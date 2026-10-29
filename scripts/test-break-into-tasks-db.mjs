#!/usr/bin/env node
// Database tests for "Break into tasks" (Baseline task d1f7e622, migration 066),
// against a LOCAL Supabase stack with every migration applied
// (scripts/test-stack/up.sh):
//
//   BIT_TEST_SUPABASE_URL=$STACK_API_URL BIT_TEST_ANON_KEY=$STACK_ANON_KEY \
//   BIT_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY BIT_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:break-into-tasks-db
//
// Part 1: 066 itself: the column, FK, guard trigger, grants; rollback and
//         re-apply (twice).
// Part 2: the real routes on the real database, signed in as the user (RLS):
//         the mockup case (4 finished + 2 open, chained), Done steps dated by
//         their tick, the umbrella left open with its checklist untouched, no
//         other due date moved, GET /api/tasks/{id} part_of/step_tasks, Today's
//         query and card counting the new tasks (all Done → Done lit, still
//         open), the Portfolio credit, a second break refused, the cascade
//         moving the next step but never the umbrella; no-project → new
//         project / existing project; existing section / unsectioned.
// Part 3: all-or-nothing: a failure on the last write rolls back the section,
//         the tasks, their history and comments; stale checklist, taken
//         section name, another user's task (RLS + the function's own check),
//         the guard trigger; Undo (and its refusal).
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.BIT_TEST_SUPABASE_URL;
const anonKey = process.env.BIT_TEST_ANON_KEY;
const serviceKey = process.env.BIT_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.BIT_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set BIT_TEST_SUPABASE_URL, BIT_TEST_ANON_KEY, BIT_TEST_SERVICE_ROLE_KEY and BIT_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/066_break_task_into_tasks.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/066_break_task_into_tasks.down.sql", import.meta.url), "utf8");

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

/**
 * One long-lived database session (its own psql process), for the two-session
 * barrier tests: run() sends SQL and resolves when it has finished (a marker
 * row after it), so a statement that blocks on a lock simply stays pending
 * until the other session lets it go. Signed in as a user (RLS applies) via
 * the same JWT claims PostgREST sets.
 */
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
      // stderr (errors) is unbuffered and written before the marker query runs; give the pipe a moment.
      setTimeout(() => {
        const err = this.err;
        this.err = "";
        waiter.resolve({ out: text, err });
      }, 60);
    }
  }
  run(sql, ms = 30_000) {
    this.n += 1;
    const marker = `__BIT_DONE_${this.n}__`;
    const done = new Promise((resolve) => {
      const waiter = { marker, resolve };
      this.waiters.push(waiter);
      // Never hang the suite: a statement still blocked after `ms` resolves as an error.
      setTimeout(() => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolve({ out: "", err: `session still blocked after ${ms} ms` });
      }, ms).unref();
    });
    // \echo, not SELECT: it prints even inside a transaction an error has aborted.
    this.proc.stdin.write(`${sql}\n\\echo ${marker}\n`);
    return done;
  }
  async signIn(userId) {
    const r = await this.run(`SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false) IS NOT NULL;`);
    assert.equal(r.err, "", r.err);
    return this;
  }
  close() {
    this.proc.stdin.end("\\q\n");
  }
}
/** Resolves once another backend is waiting on a lock while running SQL that matches `like`, or `settled()` is true. */
async function untilWaitingOrSettled(like, settled, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (settled()) return "settled";
    const waiting = psql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '${like}' AND pid <> pg_backend_pid();`);
    if (Number(waiting) > 0) return "waiting";
    await sleep(50);
  }
  throw new Error(`nothing waited on a lock for ${like} within ${ms} ms, and it never finished`);
}
/** A promise plus whether it has settled yet. */
function tracked(promise) {
  const t = { settled: false, promise: null };
  t.promise = promise.finally(() => {
    t.settled = true;
  });
  return t;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForColumn(present) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { error } = await admin.from("tasks").select("parent_task_id").limit(1);
    if (present ? !error : Boolean(error)) return;
    await sleep(250);
  }
  throw new Error(`schema cache never ${present ? "saw" : "dropped"} tasks.parent_task_id`);
}
/** After a re-apply, also wait until PostgREST knows the function again (a column read can come back first). */
async function waitForFunction() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { error } = await admin.rpc("break_task_into_tasks", { p_user_id: randomUUID(), p_task_id: randomUUID(), p_request: {} });
    if (!error || error.code !== "PGRST202") return;
    await sleep(250);
  }
  throw new Error("schema cache never saw break_task_into_tasks");
}

const users = [];
const passwords = new Map();
async function makeUser(prefix) {
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${prefix}-${randomUUID().slice(0, 8)}@example.test`,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  passwords.set(data.user.id, { email: data.user.email, password });
  return data.user.id;
}
async function userClient(id) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { email, password } = passwords.get(id);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.DEPLOYMENT_ROLE = "main";

const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const breakRoute = await import("../src/app/api/tasks/[id]/break/route.ts");
const stepsRoute = await import("../src/app/api/tasks/[id]/steps/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
const queries = await import("../src/lib/today/queries.ts");
const bit = await import("../src/lib/break-into-tasks.ts");
const rangeView = await import("../src/lib/task-range-view.ts");
const portfolioQueries = await import("../src/lib/portfolio-queries.ts");
const { getDateOnlyInTimeZone, addDateOnlyDays } = await import("../src/lib/date-only.ts");
const { buildRecurringDueAt } = await import("../src/lib/recurrence.ts");
const { readFamcalTaskComments } = await import("../src/lib/famcal-api-key.ts");
const { getProjectForecast } = await import("../src/lib/work-sessions/service.ts");
const { buildWorkIntelligenceSnapshot } = await import("../src/lib/work-intelligence/snapshot.ts");
const notesLib = await import("../src/lib/notes.ts");

const userA = await makeUser("bit-a");
const userB = await makeUser("bit-b");
const clientA = await userClient(userA);
const clientB = await userClient(userB);

const params = (id) => ({ params: Promise.resolve({ id }) });
const reply = async (response) => ({ status: response.status, body: await response.json() });
function routeRequest(method, path, body, supabase, userId) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase, user: { id: userId }, userId, authSource: "session" });
}
const breakTask = async (taskId, body, client = clientA, userId = userA) =>
  reply(await breakRoute.POST(routeRequest("POST", `/api/tasks/${taskId}/break`, body, client, userId), params(taskId)));
const getTask = async (taskId) => reply(await taskRoute.GET(routeRequest("GET", `/api/tasks/${taskId}`, undefined, clientA, userA), params(taskId)));
const getSteps = async (taskId) => reply(await stepsRoute.GET(routeRequest("GET", `/api/tasks/${taskId}/steps`, undefined, clientA, userA), params(taskId)));
const patchTask = async (taskId, body) => reply(await taskRoute.PATCH(routeRequest("PATCH", `/api/tasks/${taskId}`, body, clientA, userA), params(taskId)));

// Dates relative to today's ET date, so the Today queries see the umbrella in range.
const TZ = "America/New_York";
const today = getDateOnlyInTimeZone(TZ, new Date());
const day = (offset) => addDateOnlyDays(today, offset);
const endOf = (date) => buildRecurringDueAt(date, TZ);
const startOf = (date) => new Date(Date.parse(endOf(addDateOnlyDays(date, -1))) + 1).toISOString();

