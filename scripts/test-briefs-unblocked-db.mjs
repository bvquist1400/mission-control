#!/usr/bin/env node
// Database tests for the brief's "Recently unblocked" section (Baseline 2f6b39f2,
// S3, no migration), run against a LOCAL Supabase stack with every migration applied:
//
//   BRIEFS_TEST_SUPABASE_URL=$STACK_API_URL BRIEFS_TEST_ANON_KEY=$STACK_ANON_KEY \
//   BRIEFS_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY \
//   BRIEFS_TEST_DB_CONTAINER=$STACK_DB_CONTAINER npm run test:briefs-unblocked-db
//
// (see "Local DB test stack" in CLAUDE.md). The real triggers and functions: an
// unblock made by finishing a real blocker, the save (as the signed-in user, RLS
// on, and with the machine key's service-role client), Keep and Move through
// clear_task_unblock and brief_item_transition, Undo, the stuck count, a 1,005-pill
// read through PostgREST's real row cap, and the system comments.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  console.error(`Refusing to run against ${url}: this test creates and deletes users. Local stacks only.`);
  process.exit(2);
}
if (!/^supabase_db_[A-Za-z0-9_-]+$/.test(dbContainer)) {
  console.error(`Refusing BRIEFS_TEST_DB_CONTAINER=${dbContainer}: expected a local supabase_db_<project> container.`);
  process.exit(2);
}

delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, getBrief, actOnBriefItems } = await import("../src/lib/briefs/service.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");

