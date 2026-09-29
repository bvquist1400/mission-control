#!/usr/bin/env node
// Database tests for Portfolio slice 2, against a LOCAL Supabase stack with
// every migration applied:
//
//   PORTFOLIO_TEST_SUPABASE_URL=http://127.0.0.1:59321 \
//   PORTFOLIO_TEST_ANON_KEY=... PORTFOLIO_TEST_SERVICE_ROLE_KEY=... \
//   PORTFOLIO_TEST_DB_CONTAINER=supabase_db_<project_id> \
//   npm run test:portfolio-db
//
// Part 1: migration 057 (planned section dates): defaults, the range check,
//         rollback and re-apply (psql through `docker exec`).
// Part 2: the section API and the MCP tools create_project_section /
//         update_project_section / list_project_sections, end to end through
//         the real /api/mcp handler (its fetches are routed in-process).
// Part 3: planned dates change nothing else: task rows (due dates, priority,
//         updated_at), the daily brief digest and the Portfolio outside the
//         timeline are identical before and after.
// Part 4: the Portfolio read from the database: planned lanes, and Brent's
//         blocked tasks (Blocked/Waiting or an unfinished dependency) in
//         "Coming to you later" instead of "Assigned to you".
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.PORTFOLIO_TEST_SUPABASE_URL;
const anonKey = process.env.PORTFOLIO_TEST_ANON_KEY;
const serviceKey = process.env.PORTFOLIO_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.PORTFOLIO_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error(
    "Set PORTFOLIO_TEST_SUPABASE_URL, PORTFOLIO_TEST_ANON_KEY, PORTFOLIO_TEST_SERVICE_ROLE_KEY and PORTFOLIO_TEST_DB_CONTAINER (local stack only)."
  );
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/057_add_section_planned_dates.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/057_add_section_planned_dates.down.sql", import.meta.url), "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForSchema(hasPlanned) {
  // PostgREST reloads its schema cache on NOTIFY; wait until it agrees.
  // A select passes a stale cache straight to Postgres, so probe with a no-op update,
  // which PostgREST checks against its cache (PGRST204 while stale).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = hasPlanned
      ? await admin.from("project_sections").update({ planned_start: null }).eq("id", "00000000-0000-0000-0000-000000000000")
      : await admin.from("project_sections").select("planned_start").limit(1);
    if (hasPlanned ? !error : error) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`schema cache never ${hasPlanned ? "saw" : "dropped"} planned_start`);
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

const userId = await makeUser("portfolio-db");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.MISSION_CONTROL_API_KEY = `portfolio-db-${randomUUID()}`;
process.env.MISSION_CONTROL_USER_ID = userId;
process.env.DEPLOYMENT_ROLE = "main";
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const projectSectionsRoute = await import("../src/app/api/projects/[id]/sections/route.ts");
const sectionRoute = await import("../src/app/api/sections/[id]/route.ts");
const { buildPortfolio } = await import("../src/lib/portfolio.ts");
const { loadPortfolioInput } = await import("../src/lib/portfolio-queries.ts");
const { buildDailyBriefDigest } = await import("../src/lib/briefing/digest.ts");
const { NextRequest } = await import("next/server.js");

const realFetch = globalThis.fetch;
const apiCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  const isApi = ["mission-control-orpin-chi.vercel.app", "localhost"].includes(target.hostname)
    && target.pathname.startsWith("/api/");
  if (!isApi) return realFetch(input, init);
  const request = new NextRequest(`http://localhost${target.pathname}${target.search}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
  apiCalls.push(`${request.method} ${target.pathname}`);
  const projectMatch = /^\/api\/projects\/([^/]+)\/sections$/.exec(target.pathname);
  if (projectMatch) {
    const ctx = { params: Promise.resolve({ id: projectMatch[1] }) };
    return request.method === "POST" ? projectSectionsRoute.POST(request, ctx) : projectSectionsRoute.GET(request, ctx);
  }
  const sectionMatch = /^\/api\/sections\/([^/]+)$/.exec(target.pathname);
  if (sectionMatch) {
    const ctx = { params: Promise.resolve({ id: sectionMatch[1] }) };
    return request.method === "PATCH" ? sectionRoute.PATCH(request, ctx) : sectionRoute.DELETE(request, ctx);
  }
  throw new Error(`test fetch: unrouted ${request.method} ${target.pathname}`);
};

const { POST: mcpPost } = await import("../src/app/api/mcp/route.ts");

let rpcId = 0;
async function mcp(method, params) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    })
  );
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  return JSON.parse(payload);
}

async function callTool(name, args) {
  const reply = await mcp("tools/call", { name, arguments: args });
  if (reply.error) return { isError: true, error: reply.error };
  const result = reply.result;
  const text = result.content?.[0]?.text ?? "{}";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(result.isError), data: data?.data ?? data, raw: text };
}

async function apiRequest(route, method, path, id, body) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await route[method](request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 4).join("\n  ")}`);
  }
}

