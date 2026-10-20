// Tests for dependency visibility (cascade S0): blocked_by / blocks on
// GET /api/tasks/{id}, dependency_links on GET /api/projects/{id}, the loop
// check on POST /api/tasks/{id}/dependencies, the create-time
// blocked_by_task_id error, the MCP add/remove tools, and FamCal redaction in
// both directions.
//
// Offline: no database and no network. Route handlers run with an injected
// auth context and an in-memory fake Supabase client; MCP tools run through the
// real /api/mcp handler with a stubbed fetch.
//
//   npm run test:task-dependency-links

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const LEGACY_KEY = "test-legacy-key-aaaaaaaaaaaaaaaa";
const API_USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;
process.env.DEPLOYMENT_ROLE = "main";

// The MCP tools call the HTTP API through fetch; record and answer locally.
const mcpCalls = [];
let mcpResponder = () => new Response(JSON.stringify({ error: "no responder" }), { status: 500 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const call = { url, method: (init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : undefined };
  mcpCalls.push(call);
  return mcpResponder(call);
};

const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const links = await import("../src/lib/task-dependency-links.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const dependenciesRoute = await import("../src/app/api/tasks/[id]/dependencies/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const mcpRoute = await import("../src/app/api/mcp/route.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 6).join("\n    ")}`);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = {
  calendar: id(1), mca: id(2), budget: id(3), release: id(4), // a work chain in PROJECT
  outside: id(5), // work task in another project
  license: id(11), voter: id(12), // personal standalone (FamCal-eligible)
  personalInWork: id(13), // tagged personal but filed under a work project (ineligible)
  workSecret: id(14), // work task that a personal task waits on
  workWaiter: id(15), // work task that waits on a personal task
  otherUsers: id(20),
};
const PROJECT = { id: id(100), name: "OnCore Workflow Testing", stage: "Build", rag: "Green", tags: ["work"], user_id: API_USER_ID, implementation_id: null };
const OTHER_PROJECT = { id: id(101), name: "Other", stage: "Build", rag: "Green", tags: ["work"], user_id: API_USER_ID, implementation_id: null };
const COMMITMENT = { id: id(200), title: "Promise to the sponsor", status: "Open", due_at: "2026-10-28T16:00:00Z", user_id: API_USER_ID };
const WORK_SECRETS = ["Secret work dependency", "Secret waiting work task", T.workSecret, T.workWaiter, "Promise to the sponsor", COMMITMENT.id, "Filed under work", T.personalInWork];

function task(taskId, title, extra = {}) {
  return {
    id: taskId, user_id: API_USER_ID, title, status: "Planned", tags: ["work"], due_at: null, follow_up_at: null,
    project_id: null, implementation_id: null, sprint_id: null, section_id: null, base_priority: 50, priority_score: 50,
    stakeholder_mentions: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra,
  };
}

function seed() {
  return {
    projects: [PROJECT, OTHER_PROJECT].map((p) => ({ ...p })),
    commitments: [{ ...COMMITMENT }],
    tasks: [
      task(T.calendar, "Calendar build", { project_id: PROJECT.id, due_at: "2026-10-20T21:00:00Z" }),
      task(T.mca, "MCA review", { project_id: PROJECT.id, due_at: "2026-10-22T21:00:00Z" }),
      task(T.budget, "Budget", { project_id: PROJECT.id, due_at: "2026-10-23T21:00:00Z", status: "Done" }),
      task(T.release, "Release", { project_id: PROJECT.id, due_at: null }),
      task(T.outside, "Outside task", { project_id: OTHER_PROJECT.id }),
      task(T.license, "MA driver's license transfer", { tags: ["personal"], due_at: "2026-10-20T21:00:00Z" }),
      task(T.voter, "Voter registration", { tags: ["personal"], due_at: "2026-10-22T21:00:00Z" }),
      task(T.personalInWork, "Filed under work", { tags: ["personal"], project_id: OTHER_PROJECT.id, due_at: "2026-10-21T21:00:00Z" }),
      task(T.workSecret, "Secret work dependency", { status: "In Progress", due_at: "2026-10-19T21:00:00Z" }),
      task(T.workWaiter, "Secret waiting work task", { due_at: "2026-10-30T21:00:00Z" }),
      task(T.otherUsers, "Someone else's task", { user_id: OTHER_USER_ID }),
    ],
    task_dependencies: [
      // chain: mca waits on calendar; budget waits on mca; release waits on budget; outside waits on release
      dep("d1", T.mca, T.calendar),
      dep("d2", T.budget, T.mca),
      dep("d3", T.release, T.budget),
      dep("d4", T.outside, T.release),
      dep("d-resolved", T.release, T.calendar, { is_resolved: true, resolved_at: "2026-10-02T00:00:00Z" }),
      dep("d-commit", T.calendar, null, { depends_on_commitment_id: COMMITMENT.id }),
      // personal: voter waits on license (both eligible); license waits on a work task;
      // a work task waits on license; license waits on a personal task filed under work.
      dep("p1", T.voter, T.license),
      dep("p2", T.license, T.workSecret),
      dep("p3", T.workWaiter, T.license),
      dep("p4", T.license, T.personalInWork),
      dep("p5", T.license, null, { depends_on_commitment_id: COMMITMENT.id }),
    ],
    task_comments: [],
    task_status_transitions: [],
  };
}

function dep(depId, taskId, dependsOnTaskId, extra = {}) {
  return {
    id: depId, user_id: API_USER_ID, task_id: taskId, depends_on_task_id: dependsOnTaskId, depends_on_commitment_id: null,
    is_resolved: false, resolved_at: null, created_at: "2026-10-01T00:00:00Z", ...extra,
  };
}

// ── Fake Supabase (generic, in-memory) ────────────────────────────────────
// failInsert: { table, error } makes that table's insert fail once.
// failDelete: { table, error } makes that table's delete fail.
// rowCap: like PostgREST's max_rows (scripts/test-stack config: 1000), no read
//   returns more rows than this, whatever range it asks for.
// countMode: "exact" answers select(..., { count: "exact" }); "none" never
//   returns a count.
// unordered: the server ignores order() and gt() (a pager must notice that it
//   can't prove it read everything).
// hook({ table, ops, state }): runs after each query's result is fixed, to
//   model an edit landing between two queries.
function makeDb({ failInsert = null, failDelete = null, rowCap = 1000, countMode = "exact", unordered = false, hook = null, state: given = null } = {}) {
  const state = given ?? seed();
  const log = [];
  const projectById = () => new Map(state.projects.map((p) => [p.id, p]));
  const famcalEligible = (row) => {
    if (!(row.tags || []).includes("personal") || row.sprint_id) return false;
    if (!row.project_id) return !row.implementation_id && !row.section_id;
    const project = projectById().get(row.project_id);
    return Boolean(project && project.user_id === row.user_id && project.tags.includes("personal"));
  };
  const value = (table, row, column) => (table === "tasks" && column === "famcal_eligible" ? famcalEligible(row) : row[column]);

  function run(table, ops) {
    const op = (name) => ops.find(([n]) => n === name);
    const mode = op("single") ? "single" : op("maybeSingle") ? "maybeSingle" : "many";
    const selectOptions = op("select")?.[1][1] ?? {};
    const wantsCount = selectOptions.count === "exact" && countMode === "exact";
    let matchedCount = null;
    const finish = (rows, error = null) => {
      if (error) return { data: null, error };
      const count = wantsCount ? (matchedCount ?? rows.length) : null;
      if (selectOptions.head) return { data: null, error: null, count: matchedCount ?? rows.length };
      if (mode === "many") return { data: rows, error: null, count };
      if (rows.length === 0) {
        return mode === "single" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
      }
      if (rows.length > 1 && mode !== "many") return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: rows[0], error: null };
    };
    const rowsOf = () => (state[table] ||= []);
    const matches = (row) => ops.every(([name, args]) => {
      if (name === "eq") return value(table, row, args[0]) === args[1];
      if (name === "neq") return value(table, row, args[0]) !== args[1];
      if (name === "in") return args[1].includes(value(table, row, args[0]));
      if (name === "is") return value(table, row, args[0]) === args[1];
      if (name === "gt") return unordered || String(value(table, row, args[0])) > String(args[1]);
      if (name === "not" && args[1] === "is") return value(table, row, args[0]) !== args[2];
      if (name === "contains") return args[1].every((tag) => (value(table, row, args[0]) || []).includes(tag));
      return true;
    });
    const withRelations = (row) => {
      if (table !== "tasks") return { ...row };
      const project = row.project_id ? projectById().get(row.project_id) ?? null : null;
      return { ...row, project: project ? { id: project.id, name: project.name, stage: project.stage, rag: project.rag, tags: project.tags } : null, implementation: null, sprint: null, section: null };
    };

    const insert = op("insert")?.[1][0];
    if (insert) {
      if (failInsert && failInsert.table === table) {
        const error = failInsert.error;
        failInsert = null;
        return finish([], error);
      }
      const rows = (Array.isArray(insert) ? insert : [insert]).map((row, index) => ({
        id: row.id ?? `${table}-new-${rowsOf().length + index + 1}`,
        created_at: "2026-10-19T12:00:00Z",
        ...(table === "task_dependencies" ? { is_resolved: false, resolved_at: null } : {}),
        ...row,
      }));
      rowsOf().push(...rows);
      return finish(rows.map(withRelations));
    }
    if (op("delete")) {
      if (failDelete && failDelete.table === table) return finish([], failDelete.error);
      const doomed = rowsOf().filter(matches);
      state[table] = rowsOf().filter((row) => !doomed.includes(row));
      return finish(doomed);
    }
    const update = op("update")?.[1][0];
    if (update) {
      const hit = rowsOf().filter(matches);
      for (const row of hit) Object.assign(row, update);
      return finish(hit.map(withRelations));
    }
    // Like the real server: a very long id list makes the URL too long (seen
    // on the local stack with 1,000 UUIDs in one in() filter).
    if (ops.some(([name, args]) => name === "in" && args[1].length > 500)) {
      return finish([], { message: "URI too long" });
    }
    let rows = rowsOf().filter(matches);
    matchedCount = rows.length;
    for (const [name, args] of ops) {
      if (name !== "order" || unordered) continue;
      const [column, options = {}] = args;
      const dir = options.ascending === false ? -1 : 1;
      const key = (row) => String(row[column] ?? "");
      rows = [...rows].sort((a, b) => dir * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    }
    const range = op("range")?.[1];
    if (range) rows = rows.slice(range[0], range[1] + 1);
    const limit = op("limit")?.[1][0];
    if (typeof limit === "number") rows = rows.slice(0, limit);
    if (mode === "many") rows = rows.slice(0, rowCap);
    return finish(rows.map(withRelations));
  }

  const client = {
    async rpc(name) {
      log.push({ table: `rpc:${name}`, ops: [] });
      return { data: null, error: { code: "PGRST202", message: "no such function" } };
    },
    from(table) {
      const ops = [];
      log.push({ table, ops });
      const proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            const result = run(table, ops);
            if (hook) hook({ table, ops, state });
            return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          }
          return (...args) => {
            ops.push([prop, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  return { client, state, log };
}

function routeRequest(db, authSource, method, urlPath, body) {
  const request = new NextRequest(`http://localhost${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase: db.client, user: { id: API_USER_ID }, userId: API_USER_ID, authSource });
}
const params = (value) => ({ params: Promise.resolve({ id: value }) });

async function getTask(db, authSource, taskId) {
  const response = await taskRoute.GET(routeRequest(db, authSource, "GET", `/api/tasks/${taskId}`), params(taskId));
  return { status: response.status, body: await response.json() };
}
async function addDependency(db, taskId, body, authSource = "legacy_api_key") {
  const response = await dependenciesRoute.POST(routeRequest(db, authSource, "POST", `/api/tasks/${taskId}/dependencies`, body), params(taskId));
  return { status: response.status, body: await response.json() };
}

// ── 1. Loop check (pure) ───────────────────────────────────────────────────
function loaderFor(edges) {
  const calls = [];
  const loader = async (ids) => {
    calls.push([...ids]);
    return edges.filter(([from]) => ids.includes(from)).map(([from, to]) => ({ task_id: from, depends_on_task_id: to }));
  };
  return { loader, calls };
}

await test("findDependencyPath: direct, transitive, none, self", async () => {
  const { loader } = loaderFor([["B", "A"], ["C", "B"], ["D", "C"], ["X", "Y"]]);
  assert.deepEqual(await links.findDependencyPath("B", "A", loader), ["B", "A"]);
  assert.deepEqual(await links.findDependencyPath("D", "A", loader), ["D", "C", "B", "A"]);
  assert.equal(await links.findDependencyPath("A", "D", loader), null);
  assert.equal(await links.findDependencyPath("X", "A", loader), null);
  assert.deepEqual(await links.findDependencyPath("A", "A", loader), ["A"]);
});

await test("findDependencyPath: an existing loop in the data ends the walk; diamonds visit each task once", async () => {
  const { loader, calls } = loaderFor([["P", "Q"], ["Q", "P"], ["P", "R"], ["R", "S"], ["Q", "S"]]);
  assert.equal(await links.findDependencyPath("P", "Z", loader), null);
  const visited = calls.flat();
  assert.equal(new Set(visited).size, visited.length, "a task was loaded twice");
});

await test("findDependencyPath: refuses past the size limit instead of guessing", async () => {
  const edges = Array.from({ length: 50 }, (_, index) => [`n${index}`, `n${index + 1}`]);
  const { loader } = loaderFor(edges);
  await assert.rejects(() => links.findDependencyPath("n0", "never", loader, 10), links.DependencyGraphTooLargeError);
});

await test("describeDependencyCycle: plain words, counts the tasks in between", () => {
  assert.equal(
    links.describeDependencyCycle({ taskTitle: "Calendar build", dependsOnTitle: "MCA review", path: [T.mca, T.calendar] }),
    'That would make a loop: "MCA review" already waits on "Calendar build". Remove one of those links first.'
  );
  assert.match(links.describeDependencyCycle({ taskTitle: "a", dependsOnTitle: "b", path: ["b", "x", "a"] }), /through 1 other task\./);
  assert.match(links.describeDependencyCycle({ taskTitle: "a", dependsOnTitle: "b", path: ["b", "x", "y", "a"] }), /through 2 other tasks\./);
});

// ── 2. POST /api/tasks/{id}/dependencies (the route the UI and MCP share) ──
await test("add: a task can't wait on itself (400, nothing written)", async () => {
  const db = makeDb();
  const before = db.state.task_dependencies.length;
  const result = await addDependency(db, T.calendar, { depends_on_task_id: T.calendar });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /cannot depend on itself/);
  assert.equal(db.state.task_dependencies.length, before);
});

await test("add: a direct loop is refused (calendar waits on MCA while MCA waits on calendar)", async () => {
  const db = makeDb();
  const before = db.state.task_dependencies.length;
  const result = await addDependency(db, T.calendar, { depends_on_task_id: T.mca });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'That would make a loop: "MCA review" already waits on "Calendar build". Remove one of those links first.');
  assert.deepEqual(result.body.cycle_task_ids, [T.mca, T.calendar]);
  assert.equal(db.state.task_dependencies.length, before);
});

await test("add: a loop through other tasks is refused (calendar waits on outside: outside→release→budget→MCA→calendar)", async () => {
  const db = makeDb();
  const before = db.state.task_dependencies.length;
  const result = await addDependency(db, T.calendar, { depends_on_task_id: T.outside });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /"Outside task" already waits on "Calendar build" through 3 other tasks\./);
  assert.deepEqual(result.body.cycle_task_ids, [T.outside, T.release, T.budget, T.mca, T.calendar]);
  assert.equal(db.state.task_dependencies.length, before);
});

await test("add: a removed (resolved) link doesn't count toward a loop", async () => {
  // d-resolved said release waited on calendar; it was removed. calendar → release
  // is still a loop through the live chain, so use a fresh pair instead:
  const db = makeDb();
  db.state.task_dependencies = [dep("old", T.voter, T.license, { is_resolved: true })];
  const result = await addDependency(db, T.license, { depends_on_task_id: T.voter });
  assert.equal(result.status, 201, JSON.stringify(result.body));
});

await test("add: someone else's links are never followed", async () => {
  const db = makeDb();
  // voter → license → personalInWork exist; personalInWork → calendar exists only
  // for another user. Counting it would make "calendar waits on voter" a loop.
  db.state.task_dependencies.push(dep("foreign", T.personalInWork, T.calendar, { user_id: OTHER_USER_ID }));
  const result = await addDependency(db, T.calendar, { depends_on_task_id: T.voter });
  assert.equal(result.status, 201, JSON.stringify(result.body));
});

await test("add: a normal link is created (201) and get_task then shows it both ways", async () => {
  const db = makeDb();
  const result = await addDependency(db, T.workWaiter, { depends_on_task_id: T.calendar });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.depends_on_task_id, T.calendar);
  const waiting = await getTask(db, "legacy_api_key", T.workWaiter);
  assert.ok(waiting.body.blocked_by.some((link) => link.id === T.calendar && link.dependency_id === result.body.id));
  const prerequisite = await getTask(db, "legacy_api_key", T.calendar);
  assert.ok(prerequisite.body.blocks.some((link) => link.id === T.workWaiter));
});

await test("add: a duplicate is 409, and a duplicate that races past the check (23505) is 409, not 500", async () => {
  const db = makeDb();
  const dup = await addDependency(db, T.mca, { depends_on_task_id: T.calendar });
  assert.equal(dup.status, 409);
  const racing = makeDb({ failInsert: { table: "task_dependencies", error: { code: "23505", message: "duplicate key" } } });
  const raced = await addDependency(racing, T.workWaiter, { depends_on_task_id: T.calendar });
  assert.equal(raced.status, 409);
  assert.match(raced.body.error, /already exists/);
});

await test("add: a commitment link needs no loop check and still works", async () => {
  const db = makeDb();
  const result = await addDependency(db, T.mca, { depends_on_commitment_id: COMMITMENT.id });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.type, "commitment");
});

// ── 3. GET /api/tasks/{id}: blocked_by and blocks ──────────────────────────
await test("get_task shape: blocked_by (tasks + commitments) and blocks, active links only", async () => {
  const db = makeDb();
  const { status, body } = await getTask(db, "legacy_api_key", T.calendar);
  assert.equal(status, 200);
  assert.equal(body.title, "Calendar build");
  assert.deepEqual(body.blocked_by, [
    { dependency_id: "d-commit", type: "commitment", id: COMMITMENT.id, title: COMMITMENT.title, status: "Open", due_at: COMMITMENT.due_at, unresolved: true },
  ]);
  assert.deepEqual(body.blocks, [
    { dependency_id: "d1", id: T.mca, title: "MCA review", status: "Planned", due_at: "2026-10-22T21:00:00Z" },
  ]);
  // The removed link (release used to wait on calendar) is not listed.
  assert.equal(body.blocks.some((link) => link.id === T.release), false);
});

await test("get_task: blocked_by sorts unresolved first, then by due date; a Done prerequisite says unresolved false", async () => {
  const db = makeDb();
  db.state.task_dependencies.push(dep("extra", T.release, T.calendar));
  const { body } = await getTask(db, "legacy_api_key", T.release);
  assert.deepEqual(body.blocked_by.map((link) => [link.id, link.unresolved]), [[T.calendar, true], [T.budget, false]]);
  assert.deepEqual(body.blocks.map((link) => link.id), [T.outside]);
});

await test("get_task: legacy and actions keys and the app session see full titles and ids (unchanged rules)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key", "session"]) {
    const db = makeDb();
    const { body } = await getTask(db, source, T.license);
    const byId = new Map(body.blocked_by.map((link) => [link.id, link]));
    assert.equal(byId.get(T.workSecret)?.title, "Secret work dependency", source);
    assert.equal(byId.get(T.personalInWork)?.title, "Filed under work", source);
    assert.equal(body.blocks.find((link) => link.id === T.workWaiter)?.title, "Secret waiting work task", source);
  }
});

await test("get_task: a task with no links returns empty arrays", async () => {
  const db = makeDb();
  db.state.task_dependencies = [];
  const { body } = await getTask(db, "legacy_api_key", T.calendar);
  assert.deepEqual(body.blocked_by, []);
  assert.deepEqual(body.blocks, []);
});

await test("get_task: queries are scoped to the user", async () => {
  const db = makeDb();
  await getTask(db, "legacy_api_key", T.license);
  for (const entry of db.log.filter((e) => ["task_dependencies", "tasks", "commitments"].includes(e.table))) {
    assert.ok(entry.ops.some(([name, args]) => name === "eq" && args[0] === "user_id" && args[1] === API_USER_ID), `${entry.table} without user_id`);
  }
});

// ── 4. FamCal key: redaction both ways ─────────────────────────────────────
await test("FamCal get_task: a personal task waiting on a work task sees 'Another task', no title, id or date", async () => {
  const db = makeDb();
  const { status, body } = await getTask(db, "famcal_api_key", T.license);
  assert.equal(status, 200);
  const redacted = body.blocked_by.find((link) => link.dependency_id === "p2");
  assert.deepEqual(redacted, { dependency_id: "p2", type: "task", id: null, title: "Another task", status: "Blocked/Waiting", due_at: null, unresolved: true });
  // A personal task filed under work is not FamCal-eligible, so it is hidden too.
  assert.deepEqual(body.blocked_by.find((link) => link.dependency_id === "p4"), { dependency_id: "p4", type: "task", id: null, title: "Another task", status: "Blocked/Waiting", due_at: null, unresolved: true });
  // Commitments are always hidden from FamCal.
  assert.deepEqual(body.blocked_by.find((link) => link.dependency_id === "p5"), { dependency_id: "p5", type: "commitment", id: null, title: "A commitment", status: "Open", due_at: null, unresolved: true });
  const text = JSON.stringify(body);
  for (const secret of WORK_SECRETS) assert.equal(text.includes(secret), false, `leaked ${secret}`);
});

await test("FamCal get_task (reverse direction): a work task waiting on a personal task is left out of blocks entirely", async () => {
  const db = makeDb();
  const { body } = await getTask(db, "famcal_api_key", T.license);
  assert.equal(body.blocks.some((link) => link.dependency_id === "p3"), false);
  assert.equal(body.blocks.some((link) => link.id === null || link.title === "Another task"), false);
  assert.deepEqual(body.blocks.map((link) => link.id), [T.voter]);
});

await test("FamCal get_task: eligible personal tasks on either side keep their id, title, status and due date", async () => {
  const db = makeDb();
  const license = await getTask(db, "famcal_api_key", T.license);
  assert.deepEqual(license.body.blocks.find((link) => link.dependency_id === "p1"), { dependency_id: "p1", id: T.voter, title: "Voter registration", status: "Planned", due_at: "2026-10-22T21:00:00Z" });
  const voter = await getTask(db, "famcal_api_key", T.voter);
  assert.deepEqual(voter.body.blocked_by, [{ dependency_id: "p1", type: "task", id: T.license, title: "MA driver's license transfer", status: "Planned", due_at: "2026-10-20T21:00:00Z", unresolved: true }]);
});

await test("FamCal get_task: a Done work prerequisite reads Done (as the list does), still with no title", async () => {
  const db = makeDb();
  db.state.tasks.find((row) => row.id === T.workSecret).status = "Done";
  const { body } = await getTask(db, "famcal_api_key", T.license);
  const redacted = body.blocked_by.find((link) => link.dependency_id === "p2");
  assert.equal(redacted.status, "Done");
  assert.equal(redacted.unresolved, false);
  assert.equal(redacted.title, "Another task");
});

await test("FamCal get_task: the eligibility check uses the same filters as other FamCal reads (personal tag + famcal_eligible)", async () => {
  const db = makeDb();
  await getTask(db, "famcal_api_key", T.license);
  const eligibilityReads = db.log.filter((entry) => entry.table === "tasks"
    && entry.ops.some(([name, args]) => name === "eq" && args[0] === "famcal_eligible" && args[1] === true)
    && entry.ops.some(([name, args]) => name === "contains" && args[0] === "tags" && args[1].includes("personal"))
    && entry.ops.some(([name, args]) => name === "in" && args[0] === "id"));
  assert.equal(eligibilityReads.length, 1);
  // Fix round 1 (P1-1): the eligibility-filtered read is the one that carries the
  // fields, and no other task read in the FamCal path selects a title or a date.
  const fieldSelect = String(eligibilityReads[0].ops.find(([name]) => name === "select")?.[1][0] ?? "");
  assert.match(fieldSelect, /title/);
  assert.match(fieldSelect, /due_at/);
  const otherTaskReads = db.log.filter((entry) => entry.table === "tasks" && entry !== eligibilityReads[0]
    && entry.ops.some(([name, args]) => name === "in" && args[0] === "id"));
  for (const entry of otherTaskReads) {
    const select = String(entry.ops.find(([name]) => name === "select")?.[1][0] ?? "");
    assert.doesNotMatch(select, /title|due_at|\*/, `unfiltered task read selects ${select}`);
  }
  // FamCal never reads commitment titles.
  for (const entry of db.log.filter((e) => e.table === "commitments")) {
    const select = String(entry.ops.find(([name]) => name === "select")?.[1][0] ?? "");
    assert.equal(select.includes("title"), false, select);
  }
});

await test("FamCal get_task: a work task is still 404 and reads no links", async () => {
  const db = makeDb();
  const { status, body } = await getTask(db, "famcal_api_key", T.workSecret);
  assert.equal(status, 404);
  assert.equal(JSON.stringify(body).includes("Secret"), false);
  assert.equal(db.log.filter((entry) => entry.table === "task_dependencies").length, 0);
});

await test("buildTaskDependencyLinks: placeholders don't carry real due dates into the sort order", () => {
  const out = links.buildTaskDependencyLinks({
    taskId: "t",
    outgoing: [
      { id: "a", task_id: "t", depends_on_task_id: "hidden", depends_on_commitment_id: null },
      { id: "b", task_id: "t", depends_on_task_id: "seen", depends_on_commitment_id: null },
    ],
    incoming: [],
    tasks: [
      { id: "hidden", title: "Hidden", status: "Planned", due_at: "2026-01-01T00:00:00Z" },
      { id: "seen", title: "Seen", status: "Planned", due_at: "2026-12-01T00:00:00Z" },
    ],
    commitments: [],
    famcal: {
      visibleTasks: [{ id: "seen", title: "Seen", status: "Planned", due_at: "2026-12-01T00:00:00Z" }],
      hiddenTaskStatus: new Map([["hidden", "Planned"]]),
    },
  });
  assert.deepEqual(out.blocked_by.map((link) => link.dependency_id), ["b", "a"]);
  // FamCal mode never takes fields from `tasks`, even when a caller passes them.
  assert.equal(out.blocked_by.find((link) => link.dependency_id === "a").title, "Another task");
});

// ── 4b. Fix round 1 (Codex Sol P1-1, P1-2, P2-3) ───────────────────────────
// P1-1: an edit landing between two reads must never put a work title or date
// into the FamCal response. The hook re-tags the work task as personal, with a
// public title and no date, right after the first linked-task read.
async function famcalGetWithEditAfterFirstTaskRead(taskId, targetId) {
  let edited = false;
  const db = makeDb({
    hook: ({ table, ops, state }) => {
      if (edited || table !== "tasks") return;
      if (!ops.some(([name, args]) => name === "in" && args[0] === "id")) return;
      edited = true;
      Object.assign(state.tasks.find((row) => row.id === targetId), { tags: ["personal"], title: "Public personal title", due_at: null });
    },
  });
  const result = await getTask(db, "famcal_api_key", taskId);
  return { db, edited, ...result };
}

await test("P1-1: forward link: a work task re-tagged personal between reads never shows its old work title or date", async () => {
  const { edited, status, body } = await famcalGetWithEditAfterFirstTaskRead(T.license, T.workSecret);
  assert.ok(edited, "precondition: the edit landed between reads");
  assert.equal(status, 200);
  const text = JSON.stringify(body);
  assert.equal(text.includes("Secret work dependency"), false, "old work title leaked");
  assert.equal(text.includes("2026-10-19T21:00:00Z"), false, "old work date leaked");
  const link = body.blocked_by.find((row) => row.dependency_id === "p2");
  // Either the placeholder (read before the edit) or the new public fields; never a mix.
  assert.ok(
    (link.id === null && link.title === "Another task" && link.due_at === null)
      || (link.id === T.workSecret && link.title === "Public personal title" && link.due_at === null),
    JSON.stringify(link)
  );
});

await test("P1-1: reverse link: a work task re-tagged personal between reads never shows its old work title or date", async () => {
  const { edited, body } = await famcalGetWithEditAfterFirstTaskRead(T.license, T.workWaiter);
  assert.ok(edited);
  const text = JSON.stringify(body);
  assert.equal(text.includes("Secret waiting work task"), false);
  assert.equal(text.includes("2026-10-30T21:00:00Z"), false);
});

await test("P1-1 control: with no edit, the next read shows the re-tagged task with its new fields", async () => {
  const db = makeDb();
  Object.assign(db.state.tasks.find((row) => row.id === T.workSecret), { tags: ["personal"], title: "Public personal title", due_at: null });
  const { body } = await getTask(db, "famcal_api_key", T.license);
  assert.equal(body.blocked_by.find((row) => row.dependency_id === "p2").title, "Public personal title");
});

// P1-2: the number of hidden tasks waiting on a personal task must not show.
function reverseCountState(hiddenWaiters) {
  const state = seed();
  const extra = [id(31), id(32)];
  state.tasks.push(task(extra[0], "Hidden waiter one"), task(extra[1], "Hidden waiter two"));
  state.task_dependencies = [
    dep("visible-link", T.voter, T.license),
    ...extra.slice(0, hiddenWaiters).map((waiter, index) => dep(`hidden-${index}`, waiter, T.license)),
  ];
  return state;
}

await test("P1-2: FamCal blocks look the same with 2, 1 or 0 hidden work tasks waiting (no count, no link ids)", async () => {
  const bodies = [];
  for (const hidden of [2, 1, 0]) {
    const db = makeDb({ state: reverseCountState(hidden) });
    const { status, body } = await getTask(db, "famcal_api_key", T.license);
    assert.equal(status, 200);
    bodies.push(body.blocks);
    assert.equal(JSON.stringify(body).includes("hidden-"), false, "hidden link id leaked");
  }
  assert.deepEqual(bodies[0], bodies[2]);
  assert.deepEqual(bodies[1], bodies[2]);
  assert.deepEqual(bodies[2].map((link) => link.id), [T.voter]);
});

await test("P1-2 control: other keys still see every waiting task", async () => {
  const db = makeDb({ state: reverseCountState(2) });
  const { body } = await getTask(db, "legacy_api_key", T.license);
  assert.equal(body.blocks.length, 3);
});

// P2-3: reads past the 1,000-row cap.
function rowCapLoopState() {
  // B waits on 11 middle tasks; those have 1,001 outgoing links between them,
  // and only the last one reaches A. Reading that frontier needs 2 pages.
  const A = id(41), B = id(42);
  const middle = Array.from({ length: 11 }, (_, i) => id(100 + i));
  const leaves = Array.from({ length: 91 }, (_, i) => id(200 + i));
  const state = seed();
  state.tasks.push(task(A, "Task A"), task(B, "Task B"), ...middle.map((m) => task(m, `Middle ${m}`)), ...leaves.map((l) => task(l, `Leaf ${l}`)));
  state.task_dependencies = middle.map((m, i) => dep(`bm-${String(i).padStart(2, "0")}`, B, m));
  for (const [i, m] of middle.entries()) {
    for (const [j, leaf] of leaves.entries()) {
      state.task_dependencies.push(dep(`ml-${String(i).padStart(2, "0")}-${String(j).padStart(2, "0")}`, m, i === 10 && j === 90 ? A : leaf));
    }
  }
  return { state, A, B, middle };
}

await test("P2-3: a loop hidden past the 1,000-row cap is still refused", async () => {
  const { state, A, B, middle } = rowCapLoopState();
  const db = makeDb({ state });
  const before = db.state.task_dependencies.length;
  const result = await addDependency(db, A, { depends_on_task_id: B });
  assert.equal(result.status, 400, JSON.stringify(result.body).slice(0, 300));
  assert.deepEqual(result.body.cycle_task_ids, [B, middle[10], A]);
  assert.equal(db.state.task_dependencies.length, before);
});

await test("P2-3: the same loop is refused when the server caps pages below the page size (cap 100)", async () => {
  const { state, A, B } = rowCapLoopState();
  const db = makeDb({ state, rowCap: 100 });
  const result = await addDependency(db, A, { depends_on_task_id: B });
  assert.equal(result.status, 400);
});

await test("P2-3: if the loop check can't prove it read every link, it refuses the add (never 'no path')", async () => {
  const { state, A, B } = rowCapLoopState();
  const db = makeDb({ state, unordered: true });
  const before = db.state.task_dependencies.length;
  const result = await addDependency(db, A, { depends_on_task_id: B });
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.match(result.body.error, /couldn't read all the links/i);
  assert.equal(db.state.task_dependencies.length, before);
});

await test("P2-3: a link removed between pages can't push the loop's edge out of view (keyset, not offset)", async () => {
  const { state, A, B, middle } = rowCapLoopState();
  let removed = false;
  const db = makeDb({
    state,
    hook: ({ table, ops, state: live }) => {
      // After the first full page of the middle tasks' links, remove a row that page already read.
      if (removed || table !== "task_dependencies") return;
      const frontier = ops.find(([name, args]) => name === "in" && args[0] === "task_id")?.[1][1] ?? [];
      if (!frontier.includes(middle[0])) return;
      removed = true;
      live.task_dependencies = live.task_dependencies.filter((row) => row.id !== "ml-00-00");
    },
  });
  const result = await addDependency(db, A, { depends_on_task_id: B });
  assert.ok(removed, "precondition: a row was removed mid-read");
  assert.equal(result.status, 400, JSON.stringify(result.body).slice(0, 200));
  assert.equal(db.state.task_dependencies.some((row) => row.task_id === A && row.depends_on_task_id === B), false);
});

await test("P2-3: get_project returns all 1,035 links of a 46-task project", async () => {
  const project = id(800);
  const state = seed();
  state.projects.push({ id: project, name: "Big", stage: "Build", rag: "Green", tags: ["work"], user_id: API_USER_ID, implementation_id: null });
  const nodes = Array.from({ length: 46 }, (_, i) => task(id(1000 + i), `Node ${String(i).padStart(2, "0")}`, { project_id: project }));
  state.tasks.push(...nodes);
  state.task_dependencies = [];
  for (let i = 0; i < 46; i++) for (let j = i + 1; j < 46; j++) state.task_dependencies.push(dep(`p-${String(i).padStart(2, "0")}-${String(j).padStart(2, "0")}`, nodes[i].id, nodes[j].id));
  const db = makeDb({ state });
  const response = await projectRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/projects/${project}`), params(project));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dependency_links.length, 1035);
  assert.equal(new Set(body.dependency_links.map((link) => link.dependency_id)).size, 1035);
});

await test("P2-3: get_task returns every one of 1,200 tasks waiting on it", async () => {
  const state = seed();
  const waiters = Array.from({ length: 1200 }, (_, i) => id(5000 + i));
  state.tasks.push(...waiters.map((w) => task(w, `Waiter ${w}`)));
  state.task_dependencies = waiters.map((w, i) => dep(`w-${String(i).padStart(4, "0")}`, w, T.calendar));
  const db = makeDb({ state });
  const { status, body } = await getTask(db, "legacy_api_key", T.calendar);
  assert.equal(status, 200);
  assert.equal(body.blocks.length, 1200);
});

await test("P2-3: a detail read that can't be proven complete is an error, not a short list", async () => {
  const state = seed();
  const waiters = Array.from({ length: 1200 }, (_, i) => id(5000 + i));
  state.tasks.push(...waiters.map((w) => task(w, `Waiter ${w}`)));
  state.task_dependencies = waiters.map((w, i) => dep(`w-${String(i).padStart(4, "0")}`, w, T.calendar));
  const db = makeDb({ state, unordered: true });
  const { status, body } = await getTask(db, "legacy_api_key", T.calendar);
  assert.equal(status, 503, JSON.stringify(body).slice(0, 200));
  assert.equal("blocks" in body, false);
});

await test("P2-3: every paged dependency read keeps the user and active filters and a unique order", async () => {
  const db = makeDb();
  await getTask(db, "legacy_api_key", T.release);
  await projectRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/projects/${PROJECT.id}`), params(PROJECT.id));
  await addDependency(db, T.workWaiter, { depends_on_task_id: T.calendar });
  const reads = db.log.filter((entry) => entry.table === "task_dependencies" && entry.ops.some(([name]) => name === "limit"));
  assert.ok(reads.length >= 4, `only ${reads.length} paged reads`);
  for (const entry of reads) {
    assert.ok(entry.ops.some(([name, args]) => name === "eq" && args[0] === "user_id" && args[1] === API_USER_ID));
    assert.ok(entry.ops.some(([name, args]) => name === "eq" && args[0] === "is_resolved" && args[1] === false));
    assert.ok(entry.ops.some(([name, args]) => name === "order" && args[0] === "id"));
  }
  // Every read on these paths is paged; the only other one is the add route's
  // duplicate check (maybeSingle). The add route's reply no longer re-reads links.
  const unpaged = db.log.filter((entry) => entry.table === "task_dependencies"
    && entry.ops.some(([name]) => name === "select") && !entry.ops.some(([name]) => name === "limit")
    && !entry.ops.some(([name]) => name === "insert") && !entry.ops.some(([name]) => name === "maybeSingle"));
  assert.equal(unpaged.length, 0, `unpaged dependency reads: ${unpaged.map((e) => JSON.stringify(e.ops)).join(" | ")}`);
});

await test("P2-3 sweep: adding a link to a task that already waits on 1,100 tasks replies 201 with the new link", async () => {
  const state = seed();
  const many = Array.from({ length: 1100 }, (_, i) => id(7000 + i));
  state.tasks.push(...many.map((m) => task(m, `Prereq ${m}`)));
  state.task_dependencies = many.map((m, i) => dep(`wide-${String(i).padStart(4, "0")}`, T.workWaiter, m));
  const db = makeDb({ state, failInsert: null });
  const result = await addDependency(db, T.workWaiter, { depends_on_task_id: T.calendar });
  assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 200));
  assert.equal(result.body.depends_on_task_id, T.calendar);
  assert.equal(result.body.title, "Calendar build");
  assert.equal(result.body.unresolved, true);
});

await test("fetchAllPages: keyset pages until an empty page, at any server cap; refuses out-of-order rows and endless reads", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` }));
  const server = (cap) => async (afterId, limit) => ({
    data: rows.filter((row) => afterId === null || row.id > afterId).slice(0, Math.min(limit, cap)), error: null,
  });
  assert.equal((await links.fetchAllPages(server(1000))).length, 2500);
  assert.equal((await links.fetchAllPages(server(70))).length, 2500);
  assert.equal((await links.fetchAllPages(server(1000), 1000)).map((row) => row.id).join(), rows.map((row) => row.id).join());
  const ignoresOrder = async () => ({ data: rows.slice(0, 10), error: null });
  await assert.rejects(() => links.fetchAllPages(ignoresOrder), links.DependencyReadIncompleteError);
  await assert.rejects(() => links.fetchAllPages(server(1), 1000, 5), links.DependencyReadIncompleteError);
  await assert.rejects(
    () => links.fetchAllPages(async () => ({ data: null, error: { code: "XX000", message: "boom" } })),
    (error) => error?.code === "XX000"
  );
});

// ── 5. GET /api/projects/{id}: dependency_links ────────────────────────────
await test("get_project lists every link between two of its tasks (any status), and nothing that leaves the project", async () => {
  const db = makeDb();
  const response = await projectRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/projects/${PROJECT.id}`), params(PROJECT.id));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.dependency_links, [
    { dependency_id: "d3", task_id: T.release, task_title: "Release", depends_on_task_id: T.budget, depends_on_title: "Budget" },
    { dependency_id: "d1", task_id: T.mca, task_title: "MCA review", depends_on_task_id: T.calendar, depends_on_title: "Calendar build" },
    { dependency_id: "d2", task_id: T.budget, task_title: "Budget", depends_on_task_id: T.mca, depends_on_title: "MCA review" },
  ]);
  // d4 (outside → release) crosses the project edge; d-resolved was removed; d-commit is a commitment.
  assert.ok(Array.isArray(body.open_tasks));
});

await test("get_project: a project with no tasks returns an empty list", async () => {
  const db = makeDb();
  db.state.tasks = db.state.tasks.filter((row) => row.project_id !== PROJECT.id);
  const response = await projectRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/projects/${PROJECT.id}`), params(PROJECT.id));
  assert.deepEqual((await response.json()).dependency_links, []);
});

