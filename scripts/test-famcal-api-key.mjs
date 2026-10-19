// Tests for the FamCal scoped key (MISSION_CONTROL_FAMCAL_API_KEY, authSource
// `famcal_api_key`): the route allowlist, the forced `personal` tag on the task
// list, the per-task personal guard, the PATCH field/status allowlist, and that
// the legacy and actions keys behave exactly as before.
//
// Offline: no database and no network. Key auth runs through the real
// requireAuthenticatedRoute with a stubbed fetch for the one Supabase auth call;
// the route handlers run with an injected auth context and a fake Supabase client.
//
//   npm run test:famcal-api-key

import assert from "node:assert/strict";

const LEGACY_KEY = "test-legacy-key-aaaaaaaaaaaaaaaa";
const ACTIONS_KEY = "test-actions-key-bbbbbbbbbbbbbbb";
const FAMCAL_KEY = "test-famcal-key-cccccccccccccccc";
const API_USER_ID = "00000000-0000-4000-8000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_ACTIONS_API_KEY = ACTIONS_KEY;
process.env.MISSION_CONTROL_FAMCAL_API_KEY = FAMCAL_KEY;
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;

// The only network call key auth makes is auth.admin.getUserById; answer it locally.
let authFetchCalls = 0;
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes(`/auth/v1/admin/users/${API_USER_ID}`)) {
    authFetchCalls += 1;
    return new Response(
      JSON.stringify({ id: API_USER_ID, aud: "authenticated", role: "authenticated", email: "test@example.test" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  throw new Error(`Unexpected network call in test: ${url}`);
};

const { NextRequest } = await import("next/server");
const famcal = await import("../src/lib/famcal-api-key.ts");
const { buildRecurringInstanceMetadata } = await import("../src/lib/recurrence.ts");
const routeAuth = await import("../src/lib/supabase/route-auth.ts");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const machineKeys = await import("../src/lib/machine-keys.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const recurringRoute = await import("../src/app/api/tasks/generate-recurring/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
const parkRoute = await import("../src/app/api/tasks/park/[id]/route.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.message ?? error).split("\n").join("\n    ")}`);
  }
}

const PERSONAL_ID = "11111111-1111-4111-8111-111111111111";
const WORK_ID = "22222222-2222-4222-8222-222222222222";
const DONE_PERSONAL_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_ID = "44444444-4444-4444-8444-444444444444";
const WORK_DEP_ID = "55555555-5555-4555-8555-555555555555";
// A personal task filed under a WORK application/project/sprint/section (review R3),
// and one under an approved personal project with its section.
const PERSONAL_IN_WORK_ID = "66666666-6666-4666-8666-666666666666";
const PERSONAL_IN_PERSONAL_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const WORK_APP = { id: "a0000000-0000-4000-8000-00000000000a", name: "Confidential Client App", phase: "Build", rag: "Red" };
const WORK_PROJECT = { id: "b0000000-0000-4000-8000-00000000000b", name: "Confidential Work Project", stage: "Build", rag: "Red", tags: ["work"] };
const WORK_SPRINT = { id: "c0000000-0000-4000-8000-00000000000c", name: "Sprint Secret-42", start_date: "2026-10-12", end_date: "2026-10-23", theme: "Secret go-live theme" };
const WORK_SECTION = { id: "d0000000-0000-4000-8000-00000000000d", project_id: WORK_PROJECT.id, name: "Secret cutover section", sort_order: 1, created_at: "2026-10-01T00:00:00Z" };
const PERSONAL_PROJECT = { id: "e0000000-0000-4000-8000-00000000000e", name: "Personal — House admin", stage: "Build", rag: "Green", tags: ["personal"] };
const PERSONAL_SECTION = { id: "f0000000-0000-4000-8000-00000000000f", project_id: PERSONAL_PROJECT.id, name: "Paperwork", sort_order: 1, created_at: "2026-10-01T00:00:00Z" };
// A personal occurrence generated from a WORK recurring template (review N1),
// built with the real recurrence metadata builder.
const PERSONAL_RECURRING_ID = "88888888-8888-4888-8888-888888888888";
const WORK_TEMPLATE_ID = "99999999-9999-4999-8999-999999999999";
const WORK_TEMPLATE_RECURRENCE = { enabled: true, frequency: "weekly", auto_mark_missed: false, day_of_week: 4, day_of_month: null, next_due: "2026-10-22", template_task_id: WORK_TEMPLATE_ID };
const RECURRING_INSTANCE = buildRecurringInstanceMetadata(WORK_TEMPLATE_ID, WORK_TEMPLATE_RECURRENCE, "2026-10-15");
// Round 4 eligibility fixtures (Brent 10/16: only standalone to-dos or tasks in a
// personal project reach FamCal).
const BUILD_PROJECT = { id: "b1000000-0000-4000-8000-0000000000b1", name: "Side build (not tagged personal)", stage: "Build", rag: "Green", tags: ["build"] };
const PERSONAL_APP = { id: "a1000000-0000-4000-8000-0000000000a1", name: "FamCal app", phase: "Build", rag: "Green" };
const PERSONAL_APP_PROJECT = { id: "e1000000-0000-4000-8000-0000000000e1", name: "Personal — FamCal Sunday Brief", stage: "Build", rag: "Green", tags: ["personal", "famcal"] };
const PERSONAL_APP_SECTION = { id: "f1000000-0000-4000-8000-0000000000f1", project_id: PERSONAL_APP_PROJECT.id, name: "S1 show-only", sort_order: 1, created_at: "2026-10-01T00:00:00Z" };
const PERSONAL_IN_BUILD_ID = "a2000000-0000-4000-8000-0000000000a2";
const PERSONAL_APP_NO_PROJECT_ID = "a3000000-0000-4000-8000-0000000000a3";
const PERSONAL_WITH_SPRINT_ID = "a4000000-0000-4000-8000-0000000000a4";
const PERSONAL_IN_APP_PROJECT_ID = "a5000000-0000-4000-8000-0000000000a5";
const INELIGIBLE_IDS = [PERSONAL_IN_WORK_ID, PERSONAL_IN_BUILD_ID, PERSONAL_APP_NO_PROJECT_ID, PERSONAL_WITH_SPRINT_ID];
const WORK_SECRETS = [
  WORK_APP.id, WORK_APP.name, WORK_PROJECT.id, WORK_PROJECT.name, WORK_SPRINT.id, WORK_SPRINT.name,
  WORK_SPRINT.theme, WORK_SECTION.id, WORK_SECTION.name, "inbox-secret-id", "TaskAdvisor", "TA-SECRET-9",
];

// ── Fake Supabase client ───────────────────────────────────────────────────
// untagBeforeWrite: someone removes `personal` from PERSONAL_ID just before the
// write lands (after the guard's read), as in the review's probes C1-C3.
// statusBeforeWrite: someone sets the target task to this status just before the
// UPDATE lands (after the FamCal transition check), as in review R4.
// rpcError: the comment function fails (the real one rolls back: nothing written).
// untagProjectBeforeWrite: someone removes `personal` from PERSONAL_PROJECT just
// before the write lands (round 4: project re-tag between check and write).
function makeDb({ untagBeforeWrite = false, statusBeforeWrite = null, rpcError = null, untagProjectBeforeWrite = false } = {}) {
  const projects = new Map(
    [WORK_PROJECT, PERSONAL_PROJECT, BUILD_PROJECT, PERSONAL_APP_PROJECT].map((project) => [project.id, { ...project, tags: [...project.tags] }])
  );
  // Independent oracle for famcal_eligible (migration 060), read at query time.
  const eligible = (row) => {
    if (!row.tags.includes("personal") || row.sprint_id) return false;
    if (!row.project_id) return !row.implementation_id && !row.section_id;
    const project = projects.get(row.project_id);
    return Boolean(project && project.tags.includes("personal"));
  };
  const withProject = (row) => (row.project_id ? { ...row, project: { ...projects.get(row.project_id) } } : { ...row });
  const tasks = new Map([
    [PERSONAL_ID, { id: PERSONAL_ID, user_id: API_USER_ID, title: "Register to vote", status: "Backlog", tags: ["personal"], base_priority: 50, due_at: null, follow_up_at: null, waiting_on: null, blocked_reason: null, status_line: null, updated_at: "2026-10-01T00:00:00Z", project: null, stakeholder_mentions: [] }],
    [WORK_ID, { id: WORK_ID, user_id: API_USER_ID, title: "Day-job ticket", status: "Planned", tags: ["work"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [DONE_PERSONAL_ID, { id: DONE_PERSONAL_ID, user_id: API_USER_ID, title: "Old errand", status: "Done", tags: ["personal", "finance"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [WORK_DEP_ID, { id: WORK_DEP_ID, user_id: API_USER_ID, title: "Secret work dependency", status: "In Progress", tags: ["work"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [PERSONAL_IN_WORK_ID, {
      id: PERSONAL_IN_WORK_ID, user_id: API_USER_ID, title: "Dentist (filed under work)", status: "Planned", tags: ["personal"], base_priority: 40, due_at: null, stakeholder_mentions: [],
      implementation_id: WORK_APP.id, project_id: WORK_PROJECT.id, sprint_id: WORK_SPRINT.id, section_id: WORK_SECTION.id,
      inbox_item_id: "inbox-secret-id", external_source_system: "TaskAdvisor", external_source_id: "TA-SECRET-9",
      implementation: WORK_APP, project: WORK_PROJECT, sprint: WORK_SPRINT, section: WORK_SECTION,
    }],
    [PERSONAL_IN_PERSONAL_PROJECT_ID, {
      id: PERSONAL_IN_PERSONAL_PROJECT_ID, user_id: API_USER_ID, title: "File the deed", status: "Done", tags: ["personal"], base_priority: 40, due_at: null, stakeholder_mentions: [],
      implementation_id: null, project_id: PERSONAL_PROJECT.id, sprint_id: null, section_id: PERSONAL_SECTION.id,
      implementation: null, project: PERSONAL_PROJECT, sprint: null, section: PERSONAL_SECTION,
    }],
    [PERSONAL_RECURRING_ID, {
      id: PERSONAL_RECURRING_ID, user_id: API_USER_ID, title: "Weekly errand (from a work template)", status: "Backlog", tags: ["personal"], base_priority: 40, stakeholder_mentions: [],
      ...RECURRING_INSTANCE,
    }],
    [PERSONAL_IN_BUILD_ID, {
      id: PERSONAL_IN_BUILD_ID, user_id: API_USER_ID, title: "Build task tagged personal", status: "Planned", tags: ["personal"], base_priority: 40, due_at: "2026-10-27T03:59:00Z", stakeholder_mentions: [],
      implementation_id: null, project_id: BUILD_PROJECT.id, sprint_id: null, section_id: null, implementation: null, project: BUILD_PROJECT, sprint: null, section: null,
    }],
    [PERSONAL_APP_NO_PROJECT_ID, {
      id: PERSONAL_APP_NO_PROJECT_ID, user_id: API_USER_ID, title: "No project, but an application", status: "Backlog", tags: ["personal"], base_priority: 40, stakeholder_mentions: [],
      implementation_id: WORK_APP.id, project_id: null, sprint_id: null, section_id: null, implementation: WORK_APP, project: null, sprint: null, section: null,
    }],
    [PERSONAL_WITH_SPRINT_ID, {
      id: PERSONAL_WITH_SPRINT_ID, user_id: API_USER_ID, title: "Personal project, but in a sprint", status: "Backlog", tags: ["personal"], base_priority: 40, stakeholder_mentions: [],
      implementation_id: null, project_id: PERSONAL_PROJECT.id, sprint_id: WORK_SPRINT.id, section_id: null, implementation: null, project: PERSONAL_PROJECT, sprint: WORK_SPRINT, section: null,
    }],
    [PERSONAL_IN_APP_PROJECT_ID, {
      id: PERSONAL_IN_APP_PROJECT_ID, user_id: API_USER_ID, title: "Wire the to-dos section", status: "Planned", tags: ["personal"], base_priority: 40, stakeholder_mentions: [],
      source_url: "https://example.test/secret-link",
      implementation_id: PERSONAL_APP.id, project_id: PERSONAL_APP_PROJECT.id, sprint_id: null, section_id: PERSONAL_APP_SECTION.id,
      implementation: PERSONAL_APP, project: PERSONAL_APP_PROJECT, sprint: null, section: PERSONAL_APP_SECTION,
    }],
    [WORK_TEMPLATE_ID, {
      id: WORK_TEMPLATE_ID, user_id: API_USER_ID, title: "Work recurring template", status: "Backlog", tags: ["work"], base_priority: 40, due_at: null, stakeholder_mentions: [],
      is_recurring_template: true, recurrence: WORK_TEMPLATE_RECURRENCE,
    }],
  ]);
  const comments = [
    { id: "c1", task_id: PERSONAL_ID, user_id: API_USER_ID, content: "Personal comment", source: "manual", created_at: "2026-10-01T00:00:00Z" },
    { id: "c2", task_id: WORK_ID, user_id: API_USER_ID, content: "Work comment", source: "manual", created_at: "2026-10-01T00:00:00Z" },
  ];
  const dependencies = [
    { id: "d1", task_id: PERSONAL_ID, depends_on_task_id: WORK_DEP_ID, depends_on_commitment_id: null, resolved_at: null, is_resolved: false, created_at: "2026-10-01T00:00:00Z" },
  ];
  const log = [];

  function resolveQuery(table, ops) {
    const op = (name) => ops.find(([n]) => n === name);
    const eqs = ops.filter(([n]) => n === "eq").map(([, args]) => args);
    const eqId = eqs.find(([column]) => column === "id")?.[1];
    const mode = op("single") ? "single" : op("maybeSingle") ? "maybeSingle" : "many";
    const update = op("update")?.[1][0];
    const insert = op("insert")?.[1][0];
    const isDelete = Boolean(op("delete"));

    const finish = (rows) => {
      if (mode === "many") return { data: rows, error: null };
      if (rows.length === 0) {
        return mode === "single"
          ? { data: null, error: { code: "PGRST116", message: "no rows" } }
          : { data: null, error: null };
      }
      return { data: rows[0], error: null };
    };

    if (table === "tasks") {
      if (update) {
        const row = tasks.get(eqId);
        if (!row) return finish([]);
        if (untagBeforeWrite && row.id === PERSONAL_ID) row.tags = ["work"];
        if (untagProjectBeforeWrite) projects.get(PERSONAL_PROJECT.id).tags = ["work"];
        if (statusBeforeWrite) row.status = statusBeforeWrite;
        for (const [, [column, value]] of ops.filter(([n]) => n === "contains")) {
          if (column === "tags" && !value.every((tag) => row.tags.includes(tag))) return finish([]);
        }
        // Every eq filter is part of the UPDATE's WHERE (id, user_id, status, famcal_eligible…).
        for (const [column, value] of eqs) {
          const actual = column === "famcal_eligible" ? eligible(row) : row[column];
          if (actual !== value) return finish([]);
        }
        Object.assign(row, update);
        return finish([withProject(row)]);
      }
      let rows = [...tasks.values()];
      if (eqId) rows = rows.filter((row) => row.id === eqId);
      const inIds = op("in")?.[1];
      if (inIds && inIds[0] === "id") rows = rows.filter((row) => inIds[1].includes(row.id));
      for (const [, [column, value]] of ops.filter(([n]) => n === "contains")) {
        if (column === "tags") rows = rows.filter((row) => value.every((tag) => row.tags.includes(tag)));
      }
      for (const [, [column, value]] of ops.filter(([n]) => n === "neq")) {
        rows = rows.filter((row) => row[column] !== value);
      }
      for (const [column, value] of eqs) {
        if (column === "famcal_eligible") rows = rows.filter((row) => eligible(row) === value);
      }
      // Embedded comments (select 'id, task_comments(...)'): one statement, so the
      // tag filter above and the comment rows come from the same state.
      const selectArg = String(op("select")?.[1][0] ?? "");
      if (selectArg.includes("task_comments(")) {
        const commentUser = eqs.find(([column]) => column === "task_comments.user_id")?.[1];
        return finish(rows.map((row) => ({
          id: row.id,
          task_comments: comments
            .filter((comment) => comment.task_id === row.id && (!commentUser || comment.user_id === commentUser))
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((comment) => ({ ...comment })),
        })));
      }
      return finish(rows.map(withProject));
    }
    if (table === "task_comments") {
      if (isDelete) {
        const commentId = eqs.find(([column]) => column === "id")?.[1];
        const index = comments.findIndex((row) => row.id === commentId);
        return finish(index >= 0 ? comments.splice(index, 1) : []);
      }
      if (insert) {
        if (untagBeforeWrite) tasks.get(PERSONAL_ID).tags = ["work"];
        const row = { id: `c${comments.length + 1}`, created_at: "2026-10-15T00:00:00Z", ...insert };
        comments.push(row);
        return finish([row]);
      }
      const taskId = eqs.find(([column]) => column === "task_id")?.[1];
      return finish(comments.filter((row) => row.task_id === taskId));
    }
    if (table === "project_sections") {
      const sections = [WORK_SECTION, PERSONAL_SECTION, PERSONAL_APP_SECTION].map((section) => ({ ...section, user_id: API_USER_ID }));
      return finish(sections.filter((row) => eqs.every(([column, value]) => row[column] === value)));
    }
    if (table === "task_dependencies") {
      // Keyset paging like PostgREST (cascade S1 pages every dependency read):
      // in() on its column, eq() on the columns these rows carry, gt/order/limit on id.
      const inOp = op("in")?.[1];
      let rows = dependencies.filter((row) => !inOp || inOp[1].includes(row[inOp[0]]));
      for (const [column, value] of eqs) {
        if (column in (rows[0] ?? {})) rows = rows.filter((row) => row[column] === value);
      }
      const gtOp = op("gt")?.[1];
      if (gtOp) rows = rows.filter((row) => String(row[gtOp[0]]) > String(gtOp[1]));
      if (op("order")) rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limit = op("limit")?.[1]?.[0];
      if (typeof limit === "number") rows = rows.slice(0, limit);
      return finish(rows);
    }
    return finish([]);
  }

  const rpcCalls = [];
  const client = {
    // The FamCal comment function (migration 060), modelled as one atomic step:
    // the tag is checked and the comment inserted together, or nothing happens.
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      log.push({ table: `rpc:${name}`, ops: [["rpc", [args]]] });
      if (name !== "famcal_add_personal_task_comment") return { data: null, error: { code: "PGRST202", message: "no such function" } };
      if (untagBeforeWrite && args.p_task_id === PERSONAL_ID) tasks.get(PERSONAL_ID).tags = ["work"];
      if (untagProjectBeforeWrite) projects.get(PERSONAL_PROJECT.id).tags = ["work"];
      if (rpcError) return { data: null, error: rpcError };
      const task = tasks.get(args.p_task_id);
      if (!task || task.user_id !== args.p_user_id || !eligible(task)) return { data: [], error: null };
      const row = { id: `c${comments.length + 1}`, task_id: task.id, user_id: args.p_user_id, content: args.p_content, source: args.p_source, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" };
      comments.push(row);
      return { data: [row], error: null };
    },
    from(table) {
      const ops = [];
      const entry = { table, ops };
      log.push(entry);
      const proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            const result = resolveQuery(table, ops);
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

  return { client, tasks, projects, comments, dependencies, log, rpcCalls };
}

function routeRequest(db, authSource, method, path, body) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, {
    supabase: db.client,
    user: { id: API_USER_ID },
    userId: API_USER_ID,
    authSource,
  });
}

const params = (id) => ({ params: Promise.resolve({ id }) });
const tableOps = (db, table, opName) => db.log.filter((entry) => entry.table === table && entry.ops.some(([n]) => n === opName));

// ── 1. Route allowlist (pure) ──────────────────────────────────────────────
const ALLOWED = [
  ["GET", "/api/tasks"],
  ["GET", `/api/tasks/${PERSONAL_ID}`],
  ["PATCH", `/api/tasks/${PERSONAL_ID}`],
  ["GET", `/api/tasks/${PERSONAL_ID}/comments`],
  ["POST", `/api/tasks/${PERSONAL_ID}/comments`],
  ["POST", `/api/tasks/park/${PERSONAL_ID}`],
];
const DENIED = [
  ["POST", "/api/tasks"],
  ["DELETE", `/api/tasks/${PERSONAL_ID}`],
  ["PATCH", `/api/tasks/${PERSONAL_ID}/comments`],
  ["DELETE", `/api/tasks/${PERSONAL_ID}/comments`],
  ["GET", "/api/tasks/parked"],
  ["GET", "/api/tasks/recurring"],
  ["GET", "/api/tasks/lookup-external"],
  ["POST", "/api/tasks/parse"],
  ["POST", "/api/tasks/generate-recurring"],
  ["GET", `/api/tasks/${PERSONAL_ID}/checklist`],
  ["GET", `/api/tasks/${PERSONAL_ID}/dependencies`],
  ["POST", `/api/tasks/${PERSONAL_ID}/recur`],
  ["POST", "/api/tasks/park/not-a-uuid"],
  ["GET", "/api/tasks/park"],
  ["GET", "/api/notes"],
  ["GET", "/api/projects"],
  ["GET", "/api/briefing/digest"],
  ["GET", "/api/calendar"],
  ["POST", "/api/mcp"],
  ["GET", "/api/focus"],
];

await test("FamCal allowlist: exactly the five personal-task route/method pairs", () => {
  for (const [method, path] of ALLOWED) {
    assert.equal(famcal.isFamcalKeyRouteAllowed(method, path), true, `${method} ${path} should be allowed`);
  }
  for (const [method, path] of DENIED) {
    assert.equal(famcal.isFamcalKeyRouteAllowed(method, path), false, `${method} ${path} should be denied`);
  }
});

// ── 2. Key resolution and the route gate through requireAuthenticatedRoute ──
function keyRequest(key, method, path) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: key ? { "x-mission-control-key": key } : {},
  });
}

await test("FamCal key authenticates on its routes as famcal_api_key (acts as MISSION_CONTROL_USER_ID)", async () => {
  for (const [method, path] of ALLOWED) {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, method, path));
    assert.equal(result.response, null, `${method} ${path}`);
    assert.equal(result.context.authSource, "famcal_api_key");
    assert.equal(result.context.userId, API_USER_ID);
  }
});

await test("FamCal key gets 403 on every other route, before any user lookup", async () => {
  const before = authFetchCalls;
  for (const [method, path] of DENIED) {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, method, path));
    assert.equal(result.context, null, `${method} ${path}`);
    assert.equal(result.response.status, 403, `${method} ${path}`);
    assert.match((await result.response.json()).error, /FamCal API key is not permitted/);
  }
  assert.equal(authFetchCalls, before);
});

await test("FamCal key: path and method tricks are 403 (HEAD, OPTIONS, %2F, //, ;x, encoded ..)", async () => {
  for (const [method, path] of [
    ["HEAD", "/api/tasks"],
    ["OPTIONS", "/api/tasks"],
    ["GET", `/api/tasks/${PERSONAL_ID}%2Fcomments`],
    ["GET", `/api/tasks//${PERSONAL_ID}`],
    ["GET", `/api/tasks/${PERSONAL_ID};x`],
    ["GET", `/api/tasks/${PERSONAL_ID}/comments/%2E%2E/checklist`],
    ["GET", `/api/tasks/${PERSONAL_ID}/comments/../checklist`],
    ["patch", `/api/tasks/${PERSONAL_ID}/comments`],
  ]) {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, method, path));
    assert.equal(result.response?.status, 403, `${method} ${path}`);
  }
});

await test("FamCal key is also refused by the API-key-only guard on non-allowlisted routes", async () => {
  const result = await routeAuth.requireMissionControlApiKeyRoute(keyRequest(FAMCAL_KEY, "GET", "/api/briefing/render"));
  assert.equal(result.response.status, 403);
});

await test("a wrong key is still 401; trailing slash is normalized", async () => {
  const wrong = await routeAuth.requireAuthenticatedRoute(keyRequest("nope", "GET", "/api/tasks"));
  assert.equal(wrong.response.status, 401);
  const slash = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, "GET", "/api/tasks/"));
  assert.equal(slash.context.authSource, "famcal_api_key");
});

await test("legacy key unchanged: every route and method, including DELETE and FamCal-denied routes", async () => {
  for (const [method, path] of [...ALLOWED, ...DENIED, ["DELETE", "/api/notes/abc"]]) {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(LEGACY_KEY, method, path));
    assert.equal(result.response, null, `${method} ${path}`);
    assert.equal(result.context.authSource, "legacy_api_key");
  }
});

