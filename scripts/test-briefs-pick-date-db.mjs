#!/usr/bin/env node
// Database tests for "Pick a date..." on brief cards (Baseline task 57224ad9,
// migration 064), run against a LOCAL Supabase stack with every migration applied:
//
//   BRIEFS_TEST_SUPABASE_URL=http://127.0.0.1:58321 \
//   BRIEFS_TEST_ANON_KEY=... BRIEFS_TEST_SERVICE_ROLE_KEY=... \
//   BRIEFS_TEST_DB_CONTAINER=supabase_db_<project_id> \
//   npm run test:briefs-pick-date-db
//
// (see "Local DB test stack" in CLAUDE.md). Checks on a real database: Accept with a
// picked date; Move for a single carry-over and a group; the snapshot 064 saves
// in the same transaction; Undo restoring the exact previous due date (including
// none); the expect_due_at refusal (SQLSTATE MC064) rolling everything back; the
// Nov 1 DST edge; Tomorrow now saving a snapshot too; and 064's rollback /
// re-apply (psql through `docker exec`). The stack is left on 064.

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

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const MIGRATION_064 = read("../supabase/migrations/064_brief_item_prior_due.sql");
const ROLLBACK_064 = read("../supabase/rollbacks/064_brief_item_prior_due.down.sql");

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
  const email = `briefs-pick-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
  if (error) throw error;
  return { id: data.user.id };
}

async function makeTask(userId, title, dueAt) {
  const { data, error } = await admin
    .from("tasks")
    .insert({ user_id: userId, title, status: "Backlog", task_type: "Task", due_at: dueAt })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

const dueOf = async (id) => {
  const { data, error } = await admin.from("tasks").select("due_at").eq("id", id).single();
  if (error) throw error;
  return data.due_at === null ? null : new Date(data.due_at).toISOString();
};

const actions = (list) => {
  const result = parseBriefActions(list);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
};

async function save(userId, date, items) {
  const parsed = parseSaveBriefInput({ edition: "eod", date, covered_meeting_ids: [], items }, new Date(`${date}T20:15:00Z`));
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return saveBrief(admin, userId, parsed.value, { appUrl: APP_URL, notifier: quiet });
}

const itemOf = async (userId, code, n) => (await getBrief(admin, userId, code, { appUrl: APP_URL })).items.find((entry) => entry.n === n);
const rawItem = async (userId, code, n) => {
  const view = await getBrief(admin, userId, code, { appUrl: APP_URL });
  const { data, error } = await admin.from("brief_items").select("state, prior_due").eq("brief_id", view.brief.id).eq("n", n).single();
  if (error) throw error;
  return data;
};

const users = [];
try {
  const alice = await makeUser("alice");
  users.push(alice);
  const NOW = new Date("2026-10-27T20:30:00Z"); // Tue 10/27 4:30 PM EDT

  const dated = await makeTask(alice.id, "Vendor quote", "2026-10-27T03:59:59.999Z");
  const undated = await makeTask(alice.id, "No date yet", null);
  const g1 = await makeTask(alice.id, "Group 1", "2026-10-28T03:59:59.999Z");
  const g2 = await makeTask(alice.id, "Group 2", null);
  const t1 = await makeTask(alice.id, "Tomorrow item", "2026-10-26T03:59:59.999Z");
  const saved = await save(alice.id, "2026-10-27", [
    { kind: "carry_over", title: "Follow up on vendor quote", task_ids: [dated] }, // 1
    { kind: "carry_over", title: "Undated item", task_ids: [undated] }, // 2
    { kind: "carry_group", title: "Two slipped", task_ids: [g1, g2] }, // 3
    { kind: "carry_over", title: "Tomorrow item", task_ids: [t1] }, // 4
    {
      kind: "proposed_task",
      title: "Send the workbook",
      suggested_due: "2026-10-29",
      source: { meetings: [{ id: "m-pick", title: "Study team sync", start: "2026-10-27T14:00:00Z", url: null, lines: ["Send the workbook (Brent)"] }] },
    }, // 5
  ]);
  const code = saved.code;
  const move = (n, date) => actions([{ n, action: "move", date }]);

  await test("Accept with a picked date that isn't the notes' date: the task is created due the end of that ET day", async () => {
    const result = await actOnBriefItems(admin, alice.id, code, actions([{ n: 5, action: "accept", due: "2026-11-03" }]), { now: NOW });
    assert.equal(result.results[0].ok, true, JSON.stringify(result.results[0]));
    const created = (await itemOf(alice.id, code, 5)).created_task_id;
    assert.equal(await dueOf(created), "2026-11-04T04:59:59.999Z");
  });

  await test("Move a carry-over: due the end of the picked ET day (EST after Nov 1), item deferred, snapshot saved in the same write", async () => {
    const result = await actOnBriefItems(admin, alice.id, code, move(1, "2026-11-04"), { now: NOW });
    assert.equal(result.results[0].state, "deferred");
    assert.equal(await dueOf(dated), "2026-11-05T04:59:59.999Z");
    const raw = await rawItem(alice.id, code, 1);
    assert.equal(raw.state, "deferred");
    assert.equal(raw.prior_due.length, 1);
    assert.equal(new Date(raw.prior_due[0].due_at).toISOString(), "2026-10-27T03:59:59.999Z");
    assert.equal(new Date(raw.prior_due[0].applied_due_at).toISOString(), "2026-11-05T04:59:59.999Z");
    const view = await itemOf(alice.id, code, 1);
    assert.equal(view.can_undo, true);
    assert.equal("prior_due" in view, false);
  });

  await test("a repeat of the same move is a no-op; a different day is a 400 until Undo", async () => {
    const again = await actOnBriefItems(admin, alice.id, code, move(1, "2026-11-04"), { now: NOW });
    assert.equal(again.results[0].already, true);
    await rejects(actOnBriefItems(admin, alice.id, code, move(1, "2026-11-05"), { now: NOW }), 400, /undo it first/);
    assert.equal(await dueOf(dated), "2026-11-05T04:59:59.999Z");
  });

  await test("Undo puts the exact earlier due date back, reopens the card and clears the snapshot", async () => {
    const result = await actOnBriefItems(admin, alice.id, code, actions([{ n: 1, action: "undo" }]), { now: NOW });
    assert.equal(result.results[0].state, "open");
    assert.equal(await dueOf(dated), "2026-10-27T03:59:59.999Z");
    const raw = await rawItem(alice.id, code, 1);
    assert.deepEqual({ state: raw.state, prior_due: raw.prior_due }, { state: "open", prior_due: null });
  });

  await test("a task that had no due date gets 'no due date' back", async () => {
    await actOnBriefItems(admin, alice.id, code, move(2, "2026-10-31"), { now: NOW });
    assert.equal(await dueOf(undated), "2026-11-01T03:59:59.999Z"); // Sat 10/31 ends in EDT
    await actOnBriefItems(admin, alice.id, code, actions([{ n: 2, action: "undo" }]), { now: NOW });
    assert.equal(await dueOf(undated), null);
  });

  await test("Move on a carry group writes every task in one transaction; Undo restores each, the undated one included", async () => {
    await actOnBriefItems(admin, alice.id, code, move(3, "2026-11-01"), { now: NOW }); // the DST changeover Sunday
    assert.equal(await dueOf(g1), "2026-11-02T04:59:59.999Z");
    assert.equal(await dueOf(g2), "2026-11-02T04:59:59.999Z");
    await actOnBriefItems(admin, alice.id, code, actions([{ n: 3, action: "undo" }]), { now: NOW });
    assert.equal(await dueOf(g1), "2026-10-28T03:59:59.999Z");
    assert.equal(await dueOf(g2), null);
  });

  await test("Tomorrow now saves a snapshot too, so its Undo works", async () => {
    const result = await actOnBriefItems(admin, alice.id, code, actions([{ n: 4, action: "tomorrow" }]), { now: NOW });
    assert.equal(result.results[0].state, "deferred");
    assert.notEqual(await dueOf(t1), "2026-10-26T03:59:59.999Z");
    await actOnBriefItems(admin, alice.id, code, actions([{ n: 4, action: "undo" }]), { now: NOW });
    assert.equal(await dueOf(t1), "2026-10-26T03:59:59.999Z");
  });

  await test("Undo is refused (MC064) when a task's date changed after the move, and nothing is half-restored", async () => {
    await actOnBriefItems(admin, alice.id, code, move(3, "2026-11-09"), { now: NOW });
    const { error } = await admin.from("tasks").update({ due_at: "2026-11-20T04:59:59.999Z" }).eq("id", g2);
    assert.equal(error, null);
    const result = await actOnBriefItems(admin, alice.id, code, actions([{ n: 3, action: "undo" }]), { now: NOW });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /can't be undone: a task's due date was changed after the move/);
    assert.equal((await rawItem(alice.id, code, 3)).state, "deferred");
    assert.equal(await dueOf(g1), "2026-11-10T04:59:59.999Z", "g1 is not restored on its own");
    assert.equal(await dueOf(g2), "2026-11-20T04:59:59.999Z");
  });

  await test("a deferred item without a snapshot (moved before 064) gets a plain 400 on Undo", async () => {
    const legacy = await save(alice.id, "2026-10-28", [{ kind: "carry_over", title: "Legacy", task_ids: [await makeTask(alice.id, "Legacy task", null)] }]);
    const view = await getBrief(admin, alice.id, legacy.code, { appUrl: APP_URL });
    const { error } = await admin.from("brief_items").update({ state: "deferred" }).eq("brief_id", view.brief.id).eq("n", 1);
    assert.equal(error, null);
    await rejects(actOnBriefItems(admin, alice.id, legacy.code, actions([{ n: 1, action: "undo" }])), 400, /moved before earlier due dates were saved/);
  });

  await test("a past date is refused for Move and Accept (400, nothing changes)", async () => {
    const fresh = await save(alice.id, "2026-10-29", [{ kind: "carry_over", title: "Past test", task_ids: [await makeTask(alice.id, "Past task", "2026-10-29T03:59:59.999Z")] }]);
    await rejects(actOnBriefItems(admin, alice.id, fresh.code, move(1, "2026-10-28")), 400, /before the brief's date \(2026-10-29\)/);
    assert.equal((await rawItem(alice.id, fresh.code, 1)).state, "open");
  });

  await test("064: applies twice, rolls back to 058's exact function and drops the column, re-applies", async () => {
    const fnDef = () => psql(`SELECT md5(pg_get_functiondef('public.brief_item_transition(uuid,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure));`);
    const fnMeta = () =>
      psql(`SELECT prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') || '|' ||
              has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' ||
              has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
              has_function_privilege('service_role', p.oid, 'EXECUTE')::text
            FROM pg_proc p WHERE p.oid = 'public.brief_item_transition(uuid,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure;`);
    const hasColumn = () => psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'brief_items' AND column_name = 'prior_due';`);
    const taskDates = () => psql(`SELECT md5(string_agg(t.id::text || coalesce(t.due_at::text, ''), ',' ORDER BY t.id)) FROM tasks t WHERE t.user_id = '${alice.id}';`);

    const on064 = fnDef();
    const meta = fnMeta();
    assert.equal(meta, "false|search_path=public|false|true|true");
    assert.equal(hasColumn(), "1");
    psql(MIGRATION_064);
    assert.equal(fnDef(), on064, "applying 064 twice gives the same function");

    const datesBefore = taskDates();
    psql(ROLLBACK_064);
    assert.equal(hasColumn(), "0", "the column is gone");
    assert.notEqual(fnDef(), on064);
    assert.equal(fnMeta(), meta, "same security settings and grants after the rollback");
    assert.equal(taskDates(), datesBefore, "the rollback touched no task");
    psql(ROLLBACK_064); // re-running is safe

    psql(MIGRATION_064);
    assert.equal(fnDef(), on064, "re-applied");
    assert.equal(fnMeta(), meta);
    assert.equal(hasColumn(), "1");
  });
} finally {
  try {
    psql(MIGRATION_064);
  } catch (error) {
    console.error("could not re-apply 064:", error.message);
  }
  for (const user of users) await admin.auth.admin.deleteUser(user.id).catch(() => null);
}

console.log(`\n${passed} passed`);