async function insert(table, row, client = admin) {
  const { data, error } = await client.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

/** A project, optional section, an umbrella with 4 ticked + 2 open rows (the mockup), and a task that waits on the umbrella. */
async function mockupFixture({ owner = userA, project = true, tags = ["work"], status = "In Progress" } = {}) {
  const app = await insert("implementations", { user_id: owner, name: `App ${randomUUID().slice(0, 6)}` });
  const sprint = await insert("sprints", { user_id: owner, name: "Sprint", start_date: day(-7), end_date: day(7) });
  const proj = project ? await insert("projects", { user_id: owner, name: `EPIC ${randomUUID().slice(0, 6)}`, implementation_id: app.id, tags: [] }) : null;
  const umbrella = await insert("tasks", {
    user_id: owner,
    title: "Fix readiness script failures from Daniel's review and retest (Scripts 002 + 006)",
    status,
    owner: "brent",
    project_id: proj?.id ?? null,
    implementation_id: proj ? null : app.id,
    sprint_id: sprint.id,
    tags,
    base_priority: 60,
    priority_score: 60,
    start_at: startOf(day(-6)),
    due_at: endOf(day(3)),
  });
  const texts = ["Retest row 64", "Exclude observational studies, rows 80–82", "QuickAction, rows 83–84", "Complete 006", "Complete 009", "Complete 015"];
  const ticked = { 0: -6, 1: -5, 2: -3, 4: -1 };
  const rows = [];
  for (const [index, text] of texts.entries()) {
    const done = index in ticked;
    rows.push(
      await insert("task_checklist_items", {
        user_id: owner,
        task_id: umbrella.id,
        text,
        sort_order: index,
        is_done: done,
        completed_at: done ? new Date(Date.parse(startOf(day(ticked[index]))) + 14 * 3600_000).toISOString() : null,
      })
    );
  }
  const waiter = await insert("tasks", { user_id: owner, title: "Waits on the umbrella", status: "Planned", due_at: endOf(day(8)), project_id: proj?.id ?? null });
  await insert("task_dependencies", { user_id: owner, task_id: waiter.id, depends_on_task_id: umbrella.id });
  return { app, sprint, proj, umbrella, rows, waiter };
}

const stepsBody = (rows, { chain = true, kind = "new_section", name = "Readiness steps", extra = {} } = {}) => ({
  destination: { kind, name: kind === "existing_section" ? undefined : name, ...extra },
  steps: rows.map((r, i) => ({
    checklist_item_id: r.id,
    due_date: r.is_done ? null : [day(0), day(3)][i === 3 ? 0 : 1],
    owner: i === 5 ? "agent" : "brent",
    waits_on_previous: chain,
  })),
});

/**
 * The toast's Undo body. Since fix round 1 the create reply carries `break_id`
 * and Undo takes nothing else; on the 5c5c8b4 code (no break_id) this sends the
 * old id list, so the fix-round tests below show what that code did.
 */
const undoOf = (made, legacyExtra = {}) =>
  made.body.break_id
    ? { action: "undo", break_id: made.body.break_id }
    : {
        action: "undo",
        task_ids: made.body.task_ids,
        section_id: made.body.section_created ? made.body.section_id : null,
        project_id: made.body.project_created ? made.body.project_id : null,
        umbrella_comment_id: made.body.umbrella_comment_id,
        ...legacyExtra,
      };

/** A small umbrella: open/done rows, any tags/project/application, no sprint. */
async function smallUmbrella({ owner = userA, title = "Small umbrella", tags = ["work"], projectId = null, implementationId = null, status = "Planned", rows = [["Open step", false]], units = null } = {}) {
  const umbrella = await insert("tasks", {
    user_id: owner, title, status, owner: "brent", project_id: projectId, implementation_id: implementationId, tags,
    base_priority: 50, priority_score: 50, due_at: endOf(day(5)),
  });
  const made = [];
  for (const [index, [text, done]] of rows.entries()) {
    made.push(await insert("task_checklist_items", {
      user_id: owner, task_id: umbrella.id, text, sort_order: index, is_done: done,
      completed_at: done ? new Date(Date.parse(startOf(day(-8))) + 15 * 3600_000).toISOString() : null,
      unit_count: units ? units[index] : null,
    }));
  }
  return { umbrella, rows: made };
}

const userState = (owner) =>
  json(`SELECT json_build_object(
    'tasks', (SELECT count(*) FROM tasks WHERE user_id = '${owner}'),
    'sections', (SELECT count(*) FROM project_sections WHERE user_id = '${owner}'),
    'projects', (SELECT count(*) FROM projects WHERE user_id = '${owner}'),
    'comments', (SELECT count(*) FROM task_comments WHERE user_id = '${owner}'),
    'deps', (SELECT count(*) FROM task_dependencies WHERE user_id = '${owner}'),
    'transitions', (SELECT count(*) FROM task_status_transitions WHERE user_id = '${owner}'),
    'dues', (SELECT coalesce(json_object_agg(id, due_at), '{}'::json) FROM tasks WHERE user_id = '${owner}'),
    'rows', (SELECT coalesce(json_agg(json_build_object('id', id, 'is_done', is_done, 'completed_at', completed_at, 'text', text) ORDER BY id), '[]'::json) FROM task_checklist_items WHERE user_id = '${owner}')
  );`);

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
  // ── Part 1: the migration ──────────────────────────────────────────────

  await test("066: tasks.parent_task_id is a nullable uuid, FK to tasks ON DELETE SET NULL; guard trigger; functions run for authenticated/service_role only", () => {
    assert.equal(psql(`SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'parent_task_id';`), "uuid:YES");
    assert.equal(psql(`SELECT confdeltype FROM pg_constraint WHERE conname = 'tasks_parent_task_id_fkey';`), "n");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_tasks_guard_parent_task' AND NOT tgisinternal;`), "1");
    for (const fn of ["break_task_into_tasks(uuid,uuid,jsonb)", "undo_break_task_into_tasks(uuid,uuid,jsonb)"]) {
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), "t");
      assert.equal(psql(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE');`), "t");
      assert.equal(psql(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE');`), "f");
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), "f", "SECURITY INVOKER");
    }
  });

  await test("066 rollback drops the column, trigger and functions; re-applying (twice) puts them back", async () => {
    psql(ROLLBACK);
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'parent_task_id';`), "0");
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('break_task_into_tasks', 'undo_break_task_into_tasks', 'tasks_guard_parent_task', 'task_break_lock_for_undo', 'note_links_lock_target', 'note_link_target_uuid');`), "0");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_note_links_lock_target';`), "0");
    await waitForColumn(false);
    psql(MIGRATION);
    psql(MIGRATION);
    // The test stack grants every function to the API roles; production relies on 066's own grants (checked above).
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('break_task_into_tasks', 'undo_break_task_into_tasks', 'tasks_guard_parent_task');`), "3");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'break_task_into_tasks(uuid,uuid,jsonb)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('task_break_lock_for_undo', 'note_links_lock_target', 'note_link_target_uuid');`), "3");
    assert.equal(psql(`SELECT prorettype::regtype::text FROM pg_proc WHERE proname = 'task_break_lock_for_undo';`), "boolean");
    assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_note_links_lock_target';`), "1", "one trigger, however often 066 runs");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'task_break_lock_for_undo(uuid,uuid[],uuid,uuid,uuid)', 'EXECUTE');`), "f");
    await waitForColumn(true);
    await waitForFunction();
    psql(`NOTIFY pgrst, 'reload schema';`);
    await sleep(1500);
    await waitForColumn(true);
  });

  // ── Part 2: the routes ─────────────────────────────────────────────────

  let main;
  let mainReply;
  await test("The mockup case, signed in as the user: 6 tasks in a new section, finished ones Done on their tick day, open ones dated/owned/statused, one 'waits on' link", async () => {
    main = await mockupFixture();
    const before = userState(userA);
    mainReply = await breakTask(main.umbrella.id, stepsBody(main.rows));
    assert.equal(mainReply.status, 201, JSON.stringify(mainReply.body));
    const { task_ids: ids, section_id: sectionId } = mainReply.body;
    assert.equal(ids.length, 6);
    assert.equal(mainReply.body.section_created, true);
    const section = json(`SELECT row_to_json(s) FROM project_sections s WHERE id = '${sectionId}';`);
    assert.equal(section.name, "Readiness steps");
    assert.equal(section.project_id, main.proj.id);
    assert.equal(section.planned_start, day(-6));
    assert.equal(section.planned_end, day(3));

    const tasks = json(`SELECT json_agg(row_to_json(t) ORDER BY created_at) FROM tasks t WHERE parent_task_id = '${main.umbrella.id}';`);
    assert.deepEqual(tasks.map((t) => t.id), ids, "checklist order");
    assert.deepEqual(tasks.map((t) => t.title), main.rows.map((r) => r.text));
    assert.deepEqual(tasks.map((t) => t.status), ["Done", "Done", "Done", "In Progress", "Done", "Planned"]);
    assert.deepEqual(tasks.map((t) => t.owner), ["brent", "brent", "brent", "brent", "brent", "agent"]);
    for (const t of tasks) {
      assert.equal(t.project_id, main.proj.id);
      assert.equal(t.section_id, sectionId);
      assert.equal(t.sprint_id, main.sprint.id);
      assert.equal(t.implementation_id, main.app.id, "046's trigger: the project's application");
      assert.deepEqual(t.tags, ["work"]);
      assert.equal(t.base_priority, 60);
      assert.equal(t.user_id, userA);
    }
    // Finished steps: due = end of the ET day the row was ticked; status history at the tick time.
    for (const [index, task] of tasks.entries()) {
      const r = main.rows[index];
      if (!r.is_done) continue;
      assert.equal(Date.parse(task.due_at), Date.parse(endOf(getDateOnlyInTimeZone(TZ, new Date(r.completed_at)))));
      const at = psql(`SELECT transitioned_at FROM task_status_transitions WHERE task_id = '${task.id}' AND to_status = 'Done';`);
      assert.equal(Date.parse(at.replace(" ", "T").replace(/\+00$/, "Z")), Date.parse(r.completed_at));
    }
    assert.equal(Date.parse(tasks[3].due_at), Date.parse(endOf(day(0))));
    assert.equal(Date.parse(tasks[5].due_at), Date.parse(main.umbrella.due_at), "the last step gets the umbrella's own due instant");
    // Chain: only the second open step waits on the first open one.
    const deps = json(`SELECT json_agg(json_build_object('t', task_id, 'on', depends_on_task_id)) FROM task_dependencies WHERE task_id = ANY(ARRAY['${ids.join("','")}']::uuid[]);`);
    assert.deepEqual(deps, [{ t: ids[5], on: ids[3] }]);
    // Comments: one per new task pointing back, one on the umbrella.
    assert.equal(psql(`SELECT count(*) FROM task_comments WHERE task_id = ANY(ARRAY['${ids.join("','")}']::uuid[]) AND source = 'system' AND content LIKE 'Part of “Fix readiness%';`), "6");
    assert.match(psql(`SELECT content FROM task_comments WHERE task_id = '${main.umbrella.id}';`), /^Broken into 6 tasks in the new section “Readiness steps” \(4 already done\)/);

    // The umbrella stays open; its checklist is untouched; no other due date moved; no cascade ran.
    const after = userState(userA);
    assert.deepEqual(after.rows, before.rows);
    assert.equal(psql(`SELECT status FROM tasks WHERE id = '${main.umbrella.id}';`), "In Progress");
    for (const [id, due] of Object.entries(before.dues)) assert.equal(after.dues[id], due, `due date of ${id}`);
    assert.equal(psql(`SELECT count(*) FROM task_date_cascades WHERE user_id = '${userA}';`), "0");
    assert.equal(after.tasks - before.tasks, 6);
    assert.equal(after.transitions - before.transitions, 6);
  });

  await test("GET /api/tasks/{id} (MCP get_task) and /steps: the umbrella lists its steps (4/6), each step says Part of", async () => {
    const umbrella = await getTask(main.umbrella.id);
    assert.equal(umbrella.status, 200);
    assert.equal(umbrella.body.step_tasks.length, 6);
    assert.deepEqual(umbrella.body.steps_progress, { done: 4, total: 6, all_done: false, text: "4/6 tasks done" });
    assert.equal(umbrella.body.part_of, null);
    assert.equal(umbrella.body.blocks.length, 1, "the task waiting on the umbrella still does");
    const step = await getTask(mainReply.body.task_ids[5]);
    assert.deepEqual(step.body.part_of, { id: main.umbrella.id, title: main.umbrella.title, status: "In Progress" });
    assert.equal(step.body.parent_task_id, main.umbrella.id);
    assert.equal(step.body.blocked_by.length, 1);
    const viaSteps = await getSteps(main.umbrella.id);
    assert.deepEqual(viaSteps.body.step_tasks.map((s) => s.id), mainReply.body.task_ids);
  });

  await test("Today: the umbrella's card counts the new tasks (4/6), then all Done → Done lights up and the umbrella stays open", async () => {
    const weekEnd = new Date(Date.parse(endOf(day(10))));
    const read = async () => (await queries.queryWeeklyBoardTasks(clientA, userA, weekEnd, 200)).find((t) => t.id === main.umbrella.id);
    let umbrella = await read();
    assert.equal(umbrella.step_tasks.length, 6);
    let progress = bit.progressRowsFor(umbrella);
    let card = rangeView.buildRangeCardView(umbrella, progress.rows, new Date(), { stepsAreTasks: progress.source === "tasks" });
    assert.equal(card.steps.text, "4/6 tasks");
    assert.equal(card.allStepsDone, false);
    for (const id of [mainReply.body.task_ids[3], mainReply.body.task_ids[5]]) {
      const done = await patchTask(id, { status: "Done" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
    }
    umbrella = await read();
    progress = bit.progressRowsFor(umbrella);
    card = rangeView.buildRangeCardView(umbrella, progress.rows, new Date(), { stepsAreTasks: true });
    assert.equal(card.steps.text, "6/6 tasks");
    assert.equal(card.allStepsDone, true);
    assert.equal(umbrella.status, "In Progress", "never closed on its own");
    // The kept checklist still has 2 open rows: progress ignores it.
    assert.equal(umbrella.checklist_rows.filter((r) => !r.is_done).length, 2);
    // Another user's session sees none of it.
    assert.deepEqual(await queries.queryWeeklyBoardTasks(clientB, userA, weekEnd, 200), []);
  });

  await test("Portfolio: the umbrella's credit comes from its steps, not its checklist", async () => {
    const input = await portfolioQueries.loadPortfolioInput(clientA, userA, { getForecast: async () => { throw new Error("no pace"); } });
    assert.deepEqual(input.checklist[main.umbrella.id], { done: 6, total: 6 });
    const step = input.tasks.find((t) => t.id === mainReply.body.task_ids[0]);
    assert.equal(step.parent_task_id, main.umbrella.id);
  });

  await test("A second break of the same task is refused (409), nothing written", async () => {
    const before = userState(userA);
    const again = await breakTask(main.umbrella.id, stepsBody(main.rows, { name: "Again" }));
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already been broken/);
    assert.deepEqual(userState(userA), before);
  });

  await test("Cascade: moving a chained step later moves the step that waits on it; the umbrella never moves", async () => {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows));
    assert.equal(made.status, 201);
    const [first, second] = [made.body.task_ids[3], made.body.task_ids[5]];
    const secondDue = psql(`SELECT due_at FROM tasks WHERE id = '${second}';`);
    const umbrellaDue = psql(`SELECT due_at FROM tasks WHERE id = '${fixture.umbrella.id}';`);
    const moved = await patchTask(first, { due_at: endOf(day(1)) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.cascade.status, "moved");
    assert.deepEqual(moved.body.cascade.moves.map((m) => m.task_id), [second]);
    assert.notEqual(psql(`SELECT due_at FROM tasks WHERE id = '${second}';`), secondDue);
    assert.equal(psql(`SELECT due_at FROM tasks WHERE id = '${fixture.umbrella.id}';`), umbrellaDue);
  });

  await test("Chain off: no 'waits on' links at all", async () => {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { chain: false }));
    assert.equal(made.status, 201);
    assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE task_id = ANY(ARRAY['${made.body.task_ids.join("','")}']::uuid[]);`), "0");
  });

  await test("No project → new project named after the task (tags and application copied, stage from the task, steps unsectioned)", async () => {
    const fixture = await mockupFixture({ project: false, tags: ["personal"] });
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "new_project", name: "Readiness project" }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.project_created, true);
    assert.equal(made.body.section_id, null);
    const project = json(`SELECT row_to_json(p) FROM projects p WHERE id = '${made.body.project_id}';`);
    assert.equal(project.name, "Readiness project");
    assert.deepEqual(project.tags, ["personal"]);
    assert.equal(project.implementation_id, fixture.app.id);
    assert.equal(project.stage, "In Progress");
    assert.equal(project.user_id, userA);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE parent_task_id = '${fixture.umbrella.id}' AND project_id = '${made.body.project_id}' AND section_id IS NULL;`), "6");
    assert.equal(psql(`SELECT project_id IS NULL FROM tasks WHERE id = '${fixture.umbrella.id}';`), "t", "the umbrella stays where it was");
  });

  await test("No project → an existing project, as a new section named after the task; section kinds refused for a task without a project", async () => {
    const fixture = await mockupFixture({ project: false });
    const target = await insert("projects", { user_id: userA, name: "Home", tags: [] });
    const refused = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "new_section", name: "x" }));
    assert.equal(refused.status, 400);
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "existing_project", name: "Readiness", extra: { project_id: target.id } }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.project_id, target.id);
    assert.equal(made.body.project_created, false);
    assert.equal(psql(`SELECT name || ':' || project_id FROM project_sections WHERE id = '${made.body.section_id}';`), `Readiness:${target.id}`);
  });

  await test("Existing section (and unsectioned): no new section is made", async () => {
    const fixture = await mockupFixture();
    const existing = await insert("project_sections", { user_id: userA, project_id: fixture.proj.id, name: "Retests" });
    const sectionsBefore = psql(`SELECT count(*) FROM project_sections WHERE project_id = '${fixture.proj.id}';`);
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "existing_section", extra: { section_id: existing.id } }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.section_created, false);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE parent_task_id = '${fixture.umbrella.id}' AND section_id = '${existing.id}';`), "6");
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE project_id = '${fixture.proj.id}';`), sectionsBefore);
    const second = await mockupFixture();
    const unsectioned = await breakTask(second.umbrella.id, stepsBody(second.rows, { kind: "existing_section", extra: { section_id: null } }));
    assert.equal(unsectioned.status, 201);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE parent_task_id = '${second.umbrella.id}' AND section_id IS NULL AND project_id = '${second.proj.id}';`), "6");
  });

  // ── Part 3: all-or-nothing, refusals, RLS, Undo ────────────────────────

  await test("All or nothing: a failure on the LAST write (the umbrella's comment) rolls back the section, the 6 tasks, their links, history and comments", async () => {
    const fixture = await mockupFixture();
    const before = userState(userA);
    psql(`
      CREATE OR REPLACE FUNCTION bit_test_fail_umbrella_comment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.content LIKE 'Broken into%' THEN RAISE EXCEPTION 'bit test: forced failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bit_test_fail BEFORE INSERT ON task_comments FOR EACH ROW EXECUTE FUNCTION bit_test_fail_umbrella_comment();
    `);
    try {
      const failed = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { name: "Will roll back" }));
      assert.equal(failed.status, 500, JSON.stringify(failed.body));
      assert.match(failed.body.error, /Nothing was changed/);
    } finally {
      psql(`DROP TRIGGER IF EXISTS bit_test_fail ON task_comments; DROP FUNCTION IF EXISTS bit_test_fail_umbrella_comment();`);
    }
    assert.deepEqual(userState(userA), before);
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE name = 'Will roll back' AND user_id = '${userA}';`), "0");
    // And it works once the failure is gone.
    const ok = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { name: "Will roll back" }));
    assert.equal(ok.status, 201);
  });

  await test("Stale window: a row ticked after the app read the checklist → checklist_changed, nothing written", async () => {
    const fixture = await mockupFixture();
    const parsed = bit.parseBreakRequest(stepsBody(fixture.rows));
    const plan = bit.planBreak(parsed.value, { umbrella: { ...fixture.umbrella, project: { tags: [] } }, rows: fixture.rows, projectName: "P", now: new Date() });
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id = '${fixture.rows[3].id}';`);
    const before = userState(userA);
    const { data, error } = await clientA.rpc("break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.equal(error, null);
    assert.deepEqual(data, { ok: false, reason: "checklist_changed" });
    assert.deepEqual(userState(userA), before);
    // The route reads the checklist itself, so a fresh request sees the tick (and makes it a Done task).
    const fresh = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows.map((r, i) => (i === 3 ? { ...r, is_done: true } : r))));
    assert.equal(fresh.status, 201);
    assert.equal(psql(`SELECT status FROM tasks WHERE id = '${fresh.body.task_ids[3]}';`), "Done");
  });

  await test("Stale window: the task's project or base priority changed → task_changed; a taken section name → 409", async () => {
    const fixture = await mockupFixture();
    const parsed = bit.parseBreakRequest(stepsBody(fixture.rows));
    const plan = bit.planBreak(parsed.value, { umbrella: { ...fixture.umbrella, project: { tags: [] } }, rows: fixture.rows, projectName: "P", now: new Date() });
    psql(`UPDATE tasks SET base_priority = 70 WHERE id = '${fixture.umbrella.id}';`);
    const { data } = await clientA.rpc("break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.deepEqual(data, { ok: false, reason: "task_changed" });
    await insert("project_sections", { user_id: userA, project_id: fixture.proj.id, name: "Taken" });
    const taken = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { name: " taken " }));
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /already has a section with this name/);
  });

  await test("RLS: another signed-in user can't break A's task (their own id → not found; A's id → refused), and sees nothing", async () => {
    const fixture = await mockupFixture();
    const before = userState(userA);
    const asB = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows), clientB, userB);
    assert.equal(asB.status, 404);
    const parsed = bit.parseBreakRequest(stepsBody(fixture.rows));
    const plan = bit.planBreak(parsed.value, { umbrella: { ...fixture.umbrella, project: { tags: [] } }, rows: fixture.rows, projectName: "P", now: new Date() });
    const spoof = await clientB.rpc("break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.equal(spoof.error?.code, "42501");
    const own = await clientB.rpc("break_task_into_tasks", { p_user_id: userB, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.deepEqual(own.data, { ok: false, reason: "not_found" });
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const anonCall = await anon.rpc("break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.ok(anonCall.error, "anon has no EXECUTE");
    assert.deepEqual(userState(userA), before);
  });

  await test("Guard trigger: a parent must be the same user's task; an UPDATE may only clear it; deleting the umbrella frees its steps", async () => {
    const theirs = await insert("tasks", { user_id: userB, title: "Theirs" });
    assert.match(psqlFails(`BEGIN; SELECT set_config('mission_control.break_umbrella_id', '${theirs.id}', true); INSERT INTO tasks (user_id, title, parent_task_id) VALUES ('${userA}', 'x', '${theirs.id}'); COMMIT;`), /same user/);
    const { error: viaApi } = await clientA.from("tasks").insert({ user_id: userA, title: "x", parent_task_id: theirs.id });
    assert.ok(viaApi, "refused through PostgREST too");
    const { umbrella: mine, rows } = await smallUmbrella({ title: "Mine" });
    const made = await breakTask(mine.id, { destination: { kind: "new_project", name: `Guard ${randomUUID().slice(0, 6)}` }, steps: [{ checklist_item_id: rows[0].id, due_date: null, owner: "brent" }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const child = { id: made.body.task_ids[0] };
    const other = await insert("tasks", { user_id: userA, title: "Other" });
    assert.match(psqlFails(`UPDATE tasks SET parent_task_id = '${other.id}' WHERE id = '${child.id}';`), /only be cleared/);
    assert.match(psqlFails(`UPDATE tasks SET parent_task_id = id WHERE id = '${other.id}';`), /cleared|own umbrella|parent_task_not_self/);
    psql(`DELETE FROM tasks WHERE id = '${mine.id}';`);
    assert.equal(psql(`SELECT parent_task_id IS NULL FROM tasks WHERE id = '${child.id}';`), "t");
  });

  await test("Undo: deletes the new tasks, the section it made and the umbrella's comment; the checklist was never touched; a second Undo is refused", async () => {
    const fixture = await mockupFixture();
    const before = userState(userA);
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { name: "Undo me" }));
    assert.equal(made.status, 201);
    const undoBody = undoOf(made);
    const undone = await breakTask(fixture.umbrella.id, undoBody);
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(undone.body.deleted_tasks, 6);
    assert.equal(undone.body.section_deleted, true);
    const after = userState(userA);
    assert.deepEqual({ ...after, transitions: before.transitions }, before, "back to exactly where it was (history rows of deleted tasks go with them)");
    const again = await breakTask(fixture.umbrella.id, undoBody);
    assert.equal(again.status, 409);
    // It can be broken out again after an Undo.
    const redo = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { name: "Undo me" }));
    assert.equal(redo.status, 201);
  });

  await test("Undo: a new project is removed too; a step that was detached since makes Undo refuse with nothing deleted", async () => {
    const fixture = await mockupFixture({ project: false });
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "new_project", name: "Undo project" }));
    assert.equal(made.status, 201);
    const undone = await breakTask(fixture.umbrella.id, undoOf(made));
    assert.equal(undone.status, 200);
    assert.equal(undone.body.project_deleted, true);
    assert.equal(psql(`SELECT count(*) FROM projects WHERE id = '${made.body.project_id}';`), "0");

    const second = await mockupFixture();
    const made2 = await breakTask(second.umbrella.id, stepsBody(second.rows, { name: "Keep me" }));
    psql(`UPDATE tasks SET parent_task_id = NULL WHERE id = '${made2.body.task_ids[0]}';`);
    const refused = await breakTask(second.umbrella.id, undoOf(made2));
    assert.equal(refused.status, 409);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE id = ANY(ARRAY['${made2.body.task_ids.join("','")}']::uuid[]);`), "6");
    // Another user's Undo can't touch them either.
    const asB = await breakTask(second.umbrella.id, undoOf(made2), clientB, userB);
    assert.equal(asB.status, 409);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE id = ANY(ARRAY['${made2.body.task_ids.join("','")}']::uuid[]);`), "6");
  });

  await test("A repeating template can't be broken into tasks", async () => {
    const template = await insert("tasks", { user_id: userA, title: "Weekly", is_recurring_template: true, recurrence: { enabled: true, frequency: "weekly", interval: 1, days_of_week: [1], timezone: TZ } });
    const r = await insert("task_checklist_items", { user_id: userA, task_id: template.id, text: "Step", sort_order: 0 });
    const refused = await breakTask(template.id, { destination: { kind: "new_project", name: "x" }, steps: [{ checklist_item_id: r.id, due_date: null, owner: "brent" }] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /repeating task/);
  });

  // ── Fix round 1 (Codex Astra review of 5c5c8b4): one test per finding ──

  const countIn = (table, column, ids) => psql(`SELECT count(*) FROM ${table} WHERE ${column} = ANY(ARRAY['${ids.join("','")}']::uuid[]);`);
  const newSectionBody = (rows, name) => ({ destination: { kind: "new_section", name }, steps: rows.map((r) => ({ checklist_item_id: r.id, due_date: r.is_done ? null : day(2), owner: "brent", waits_on_previous: true })) });

  await test("FR 066: task_breaks (owner reads only; writes only inside the functions), task_break_fingerprint and tasks.source_checklist_item_id are in place", () => {
    assert.equal(psql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.task_breaks'::regclass;`), "t");
    assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE tablename = 'task_breaks' AND cmd = 'UPDATE';`), "0", "records are never updated");
    // No FK on source_checklist_item_id: a second tasks ↔ task_checklist_items relationship would break every
    // `task_checklist_items(...)` embed from tasks (PostgREST: "more than one relationship").
    assert.equal(psql(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.tasks'::regclass AND confrelid = 'public.task_checklist_items'::regclass;`), "0");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'task_break_fingerprint(uuid,uuid[],uuid,uuid,uuid)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE proname = 'task_break_fingerprint';`), "f", "SECURITY INVOKER");
  });

  await test("FR P1-1: Undo can't be pointed at an unrelated empty project (with history), section or comment: substituted ids are refused and they survive", async () => {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, newSectionBody(fixture.rows, "P1-1"));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const victim = await insert("projects", { user_id: userA, name: "Unrelated empty project", tags: [] });
    await insert("project_status_updates", { user_id: userA, project_id: victim.id, summary: "History that must survive" });
    const victimSection = await insert("project_sections", { user_id: userA, project_id: fixture.proj.id, name: "Unrelated empty section", planned_start: day(1), planned_end: day(4) });
    const victimComment = await insert("task_comments", { user_id: userA, task_id: fixture.umbrella.id, content: "Another system comment", source: "system" });
    const before = userState(userA);
    // The 5c5c8b4 Undo body, with the unrelated ids substituted in.
    const substituted = {
      action: "undo",
      task_ids: made.body.task_ids,
      section_id: victimSection.id,
      project_id: victim.id,
      umbrella_comment_id: victimComment.id,
    };
    const refused = await breakTask(fixture.umbrella.id, substituted);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(psql(`SELECT count(*) FROM projects WHERE id = '${victim.id}';`), "1", "the unrelated project survives");
    assert.equal(psql(`SELECT count(*) FROM project_status_updates WHERE project_id = '${victim.id}';`), "1", "with its history");
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE id = '${victimSection.id}';`), "1");
    assert.equal(psql(`SELECT count(*) FROM task_comments WHERE id = '${victimComment.id}';`), "1");
    assert.deepEqual(userState(userA), before, "nothing at all changed");
    // The function itself takes only break_id too (a direct RPC with ids is refused).
    const direct = await clientA.rpc("undo_break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: { task_ids: made.body.task_ids, project_id: victim.id } });
    assert.ok(direct.error, "direct RPC with ids refused");
    // Another umbrella's break id doesn't work on this umbrella.
    const other = await mockupFixture();
    const madeOther = await breakTask(other.umbrella.id, newSectionBody(other.rows, "P1-1 other"));
    const beforeCrossed = userState(userA);
    const crossed = await breakTask(fixture.umbrella.id, { action: "undo", break_id: madeOther.body.break_id ?? randomUUID() });
    assert.equal(crossed.status, 409);
    assert.deepEqual(userState(userA), beforeCrossed, "another umbrella's break id deletes nothing");
    // And a record can't be forged or removed through the API (only the functions write task_breaks).
    const forged = await clientA.from("task_breaks").insert({ user_id: userA, umbrella_task_id: fixture.umbrella.id, task_ids: [made.body.task_ids[0]], project_id: victim.id, project_created: true, fingerprint: "x" });
    assert.ok(forged.error, "forged record refused");
    await clientA.from("task_breaks").delete().eq("umbrella_task_id", fixture.umbrella.id);
    assert.equal(psql(`SELECT count(*) FROM task_breaks WHERE umbrella_task_id = '${fixture.umbrella.id}';`), "1", "RLS: the record can't be deleted through the API");
    // The real Undo still works and deletes only what the break made.
    const undone = await breakTask(fixture.umbrella.id, undoOf(made));
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(undone.body.project_deleted, false);
    assert.equal(psql(`SELECT count(*) FROM projects WHERE id = '${victim.id}';`), "1");
    assert.equal(psql(`SELECT count(*) FROM task_comments WHERE id = '${victimComment.id}';`), "1");
  });

  async function staleUndoCase(change) {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, newSectionBody(fixture.rows, `Stale ${randomUUID().slice(0, 6)}`));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const ids = made.body.task_ids;
    await change({ fixture, made, ids });
    const before = userState(userA);
    const undone = await breakTask(fixture.umbrella.id, undoOf(made));
    assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
    assert.match(undone.body.error, /changed since the break/);
    // Nothing deleted (counts, not every column: a PATCH can still be settling priorities in the background).
    const after = userState(userA);
    for (const key of ["tasks", "sections", "projects", "comments", "deps"]) assert.equal(after[key], before[key], `nothing deleted: ${key}`);
    assert.deepEqual(after.rows, before.rows);
    assert.equal(countIn("tasks", "id", ids), "6");
    return { fixture, made, ids };
  }

  await test("FR P1-2: a comment added to a step since the break → Undo refuses, the step and the comment stay", async () => {
    await staleUndoCase(async ({ ids }) => {
      const { error } = await clientA.from("task_comments").insert({ user_id: userA, task_id: ids[3], content: "Real work notes", source: "manual" });
      assert.equal(error, null);
    });
  });

  await test("FR P1-2: another task linked to wait on a step → Undo refuses, the link stays (X stays blocked)", async () => {
    const { ids } = await staleUndoCase(async ({ ids }) => {
      const x = await insert("tasks", { user_id: userA, title: "X waits on step 4", status: "Planned" }, clientA);
      const { error } = await clientA.from("task_dependencies").insert({ user_id: userA, task_id: x.id, depends_on_task_id: ids[3] });
      assert.equal(error, null);
    });
    assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE depends_on_task_id = '${ids[3]}' AND NOT is_resolved;`), "2", "step 6's chain link and X's link");
  });

  await test("FR P1-2: a step edited or completed since → Undo refuses", async () => {
    await staleUndoCase(async ({ ids }) => {
      const done = await patchTask(ids[3], { status: "Done" });
      assert.equal(done.status, 200, JSON.stringify(done.body));
    });
    await staleUndoCase(async ({ ids }) => {
      const renamed = await patchTask(ids[5], { title: "Complete 015 (renamed)" });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    });
  });

  await test("FR P1-2: a new task added to the section the break made, or a note linked to a step → Undo refuses", async () => {
    await staleUndoCase(async ({ fixture, made }) => {
      await insert("tasks", { user_id: userA, title: "Added later", project_id: fixture.proj.id, section_id: made.body.section_id }, clientA);
    });
    await staleUndoCase(async ({ ids }) => {
      const note = await insert("notes", { user_id: userA, title: "Note", note_type: "working_note" }, clientA);
      await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: ids[0] }, clientA);
    });
  });

  await test("FR P1-3: a personal task broken into a WORK project: the FamCal key's comment read never shows the project's name", async () => {
    const work = await insert("projects", { user_id: userA, name: "CONFIDENTIAL WORK PROJECT", tags: [] });
    const { umbrella, rows } = await smallUmbrella({ title: "Pick up the dog food", tags: ["personal"], rows: [["Open step", false], ["Done step", true]] });
    const made = await breakTask(umbrella.id, { destination: { kind: "existing_project", name: "Errands", project_id: work.id }, steps: rows.map((r) => ({ checklist_item_id: r.id, due_date: null, owner: "brent" })) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const famcal = await readFamcalTaskComments(admin, userA, umbrella.id);
    assert.ok(Array.isArray(famcal) && famcal.length === 1, "the umbrella is FamCal-visible and has its comment");
    for (const comment of famcal) assert.doesNotMatch(comment.content, /CONFIDENTIAL|Errands/);
    assert.match(famcal[0].content, /^Broken into 2 tasks in another project \(1 already done\)/);
    // The steps (in the work project) aren't FamCal-visible; their comments may name the personal umbrella.
    assert.equal(await readFamcalTaskComments(admin, userA, made.body.task_ids[0]), null);
    // Control: into a PERSONAL project the same audience sees both, so the name is used.
    const garden = await insert("projects", { user_id: userA, name: "Garden", tags: ["personal"] });
    const second = await smallUmbrella({ title: "Plant bulbs", tags: ["personal"] });
    const made2 = await breakTask(second.umbrella.id, { destination: { kind: "existing_project", name: "Bulbs", project_id: garden.id }, steps: [{ checklist_item_id: second.rows[0].id, due_date: null, owner: "brent" }] });
    assert.equal(made2.status, 201, JSON.stringify(made2.body));
    assert.match((await readFamcalTaskComments(admin, userA, second.umbrella.id))[0].content, /a new section “Bulbs” in Garden/);
  });

  await test("FR P1-3 (reverse): a non-FamCal task whose steps become FamCal-visible: the steps' comments don't name it", async () => {
    const app = await insert("implementations", { user_id: userA, name: `Work app ${randomUUID().slice(0, 6)}` });
    const { umbrella, rows } = await smallUmbrella({ title: "SECRET WORK TASK TITLE", tags: ["personal"], implementationId: app.id });
    assert.equal(await readFamcalTaskComments(admin, userA, umbrella.id), null, "the umbrella is not FamCal-visible (it has an application)");
    // A new project gets the task's tags (personal) but 046 keeps the application on the project; make the target a plain personal project instead.
    const home = await insert("projects", { user_id: userA, name: "Home", tags: ["personal"] });
    const made = await breakTask(umbrella.id, { destination: { kind: "existing_project", name: "Home steps", project_id: home.id }, steps: [{ checklist_item_id: rows[0].id, due_date: null, owner: "brent" }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const stepComments = await readFamcalTaskComments(admin, userA, made.body.task_ids[0]);
    assert.ok(Array.isArray(stepComments) && stepComments.length === 1, "the step is FamCal-visible");
    assert.doesNotMatch(stepComments[0].content, /SECRET/);
    assert.match(stepComments[0].content, /^Part of another task: broken out of its checklist/);
  });

  await test("FR P2-2: the pace forecast counts a broken-out row once (10 units left stays 10, not 20; step Done → 0); partial selection; Undo", async () => {
    const proj = await insert("projects", { user_id: userA, name: `Blanket ${randomUUID().slice(0, 6)}`, unit_label: "rows", tags: [] });
    const { umbrella, rows } = await smallUmbrella({ title: "Rows 1-14", projectId: proj.id, rows: [["Rows 1-10", false], ["Rows 11-14", false]], units: [10, 4] });
    psql(`UPDATE tasks SET work_type = 'sc' WHERE id = '${umbrella.id}';`);
    const left = async () => (await getProjectForecast(clientA, userA, proj.id)).forecast.work_types.reduce((sum, t) => sum + t.units_left, 0);
    assert.equal(await left(), 14);
    const made = await breakTask(umbrella.id, { destination: { kind: "new_section", name: "First ten" }, steps: [{ checklist_item_id: rows[0].id, due_date: day(2), owner: "brent" }] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(await left(), 14, "the same work, counted once");
    assert.equal(psql(`SELECT unit_count::int || ':' || source_checklist_item_id FROM tasks WHERE id = '${made.body.task_ids[0]}';`), `10:${rows[0].id}`);
    const before = await left();
    const done = await patchTask(made.body.task_ids[0], { status: "Done" });
    assert.equal(done.status, 200);
    assert.equal(await left(), before - 10, "step Done → its row's units are done");
    // Undo (a fresh break, untouched) puts the row back on its own.
    const second = await smallUmbrella({ title: "Rows 15-20", projectId: proj.id, rows: [["Rows 15-20", false]], units: [6] });
    const at = await left();
    const made2 = await breakTask(second.umbrella.id, { destination: { kind: "new_section", name: "Last six" }, steps: [{ checklist_item_id: second.rows[0].id, due_date: day(2), owner: "brent" }] });
    assert.equal(await left(), at);
    assert.equal((await breakTask(second.umbrella.id, undoOf(made2))).status, 200);
    assert.equal(await left(), at);
  });

  await test("FR P2-3: historical finished steps are not today's completions (updated_at = tick time; the brief snapshot agrees)", async () => {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, newSectionBody(fixture.rows, "P2-3"));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const steps = json(`SELECT json_agg(row_to_json(t) ORDER BY created_at) FROM tasks t WHERE parent_task_id = '${fixture.umbrella.id}';`);
    for (const [index, step] of steps.entries()) {
      const r = fixture.rows[index];
      if (r.is_done) assert.equal(Date.parse(step.updated_at), Date.parse(r.completed_at), `step ${index + 1}: updated_at = its tick time`);
    }
    const dayStart = startOf(today);
    const window = { requestedDate: today, since: dayStart, dayStartIso: dayStart, dayEndExclusiveIso: startOf(day(1)), timezone: TZ };
    const snapshotTasks = () => json(`SELECT json_agg(row_to_json(t)) FROM tasks t WHERE parent_task_id = '${fixture.umbrella.id}';`)
      .map((t) => ({ ...t, implementation: null, project: null, sprint: null }));
    let snapshot = buildWorkIntelligenceSnapshot({ now: new Date(), window, tasks: snapshotTasks(), events: [], taskComments: [], currentSprint: null });
    assert.deepEqual(snapshot.completedTodayTasks.map((t) => t.id), [], "none of the 4 old finished steps count as done today");
    // Control: a step finished today does count.
    assert.equal((await patchTask(made.body.task_ids[3], { status: "Done" })).status, 200);
    snapshot = buildWorkIntelligenceSnapshot({ now: new Date(), window, tasks: snapshotTasks(), events: [], taskComments: [], currentSprint: null });
    assert.deepEqual(snapshot.completedTodayTasks.map((t) => t.id), [made.body.task_ids[3]]);
  });

  await test("FR P2-4: a Done task can't be broken (route refused; and closed under the lock after the app planned → task_closed), nothing written", async () => {
    for (const status of ["Done", "Parked", "Missed"]) {
      const closed = await smallUmbrella({ title: `Closed ${status}`, status });
      const before = userState(userA);
      const refused = await breakTask(closed.umbrella.id, { destination: { kind: "new_project", name: `Closed ${status} ${randomUUID().slice(0, 4)}` }, steps: [{ checklist_item_id: closed.rows[0].id, due_date: null, owner: "brent" }] });
      assert.ok(refused.status === 400 || refused.status === 409, `${status}: ${refused.status} ${JSON.stringify(refused.body)}`);
      assert.deepEqual(userState(userA), before, status);
    }
    const fixture = await mockupFixture();
    const parsed = bit.parseBreakRequest(stepsBody(fixture.rows));
    const plan = bit.planBreak(parsed.value, { umbrella: { ...fixture.umbrella, project: { tags: [] } }, rows: fixture.rows, projectName: "P", now: new Date() });
    assert.equal(plan.ok, true);
    psql(`UPDATE tasks SET status = 'Done' WHERE id = '${fixture.umbrella.id}';`);
    const before = userState(userA);
    const { data, error } = await clientA.rpc("break_task_into_tasks", { p_user_id: userA, p_task_id: fixture.umbrella.id, p_request: plan.value });
    assert.equal(error, null);
    assert.deepEqual(data, { ok: false, reason: "task_closed" });
    assert.deepEqual(userState(userA), before);
  });

  await test("FR L3: a step can't be made by a direct insert (PostgREST or SQL), even for the user's own task; nor can a source row be set", async () => {
    const { umbrella, rows } = await smallUmbrella({ title: "L3" });
    const viaApi = await clientA.from("tasks").insert({ user_id: userA, title: "Sneaky step", parent_task_id: umbrella.id });
    assert.ok(viaApi.error, "PostgREST insert with parent_task_id refused");
    assert.match(psqlFails(`INSERT INTO tasks (user_id, title, parent_task_id) VALUES ('${userA}', 'x', '${umbrella.id}');`), /only by Break into tasks|parent_task_guard/);
    const plain = await insert("tasks", { user_id: userA, title: "Plain" }, clientA);
    const setSource = await clientA.from("tasks").update({ source_checklist_item_id: rows[0].id }).eq("id", plain.id);
    assert.ok(setSource.error, "setting a source row later is refused");
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE parent_task_id = '${umbrella.id}';`), "0");
  });

  // ── Fix round 2: Undo's fingerprint is a fence, not just a check ──────────
  // Each case is a deterministic two-session schedule: session 1 holds a write
  // open (not committed), Undo (the real route) starts and must either wait for
  // it or finish; then session 1 commits. On 7ea9257 Undo answered ok and the
  // committed comment/edit/link was cascade-deleted (or left dangling); since
  // fix round 2 Undo refuses with nothing deleted (since fix round 3 without
  // waiting: its fence is NOWAIT, a write in flight = changed).

  async function raceFixture() {
    const fixture = await mockupFixture();
    const made = await breakTask(fixture.umbrella.id, newSectionBody(fixture.rows, `Race ${randomUUID().slice(0, 6)}`));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { fixture, made, ids: made.body.task_ids };
  }

  async function undoAgainstOpenWrite({ fixture, made }, writeSql) {
    const s1 = await new Session().signIn(userA);
    try {
      const begun = await s1.run(`BEGIN; ${writeSql}`);
      assert.equal(begun.err, "", `the held write itself succeeds: ${begun.err}`);
      const undo = tracked(breakTask(fixture.umbrella.id, undoOf(made)));
      const state = await untilWaitingOrSettled("%undo_break_task_into_tasks%", () => undo.settled);
      const committed = await s1.run("COMMIT;");
      assert.equal(committed.err, "", `session 1 commits: ${committed.err}`);
      return { undone: await undo.promise, state };
    } finally {
      s1.close();
    }
  }

  await test("FR2 P1-2 race: a comment insert still in flight when Undo starts → Undo refuses at once (FR3: never waits on a writer); the step and the comment stay", async () => {
    const race = await raceFixture();
    const { undone, state } = await undoAgainstOpenWrite(race, `INSERT INTO task_comments (user_id, task_id, content, source) VALUES ('${userA}', '${race.ids[3]}', 'Typed while Undo ran', 'manual');`);
    assert.equal(state, "settled", "Undo answered without waiting on the open comment");
    assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
    assert.match(undone.body.error, /changed since the break/);
    assert.equal(psql(`SELECT count(*) FROM task_comments WHERE task_id = '${race.ids[3]}' AND content = 'Typed while Undo ran';`), "1", "the comment survives");
    assert.equal(countIn("tasks", "id", race.ids), "6", "no step deleted");
  });

  await test("FR2 P1-2 race: an edit of a step's comment in flight → Undo refuses; the edit stays", async () => {
    const race = await raceFixture();
    const { undone } = await undoAgainstOpenWrite(race, `UPDATE task_comments SET content = 'Edited while Undo ran' WHERE task_id = '${race.ids[0]}' AND source = 'system';`);
    assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
    assert.equal(psql(`SELECT count(*) FROM task_comments WHERE task_id = '${race.ids[0]}' AND content = 'Edited while Undo ran';`), "1", "the edit survives");
    assert.equal(countIn("tasks", "id", race.ids), "6");
  });

  await test("FR2 P1-2 race: a note link to a step in flight (no foreign key) → Undo refuses; the link and its step stay", async () => {
    const race = await raceFixture();
    const note = await insert("notes", { user_id: userA, title: "Race note", note_type: "working_note" }, clientA);
    const { undone } = await undoAgainstOpenWrite(race, `INSERT INTO note_links (user_id, note_id, entity_type, entity_id) VALUES ('${userA}', '${note.id}', 'task', '${race.ids[1]}');`);
    assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
    assert.equal(psql(`SELECT count(*) FROM note_links l JOIN tasks t ON t.id::text = l.entity_id WHERE l.note_id = '${note.id}';`), "1", "the link names a step that still exists");
  });

  await test("FR2 P1-2 race: a new task filed into the section the break made, in flight → Undo refuses; the section and the task stay", async () => {
    const race = await raceFixture();
    const { undone } = await undoAgainstOpenWrite(race, `INSERT INTO tasks (user_id, title, project_id, section_id) VALUES ('${userA}', 'Filed while Undo ran', '${race.fixture.proj.id}', '${race.made.body.section_id}');`);
    assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE title = 'Filed while Undo ran' AND section_id = '${race.made.body.section_id}';`), "1", "the task is still in its section");
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE id = '${race.made.body.section_id}';`), "1");
  });

  await test("FR2 P1-2 race (other order): writes that start after Undo took its locks wait, then are REFUSED (comment route 404, note link refused), never saved and lost", async () => {
    const race = await raceFixture();
    const note = await insert("notes", { user_id: userA, title: "Late note", note_type: "working_note" }, clientA);
    const undoSession = await new Session().signIn(userA);
    const linkSession = await new Session().signIn(userA);
    try {
      const held = await undoSession.run(`BEGIN; SELECT undo_break_task_into_tasks('${userA}', '${race.fixture.umbrella.id}', '{"break_id":"${race.made.body.break_id}"}'::jsonb) ->> 'ok';`);
      assert.equal(held.err, "", held.err);
      assert.equal(held.out, "true", "Undo ran (not committed yet)");
      const comment = tracked(
        commentsRoute.POST(routeRequest("POST", `/api/tasks/${race.ids[2]}/comments`, { content: "Too late" }, clientA, userA), params(race.ids[2])).then(reply)
      );
      assert.equal(await untilWaitingOrSettled("%task_comments%", () => comment.settled), "waiting", "the comment insert waits for Undo");
      const link = tracked(linkSession.run(`INSERT INTO note_links (user_id, note_id, entity_type, entity_id) VALUES ('${userA}', '${note.id}', 'task', '${race.ids[2]}');`));
      await untilWaitingOrSettled("%note_links%", () => link.settled);
      const committed = await undoSession.run("COMMIT;");
      assert.equal(committed.err, "", committed.err);
      const commentReply = await comment.promise;
      assert.equal(commentReply.status, 404, `the late comment is refused as "Task not found": ${JSON.stringify(commentReply.body)}`);
      const linkReply = await link.promise;
      assert.match(linkReply.err, /no longer exists|foreign key/i, `the late note link is refused: ${JSON.stringify(linkReply)}`);
      assert.equal(psql(`SELECT count(*) FROM task_comments WHERE task_id = '${race.ids[2]}';`), "0");
      assert.equal(psql(`SELECT count(*) FROM note_links WHERE note_id = '${note.id}';`), "0", "no link left naming a deleted step");
      assert.equal(countIn("tasks", "id", race.ids), "0", "Undo itself went through");
    } finally {
      undoSession.close();
      linkSession.close();
    }
    // Ordinary note links are unchanged: an existing task, or a kind the trigger doesn't look at.
    const plain = await insert("tasks", { user_id: userA, title: "Linked normally" }, clientA);
    await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: plain.id }, clientA);
    await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "calendar_event", entity_id: "evt-123" }, clientA);
  });

  await test("FR2 LOW-2: a break refused with section_not_found / section_name_taken leaves the guard setting off, so the same transaction can't forge a step or a break record", async () => {
    const proj = await insert("projects", { user_id: userA, name: `Setting ${randomUUID().slice(0, 6)}`, tags: [] });
    await insert("project_sections", { user_id: userA, project_id: proj.id, name: "Taken name", sort_order: 0 });
    const { umbrella, rows } = await smallUmbrella({ title: "LOW-2", projectId: proj.id });
    const step = `{"checklist_item_id":"${rows[0].id}","expect_done":false,"status":"Planned","owner":"brent","title":"x"}`;
    const cases = {
      section_not_found: `{"kind":"existing_section","project_id":"${proj.id}","section_id":"${randomUUID()}"}`,
      section_name_taken: `{"kind":"new_section","project_id":"${proj.id}","name":"Taken name"}`,
    };
    for (const [reason, destination] of Object.entries(cases)) {
      const out = psql(`BEGIN;
        SET LOCAL ROLE authenticated;
        SELECT set_config('request.jwt.claims', '{"sub":"${userA}","role":"authenticated"}', true) IS NULL;
        SELECT set_config('bit.result', break_task_into_tasks('${userA}', '${umbrella.id}', '{"destination":${destination},"expect_project_id":"${proj.id}","expect_base_priority":50,"steps":[${step}]}'::jsonb) ->> 'reason', true) IS NULL;
        DO $$ BEGIN
          INSERT INTO tasks (user_id, title, parent_task_id) VALUES ('${userA}', 'Forged step', '${umbrella.id}');
          PERFORM set_config('bit.step', 'forged', true);
        EXCEPTION WHEN check_violation THEN PERFORM set_config('bit.step', 'refused', true); END $$;
        DO $$ BEGIN
          INSERT INTO task_breaks (user_id, umbrella_task_id, task_ids, fingerprint) VALUES ('${userA}', '${umbrella.id}', ARRAY['${umbrella.id}']::uuid[], 'x');
          PERFORM set_config('bit.record', 'forged', true);
        EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('bit.record', 'refused', true); END $$;
        SELECT json_build_object('reason', current_setting('bit.result'), 'setting', current_setting('mission_control.break_umbrella_id', true), 'step', current_setting('bit.step'), 'record', current_setting('bit.record'));
        ROLLBACK;`);
      const result = JSON.parse(out.split("\n").filter((line) => line.startsWith("{")).pop());
      assert.equal(result.reason, reason);
      assert.notEqual(result.setting, umbrella.id, `${reason}: the setting is not left on`);
      assert.equal(result.step, "refused", `${reason}: a direct step insert is still refused`);
      assert.equal(result.record, "refused", `${reason}: a forged break record is still refused`);
    }
  });

  // ── Fix round 3 ────────────────────────────────────────────────────────────
  // P2-1: Undo vs a work-session edit/delete. The session RPCs (059) lock the
  // session row, then its task; b37adf6's Undo locked the step (062), then
  // waited for the session row under its fence: A→B→A, Postgres aborted one.
  // Each schedule pauses one side at exactly that point (deterministic), and
  // must finish with no deadlock, Undo refusing (`changed`) and the session
  // write saved.

  const lockArgs = (race) => `'${userA}', ARRAY['${[race.fixture.umbrella.id, ...race.ids].join("','")}']::uuid[], 'all', '{}'::uuid[]`;
  async function sessionOnStep(race, stepIndex = 2) {
    const step = race.ids[stepIndex];
    const project = psql(`SELECT project_id FROM tasks WHERE id = '${step}';`);
    const id = psql(`SELECT work_session_create('${userA}', jsonb_build_object('project_id', '${project}', 'task_id', '${step}', 'session_date', current_date, 'minutes', 30), '{}'::uuid[], false) ->> 'session_id';`);
    assert.match(id, /^[0-9a-f-]{36}$/);
    return { id, step };
  }
  // As postgres: the auth service can't delete a user who still has sessions (059's
  // rollup trigger reads tasks as supabase_auth_admin), so the test removes its own.
  const dropSession = (s) => psql(`DELETE FROM work_sessions WHERE id = '${s.id}';`);
  const sessionOps = {
    update: (s) => `SELECT work_session_update('${userA}', '${s.id}', '{"minutes": 45}'::jsonb) IS NOT NULL;`,
    delete: (s) => `SELECT work_session_delete('${userA}', '${s.id}') IS NOT NULL;`,
  };
  const sessionAfter = { update: "45", delete: "" };

  for (const op of ["update", "delete"]) {
    await test(`FR3 P2-1 (Undo first): Undo holds the step (062), a session ${op} locks its session and waits for the step, then Undo's fence runs → no deadlock; Undo refuses, the ${op} is saved`, async () => {
      const race = await raceFixture();
      const session = await sessionOnStep(race);
      const undoSession = await new Session().signIn(userA);
      const writer = await new Session().signIn(userA);
      try {
        const locked = await undoSession.run(`BEGIN; SELECT cardinality(task_date_cascade_lock(${lockArgs(race)})) > 0;`);
        assert.equal(locked.err, "", locked.err);
        const write = tracked(writer.run(`BEGIN; ${sessionOps[op](session)}`));
        assert.equal(await untilWaitingOrSettled(`%work_session_${op}%`, () => write.settled), "waiting", `the session ${op} waits for the step`);
        const undo = await undoSession.run(`SELECT undo_break_task_into_tasks('${userA}', '${race.fixture.umbrella.id}', '{"break_id":"${race.made.body.break_id}"}'::jsonb)::text;`);
        const undoCommit = await undoSession.run("COMMIT;");
        const written = await write.promise;
        const writeCommit = await writer.run("COMMIT;");
        const errors = [undo.err, undoCommit.err, written.err, writeCommit.err].join(" ");
        assert.doesNotMatch(errors, /deadlock/i, `no deadlock: ${errors}`);
        assert.equal(written.err, "", `the session ${op} goes through: ${written.err}`);
        assert.equal(undo.err, "", undo.err);
        assert.equal(JSON.parse(undo.out).reason, "changed", `Undo refuses: ${undo.out}`);
        assert.equal(psql(`SELECT minutes FROM work_sessions WHERE id = '${session.id}';`), sessionAfter[op]);
        assert.equal(countIn("tasks", "id", race.ids), "6", "no step deleted");
      } finally {
        undoSession.close();
        writer.close();
        dropSession(session);
      }
    });

    await test(`FR3 P2-1 (session first): a session ${op} holds its session row, Undo runs (the real route), then the ${op} locks the step → no deadlock; Undo refuses, the ${op} is saved`, async () => {
      const race = await raceFixture();
      const session = await sessionOnStep(race);
      const writer = await new Session().signIn(userA);
      try {
        const held = await writer.run(`BEGIN; SELECT id FROM work_sessions WHERE id = '${session.id}' FOR UPDATE;`);
        assert.equal(held.err, "", held.err);
        assert.equal(held.out, session.id);
        const undo = tracked(breakTask(race.fixture.umbrella.id, undoOf(race.made)));
        await untilWaitingOrSettled("%undo_break_task_into_tasks%", () => undo.settled);
        const write = tracked(writer.run(sessionOps[op](session)));
        const undone = await undo.promise;
        const written = await write.promise;
        const writeCommit = await writer.run("COMMIT;");
        assert.doesNotMatch(`${written.err} ${writeCommit.err} ${JSON.stringify(undone.body)}`, /deadlock/i);
        assert.equal(written.err, "", `the session ${op} goes through: ${written.err}`);
        assert.equal(undone.status, 409, `Undo refuses (not a 500): ${JSON.stringify(undone.body)}`);
        assert.equal(psql(`SELECT minutes FROM work_sessions WHERE id = '${session.id}';`), sessionAfter[op]);
        assert.equal(countIn("tasks", "id", race.ids), "6", "no step deleted");
      } finally {
        writer.close();
        dropSession(session);
      }
    });
  }

  await test("FR3 P2-1 sweep: a note link to one step being re-pointed at another step (link row locked first) while Undo runs → no deadlock; Undo refuses, the link moves", async () => {
    const race = await raceFixture();
    const note = await insert("notes", { user_id: userA, title: "Retarget note", note_type: "working_note" }, clientA);
    const link = await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: race.ids[0] }, clientA);
    const writer = await new Session().signIn(userA);
    try {
      const held = await writer.run(`BEGIN; SELECT id FROM note_links WHERE id = '${link.id}' FOR UPDATE;`);
      assert.equal(held.err, "", held.err);
      const undo = tracked(breakTask(race.fixture.umbrella.id, undoOf(race.made)));
      await untilWaitingOrSettled("%undo_break_task_into_tasks%", () => undo.settled);
      const write = tracked(writer.run(`UPDATE note_links SET entity_id = '${race.ids[1]}' WHERE id = '${link.id}';`));
      const undone = await undo.promise;
      const written = await write.promise;
      const writeCommit = await writer.run("COMMIT;");
      assert.doesNotMatch(`${written.err} ${writeCommit.err} ${JSON.stringify(undone.body)}`, /deadlock/i);
      assert.equal(written.err, "", written.err);
      assert.equal(undone.status, 409, JSON.stringify(undone.body));
      assert.equal(psql(`SELECT entity_id FROM note_links WHERE id = '${link.id}';`), race.ids[1]);
      assert.equal(countIn("tasks", "id", race.ids), "6");
    } finally {
      writer.close();
    }
  });

  await test("FR3 control: a step edit queued behind Undo's task locks is not a reason to refuse; Undo goes through and the late edit finds nothing", async () => {
    const race = await raceFixture();
    const undoSession = await new Session().signIn(userA);
    const writer = await new Session().signIn(userA);
    try {
      const locked = await undoSession.run(`BEGIN; SELECT cardinality(task_date_cascade_lock(${lockArgs(race)})) > 0;`);
      assert.equal(locked.err, "", locked.err);
      const write = tracked(writer.run(`UPDATE tasks SET title = 'Late edit' WHERE id = '${race.ids[0]}' RETURNING id;`));
      assert.equal(await untilWaitingOrSettled("%Late edit%", () => write.settled), "waiting");
      const undo = await undoSession.run(`SELECT undo_break_task_into_tasks('${userA}', '${race.fixture.umbrella.id}', '{"break_id":"${race.made.body.break_id}"}'::jsonb)::text;`);
      assert.equal(undo.err, "", undo.err);
      assert.equal(JSON.parse(undo.out).ok, true, `Undo goes through: ${undo.out}`);
      assert.equal((await undoSession.run("COMMIT;")).err, "");
      const written = await write.promise;
      assert.equal(written.err, "", written.err);
      assert.equal(written.out, "", "the late edit updated nothing");
      assert.equal(countIn("tasks", "id", race.ids), "0");
    } finally {
      undoSession.close();
      writer.close();
    }
  });

  // P2-2: a note link may name a step in any spelling Postgres reads as that
  // uuid (uppercase, braces, no hyphens). b37adf6 compared the stored text to
  // the lowercase id, so Undo didn't see the link: it deleted the step and left
  // the link pointing at nothing.
  const spellings = (id) => ({
    uppercase: id.toUpperCase(),
    braces: `{${id}}`,
    "no hyphens, uppercase": id.replace(/-/g, "").toUpperCase(),
  });

  await test("FR3 P2-2: note_link_target_uuid reads exactly the spellings Postgres's uuid cast reads (and NULL for the rest)", () => {
    const id = randomUUID();
    const inputs = [id, ...Object.values(spellings(id)), `{${id}`, `${id}}`, ` ${id}`, `${id} `, `${id.slice(0, 4)}-${id.slice(4)}`, id.replace(/-/g, "").replace(/(.{4})/g, "$1-").replace(/-$/, ""), `${id}-`, "evt-123", "", "not-a-uuid", id.slice(0, 35)];
    const values = inputs.map((v) => `('${v.replace(/'/g, "''")}')`).join(", ");
    const out = psql(`DO $$
      DECLARE r RECORD; v_cast UUID;
      BEGIN
        FOR r IN SELECT x FROM (VALUES ${values}) AS t(x) LOOP
          BEGIN v_cast := r.x::uuid; EXCEPTION WHEN invalid_text_representation THEN v_cast := NULL; END;
          IF public.note_link_target_uuid(r.x) IS DISTINCT FROM v_cast THEN
            RAISE EXCEPTION 'mismatch for %: helper %, cast %', r.x, public.note_link_target_uuid(r.x), v_cast;
          END IF;
        END LOOP;
      END $$; SELECT 'agree';`);
    assert.equal(out, "agree");
  });

  for (const [name, spell] of Object.entries(spellings(randomUUID())).map(([k]) => [k, (id) => spellings(id)[k]])) {
    await test(`FR3 P2-2 (sequential): a note link naming a step as ${name} → Undo refuses; the step and the link stay`, async () => {
      const race = await raceFixture();
      const note = await insert("notes", { user_id: userA, title: `Spelling ${name}`, note_type: "working_note" }, clientA);
      await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: spell(race.ids[1]) }, clientA);
      const undone = await breakTask(race.fixture.umbrella.id, undoOf(race.made));
      assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
      assert.equal(countIn("tasks", "id", race.ids), "6");
      assert.equal(psql(`SELECT count(*) FROM note_links WHERE note_id = '${note.id}';`), "1");
    });

    await test(`FR3 P2-2 (overlap): a note link naming a step as ${name}, still in flight when Undo starts → Undo refuses; the step and the link stay`, async () => {
      const race = await raceFixture();
      const note = await insert("notes", { user_id: userA, title: `Spelling ${name} open`, note_type: "working_note" }, clientA);
      const { undone } = await undoAgainstOpenWrite(race, `INSERT INTO note_links (user_id, note_id, entity_type, entity_id) VALUES ('${userA}', '${note.id}', 'task', '${spell(race.ids[1])}');`);
      assert.equal(undone.status, 409, `Undo must refuse: ${JSON.stringify(undone.body)}`);
      assert.equal(countIn("tasks", "id", race.ids), "6");
      assert.equal(psql(`SELECT count(*) FROM note_links WHERE note_id = '${note.id}';`), "1");
    });
  }

  await test("FR3 P2-2: a created project named in uppercase by a note link → Undo refuses; a link to a gone task in any spelling is refused", async () => {
    const fixture = await mockupFixture({ project: false });
    const made = await breakTask(fixture.umbrella.id, stepsBody(fixture.rows, { kind: "new_project", name: `Spelling project ${randomUUID().slice(0, 6)}` }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const note = await insert("notes", { user_id: userA, title: "Project spelling", note_type: "working_note" }, clientA);
    await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "project", entity_id: made.body.project_id.toUpperCase() }, clientA);
    const undone = await breakTask(fixture.umbrella.id, undoOf(made));
    assert.equal(undone.status, 409, JSON.stringify(undone.body));
    assert.equal(psql(`SELECT count(*) FROM projects WHERE id = '${made.body.project_id}';`), "1");
    const gone = randomUUID();
    for (const spelled of Object.values(spellings(gone))) {
      const { error } = await clientA.from("note_links").insert({ user_id: userA, note_id: note.id, entity_type: "task", entity_id: spelled });
      assert.ok(error, `a link to a missing task (${spelled}) is refused`);
    }
  });

  await test("FR3 P2-2 (app): linking a note to a task or project by an uppercase / braced id stores the canonical lowercase id; unlinking by the same spelling still works", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Canonical link target" }, clientA);
    const fixtureProjectId = (await insert("projects", { user_id: userA, name: `Canonical ${randomUUID().slice(0, 6)}`, tags: [] }, clientA)).id;
    const note = await insert("notes", { user_id: userA, title: "Canonical note", note_type: "working_note" }, clientA);
    const upper = await notesLib.linkNoteToEntity(clientA, userA, note.id, { entity_type: "task", entity_id: task.id.toUpperCase(), link_role: "reference" });
    assert.equal(upper.entity_id, task.id);
    const braced = await notesLib.linkNoteToEntity(clientA, userA, note.id, { entity_type: "project", entity_id: `{${fixtureProjectId.toUpperCase()}}`, link_role: "reference" });
    assert.equal(braced.entity_id, fixtureProjectId);
    assert.equal(psql(`SELECT string_agg(entity_id, ',' ORDER BY entity_type) FROM note_links WHERE note_id = '${note.id}';`), `${fixtureProjectId},${task.id}`);
    const listed = await notesLib.listNotesForEntity(clientA, userA, "task", task.id.toUpperCase());
    assert.deepEqual(listed.map((n) => n.id), [note.id], "listing by another spelling finds it");
    assert.deepEqual(await notesLib.unlinkNoteFromEntity(clientA, userA, note.id, { entity_type: "task", entity_id: task.id.toUpperCase(), link_role: "reference" }), { removed: true });
    // An older row stored with an uppercase id (before this fix) can still be unlinked by that spelling.
    await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: task.id.toUpperCase(), link_role: "reference" }, clientA);
    assert.deepEqual(await notesLib.unlinkNoteFromEntity(clientA, userA, note.id, { entity_type: "task", entity_id: task.id.toUpperCase(), link_role: "reference" }), { removed: true });
    // linkTaskToNote's related_task entity link uses the canonical id too.
    await notesLib.linkTaskToNote(clientA, userA, note.id, { task_id: task.id.toUpperCase() });
    assert.equal(psql(`SELECT entity_id FROM note_links WHERE note_id = '${note.id}' AND link_role = 'related_task';`), task.id);
  });

  await test("FR2: rollback with break records, steps and note links present keeps every task; re-applying 066 makes break + Undo work again", async () => {
    const race = await raceFixture();
    const note = await insert("notes", { user_id: userA, title: "Kept note", note_type: "working_note" }, clientA);
    await insert("note_links", { user_id: userA, note_id: note.id, entity_type: "task", entity_id: race.ids[0] }, clientA);
    assert.ok(Number(psql(`SELECT count(*) FROM task_breaks;`)) >= 1, "break records exist");
    const tasksBefore = psql(`SELECT count(*) FROM tasks WHERE user_id = '${userA}';`);
    psql(ROLLBACK);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE user_id = '${userA}';`), tasksBefore, "every task stays");
    assert.equal(psql(`SELECT count(*) FROM note_links WHERE note_id = '${note.id}';`), "1", "note links stay");
    assert.equal(psql(`SELECT to_regclass('public.task_breaks') IS NULL;`), "t");
    await waitForColumn(false);
    psql(MIGRATION);
    await waitForColumn(true);
    await waitForFunction();
    psql(`NOTIFY pgrst, 'reload schema';`);
    await sleep(1500);
    const again = await raceFixture();
    const undone = await breakTask(again.fixture.umbrella.id, undoOf(again.made));
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(undone.body.deleted_tasks, 6);
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