// Decisions the actions key made before this change, pinned route by route.
const ACTIONS_EXPECTED = [
  ["GET", "/api/tasks", true],
  ["POST", "/api/tasks", true],
  ["GET", `/api/tasks/${PERSONAL_ID}`, true],
  ["PATCH", `/api/tasks/${PERSONAL_ID}`, true],
  ["DELETE", `/api/tasks/${PERSONAL_ID}`, false],
  ["GET", `/api/tasks/${PERSONAL_ID}/comments`, true],
  ["POST", `/api/tasks/${PERSONAL_ID}/comments`, true],
  ["PATCH", `/api/tasks/${PERSONAL_ID}/comments`, false],
  ["POST", `/api/tasks/park/${PERSONAL_ID}`, false],
  ["GET", "/api/tasks/parked", true],
  ["POST", "/api/tasks/parse", true],
  ["GET", "/api/notes", true],
  ["POST", "/api/notes", true],
  ["PATCH", "/api/notes/abc", true],
  ["DELETE", "/api/notes/abc", false],
  ["GET", "/api/projects", true],
  ["PATCH", "/api/projects/abc", true],
  ["GET", "/api/briefing/digest", true],
  ["GET", "/api/calendar", true],
  ["GET", "/api/focus", true],
  ["POST", "/api/mcp", false],
  ["GET", "/api/briefs", false],
];

