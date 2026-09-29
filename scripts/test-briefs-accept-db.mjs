#!/usr/bin/env node
// Database tests for Accept scheduling (task 98683030, migration 058), run
// against a LOCAL Supabase stack with every migration applied:
//
//   BRIEFS_TEST_SUPABASE_URL=http://127.0.0.1:62321 \
//   BRIEFS_TEST_ANON_KEY=... BRIEFS_TEST_SERVICE_ROLE_KEY=... \
//   BRIEFS_TEST_DB_CONTAINER=supabase_db_<project_id> \
//   npm run test:briefs-accept-db
//
// Accept creates the task owned by Brent with the chosen due date (default
// Tomorrow, "none" = no date); a repeat Accept never changes the task; the
// function refuses a bad due_at without claiming the item. The last test
// rolls 058 back and re-applies it (psql through `docker exec`), then leaves
// the stack on 058.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.BRIEFS_TEST_SUPABASE_URL;
const anonKey = process.env.BRIEFS_TEST_ANON_KEY;
const serviceKey = process.env.BRIEFS_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.BRIEFS_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set BRIEFS_TEST_SUPABASE_URL, BRIEFS_TEST_ANON_KEY, BRIEFS_TEST_SERVICE_ROLE_KEY and BRIEFS_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and replaces a function. Local stacks only.`);
  process.exit(2);
}
if (!/^supabase_db_[A-Za-z0-9_-]+$/.test(dbContainer)) {
  console.error(`Refusing BRIEFS_TEST_DB_CONTAINER=${dbContainer}: expected a local supabase_db_<project> container.`);
  process.exit(2);
}

delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, getBrief, actOnBriefItems, BriefServiceError } = await import("../src/lib/briefs/service.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");
const { resolveTomorrowDueAt } = await import("../src/lib/briefs/keys.ts");
const due = await import("../src/lib/briefs/due.ts").catch(() => ({}));

const MIGRATION_055 = readFileSync(new URL("../supabase/migrations/055_add_briefs.sql", import.meta.url), "utf8");
const MIGRATION_058_URL = new URL("../supabase/migrations/058_brief_accept_owner_due.sql", import.meta.url);
const ROLLBACK_058_URL = new URL("../supabase/rollbacks/058_brief_accept_owner_due.down.sql", import.meta.url);
const read = (fileUrl) => readFileSync(fileUrl, "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}

const APP_URL = "http://localhost:3000";
const quiet = { send: async () => {} };
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function rejects(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BriefServiceError, `expected BriefServiceError, got ${error?.message ?? error}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a rejection");
}

async function makeUser(label) {
  const email = `briefs-accept-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

function actions(list) {
  const result = parseBriefActions(list);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

const MEETING = { id: "7c1e0f9a-accept-sched", title: "DEP workgroup", start: "2026-09-29T14:00:00Z", url: "https://notes.granola.ai/d/7c1e0f9a" };
let lineNo = 0;
function proposal(title, extra = {}) {
  lineNo += 1;
  return { kind: "proposed_task", title, source: { meetings: [{ ...MEETING, lines: [`${title} (Brent) #${lineNo}`] }] }, ...extra };
}

async function saveItems(userId, date, items, edition = "eod") {
  const parsed = parseSaveBriefInput({ edition, date, covered_meeting_ids: [MEETING.id], items }, new Date(`${date}T20:15:00Z`));
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return saveBrief(admin, userId, parsed.value, { appUrl: APP_URL, notifier: quiet });
}

const TASK_COLUMNS = "id, owner, owner_label, status_line, due_at, status, title, base_priority, priority_score, external_source_system, external_source_id, updated_at";

async function taskOf(userId, code, n) {
  const view = await getBrief(admin, userId, code, { appUrl: APP_URL });
  const item = view.items.find((entry) => entry.n === n);
  if (!item.created_task_id) return { item, task: null };
  const { data, error } = await admin.from("tasks").select(TASK_COLUMNS).eq("id", item.created_task_id).single();
  if (error) throw error;
  return { item, task: data };
}

const iso = (value) => (value === null ? null : new Date(value).toISOString());