async function makeProject(name, extra = {}) {
  const { data: app, error: appError } = await admin
    .from("implementations")
    .insert({ user_id: userId, name: `${name} app`, phase: "Build", rag: "Green" })
    .select("id")
    .single();
  if (appError) throw appError;
  const { data: project, error } = await admin
    .from("projects")
    .insert({ user_id: userId, name, implementation_id: app.id, tags: ["personal"], ...extra })
    .select("id, implementation_id")
    .single();
  if (error) throw error;
  return project;
}

async function makeTask(fields) {
  const { data, error } = await admin
    .from("tasks")
    .insert({ user_id: userId, tags: ["personal"], ...fields })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

try {
  const project = await makeProject("Stock & Stir DB test");

  // ── Part 1: migration 057 ──────────────────────────────────────────────
  await test("057: a section inserted without planned dates has both null (existing inserts unchanged)", async () => {
    const { data, error } = await admin
      .from("project_sections")
      .insert({ user_id: userId, project_id: project.id, name: "Legacy section" })
      .select("planned_start, planned_end, sort_order")
      .single();
    if (error) throw error;
    assert.deepEqual(data, { planned_start: null, planned_end: null, sort_order: 0 });
  });

  await test("057: either date alone, or end on/after start, is allowed; end before start is rejected", async () => {
    const ok = [
      { name: "Start only", planned_start: "2026-10-01" },
      { name: "End only", planned_end: "2026-10-01" },
      { name: "Same day", planned_start: "2026-10-01", planned_end: "2026-10-01" },
      { name: "A range", planned_start: "2026-10-01", planned_end: "2026-10-31" },
    ];
    for (const fields of ok) {
      const { error } = await admin.from("project_sections").insert({ user_id: userId, project_id: project.id, ...fields });
      assert.equal(error, null, `${fields.name}: ${error?.message}`);
    }
    const bad = await admin
      .from("project_sections")
      .insert({ user_id: userId, project_id: project.id, name: "Backwards", planned_start: "2026-10-31", planned_end: "2026-10-01" });
    assert.equal(bad.error?.code, "23514");
    assert.match(bad.error.message, /project_sections_planned_range_check/);
    const { data: row } = await admin.from("project_sections").select("id").eq("user_id", userId).eq("name", "A range").single();
    const badUpdate = await admin.from("project_sections").update({ planned_end: "2026-09-01" }).eq("id", row.id);
    assert.equal(badUpdate.error?.code, "23514", "the check also guards updates of one date");
  });

  await test("057: columns are date, nullable, no default; the check is the only new constraint", async () => {
    const columns = psql(`SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-')
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'project_sections'
      AND column_name IN ('planned_start', 'planned_end') ORDER BY column_name;`);
    assert.deepEqual(columns.split("\n"), ["planned_end:date:YES:-", "planned_start:date:YES:-"]);
    const checks = psql(`SELECT conname FROM pg_constraint WHERE conrelid = 'public.project_sections'::regclass AND contype = 'c' ORDER BY conname;`);
    assert.deepEqual(checks.split("\n"), ["project_sections_planned_range_check"]);
  });

  await test("057: rollback drops only the new columns and check (rows kept); re-apply restores them; applying twice is a no-op", async () => {
    const before = psql(`SELECT count(*) FROM project_sections WHERE user_id = '${userId}';`);
    psql(`${ROLLBACK}\nNOTIFY pgrst, 'reload schema';`);
    await waitForSchema(false);
    const gone = psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_sections' AND column_name LIKE 'planned_%';`);
    assert.equal(gone, "0");
    assert.equal(psql(`SELECT count(*) FROM project_sections WHERE user_id = '${userId}';`), before, "rows kept");
    // Old code path (no planned columns) still inserts.
    const legacy = await admin.from("project_sections").insert({ user_id: userId, project_id: project.id, name: "Written while rolled back" });
    assert.equal(legacy.error, null);

    psql(`${MIGRATION}\n${MIGRATION}\nNOTIFY pgrst, 'reload schema';`);
    await waitForSchema(true);
    const { data, error } = await admin
      .from("project_sections")
      .select("name, planned_start, planned_end")
      .eq("user_id", userId)
      .eq("name", "A range")
      .single();
    if (error) throw error;
    assert.deepEqual(data, { name: "A range", planned_start: null, planned_end: null }, "dates dropped by the rollback come back null");
    const bad = await admin
      .from("project_sections")
      .insert({ user_id: userId, project_id: project.id, name: "Backwards again", planned_start: "2026-10-31", planned_end: "2026-10-01" });
    assert.equal(bad.error?.code, "23514", "the check is back");
  });

  // ── Part 2: API + MCP tools ────────────────────────────────────────────
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "portfolio-db-test", version: "1.0.0" },
  });
  assert.ok(init.result, "MCP initialize");

  let releaseId;
  await test("create_project_section without planned dates (an existing caller) still works; both come back null", async () => {
    const result = await callTool("create_project_section", { project_id: project.id, name: "Release 2 follow-ups", sort_order: 5 });
    assert.equal(result.isError, false, result.raw);
    assert.equal(result.data.name, "Release 2 follow-ups");
    assert.equal(result.data.planned_start, null);
    assert.equal(result.data.planned_end, null);
  });

  await test("create_project_section with planned dates stores and returns them", async () => {
    const result = await callTool("create_project_section", {
      project_id: project.id,
      name: "Release 3",
      sort_order: 1,
      planned_start: "2026-09-21",
      planned_end: "2026-10-09",
    });
    assert.equal(result.isError, false, result.raw);
    assert.equal(result.data.planned_start, "2026-09-21");
    assert.equal(result.data.planned_end, "2026-10-09");
    releaseId = result.data.id;
  });

  await test("list_project_sections includes planned_start / planned_end", async () => {
    const result = await callTool("list_project_sections", { project_id: project.id });
    assert.equal(result.isError, false, result.raw);
    const release = result.data.find((section) => section.id === releaseId);
    assert.deepEqual([release.planned_start, release.planned_end], ["2026-09-21", "2026-10-09"]);
    assert.ok(result.data.every((section) => "planned_start" in section && "planned_end" in section));
  });

  await test("update_project_section: move the end, rename without touching dates, clear with null", async () => {
    const moved = await callTool("update_project_section", { section_id: releaseId, planned_end: "2026-10-16" });
    assert.equal(moved.isError, false, moved.raw);
    assert.deepEqual([moved.data.planned_start, moved.data.planned_end], ["2026-09-21", "2026-10-16"]);
    const renamed = await callTool("update_project_section", { section_id: releaseId, name: "Release 3 — Pantry" });
    assert.deepEqual([renamed.data.name, renamed.data.planned_start, renamed.data.planned_end], ["Release 3 — Pantry", "2026-09-21", "2026-10-16"]);
    const cleared = await callTool("update_project_section", { section_id: releaseId, planned_start: null });
    assert.deepEqual([cleared.data.planned_start, cleared.data.planned_end], [null, "2026-10-16"]);
    const back = await callTool("update_project_section", { section_id: releaseId, planned_start: "2026-09-21", planned_end: "2026-10-09" });
    assert.deepEqual([back.data.planned_start, back.data.planned_end], ["2026-09-21", "2026-10-09"]);
  });

  await test("MCP schema stops a malformed date before the API is called", async () => {
    const before = apiCalls.length;
    const bad = await callTool("update_project_section", { section_id: releaseId, planned_end: "10/9/2026" });
    assert.equal(bad.isError, true);
    const badCreate = await callTool("create_project_section", { project_id: project.id, name: "X", planned_start: "2026-10-01T00:00:00Z" });
    assert.equal(badCreate.isError, true);
    assert.equal(apiCalls.length, before);
  });

  await test("API: impossible dates and backwards ranges are 400s, and nothing changes", async () => {
    const impossible = await apiRequest(sectionRoute, "PATCH", `/api/sections/${releaseId}`, releaseId, { planned_start: "2026-02-30" });
    assert.equal(impossible.status, 400);
    assert.match(impossible.body.error, /planned_start must be a calendar date/);
    const both = await apiRequest(sectionRoute, "PATCH", `/api/sections/${releaseId}`, releaseId, { planned_start: "2026-10-10", planned_end: "2026-10-01" });
    assert.equal(both.status, 400);
    // Only the end sent, before the stored start: the database check answers, as a 400.
    const oneSide = await callTool("update_project_section", { section_id: releaseId, planned_end: "2026-09-01" });
    assert.match(oneSide.data.error, /planned_end can't be before planned_start/);
    const notString = await apiRequest(projectSectionsRoute, "POST", `/api/projects/${project.id}/sections`, project.id, { name: "Y", planned_end: 20261001 });
    assert.equal(notString.status, 400);
    const { data } = await admin.from("project_sections").select("planned_start, planned_end").eq("id", releaseId).single();
    assert.deepEqual(data, { planned_start: "2026-09-21", planned_end: "2026-10-09" });
    const empty = await apiRequest(sectionRoute, "PATCH", `/api/sections/${releaseId}`, releaseId, {});
    assert.equal(empty.status, 400, "an empty PATCH is still rejected");
  });

  await test("another user's section can't be re-planned", async () => {
    const otherId = await makeUser("portfolio-db-other");
    const { data: otherProject } = await admin.from("projects").insert({ user_id: otherId, name: "Not yours" }).select("id").single();
    const { data: otherSection } = await admin
      .from("project_sections")
      .insert({ user_id: otherId, project_id: otherProject.id, name: "Theirs" })
      .select("id")
      .single();
    const result = await apiRequest(sectionRoute, "PATCH", `/api/sections/${otherSection.id}`, otherSection.id, { planned_start: "2026-10-01" });
    assert.equal(result.status, 404);
    const { data } = await admin.from("project_sections").select("planned_start").eq("id", otherSection.id).single();
    assert.equal(data.planned_start, null);
  });

  // ── Part 3: planned dates change nothing else ─────────────────────────
  await test("planned dates leave tasks, priority, the brief digest and the Portfolio (outside the timeline) unchanged", async () => {
    // Work (not personal) tasks: the briefs leave personal ones out, so these must be work to count.
    const work = await makeProject("OnCore DB test", { tags: [] });
    const { data: section } = await admin
      .from("project_sections")
      .insert({ user_id: userId, project_id: work.id, name: "Release 4", sort_order: 2 })
      .select("id")
      .single();
    const day = "2026-09-29";
    const taskIds = [
      await makeTask({ title: "Pantry basics", tags: [], project_id: work.id, section_id: section.id, status: "In Progress", due_at: "2026-09-30T21:00:00Z", base_priority: 60, owner: "brent" }),
      await makeTask({ title: "Overdue bit", tags: [], project_id: work.id, section_id: section.id, status: "Planned", due_at: "2026-09-25T21:00:00Z", base_priority: 40 }),
      await makeTask({ title: "No date", tags: [], project_id: work.id, section_id: section.id, status: "Backlog" }),
    ];
    const snapshotTasks = async () => {
      const { data } = await admin
        .from("tasks")
        .select("id, due_at, priority_score, base_priority, status, updated_at, section_id")
        .in("id", taskIds)
        .order("id");
      return data;
    };
    // The clock moves between the two builds (generation time, "Generated 9:37 AM ET"); nothing else may.
    const stripVolatile = (value) =>
      JSON.parse(
        JSON.stringify(value, (key, v) => {
          if (/^(generated_at|generatedAt|current_time_et|current_time_utc|currentTimeET)$/.test(key)) return undefined;
          return typeof v === "string" ? v.replace(/Generated \d{1,2}:\d{2} [AP]M ET/g, "Generated <time> ET") : v;
        })
      );
    const digests = async () => ({
      eod: stripVolatile(await buildDailyBriefDigest({ supabase: admin, userId, mode: "eod", date: day })),
      morning: stripVolatile(await buildDailyBriefDigest({ supabase: admin, userId, mode: "morning", date: day })),
    });
    const portfolioOutside = async () => {
      const view = buildPortfolio(await loadPortfolioInput(admin, userId), { scope: "all", now: new Date("2026-09-29T15:00:00Z") });
      return { ...view, apps: view.apps.map((app) => ({ ...app, timeline: null })) };
    };

    const tasksBefore = await snapshotTasks();
    const digestBefore = await digests();
    const portfolioBefore = await portfolioOutside();
    assert.ok(JSON.stringify(digestBefore.eod).includes("Pantry basics"), "the EOD digest covers the section's tasks");
    assert.ok(JSON.stringify(digestBefore.morning).includes("Overdue bit"), "the morning digest covers them too");

    const planned = await callTool("update_project_section", { section_id: section.id, planned_start: "2026-09-01", planned_end: "2026-09-10" });
    assert.equal(planned.isError, false, planned.raw);

    assert.deepEqual(await snapshotTasks(), tasksBefore, "task due dates, priority and updated_at untouched");
    const digestAfter = await digests();
    if (JSON.stringify(digestAfter) !== JSON.stringify(digestBefore)) {
      const walk = (a, b, path) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        if (a && b && typeof a === "object" && typeof b === "object") {
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`);
          return;
        }
        console.log(`  digest differs at ${path}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
      };
      walk(digestAfter, digestBefore, "digest");
    }
    assert.deepEqual(digestAfter, digestBefore, "AM/EOD digest identical");
    assert.deepEqual(await portfolioOutside(), portfolioBefore, "Assigned, counts, stand/next identical");
  });

  // ── Part 4: the Portfolio from the database ────────────────────────────
  await test("Portfolio: planned sections draw from their dates (solid), a planned-only section shows with no tasks", async () => {
    await makeTask({ title: "Rename screens", project_id: project.id, section_id: releaseId, status: "In Progress" });
    const { data: future } = await admin
      .from("project_sections")
      .insert({ user_id: userId, project_id: project.id, name: "Release 5", sort_order: 3, planned_start: "2026-11-02", planned_end: "2026-11-20" })
      .select("id")
      .single();
    const view = buildPortfolio(await loadPortfolioInput(admin, userId), { scope: "all", now: new Date("2026-09-29T15:00:00Z") });
    const app = view.apps.find((a) => a.id === project.implementation_id);
    const lanes = Object.fromEntries(app.timeline.lanes.map((lane) => [lane.key, lane]));
    const r3 = lanes[`s:${releaseId}`];
    assert.deepEqual([r3.start, r3.end, r3.planned, r3.estimated], ["2026-09-21", "2026-10-09", true, false]);
    const r5 = lanes[`s:${future.id}`];
    assert.deepEqual([r5.start, r5.end, r5.planned, r5.sub], ["2026-11-02", "2026-11-20", true, "Planned · no tasks yet"]);
  });

  await test("Portfolio: Brent's blocked tasks move to Coming to you later; the hero counts only actionable ones", async () => {
    const now = new Date("2026-09-29T15:00:00Z");
    const baseline = buildPortfolio(await loadPortfolioInput(admin, userId), { scope: "all", now });
    const actionable = await makeTask({ title: "Check Split View", owner: "brent", status: "Planned", project_id: project.id });
    const waiting = await makeTask({
      title: "Confirm the TestFlight build",
      owner: "brent",
      status: "Blocked/Waiting",
      waiting_on: "Release 3.1 upload",
      status_line: "Comes to you once 3.1 is on TestFlight.",
      follow_up_at: "2026-10-02T13:00:00Z",
      project_id: project.id,
    });
    const blocker = await makeTask({ title: "Ship Release 3.1", status: "In Progress", project_id: project.id });
    const depBlocked = await makeTask({ title: "Try 3.1 on the iPad", owner: "brent", status: "Planned", project_id: project.id });
    const { error: depError } = await admin.from("task_dependencies").insert({ user_id: userId, task_id: depBlocked, depends_on_task_id: blocker });
    if (depError) throw depError;

    const view = buildPortfolio(await loadPortfolioInput(admin, userId), { scope: "all", now });
    assert.ok(view.assigned.some((t) => t.id === actionable));
    assert.equal(view.assigned.some((t) => t.id === waiting || t.id === depBlocked), false);
    assert.equal(view.brentOpen, baseline.brentOpen + 1, "hero +1 (only the actionable one)");
    assert.equal(view.brentLater, baseline.brentLater + 2);
    const later = Object.fromEntries(view.comingLater.map((t) => [t.id, t]));
    assert.equal(later[waiting].waitingOn, "Release 3.1 upload");
    assert.equal(later[waiting].followUp, "2026-10-02");
    assert.equal(later[waiting].statusLine, "Comes to you once 3.1 is on TestFlight.");
    assert.deepEqual(later[depBlocked].blockedBy, ["Ship Release 3.1"]);

    // The blocker finishes: the task becomes actionable and lands in Assigned to you.
    await admin.from("tasks").update({ status: "Done" }).eq("id", blocker);
    const after = buildPortfolio(await loadPortfolioInput(admin, userId), { scope: "all", now });
    assert.ok(after.assigned.some((t) => t.id === depBlocked));
    assert.equal(after.brentOpen, view.brentOpen + 1);
    assert.equal(after.comingLater.some((t) => t.id === depBlocked), false);
  });
} finally {
  globalThis.fetch = realFetch;
  for (const id of users) {
    await admin.from("tasks").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