await test("actions key unchanged: same allow/deny decisions as before", async () => {
  for (const [method, path, allowed] of ACTIONS_EXPECTED) {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(ACTIONS_KEY, method, path));
    if (allowed) {
      assert.equal(result.response, null, `${method} ${path} should be allowed`);
      assert.equal(result.context.authSource, "actions_api_key");
    } else {
      assert.equal(result.response.status, 403, `${method} ${path} should be 403`);
      assert.match((await result.response.json()).error, /actions API key is not permitted/);
    }
  }
});

await test("FamCal key alone (no legacy/actions key) is enough to configure machine auth", async () => {
  const saved = { legacy: process.env.MISSION_CONTROL_API_KEY, actions: process.env.MISSION_CONTROL_ACTIONS_API_KEY };
  delete process.env.MISSION_CONTROL_API_KEY;
  delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
  try {
    const ok = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, "GET", "/api/tasks"));
    assert.equal(ok.context.authSource, "famcal_api_key");
    const legacyGone = await routeAuth.requireAuthenticatedRoute(keyRequest(LEGACY_KEY, "GET", "/api/tasks"));
    assert.equal(legacyGone.response.status, 401);
  } finally {
    process.env.MISSION_CONTROL_API_KEY = saved.legacy;
    process.env.MISSION_CONTROL_ACTIONS_API_KEY = saved.actions;
  }
});

await test("without MISSION_CONTROL_FAMCAL_API_KEY the FamCal value is just an invalid key (401)", async () => {
  const saved = process.env.MISSION_CONTROL_FAMCAL_API_KEY;
  delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
  try {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(FAMCAL_KEY, "GET", "/api/tasks"));
    assert.equal(result.response.status, 401);
  } finally {
    process.env.MISSION_CONTROL_FAMCAL_API_KEY = saved;
  }
});

// ── 3. List route: forced personal tag ─────────────────────────────────────
await test("GET /api/tasks with the FamCal key returns personal tasks only, even with no tag", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?limit=500&include_done=true"));
  assert.equal(response.status, 200);
  const ids = (await response.json()).map((task) => task.id).sort();
  assert.deepEqual(ids, [PERSONAL_ID, DONE_PERSONAL_ID, PERSONAL_IN_PERSONAL_PROJECT_ID, PERSONAL_RECURRING_ID, PERSONAL_IN_APP_PROJECT_ID].sort());
});