// ── 6. Create-time blocked_by_task_id ──────────────────────────────────────
async function createTask(db, body) {
  const response = await tasksRoute.POST(routeRequest(db, "legacy_api_key", "POST", "/api/tasks", body));
  return { status: response.status, body: await response.json() };
}

await test("create with blocked_by_task_id: the link is saved", async () => {
  const db = makeDb();
  const result = await createTask(db, { title: "Walkthrough", blocked_by_task_id: T.release });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.ok(db.state.task_dependencies.some((row) => row.task_id === result.body.id && row.depends_on_task_id === T.release && !row.is_resolved));
});

await test("create with blocked_by_task_id: a failed link is an error, and the half-made task is removed", async () => {
  const db = makeDb({ failInsert: { table: "task_dependencies", error: { code: "23503", message: "violates foreign key" } } });
  const before = db.state.tasks.length;
  const result = await createTask(db, { title: "Walkthrough", blocked_by_task_id: T.release, initial_comment: "should not be written" });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /could not be linked to blocked_by_task_id, so it was not created/);
  assert.equal(db.state.tasks.length, before, "the new task should be gone");
  assert.equal(db.state.tasks.some((row) => row.title === "Walkthrough"), false);
  assert.equal(db.state.task_comments.length, 0);
});

await test("create with blocked_by_task_id: if removing the task also fails, the error says so and gives its id", async () => {
  const db = makeDb({
    failInsert: { table: "task_dependencies", error: { code: "XX000", message: "boom" } },
    failDelete: { table: "tasks", error: { code: "XX000", message: "boom" } },
  });
  const result = await createTask(db, { title: "Walkthrough", blocked_by_task_id: T.release });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /was created, but it could not be linked/);
  const created = db.state.tasks.find((row) => row.title === "Walkthrough");
  assert.ok(created);
  assert.equal(result.body.task_id, created.id);
});

