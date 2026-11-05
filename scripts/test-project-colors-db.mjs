#!/usr/bin/env node
// Database tests for project colours (migration 069, redesign S2, Baseline task
// b13c2e2d), run against a LOCAL Supabase stack with every migration applied
// (scripts/test-stack):
//
//   set -a; . scripts/test-stack/.env.local; set +a
//   COLORS_TEST_SUPABASE_URL=$STACK_API_URL COLORS_TEST_ANON_KEY=$STACK_ANON_KEY \
//   COLORS_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY COLORS_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:project-colors-db
//
// 1. 069: rollback / re-apply twice each; no existing row changes (a before/after
//    hash of every other column); the CHECK refuses a bad shape (23514), as SQL.
// 2. The real routes (PATCH /api/applications/[id], PATCH /api/projects/[id],
//    POST /api/projects, GET /api/project-colors) save, normalise, refuse and
//    clear a colour on the real database.
// 3. The real MCP tools (update_application, create_project, update_project,
//    get_application, get_project) round-trip a colour through /api/mcp, whose
//    internal fetches go to the route handlers in-process.
// 4. RLS: another user can't colour this user's rows. Before 069 the colour
//    list falls back to defaults instead of failing.
// A throwaway user is created and deleted. 069 is left applied.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.COLORS_TEST_SUPABASE_URL;
const anonKey = process.env.COLORS_TEST_ANON_KEY;
const serviceKey = process.env.COLORS_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.COLORS_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set COLORS_TEST_SUPABASE_URL, COLORS_TEST_ANON_KEY, COLORS_TEST_SERVICE_ROLE_KEY and COLORS_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/069_project_colors.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/069_project_colors.down.sql", import.meta.url), "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}
function psqlError(sql) {
  try {
    psql(sql);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  return null;
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function newUser(prefix) {
  const { data, error } = await admin.auth.admin.createUser({ email: `${prefix}-${randomUUID().slice(0, 8)}@example.test`, password: randomUUID(), email_confirm: true });
  if (error) throw error;
  return data.user.id;
}
const userId = await newUser("colors-test");
const otherId = await newUser("colors-other");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.MISSION_CONTROL_API_KEY = `colors-test-${randomUUID()}`;
process.env.MISSION_CONTROL_USER_ID = userId;
process.env.DEPLOYMENT_ROLE = "main";
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;

const appRoute = await import("../src/app/api/applications/[id]/route.ts");
const appsRoute = await import("../src/app/api/applications/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const projectsRoute = await import("../src/app/api/projects/route.ts");
const colorsRoute = await import("../src/app/api/project-colors/route.ts");
const { loadProjectColorCatalog } = await import("../src/lib/project-colors-queries.ts");
const { NextRequest } = await import("next/server.js");

const headers = { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" };

/** Routes the MCP tools' HTTP calls (and this test's own) to the handlers in-process. */
async function route(method, pathname, body) {
  const request = new NextRequest(`http://localhost${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const app = /^\/api\/applications\/([^/]+)$/.exec(pathname);
  const project = /^\/api\/projects\/([^/?]+)$/.exec(pathname);
  const params = (id) => ({ params: Promise.resolve({ id }) });
  if (pathname === "/api/applications") return method === "POST" ? appsRoute.POST(request) : appsRoute.GET(request);
  if (pathname.startsWith("/api/projects") && !project) return method === "POST" ? projectsRoute.POST(request) : projectsRoute.GET(request);
  if (pathname === "/api/project-colors") return colorsRoute.GET(request);
  if (app) return method === "PATCH" ? appRoute.PATCH(request, params(app[1])) : appRoute.GET(request, params(app[1]));
  if (project) return method === "PATCH" ? projectRoute.PATCH(request, params(project[1])) : projectRoute.GET(request, params(project[1]));
  throw new Error(`test route: unrouted ${method} ${pathname}`);
}
async function api(method, pathname, body) {
  const response = await route(method, pathname, body);
  return { status: response.status, body: await response.json() };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  const isApi = ["mission-control-orpin-chi.vercel.app", "localhost"].includes(target.hostname) && target.pathname.startsWith("/api/");
  if (!isApi) return realFetch(input, init);
  return route(init.method ?? "GET", `${target.pathname}${target.search}`, init.body === undefined ? undefined : JSON.parse(init.body));
};

const { POST: mcpPost } = await import("../src/app/api/mcp/route.ts");
let rpcId = 0;
async function callTool(name, args) {
  rpcId += 1;
  const response = await mcpPost(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY,
        "mcp-session-id": "stateless",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
    })
  );
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "" : text;
  const reply = JSON.parse(payload);
  if (reply.error) return { isError: true, data: reply.error };
  const raw = reply.result.content?.[0]?.text ?? "{}";
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { isError: Boolean(reply.result.isError), data: data?.data ?? data };
}

/** PostgREST reloads its schema cache after 069's NOTIFY; wait until it sees (or stops seeing) the column. */
async function waitForColumn(present) {
  for (let i = 0; i < 50; i += 1) {
    const { error } = await admin.from("projects").select("color").limit(1);
    if (present ? !error : Boolean(error)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`PostgREST never ${present ? "saw" : "dropped"} projects.color`);
}

const rowHash = (table) =>
  psql(`SELECT md5(COALESCE(string_agg((to_jsonb(t) - 'color')::TEXT, '|' ORDER BY t.id), '')) FROM ${table} t WHERE user_id = '${userId}';`);
const colorState = () =>
  psql(`SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '<none>'), ',' ORDER BY table_name) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'color' AND table_name IN ('implementations', 'projects');`);
const checkState = () =>
  psql(`SELECT string_agg(conname || ':' || convalidated || ':' || pg_get_constraintdef(oid), ',' ORDER BY conname) FROM pg_constraint WHERE conname IN ('implementations_color_hex_check', 'projects_color_hex_check');`);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  // Rows that exist before 069 is (re-)applied.
  const seedApp = await admin.from("implementations").insert({ user_id: userId, name: "Baseline" }).select("id").single();
  if (seedApp.error) throw seedApp.error;
  const appId = seedApp.data.id;
  const seedProject = await admin.from("projects").insert({ user_id: userId, name: "Home", tags: ["personal"] }).select("id").single();
  if (seedProject.error) throw seedProject.error;
  const projectId = seedProject.data.id;
  const linked = await admin.from("projects").insert({ user_id: userId, name: "Personal — Baseline Redesign", implementation_id: appId, tags: ["personal"] }).select("id").single();
  if (linked.error) throw linked.error;
  const linkedId = linked.data.id;

  // ── 1. the migration ────────────────────────────────────────────────────
  await test("069 applied: nullable TEXT, no default, both CHECKs validated with the exact pattern", () => {
    assert.equal(colorState(), "implementations.color:text:YES:<none>,projects.color:text:YES:<none>");
    assert.equal(
      checkState(),
      "implementations_color_hex_check:true:CHECK (((color IS NULL) OR (color ~ '^#[0-9A-Fa-f]{6}$'::text))),projects_color_hex_check:true:CHECK (((color IS NULL) OR (color ~ '^#[0-9A-Fa-f]{6}$'::text)))"
    );
  });

  await test("069: rollback twice, re-apply twice; no existing row changes and every row reads NULL", async () => {
    psql(`UPDATE projects SET color = '#3B5BA5' WHERE id = '${projectId}';`);
    psql(ROLLBACK);
    assert.equal(colorState(), "", "both columns gone");
    assert.equal(checkState(), "", "both checks gone");
    psql(ROLLBACK); // twice is fine
    const appsBefore = rowHash("implementations");
    const projectsBefore = rowHash("projects");
    const tasksBefore = psql(`SELECT count(*) FROM tasks WHERE user_id = '${userId}';`);
    psql(MIGRATION);
    psql(MIGRATION); // twice is fine
    assert.equal(rowHash("implementations"), appsBefore, "no application row changed (updated_at included)");
    assert.equal(rowHash("projects"), projectsBefore, "no project row changed (updated_at included)");
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE user_id = '${userId}';`), tasksBefore);
    assert.equal(psql(`SELECT count(*) FROM projects WHERE user_id = '${userId}' AND color IS NOT NULL;`), "0", "the colour set before the rollback is gone; nothing is backfilled");
    assert.equal(psql(`SELECT count(*) FROM implementations WHERE user_id = '${userId}' AND color IS NOT NULL;`), "0");
    assert.equal(colorState(), "implementations.color:text:YES:<none>,projects.color:text:YES:<none>");
    assert.match(checkState(), /implementations_color_hex_check:true:.*projects_color_hex_check:true:/);
    await waitForColumn(true);
  });

  await test("069 CHECK: SQL refuses a bad shape (23514) on both tables; accepts #rrggbb in any case and NULL", () => {
    for (const bad of ["#FFF", "red", "3B5BA5", "#3B5BA5 ", "#12345G", "#3B5BA55", ""]) {
      const appError = psqlError(`UPDATE implementations SET color = '${bad}' WHERE id = '${appId}';`);
      assert.match(appError ?? "", /implementations_color_hex_check/, `app '${bad}'`);
      const projectError = psqlError(`UPDATE projects SET color = '${bad}' WHERE id = '${projectId}';`);
      assert.match(projectError ?? "", /projects_color_hex_check/, `project '${bad}'`);
    }
    psql(`UPDATE projects SET color = '#3b5ba5' WHERE id = '${projectId}'; UPDATE projects SET color = NULL WHERE id = '${projectId}';`);
    // The CHECK only pins the shape (spec); yellow is refused by the API and never painted by the app.
    psql(`UPDATE implementations SET color = '#F2B230' WHERE id = '${appId}'; UPDATE implementations SET color = NULL WHERE id = '${appId}';`);
  });

  // ── 2. the routes ───────────────────────────────────────────────────────
  await test("PATCH /api/applications/[id]: saves upper case, GET shows it, null clears, bad colours are 400 and change nothing", async () => {
    let reply = await api("PATCH", `/api/applications/${appId}`, { color: "#6e4f9c" });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.color, "#6E4F9C");
    assert.equal((await api("GET", `/api/applications/${appId}`)).body.color, "#6E4F9C");
    for (const bad of ["#F2B230", "#FFE14D", "#EEEEEE", "#FFF", 7]) {
      reply = await api("PATCH", `/api/applications/${appId}`, { color: bad });
      assert.equal(reply.status, 400, String(bad));
    }
    assert.equal(psql(`SELECT color FROM implementations WHERE id = '${appId}';`), "#6E4F9C", "a refused PATCH changed nothing");
    reply = await api("PATCH", `/api/applications/${appId}`, { color: null });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.color, null);
    reply = await api("PATCH", `/api/applications/${appId}`, { color: "" });
    assert.equal(reply.body.color, null, '"" clears too');
    reply = await api("PATCH", `/api/applications/${appId}`, { color: "#1E6E55", name: "Baseline" });
    assert.equal(reply.body.color, "#1E6E55", "with other fields in the same PATCH");
  });

  await test("PATCH /api/projects/[id] and POST /api/projects: save, clear and refuse a colour; a create without one stays NULL", async () => {
    let reply = await api("PATCH", `/api/projects/${projectId}`, { color: "#2b8780" });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.color, "#2B8780");
    reply = await api("PATCH", `/api/projects/${projectId}`, { color: "#F2B230" });
    assert.equal(reply.status, 400);
    assert.match(reply.body.error, /needs you/);
    assert.equal(psql(`SELECT color FROM projects WHERE id = '${projectId}';`), "#2B8780");
    reply = await api("PATCH", `/api/projects/${projectId}`, { color: null });
    assert.equal(reply.body.color, null);

    const created = await api("POST", "/api/projects", { name: "Move", tags: ["personal"], color: "#96592a" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.color, "#96592A");
    const plain = await api("POST", "/api/projects", { name: "Plain" });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.color, null);
    const refused = await api("POST", "/api/projects", { name: "Gold", color: "#FFD700" });
    assert.equal(refused.status, 400);
    assert.equal(psql(`SELECT count(*) FROM projects WHERE user_id = '${userId}' AND name = 'Gold';`), "0", "a refused create inserts nothing");
  });

  await test("GET /api/project-colors and the layout's loader: every app and project with its colour", async () => {
    const reply = await api("GET", "/api/project-colors");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.available, true);
    assert.deepEqual(reply.body.apps.map((a) => [a.name, a.color]), [["Baseline", "#1E6E55"]]);
    const names = Object.fromEntries(reply.body.projects.map((p) => [p.name, p.color]));
    assert.equal(names.Move, "#96592A");
    assert.equal(names.Home, null);
    assert.equal(reply.body.projects.find((p) => p.id === linkedId).implementation_id, appId);
    const direct = await loadProjectColorCatalog(admin, userId);
    assert.equal(direct.apps.length, 1);
    const other = await loadProjectColorCatalog(admin, otherId);
    assert.deepEqual([other.apps.length, other.projects.length], [0, 0], "filtered by user");
  });

  // ── 3. MCP ──────────────────────────────────────────────────────────────
  await test("MCP: update_application / create_project / update_project round-trip a colour; refusals are isError; null clears", async () => {
    let result = await callTool("update_application", { application_id: appId, color: "#3d6c99" });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    assert.equal(result.data.color, "#3D6C99");
    result = await callTool("get_application", { application_id: appId });
    assert.equal(result.data.color, "#3D6C99");

    result = await callTool("update_application", { application_id: appId, color: "#F2B230" });
    assert.equal(result.isError, true, "marigold is refused through MCP");
    assert.match(JSON.stringify(result.data), /needs you/);

    result = await callTool("create_project", { name: "Agent-made project", color: "#87387a", tags: ["personal"] });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    assert.equal(result.data.color, "#87387A");
    const newId = result.data.id;
    result = await callTool("get_project", { project_id: newId });
    assert.equal(result.data.color, "#87387A");

    result = await callTool("update_project", { project_id: newId, color: null });
    assert.equal(result.isError, false);
    assert.equal(result.data.color, null);
    result = await callTool("update_project", { project_id: newId, color: "not a colour" });
    assert.equal(result.isError, true);

    result = await callTool("create_project", { name: "Pale", color: "#EEEEEE" });
    assert.equal(result.isError, true);
    assert.equal(psql(`SELECT color FROM projects WHERE id = '${newId}';`), "", "NULL after the clear");
    result = await callTool("list_projects", {});
    const listed = (Array.isArray(result.data) ? result.data : result.data.projects ?? []).find((p) => p.id === newId);
    assert.ok(listed && "color" in listed, "list_projects carries the field");
  });

  // ── 4. RLS and the pre-069 fallback ─────────────────────────────────────
  await test("RLS: another signed-in user can't colour this user's app or project (0 rows)", () => {
    const claims = `'{"sub":"${otherId}","role":"authenticated"}'`;
    const out = psql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', ${claims}, true) IS NOT NULL;
      WITH a AS (UPDATE implementations SET color = '#000000' WHERE id = '${appId}' RETURNING 1),
           p AS (UPDATE projects SET color = '#000000' WHERE id = '${projectId}' RETURNING 1)
      SELECT (SELECT count(*) FROM a) || '|' || (SELECT count(*) FROM p); COMMIT;`);
    assert.match(out, /0\|0$/);
    assert.equal(psql(`SELECT color FROM implementations WHERE id = '${appId}';`), "#3D6C99");
  });

  await test("before 069 (rolled back): the colour list falls back to defaults (available false) instead of failing; re-apply restores it", async () => {
    psql(ROLLBACK);
    await waitForColumn(false);
    const catalog = await loadProjectColorCatalog(admin, userId);
    assert.equal(catalog.available, false);
    assert.ok(catalog.apps.length === 1 && catalog.apps[0].color === null);
    assert.ok(catalog.projects.length >= 3 && catalog.projects.every((p) => p.color === null));
    psql(MIGRATION);
    await waitForColumn(true);
    assert.equal((await loadProjectColorCatalog(admin, userId)).available, true);
  });
} finally {
  globalThis.fetch = realFetch;
  // 069 stays applied whatever happened above.
  try {
    psql(MIGRATION);
  } catch (error) {
    console.error("could not re-apply 069:", error.message);
  }
  await admin.from("projects").delete().eq("user_id", userId);
  await admin.from("implementations").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId);
  await admin.auth.admin.deleteUser(otherId);
}

console.log(`\n${passed} passed`);