await test("GET /api/tasks?tag=work with the FamCal key still requires personal (returns nothing)", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=work"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  const contains = tableOps(db, "tasks", "contains")[0].ops.find(([n]) => n === "contains")[1];
  assert.deepEqual(contains, ["tags", ["personal", "work"]]);
});

await test("GET /api/tasks?tag=personal (the FamCal contract call) returns personal open tasks with dependency_blocked", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal&limit=500"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.map((task) => task.id), [PERSONAL_ID, PERSONAL_RECURRING_ID, PERSONAL_IN_APP_PROJECT_ID]);
  assert.equal(body[0].dependency_blocked, true);
  assert.equal(body[0].dependencies.length, 1);
  // The fields FamCal S1 reads (baseline-client.ts parseBaselineTask) are all still there.
  for (const field of ["id", "title", "status", "tags", "due_at", "follow_up_at", "waiting_on", "blocked_reason", "dependency_blocked", "status_line", "updated_at", "project"]) {
    assert.ok(field in body[0], field);
  }
});

await test("FamCal key never sees a work task's title, status or id through dependencies", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal"));
  const body = await response.json();
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /Secret work dependency/);
  assert.doesNotMatch(text, /In Progress/);
  assert.equal(text.includes(WORK_DEP_ID), false);
  assert.equal(body[0].dependency_blocked, true);
  const dependency = body[0].dependencies[0];
  assert.deepEqual(
    Object.keys(dependency).sort(),
    ["created_at", "depends_on_commitment_id", "depends_on_task_id", "id", "resolved_at", "status", "task_id", "title", "type", "unresolved"]
  );
  assert.equal(dependency.title, "Another task");
  assert.equal(dependency.status, "Blocked/Waiting");
  assert.equal(dependency.depends_on_task_id, null);
  assert.equal(dependency.unresolved, true);
});

await test("redactDependencyForFamcal: status mirrors unresolved; commitments say 'A commitment' with a commitment status", () => {
  const base = { id: "d", task_id: PERSONAL_ID, type: "commitment", resolved_at: null, created_at: "x" };
  assert.deepEqual(
    famcal.redactDependencyForFamcal({ ...base, depends_on_task_id: null, depends_on_commitment_id: "c-1", title: "Client promise", status: "Dropped", unresolved: true }),
    { ...base, depends_on_task_id: null, depends_on_commitment_id: null, title: "A commitment", status: "Open", unresolved: true }
  );
  assert.equal(
    famcal.redactDependencyForFamcal({ ...base, depends_on_task_id: null, depends_on_commitment_id: "c-1", title: "x", status: "Done", unresolved: false }).status,
    "Done"
  );
  assert.equal(
    famcal.redactDependencyForFamcal({ ...base, type: "task", depends_on_task_id: WORK_DEP_ID, depends_on_commitment_id: null, title: "t", status: "Done", unresolved: false }).status,
    "Done"
  );
});

await test("GET /api/tasks?view=… is refused for the FamCal key (views ignore the tag filter)", async () => {
  for (const view of ["top3", "due_soon", "weekly_board", "waiting_summary", "needs_review_count"]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks?view=${view}`));
    assert.equal(response.status, 400, view);
    assert.equal(db.log.length, 0, `${view} should not query`);
  }
});

await test("list route unchanged for other keys: no forced tag, dependency titles kept", async () => {
  for (const source of ["legacy_api_key", "actions_api_key", "session"]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, source, "GET", "/api/tasks"));
    const body = await response.json();
    assert.deepEqual(body.map((task) => task.id).sort(), [PERSONAL_ID, WORK_ID, WORK_DEP_ID, PERSONAL_IN_WORK_ID, PERSONAL_RECURRING_ID, WORK_TEMPLATE_ID, ...INELIGIBLE_IDS.slice(1), PERSONAL_IN_APP_PROJECT_ID].sort(), source);
    assert.equal(tableOps(db, "tasks", "contains").length, 0, source);
    assert.match(JSON.stringify(body), /Secret work dependency/, source);
  }
});

// ── 4. Per-task personal guard ─────────────────────────────────────────────
await test("GET /api/tasks/{id}: personal 200, work 404, missing 404 (FamCal key)", async () => {
  const db = makeDb();
  assert.equal((await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_ID}`), params(PERSONAL_ID))).status, 200);
  const work = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${WORK_ID}`), params(WORK_ID));
  assert.equal(work.status, 404);
  assert.doesNotMatch(JSON.stringify(await work.json()), /Day-job/);
  assert.equal((await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${MISSING_ID}`), params(MISSING_ID))).status, 404);
});

await test("GET /api/tasks/{id} of a work task is still 200 for the legacy and actions keys", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await taskRoute.GET(routeRequest(db, source, "GET", `/api/tasks/${WORK_ID}`), params(WORK_ID));
    assert.equal(response.status, 200, source);
  }
});

await test("comments GET/POST on a work task are 404 for the FamCal key and touch no comments", async () => {
  const db = makeDb();
  const get = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${WORK_ID}/comments`), params(WORK_ID));
  assert.equal(get.status, 404);
  const post = await commentsRoute.POST(
    routeRequest(db, "famcal_api_key", "POST", `/api/tasks/${WORK_ID}/comments`, { content: "From Sunday brief 10/25: done.", source: "manual" }),
    params(WORK_ID)
  );
  assert.equal(post.status, 404);
  assert.equal(db.log.filter((entry) => entry.table === "task_comments").length, 0);
  assert.equal(db.comments.length, 2);
});

await test("comments GET/POST on a personal task work for the FamCal key", async () => {
  const db = makeDb();
  const get = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_ID}/comments`), params(PERSONAL_ID));
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).map((row) => row.content), ["Personal comment"]);
  const post = await commentsRoute.POST(
    routeRequest(db, "famcal_api_key", "POST", `/api/tasks/${PERSONAL_ID}/comments`, { content: "From Sunday brief 10/25: done.", source: "manual" }),
    params(PERSONAL_ID)
  );
  assert.equal(post.status, 201);
  assert.equal(db.comments.at(-1).content, "From Sunday brief 10/25: done.");
});

await test("comments on a work task still work for the legacy key", async () => {
  const db = makeDb();
  const get = await commentsRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/tasks/${WORK_ID}/comments`), params(WORK_ID));
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).map((row) => row.content), ["Work comment"]);
});

await test("park: personal 200 (Parked), work 404 and unchanged (FamCal key)", async () => {
  const db = makeDb();
  const ok = await parkRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/park/${PERSONAL_ID}`), params(PERSONAL_ID));
  assert.equal(ok.status, 200);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "Parked");
  const work = await parkRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/park/${WORK_ID}`), params(WORK_ID));
  assert.equal(work.status, 404);
  assert.equal(db.tasks.get(WORK_ID).status, "Planned");
});

await test("park of a work task still works for the legacy key", async () => {
  const db = makeDb();
  const response = await parkRoute.POST(routeRequest(db, "legacy_api_key", "POST", `/api/tasks/park/${WORK_ID}`), params(WORK_ID));
  assert.equal(response.status, 200);
  assert.equal(db.tasks.get(WORK_ID).status, "Parked");
});

// ── 5. PATCH field and status allowlist ────────────────────────────────────
async function famcalPatch(db, id, body) {
  const response = await taskRoute.PATCH(routeRequest(db, "famcal_api_key", "PATCH", `/api/tasks/${id}`, body), params(id));
  return { status: response.status, body: await response.json() };
}

await test("PATCH with a field outside status/due_at/follow_up_at is 400 and writes nothing", async () => {
  for (const body of [
    { title: "x" },
    { owner: "brent" },
    { status_line: "x" },
    { tags: ["work"] },
    { waiting_on: "x" },
    { blocked_reason: "other" },
    { project_id: null },
    { status: "Done", title: "x" },
    {},
  ]) {
    const db = makeDb();
    const result = await famcalPatch(db, PERSONAL_ID, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(tableOps(db, "tasks", "update").length, 0, JSON.stringify(body));
  }
});

await test("PATCH status outside the allowlist is 400 (Missed, nonsense)", async () => {
  for (const status of ["Missed", "Deleted", 7, null]) {
    const db = makeDb();
    const result = await famcalPatch(db, PERSONAL_ID, { status });
    assert.equal(result.status, 400, String(status));
    assert.equal(tableOps(db, "tasks", "update").length, 0);
  }
});

await test("PATCH reopen is only an undo: open→open is 400, Done→Backlog is 200", async () => {
  const db = makeDb();
  const sideways = await famcalPatch(db, PERSONAL_ID, { status: "In Progress" });
  assert.equal(sideways.status, 400);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "Backlog");
  const undo = await famcalPatch(db, DONE_PERSONAL_ID, { status: "Backlog" });
  assert.equal(undo.status, 200);
  assert.equal(db.tasks.get(DONE_PERSONAL_ID).status, "Backlog");
});

await test("PATCH Done / due_at / follow_up_at on a personal task is 200", async () => {
  const db = makeDb();
  assert.equal((await famcalPatch(db, PERSONAL_ID, { status: "Done" })).status, 200);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "Done");
  const dated = await famcalPatch(db, DONE_PERSONAL_ID, { due_at: "2026-11-02T04:59:00.000Z", follow_up_at: "2026-10-28T03:59:00.000Z" });
  assert.equal(dated.status, 200);
  assert.equal(db.tasks.get(DONE_PERSONAL_ID).due_at, "2026-11-02T04:59:00.000Z");
  assert.equal(db.tasks.get(DONE_PERSONAL_ID).follow_up_at, "2026-10-28T03:59:00.000Z");
});

await test("PATCH cannot clear a date: due_at/follow_up_at null, empty or non-string is 400", async () => {
  for (const body of [{ due_at: null }, { due_at: "" }, { due_at: "   " }, { follow_up_at: null }, { follow_up_at: "" }, { due_at: {} }, { due_at: 0 }]) {
    const db = makeDb();
    const result = await famcalPatch(db, PERSONAL_ID, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(tableOps(db, "tasks", "update").length, 0, JSON.stringify(body));
  }
});

await test("PATCH with an invalid date is 400 (the route's normal timestamp check still runs)", async () => {
  const db = makeDb();
  const result = await famcalPatch(db, PERSONAL_ID, { due_at: "next tuesday" });
  assert.equal(result.status, 400);
  assert.equal(tableOps(db, "tasks", "update").length, 0);
});

await test("PATCH on a work or missing task is 404 and writes nothing", async () => {
  for (const id of [WORK_ID, MISSING_ID]) {
    const db = makeDb();
    const result = await famcalPatch(db, id, { status: "Done" });
    assert.equal(result.status, 404, id);
    assert.equal(tableOps(db, "tasks", "update").length, 0, id);
  }
  const db = makeDb();
  assert.equal(db.tasks.get(WORK_ID).status, "Planned");
});

await test("PATCH unchanged for the legacy and actions keys: any field, any task", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await taskRoute.PATCH(
      routeRequest(db, source, "PATCH", `/api/tasks/${WORK_ID}`, { title: "Renamed", status: "In Progress" }),
      params(WORK_ID)
    );
    assert.equal(response.status, 200, source);
    assert.equal(db.tasks.get(WORK_ID).title, "Renamed", source);
    assert.equal(db.tasks.get(WORK_ID).status, "In Progress", source);
  }
});

// ── 5b. Write-time guard (tag removed between the guard's read and the write) ──
await test("C1: PATCH after a concurrent untag is 404 and the task is not changed", async () => {
  const db = makeDb({ untagBeforeWrite: true });
  const result = await famcalPatch(db, PERSONAL_ID, { status: "Done" });
  assert.equal(result.status, 404);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "Backlog");
  const update = tableOps(db, "tasks", "update")[0];
  assert.deepEqual(update.ops.find(([n]) => n === "contains")[1], ["tags", ["personal"]]);
});

await test("C2: park after a concurrent untag is 404 and the task is not parked", async () => {
  const db = makeDb({ untagBeforeWrite: true });
  const response = await parkRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/park/${PERSONAL_ID}`), params(PERSONAL_ID));
  assert.equal(response.status, 404);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "Backlog");
});

