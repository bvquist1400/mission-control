#!/usr/bin/env node
// Database tests for multi-day tasks, slice S1 (Baseline task 6f87add5), against a
// LOCAL Supabase stack with every migration applied (scripts/test-stack/up.sh):
//
//   RANGE_TEST_SUPABASE_URL=$STACK_API_URL RANGE_TEST_ANON_KEY=$STACK_ANON_KEY \
//   RANGE_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY RANGE_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:task-range-db
//
// Part 1: migration 063 itself: the column, rollback and re-apply (twice), and the
//         start <= due trigger (refuses only writes that set or change start_at;
//         a due-only write is never refused).
// Part 2: the real routes on the real database: POST/PATCH/GET/list with
//         start_at, a start after the due refused with nothing saved, and the
//         cascade (061/062, unchanged) moving only due dates: a push lengthens the
//         range, and an Undo that puts a due date back before a start set since
//         still completes (the reason 063 is a trigger and not a CHECK).
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.RANGE_TEST_SUPABASE_URL;
const anonKey = process.env.RANGE_TEST_ANON_KEY;
const serviceKey = process.env.RANGE_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.RANGE_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set RANGE_TEST_SUPABASE_URL, RANGE_TEST_ANON_KEY, RANGE_TEST_SERVICE_ROLE_KEY and RANGE_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/063_add_task_start_at.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/063_add_task_start_at.down.sql", import.meta.url), "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}
/** Runs SQL expected to fail; returns the error text (throws if it succeeded). */
function psqlFails(sql) {
  try {
    psql(sql);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  throw new Error(`expected an error from: ${sql}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForColumn(present) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { error } = await admin.from("tasks").select("start_at").limit(1);
    if (present ? !error : Boolean(error)) return;
    await sleep(250);
  }
  throw new Error(`schema cache never ${present ? "saw" : "dropped"} tasks.start_at`);
}

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

const userA = await makeUser("range-a");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.DEPLOYMENT_ROLE = "main";

const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const dateCascadeRoute = await import("../src/app/api/tasks/[id]/date-cascade/route.ts");
const range = await import("../src/lib/task-range.ts");

function routeRequest(method, path, body) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase: admin, user: { id: userA }, userId: userA, authSource: "legacy_api_key" });
}
const params = (id) => ({ params: Promise.resolve({ id }) });
const reply = async (response) => ({ status: response.status, body: await response.json() });
const patch = async (taskId, body) => reply(await taskRoute.PATCH(routeRequest("PATCH", `/api/tasks/${taskId}`, body), params(taskId)));
const post = async (body) => reply(await tasksRoute.POST(routeRequest("POST", "/api/tasks", body)));
const getTask = async (taskId) => reply(await taskRoute.GET(routeRequest("GET", `/api/tasks/${taskId}`), params(taskId)));
const listTasks = async (query) => reply(await tasksRoute.GET(routeRequest("GET", `/api/tasks?${query}`)));
const dateCascade = async (taskId, body) => reply(await dateCascadeRoute.POST(routeRequest("POST", `/api/tasks/${taskId}/date-cascade`, body), params(taskId)));

// ET instants. October 2026 is EDT (UTC-4) until Sun Nov 1, then EST (UTC-5).
const etAt = (date, time = "17:00") => {
  const offset = date >= "2026-11-01" ? "-05:00" : "-04:00";
  return new Date(`${date}T${time}:00${offset}`).toISOString();
};
const startOf = (date) => etAt(date, "00:00");

async function insertTask(title, extra = {}) {
  const { data, error } = await admin.from("tasks").insert({ user_id: userA, title, status: "Planned", tags: ["work"], ...extra }).select("*").single();
  if (error) throw error;
  return data;
}
const row = (id) => JSON.parse(psql(`SELECT json_build_object('start_at', start_at, 'due_at', due_at) FROM tasks WHERE id = '${id}';`));
const sameInstant = (a, b) => assert.equal(a === null ? null : Date.parse(a), b === null ? null : Date.parse(b));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 10).join("\n    ")}`);
  }
}