await test("create with blocked_by_task_id: an unknown blocker is still a 400 and nothing is created", async () => {
  const db = makeDb();
  const before = db.state.tasks.length;
  const result = await createTask(db, { title: "Walkthrough", blocked_by_task_id: id(999) });
  assert.equal(result.status, 400);
  assert.equal(db.state.tasks.length, before);
});

// ── 7. MCP tools ───────────────────────────────────────────────────────────
async function mcpRpc(body) {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mission-control-key": LEGACY_KEY,
      "mcp-session-id": "stateless",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const response = await mcpRoute.POST(request);
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  return JSON.parse(payload);
}

async function callTool(name, args) {
  mcpCalls.length = 0;
  const result = await mcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  if (result.error) throw new Error(JSON.stringify(result.error));
  const text = result.result.content[0].text;
  return { isError: result.result.isError === true, data: JSON.parse(text).data, calls: [...mcpCalls] };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

await mcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dep-test", version: "1" } } });

await test("MCP tools/list: add_task_dependency and remove_task_dependency exist with plain descriptions", async () => {
  const result = await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const byName = new Map(result.result.tools.map((tool) => [tool.name, tool]));
  const add = byName.get("add_task_dependency");
  const remove = byName.get("remove_task_dependency");
  assert.ok(add && remove);
  assert.deepEqual(Object.keys(add.inputSchema.properties).sort(), ["depends_on_commitment_id", "depends_on_task_id", "task_id"]);
  assert.deepEqual(add.inputSchema.required, ["task_id"]);
  assert.deepEqual(Object.keys(remove.inputSchema.properties).sort(), ["dependency_id", "depends_on_task_id", "task_id"]);
  assert.match(add.description, /loop/);
  assert.match(byName.get("get_task").description, /blocked_by/);
  assert.match(byName.get("get_task").description, /blocks/);
  assert.match(byName.get("get_project").description, /dependency_links/);
  for (const tool of [add, remove, byName.get("get_task"), byName.get("get_project")]) {
    assert.doesNotMatch(tool.description, /claude|anthropic/i);
  }
});

await test("MCP add_task_dependency posts to the dependencies route with only the given target", async () => {
  mcpResponder = () => json({ id: "new-dep", type: "task", depends_on_task_id: T.calendar }, 201);
  const result = await callTool("add_task_dependency", { task_id: T.workWaiter, depends_on_task_id: T.calendar });
  assert.equal(result.isError, false);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].method, "POST");
  assert.equal(new URL(result.calls[0].url).pathname, `/api/tasks/${T.workWaiter}/dependencies`);
  assert.deepEqual(result.calls[0].body, { depends_on_task_id: T.calendar });
  assert.equal(result.data.id, "new-dep");
});

