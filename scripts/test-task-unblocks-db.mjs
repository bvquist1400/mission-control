#!/usr/bin/env node
// Database tests for "Now unblocked" (Baseline 2f6b39f2 / S2 task 1349c17a,
// migration 067), against a LOCAL Supabase stack with every migration applied
// (scripts/test-stack/up.sh):
//
//   UNBLOCK_TEST_SUPABASE_URL=$STACK_API_URL UNBLOCK_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY \
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
// Part 5: RLS (no direct writes, no cross-user reads), failure isolation (a
//         held row lock past lock_timeout: the Done still saves), two blockers
//         finished at once in two sessions (exactly one unblock), and a bulk
//         Done of both blockers in one statement (one unblock).
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.UNBLOCK_TEST_SUPABASE_URL;
const serviceKey = process.env.UNBLOCK_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.UNBLOCK_TEST_DB_CONTAINER;

if (!url || !serviceKey || !dbContainer) {
  console.error("Set UNBLOCK_TEST_SUPABASE_URL, UNBLOCK_TEST_SERVICE_ROLE_KEY and UNBLOCK_TEST_DB_CONTAINER (local stack only).");
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
  constructor() {
    this.proc = spawn("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"]);
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
async function makeUser(prefix) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${prefix}-${randomUUID().slice(0, 8)}@example.test`,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  return data.user.id;
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
    // (No DELETE grant in 067; up.sh grants ALL like production's default privileges, so RLS (no DELETE policy) is what denies it: see Part 5.)
    assert.equal(psql(`SELECT has_function_privilege('anon', 'public.clear_task_unblock(uuid, uuid, text)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'public.clear_task_unblock(uuid, uuid, text)', 'EXECUTE');`), "t");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_tasks_unblock_dependents','trg_commitments_unblock_dependents','trg_tasks_unblock_pill','trg_tasks_unblock_pill_insert','trg_task_dependencies_unblock_reblock');`), "5");
  });

  await test("067: no backfill (a blocker already Done when 067 is applied changes nothing); rollback and re-apply twice", () => {
    psql(ROLLBACK);
    assert.equal(psql(`SELECT to_regclass('public.task_unblocks') IS NULL;`), "t");
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
    assert.equal(task(waiting).status, "Blocked/Waiting", "nothing unblocked on apply");
    assert.equal(task(waiting).unblocked_at, null);
    assert.equal(psql(`SELECT count(*) FROM task_unblocks;`), "0");
    assert.equal(psql(`SELECT count(*) FROM task_comments;`), commentsBefore);
    // Every row's text gains the new NULL column, nothing else.
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE unblocked_at IS NOT NULL;`), "0");
    assert.ok(before.length === 32);
  });

  // ── Part 2: the rules ────────────────────────────────────────────────────

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
    assert.equal(after.priority_score, Math.min(100, before.priority_score + 20 + 25), "+20 leaving Waiting, +25 due today");
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
    // No DELETE policy: denied (permission denied without a grant, 0 rows with one).
    const deleted = (() => {
      try {
        return asUser(userA, `WITH d AS (DELETE FROM task_unblocks WHERE task_id = ${q(waiting)} RETURNING 1) SELECT count(*) FROM d`);
      } catch (error) {
        assert.match(String(error.stderr ?? error.message), /permission denied/);
        return "0";
      }
    })();
    assert.equal(deleted, "0");
    assert.equal(asUser(userB, `SELECT count(*) FROM task_unblocks WHERE task_id = ${q(waiting)}`), "0");
    assert.equal(asUser(userA, `SELECT count(*) FROM task_unblocks WHERE task_id = ${q(waiting)}`), "1");
    assert.equal(psql(`SELECT current_setting('mission_control.unblock_writer', true) IS DISTINCT FROM 'on';`), "t");
  });

  await test("failure isolation: a waiting task locked past lock_timeout -> the Done still saves, nothing half-written", async () => {
    const blocker = makeTask(userA, { tags: P });
    const waiting = makeTask(userA, { status: "Blocked/Waiting", tags: P });
    link(userA, waiting, blocker);
    const holder = new Session();
    const doer = new Session();
    try {
      await holder.signIn(userA);
      await doer.signIn(userA);
      await holder.run(`BEGIN; SELECT id FROM tasks WHERE id = ${q(waiting)} FOR UPDATE;`);
      const done = doer.run(`UPDATE tasks SET status = 'Done' WHERE id = ${q(blocker)};`, 20_000);
      const result = await done; // lock_timeout 5s inside the trigger, caught
      assert.match(result.err, /WARNING:\s+task_unblock_on_status_change/);
      await holder.run(`COMMIT;`);
      assert.equal(task(blocker).status, "Done", "the Done saved");
      assert.equal(task(waiting).status, "Blocked/Waiting");
      assert.equal(unblockRows(waiting).length, 0);
      assert.equal(systemComments(waiting).length, 0);
    } finally {
      holder.close();
      doer.close();
    }
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
} finally {
  for (const id of users) {
    psql(`DELETE FROM task_dependencies WHERE user_id = '${id}'; DELETE FROM tasks WHERE user_id = '${id}'; DELETE FROM commitments WHERE user_id = '${id}'; DELETE FROM stakeholders WHERE user_id = '${id}';`);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
