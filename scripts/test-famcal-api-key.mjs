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
const routeAuth = await import("../src/lib/supabase/route-auth.ts");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
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

// ── Fake Supabase client ───────────────────────────────────────────────────
function makeDb() {
  const tasks = new Map([
    [PERSONAL_ID, { id: PERSONAL_ID, user_id: API_USER_ID, title: "Register to vote", status: "Backlog", tags: ["personal"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [WORK_ID, { id: WORK_ID, user_id: API_USER_ID, title: "Day-job ticket", status: "Planned", tags: ["work"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [DONE_PERSONAL_ID, { id: DONE_PERSONAL_ID, user_id: API_USER_ID, title: "Old errand", status: "Done", tags: ["personal", "finance"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
    [WORK_DEP_ID, { id: WORK_DEP_ID, user_id: API_USER_ID, title: "Secret work dependency", status: "Planned", tags: ["work"], base_priority: 50, due_at: null, stakeholder_mentions: [] }],
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
        Object.assign(row, update);
        return finish([{ ...row }]);
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
      return finish(rows.map((row) => ({ ...row })));
    }
    if (table === "task_comments") {
      if (insert) {
        const row = { id: `c${comments.length + 1}`, created_at: "2026-10-15T00:00:00Z", ...insert };
        comments.push(row);
        return finish([row]);
      }
      const taskId = eqs.find(([column]) => column === "task_id")?.[1];
      return finish(comments.filter((row) => row.task_id === taskId));
    }
    if (table === "task_dependencies") {
      const inIds = op("in")?.[1]?.[1] ?? [];
      return finish(dependencies.filter((row) => inIds.includes(row.task_id)));
    }
    return finish([]);
  }

  const client = {
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

  return { client, tasks, comments, log };
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
  assert.deepEqual(ids, [PERSONAL_ID, DONE_PERSONAL_ID].sort());
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
  assert.deepEqual(body.map((task) => task.id), [PERSONAL_ID]);
  assert.equal(body[0].dependency_blocked, true);
  assert.equal(body[0].dependencies.length, 1);
});

await test("FamCal key never sees a work task's title through dependencies", async () => {
  const db = makeDb();
  const response = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal"));
  const text = JSON.stringify(await response.json());
  assert.doesNotMatch(text, /Secret work dependency/);
  assert.match(text, /Another task/);
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
    assert.deepEqual(body.map((task) => task.id).sort(), [PERSONAL_ID, WORK_ID, WORK_DEP_ID].sort(), source);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
