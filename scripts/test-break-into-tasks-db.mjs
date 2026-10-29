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
import { execFileSync } from "node:child_process";
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
const queries = await import("../src/lib/today/queries.ts");
const bit = await import("../src/lib/break-into-tasks.ts");
const rangeView = await import("../src/lib/task-range-view.ts");
const portfolioQueries = await import("../src/lib/portfolio-queries.ts");
const { getDateOnlyInTimeZone, addDateOnlyDays } = await import("../src/lib/date-only.ts");
const { buildRecurringDueAt } = await import("../src/lib/recurrence.ts");

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
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('break_task_into_tasks', 'undo_break_task_into_tasks', 'tasks_guard_parent_task');`), "0");
    await waitForColumn(false);
    psql(MIGRATION);
    psql(MIGRATION);
    // The test stack grants every function to the API roles; production relies on 066's own grants (checked above).
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('break_task_into_tasks', 'undo_break_task_into_tasks', 'tasks_guard_parent_task');`), "3");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'break_task_into_tasks(uuid,uuid,jsonb)', 'EXECUTE');`), "f");
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
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE name = 'Will roll back';`), "0");
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
    const mine = await insert("tasks", { user_id: userA, title: "Mine" });
    const theirs = await insert("tasks", { user_id: userB, title: "Theirs" });
    assert.match(psqlFails(`INSERT INTO tasks (user_id, title, parent_task_id) VALUES ('${userA}', 'x', '${theirs.id}');`), /same user/);
    const { error: viaApi } = await clientA.from("tasks").insert({ user_id: userA, title: "x", parent_task_id: theirs.id });
    assert.ok(viaApi, "refused through PostgREST too");
    const child = await insert("tasks", { user_id: userA, title: "Child", parent_task_id: mine.id });
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
    const undoBody = {
      action: "undo",
      task_ids: made.body.task_ids,
      section_id: made.body.section_id,
      project_id: null,
      umbrella_comment_id: made.body.umbrella_comment_id,
    };
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
    const undone = await breakTask(fixture.umbrella.id, { action: "undo", task_ids: made.body.task_ids, project_id: made.body.project_id, umbrella_comment_id: made.body.umbrella_comment_id });
    assert.equal(undone.status, 200);
    assert.equal(undone.body.project_deleted, true);
    assert.equal(psql(`SELECT count(*) FROM projects WHERE id = '${made.body.project_id}';`), "0");

    const second = await mockupFixture();
    const made2 = await breakTask(second.umbrella.id, stepsBody(second.rows, { name: "Keep me" }));
    psql(`UPDATE tasks SET parent_task_id = NULL WHERE id = '${made2.body.task_ids[0]}';`);
    const refused = await breakTask(second.umbrella.id, { action: "undo", task_ids: made2.body.task_ids, section_id: made2.body.section_id });
    assert.equal(refused.status, 409);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE id = ANY(ARRAY['${made2.body.task_ids.join("','")}']::uuid[]);`), "6");
    // Another user's Undo can't touch them either.
    const asB = await breakTask(second.umbrella.id, { action: "undo", task_ids: made2.body.task_ids.slice(1) }, clientB, userB);
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