await test("C3/R1: comment after a concurrent untag is 404 and no comment is ever written", async () => {
  const db = makeDb({ untagBeforeWrite: true });
  const response = await commentsRoute.POST(
    routeRequest(db, "famcal_api_key", "POST", `/api/tasks/${PERSONAL_ID}/comments`, { content: "From Sunday brief 10/25: done." }),
    params(PERSONAL_ID)
  );
  assert.equal(response.status, 404);
  assert.deepEqual(db.comments.map((row) => row.content), ["Personal comment", "Work comment"]);
  // Never written then removed: no insert and no delete on task_comments at all.
  assert.equal(tableOps(db, "task_comments", "insert").length, 0);
  assert.equal(tableOps(db, "task_comments", "delete").length, 0);
});

await test("write-time tag filter is FamCal-only: legacy PATCH/park carry no tag filter", async () => {
  for (const run of [
    (db) => taskRoute.PATCH(routeRequest(db, "legacy_api_key", "PATCH", `/api/tasks/${WORK_ID}`, { status: "Done" }), params(WORK_ID)),
    (db) => parkRoute.POST(routeRequest(db, "legacy_api_key", "POST", `/api/tasks/park/${WORK_ID}`), params(WORK_ID)),
  ]) {
    const db = makeDb();
    assert.equal((await run(db)).status, 200);
    assert.equal(tableOps(db, "tasks", "update")[0].ops.some(([n]) => n === "contains"), false);
  }
});

// ── 5c. Fix round 2 (Codex Astra review R1-R6) ─────────────────────────────
function famcalComment(db, id, body) {
  return commentsRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/${id}/comments`, body), params(id));
}

await test("R1: FamCal comment POST is one RPC (user, task, trimmed content, source); no direct insert or delete", async () => {
  const db = makeDb();
  const response = await famcalComment(db, PERSONAL_ID, { content: "  From Sunday brief 10/25: done.  ", source: "system" });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.content, "From Sunday brief 10/25: done.");
  assert.deepEqual(db.rpcCalls, [{
    name: "famcal_add_personal_task_comment",
    args: { p_user_id: API_USER_ID, p_task_id: PERSONAL_ID, p_content: "From Sunday brief 10/25: done.", p_source: "system" },
  }]);
  assert.equal(db.log.filter((entry) => entry.table === "task_comments").length, 0, "no PostgREST call on task_comments");
  assert.equal(db.log.filter((entry) => entry.table === "tasks").length, 0, "no separate tag check before the write");
});

await test("R1: a failing comment function is a 500 and leaves no comment behind (nothing to clean up)", async () => {
  const db = makeDb({ rpcError: { code: "XX000", message: "synthetic internal error" } });
  const response = await famcalComment(db, PERSONAL_ID, { content: "From Sunday brief: done." });
  assert.equal(response.status, 500);
  assert.deepEqual(db.comments.map((row) => row.content), ["Personal comment", "Work comment"]);
  assert.equal(tableOps(db, "task_comments", "delete").length, 0);
});

// Scope (review L1): this holds for a SQL failure that rolls the function back. If the
// reply is lost AFTER the function committed, the 500 is ambiguous and a retry adds a
// second comment; there is no idempotency token yet (proposed follow-up for S2).
await test("R1: a retry after a SQL failure that rolled back can't duplicate: the failed call wrote nothing, the retry writes one", async () => {
  const failing = makeDb({ rpcError: { code: "08006", message: "connection failure" } });
  assert.equal((await famcalComment(failing, PERSONAL_ID, { content: "Done via brief" })).status, 500);
  const healthy = makeDb();
  healthy.comments.splice(0, healthy.comments.length, ...failing.comments);
  assert.equal((await famcalComment(healthy, PERSONAL_ID, { content: "Done via brief" })).status, 201);
  assert.equal(healthy.comments.filter((row) => row.content === "Done via brief").length, 1);
});

await test("R1: validation still happens before the function (empty/oversized content, bad source → 400, no call)", async () => {
  for (const body of [{ content: "   " }, { content: "x".repeat(5001) }, { content: "ok", source: "robot" }]) {
    const db = makeDb();
    assert.equal((await famcalComment(db, PERSONAL_ID, body)).status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(db.rpcCalls.length, 0);
  }
});

await test("R1: comment POST on a work, missing or other-scope task is 404 via the function (no rows), nothing written", async () => {
  for (const id of [WORK_ID, MISSING_ID]) {
    const db = makeDb();
    assert.equal((await famcalComment(db, id, { content: "x" })).status, 404, id);
    assert.equal(db.comments.length, 2);
  }
});

await test("R1: legacy/actions comment POST unchanged (direct insert, no function call)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await commentsRoute.POST(routeRequest(db, source, "POST", `/api/tasks/${WORK_ID}/comments`, { content: "work note" }), params(WORK_ID));
    assert.equal(response.status, 201, source);
    assert.equal(db.rpcCalls.length, 0, source);
    assert.equal(tableOps(db, "task_comments", "insert").length, 1, source);
  }
});

await test("R2: FamCal comments GET is ONE query: the task (user + personal tag) with its comments embedded", async () => {
  const db = makeDb();
  const response = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_ID}/comments`), params(PERSONAL_ID));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((row) => row.content), ["Personal comment"]);
  assert.equal(db.log.length, 1, "exactly one database call");
  const [entry] = db.log;
  assert.equal(entry.table, "tasks");
  assert.match(String(entry.ops.find(([n]) => n === "select")[1][0]), /task_comments\(/);
  assert.deepEqual(entry.ops.find(([n]) => n === "contains")[1], ["tags", ["personal"]]);
  assert.ok(entry.ops.some(([n, args]) => n === "eq" && args[0] === "user_id" && args[1] === API_USER_ID));
  assert.ok(entry.ops.some(([n, args]) => n === "eq" && args[0] === "task_comments.user_id" && args[1] === API_USER_ID));
});

await test("R2: after `personal` is removed and a work comment is added, GET is 404 and shows no comment", async () => {
  const db = makeDb();
  db.tasks.get(PERSONAL_ID).tags = ["work"];
  db.comments.push({ id: "c9", task_id: PERSONAL_ID, user_id: API_USER_ID, content: "Synthetic work secret", source: "manual", created_at: "2026-10-16T00:00:00Z" });
  const response = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_ID}/comments`), params(PERSONAL_ID));
  assert.equal(response.status, 404);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Synthetic work secret/);
});

await test("R2: a personal task with no comments is 200 [] (distinct from a 404), same body shape as before", async () => {
  const db = makeDb();
  const empty = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${DONE_PERSONAL_ID}/comments`), params(DONE_PERSONAL_ID));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
  const missing = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${MISSING_ID}/comments`), params(MISSING_ID));
  const work = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${WORK_ID}/comments`), params(WORK_ID));
  assert.equal(missing.status, 404);
  assert.equal(work.status, 404);
  assert.deepEqual(await missing.json(), await work.json(), "absent and non-personal look the same");
});