const users = [];
try {
  const alice = await makeUser("alice");
  users.push(alice);
  const NOW = new Date("2026-09-29T21:00:00Z"); // Tue 9/29, 5:00 PM EDT

  const saved = await saveItems(alice.id, "2026-09-29", [
    proposal("Default accept item"), // 1
    proposal("Today item"), // 2
    proposal("This week item"), // 3
    proposal("No date item"), // 4
    proposal("Notes date item", { suggested_due: "2026-10-12" }), // 5
    proposal("Wrong date item", { suggested_due: "2026-10-12" }), // 6
    proposal("Undated item"), // 7
    proposal("Repeat item"), // 8
    proposal("Race item"), // 9
    proposal("Page item"), // 10
  ]);
  const code = saved.code;

  await test("Accept with no due: owner brent, due end of tomorrow ET (the carry-over rule), reported back", async () => {
    const result = await actOnBriefItems(admin, alice.id, code, actions([{ n: 1, action: "accept" }]), { now: NOW });
    assert.equal(result.results[0].ok, true, result.results[0].error);
    const expected = resolveTomorrowDueAt("2026-09-29", NOW);
    assert.equal(expected, "2026-10-01T03:59:59.999Z"); // Wed 9/30 23:59:59.999 EDT
    const { task } = await taskOf(alice.id, code, 1);
    assert.equal(task.owner, "brent");
    assert.equal(task.owner_label, null);
    assert.equal(task.status, "Backlog");
    assert.equal(iso(task.due_at), expected);
    assert.equal(result.results[0].due_at, expected);
    assert.equal(result.results[0].owner, "brent");
  });

  await test("today / this_week / none / the notes' date each land where they should", async () => {
    const result = await actOnBriefItems(
      admin,
      alice.id,
      code,
      actions([
        { n: 2, action: "accept", due: "today" },
        { n: 3, action: "accept", due: "this_week" },
        { n: 4, action: "accept", due: "none" },
        { n: 5, action: "accept", due: "2026-10-12" },
      ]),
      { now: NOW }
    );
    assert.ok(result.results.every((entry) => entry.ok), JSON.stringify(result.results));
    const expected = { 2: "2026-09-30T03:59:59.999Z", 3: "2026-10-03T03:59:59.999Z", 4: null, 5: "2026-10-13T03:59:59.999Z" };
    for (const [n, dueAt] of Object.entries(expected)) {
      const { task } = await taskOf(alice.id, code, Number(n));
      assert.equal(task.owner, "brent", `#${n}`);
      assert.equal(iso(task.due_at), dueAt, `#${n}`);
      assert.equal(result.results.find((entry) => entry.n === Number(n)).due_at, dueAt, `#${n} result`);
    }
  });

  await test("the due date is part of the first priority score (real clock: today = +25, none = +0)", async () => {
    const own = await saveItems(alice.id, "2026-09-28", [proposal("Priority today"), proposal("Priority none")]);
    await actOnBriefItems(admin, alice.id, own.code, actions([{ n: 1, action: "accept", due: "today" }, { n: 2, action: "accept", due: "none" }]));
    const { task: today } = await taskOf(alice.id, own.code, 1);
    const { task: none } = await taskOf(alice.id, own.code, 2);
    assert.equal(today.base_priority, 50);
    assert.equal(today.priority_score, 75);
    assert.equal(none.priority_score, 50);
  });

  await test("a date that isn't the item's notes date is a 400, and nothing changes", async () => {
    await rejects(actOnBriefItems(admin, alice.id, code, actions([{ n: 6, action: "accept", due: "2026-10-13" }]), { now: NOW }), 400, /only date allowed is the one from the notes \(2026-10-12\)/);
    await rejects(actOnBriefItems(admin, alice.id, code, actions([{ n: 7, action: "accept", due: "2026-10-12" }]), { now: NOW }), 400, /has no date from the notes/);
    // One bad entry blocks the whole batch.
    await rejects(
      actOnBriefItems(admin, alice.id, code, actions([{ n: 7, action: "accept" }, { n: 6, action: "accept", due: "2026-10-01" }]), { now: NOW }),
      400
    );
    for (const n of [6, 7]) {
      const { item, task } = await taskOf(alice.id, code, n);
      assert.equal(item.state, "open", `#${n}`);
      assert.equal(task, null, `#${n}`);
    }
  });

  await test("re-accept is a no-op: a different due never touches the task (row byte-for-byte the same)", async () => {
    await actOnBriefItems(admin, alice.id, code, actions([{ n: 8, action: "accept", due: "today" }]), { now: NOW });
    const { task: before } = await taskOf(alice.id, code, 8);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const choice of ["none", "this_week", "tomorrow", undefined]) {
      const again = await actOnBriefItems(admin, alice.id, code, actions([{ n: 8, action: "accept", ...(choice ? { due: choice } : {}) }]), { now: NOW });
      assert.equal(again.results[0].ok, true);
      assert.equal(again.results[0].already, true);
      assert.equal(again.results[0].task_id, before.id);
      assert.equal("due_at" in again.results[0], false, "a repeat doesn't claim a due date it didn't set");
    }
    const { task: after } = await taskOf(alice.id, code, 8);
    assert.deepEqual(after, before);
  });

  await test("racing Accepts with different dues: one task, one due date, both callers succeed", async () => {
    const racers = await Promise.all(
      ["today", "none", "this_week", "tomorrow"].map((choice) => actOnBriefItems(admin, alice.id, code, actions([{ n: 9, action: "accept", due: choice }]), { now: NOW }))
    );
    const ids = new Set(racers.map((result) => result.results[0].task_id));
    assert.equal(ids.size, 1);
    assert.ok(racers.every((result) => result.results[0].ok));
    const { count } = await admin.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", alice.id).eq("title", "Race item");
    assert.equal(count, 1);
    const winners = racers.filter((result) => !result.results[0].already);
    assert.equal(winners.length, 1, "exactly one call created it");
    const { task } = await taskOf(alice.id, code, 9);
    assert.equal(iso(task.due_at), winners[0].results[0].due_at);
  });

  await test("the page path (Brent's own client, under RLS) accepts with a due choice too", async () => {
    const result = await actOnBriefItems(alice.client, alice.id, code, actions([{ n: 10, action: "accept", due: "this_week" }]), { now: NOW });
    assert.equal(result.results[0].ok, true, result.results[0].error);
    const { task } = await taskOf(alice.id, code, 10);
    assert.equal(task.owner, "brent");
    assert.equal(iso(task.due_at), "2026-10-03T03:59:59.999Z");
  });

  await test("a proposal on a morning (AM) brief is accepted the same way (nothing branches on edition)", async () => {
    const am = await saveItems(alice.id, "2026-09-30", [proposal("AM proposal")], "am");
    assert.equal(am.code, "AM-0930");
    await actOnBriefItems(admin, alice.id, am.code, actions([{ n: 1, action: "accept" }]), { now: new Date("2026-09-30T12:05:00Z") });
    const { task } = await taskOf(alice.id, am.code, 1);
    assert.equal(task.owner, "brent");
    assert.equal(iso(task.due_at), "2026-10-02T03:59:59.999Z"); // Thu 10/1
  });

  await test("the function refuses a bad due_at with 22023 and leaves the item open with no task", async () => {
    const own = await saveItems(alice.id, "2026-10-05", [proposal("RPC item")]);
    const item = (await getBrief(admin, alice.id, own.code, { appUrl: APP_URL })).items[0];
    const call = (dueAt) =>
      admin.rpc("brief_item_transition", {
        p_user_id: alice.id,
        p_item_id: item.id,
        p_expected_state: "open",
        p_state: "accepted",
        p_fields: {},
        p_task: { title: "RPC item", ...(dueAt === undefined ? {} : { due_at: dueAt }) },
      });
    for (const bad of ["now", "today", "infinity", "-infinity", "epoch", "garbage", "", "2026-02-30T00:00:00Z", "2026-09-30", "2026-09-30T12:00:00", "2026-09-30 12:00:00+00", "2026-09-30T25:00:00Z", 1759276799, true, { at: "x" }, ["2026-09-30T12:00:00Z"]]) {
      const { error } = await call(bad);
      assert.ok(error, `${JSON.stringify(bad)} should be refused`);
      assert.equal(error.code, "22023", `${JSON.stringify(bad)}: ${error.message}`);
    }
    const after = (await getBrief(admin, alice.id, own.code, { appUrl: APP_URL })).items[0];
    assert.equal(after.state, "open");
    assert.equal(after.created_task_id, null);
    const { count } = await admin.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", alice.id).eq("external_source_id", item.item_key);
    assert.equal(count, 0);

    // JSON null means no date; an offset other than Z is honoured.
    const { data, error } = await call(null);
    assert.equal(error, null, error?.message);
    assert.equal(data.ok, true);
    const { data: nullTask } = await admin.from("tasks").select("owner, due_at").eq("id", data.created_task_id).single();
    assert.deepEqual(nullTask, { owner: "brent", due_at: null });

    const other = await saveItems(alice.id, "2026-10-06", [proposal("Offset item")]);
    const otherItem = (await getBrief(admin, alice.id, other.code, { appUrl: APP_URL })).items[0];
    const { data: offset, error: offsetError } = await admin.rpc("brief_item_transition", {
      p_user_id: alice.id, p_item_id: otherItem.id, p_expected_state: "open", p_state: "accepted", p_fields: {},
      p_task: { title: "Offset item", due_at: "2026-10-06T23:59:59.999-04:00" },
    });
    assert.equal(offsetError, null, offsetError?.message);
    const { data: offsetTask } = await admin.from("tasks").select("due_at").eq("id", offset.created_task_id).single();
    assert.equal(iso(offsetTask.due_at), "2026-10-07T03:59:59.999Z");
  });

  await test("058: applies twice, rolls back to 055's exact function, re-applies; existing accepted tasks untouched", async () => {
    const fnDef = () => psql(`SELECT md5(pg_get_functiondef('public.brief_item_transition(uuid,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure));`);
    const fnMeta = () =>
      psql(`SELECT prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') || '|' ||
              has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' ||
              has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
              has_function_privilege('service_role', p.oid, 'EXECUTE')::text
            FROM pg_proc p WHERE p.oid = 'public.brief_item_transition(uuid,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure;`);
    const acceptedTasks = () =>
      psql(`SELECT md5(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id)) FROM tasks t WHERE t.user_id = '${alice.id}' AND t.external_source_system = 'eod_proposal';`);

    const on058 = fnDef();
    const meta = fnMeta();
    assert.equal(meta, "false|search_path=public|false|true|true", "SECURITY INVOKER, search_path, anon can't execute");
    const tasksBefore = acceptedTasks();

    // 055's function as 055 defines it (lines from CREATE OR REPLACE through the GRANT).
    const start = MIGRATION_055.indexOf("CREATE OR REPLACE FUNCTION brief_item_transition(");
    const end = MIGRATION_055.indexOf("TO authenticated, service_role;", start) + "TO authenticated, service_role;".length;
    psql(MIGRATION_055.slice(start, end));
    const on055 = fnDef();
    assert.notEqual(on055, on058);

    psql(read(MIGRATION_058_URL));
    psql(read(MIGRATION_058_URL));
    assert.equal(fnDef(), on058, "applying 058 twice gives the same function");

    psql(read(ROLLBACK_058_URL));
    assert.equal(fnDef(), on055, "the rollback restores 055's exact function");
    assert.equal(fnMeta(), meta, "same security settings and grants after the rollback");
    assert.equal(acceptedTasks(), tasksBefore, "the rollback touched no task");

    // On the rolled-back function, Accept is the old behaviour again (column defaults).
    const old = await saveItems(alice.id, "2026-10-07", [proposal("Rolled back item")]);
    const oldItem = (await getBrief(admin, alice.id, old.code, { appUrl: APP_URL })).items[0];
    const { data: oldAccept, error: oldError } = await admin.rpc("brief_item_transition", {
      p_user_id: alice.id, p_item_id: oldItem.id, p_expected_state: "open", p_state: "accepted", p_fields: {},
      p_task: { title: "Rolled back item", due_at: "2026-10-08T03:59:59.999Z" },
    });
    assert.equal(oldError, null, oldError?.message);
    const { data: oldTask } = await admin.from("tasks").select("owner, due_at").eq("id", oldAccept.created_task_id).single();
    assert.deepEqual(oldTask, { owner: "agent", due_at: null });
    const tasksWithOld = acceptedTasks();

    psql(read(MIGRATION_058_URL));
    assert.equal(fnDef(), on058, "re-applied");
    assert.equal(fnMeta(), meta);
    assert.equal(acceptedTasks(), tasksWithOld, "re-applying touched no task either (the old-style task stays agent / no date)");
  });
} finally {
  // Leave the stack on 058 whatever happened above.
  try {
    psql(read(MIGRATION_058_URL));
  } catch (error) {
    console.error("could not re-apply 058:", error.message);
  }
  for (const user of users) await admin.auth.admin.deleteUser(user.id).catch(() => null);
}

if (!due.resolveAcceptDueAt) console.log("(note: src/lib/briefs/due.ts is missing: this is the pre-058 code)");
console.log(`\n${passed} passed`);
