#!/usr/bin/env node
// Database tests for "Now unblocked" (Baseline 2f6b39f2 / S2 task 1349c17a,
// migration 067), against a LOCAL Supabase stack with every migration applied
// (scripts/test-stack/up.sh):
//
//   UNBLOCK_TEST_SUPABASE_URL=$STACK_API_URL UNBLOCK_TEST_ANON_KEY=$STACK_ANON_KEY \
//   UNBLOCK_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY \
//   UNBLOCK_TEST_DB_CONTAINER=$STACK_DB_CONTAINER npm run test:task-unblocks-db
//
// Writes run in psql signed in as a throwaway user (SET ROLE authenticated +
// request.jwt.claims, exactly what PostgREST does), so RLS applies; a few run
// as postgres to stand in for the SQL path (brief_item_transition) and the
// service-role machine keys.
//
// Part 1: 067 itself: column (nullable, no default), table, policies, grants;
//         no backfill (a link whose blocker is ALREADY Done when 067 is applied
//         changes nothing); rollback and re-apply (twice).
//         A busy table stops 067 and its rollback at their 10s lock timeout, nothing
//         changed, and the same file then runs.
// Part 2: the rules: one blocker; three blockers (the first two change
//         nothing); later date kept, past/none moved to the end of today ET,
//         same day kept; Waiting with another hold stays Waiting; prerequisite
//         reason moves; Parked/Missed/Done untouched; recurring pill-only;
//         commitments; the comment names no titles; one transition row; the
//         priority adjustment; no cascade from the auto-move; the helpers'
//         weekend rule and DST end of day.
// Part 3: the pill: start/finish/park/missed/waiting/re-date clear it with the
//         reason; Backlog<->Planned and other edits keep it; a direct write of
//         unblocked_at is ignored; an insert can't set it; a new blocker clears
//         it; clear_task_unblock (own user, other user refused).
// Part 4: reopen: within 7 days everything back (compare-and-set), after a
//         re-date the date stays, after 7 days only the pill; pill-only rows;
//         a closed task (Done, Parked, Missed) gets no write and no comment.
// Part 5: RLS (no direct writes, no cross-user reads), two blockers finished at
//         once in two sessions (exactly one unblock), and a bulk Done of both
//         blockers in one statement (one unblock).
// Part 6 (fix round 2): the priority recalculated from the base and real boosts,
//         checked against src/lib/priority.ts itself.
// Part 7 (fix round 2): a link and a reopen at the same moment, both orders, task
//         and commitment targets, the 061 loop guard and the 062 lock protocol in
//         the same schedule, a busy target.
// Part 8 (fix round 2): failures and the retry: a lock timeout on one of two
//         waiters (both id orders), both locked, statement_timeout, a caught
//         deadlock, a reopen failure, retry success, retry skipped because the
//         task or the blocker changed, the cap, RLS on the records, the real cron
//         route, and the unblocked_at <-> open row invariant over everything.
// Part 9 (fix round 3): the retry never brings back a pill that was cleared after
//         the failure, or redoes a normal unblock, and still applies when its
//         failure is the newest event; Remove from a signed-in session (the real
//         routes on a real PostgREST): owner only, the 061 loop guard and 067's
//         link trigger, a hand-removed last link still doesn't unblock.
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { recalculateTaskPriority } from "../src/lib/priority.ts";