function assertNoWorkRelations(task, label) {
  const text = JSON.stringify(task);
  for (const secret of WORK_SECRETS) {
    assert.equal(text.includes(secret), false, `${label}: leaked ${secret}`);
  }
  for (const key of ["project", "project_id", "implementation", "implementation_id", "sprint", "sprint_id", "section_id", "section_name"]) {
    assert.ok(key in task, `${label}: ${key} key kept (stable shape)`);
    assert.equal(task[key], null, `${label}: ${key} is null`);
  }
  for (const key of ["user_id", "inbox_item_id", "external_source_system", "external_source_id", "recurring_template_id", "latest_instance_id", "last_generated_at", "section"]) {
    assert.equal(key in task, false, `${label}: ${key} not returned`);
  }
}

// Round 4 (Brent 10/16, "Leave it out of the brief"): a personal task that is not
// standalone and not in a personal project is never handed to FamCal at all.
async function notFoundBody(db) {
  const response = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${MISSING_ID}`), params(MISSING_ID));
  return { status: response.status, body: await response.json() };
}

await test("E1: list leaves out every ineligible personal task (work project, build project, app without project, sprint), in the query", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal&limit=500&include_done=true&include_parked=true&include_missed=true"));
  const ids = (await response.json()).map((row) => row.id);
  for (const id of INELIGIBLE_IDS) assert.equal(ids.includes(id), false, id);
  const query = tableOps(db, "tasks", "select")[0];
  assert.ok(query.ops.some(([n, args]) => n === "eq" && args[0] === "famcal_eligible" && args[1] === true), "eligibility is a query filter, so paging counts only eligible tasks");
  assert.ok(ids.includes(PERSONAL_ID) && ids.includes(PERSONAL_IN_APP_PROJECT_ID) && ids.includes(PERSONAL_IN_PERSONAL_PROJECT_ID));
});

await test("E1: the S1 review case: a personal task in a project tagged only `build` is not listed (it can't slip past FamCal's project-tag filter)", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal&limit=500"));
  assert.equal(JSON.stringify(await response.json()).includes("Build task tagged personal"), false);
});

await test("E1: detail, PATCH, park and comments GET/POST are the same 404 as a missing task for every ineligible task; nothing written", async () => {
  for (const id of INELIGIBLE_IDS) {
    const db = makeDb();
    const missing = await notFoundBody(db);
    const before = JSON.stringify([...db.tasks.values()]);
    const results = [
      await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${id}`), params(id)),
      await taskRoute.PATCH(routeRequest(db, "famcal_api_key", "PATCH", `/api/tasks/${id}`, { status: "Done" }), params(id)),
      await taskRoute.PATCH(routeRequest(db, "famcal_api_key", "PATCH", `/api/tasks/${id}`, { follow_up_at: "2026-11-02T04:59:00Z" }), params(id)),
      await parkRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/park/${id}`), params(id)),
      await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${id}/comments`), params(id)),
      await commentsRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/${id}/comments`, { content: "nope" }), params(id)),
    ];
    for (const [index, response] of results.entries()) {
      assert.equal(response.status, missing.status, `${id} #${index}`);
      assert.deepEqual(await response.json(), missing.body, `${id} #${index}: same body as missing`);
    }
    assert.equal(JSON.stringify([...db.tasks.values()]), before, `${id}: no task changed`);
    assert.equal(db.comments.length, 2, `${id}: no comment written`);
  }
});

await test("E1: a task in a personal project that has an application and a section stays eligible (FamCal/Stock & Stir shape); the application is still hidden", async () => {
  const db = makeDb();
  const response = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_IN_APP_PROJECT_ID}`), params(PERSONAL_IN_APP_PROJECT_ID));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project.name, PERSONAL_APP_PROJECT.name);
  assert.equal(body.section_name, PERSONAL_APP_SECTION.name);
  assert.equal(body.implementation, null);
  assert.equal(body.implementation_id, null);
  assert.equal(JSON.stringify(body).includes(PERSONAL_APP.id), false);
  const patch = await famcalPatch(db, PERSONAL_IN_APP_PROJECT_ID, { status: "Done" });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  const comment = await famcalComment(db, PERSONAL_IN_APP_PROJECT_ID, { content: "Done via brief" });
  assert.equal(comment.status, 201);
});

await test("E1: project re-tagged between the check and the write: PATCH, park and comment POST are 404 and write nothing", async () => {
  const patchDb = makeDb({ untagProjectBeforeWrite: true });
  const patch = await famcalPatch(patchDb, PERSONAL_IN_PERSONAL_PROJECT_ID, { status: "Backlog" });
  assert.equal(patch.status, 404, JSON.stringify(patch.body));
  assert.equal(patchDb.tasks.get(PERSONAL_IN_PERSONAL_PROJECT_ID).status, "Done");
  const update = tableOps(patchDb, "tasks", "update")[0];
  assert.ok(update.ops.some(([n, args]) => n === "eq" && args[0] === "famcal_eligible" && args[1] === true), "the UPDATE carries the eligibility filter");
  const parkDb = makeDb({ untagProjectBeforeWrite: true });
  const park = await parkRoute.POST(routeRequest(parkDb, "famcal_api_key", "POST", `/api/tasks/park/${PERSONAL_IN_PERSONAL_PROJECT_ID}`), params(PERSONAL_IN_PERSONAL_PROJECT_ID));
  assert.equal(park.status, 404);
  assert.equal(parkDb.tasks.get(PERSONAL_IN_PERSONAL_PROJECT_ID).status, "Done");
  const commentDb = makeDb({ untagProjectBeforeWrite: true });
  const comment = await famcalComment(commentDb, PERSONAL_IN_PERSONAL_PROJECT_ID, { content: "late" });
  assert.equal(comment.status, 404);
  assert.equal(commentDb.comments.length, 2);
});

await test("E1: isFamcalEligibleRow mirrors the rule (code defence in depth)", () => {
  const db = makeDb();
  for (const row of db.tasks.values()) {
    const withProject = row.project_id ? { ...row, project: db.projects.get(row.project_id) } : row;
    const expected = !INELIGIBLE_IDS.includes(row.id) && row.tags.includes("personal");
    assert.equal(famcal.isFamcalEligibleRow(withProject), expected, row.id);
  }
  assert.equal(famcal.isFamcalEligibleRow({ tags: ["personal"], project_id: "p", project: { id: "other", tags: ["personal"] } }), false, "project mismatch");
  assert.equal(famcal.isFamcalEligibleRow({ tags: ["personal"], section_id: "s" }), false, "section without project");
  assert.equal(famcal.isFamcalEligibleRow(null), false);
});

await test("E1: legacy and actions keys still see ineligible personal tasks (unchanged)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    for (const id of INELIGIBLE_IDS) {
      const response = await taskRoute.GET(routeRequest(db, source, "GET", `/api/tasks/${id}`), params(id));
      assert.equal(response.status, 200, `${source} ${id}`);
    }
    assert.equal(tableOps(db, "tasks", "select").some((entry) => entry.ops.some(([n, args]) => n === "eq" && args[0] === "famcal_eligible")), false, source);
  }
});

await test("R3 (defence in depth): the projection alone still nulls every work relation of a personal-in-work row", () => {
  const db = makeDb();
  assertNoWorkRelations(famcal.projectTaskForFamcal(db.tasks.get(PERSONAL_IN_WORK_ID)), "projection");
});

await test("source_url is not in the FamCal projection (round 4); legacy still returns it", async () => {
  assert.equal(famcal.FAMCAL_TASK_FIELDS.includes("source_url"), false);
  const db = makeDb();
  const famcalBody = await (await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_IN_APP_PROJECT_ID}`), params(PERSONAL_IN_APP_PROJECT_ID))).json();
  assert.equal("source_url" in famcalBody, false);
  assert.equal(JSON.stringify(famcalBody).includes("secret-link"), false);
  const legacyBody = await (await taskRoute.GET(routeRequest(db, "legacy_api_key", "GET", `/api/tasks/${PERSONAL_IN_APP_PROJECT_ID}`), params(PERSONAL_IN_APP_PROJECT_ID))).json();
  assert.equal(legacyBody.source_url, "https://example.test/secret-link");
});