const APP_URL = "http://localhost:3000";
const quiet = { send: async () => {} };
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
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
    const detail = error instanceof Error ? error.stack : JSON.stringify(error);
    console.log(`not ok - ${name}\n  ${String(detail).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const users = [];
async function makeUser(label) {
  const email = `briefs-unblocked-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

async function makeTask(userId, title, extra = {}) {
  const { data, error } = await admin.from("tasks").insert({ user_id: userId, title, status: "Planned", task_type: "Task", ...extra }).select("id").single();
  if (error) throw error;
  return data.id;
}

/** A task waiting on a real blocker; finishing the blocker runs 067's trigger. */
async function unblockedTask(userId, title, extra = {}, blockerExtra = {}) {
  const blockerTitle = `Blocker of ${title}`;
  const blocker = await makeTask(userId, blockerTitle, blockerExtra);
  const task = await makeTask(userId, title, extra);
  const { error: linkError } = await admin.from("task_dependencies").insert({ user_id: userId, task_id: task, depends_on_task_id: blocker });
  if (linkError) throw linkError;
  const { error } = await admin.from("tasks").update({ status: "Done" }).eq("id", blocker);
  if (error) throw error;
  return { task, blocker, blockerTitle };
}

async function taskRow(id) {
  const { data, error } = await admin.from("tasks").select("id, status, due_at, unblocked_at, priority_score").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function unblockRow(taskId) {
  const { data, error } = await admin.from("task_unblocks").select("cleared_at, cleared_reason").eq("task_id", taskId).order("created_at", { ascending: false }).limit(1).single();
  if (error) throw error;
  return data;
}

const dueAtEndOf = (offsetDays) => psql(`SELECT task_unblock_end_of_day((now() AT TIME ZONE 'America/New_York')::DATE + ${offsetDays})::TEXT;`);
const etToday = () => psql(`SELECT (now() AT TIME ZONE 'America/New_York')::DATE::TEXT;`);

let briefDay = 0;
/** Each save gets its own brief (a date further back), so the tests don't share one. */
function saveInput(edition = "am", body = {}) {
  briefDay += 1;
  const date = psql(`SELECT ((now() AT TIME ZONE 'America/New_York')::DATE - ${briefDay})::TEXT;`);
  const parsed = parseSaveBriefInput({ edition, date, content: {}, items: [], ...body }, new Date());
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return parsed.value;
}
const save = (client, userId, input = saveInput()) => saveBrief(client, userId, input, { appUrl: APP_URL, notifier: quiet });

async function act(client, userId, code, list) {
  const parsed = parseBriefActions(list);
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return actOnBriefItems(client, userId, code, parsed.value);
}

async function rowFor(userId, code, taskId) {
  const view = await getBrief(admin, userId, code, { appUrl: APP_URL });
  return view.items.find((item) => item.task_ids[0] === taskId);
}

try {
  const user = await makeUser("a");
  const { client } = user;

  await test("a real unblock gets a row on save, as the signed-in user with RLS on, naming what it waited on", async () => {
    const { task, blockerTitle } = await unblockedTask(user.id, "Send revised timeline", { due_at: dueAtEndOf(4) });
    const result = await save(client, user.id);
    assert.equal(result.unblocked.read_failed, false);
    assert.equal(result.unblocked.added, 1);
    const row = await rowFor(user.id, result.code, task);
    assert.equal(row.kind, "carry_over");
    assert.equal(row.state, "open");
    assert.equal(row.payload.group, "Recently unblocked");
    assert.equal(row.payload.label, "Now unblocked");
    assert.ok(row.payload.why.startsWith(`Was waiting on "${blockerTitle}" (done `), row.payload.why);
    assert.match(row.payload.why, /Already due /);
  });

  await test("the machine key's service-role client gets the same rows", async () => {
    const result = await save(admin, user.id);
    assert.equal(result.unblocked.read_failed, false);
    assert.equal(result.unblocked.added, 1, "the pill from the last test carries over");
  });

  await test("Keep on a later date: the real clear_task_unblock clears the pill with reason brief, and the date stays", async () => {
    const later = dueAtEndOf(6);
    const { task } = await unblockedTask(user.id, "Book the review session", { due_at: later });
    const before = await taskRow(task);
    assert.ok(before.unblocked_at, "the trigger set the pill");
    const { code } = await save(client, user.id);
    const row = await rowFor(user.id, code, task);
    const { results } = await act(client, user.id, code, [{ n: row.n, action: "keep" }]);
    assert.equal(results[0].ok, true, results[0].error);
    const after = await taskRow(task);
    assert.equal(after.unblocked_at, null);
    assert.equal(after.due_at, before.due_at);
    assert.equal(after.status, before.status);
    assert.equal(after.priority_score, before.priority_score);
    assert.equal((await unblockRow(task)).cleared_reason, "brief");
    const kept = await rowFor(user.id, code, task);
    assert.equal(kept.state, "decided");
    assert.equal(kept.choice, "keep");
    assert.equal(kept.can_undo, true);

    const next = await save(client, user.id);
    assert.equal(await rowFor(user.id, next.code, task), undefined, "acted on: it stops carrying");
  });

  await test("Undo of a Keep reopens the row; the pill stays gone (067 can't set one back)", async () => {
    const { task } = await unblockedTask(user.id, "Undo a keep", { due_at: dueAtEndOf(6) });
    const { code } = await save(client, user.id);
    const row = await rowFor(user.id, code, task);
    await act(client, user.id, code, [{ n: row.n, action: "keep" }]);
    const { results } = await act(client, user.id, code, [{ n: row.n, action: "undo" }]);
    assert.equal(results[0].ok, true, results[0].error);
    const reopened = await rowFor(user.id, code, task);
    assert.equal(reopened.state, "open");
    assert.equal(reopened.choice, null);
    assert.equal((await taskRow(task)).unblocked_at, null);
    const again = await act(client, user.id, code, [{ n: row.n, action: "keep" }]);
    assert.equal(again.results[0].ok, true, again.results[0].error);
  });

  await test("Move to today on a task already due today: the due date doesn't change, and the pill still clears", async () => {
    const dueToday = dueAtEndOf(0);
    const { task } = await unblockedTask(user.id, "Already due today", { due_at: dueToday });
    const before = await taskRow(task);
    assert.equal(Date.parse(before.due_at), Date.parse(dueToday));
    assert.ok(before.unblocked_at, "a date of today isn't moved, and the pill is on");
    const { code } = await save(client, user.id);
    const row = await rowFor(user.id, code, task);
    const { results } = await act(client, user.id, code, [{ n: row.n, action: "move", date: etToday() }]);
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal(results[0].state, "deferred");
    const after = await taskRow(task);
    assert.equal(after.unblocked_at, null);
    assert.equal(Date.parse(after.due_at), Date.parse(dueToday));
    assert.equal((await unblockRow(task)).cleared_reason, "brief");
  });

  await test("Today on a task with a later date: the trigger clears it as a due change, and Undo puts the date back", async () => {
    const later = dueAtEndOf(6);
    const { task } = await unblockedTask(user.id, "Pull it in", { due_at: later });
    const { code } = await save(client, user.id);
    const row = await rowFor(user.id, code, task);
    const { results } = await act(client, user.id, code, [{ n: row.n, action: "move", date: etToday() }]);
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal((await taskRow(task)).unblocked_at, null);
    assert.equal((await unblockRow(task)).cleared_reason, "redated");
    const undone = await act(client, user.id, code, [{ n: row.n, action: "undo" }]);
    assert.equal(undone.results[0].ok, true, undone.results[0].error);
    assert.equal(Date.parse((await taskRow(task)).due_at), Date.parse(later));
    assert.equal((await rowFor(user.id, code, task)).state, "open");
  });

  await test("a pill on tasks that were never Waiting, and a task still held by something else", async () => {
    const backlog = await unblockedTask(user.id, "Was Backlog", { status: "Backlog", due_at: dueAtEndOf(5) });
    const started = await unblockedTask(user.id, "Was In Progress", { status: "In Progress", due_at: dueAtEndOf(5) });
    const held = await unblockedTask(user.id, "Still held", { status: "Blocked/Waiting", waiting_on: "Legal", due_at: dueAtEndOf(5) });
    const { code } = await save(client, user.id);
    assert.equal((await rowFor(user.id, code, backlog.task)).payload.group, "Recently unblocked");
    assert.equal((await rowFor(user.id, code, started.task)).payload.group, "Recently unblocked");
    const heldRow = await rowFor(user.id, code, held.task);
    assert.match(heldRow.payload.why, /Still marked Waiting\./);
    assert.equal((await taskRow(held.task)).status, "Blocked/Waiting");
  });

  await test("every way the pill clears takes the task out of the next brief", async () => {
    const cases = [
      ["started", { status: "In Progress" }],
      ["finished", { status: "Done" }],
      ["parked", { status: "Parked" }],
      ["waiting", { status: "Blocked/Waiting" }],
      ["redated", { due_at: dueAtEndOf(9) }],
    ];
    const tasks = [];
    for (const [label, patch] of cases) {
      const { task } = await unblockedTask(user.id, `Clears: ${label}`, { due_at: dueAtEndOf(5) });
      const { error } = await admin.from("tasks").update(patch).eq("id", task);
      if (error) throw error;
      tasks.push(task);
    }
    const reblocked = await unblockedTask(user.id, "Clears: new link", { due_at: dueAtEndOf(5) });
    const open = await makeTask(user.id, "Open prerequisite");
    await admin.from("task_dependencies").insert({ user_id: user.id, task_id: reblocked.task, depends_on_task_id: open });
    const reopened = await unblockedTask(user.id, "Clears: reopened", { due_at: dueAtEndOf(5) });
    await admin.from("tasks").update({ status: "Planned" }).eq("id", reopened.blocker);
    const { data: rpcData, error: rpcError } = await client.rpc("clear_task_unblock", { p_user_id: user.id, p_task_id: (await unblockedTask(user.id, "Clears: manual", { due_at: dueAtEndOf(5) })).task, p_reason: "manual" });
    assert.equal(rpcError, null);
    assert.equal(rpcData.cleared, true);

    const { code } = await save(client, user.id);
    const view = await getBrief(admin, user.id, code, { appUrl: APP_URL });
    const titles = view.items.map((item) => item.payload.title);
    assert.equal(titles.filter((title) => title.startsWith("Clears:")).length, 0, titles.join(", "));
  });

  await test("personal tasks get no row; a personal blocker is counted, never named", async () => {
    const personal = await unblockedTask(user.id, "Private task", { tags: ["personal"], due_at: dueAtEndOf(5) });
    const work = await unblockedTask(user.id, "Work task after a private one", { due_at: dueAtEndOf(5) }, { tags: ["personal"] });
    const { code } = await save(client, user.id);
    assert.equal(await rowFor(user.id, code, personal.task), undefined);
    const row = await rowFor(user.id, code, work.task);
    assert.match(row.payload.why, /^Was waiting on another task \(done /);
    assert.doesNotMatch(row.payload.why, /Blocker of/);
  });

  await test("a new brief's rows leave no comment on the task: comments stay 067's title-free one", async () => {
    const { task, blockerTitle } = await unblockedTask(user.id, "Comment check", { due_at: dueAtEndOf(6) });
    const { code } = await save(client, user.id);
    const row = await rowFor(user.id, code, task);
    await act(client, user.id, code, [{ n: row.n, action: "keep" }]);
    const { data, error } = await admin.from("task_comments").select("content").eq("task_id", task);
    if (error) throw error;
    assert.equal(data.length, 1);
    assert.equal(data[0].content.startsWith("Now unblocked: everything it waited on is done."), true);
    assert.equal(data[0].content.includes(blockerTitle), false);
  });

  await test("the stuck count: only open records at 8+ attempts, seen by the owner under RLS, stored only above zero", async () => {
    const owner = await makeUser("stuck");
    const stray = randomUUID();
    const record = (attempts, closed = false) => ({
      user_id: owner.id,
      kind: "unblock",
      task_id: stray,
      blocker_type: "task",
      blocker_id: stray,
      task_status: "Planned",
      attempts,
      ...(closed ? { closed_at: new Date().toISOString(), closed_reason: "applied" } : {}),
    });
    const { error } = await admin.from("task_unblock_retries").insert([record(8), record(9), record(7), record(8, true)]);
    if (error) throw error;

    const result = await save(owner.client, owner.id);
    assert.equal(result.unblocked.stuck, 2);
    const view = await getBrief(owner.client, owner.id, result.code, { appUrl: APP_URL });
    assert.equal(view.brief.content.unblock_stuck, 2);

    const other = await makeUser("not-stuck");
    const quietResult = await save(other.client, other.id);
    assert.equal(quietResult.unblocked.stuck, 0, "someone else's records never count");
    const quietView = await getBrief(other.client, other.id, quietResult.code, { appUrl: APP_URL });
    assert.equal("unblock_stuck" in quietView.brief.content, false);
  });

  await test("the read goes past PostgREST's real 1,000-row cap", async () => {
    const many = await makeUser("many");
    const count = 1005;
    psql(`
      BEGIN;
      SELECT set_config('mission_control.unblock_writer', 'on', true);
      WITH made AS (
        INSERT INTO tasks (user_id, title, status, task_type, unblocked_at)
        SELECT '${many.id}', 'Pill ' || g, 'Planned', 'Task', now() FROM generate_series(1, ${count}) g
        RETURNING id
      )
      INSERT INTO task_unblocks (user_id, task_id, blocker_type, unblocked_at, landing_date, prior_status, new_status)
      SELECT '${many.id}', id, 'task', now(), CURRENT_DATE, 'Planned', 'Planned' FROM made;
      COMMIT;
    `);
    const { count: pills, error } = await admin.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", many.id).not("unblocked_at", "is", null);
    assert.equal(error, null);
    assert.equal(pills, count, "the fixture really has the pills");
    const { data: capped } = await admin.from("task_unblocks").select("id").eq("user_id", many.id);
    assert.equal(capped.length, 1000, "PostgREST really caps a plain read here");

    const result = await save(many.client, many.id);
    assert.equal(result.unblocked.read_failed, false);
    assert.equal(result.unblocked.added, count);
    const view = await getBrief(many.client, many.id, result.code, { appUrl: APP_URL });
    const { count: saved } = await admin.from("brief_items").select("id", { count: "exact", head: true }).eq("user_id", many.id);
    assert.equal(saved, count, "every row is saved");
    // The page's embedded read has the same cap: a brief past 1,000 rows shows the
    // first 1,000 (known limit; what's left carries to the next brief once acted on).
    assert.equal(view.items.length, 1000);
    assert.equal(Object.keys(view.tasks).length, 1000, "and the page's task read survives a list that long");
  });

  await test("an unrelated user's pills never reach this user's brief", async () => {
    const other = await makeUser("other");
    const result = await save(other.client, other.id);
    assert.equal(result.unblocked.added, 0);
  });
} finally {
  for (const id of users) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