const url = process.env.UNBLOCK_TEST_SUPABASE_URL;
const anonKey = process.env.UNBLOCK_TEST_ANON_KEY;
const serviceKey = process.env.UNBLOCK_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.UNBLOCK_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set UNBLOCK_TEST_SUPABASE_URL, UNBLOCK_TEST_ANON_KEY, UNBLOCK_TEST_SERVICE_ROLE_KEY and UNBLOCK_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/067_task_unblocks.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/067_task_unblocks.down.sql", import.meta.url), "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}
function psqlFails(sql) {
  try {
    psql(sql);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  throw new Error(`expected an error from: ${sql}`);
}
const json = (sql) => JSON.parse(psql(sql) || "null");
const claims = (userId) => `'{"sub":"${userId}","role":"authenticated"}'`;
/** SQL run as the signed-in user (RLS applies), in one transaction. */
const asUser = (userId, sql) =>
  psql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', ${claims(userId)}, true) IS NOT NULL; ${sql}; COMMIT;`)
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();
const asUserFails = (userId, sql) =>
  psqlFails(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', ${claims(userId)}, true) IS NOT NULL; ${sql}; COMMIT;`);

/** One long-lived session (its own psql process) for the two-session tests; see test-break-into-tasks-db.mjs. */
class Session {
  constructor(role = "postgres") {
    this.proc = spawn("docker", ["exec", "-i", dbContainer, "psql", "-U", role, "-d", "postgres", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]);
    this.out = "";
    this.err = "";
    this.n = 0;
    this.waiters = [];
    this.proc.stdout.setEncoding("utf8").on("data", (chunk) => {
      this.out += chunk;
      this.flush();
    });
    this.proc.stderr.setEncoding("utf8").on("data", (chunk) => {
      this.err += chunk;
    });
  }
  flush() {
    for (const waiter of [...this.waiters]) {
      const at = this.out.indexOf(waiter.marker);
      if (at === -1) continue;
      const text = this.out.slice(0, at).trim();
      this.out = this.out.slice(at + waiter.marker.length).replace(/^\n/, "");
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      setTimeout(() => {
        const err = this.err;
        this.err = "";
        waiter.resolve({ out: text, err });
      }, 60);
    }
  }
  run(sql, ms = 30_000) {
    this.n += 1;
    const marker = `__UNBLOCK_DONE_${this.n}__`;
    const done = new Promise((resolve) => {
      const waiter = { marker, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve({ out: "", err: `session still blocked after ${ms} ms` });
      }, ms).unref();
    });
    this.proc.stdin.write(`${sql}\n\\echo ${marker}\n`);
    return done;
  }
  async signIn(userId) {
    const r = await this.run(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', ${claims(userId)}, false) IS NOT NULL;`);
    assert.equal(r.err, "", r.err);
    return this;
  }
  close() {
    this.proc.stdin.end("\\q\n");
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function untilWaiting(like, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const waiting = psql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '${like.replace(/'/g, "''")}' AND pid <> pg_backend_pid();`);
    if (Number(waiting) > 0) return;
    await sleep(50);
  }
  throw new Error(`nothing waited on a lock for ${like} within ${ms} ms`);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [];
const logins = new Map();
async function makeUser(prefix) {
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${prefix}-${randomUUID().slice(0, 8)}@example.test`,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  logins.set(data.user.id, { email: data.user.email, password });
  return data.user.id;
}
/** A real signed-in session on PostgREST (the browser's client: anon key + the user's JWT). */
async function userClient(id) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword(logins.get(id));
  if (error) throw error;
  return client;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

// ── Fixtures (as the user, RLS on) ────────────────────────────────────────

const q = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);
function makeTask(userId, fields = {}) {
  const row = { title: `Task ${randomUUID().slice(0, 6)}`, status: "Planned", ...fields };
  const columns = ["user_id", ...Object.keys(row)];
  const values = [q(userId), ...Object.values(row).map((value) => (Array.isArray(value) ? `ARRAY[${value.map(q).join(",")}]::TEXT[]` : q(value)))];
  return asUser(userId, `INSERT INTO tasks (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING id`);
}
function link(userId, taskId, dependsOn, kind = "task") {
  const column = kind === "task" ? "depends_on_task_id" : "depends_on_commitment_id";
  return asUser(userId, `INSERT INTO task_dependencies (user_id, task_id, ${column}) VALUES (${q(userId)}, ${q(taskId)}, ${q(dependsOn)}) RETURNING id`);
}
function setStatus(userId, taskId, status, table = "tasks") {
  asUser(userId, `UPDATE ${table} SET status = ${q(status)} WHERE id = ${q(taskId)}`);
}
function task(taskId) {
  return json(`SELECT row_to_json(t) FROM (SELECT id, status::TEXT AS status, due_at, priority_score, unblocked_at, due_change_id, waiting_on FROM tasks WHERE id = ${q(taskId)}) t;`);
}
function unblockRows(taskId) {
  return json(`SELECT COALESCE(json_agg(u ORDER BY u.unblocked_at, u.created_at), '[]') FROM task_unblocks u WHERE u.task_id = ${q(taskId)};`);
}
function systemComments(taskId) {
  return json(`SELECT COALESCE(json_agg(c.content ORDER BY c.created_at), '[]') FROM task_comments c WHERE c.task_id = ${q(taskId)} AND c.source = 'system';`);
}
function transitions(taskId) {
  return json(`SELECT COALESCE(json_agg(json_build_array(from_status, to_status) ORDER BY transitioned_at, created_at), '[]') FROM task_status_transitions WHERE task_id = ${q(taskId)};`);
}
const endOfTodayEt = () => psql(`SELECT task_unblock_end_of_day(task_unblock_landing_date(now(), true))::TEXT;`);
const todayEt = () => psql(`SELECT (now() AT TIME ZONE 'America/New_York')::DATE::TEXT;`);
const sameInstant = (a, b) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
// Tests below tag tasks `personal` so the landing day is always today (no weekend shift); the weekend rule is checked on the helper.
const P = ["personal"];

try {
  const userA = await makeUser("unblock-a");
  const userB = await makeUser("unblock-b");

  // ── Part 1: the migration ────────────────────────────────────────────────

  await test("067: the column is nullable with no default; table, RLS, policies and grants as written", () => {
    assert.equal(psql(`SELECT is_nullable || '|' || COALESCE(column_default, '<none>') FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'unblocked_at';`), "YES|<none>");
    assert.equal(psql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.task_unblocks'::regclass;`), "t");
    assert.equal(psql(`SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE tablename = 'task_unblocks';`), "INSERT,SELECT,UPDATE");
    assert.equal(psql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.task_unblock_retries'::regclass;`), "t");
    assert.equal(psql(`SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE tablename = 'task_unblock_retries';`), "INSERT,SELECT");
    assert.equal(psql(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.task_unblock_retries'::regclass AND contype = 'f';`), "0", "no foreign key: a key check would wait on the lock that failed");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'public.clear_task_unblock(uuid, uuid, text)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.clear_task_unblock(uuid, uuid, text)', 'EXECUTE');`), "t");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_tasks_unblock_dependents','trg_commitments_unblock_dependents','trg_tasks_unblock_pill','trg_tasks_unblock_pill_insert','trg_task_dependencies_unblock_reblock');`), "5");
  });

  await test("067: no backfill (a blocker already Done when 067 is applied changes nothing); rollback and re-apply twice", () => {
    psql(ROLLBACK);
    assert.equal(psql(`SELECT to_regclass('public.task_unblocks') IS NULL;`), "t");
    assert.equal(psql(`SELECT to_regclass('public.task_unblock_retries') IS NULL;`), "t");
    assert.equal(psql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND (p.proname LIKE 'task_unblock%' OR p.proname = 'clear_task_unblock');`), "0", "every function is gone");
    assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE tablename = 'task_dependencies' AND cmd = 'UPDATE';`), "0", "the UPDATE policy goes with 067");
    psql(ROLLBACK); // twice is fine
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'unblocked_at';`), "0");
    // Without 067: the blocker is finished, the waiting task stays Waiting.
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    const before = psql(`SELECT md5(string_agg(t::TEXT, '|' ORDER BY t.id)) FROM tasks t;`);
    const commentsBefore = psql(`SELECT count(*) FROM task_comments;`);
    psql(MIGRATION);
    psql(MIGRATION);
    // (The stack's up.sh grants ALL after the migrations ran, so 067's own grants are only visible after this re-apply.)
    const can = (role, table, privilege) => psql(`SELECT has_table_privilege('${role}', 'public.${table}', '${privilege}');`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["DELETE", "TRUNCATE"]) {
        assert.equal(can(role, "task_unblocks", privilege), "f", `${role} ${privilege} task_unblocks`);
        assert.equal(can(role, "task_unblock_retries", privilege), "f", `${role} ${privilege} task_unblock_retries`);
      }
    }
    assert.equal(can("anon", "task_unblocks", "SELECT"), "f");
    assert.equal(can("anon", "task_unblock_retries", "SELECT"), "f");
    assert.equal(can("authenticated", "task_unblock_retries", "UPDATE"), "f", "only the retry updates a record");
    assert.equal(can("service_role", "task_unblock_retries", "UPDATE"), "t");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.task_unblock_run_retries(uuid, integer)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'public.task_unblock_run_retries(uuid, integer)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT has_function_privilege('service_role', 'public.task_unblock_run_retries(uuid, integer)', 'EXECUTE');`), "t");
    assert.equal(task(waiting).status, "Blocked/Waiting", "nothing unblocked on apply");
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(psql(`SELECT count(*) FROM task_unblocks;`), "0");
    assert.equal(psql(`SELECT count(*) FROM task_comments;`), commentsBefore);
    // Every row's text gains the new NULL column, nothing else.
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE unblocked_at IS NOT NULL;`), "0");
    assert.ok(before.length === 32);
  });

  // ── Part 2: the rules ────────────────────────────────────────────────────

  // The ship script review: `supabase db push` sets no lock timeout, so a session holding a tasks write
  // left the apply waiting with every read of tasks queued behind it. Bounded wait here (15s), so without
  // the timeout this fails instead of hanging; the holder's ROLLBACK then lets the file finish.
  const ATTEMPT_MS = 15_000;
  const unblockedAtColumns = `SELECT count(*) FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'unblocked_at';`;
  async function attemptWhileHolderWrites(holderSql, sql) {
    const holder = new Session();
    const attempt = new Session();
    try {
      assert.equal((await holder.run(`BEGIN; ${holderSql}`)).err, "");
      const started = Date.now();
      const result = await attempt.run(sql, ATTEMPT_MS);
      const seconds = (Date.now() - started) / 1000;
      assert.match(result.err, /canceling statement due to lock timeout/, result.err.slice(0, 200));
      assert.ok(seconds > 9 && seconds < 13, `stopped at about 10s, not ${seconds}s`);
      // The holder is still there: a read of tasks doesn't queue behind a failed attempt.
      assert.notEqual(psql(`SET statement_timeout = '2s'; SELECT count(*) FROM tasks;`), "");
      await holder.run(`ROLLBACK;`);
      return seconds;
    } finally {
      await holder.run(`ROLLBACK;`, 2_000);
      holder.close();
      await attempt.run(`SELECT 1;`, 40_000); // an attempt that was still waiting has finished by now
      attempt.close();
    }
  }

  await test("busy tables: 067 stops at its lock timeout (55P03), nothing applied, reads not stalled, and the same file then applies", async () => {
    psql(ROLLBACK);
    try {
      await attemptWhileHolderWrites(`UPDATE tasks SET title = title WHERE false;`, MIGRATION);
      assert.equal(psql(unblockedAtColumns), "0", "nothing of 067 was applied");
      assert.equal(psql(`SELECT to_regclass('public.task_unblocks') IS NULL AND to_regclass('public.task_unblock_retries') IS NULL;`), "t");
    } finally {
      psql(MIGRATION);
    }
    assert.equal(psql(unblockedAtColumns), "1", "the re-run applied");
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname = 'task_unblock_on_status_change' AND 'lock_timeout=5s' = ANY(proconfig);`), "1", "the functions keep their own 5s");
  });

  await test("busy tables: the rollback stops at its lock timeout too, whichever table is busy, and 067 stays whole", async () => {
    try {
      for (const table of ["tasks", "commitments", "task_dependencies"]) {
        await attemptWhileHolderWrites(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE;`, ROLLBACK);
        assert.equal(psql(unblockedAtColumns), "1", `${table}: the column is still there`);
        assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_tasks_unblock_dependents','trg_commitments_unblock_dependents','trg_tasks_unblock_pill','trg_tasks_unblock_pill_insert','trg_task_dependencies_unblock_reblock');`), "5", `${table}: every trigger is still there`);
      }
    } finally {
      psql(MIGRATION); // the rest of the run needs 067, also when a waiting rollback finished after the 15s
    }
  });

  await test("one blocker: Waiting -> Planned, no due -> end of today ET, pill, one comment, one transition, a record", () => {
    const blocker = makeTask(userA, { tags: P, title: "Secret blocker title" });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P, title: "Secret waiting title" });
    link(userA, waiting, blocker);
    const before = task(waiting);
    setStatus(userA, blocker, "Done");
    const after = task(waiting);
    assert.equal(after.status, "Planned");
    assert.ok(sameInstant(after.due_at, endOfTodayEt()), `${after.due_at} vs ${endOfTodayEt()}`);
    assert.ok(after.unblocked_at);
    assert.equal(before.priority_score, 50, "the default score, written with no recalculation");
    assert.equal(after.priority_score, 75, "base 50 + 25 due today: recalculated, not 50 + 20 + 25");
    const comments = systemComments(waiting);
    assert.equal(comments.length, 1);
    assert.match(comments[0], /^Now unblocked: everything it waited on is done\. Moved from Waiting to Planned\. Due date set to \w{3} \d{1,2}\/\d{1,2}\./);
    assert.doesNotMatch(comments[0], /Secret/);
    assert.deepEqual(transitions(waiting), [["Blocked/Waiting", "Planned"]]);
    const [row] = unblockRows(waiting);
    assert.equal(row.blocker_type, "task");
    assert.equal(row.blocker_task_id, blocker);
    assert.deepEqual(row.waited_on_task_ids, [blocker]);
    assert.equal(row.landing_date, todayEt());
    assert.deepEqual([row.prior_status, row.new_status, row.status_changed, row.prior_due_at, row.due_changed], ["Blocked/Waiting", "Planned", true, null, true]);
    assert.equal(row.new_due_change_id, after.due_change_id, "the token our write produced");
    assert.equal(row.cleared_at, null);
    assert.equal(systemComments(blocker).length, 0, "nothing on the blocker");
  });

  await test("three blockers: the first two change nothing, the third unblocks", () => {
    const [b1, b2, b3] = [makeTask(userA, { tags: P }), makeTask(userA, { tags: P }), makeTask(userA, { tags: P })];
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    for (const b of [b1, b2, b3]) link(userA, waiting, b);
    setStatus(userA, b1, "Done");
    setStatus(userA, b2, "Done");
    assert.equal(task(waiting).status, "Blocked/Waiting");
    assert.equal(unblockRows(waiting).length, 0);
    setStatus(userA, b3, "Done");
    assert.equal(task(waiting).status, "Planned");
    const [row] = unblockRows(waiting);
    assert.equal(row.blocker_task_id, b3);
    assert.deepEqual([...row.waited_on_task_ids].sort(), [b1, b2, b3].sort());
  });

  await test("due dates (Brent: keep the later date): later kept, same day kept, past moved", () => {
    const later = psql(`SELECT (now() + INTERVAL '5 days')::TEXT;`);
    const cases = [
      { due: later, expect: later },
      { due: psql(`SELECT ((now() AT TIME ZONE 'America/New_York')::DATE::TIMESTAMP + INTERVAL '1 minute') AT TIME ZONE 'America/New_York';`), same: true },
      { due: psql(`SELECT (now() - INTERVAL '3 days')::TEXT;`), expect: endOfTodayEt() },
    ];
    for (const item of cases) {
      const blocker = makeTask(userA, { tags: P });
      const waiting = makeTask(userA, { status: "Planned", tags: P, due_at: item.due });
      link(userA, waiting, blocker);
      const before = task(waiting);
      setStatus(userA, blocker, "Done");
      const after = task(waiting);
      assert.ok(sameInstant(after.due_at, item.same ? before.due_at : item.expect), `${item.due}: ${after.due_at}`);
      assert.equal(after.status, "Planned");
      assert.ok(after.unblocked_at, "pill either way");
      const [row] = unblockRows(waiting);
      assert.equal(row.due_changed, !sameInstant(before.due_at, after.due_at));
    }
  });

  await test("also waiting on something else: stays Waiting with the pill; reason 'prerequisite' moves it", () => {
    const blocker = makeTask(userA, { tags: P });
    const held = makeTask(userA, { status: "Blocked/Waiting", tags: P, waiting_on: "Legal sign-off", blocked_reason: "approval" });
    const prereq = makeTask(userA, { status: "Blocked/Waiting", tags: P, waiting_on: "The design doc", blocked_reason: "prerequisite" });
    link(userA, held, blocker);
    link(userA, prereq, blocker);
    setStatus(userA, blocker, "Done");
    assert.equal(task(held).status, "Blocked/Waiting");
    assert.ok(task(held).unblocked_at);
    assert.match(systemComments(held)[0], /Still marked Waiting, since it also waits on something else\./);
    assert.deepEqual(transitions(held), []);
    assert.equal(task(prereq).status, "Planned");
    assert.equal(task(prereq).waiting_on, "The design doc", "waiting_on is left as it is");
  });

  await test("Parked, Missed and Done waiting tasks are untouched; recurring tasks get the pill only", () => {
    const blocker = makeTask(userA, { tags: P });
    const ids = ["Parked", "Missed", "Done"].map((status) => makeTask(userA, { status, tags: P }));
    for (const id of ids) link(userA, id, blocker);
    const template = makeTask(userA, { status: "Blocked/Waiting", tags: P, is_recurring_template: true });
    link(userA, template, blocker);
    const before = ids.map(task);
    const templateBefore = task(template);
    setStatus(userA, blocker, "Done");
    assert.deepEqual(ids.map(task), before);
    for (const id of ids) assert.equal(unblockRows(id).length, 0);
    const t = task(template);
    assert.equal(t.status, "Blocked/Waiting");
    assert.equal(t.due_at, templateBefore.due_at);
    assert.ok(t.unblocked_at);
    assert.equal(unblockRows(template)[0].is_recurring, true);
  });

  await test("a commitment becoming Done unblocks too; Dropped still blocks", () => {
    const stakeholder = asUser(userA, `INSERT INTO stakeholders (user_id, name) VALUES (${q(userA)}, 'Pat') RETURNING id`);
    const commitment = asUser(userA, `INSERT INTO commitments (user_id, stakeholder_id, title) VALUES (${q(userA)}, ${q(stakeholder)}, 'Send contract') RETURNING id`);
    const dropped = asUser(userA, `INSERT INTO commitments (user_id, stakeholder_id, title) VALUES (${q(userA)}, ${q(stakeholder)}, 'Other') RETURNING id`);
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    const both = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, commitment, "commitment");
    link(userA, both, commitment, "commitment");
    link(userA, both, dropped, "commitment");
    setStatus(userA, dropped, "Dropped", "commitments");
    setStatus(userA, commitment, "Done", "commitments");
    assert.equal(task(waiting).status, "Planned");
    assert.equal(unblockRows(waiting)[0].blocker_commitment_id, commitment);
    assert.equal(task(both).status, "Blocked/Waiting", "a Dropped commitment still blocks (isDependencyResolved)");
    assert.equal(unblockRows(both).length, 0);
  });

  await test("the auto-move does not cascade: a task waiting on the unblocked one keeps its date", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P, due_at: psql(`SELECT (now() - INTERVAL '4 days')::TEXT;`) });
    const next = makeTask(userA, { status: "Planned", tags: P, due_at: psql(`SELECT (now() - INTERVAL '2 days')::TEXT;`) });
    link(userA, waiting, blocker);
    link(userA, next, waiting);
    const nextBefore = task(next);
    setStatus(userA, blocker, "Done");
    assert.ok(task(waiting).unblocked_at);
    assert.deepEqual(task(next), nextBefore);
  });

  await test("helpers: work tasks land Monday from a weekend, personal stay; the end of an ET day across DST", () => {
    assert.equal(psql(`SELECT task_unblock_landing_date('2026-10-31T15:00:00Z', false)::TEXT;`), "2026-11-02");
    assert.equal(psql(`SELECT task_unblock_landing_date('2026-11-01T15:00:00Z', false)::TEXT;`), "2026-11-02");
    assert.equal(psql(`SELECT task_unblock_landing_date('2026-10-31T15:00:00Z', true)::TEXT;`), "2026-10-31");
    assert.equal(psql(`SELECT task_unblock_landing_date('2026-10-31T03:30:00Z', false)::TEXT;`), "2026-10-30", "Fri 11:30 PM ET");
    assert.equal(psql(`SELECT to_char(task_unblock_end_of_day('2026-11-02') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS');`), "2026-11-03T04:59:59.999");
    assert.equal(psql(`SELECT to_char(task_unblock_end_of_day('2026-10-30') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS');`), "2026-10-31T03:59:59.999");
    assert.equal(psql(`SELECT task_unblock_day_label('2026-11-04');`), "Wed 11/4");
  });

  await test("a work task's real unblock uses the same landing day as the helper", () => {
    const blocker = makeTask(userA, {});
    const waiting = makeTask(userA, { status: "Blocked/Waiting" });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    assert.equal(unblockRows(waiting)[0].landing_date, psql(`SELECT task_unblock_landing_date(now(), false)::TEXT;`));
  });

  // ── Part 3: the pill ─────────────────────────────────────────────────────

  function pilledTask() {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    assert.ok(task(waiting).unblocked_at);
    return { blocker, waiting };
  }

  await test("the pill clears on start, finish, park, missed, re-hold and re-date, with the reason", () => {
    const cases = [
      ["status = 'In Progress'", "started"],
      ["status = 'Done'", "finished"],
      ["status = 'Parked'", "parked"],
      ["status = 'Missed'", "missed"],
      ["status = 'Blocked/Waiting'", "waiting"],
      ["due_at = now() + INTERVAL '9 days'", "redated"],
      ["due_at = NULL", "redated"],
    ];
    for (const [set, reason] of cases) {
      const { waiting } = pilledTask();
      asUser(userA, `UPDATE tasks SET ${set} WHERE id = ${q(waiting)}`);
      assert.equal(task(waiting).unblocked_at, null, set);
      const [row] = unblockRows(waiting);
      assert.equal(row.cleared_reason, reason, set);
      assert.ok(row.cleared_at);
    }
  });

  await test("the pill stays on Backlog <-> Planned and other edits (no time limit)", () => {
    const { waiting } = pilledTask();
    const at = task(waiting).unblocked_at;
    asUser(userA, `UPDATE tasks SET status = 'Backlog' WHERE id = ${q(waiting)}`);
    asUser(userA, `UPDATE tasks SET status = 'Planned', title = 'Renamed', tags = ARRAY['personal','x'] WHERE id = ${q(waiting)}`);
    asUser(userA, `INSERT INTO task_comments (user_id, task_id, content) VALUES (${q(userA)}, ${q(waiting)}, 'a note')`);
    assert.equal(task(waiting).unblocked_at, at);
    assert.equal(unblockRows(waiting)[0].cleared_at, null);
    // An old pill stays: backdate it a month.
    psql(`UPDATE task_unblocks SET unblocked_at = now() - INTERVAL '30 days' WHERE task_id = ${q(waiting)};`);
    asUser(userA, `UPDATE tasks SET title = 'Renamed again' WHERE id = ${q(waiting)}`);
    assert.ok(task(waiting).unblocked_at);
  });

  await test("only 067 sets unblocked_at: a direct write keeps the old value, NULL clears ('manual'), an insert can't set it", () => {
    const { waiting } = pilledTask();
    const at = task(waiting).unblocked_at;
    asUser(userA, `UPDATE tasks SET unblocked_at = now() - INTERVAL '1 day' WHERE id = ${q(waiting)}`);
    assert.equal(task(waiting).unblocked_at, at);
    asUser(userA, `UPDATE tasks SET unblocked_at = NULL WHERE id = ${q(waiting)}`);
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "manual");
    asUser(userA, `UPDATE tasks SET unblocked_at = now() WHERE id = ${q(waiting)}`);
    assert.equal(task(waiting).unblocked_at, null, "can't be set again by hand");
    const copied = makeTask(userA, { tags: P, unblocked_at: "2026-10-30T13:40:00Z" });
    assert.equal(task(copied).unblocked_at, null);
    // Service role / postgres (the machine keys) is held to the same rule.
    psql(`UPDATE tasks SET unblocked_at = now() WHERE id = ${q(copied)};`);
    assert.equal(task(copied).unblocked_at, null);
  });

  await test("a new blocker clears the pill ('reblocked'); a link to a Done item doesn't", () => {
    const { waiting } = pilledTask();
    const done = makeTask(userA, { tags: P, status: "Done" });
    link(userA, waiting, done);
    assert.ok(task(waiting).unblocked_at, "a Done prerequisite doesn't block");
    const open = makeTask(userA, { tags: P });
    link(userA, waiting, open);
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "reblocked");
    // Finishing the new one unblocks again (a second record).
    setStatus(userA, open, "Done");
    assert.ok(task(waiting).unblocked_at);
    assert.equal(unblockRows(waiting).length, 2);
  });

  await test("clear_task_unblock: Brent's own task clears ('brief'); another user's id is refused", () => {
    const { waiting } = pilledTask();
    assert.match(asUserFails(userB, `SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'brief')`), /another user/);
    assert.match(asUserFails(userA, `SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'timeout')`), /brief or manual/);
    assert.deepEqual(JSON.parse(asUser(userB, `SELECT clear_task_unblock(${q(userB)}, ${q(waiting)}, 'brief')`)), { ok: false, reason: "not_found" });
    assert.ok(task(waiting).unblocked_at);
    assert.deepEqual(JSON.parse(asUser(userA, `SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'brief')`)), { ok: true, cleared: true });
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "brief");
    assert.deepEqual(JSON.parse(asUser(userA, `SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'brief')`)), { ok: true, cleared: false });
  });

  // ── Part 4: reopen ───────────────────────────────────────────────────────

  await test("reopen within 7 days: status, due date and priority go back; one transition, one comment, row reverted", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    const before = task(waiting);
    setStatus(userA, blocker, "Done");
    setStatus(userA, blocker, "Planned");
    const after = task(waiting);
    assert.equal(after.status, "Blocked/Waiting");
    assert.equal(after.due_at, null);
    assert.equal(after.priority_score, before.priority_score);
    assert.equal(after.unblocked_at, null);
    assert.deepEqual(transitions(waiting), [["Blocked/Waiting", "Planned"], ["Planned", "Blocked/Waiting"]]);
    const comments = systemComments(waiting);
    assert.equal(comments.length, 2);
    assert.equal(comments[1], "Something it waited on was reopened, so it is no longer marked Now unblocked. Back to Waiting. Due date cleared again.");
    const [row] = unblockRows(waiting);
    assert.ok(row.reverted_at);
    assert.deepEqual([row.cleared_reason, row.revert_status_restored, row.revert_due_restored, row.reverted_by_id], ["reopened", true, true, blocker]);
  });

  await test("reopen after Brent re-dated it: the date he set stays, the status goes back; the comment says so", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    asUser(userA, `UPDATE tasks SET due_at = now() + INTERVAL '6 days' WHERE id = ${q(waiting)}`);
    const redated = task(waiting).due_at;
    setStatus(userA, blocker, "In Progress");
    const after = task(waiting);
    assert.equal(after.status, "Blocked/Waiting");
    assert.ok(sameInstant(after.due_at, redated));
    assert.match(systemComments(waiting).at(-1), /^Something it waited on was reopened\. Back to Waiting\. Its status or due date changed since, so that was left as it is\.$/);
    assert.deepEqual([unblockRows(waiting)[0].revert_status_restored, unblockRows(waiting)[0].revert_due_restored], [true, false]);
  });

  await test("reopen after a save of the same date (another change token): the date stays", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    const set = task(waiting).due_at;
    // Away and back: the date is the same, the token isn't.
    asUser(userA, `UPDATE tasks SET due_at = now() + INTERVAL '6 days' WHERE id = ${q(waiting)}`);
    asUser(userA, `UPDATE tasks SET due_at = ${q(set)} WHERE id = ${q(waiting)}`);
    setStatus(userA, blocker, "Planned");
    assert.ok(sameInstant(task(waiting).due_at, set));
  });

  await test("reopen after 7 days: only the pill clears, nothing else and no comment", () => {
    const { blocker, waiting } = pilledTask();
    psql(`UPDATE task_unblocks SET unblocked_at = now() - INTERVAL '8 days' WHERE task_id = ${q(waiting)};`);
    const before = task(waiting);
    const commentCount = systemComments(waiting).length;
    setStatus(userA, blocker, "Planned");
    const after = task(waiting);
    assert.equal(after.status, before.status);
    assert.equal(after.due_at, before.due_at);
    assert.equal(after.unblocked_at, null);
    assert.equal(systemComments(waiting).length, commentCount);
    const [row] = unblockRows(waiting);
    assert.equal(row.reverted_at, null);
    assert.equal(row.cleared_reason, "reopened");
  });

  await test("reopen of a pill-only unblock whose pill Brent already cleared: recorded, no task write, no comment", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "In Progress", tags: P, due_at: psql(`SELECT (now() + INTERVAL '3 days')::TEXT;`) });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    asUser(userA, `UPDATE tasks SET status = 'Parked' WHERE id = ${q(waiting)}`);
    const before = psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`);
    const comments = systemComments(waiting).length;
    setStatus(userA, blocker, "Planned");
    assert.equal(psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`), before);
    assert.equal(systemComments(waiting).length, comments);
    assert.ok(unblockRows(waiting)[0].reverted_at);
  });

  await test("reopen when the waiting task is closed (Done, Parked, Missed): nothing on the task changes, no comment, the row closes", () => {
    for (const status of ["Done", "Parked", "Missed"]) {
      const blocker = makeTask(userA, { tags: P });
      const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
      link(userA, waiting, blocker);
      setStatus(userA, blocker, "Done");
      const set = task(waiting);
      assert.ok(set.due_at, "the unblock set a due date");
      setStatus(userA, waiting, status);
      const closed = task(waiting);
      const updatedAt = psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`);
      const comments = systemComments(waiting);
      const history = transitions(waiting);
      setStatus(userA, blocker, "Planned");
      assert.deepEqual(task(waiting), closed, `${status}: status, due date, priority and token stay`);
      assert.equal(task(waiting).status, status);
      assert.ok(sameInstant(task(waiting).due_at, set.due_at), `${status}: the due date isn't cleared`);
      assert.equal(psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`), updatedAt, `${status}: no task write`);
      assert.deepEqual(systemComments(waiting), comments, `${status}: no comment`);
      assert.deepEqual(transitions(waiting), history, `${status}: no transition`);
      const [row] = unblockRows(waiting);
      assert.ok(row.reverted_at, `${status}: the row is closed`);
      assert.deepEqual([row.revert_status_restored, row.revert_due_restored, row.revert_comment_id], [false, false, null]);
    }
  });

  await test("reopen with a closed task still holding a pill (bookkeeping only): the pill and its row clear together", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    setStatus(userA, blocker, "Done");
    // Only a write under the setting can leave a closed task with a pill; stand in for it as postgres.
    psql(`BEGIN; SELECT set_config('mission_control.unblock_writer', 'on', true); UPDATE tasks SET status = 'Parked' WHERE id = ${q(waiting)}; COMMIT;`);
    assert.ok(task(waiting).unblocked_at);
    const comments = systemComments(waiting);
    const due = task(waiting).due_at;
    setStatus(userA, blocker, "Planned");
    const after = task(waiting);
    assert.equal(after.unblocked_at, null);
    assert.equal(after.status, "Parked");
    assert.ok(sameInstant(after.due_at, due));
    assert.deepEqual(systemComments(waiting), comments);
    const [row] = unblockRows(waiting);
    assert.ok(row.reverted_at);
    assert.equal(row.cleared_reason, "reopened");
  });

  await test("the SQL path (as postgres, like brief_item_transition) unblocks and reopens the same way", () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    psql(`UPDATE tasks SET status = 'Done' WHERE id = ${q(blocker)};`);
    assert.equal(task(waiting).status, "Planned");
    psql(`UPDATE tasks SET status = 'Planned' WHERE id = ${q(blocker)};`);
    assert.equal(task(waiting).status, "Blocked/Waiting");
  });

  // ── Part 5: RLS, failures, concurrency ───────────────────────────────────

  await test("RLS: no direct writes to task_unblocks, and another user sees none of them", () => {
    const { waiting } = pilledTask();
    assert.match(asUserFails(userA, `INSERT INTO task_unblocks (user_id, task_id, blocker_type, unblocked_at, landing_date, prior_status, new_status) VALUES (${q(userA)}, ${q(waiting)}, 'task', now(), CURRENT_DATE, 'Planned', 'Planned')`), /row-level security/);
    assert.equal(asUser(userA, `WITH u AS (UPDATE task_unblocks SET cleared_at = now(), cleared_reason = 'manual' WHERE task_id = ${q(waiting)} RETURNING 1) SELECT count(*) FROM u`), "0");
    // No DELETE grant (067 revokes it, whatever a stack's default privileges give) and no DELETE policy.
    assert.match(asUserFails(userA, `DELETE FROM task_unblocks WHERE task_id = ${q(waiting)}`), /permission denied/);
    assert.match(psqlFails(`BEGIN; SET LOCAL ROLE service_role; DELETE FROM task_unblocks WHERE task_id = ${q(waiting)}; COMMIT;`), /permission denied/);
    assert.match(asUserFails(userA, `TRUNCATE task_unblocks`), /permission denied/);
    assert.equal(asUser(userB, `SELECT count(*) FROM task_unblocks WHERE task_id = ${q(waiting)}`), "0");
    assert.equal(asUser(userA, `SELECT count(*) FROM task_unblocks WHERE task_id = ${q(waiting)}`), "1");
    assert.equal(psql(`SELECT current_setting('mission_control.unblock_writer', true) IS DISTINCT FROM 'on';`), "t");
  });

  await test("two blockers finished at the same moment in two sessions: exactly one unblock", async () => {
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, b1);
    link(userA, waiting, b2);
    const s1 = new Session();
    const s2 = new Session();
    try {
      await s1.signIn(userA);
      await s2.signIn(userA);
      // s1 finishes b1 and holds its transaction open (its trigger has locked the waiting task).
      await s1.run(`BEGIN; UPDATE tasks SET status = 'Done' WHERE id = ${q(b1)};`);
      const second = s2.run(`BEGIN; UPDATE tasks SET status = 'Done' WHERE id = ${q(b2)}; COMMIT;`);
      await untilWaiting("%UPDATE tasks SET status = 'Done'%");
      await s1.run(`COMMIT;`);
      const r = await second;
      assert.equal(r.err, "", r.err);
      assert.equal(task(waiting).status, "Planned", "the second sees the first's commit after the lock");
      assert.equal(unblockRows(waiting).length, 1);
      assert.equal(unblockRows(waiting)[0].blocker_task_id, b2);
    } finally {
      s1.close();
      s2.close();
    }
  });

  await test("a bulk Done of both blockers in one statement: one unblock", () => {
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, b1);
    link(userA, waiting, b2);
    asUser(userA, `UPDATE tasks SET status = 'Done' WHERE id IN (${q(b1)}, ${q(b2)})`);
    assert.equal(task(waiting).status, "Planned");
    assert.equal(unblockRows(waiting).length, 1);
    assert.equal(systemComments(waiting).length, 1);
  });

  // ── Part 6: priority ─────────────────────────────────────────────────────

  function scoreRow(taskId) {
    return json(`SELECT row_to_json(t) FROM (SELECT id, title, status::TEXT AS status, due_at, priority_score, base_priority, stakeholder_mentions FROM tasks WHERE id = ${q(taskId)}) t;`);
  }

  await test("priority: recalculated from the base, not added to the clamped score (Codex finding 3)", () => {
    for (const [base, stored, expected] of [[0, 0, 25], [10, 0, 35], [20, 0, 45], [50, 30, 75], [90, 70, 100]]) {
      const blocker = makeTask(userA, { tags: P });
      const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P, base_priority: base, priority_score: stored });
      link(userA, waiting, blocker);
      setStatus(userA, blocker, "Done");
      assert.equal(task(waiting).priority_score, expected, `base ${base}`);
      const [row] = unblockRows(waiting);
      assert.deepEqual([row.prior_priority_score, row.new_priority_score], [stored, expected]);
    }
  });

  await test("priority: the stakeholder and urgency boosts stay; the SQL matches src/lib/priority.ts over a matrix", () => {
    asUser(userA, `INSERT INTO stakeholders (user_id, name, is_high_priority) VALUES (${q(userA)}, 'Dana Reyes', true), (${q(userA)}, 'Lee', true), (${q(userA)}, 'Morgan', true), (${q(userA)}, 'Pat Low', false)`);
    const names = ["Dana Reyes", "Lee", "Morgan"];
    const dueCases = [null, psql(`SELECT (now() - INTERVAL '2 days')::TEXT;`), psql(`SELECT (now() + INTERVAL '30 hours')::TEXT;`), psql(`SELECT (now() + INTERVAL '10 days')::TEXT;`)];
    for (const base of [0, 10, 20, 50, 85]) {
      for (const title of ["Plain thing", "URGENT plan", "Translate the outage note"]) {
        for (const mentions of [[], ["dana reyes (ops)"], ["DANA REYES", "lee", "morgan"], ["Pat Low"]]) {
          for (const due of dueCases) {
            for (const status of ["Blocked/Waiting", "Planned"]) {
              const blocker = makeTask(userA, { tags: P });
              const waiting = makeTask(userA, { status, tags: P, title, base_priority: base, ...(due ? { due_at: due } : {}), stakeholder_mentions: mentions });
              link(userA, waiting, blocker);
              const before = task(waiting).priority_score;
              setStatus(userA, blocker, "Done");
              const row = scoreRow(waiting);
              const [record] = unblockRows(waiting);
              const expected = record.status_changed || record.due_changed ? recalculateTaskPriority(row, names) : before;
              assert.equal(row.priority_score, expected, JSON.stringify({ base, title, mentions, due, status }));
            }
          }
          if (base !== 10) break; // the full mention/due cross on one base, one mention case on the rest
        }
      }
    }
  });

  await test("priority: the fallback to the stored score when there is no base, as recalculateTaskPriority does", () => {
    assert.equal(psql(`SELECT task_unblock_priority(${q(userB)}, NULL, 40, 'x', '{}', 'Planned', NULL, now());`), "40");
    assert.equal(psql(`SELECT task_unblock_priority(${q(userB)}, 0, 40, 'x', '{}', 'Blocked/Waiting', NULL, now());`), "0", "clamped at 0");
    assert.equal(psql(`SELECT task_unblock_priority(${q(userB)}, 95, 40, 'critical', '{}', 'Planned', now(), now());`), "100", "clamped at 100");
    // Another user's stakeholder is no boost.
    assert.equal(psql(`SELECT task_unblock_priority(${q(userB)}, 10, 10, 'x', ARRAY['dana reyes'], 'Planned', NULL, now());`), "10");
  });

  await test("priority: nothing changed, score untouched; reopen puts the stored one back; a partial reopen recalculates", () => {
    const later = psql(`SELECT (now() + INTERVAL '6 days')::TEXT;`);
    // Pill only: neither status nor date moved, the stored (even stale) score stays.
    const b1 = makeTask(userA, { tags: P });
    const pillOnly = makeTask(userA, { status: "Planned", tags: P, due_at: later, base_priority: 10, priority_score: 77 });
    link(userA, pillOnly, b1);
    setStatus(userA, b1, "Done");
    assert.equal(task(pillOnly).priority_score, 77);
    // Everything restored and the score unchanged: the stored prior value, compare-and-set kept.
    const b2 = makeTask(userA, { tags: P });
    const full = makeTask(userA, { status: "Blocked/Waiting", tags: P, base_priority: 10, priority_score: 0 });
    link(userA, full, b2);
    setStatus(userA, b2, "Done");
    assert.equal(task(full).priority_score, 35);
    setStatus(userA, b2, "Planned");
    assert.equal(task(full).priority_score, 0);
    // Status back, date stays (re-dated): base 10 - 20 (waiting) + 0 (far off) clamps to 0, not 35 - 20 ...
    const b3 = makeTask(userA, { tags: P });
    const partial = makeTask(userA, { status: "Blocked/Waiting", tags: P, base_priority: 50, priority_score: 30 });
    link(userA, partial, b3);
    setStatus(userA, b3, "Done");
    asUser(userA, `UPDATE tasks SET due_at = ${q(later)} WHERE id = ${q(partial)}`);
    setStatus(userA, b3, "Planned");
    assert.equal(task(partial).status, "Blocked/Waiting");
    assert.equal(task(partial).priority_score, 30, "base 50 - 20 waiting, due in 6 days: recalculated");
    const b4 = makeTask(userA, { tags: P });
    const clamped = makeTask(userA, { status: "Blocked/Waiting", tags: P, base_priority: 10, priority_score: 0 });
    link(userA, clamped, b4);
    setStatus(userA, b4, "Done");
    asUser(userA, `UPDATE tasks SET due_at = ${q(later)} WHERE id = ${q(clamped)}`);
    setStatus(userA, b4, "Planned");
    assert.equal(task(clamped).priority_score, 0, "base 10 - 20 clamps at 0");
    assert.equal(recalculateTaskPriority(scoreRow(clamped), []), 0);
  });

  // ── Part 7: a link and a reopen at the same moment ───────────────────────

  function targetFixture(kind) {
    const earlier = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, earlier);
    setStatus(userA, earlier, "Done");
    assert.ok(task(waiting).unblocked_at, "W has a pill from an earlier blocker");
    if (kind === "task") {
      return { waiting, target: makeTask(userA, { tags: P, status: "Done" }), table: "tasks", column: "depends_on_task_id", reopenTo: "Planned" };
    }
    const stakeholder = asUser(userA, `INSERT INTO stakeholders (user_id, name) VALUES (${q(userA)}, 'Pat') RETURNING id`);
    const target = asUser(userA, `INSERT INTO commitments (user_id, stakeholder_id, title, status) VALUES (${q(userA)}, ${q(stakeholder)}, 'Send contract', 'Done') RETURNING id`);
    return { waiting, target, table: "commitments", column: "depends_on_commitment_id", reopenTo: "Open" };
  }
  const insertLink = (f) => `INSERT INTO task_dependencies (user_id, task_id, ${f.column}) VALUES (${q(userA)}, ${q(f.waiting)}, ${q(f.target)})`;
  const reopenSql = (f) => `UPDATE ${f.table} SET status = ${q(f.reopenTo)} WHERE id = ${q(f.target)}`;
  function assertNoFalsePill(f, reason) {
    const after = task(f.waiting);
    assert.equal(after.unblocked_at, null, "the waiting task has an open prerequisite: no pill");
    const rows = unblockRows(f.waiting);
    assert.equal(rows.filter((row) => row.cleared_at === null).length, 0, "no open record");
    assert.equal(rows[rows.length - 1].cleared_reason, reason);
  }

  for (const kind of ["task", "commitment"]) {
    await test(`link vs reopen (${kind} target), the reopen first: the link waits, reads the reopened status, clears the pill`, async () => {
      const f = targetFixture(kind);
      const reopen = new Session();
      const linker = new Session();
      try {
        await reopen.signIn(userA);
        await linker.signIn(userA);
        await reopen.run(`BEGIN; ${reopenSql(f)};`);
        const added = linker.run(`${insertLink(f)};`);
        await untilWaiting("INSERT INTO task_dependencies%");
        assert.ok(task(f.waiting).unblocked_at, "not cleared yet: the reopen hasn't committed");
        await reopen.run(`COMMIT;`);
        const r = await added;
        assert.equal(r.err, "", r.err);
        assertNoFalsePill(f, "reblocked");
      } finally {
        reopen.close();
        linker.close();
      }
    });

    await test(`link vs reopen (${kind} target), the link first: the reopen waits and its trigger sees the link`, async () => {
      const f = targetFixture(kind);
      const reopen = new Session();
      const linker = new Session();
      try {
        await reopen.signIn(userA);
        await linker.signIn(userA);
        await linker.run(`BEGIN; ${insertLink(f)};`);
        const reopened = reopen.run(`${reopenSql(f)};`);
        await untilWaiting(`UPDATE ${f.table} SET status%`);
        await linker.run(`COMMIT;`);
        const r = await reopened;
        assert.equal(r.err, "", r.err);
        assertNoFalsePill(f, "reopened");
        assert.equal(task(f.waiting).status, "Blocked/Waiting", "the reopen put it back, as in the serial order");
        assert.equal(psql(`SELECT count(*) FROM task_unblock_retries WHERE task_id = ${q(f.waiting)};`), "0", "nothing failed");
      } finally {
        reopen.close();
        linker.close();
      }
    });
  }

  await test("a link to a Done target that stays Done keeps the pill, and two links to one target don't wait on each other", async () => {
    // (A commitment target: links to tasks queue on 061's per-user lock whatever this trigger does.)
    const f = targetFixture("commitment");
    const other = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    const a = new Session();
    const b = new Session();
    try {
      await a.signIn(userA);
      await b.signIn(userA);
      await a.run(`BEGIN; ${insertLink(f)};`);
      const r = await b.run(`INSERT INTO task_dependencies (user_id, task_id, depends_on_commitment_id) VALUES (${q(userA)}, ${q(other)}, ${q(f.target)});`);
      assert.equal(r.err, "", "FOR SHARE doesn't conflict with FOR SHARE");
      await a.run(`COMMIT;`);
      assert.ok(task(f.waiting).unblocked_at);
    } finally {
      a.close();
      b.close();
    }
  });

  await test("the 061 loop guard and 062's lock protocol in the same schedule: no deadlock, everyone finishes", async () => {
    const f = targetFixture("task");
    const reopen = new Session();
    const linker = new Session();
    const cascade = new Session();
    try {
      await reopen.signIn(userA);
      await linker.signIn(userA);
      await cascade.signIn(userA);
      await reopen.run(`BEGIN; ${reopenSql(f)};`);
      // The link holds the advisory lock (loop guard) and waits on the target.
      const added = linker.run(`${insertLink(f)};`);
      await untilWaiting("INSERT INTO task_dependencies%");
      // A cascade locking the same tasks queues on the advisory lock, holding nothing.
      const locked = cascade.run(`BEGIN; SELECT task_date_cascade_lock(${q(userA)}, ARRAY[${q(f.waiting)}, ${q(f.target)}]::UUID[], 'all') IS NOT NULL; COMMIT;`);
      await untilWaiting("SELECT task_date_cascade_lock%");
      await reopen.run(`COMMIT;`);
      const [r1, r2] = await Promise.all([added, locked]);
      assert.equal(r1.err, "", r1.err);
      assert.equal(r2.err, "", r2.err);
      assertNoFalsePill(f, "reblocked");
    } finally {
      reopen.close();
      linker.close();
      cascade.close();
    }
  });

  await test("a target busy past lock_timeout fails the link add out loud (55P03), nothing half-saved, the pill stays", async () => {
    const f = targetFixture("task");
    const holder = new Session();
    const linker = new Session();
    try {
      await holder.signIn(userA);
      await linker.signIn(userA);
      await holder.run(`BEGIN; SELECT id FROM tasks WHERE id = ${q(f.target)} FOR NO KEY UPDATE;`);
      const r = await linker.run(`${insertLink(f)};`, 20_000);
      assert.match(r.err, /lock timeout/);
      await holder.run(`COMMIT;`);
      assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE task_id = ${q(f.waiting)} AND depends_on_task_id = ${q(f.target)};`), "0");
      assert.ok(task(f.waiting).unblocked_at);
    } finally {
      holder.close();
      linker.close();
    }
  });

  // ── Part 8: failures and the retry ───────────────────────────────────────

  const retries = (taskId) => json(`SELECT COALESCE(json_agg(r ORDER BY r.failed_at), '[]') FROM task_unblock_retries r WHERE r.task_id = ${q(taskId)};`);
  const runRetries = (userId = userA) => json(`SELECT task_unblock_run_retries(${q(userId)});`);

  /** Runs `sql` in a second session while `taskId` is held past the trigger's lock_timeout. Returns that session's output. */
  async function whileHeld(taskId, sql, { holdSql = null, ms = 25_000 } = {}) {
    const holder = new Session();
    const doer = new Session();
    try {
      await holder.signIn(userA);
      await doer.signIn(userA);
      await holder.run(`BEGIN; ${holdSql ?? `SELECT id FROM tasks WHERE id = ${q(taskId)} FOR UPDATE`};`);
      const started = Date.now();
      const result = await doer.run(sql, ms);
      await holder.run(`COMMIT;`);
      return { ...result, ms: Date.now() - started };
    } finally {
      holder.close();
      doer.close();
    }
  }
  const done = (id) => `UPDATE tasks SET status = 'Done' WHERE id = ${q(id)};`;

  /** B Done while W is held: the Done saved, W untouched, one open record. */
  async function strandedUnblock(fields = {}, options = {}) {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P, ...fields });
    link(userA, waiting, blocker);
    const r = await whileHeld(waiting, done(blocker), options);
    assert.equal(task(blocker).status, "Done", "the Done saved");
    assert.equal(r.err.includes("ERROR"), false, r.err);
    assert.equal(retries(waiting).length, 1);
    return { blocker, waiting, r };
  }
  /** W pilled, B reopened while W is held: the reopen saved, the pill still there, one open record. */
  async function strandedReopen() {
    const { blocker, waiting } = pilledTask();
    await whileHeld(waiting, `UPDATE tasks SET status = 'Planned' WHERE id = ${q(blocker)};`);
    assert.equal(task(blocker).status, "Planned", "the reopen saved");
    assert.equal(retries(waiting).length, 1);
    return { blocker, waiting };
  }

  await test("failure: a lock timeout on the only waiter: the Done saves, nothing half-written, one durable record, retry finishes the job", async () => {
    const { blocker, waiting, r } = await strandedUnblock();
    assert.match(r.err, /WARNING:\s+task_unblock_on_status_change: 55P03 on task .*queued for retry/);
    assert.equal(task(waiting).status, "Blocked/Waiting");
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(unblockRows(waiting).length, 0);
    assert.equal(systemComments(waiting).length, 0);
    const [record] = retries(waiting);
    assert.deepEqual(
      [record.kind, record.blocker_type, record.blocker_id, record.task_status, record.error_code, record.attempts, record.closed_at],
      ["unblock", "task", blocker, "Blocked/Waiting", "55P03", 0, null]
    );
    // Repeating Done still doesn't retry; the retry does.
    psql(done(blocker));
    assert.equal(task(waiting).status, "Blocked/Waiting");
    const run = runRetries();
    assert.equal(run.ok, true);
    assert.ok(run.applied >= 1);
    const after = task(waiting);
    assert.equal(after.status, "Planned");
    assert.ok(sameInstant(after.due_at, endOfTodayEt()));
    assert.ok(after.unblocked_at);
    assert.equal(after.priority_score, 75);
    assert.equal(systemComments(waiting).length, 1);
    assert.deepEqual(transitions(waiting), [["Blocked/Waiting", "Planned"]]);
    const [row] = unblockRows(waiting);
    assert.equal(row.blocker_task_id, blocker);
    const [closed] = retries(waiting);
    assert.deepEqual([closed.closed_reason, closed.attempts], ["applied", 1]);
    // Idempotent: a second run touches nothing.
    const updatedAt = psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`);
    runRetries();
    assert.equal(psql(`SELECT updated_at FROM tasks WHERE id = ${q(waiting)};`), updatedAt);
    assert.equal(systemComments(waiting).length, 1);
    assert.equal(unblockRows(waiting).length, 1);
    assert.equal(retries(waiting)[0].attempts, 1);
  });

  for (const lockedPosition of ["first", "last"]) {
    await test(`failure: one of two waiters locked (${lockedPosition} in id order): the other still goes through and stays`, async () => {
      const blocker = makeTask(userA, { tags: P });
      const w1 = makeTask(userA, { status: "Blocked/Waiting", tags: P });
      const w2 = makeTask(userA, { status: "Blocked/Waiting", tags: P });
      link(userA, w1, blocker);
      link(userA, w2, blocker);
      const [low, high] = [w1, w2].sort();
      const [locked, free] = lockedPosition === "first" ? [low, high] : [high, low];
      await whileHeld(locked, done(blocker));
      assert.equal(task(blocker).status, "Done");
      assert.equal(task(free).status, "Planned", "not undone by the other's failure");
      assert.ok(task(free).unblocked_at);
      assert.equal(retries(free).length, 0);
      assert.equal(task(locked).status, "Blocked/Waiting");
      assert.equal(retries(locked).length, 1);
      runRetries();
      assert.equal(task(locked).status, "Planned");
      assert.equal(unblockRows(locked).length, 1);
    });
  }

  await test("failure: both of two waiters locked: both recorded, and the Done waits 5s once, not twice", async () => {
    const blocker = makeTask(userA, { tags: P });
    const w1 = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    const w2 = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, w1, blocker);
    link(userA, w2, blocker);
    const r = await whileHeld(w1, `BEGIN; ${done(blocker)} SHOW lock_timeout; COMMIT;`, { holdSql: `SELECT id FROM tasks WHERE id IN (${q(w1)}, ${q(w2)}) ORDER BY id FOR UPDATE` });
    assert.equal(r.out, "0", "the shorter wait stays inside the trigger");
    assert.equal(task(blocker).status, "Done");
    assert.equal(retries(w1).length + retries(w2).length, 2);
    assert.ok(r.ms < 7_000, `took ${r.ms} ms`);
    runRetries();
    assert.equal(task(w1).status, "Planned");
    assert.equal(task(w2).status, "Planned");
  });

  await test("failure: the API role's statement_timeout (QUERY_CANCELED, which OTHERS doesn't catch) can't undo the Done", async () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    const r = await whileHeld(waiting, `SET statement_timeout = '1s'; ${done(blocker)} RESET statement_timeout;`);
    assert.equal(r.err.includes("ERROR"), false, r.err);
    assert.equal(task(blocker).status, "Done", "the Done saved");
    assert.equal(retries(waiting)[0].error_code, "57014");
    runRetries();
    assert.equal(task(waiting).status, "Planned");
  });

  await test("failure: a caught deadlock against a cascade-style holder: the Done saves, the waiter is recorded, retry works", async () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    // The holder locks W then wants B; the trigger holds B and wants W. deadlock_timeout makes the trigger the victim.
    const holder = new Session("supabase_admin");
    const doer = new Session("supabase_admin");
    try {
      await holder.run(`SET deadlock_timeout = '30s'; BEGIN; SELECT id FROM tasks WHERE id = ${q(waiting)} FOR NO KEY UPDATE;`);
      await doer.run(`SET deadlock_timeout = '2500ms';`);
      const finished = doer.run(done(blocker), 20_000);
      await untilWaiting("UPDATE tasks SET status = 'Done'%");
      const second = holder.run(`UPDATE tasks SET title = title WHERE id = ${q(blocker)};`, 20_000);
      const r = await finished;
      assert.match(r.err, /40P01/);
      assert.equal((await second).err, "");
      await holder.run(`COMMIT;`);
    } finally {
      holder.close();
      doer.close();
    }
    assert.equal(task(blocker).status, "Done", "the Done saved");
    assert.equal(task(waiting).status, "Blocked/Waiting");
    assert.equal(retries(waiting)[0].error_code, "40P01");
    runRetries();
    assert.equal(task(waiting).status, "Planned");
  });

  await test("failure: a failed reopen saves, records 'reopen', and the retry clears the false pill and puts things back", async () => {
    const { blocker, waiting } = await strandedReopen();
    const held = task(waiting);
    assert.ok(held.unblocked_at, "still pilled until the retry");
    assert.equal(retries(waiting)[0].kind, "reopen");
    runRetries();
    const after = task(waiting);
    assert.equal(after.unblocked_at, null);
    assert.equal(after.status, "Blocked/Waiting");
    assert.equal(after.due_at, null);
    const [row] = unblockRows(waiting);
    assert.deepEqual([row.cleared_reason, row.revert_status_restored, row.revert_due_restored, row.reverted_by_id], ["reopened", true, true, blocker]);
    assert.equal(retries(waiting)[0].closed_reason, "applied");
  });

  await test("retry, reopen record: a later re-date is kept (compare-and-set) and the pill still clears", async () => {
    const { waiting } = await strandedReopen();
    const later = psql(`SELECT (now() + INTERVAL '6 days')::TEXT;`);
    asUser(userA, `UPDATE tasks SET due_at = ${q(later)} WHERE id = ${q(waiting)}`);
    runRetries();
    const after = task(waiting);
    assert.ok(sameInstant(after.due_at, later), "Brent's date stays");
    assert.equal(after.unblocked_at, null);
    assert.equal(after.status, "Blocked/Waiting");
  });

  await test("retry skipped, the task changed: a later status edit or re-date is not overwritten and no pill lands", async () => {
    const edits = [
      ["status = 'In Progress'", "In Progress"],
      [`due_at = now() + INTERVAL '6 days'`, "Blocked/Waiting"],
    ];
    for (const [set, status] of edits) {
      const { waiting } = await strandedUnblock({ tags: P });
      asUser(userA, `UPDATE tasks SET ${set} WHERE id = ${q(waiting)}`);
      const before = task(waiting);
      runRetries();
      assert.deepEqual(task(waiting), before, set);
      assert.equal(task(waiting).status, status);
      assert.equal(unblockRows(waiting).length, 0);
      assert.equal(systemComments(waiting).length, 0);
      assert.equal(retries(waiting)[0].closed_reason, "task_changed");
    }
  });

  await test("retry still applies: an unrelated later edit (title) or the edit that held the lock itself isn't 'changed'", async () => {
    const first = await strandedUnblock();
    asUser(userA, `UPDATE tasks SET title = 'Renamed' WHERE id = ${q(first.waiting)}`);
    runRetries();
    assert.equal(task(first.waiting).status, "Planned");
    assert.equal(retries(first.waiting)[0].closed_reason, "applied");
    // The holder re-dates W and commits after the failure: it began first, so it's what the trigger would have seen.
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    const later = psql(`SELECT (now() + INTERVAL '6 days')::TEXT;`);
    await whileHeld(waiting, done(blocker), { holdSql: `UPDATE tasks SET due_at = ${q(later)} WHERE id = ${q(waiting)}` });
    assert.equal(retries(waiting).length, 1);
    runRetries();
    const after = task(waiting);
    assert.equal(after.status, "Planned");
    assert.ok(sameInstant(after.due_at, later), "the later date is kept");
    assert.equal(retries(waiting)[0].closed_reason, "applied");
  });

  await test("retry skipped, the blocker changed: reopened since (unblock record), finished again (reopen record), deleted", async () => {
    const reopened = await strandedUnblock();
    setStatus(userA, reopened.blocker, "Planned");
    const before = task(reopened.waiting);
    runRetries();
    assert.deepEqual(task(reopened.waiting), before);
    assert.equal(systemComments(reopened.waiting).length, 0);
    assert.equal(retries(reopened.waiting)[0].closed_reason, "blocker_changed");

    const finishedAgain = await strandedReopen();
    setStatus(userA, finishedAgain.blocker, "Done");
    runRetries();
    assert.ok(task(finishedAgain.waiting).unblocked_at, "the blocker is Done again: the pill is true");
    assert.equal(unblockRows(finishedAgain.waiting)[0].cleared_at, null);
    assert.equal(retries(finishedAgain.waiting)[0].closed_reason, "blocker_changed");

    const deleted = await strandedUnblock();
    asUser(userA, `DELETE FROM tasks WHERE id = ${q(deleted.blocker)}`);
    runRetries();
    assert.equal(task(deleted.waiting).unblocked_at, null);
    assert.equal(retries(deleted.waiting)[0].closed_reason, "blocker_changed");
  });

  await test("a flip back and forth: the retry acts on where the blocker stands now, exactly once", async () => {
    const { blocker, waiting } = await strandedUnblock();
    setStatus(userA, blocker, "Planned");
    setStatus(userA, blocker, "Done"); // this Done works: W unblocks now
    assert.equal(task(waiting).status, "Planned");
    runRetries();
    assert.equal(unblockRows(waiting).length, 1, "no second unblock");
    assert.equal(systemComments(waiting).length, 1);
    assert.equal(retries(waiting)[0].closed_reason, "task_changed", "the second Done already moved it");
  });

  await test("retry reads the links and the task again: link removed, new open blocker, closed task, deleted task", async () => {
    const removed = await strandedUnblock();
    psql(`UPDATE task_dependencies SET is_resolved = true, resolved_at = now() WHERE task_id = ${q(removed.waiting)};`);
    runRetries();
    assert.equal(task(removed.waiting).status, "Blocked/Waiting", "removing a link by hand is not a trigger");
    assert.equal(retries(removed.waiting)[0].closed_reason, "task_changed");

    const reblocked = await strandedUnblock();
    link(userA, reblocked.waiting, makeTask(userA, { tags: P }));
    runRetries();
    assert.equal(task(reblocked.waiting).unblocked_at, null);
    assert.equal(retries(reblocked.waiting)[0].closed_reason, "nothing_to_do");

    const closed = await strandedUnblock({ status: "Planned" });
    psql(`UPDATE tasks SET status = 'Parked', updated_at = now() WHERE id = ${q(closed.waiting)};`);
    psql(`UPDATE task_unblock_retries SET failed_at = now() + INTERVAL '1 minute' WHERE task_id = ${q(closed.waiting)};`); // the parking counts as before the failure
    const parked = psql(`SELECT updated_at FROM tasks WHERE id = ${q(closed.waiting)};`);
    runRetries();
    assert.equal(psql(`SELECT updated_at FROM tasks WHERE id = ${q(closed.waiting)};`), parked, "no write on a closed task");
    assert.equal(systemComments(closed.waiting).length, 0, "no comment on a closed task");
    assert.equal(retries(closed.waiting)[0].closed_reason, "nothing_to_do");

    const gone = await strandedUnblock();
    asUser(userA, `DELETE FROM tasks WHERE id = ${q(gone.waiting)}`);
    runRetries();
    assert.equal(retries(gone.waiting)[0].closed_reason, "task_gone");
  });

  await test("a reopen record on a task closed since: nothing on the task, no comment, the bookkeeping closes", async () => {
    const { waiting } = await strandedReopen();
    setStatus(userA, waiting, "Parked");
    const closed = task(waiting);
    const comments = systemComments(waiting);
    runRetries();
    assert.deepEqual(task(waiting), closed);
    assert.deepEqual(systemComments(waiting), comments);
    assert.ok(unblockRows(waiting)[0].reverted_at);
  });

  await test("the retry takes the blocker lock: a reopen racing it waits and then undoes what it applied", async () => {
    const { blocker, waiting } = await strandedUnblock();
    const retry = new Session();
    const reopen = new Session();
    try {
      await reopen.signIn(userA);
      await retry.run(`BEGIN; SELECT task_unblock_run_retries(${q(userA)});`);
      const reopened = reopen.run(`UPDATE tasks SET status = 'Planned' WHERE id = ${q(blocker)};`);
      await untilWaiting("UPDATE tasks SET status = 'Planned'%");
      await retry.run(`COMMIT;`);
      assert.equal((await reopened).err, "");
      const after = task(waiting);
      assert.equal(after.unblocked_at, null, "no false pill");
      assert.equal(after.status, "Blocked/Waiting");
      assert.ok(unblockRows(waiting)[0].reverted_at);
    } finally {
      retry.close();
      reopen.close();
    }
  });

  await test("retry cap: a record that keeps failing counts attempts, stops at 8, stays visible as gave_up, and one failure doesn't stop another record", async () => {
    const owner = await makeUser("unblock-cap");
    const blocker = makeTask(owner, { tags: P });
    const stuck = makeTask(owner, { status: "Blocked/Waiting", tags: P });
    link(owner, stuck, blocker);
    const free = makeTask(owner, { status: "Blocked/Waiting", tags: P });
    link(owner, free, blocker);
    const holder = new Session();
    try {
      await holder.run(`BEGIN; SELECT id FROM tasks WHERE id = ${q(stuck)} FOR UPDATE;`);
      psql(done(blocker)); // 5s, the free task unblocks
      assert.equal(task(free).status, "Planned");
      // Make a second record whose waiter is free: it must succeed in the same run.
      const blocker2 = makeTask(owner, { tags: P, status: "Done" });
      const other = makeTask(owner, { status: "Blocked/Waiting", tags: P });
      link(owner, other, blocker2);
      psql(`INSERT INTO task_unblock_retries (user_id, kind, task_id, blocker_type, blocker_id, task_status, failed_at) VALUES (${q(owner)}, 'unblock', ${q(other)}, 'task', ${q(blocker2)}, 'Blocked/Waiting', now() + INTERVAL '1 minute');`);
      const first = runRetries(owner);
      assert.deepEqual([first.applied, first.failed, first.gave_up], [1, 1, 0], JSON.stringify(first));
      assert.equal(task(other).status, "Planned");
      assert.deepEqual([retries(stuck)[0].attempts, retries(stuck)[0].error_code, retries(stuck)[0].closed_at], [1, "55P03", null]);
      psql(`UPDATE task_unblock_retries SET attempts = 7 WHERE task_id = ${q(stuck)};`);
      const last = runRetries(owner);
      assert.deepEqual([last.failed, last.gave_up], [1, 1], JSON.stringify(last));
      assert.equal(retries(stuck)[0].attempts, 8);
      // Past the cap it isn't tried again, and it stays in the owner's count.
      const after = runRetries(owner);
      assert.deepEqual([after.applied, after.skipped, after.failed, after.gave_up], [0, 0, 0, 1]);
      assert.equal(retries(stuck)[0].attempts, 8);
      assert.equal(asUser(owner, `SELECT count(*) FROM task_unblock_retries WHERE closed_at IS NULL AND attempts >= 8`), "1");
      assert.equal(asUser(userB, `SELECT count(*) FROM task_unblock_retries WHERE task_id = ${q(stuck)}`), "0");
    } finally {
      await holder.run(`ROLLBACK;`);
      holder.close();
    }
    runRetries(owner);
    assert.equal(task(stuck).status, "Blocked/Waiting", "gave up: left as it is");
  });

  await test("two retry runs at once take different records (SKIP LOCKED); a run for another user sees none", async () => {
    const { waiting } = await strandedUnblock();
    const other = new Session();
    try {
      await other.run(`BEGIN; SELECT id FROM task_unblock_retries WHERE task_id = ${q(waiting)} FOR UPDATE;`);
      const run = runRetries();
      assert.equal(retries(waiting)[0].closed_at, null, `skipped while another run holds it: ${JSON.stringify(run)}`);
      await other.run(`COMMIT;`);
      assert.deepEqual(runRetries(userB), { ok: true, applied: 0, skipped: 0, failed: 0, gave_up: 0 });
      assert.equal(retries(waiting)[0].closed_at, null);
      runRetries();
      assert.equal(task(waiting).status, "Planned");
    } finally {
      other.close();
    }
  });

  await test("RLS and calls: the records are the owner's; no direct writes; the waiter function and the retry can't be called through the API", async () => {
    const { waiting } = await strandedUnblock();
    assert.equal(asUser(userA, `SELECT count(*) FROM task_unblock_retries WHERE task_id = ${q(waiting)}`), "1");
    assert.equal(asUser(userB, `SELECT count(*) FROM task_unblock_retries WHERE task_id = ${q(waiting)}`), "0");
    assert.match(asUserFails(userA, `INSERT INTO task_unblock_retries (user_id, kind, task_id, blocker_type, blocker_id, task_status) VALUES (${q(userA)}, 'unblock', ${q(waiting)}, 'task', ${q(waiting)}, 'Planned')`), /row-level security/);
    assert.match(asUserFails(userA, `UPDATE task_unblock_retries SET closed_at = now(), closed_reason = 'applied' WHERE task_id = ${q(waiting)}`), /permission denied/);
    assert.match(asUserFails(userA, `DELETE FROM task_unblock_retries WHERE task_id = ${q(waiting)}`), /permission denied/);
    assert.match(asUserFails(userA, `SELECT task_unblock_run_retries(${q(userA)})`), /permission denied/);
    assert.match(asUserFails(userA, `SELECT task_unblock_process_waiter('task', ${q(waiting)}, ${q(userA)}, ${q(waiting)}, true, now())`), /only the unblock trigger and retry/);
    assert.match(psqlFails(`SELECT task_unblock_process_waiter('task', ${q(waiting)}, ${q(userA)}, ${q(waiting)}, true, now());`), /only the unblock trigger and retry/);
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(psql(`SELECT current_setting('mission_control.unblock_writer', true) IS DISTINCT FROM 'on';`), "t");
    runRetries();
  });

  await test("the real cron route: GET /api/calendar/sync with the cron secret runs the retry as service_role; a bad retry never fails the sync", async () => {
    const { waiting } = await strandedUnblock();
    const reopened = await strandedReopen();
    Object.assign(process.env, {
      CRON_SECRET: "unblock-test-cron",
      MISSION_CONTROL_USER_ID: userA,
      CALENDAR_SOURCE: "none",
      NEXT_PUBLIC_SUPABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    });
    const { GET } = await import("../src/app/api/calendar/sync/route.ts");
    const call = () => GET(new NextRequest("http://localhost/api/calendar/sync", { headers: { authorization: "Bearer unblock-test-cron" } }));
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(task(waiting).status, "Planned");
    assert.equal(retries(waiting)[0].closed_reason, "applied");
    assert.equal(task(reopened.waiting).unblocked_at, null);
    assert.equal(retries(reopened.waiting)[0].closed_reason, "applied");
    // Without the secret no retry runs.
    const second = await strandedUnblock();
    const refused = await GET(new NextRequest("http://localhost/api/calendar/sync"));
    assert.notEqual(refused.status, 200);
    assert.equal(retries(second.waiting)[0].closed_at, null);
    // The retry function missing (or anything else) leaves the sync's reply alone.
    psql(`ALTER FUNCTION task_unblock_run_retries(UUID, INT) RENAME TO task_unblock_run_retries_x; NOTIFY pgrst, 'reload schema';`);
    try {
      await sleep(600);
      assert.equal((await call()).status, 200);
    } finally {
      psql(`ALTER FUNCTION task_unblock_run_retries_x(UUID, INT) RENAME TO task_unblock_run_retries; NOTIFY pgrst, 'reload schema';`);
    }
    await sleep(600);
    runRetries();
    assert.equal(task(second.waiting).status, "Planned");
  });

  // ── Part 9: the retry and cleared pills; Remove from a signed-in session ──

  const inSixDays = () => psql(`SELECT (now() + INTERVAL '6 days')::TEXT;`);

  /** W (Planned, a later date: nothing but the pill changes) waits on B1 and B2. B1 finishes while W is held: an open record. B2 finishes normally: pill on. */
  async function failedThenUnblocked() {
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { tags: P, due_at: inSixDays() });
    link(userA, waiting, b1);
    link(userA, waiting, b2);
    await whileHeld(waiting, done(b1));
    assert.equal(retries(waiting).length, 1);
    assert.equal(retries(waiting)[0].closed_at, null);
    setStatus(userA, b2, "Done");
    assert.ok(task(waiting).unblocked_at, "the normal unblock put the pill on");
    assert.equal(unblockRows(waiting).length, 1);
    return { b1, b2, waiting };
  }
  /** The pill was cleared after the failure: the retry closes the record and touches nothing. */
  function retryLeavesItAlone(waiting) {
    const before = task(waiting);
    assert.equal(before.unblocked_at, null, "the schedule cleared the pill");
    const rows = unblockRows(waiting).length;
    const comments = systemComments(waiting).length;
    const moves = transitions(waiting);
    runRetries();
    assert.deepEqual(task(waiting), before, "no pill, nothing written");
    assert.equal(unblockRows(waiting).length, rows, "no second row");
    assert.equal(systemComments(waiting).length, comments, "no second comment");
    assert.deepEqual(transitions(waiting), moves);
    assert.deepEqual(retries(waiting).map((r) => r.closed_reason), ["task_changed"]);
  }

  await test("retry, cleared pill (a): two blockers, the first failed, the second unblocked, clear_task_unblock: stays cleared", async () => {
    const { waiting } = await failedThenUnblocked();
    assert.deepEqual(json(`SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'brief');`), { ok: true, cleared: true });
    retryLeavesItAlone(waiting);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "brief");
  });

  await test("retry, cleared pill (b): Done while held, reopen, Done, In Progress and back to Planned: stays cleared", async () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { tags: P, due_at: inSixDays() });
    link(userA, waiting, blocker);
    await whileHeld(waiting, done(blocker));
    assert.equal(retries(waiting).length, 1);
    setStatus(userA, blocker, "Planned");
    setStatus(userA, blocker, "Done");
    assert.ok(task(waiting).unblocked_at);
    setStatus(userA, waiting, "In Progress");
    setStatus(userA, waiting, "Planned");
    retryLeavesItAlone(waiting);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "started");
  });

  await test("retry, cleared pill (c): cleared by a new blocker whose link is then removed: stays cleared", async () => {
    const { waiting } = await failedThenUnblocked();
    const third = makeTask(userA, { tags: P });
    const thirdLink = link(userA, waiting, third);
    assert.equal(task(waiting).unblocked_at, null, "the new blocker cleared it");
    // As the machine keys do it, so this schedule doesn't depend on the session policy below.
    psql(`UPDATE task_dependencies SET is_resolved = true, resolved_at = now() WHERE id = ${q(thirdLink)};`);
    retryLeavesItAlone(waiting);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "reblocked");
  });

  await test("retry, control (d): a plain failed waiter with nothing after it still unblocks, once", async () => {
    const { waiting } = await strandedUnblock({ status: "Planned", due_at: inSixDays() });
    assert.equal(unblockRows(waiting).length, 0);
    runRetries();
    assert.ok(task(waiting).unblocked_at);
    assert.equal(unblockRows(waiting).length, 1);
    assert.equal(systemComments(waiting).length, 1);
    assert.deepEqual(retries(waiting).map((r) => r.closed_reason), ["applied"]);
  });

  await test("retry, own failure is the newest event: an unblock cleared BEFORE the failure doesn't stop it", async () => {
    const { blocker, waiting } = pilledTask();
    setStatus(userA, waiting, "In Progress");
    setStatus(userA, waiting, "Planned");
    setStatus(userA, blocker, "Planned");
    const earlier = unblockRows(waiting);
    assert.equal(earlier.length, 1);
    assert.ok(earlier[0].cleared_at && earlier[0].reverted_at);
    await whileHeld(waiting, done(blocker));
    const [record] = retries(waiting);
    assert.ok(Date.parse(earlier[0].cleared_at) <= Date.parse(record.failed_at));
    runRetries();
    assert.ok(task(waiting).unblocked_at, "this Done is newer than the old clear");
    assert.equal(unblockRows(waiting).length, 2);
    assert.deepEqual(retries(waiting).map((r) => r.closed_reason), ["applied"]);
  });

  await test("retry, own failure is the newest event: a clear that held the lock began before the failure, so the new Done still lands", async () => {
    const { blocker, waiting } = await strandedReopen();
    await whileHeld(waiting, done(blocker), { holdSql: `SELECT clear_task_unblock(${q(userA)}, ${q(waiting)}, 'manual')` });
    assert.equal(task(waiting).unblocked_at, null);
    assert.deepEqual(retries(waiting).map((r) => r.kind), ["reopen", "unblock"]);
    runRetries();
    assert.ok(task(waiting).unblocked_at, "the trigger would have seen that clear had its wait been shorter");
    assert.deepEqual(retries(waiting).map((r) => r.closed_reason), ["blocker_changed", "applied"]);
  });

  await test("retry, two records for one task: the first applies, the second adds nothing", async () => {
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { tags: P, due_at: inSixDays() });
    link(userA, waiting, b1);
    link(userA, waiting, b2);
    await whileHeld(waiting, `${done(b1)} ${done(b2)}`, { ms: 40_000 });
    assert.equal(retries(waiting).length, 2);
    runRetries();
    assert.ok(task(waiting).unblocked_at);
    assert.equal(unblockRows(waiting).length, 1);
    assert.equal(systemComments(waiting).length, 1);
    assert.deepEqual(retries(waiting).map((r) => r.closed_reason), ["applied", "task_changed"]);
  });

  process.env.DEPLOYMENT_ROLE ??= "main";
  const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
  const removeRoute = await import("../src/app/api/tasks/[id]/dependencies/[dep_id]/route.ts");
  const linksRoute = await import("../src/app/api/tasks/[id]/dependencies/route.ts");
  const clientA = await userClient(userA);
  const clientB = await userClient(userB);
  const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const reply = async (response) => ({ status: response.status, body: await response.json() });
  const deleteRequest = (path, client, userId) =>
    writeInternalAuthContext(new NextRequest(`http://localhost${path}`, { method: "DELETE" }), { supabase: client, user: { id: userId }, userId, authSource: "session" });
  /** The Remove button: DELETE /api/tasks/{id}/dependencies/{dep_id} on the browser's own session. */
  const removeLink = async (taskId, linkId, client = clientA, userId = userA) =>
    reply(await removeRoute.DELETE(deleteRequest(`/api/tasks/${taskId}/dependencies/${linkId}`, client, userId), { params: Promise.resolve({ id: taskId, dep_id: linkId }) }));
  const linkRow = (id) => json(`SELECT row_to_json(d) FROM (SELECT user_id, is_resolved, resolved_at FROM task_dependencies WHERE id = ${q(id)}) d;`);
  const UPDATE_POLICY = `pg_policies WHERE tablename = 'task_dependencies' AND cmd = 'UPDATE'`;

  await test("Remove: the UPDATE policy is owner-only, USING and WITH CHECK, and authenticated has the table grant", () => {
    assert.equal(psql(`SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE tablename = 'task_dependencies';`), "DELETE,INSERT,SELECT,UPDATE");
    assert.equal(psql(`SELECT policyname || '|' || permissive || '|' || qual || '|' || with_check FROM ${UPDATE_POLICY};`), "Users can update own task_dependencies|PERMISSIVE|(auth.uid() = user_id)|(auth.uid() = user_id)");
    assert.equal(psql(`SELECT has_table_privilege('authenticated', 'public.task_dependencies', 'UPDATE');`), "t");
  });

  await test("Remove: a signed-in session succeeds through the real route (200, link resolved); the legacy route too; a second Remove is 404", async () => {
    const waiting = makeTask(userA, { tags: P });
    const blocker = makeTask(userA, { tags: P });
    const linkId = link(userA, waiting, blocker);
    assert.deepEqual(await removeLink(waiting, linkId), { status: 200, body: { success: true } });
    const row = linkRow(linkId);
    assert.equal(row.is_resolved, true);
    assert.ok(row.resolved_at);
    assert.equal((await removeLink(waiting, linkId)).status, 404);

    const legacyId = link(userA, waiting, blocker);
    const legacy = await reply(await linksRoute.DELETE(deleteRequest(`/api/tasks/${waiting}/dependencies?dependencyId=${legacyId}`, clientA, userA), { params: Promise.resolve({ id: waiting }) }));
    assert.deepEqual(legacy, { status: 200, body: { success: true } });
    assert.equal(linkRow(legacyId).is_resolved, true);
  });

  await test("Remove: another user's session or no session can't touch the row, and the owner can't hand it to someone else", async () => {
    const waiting = makeTask(userA, { tags: P });
    const blocker = makeTask(userA, { tags: P });
    const linkId = link(userA, waiting, blocker);
    assert.equal((await removeLink(waiting, linkId, clientB, userB)).status, 404);
    const direct = await clientB.from("task_dependencies").update({ is_resolved: true }).eq("id", linkId).select("id");
    assert.equal(direct.error, null);
    assert.deepEqual(direct.data, []);
    assert.equal(asUser(userB, `WITH u AS (UPDATE task_dependencies SET is_resolved = true WHERE id = ${q(linkId)} RETURNING 1) SELECT count(*) FROM u`), "0");
    const anon = await anonClient.from("task_dependencies").update({ is_resolved: true }).eq("id", linkId).select("id");
    assert.ok(anon.error || anon.data.length === 0, "no session, no row");
    const moved = await clientA.from("task_dependencies").update({ user_id: userB }).eq("id", linkId).select("id");
    assert.equal(moved.error?.code, "42501", "WITH CHECK refuses another owner");
    assert.deepEqual([linkRow(linkId).user_id, linkRow(linkId).is_resolved], [userA, false]);
  });

  await test("Remove: the 061 loop guard still refuses a session turning a link back on when that makes a loop", async () => {
    const t1 = makeTask(userA, { tags: P });
    const t2 = makeTask(userA, { tags: P });
    const forward = link(userA, t1, t2);
    assert.equal((await removeLink(t1, forward)).status, 200);
    link(userA, t2, t1);
    const back = await clientA.from("task_dependencies").update({ is_resolved: false, resolved_at: null }).eq("id", forward).select("id");
    assert.equal(back.error?.code, "MC061", JSON.stringify(back.error));
    assert.equal(linkRow(forward).is_resolved, true, "nothing saved");
  });

  await test("Remove: 067's link trigger: removing keeps a pill, a session turning a link to an open item back on clears it", async () => {
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, b1);
    const openLink = link(userA, waiting, b2);
    assert.equal((await removeLink(waiting, openLink)).status, 200);
    setStatus(userA, b1, "Done");
    const pill = task(waiting).unblocked_at;
    assert.ok(pill, "the removed link no longer holds it");
    const doneLink = psql(`SELECT id FROM task_dependencies WHERE task_id = ${q(waiting)} AND depends_on_task_id = ${q(b1)};`);
    assert.equal((await removeLink(waiting, doneLink)).status, 200);
    assert.ok(sameInstant(task(waiting).unblocked_at, pill), "a Remove never touches the pill");
    const back = await clientA.from("task_dependencies").update({ is_resolved: false, resolved_at: null }).eq("id", openLink).select("id");
    assert.equal(back.error, null, JSON.stringify(back.error));
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(unblockRows(waiting)[0].cleared_reason, "reblocked");
  });

  await test("Remove: a hand-removed last link still does NOT unblock (one blocker; the last of two with the other Done)", async () => {
    const one = makeTask(userA, { tags: P });
    const onlyWaiter = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    const onlyLink = link(userA, onlyWaiter, one);
    const b1 = makeTask(userA, { tags: P });
    const b2 = makeTask(userA, { tags: P });
    const lastWaiter = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, lastWaiter, b1);
    const lastLink = link(userA, lastWaiter, b2);
    setStatus(userA, b1, "Done");
    for (const [waiting, linkId] of [[onlyWaiter, onlyLink], [lastWaiter, lastLink]]) {
      const before = task(waiting);
      assert.equal((await removeLink(waiting, linkId)).status, 200);
      assert.deepEqual(task(waiting), before, "Waiting, no pill, nothing moved");
      assert.equal(unblockRows(waiting).length, 0);
      assert.equal(systemComments(waiting).length, 0);
      assert.deepEqual(transitions(waiting), []);
    }
  });

  await test("Remove: re-applying 067 replaces a same-named policy production may already have", () => {
    const stored = psql(`SELECT count(*) FROM ${UPDATE_POLICY};`);
    psql(`DROP POLICY IF EXISTS "Users can update own task_dependencies" ON task_dependencies; CREATE POLICY "Users can update own task_dependencies" ON task_dependencies FOR UPDATE USING (true);`);
    try {
      psql(MIGRATION);
      assert.equal(psql(`SELECT qual || '|' || with_check FROM ${UPDATE_POLICY};`), "(auth.uid() = user_id)|(auth.uid() = user_id)");
    } finally {
      if (stored === "0") psql(`DROP POLICY IF EXISTS "Users can update own task_dependencies" ON task_dependencies;`);
    }
  });

  await test("the invariant: unblocked_at is set iff an open task_unblocks row exists, on every task this run touched", () => {
    const owners = users.map(q).join(", ");
    assert.equal(psql(`SELECT count(*) FROM tasks t WHERE t.user_id IN (${owners}) AND (t.unblocked_at IS NOT NULL) <> EXISTS (SELECT 1 FROM task_unblocks u WHERE u.task_id = t.id AND u.cleared_at IS NULL);`), "0");
  });
} finally {
  for (const id of users) {
    psql(`DELETE FROM task_unblock_retries WHERE user_id = '${id}'; DELETE FROM task_dependencies WHERE user_id = '${id}'; DELETE FROM tasks WHERE user_id = '${id}'; DELETE FROM commitments WHERE user_id = '${id}'; DELETE FROM stakeholders WHERE user_id = '${id}';`);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