await test("MCP add_task_dependency: a refused loop comes back as an error with the route's message", async () => {
  mcpResponder = () => json({ error: 'That would make a loop: "MCA review" already waits on "Calendar build". Remove one of those links first.', cycle_task_ids: [T.mca, T.calendar] }, 400);
  const result = await callTool("add_task_dependency", { task_id: T.calendar, depends_on_task_id: T.mca });
  assert.equal(result.isError, true);
  assert.match(result.data.error, /would make a loop/);
});

await test("MCP remove_task_dependency by dependency_id sends one DELETE", async () => {
  mcpResponder = () => json({ success: true });
  const result = await callTool("remove_task_dependency", { task_id: T.mca, dependency_id: "d1" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.calls.map((call) => [call.method, new URL(call.url).pathname]), [["DELETE", `/api/tasks/${T.mca}/dependencies/d1`]]);
  assert.deepEqual(result.data, { success: true, dependency_id: "d1" });
});

await test("MCP remove_task_dependency by depends_on_task_id looks the link up first", async () => {
  mcpResponder = (call) => (call.method === "GET"
    ? json({ dependencies: [{ id: "d-commit", depends_on_task_id: null }, { id: "d1", depends_on_task_id: T.calendar }] })
    : json({ success: true }));
  const result = await callTool("remove_task_dependency", { task_id: T.mca, depends_on_task_id: T.calendar });
  assert.equal(result.isError, false);
  assert.deepEqual(result.calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["GET", `/api/tasks/${T.mca}/dependencies`],
    ["DELETE", `/api/tasks/${T.mca}/dependencies/d1`],
  ]);
});