try {
  // ── Part 1: migration 063 ───────────────────────────────────────────────
  await test("063: tasks.start_at is a nullable timestamptz with no default; the guard trigger fires on INSERT and UPDATE OF start_at only", () => {
    assert.equal(psql(`SELECT data_type || ',' || is_nullable || ',' || coalesce(column_default, 'none') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'start_at';`), "timestamp with time zone,YES,none");
    const def = psql(`SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_tasks_guard_start_at';`);
    assert.match(def, /BEFORE INSERT OR UPDATE OF start_at ON public\.tasks FOR EACH ROW/);
    // No CHECK constraint on purpose (see the migration header).
    assert.equal(psql(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%start_at%';`), "0");
  });

  await test("063 rollback drops the column, trigger and function; re-applying (twice) puts them back", async () => {
    psql(ROLLBACK);
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'start_at';`), "0");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_tasks_guard_start_at';`), "0");
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname = 'tasks_guard_start_at';`), "0");
    await waitForColumn(false);
    psql(ROLLBACK); // re-running the rollback is safe
    psql(MIGRATION);
    psql(MIGRATION); // and so is re-applying
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'start_at';`), "1");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_tasks_guard_start_at';`), "1");
    await waitForColumn(true);
  });

  await test("Trigger: an INSERT or an UPDATE that sets the start after the due is refused (23514 + the message the API maps)", async () => {
    const insertError = psqlFails(`INSERT INTO tasks (user_id, title, start_at, due_at) VALUES ('${userA}', 'Backwards', '${startOf("2026-10-31")}', '${etAt("2026-10-30", "23:59")}');`);
    assert.match(insertError, /start_at must be on or before due_at/);
    const t = await insertTask("Guarded", { start_at: startOf("2026-10-26"), due_at: etAt("2026-10-30", "23:59") });
    const { error } = await admin.from("tasks").update({ start_at: startOf("2026-10-31") }).eq("id", t.id);
    assert.equal(error?.code, "23514");
    assert.equal(range.isStartAfterDueViolation(error), true);
    sameInstant(row(t.id).start_at, startOf("2026-10-26"));
  });

  await test("Trigger: same-day start, a start without a due date, and clearing the start are fine", async () => {
    const t = await insertTask("Same day", { start_at: startOf("2026-10-30"), due_at: etAt("2026-10-30", "23:59") });
    sameInstant(row(t.id).start_at, startOf("2026-10-30"));
    const noDue = await insertTask("Start only", { start_at: startOf("2026-10-30") });
    sameInstant(row(noDue.id).start_at, startOf("2026-10-30"));
    psql(`UPDATE tasks SET start_at = NULL WHERE id = '${t.id}';`);
    assert.equal(row(t.id).start_at, null);
  });

  await test("Trigger: a due-only write is never refused, even one that leaves the start after the due (the cascade's Undo path)", async () => {
    const t = await insertTask("Due moves", { start_at: startOf("2026-10-26"), due_at: etAt("2026-10-30", "23:59") });
    psql(`UPDATE tasks SET due_at = '${etAt("2026-10-23", "23:59")}' WHERE id = '${t.id}';`);
    sameInstant(row(t.id).due_at, etAt("2026-10-23", "23:59"));
    // Writing the same start again with the due write is still a due-only change.
    psql(`UPDATE tasks SET start_at = start_at, due_at = '${etAt("2026-10-22", "23:59")}' WHERE id = '${t.id}';`);
    sameInstant(row(t.id).due_at, etAt("2026-10-22", "23:59"));
  });

  // ── Part 2: the routes ──────────────────────────────────────────────────
  await test("POST saves start_at; GET /api/tasks/{id} and the list return it; a start after the due is a 400 with nothing created", async () => {
    const created = await post({ title: "Copy the Q3 calendar shell", start_at: startOf("2026-10-26"), due_at: etAt("2026-10-30", "23:59"), tags: ["work"] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sameInstant(created.body.start_at, startOf("2026-10-26"));
    const fetched = await getTask(created.body.id);
    assert.equal(fetched.status, 200);
    sameInstant(fetched.body.start_at, startOf("2026-10-26"));
    const listed = await listTasks("limit=500");
    assert.equal(listed.status, 200);
    const items = Array.isArray(listed.body) ? listed.body : listed.body.tasks ?? listed.body.data;
    const found = items.find((item) => item.id === created.body.id);
    assert.ok(found, "listed");
    sameInstant(found.start_at, startOf("2026-10-26"));
    const before = psql(`SELECT count(*) FROM tasks WHERE user_id = '${userA}';`);
    const refused = await post({ title: "Backwards", start_at: startOf("2026-10-31"), due_at: etAt("2026-10-30", "23:59") });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "The start date can't be after the due date.");
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE user_id = '${userA}';`), before);
  });

  await test("PATCH sets and clears start_at; a start after the due, or a due before the start, is a 400 with nothing saved", async () => {
    const t = await insertTask("Patchable", { due_at: etAt("2026-10-30", "23:59") });
    const set = await patch(t.id, { start_at: startOf("2026-10-27") });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    sameInstant(row(t.id).start_at, startOf("2026-10-27"));
    const late = await patch(t.id, { start_at: startOf("2026-10-31") });
    assert.equal(late.status, 400);
    assert.equal(late.body.error, "The start date can't be after the due date.");
    const early = await patch(t.id, { due_at: etAt("2026-10-26", "23:59"), cascade: false });
    assert.equal(early.status, 400);
    sameInstant(row(t.id).start_at, startOf("2026-10-27"));
    sameInstant(row(t.id).due_at, etAt("2026-10-30", "23:59"));
    const cleared = await patch(t.id, { start_at: null });
    assert.equal(cleared.status, 200);
    assert.equal(row(t.id).start_at, null);
  });

  await test("Cascade (061/062 unchanged): pushing a ranged task later moves the waiting task's due date only; both starts stay, the ranges lengthen", async () => {
    const a = await insertTask("Range A", { start_at: startOf("2026-10-19"), due_at: etAt("2026-10-22") });
    const b = await insertTask("Range B waits on A", { start_at: startOf("2026-10-21"), due_at: etAt("2026-10-23") });
    const link = await admin.from("task_dependencies").insert({ user_id: userA, task_id: b.id, depends_on_task_id: a.id }).select("id").single();
    assert.equal(link.error, null);
    const moved = await patch(a.id, { due_at: etAt("2026-10-26") });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.cascade.status, "moved");
    sameInstant(row(b.id).due_at, etAt("2026-10-27"));
    sameInstant(row(a.id).start_at, startOf("2026-10-19"));
    sameInstant(row(b.id).start_at, startOf("2026-10-21"));
    assert.equal(range.rangeOf({ ...row(b.id), tags: ["work"] }).totalDays, 5, "B: Wed 10/21 → Tue 10/27 is 5 working days");
  });

  await test("Undo after a start was set since: the Undo puts the due date back before that start and still completes (a CHECK would have aborted it)", async () => {
    const a = await insertTask("Undo A", { due_at: etAt("2026-10-22") });
    const b = await insertTask("Undo B waits on A", { start_at: startOf("2026-10-21"), due_at: etAt("2026-10-23") });
    const link = await admin.from("task_dependencies").insert({ user_id: userA, task_id: b.id, depends_on_task_id: a.id }).select("id").single();
    assert.equal(link.error, null);
    const moved = await patch(a.id, { due_at: etAt("2026-10-26") });
    assert.equal(moved.body.cascade.status, "moved");
    sameInstant(row(b.id).due_at, etAt("2026-10-27"));
    // Brent sets B to start Mon 10/26 (fine: before its new due date, Tue 10/27).
    const startSet = await patch(b.id, { start_at: startOf("2026-10-26") });
    assert.equal(startSet.status, 200, JSON.stringify(startSet.body));
    const undo = await dateCascade(a.id, { action: "undo", cascade_id: moved.body.cascade.cascade_id, change_id: moved.body.cascade.change_id });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(undo.body.status, "undone");
    assert.deepEqual(undo.body.cascade.restored.map((item) => item.task_id), [b.id]);
    sameInstant(row(b.id).due_at, etAt("2026-10-23"));
    sameInstant(row(b.id).start_at, startOf("2026-10-26"), "the start is never touched");
    // The rules read it as a one-day task on its due date (Fri 10/23).
    const r = range.rangeOf({ ...row(b.id), tags: ["work"] });
    assert.equal(r.isRange, false);
    assert.equal(r.dueDate, "2026-10-23");
    // Now the API won't save anything that keeps the start after the due except clearing or fixing it.
    const stillLate = await patch(b.id, { start_at: startOf("2026-10-25") });
    assert.equal(stillLate.status, 400);
    const fixed = await patch(b.id, { start_at: startOf("2026-10-20") });
    assert.equal(fixed.status, 200);
  });
  // ── Part S2: the Today queries on a real PostgREST (quoted or= filters, the embedded checklist under RLS) ──
  await test("S2: weekly board + top priorities include ranges overlapping the week, embed checklist rows, and run under the user's own session (RLS)", async () => {
    const queries = await import("../src/lib/today/queries.ts");
    const email = `range-s2-${randomUUID().slice(0, 8)}@example.test`;
    const password = randomUUID();
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError) throw createError;
    users.push(created.user.id);
    const owner = created.user.id;
    const userClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const insert = async (title, extra) => {
      const { data, error } = await admin.from("tasks").insert({ user_id: owner, title, status: "In Progress", tags: ["work"], ...extra }).select("id").single();
      if (error) throw error;
      return data.id;
    };
    // Week of Mon 11/2/2026 (EST).
    const weekStart = new Date(startOf("2026-11-02"));
    const weekEnd = new Date(Date.parse(startOf("2026-11-09")) - 1);
    const inWeek = await insert("one-day in week", { due_at: etAt("2026-11-04") });
    const spansIntoNext = await insert("range Thu -> next Tue", { start_at: startOf("2026-11-05"), due_at: etAt("2026-11-10") });
    const fromLastWeek = await insert("range last Thu -> Tue", { start_at: startOf("2026-10-29"), due_at: etAt("2026-11-03") });
    const nextWeekOnly = await insert("range next week", { start_at: startOf("2026-11-10"), due_at: etAt("2026-11-12") });
    const laterOneDay = await insert("one-day next week", { due_at: etAt("2026-11-11") });
    const { error: checklistError } = await admin.from("task_checklist_items").insert([
      { user_id: owner, task_id: spansIntoNext, text: "a", is_done: true, sort_order: 0, unit_count: 100 },
      { user_id: owner, task_id: spansIntoNext, text: "b", is_done: false, sort_order: 1, unit_count: 300 },
    ]);
    if (checklistError) throw checklistError;

    const board = await queries.queryWeeklyBoardTasks(userClient, owner, weekEnd, 200, weekStart, "all");
    const ids = board.map((task) => task.id);
    assert.ok(ids.includes(inWeek) && ids.includes(spansIntoNext) && ids.includes(fromLastWeek), JSON.stringify(board.map((task) => task.title)));
    assert.ok(!ids.includes(nextWeekOnly) && !ids.includes(laterOneDay));
    const ranged = board.find((task) => task.id === spansIntoNext);
    assert.deepEqual(ranged.checklist_rows.map((r) => [r.is_done, Number(r.unit_count)]).sort(), [[false, 300], [true, 100]]);
    assert.deepEqual(board.find((task) => task.id === inWeek).checklist_rows, []);

    // Top priorities: a range not started by "today" stays out; started or start-less tasks stay in.
    const top = await queries.queryTopThreeTasks(userClient, owner, "all", new Date(etAt("2026-11-06", "10:00")));
    const topIds = top.map((task) => task.id);
    assert.ok(!topIds.includes(nextWeekOnly), "a range starting 11/10 isn't a priority on 11/6");
    assert.ok(topIds.includes(spansIntoNext) || topIds.length === 3);

    // Another user's session sees none of it (RLS on tasks and the embedded rows).
    const otherEmail = `range-s2o-${randomUUID().slice(0, 8)}@example.test`;
    const { data: other, error: otherError } = await admin.auth.admin.createUser({ email: otherEmail, password, email_confirm: true });
    if (otherError) throw otherError;
    users.push(other.user.id);
    const otherClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await otherClient.auth.signInWithPassword({ email: otherEmail, password });
    assert.deepEqual(await queries.queryWeeklyBoardTasks(otherClient, owner, weekEnd, 200, weekStart, "all"), []);

    // The API view the board fetches for another week goes through the same query.
    const viaRoute = await listTasks("view=weekly_board&week_start_date=2026-11-02&week_end_date=2026-11-08&limit=300");
    assert.equal(viaRoute.status, 200, JSON.stringify(viaRoute.body));
  });
} finally {
  for (const id of users) {
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