await test("R3: a personal project's approved metadata is kept (project id/name/stage/rag/tags, its section)", async () => {
  const db = makeDb();
  const response = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_IN_PERSONAL_PROJECT_ID}`), params(PERSONAL_IN_PERSONAL_PROJECT_ID));
  const body = await response.json();
  assert.deepEqual(body.project, PERSONAL_PROJECT);
  assert.equal(body.project_id, PERSONAL_PROJECT.id);
  assert.equal(body.section_id, PERSONAL_SECTION.id);
  assert.equal(body.section_name, "Paperwork");
  assert.equal(body.implementation, null);
  assert.equal(body.sprint, null);
});

await test("R3: projection keys are exactly the allowlist plus the relation keys, for every task", () => {
  const expected = [...famcal.FAMCAL_TASK_FIELDS, "recurrence", "project_id", "section_id", "implementation_id", "sprint_id", "project", "implementation", "sprint", "section_name"].sort();
  const db = makeDb();
  for (const row of db.tasks.values()) {
    assert.deepEqual(Object.keys(famcal.projectTaskForFamcal(row)).sort(), expected, row.id);
  }
  // A section that isn't in the kept personal project is dropped too.
  const odd = famcal.projectTaskForFamcal({ id: "x", tags: ["personal"], project: PERSONAL_PROJECT, section: { ...WORK_SECTION }, section_id: WORK_SECTION.id });
  assert.equal(odd.section_name, null);
  assert.equal(odd.section_id, null);
  // Array-shaped relations (PostgREST sometimes) are handled the same way.
  const arrays = famcal.projectTaskForFamcal({ id: "y", tags: ["personal"], project: [WORK_PROJECT], implementation: [WORK_APP], sprint: [WORK_SPRINT] });
  assert.equal(arrays.project, null);
});

await test("R3: legacy and actions keys still get the full relations (unchanged)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await taskRoute.GET(routeRequest(db, source, "GET", `/api/tasks/${PERSONAL_IN_WORK_ID}`), params(PERSONAL_IN_WORK_ID));
    const body = await response.json();
    assert.equal(body.project.name, WORK_PROJECT.name, source);
    assert.equal(body.sprint.theme, WORK_SPRINT.theme, source);
    assert.equal(body.implementation_id, WORK_APP.id, source);
  }
});

await test("R3: work-relation list filters are 400 for the FamCal key (even empty), with no query", async () => {
  for (const query of ["project_id=" + WORK_PROJECT.id, "implementation_id=" + WORK_APP.id, "sprint_id=" + WORK_SPRINT.id, "section_id=" + WORK_SECTION.id, "project_id=", "sprint_id"]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks?tag=personal&${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(db.log.length, 0, query);
  }
});

await test("R4: reopen when the status changed after the check is 409; the other writer's status stands", async () => {
  const db = makeDb({ statusBeforeWrite: "Planned" });
  const result = await famcalPatch(db, DONE_PERSONAL_ID, { status: "Backlog" });
  assert.equal(result.status, 409);
  assert.equal(db.tasks.get(DONE_PERSONAL_ID).status, "Planned");
  const update = tableOps(db, "tasks", "update")[0];
  assert.ok(update.ops.some(([n, args]) => n === "eq" && args[0] === "status" && args[1] === "Done"), "UPDATE carries the expected status");
});

await test("R4: a Done tap after a concurrent status change is 409 too (no write)", async () => {
  const db = makeDb({ statusBeforeWrite: "In Progress" });
  const result = await famcalPatch(db, PERSONAL_ID, { status: "Done" });
  assert.equal(result.status, 409);
  assert.equal(db.tasks.get(PERSONAL_ID).status, "In Progress");
});

await test("R4: status changed AND tag removed meanwhile is 404, not 409 (no hint the task exists)", async () => {
  const db = makeDb({ statusBeforeWrite: "Planned", untagBeforeWrite: true });
  const result = await famcalPatch(db, PERSONAL_ID, { status: "Done" });
  assert.equal(result.status, 404);
});

await test("R4: date-only PATCH has no status predicate; legacy PATCH has none either", async () => {
  const db = makeDb();
  assert.equal((await famcalPatch(db, PERSONAL_ID, { due_at: "2026-11-02T04:59:00Z" })).status, 200);
  assert.equal(tableOps(db, "tasks", "update")[0].ops.some(([n, args]) => n === "eq" && args[0] === "status"), false);
  const legacy = makeDb({ statusBeforeWrite: "Planned" });
  const response = await taskRoute.PATCH(routeRequest(legacy, "legacy_api_key", "PATCH", `/api/tasks/${DONE_PERSONAL_ID}`, { status: "Backlog" }), params(DONE_PERSONAL_ID));
  assert.equal(response.status, 200);
  assert.equal(tableOps(legacy, "tasks", "update")[0].ops.some(([n, args]) => n === "eq" && args[0] === "status"), false);
});

async function withKeys(env, fn) {
  const names = ["MISSION_CONTROL_API_KEY", "MISSION_CONTROL_ACTIONS_API_KEY", "MISSION_CONTROL_FAMCAL_API_KEY"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const errors = [];
  const savedError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    await fn(errors);
  } finally {
    console.error = savedError;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

await test("R5: FamCal key equal to the legacy key fails closed (401 everywhere, clear log, value never logged)", async () => {
  await withKeys({ MISSION_CONTROL_API_KEY: LEGACY_KEY, MISSION_CONTROL_ACTIONS_API_KEY: ACTIONS_KEY, MISSION_CONTROL_FAMCAL_API_KEY: ` ${LEGACY_KEY} ` }, async (errors) => {
    for (const [method, path] of [["GET", "/api/tasks"], ["GET", `/api/tasks/${WORK_ID}`], ["DELETE", `/api/tasks/${WORK_ID}`], ["GET", "/api/notes"]]) {
      const result = await routeAuth.requireAuthenticatedRoute(keyRequest(LEGACY_KEY, method, path));
      assert.equal(result.context, null, `${method} ${path}`);
      assert.equal(result.response.status, 401, `${method} ${path}`);
    }
    const recurring = await recurringRoute.POST(keyRequest(LEGACY_KEY, "POST", "/api/tasks/generate-recurring"));
    assert.equal(recurring.status, 401);
    // The actions key keeps its own value and still works.
    const actions = await routeAuth.requireAuthenticatedRoute(keyRequest(ACTIONS_KEY, "GET", "/api/tasks"));
    assert.equal(actions.context.authSource, "actions_api_key");
    assert.ok(errors.some((line) => /MISSION_CONTROL_FAMCAL_API_KEY has the same value as MISSION_CONTROL_API_KEY/.test(line)), errors.join("\n"));
    assert.equal(errors.some((line) => line.includes(LEGACY_KEY)), false, "the value is never logged");
  });
});

await test("R5: FamCal key equal to the actions key fails closed too; legacy keeps working", async () => {
  await withKeys({ MISSION_CONTROL_API_KEY: LEGACY_KEY, MISSION_CONTROL_ACTIONS_API_KEY: ACTIONS_KEY, MISSION_CONTROL_FAMCAL_API_KEY: ACTIONS_KEY }, async (errors) => {
    const result = await routeAuth.requireAuthenticatedRoute(keyRequest(ACTIONS_KEY, "GET", "/api/tasks"));
    assert.equal(result.response.status, 401);
    const legacy = await routeAuth.requireAuthenticatedRoute(keyRequest(LEGACY_KEY, "DELETE", `/api/tasks/${WORK_ID}`));
    assert.equal(legacy.context.authSource, "legacy_api_key");
    assert.ok(errors.some((line) => /same value as MISSION_CONTROL_ACTIONS_API_KEY/.test(line)));
  });
});

await test("R5: pure resolution: a shared value resolves to nothing; distinct values unchanged", () => {
  assert.equal(routeAuth.resolveMachineKeySource("K", { legacy: "K", actions: "A", famcal: "K" }), null);
  assert.equal(routeAuth.resolveMachineKeySource("K", { legacy: "L", actions: "K", famcal: "K" }), null);
  assert.equal(routeAuth.resolveMachineKeySource("L", { legacy: "L", actions: "K", famcal: "K" }), "legacy_api_key");
  assert.deepEqual(machineKeys.famcalKeyCollisions({ legacy: "K", actions: "K", famcal: "K" }), ["MISSION_CONTROL_API_KEY", "MISSION_CONTROL_ACTIONS_API_KEY"]);
  assert.deepEqual(machineKeys.famcalKeyCollisions({ legacy: "L", actions: "A", famcal: "F" }), []);
  assert.deepEqual(machineKeys.famcalKeyCollisions({ legacy: "L", actions: null, famcal: null }), []);
  assert.equal(machineKeys.isRefusedCollidingMachineKey("L", { legacy: "L", actions: "A", famcal: "F" }), false);
});

await test("R6: `?view=` (empty) and repeated view params are 400 for the FamCal key, with no query", async () => {
  for (const query of ["view=", "view", "view=&view=top3", "tag=personal&view="]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(db.log.length, 0, query);
  }
});

// ── 5d. Fix round 3 (Codex Astra re-check N1, N2) ──────────────────────────
function assertNoTemplateId(task, label) {
  assert.equal(JSON.stringify(task).includes(WORK_TEMPLATE_ID), false, `${label}: leaked the template id`);
  assert.deepEqual(Object.keys(task.recurrence).sort(), [...famcal.FAMCAL_RECURRENCE_FIELDS].sort(), `${label}: recurrence keys`);
  assert.equal("template_task_id" in task.recurrence, false, `${label}: template_task_id`);
  assert.equal("recurring_template_id" in task, false, `${label}: recurring_template_id`);
  // The scheduling facts themselves survive.
  assert.equal(task.recurrence.frequency, "weekly", label);
  assert.equal(task.recurrence.day_of_week, 4, label);
  assert.equal(task.recurrence.next_due, "2026-10-15", label);
  assert.equal(task.recurrence.enabled, false, label);
}

await test("N1: the real recurrence builder does put the template id in recurrence (precondition)", () => {
  assert.equal(RECURRING_INSTANCE.recurrence.template_task_id, WORK_TEMPLATE_ID);
});

await test("N1: list never returns a work template's id inside recurrence", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal&limit=500"));
  const task = (await response.json()).find((row) => row.id === PERSONAL_RECURRING_ID);
  assert.ok(task);
  assertNoTemplateId(task, "list");
});

await test("N1: detail never returns it", async () => {
  const db = makeDb();
  const response = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${PERSONAL_RECURRING_ID}`), params(PERSONAL_RECURRING_ID));
  assert.equal(response.status, 200);
  assertNoTemplateId(await response.json(), "detail");
});

await test("N1: PATCH response never returns it", async () => {
  const db = makeDb();
  const result = await famcalPatch(db, PERSONAL_RECURRING_ID, { follow_up_at: "2026-11-02T04:59:00Z" });
  assert.equal(result.status, 200);
  assertNoTemplateId(result.body, "PATCH");
});