await test("MCP remove_task_dependency: no such link, or no target given, is an error and deletes nothing", async () => {
  mcpResponder = () => json({ dependencies: [] });
  const missing = await callTool("remove_task_dependency", { task_id: T.mca, depends_on_task_id: T.budget });
  assert.equal(missing.isError, true);
  assert.equal(missing.calls.some((call) => call.method === "DELETE"), false);
  const empty = await callTool("remove_task_dependency", { task_id: T.mca });
  assert.equal(empty.isError, true);
  assert.equal(empty.calls.length, 0);
});

await test("MCP remove_task_dependency: a 404 from the route is an error", async () => {
  mcpResponder = () => json({ error: "Dependency not found" }, 404);
  const result = await callTool("remove_task_dependency", { task_id: T.mca, dependency_id: "nope" });
  assert.equal(result.isError, true);
});

await test("OAuth MCP path routes the dependency endpoints (GET/POST list, DELETE one)", () => {
  const upstream = fs.readFileSync(path.join(process.cwd(), "src/app/api/mcp-upstream/[...path]/route.ts"), "utf8");
  for (const needle of [
    "import * as taskDependenciesRoute from '@/app/api/tasks/[id]/dependencies/route';",
    "import * as taskDependencyRoute from '@/app/api/tasks/[id]/dependencies/[dep_id]/route';",
    "invokeDynamic(taskDependenciesRoute.GET, requestWithContext, { id: segments[1] })",
    "invokeDynamic(taskDependenciesRoute.POST, requestWithContext, { id: segments[1] })",
    "invokeDynamic(taskDependencyRoute.DELETE, requestWithContext, { id: segments[1], dep_id: segments[3] })",
  ]) {
    assert.ok(upstream.includes(needle), `missing: ${needle}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