await test("N1: park response never returns it", async () => {
  const db = makeDb();
  const response = await parkRoute.POST(routeRequest(db, "famcal_api_key", "POST", `/api/tasks/park/${PERSONAL_RECURRING_ID}`), params(PERSONAL_RECURRING_ID));
  assert.equal(response.status, 200);
  assertNoTemplateId(await response.json(), "park");
});

await test("N1: recurrence projection: only the six scalar fields, unknown future keys dropped, junk → null", () => {
  const projected = famcal.projectRecurrenceForFamcal({ ...WORK_TEMPLATE_RECURRENCE, future_link_id: "x-secret", nested: { id: "y-secret" } });
  assert.deepEqual(projected, { enabled: true, frequency: "weekly", auto_mark_missed: false, day_of_week: 4, day_of_month: null, next_due: "2026-10-22" });
  assert.equal(famcal.projectRecurrenceForFamcal(null), null);
  assert.equal(famcal.projectRecurrenceForFamcal({ template_task_id: WORK_TEMPLATE_ID }), null);
  assert.equal(famcal.projectRecurrenceForFamcal("weekly"), null);
});

await test("N1: legacy and actions keys still get the full recurrence (unchanged)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await taskRoute.GET(routeRequest(db, source, "GET", `/api/tasks/${PERSONAL_RECURRING_ID}`), params(PERSONAL_RECURRING_ID));
    const body = await response.json();
    assert.equal(body.recurrence.template_task_id, WORK_TEMPLATE_ID, source);
    assert.equal(body.recurring_template_id, WORK_TEMPLATE_ID, source);
  }
});

await test("N2: external-source filters are 400 for the FamCal key (with a value, empty, bare, repeated), with no query", async () => {
  for (const query of [
    "external_source_system=TaskAdvisor",
    "external_source_id=TA-SECRET-9",
    "external_source_system=",
    "external_source_id",
    "external_source_id=A&external_source_id=B",
    "tag=personal&limit=500&external_source_system=TaskAdvisor",
  ]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(db.log.length, 0, query);
  }
});

await test("N2: strict list allowlist: unknown params (scope, include, anything new) and repeated allowed params are 400", async () => {
  for (const query of ["scope=personal", "include=checklist", "search=x", "week_start_date=2026-10-12", "q=", "tag=personal&tag=work", "limit=5&limit=500", "Tag=personal"]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(db.log.length, 0, query);
  }
});

await test("N2: S1's exact call and every allowlisted param are still accepted (200)", async () => {
  assert.deepEqual([...famcal.FAMCAL_LIST_PARAMS].sort(), ["due_soon", "include_done", "include_missed", "include_parked", "limit", "needs_review", "offset", "owner", "status", "tag"]);
  for (const query of [
    "tag=personal&limit=500",
    "",
    "tag=personal&limit=100&offset=0&status=Backlog&owner=brent&needs_review=false&due_soon=false&include_done=true&include_parked=true&include_missed=true",
  ]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks${query ? `?${query}` : ""}`));
    assert.equal(response.status, 200, query);
  }
});

await test("N2: legacy and actions keys keep the external-source filter (unchanged)", async () => {
  for (const source of ["legacy_api_key", "actions_api_key"]) {
    const db = makeDb();
    const response = await tasksRoute.GET(routeRequest(db, source, "GET", "/api/tasks?external_source_system=TaskAdvisor&external_source_id=TA-SECRET-9&scope=work"));
    assert.equal(response.status, 200, source);
    const query = tableOps(db, "tasks", "select")[0];
    assert.ok(query.ops.some(([n, args]) => n === "eq" && args[0] === "external_source_system" && args[1] === "TaskAdvisor"), source);
    assert.ok(query.ops.some(([n, args]) => n === "eq" && args[0] === "external_source_id" && args[1] === "TA-SECRET-9"), source);
  }
});

// ── 5f. Fix round 5 (Codex Sol N3) ─────────────────────────────────────────
await test("N3: a lock or statement timeout in the comment function is 503 busy (not 500), and writes nothing", async () => {
  for (const code of ["55P03", "57014"]) {
    const db = makeDb({ rpcError: { code, message: "timeout" } });
    const response = await famcalComment(db, PERSONAL_ID, { content: "Done via brief" });
    assert.equal(response.status, 503, code);
    assert.match((await response.json()).error, /busy/, code);
    assert.equal(db.comments.length, 2, code);
  }
  assert.deepEqual([...famcal.FAMCAL_BUSY_SQLSTATES].sort(), ["55P03", "57014"]);
});

// ── 6. Pure helpers ────────────────────────────────────────────────────────
await test("pure helpers: list tags, visibility (own tag only), transitions", () => {
  assert.deepEqual(famcal.famcalListRequiredTags(""), ["personal"]);
  assert.deepEqual(famcal.famcalListRequiredTags(null), ["personal"]);
  assert.deepEqual(famcal.famcalListRequiredTags("personal"), ["personal"]);
  assert.deepEqual(famcal.famcalListRequiredTags("finance"), ["personal", "finance"]);
  assert.equal(famcal.isFamcalVisibleTask({ tags: ["personal"] }), true);
  assert.equal(famcal.isFamcalVisibleTask({ tags: ["work"], project: { tags: ["personal"] } }), false);
  assert.equal(famcal.isFamcalVisibleTask({ tags: null }), false);
  assert.equal(famcal.isFamcalVisibleTask(null), false);
  assert.equal(famcal.checkFamcalStatusTransition("Backlog", "Done"), null);
  assert.equal(famcal.checkFamcalStatusTransition("Blocked/Waiting", "Parked"), null);
  assert.equal(famcal.checkFamcalStatusTransition("Parked", "Blocked/Waiting"), null);
  assert.equal(famcal.checkFamcalStatusTransition("Planned", "Planned"), null);
  assert.notEqual(famcal.checkFamcalStatusTransition("Planned", "Backlog"), null);
  assert.notEqual(famcal.checkFamcalStatusTransition("Done", "Missed"), null);
});

await test("resolveMachineKeySource: fixed order, empty keys never match", () => {
  const keys = { legacy: "L", actions: "A", famcal: "F" };
  assert.equal(routeAuth.resolveMachineKeySource("L", keys), "legacy_api_key");
  assert.equal(routeAuth.resolveMachineKeySource("A", keys), "actions_api_key");
  assert.equal(routeAuth.resolveMachineKeySource("F", keys), "famcal_api_key");
  assert.equal(routeAuth.resolveMachineKeySource("X", keys), null);
  assert.equal(routeAuth.resolveMachineKeySource("", { legacy: "", actions: null, famcal: null }), null);
});

// ── Cascade due dates (S1), both directions ────────────────────────────────
await test("S1 cascade, FamCal → work: a FamCal date move never reads a waiting work task's fields, never moves it, reply unchanged", async () => {
  const db = makeDb();
  db.tasks.get(PERSONAL_ID).due_at = "2026-10-20T21:00:00.000Z";
  db.tasks.get(WORK_ID).due_at = "2026-10-22T21:00:00.000Z";
  db.dependencies.push({ id: "d-rev", task_id: WORK_ID, depends_on_task_id: PERSONAL_ID, depends_on_commitment_id: null, resolved_at: null, is_resolved: false, created_at: "2026-10-01T00:00:00Z" });
  const before = await famcalPatch(makeDb(), PERSONAL_ID, { due_at: "2026-10-22T21:00:00.000Z" });
  const result = await famcalPatch(db, PERSONAL_ID, { due_at: "2026-10-22T21:00:00.000Z" });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), Object.keys(before.body).sort());
  assert.equal("cascade" in result.body, false);
  assert.equal(db.tasks.get(WORK_ID).due_at, "2026-10-22T21:00:00.000Z");
  assert.equal(db.rpcCalls.some((call) => call.name === "apply_task_date_cascade"), false);
  // Every read of the waiting task carries the FamCal filter in the same query.
  const reads = db.log.filter((entry) => entry.table === "tasks" && entry.ops.some(([n, args]) => n === "in" && args[1].includes(WORK_ID)));
  assert.ok(reads.length > 0);
  for (const entry of reads) {
    assert.ok(entry.ops.some(([n, args]) => n === "eq" && args[0] === "famcal_eligible" && args[1] === true));
  }
  assert.equal(JSON.stringify(result.body).includes("Day-job ticket"), false);
});

await test("S1 cascade, work → FamCal: moving a work task sends the personal follower's comment in a redacted form that never names the work task", async () => {
  const db = makeDb();
  db.tasks.get(WORK_DEP_ID).due_at = "2026-10-20T21:00:00.000Z";
  db.tasks.get(PERSONAL_ID).due_at = "2026-10-21T21:00:00.000Z";
  const response = await taskRoute.PATCH(
    routeRequest(db, "legacy_api_key", "PATCH", `/api/tasks/${WORK_DEP_ID}`, { due_at: "2026-10-22T21:00:00.000Z" }),
    params(WORK_DEP_ID)
  );
  assert.equal(response.status, 200);
  const call = db.rpcCalls.find((entry) => entry.name === "apply_task_date_cascade");
  assert.ok(call, "the cascade function was called");
  assert.equal(call.args.p_scope, "all");
  assert.deepEqual(call.args.p_moves.map((move) => move.task_id), [PERSONAL_ID]);
  assert.match(call.args.p_moves[0].comment, /Secret work dependency/);
  assert.match(call.args.p_moves[0].comment_redacted, /because a task it depends on slipped 2 working days/);
  assert.equal(call.args.p_moves[0].comment_redacted.includes("Secret work dependency"), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
