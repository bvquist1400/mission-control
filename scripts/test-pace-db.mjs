#!/usr/bin/env node
// Database tests for pace tracking slice 1, against a LOCAL Supabase stack with
// every migration applied:
//
//   PACE_TEST_SUPABASE_URL=http://127.0.0.1:58321 \
//   PACE_TEST_ANON_KEY=... PACE_TEST_SERVICE_ROLE_KEY=... \
//   PACE_TEST_DB_CONTAINER=supabase_db_<project_id> \
//   [PACE_TEST_SNAPSHOT=/path/to/blanket-snapshot.json] \
//   npm run test:pace-db
//
// Part 1: migration 059: rollback and re-apply, defaults and CHECKs, the
//         completed_at trigger, the actual_minutes rollup (incl. delete and
//         cascades), ownership / project-mismatch triggers, RLS.
// Part 2: the API routes and MCP tools end to end through the real handlers
//         (log/list/update/delete sessions, forecast, pace rates, checklist,
//         task and project fields), including errors and another user's ids.
// Part 3 (only with PACE_TEST_SNAPSHOT): seed the blanket snapshot into a
//         throwaway user, run scripts/pace-backfill.mjs (dry run, --apply,
//         --apply again) and check the forecast (the acceptance numbers).
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.PACE_TEST_SUPABASE_URL;
const anonKey = process.env.PACE_TEST_ANON_KEY;
const serviceKey = process.env.PACE_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.PACE_TEST_DB_CONTAINER;
const snapshotPath = process.env.PACE_TEST_SNAPSHOT;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set PACE_TEST_SUPABASE_URL, PACE_TEST_ANON_KEY, PACE_TEST_SERVICE_ROLE_KEY and PACE_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/059_add_work_sessions_and_units.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/059_add_work_sessions_and_units.down.sql", import.meta.url), "utf8");

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForSchema(present) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { error } = present
      ? await admin.from("work_sessions").update({ note: null }).eq("id", "00000000-0000-0000-0000-000000000000")
      : await admin.from("work_sessions").select("id").limit(1);
    if (present ? !error : error) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`schema cache never ${present ? "saw" : "dropped"} work_sessions`);
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

const userA = await makeUser("pace-a");
const userB = await makeUser("pace-b");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.MISSION_CONTROL_API_KEY = `pace-db-${randomUUID()}`;
process.env.MISSION_CONTROL_USER_ID = userA;
process.env.DEPLOYMENT_ROLE = "main";
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;

const workSessionsRoute = await import("../src/app/api/work-sessions/route.ts");
const workSessionRoute = await import("../src/app/api/work-sessions/[id]/route.ts");
const forecastRoute = await import("../src/app/api/projects/[id]/forecast/route.ts");
const paceRatesRoute = await import("../src/app/api/pace-rates/route.ts");
const checklistRoute = await import("../src/app/api/tasks/[id]/checklist/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const { getProjectForecast, logWorkSession } = await import("../src/lib/work-sessions/service.ts");
const { NextRequest } = await import("next/server.js");

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  const isApi = ["mission-control-orpin-chi.vercel.app", "localhost"].includes(target.hostname) && target.pathname.startsWith("/api/");
  if (!isApi) return realFetch(input, init);
  const request = new NextRequest(`http://localhost${target.pathname}${target.search}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
  const p = target.pathname;
  const ctx = (id) => ({ params: Promise.resolve({ id }) });
  let m;
  if (p === "/api/work-sessions") return workSessionsRoute[request.method](request);
  if ((m = /^\/api\/work-sessions\/([^/]+)$/.exec(p))) return workSessionRoute[request.method](request, ctx(m[1]));
  if ((m = /^\/api\/projects\/([^/]+)\/forecast$/.exec(p))) return forecastRoute.GET(request, ctx(m[1]));
  if (p === "/api/pace-rates") return paceRatesRoute.GET(request);
  if ((m = /^\/api\/tasks\/([^/]+)\/checklist$/.exec(p))) return checklistRoute[request.method](request, ctx(m[1]));
  if (p === "/api/tasks") return tasksRoute[request.method](request);
  if ((m = /^\/api\/tasks\/([^/]+)$/.exec(p))) return taskRoute[request.method](request, ctx(m[1]));
  if ((m = /^\/api\/projects\/([^/]+)$/.exec(p))) return projectRoute[request.method](request, ctx(m[1]));
  throw new Error(`test fetch: unrouted ${request.method} ${p}`);
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
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  const reply = JSON.parse(payload);
  if (reply.error) return { isError: true, error: reply.error };
  const body = reply.result.content?.[0]?.text ?? "{}";
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = body;
  }
  return { isError: Boolean(reply.result.isError), data: data?.data ?? data };
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
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 5).join("\n  ")}`);
  }
}

async function insert(table, row, select = "*") {
  const { data, error } = await admin.from(table).insert(row).select(select).single();
  if (error) throw error;
  return data;
}
async function makeProject(owner, name, extra = {}) {
  return insert("projects", { user_id: owner, name, tags: ["personal", "hobby"], ...extra });
}
async function makeTask(owner, projectId, title, extra = {}) {
  return insert("tasks", { user_id: owner, project_id: projectId, title, tags: ["personal"], ...extra });
}
async function makeItem(owner, taskId, text, extra = {}) {
  return insert("task_checklist_items", { user_id: owner, task_id: taskId, text, ...extra });
}
async function actualMinutes(taskId) {
  const { data, error } = await admin.from("tasks").select("actual_minutes").eq("id", taskId).single();
  if (error) throw error;
  return data.actual_minutes;
}
const errCode = (result) => result.error?.code;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two overlapping transactions: `first` runs its statement and holds its
 * transaction open; `second` runs BEGIN; stmt; COMMIT and must block on it;
 * then `first` commits. Returns what each connection printed (an ERROR line
 * means that transaction was rejected).
 */
async function overlap(firstSql, secondSql) {
  const first = psqlConnection("first");
  const second = psqlConnection("second");
  let secondBlocked = false;
  try {
    first.send(`BEGIN; ${firstSql} SELECT 'first-ready';`);
    await first.waitFor("first-ready");
    second.send(`BEGIN; ${secondSql} COMMIT; SELECT 'second-done';`);
    await sleep(1500);
    secondBlocked = !second.output().includes("second-done") && !second.output().includes("ERROR");
    first.send("COMMIT; SELECT 'first-done';");
    await first.waitFor("first-done");
    for (let waited = 0; waited < 10000 && !/second-done|ERROR/.test(second.output()); waited += 50) await sleep(50);
  } finally {
    await first.end();
    await second.end();
  }
  return { first: first.output(), second: second.output(), secondBlocked };
}

/** An interactive psql connection we can feed statement by statement (for overlap tests). */
function psqlConnection(label) {
  const child = spawn("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    send: (sql) => child.stdin.write(`${sql}\n`),
    output: () => output,
    async waitFor(marker, ms = 10000) {
      for (let waited = 0; waited < ms; waited += 50) {
        if (output.includes(marker)) return;
        await sleep(50);
      }
      throw new Error(`${label}: never printed ${marker}; output: ${output}`);
    },
    async end() {
      child.stdin.end();
      await closed;
    },
  };
}

try {
  // ── Part 1: migration 059 ──────────────────────────────────────────────
  await test("059 rollback removes every table, column, trigger and function; re-apply restores them", async () => {
    psql(ROLLBACK + "\nNOTIFY pgrst, 'reload schema';");
    assert.equal(psql("SELECT to_regclass('public.work_sessions') IS NULL AND to_regclass('public.work_session_items') IS NULL;"), "t");
    assert.equal(psql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
      (table_name='tasks' AND column_name IN ('unit_count','work_type','is_sample')) OR
      (table_name='task_checklist_items' AND column_name IN ('unit_count','work_type','completed_at','created_at')) OR
      (table_name='projects' AND column_name IN ('unit_label','pace_settings')));`), "0");
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('work_sessions_rollup_actual_minutes','work_sessions_check_ownership','work_session_items_check_project','task_checklist_items_set_completed_at','tasks_guard_project_move_with_sessions','work_session_create','work_session_update','work_session_delete','work_sessions_out_of_scope_items','work_sessions_assert_caller','work_sessions_lock_tasks','work_sessions_item_tasks');"), "0");
    await waitForSchema(false);
    psql(MIGRATION + "\nNOTIFY pgrst, 'reload schema';");
    psql(MIGRATION); // idempotent: a second apply is a no-op
    assert.equal(psql("SELECT to_regclass('public.work_sessions') IS NOT NULL;"), "t");
    assert.equal(psql("SELECT count(*) FROM pg_policies WHERE tablename IN ('work_sessions','work_session_items');"), "8");
    assert.equal(psql("SELECT has_table_privilege('authenticated','public.work_sessions','select,insert,update,delete') AND has_table_privilege('service_role','public.work_session_items','select,insert,update,delete') AND NOT has_table_privilege('anon','public.work_sessions','select');"), "t");
    await waitForSchema(true);
  });

  const project = await makeProject(userA, "Pace DB blanket", { target_date: "2026-12-05" });
  const otherProject = await makeProject(userA, "Pace DB other");

  await test("059 defaults: existing-style inserts get is_sample=false, created_at, no units; projects no pace tracking", async () => {
    const task = await makeTask(userA, project.id, "Plain task");
    assert.deepEqual([task.is_sample, task.unit_count, task.work_type], [false, null, null]);
    const item = await makeItem(userA, task.id, "Plain row");
    assert.equal(item.unit_count, null);
    assert.equal(item.completed_at, null);
    assert.ok(item.created_at);
    assert.deepEqual([project.unit_label, project.pace_settings], [null, null]);
  });

  await test("059 CHECKs: negative units, bad work types, minutes out of range, end before start, unknown source", async () => {
    const task = await makeTask(userA, project.id, "Checks");
    assert.equal(errCode(await admin.from("tasks").update({ unit_count: -1 }).eq("id", task.id)), "23514");
    assert.equal(errCode(await admin.from("tasks").update({ work_type: "Bad Type" }).eq("id", task.id)), "23514");
    assert.equal(errCode(await admin.from("task_checklist_items").insert({ user_id: userA, task_id: task.id, text: "x", unit_count: -2 })), "23514");
    assert.equal(errCode(await admin.from("task_checklist_items").insert({ user_id: userA, task_id: task.id, text: "x", work_type: "-dash" })), "23514");
    const base = { user_id: userA, project_id: project.id, session_date: "2026-10-04" };
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, minutes: 0 })), "23514");
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, minutes: 1441 })), "23514");
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, minutes: 5, started_at: "2026-10-04T18:00:00Z", ended_at: "2026-10-04T18:00:00Z" })), "23514");
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, minutes: 5, source: "import" })), "23514");
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, minutes: 5, extra_work_type: "Nope!" })), "23514");
  });

  await test("059 source_ref is unique per user (and only per user)", async () => {
    const base = { project_id: project.id, session_date: "2026-10-04", minutes: 5, source: "backfill", source_ref: "dup-ref" };
    await insert("work_sessions", { ...base, user_id: userA });
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, user_id: userA })), "23505");
    const projectB = await makeProject(userB, "B's project");
    await insert("work_sessions", { ...base, user_id: userB, project_id: projectB.id });
  });

  await test("059 completed_at: set on tick (unless supplied), kept on other edits, cleared on untick; insert done stamps it", async () => {
    const task = await makeTask(userA, project.id, "Ticks");
    const born = await makeItem(userA, task.id, "Born done", { is_done: true });
    assert.ok(born.completed_at, "insert done → stamped");
    const bornUndone = await makeItem(userA, task.id, "Born undone with a stamp", { is_done: false, completed_at: "2026-10-01T00:00:00Z" });
    assert.equal(bornUndone.completed_at, null, "undone rows carry no completed_at");
    const item = await makeItem(userA, task.id, "Row 1");
    const before = Date.now();
    const { data: ticked } = await admin.from("task_checklist_items").update({ is_done: true }).eq("id", item.id).select().single();
    assert.ok(Math.abs(Date.parse(ticked.completed_at) - before) < 60_000, "now()");
    const { data: renamed } = await admin.from("task_checklist_items").update({ text: "Row 1 renamed" }).eq("id", item.id).select().single();
    assert.equal(renamed.completed_at, ticked.completed_at, "unchanged by a text edit");
    const { data: unticked } = await admin.from("task_checklist_items").update({ is_done: false }).eq("id", item.id).select().single();
    assert.equal(unticked.completed_at, null);
    const { data: supplied } = await admin.from("task_checklist_items").update({ is_done: true, completed_at: "2026-10-04T18:39:00Z" }).eq("id", item.id).select().single();
    assert.equal(new Date(supplied.completed_at).toISOString(), "2026-10-04T18:39:00.000Z", "a supplied value wins");
  });

  await test("059 rollup: actual_minutes = sum of the task's sessions (insert, update, move, delete → NULL); task-less sessions don't roll up", async () => {
    const t1 = await makeTask(userA, project.id, "Rollup 1");
    const t2 = await makeTask(userA, project.id, "Rollup 2");
    const base = { user_id: userA, project_id: project.id, session_date: "2026-10-04" };
    const s1 = await insert("work_sessions", { ...base, task_id: t1.id, minutes: 13 });
    const s2 = await insert("work_sessions", { ...base, task_id: t1.id, minutes: 61 });
    await insert("work_sessions", { ...base, task_id: null, minutes: 300 });
    assert.equal(await actualMinutes(t1.id), 74);
    await admin.from("work_sessions").update({ minutes: 60 }).eq("id", s2.id);
    assert.equal(await actualMinutes(t1.id), 73);
    await admin.from("work_sessions").update({ task_id: t2.id }).eq("id", s2.id);
    assert.deepEqual([await actualMinutes(t1.id), await actualMinutes(t2.id)], [13, 60]);
    await admin.from("work_sessions").delete().eq("id", s1.id);
    assert.equal(await actualMinutes(t1.id), null, "no sessions left → NULL");
    await admin.from("work_sessions").update({ note: "just a note" }).eq("id", s2.id);
    assert.equal(await actualMinutes(t2.id), 60);
  });

  await test("059 cascades: deleting a task keeps its sessions (task_id → NULL); deleting a project removes them", async () => {
    const doomedProject = await makeProject(userA, "Doomed");
    const t = await makeTask(userA, doomedProject.id, "Doomed task");
    const item = await makeItem(userA, t.id, "Row 1", { unit_count: 10, work_type: "sc" });
    const s = await insert("work_sessions", { user_id: userA, project_id: doomedProject.id, task_id: t.id, session_date: "2026-10-04", minutes: 9 });
    await insert("work_session_items", { session_id: s.id, checklist_item_id: item.id, user_id: userA });
    const { error: taskDelete } = await admin.from("tasks").delete().eq("id", t.id);
    assert.equal(taskDelete, null);
    const { data: orphan } = await admin.from("work_sessions").select("task_id").eq("id", s.id).single();
    assert.equal(orphan.task_id, null);
    const t2 = await makeTask(userA, doomedProject.id, "Doomed task 2");
    await insert("work_sessions", { user_id: userA, project_id: doomedProject.id, task_id: t2.id, session_date: "2026-10-04", minutes: 9 });
    const { error: projectDelete } = await admin.from("projects").delete().eq("id", doomedProject.id);
    assert.equal(projectDelete, null, projectDelete?.message);
    const { count } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("project_id", doomedProject.id);
    assert.equal(count, 0);
  });

  await test("059 ownership: a task from another project, another user's project, or a row from another project is rejected", async () => {
    const tOther = await makeTask(userA, otherProject.id, "Other project task");
    const iOther = await makeItem(userA, tOther.id, "Row 1");
    const base = { user_id: userA, project_id: project.id, session_date: "2026-10-04", minutes: 5 };
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, task_id: tOther.id })), "23503");
    const projectB = await makeProject(userB, "B private");
    assert.equal(errCode(await admin.from("work_sessions").insert({ ...base, project_id: projectB.id })), "23503");
    const s = await insert("work_sessions", base);
    assert.equal(errCode(await admin.from("work_session_items").insert({ session_id: s.id, checklist_item_id: iOther.id, user_id: userA })), "23503");
    const itemB = await makeItem(userB, (await makeTask(userB, projectB.id, "B task")).id, "Row 1");
    assert.equal(errCode(await admin.from("work_session_items").insert({ session_id: s.id, checklist_item_id: itemB.id, user_id: userA })), "23503");
  });

  await test("059 RLS: another user can't read, add to, change or delete someone's sessions or links", async () => {
    const t = await makeTask(userA, project.id, "RLS task");
    const item = await makeItem(userA, t.id, "Row 1", { unit_count: 5, work_type: "sc" });
    const s = await insert("work_sessions", { user_id: userA, project_id: project.id, task_id: t.id, session_date: "2026-10-04", minutes: 7 });
    await insert("work_session_items", { session_id: s.id, checklist_item_id: item.id, user_id: userA });
    const a = await userClient(userA);
    const b = await userClient(userB);
    const own = await a.from("work_sessions").select("id").eq("id", s.id);
    assert.equal(own.data.length, 1, "the owner reads it");
    const ownLinks = await a.from("work_session_items").select("session_id").eq("session_id", s.id);
    assert.equal(ownLinks.data.length, 1);
    assert.equal((await b.from("work_sessions").select("id").eq("id", s.id)).data.length, 0);
    assert.equal((await b.from("work_session_items").select("session_id").eq("session_id", s.id)).data.length, 0);
    const updated = await b.from("work_sessions").update({ minutes: 999 }).eq("id", s.id).select("id");
    assert.equal(updated.data.length, 0);
    const deleted = await b.from("work_sessions").delete().eq("id", s.id).select("id");
    assert.equal(deleted.data.length, 0);
    const forged = await b.from("work_sessions").insert({ user_id: userA, project_id: project.id, session_date: "2026-10-04", minutes: 5 });
    // Rejected either by the ownership trigger (B can't see A's project: 23503) or the RLS check (42501).
    assert.ok(["23503", "42501"].includes(errCode(forged)), `forged insert rejected, got ${errCode(forged)}`);
    const intoA = await b.from("work_sessions").insert({ user_id: userB, project_id: project.id, session_date: "2026-10-04", minutes: 5 });
    assert.equal(errCode(intoA), "23503", "B can't log against A's project");
    const linkForge = await b.from("work_session_items").insert({ session_id: s.id, checklist_item_id: item.id, user_id: userB });
    assert.ok(linkForge.error, "B can't link into A's session");
    assert.equal(await actualMinutes(t.id), 7, "A's rollup unchanged");
    const { count } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("project_id", project.id).eq("minutes", 999);
    assert.equal(count, 0);
  });


  await test("059 rollup under concurrency: two overlapping transactions logging sessions for one task keep both minutes", async () => {
    const t = await makeTask(userA, project.id, "Race task");
    const insertSql = (minutes) =>
      `INSERT INTO work_sessions (user_id, project_id, task_id, session_date, minutes) VALUES ('${userA}', '${project.id}', '${t.id}', '2026-10-04', ${minutes});`;
    const a = psqlConnection("A");
    const b = psqlConnection("B");
    try {
      a.send(`BEGIN; ${insertSql(10)} SELECT 'A-inserted';`);
      await a.waitFor("A-inserted");
      b.send(`BEGIN; ${insertSql(20)} COMMIT; SELECT 'B-done';`);
      await sleep(1500);
      assert.ok(!b.output().includes("B-done"), "B waits for A's rollup lock");
      a.send("COMMIT; SELECT 'A-done';");
      await a.waitFor("A-done");
      await b.waitFor("B-done");
    } finally {
      await a.end();
      await b.end();
    }
    assert.equal(await actualMinutes(t.id), 30, "10 + 20: neither commit lost the other's minutes");
  });


  await test("task move vs a new session on it, overlapping (both orders): exactly one wins", async () => {
    const insertFor = (taskId) =>
      `INSERT INTO work_sessions (user_id, project_id, task_id, session_date, minutes) VALUES ('${userA}', '${project.id}', '${taskId}', '2026-10-04', 7);`;
    const moveTo = (taskId) => `UPDATE tasks SET project_id = '${otherProject.id}' WHERE id = '${taskId}';`;
    // Move first, session second: the session must wait, then be rejected (its task is now elsewhere).
    const t1 = await makeTask(userA, project.id, "Race move first");
    const r1 = await overlap(moveTo(t1.id), insertFor(t1.id));
    assert.ok(r1.secondBlocked, "the session waited for the move");
    assert.match(r1.second, /ERROR/, "the session is rejected");
    const { data: m1 } = await admin.from("tasks").select("project_id").eq("id", t1.id).single();
    assert.equal(m1.project_id, otherProject.id);
    const { count: c1 } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("task_id", t1.id);
    assert.equal(c1, 0, "never both committed");
    // Session first, move second: the move must wait, then be rejected by the guard.
    const t2 = await makeTask(userA, project.id, "Race session first");
    const r2 = await overlap(insertFor(t2.id), moveTo(t2.id));
    assert.ok(r2.secondBlocked, "the move waited for the session");
    assert.match(r2.second, /ERROR: .*logged work sessions/);
    const { data: m2 } = await admin.from("tasks").select("project_id").eq("id", t2.id).single();
    assert.equal(m2.project_id, project.id);
    assert.equal(await actualMinutes(t2.id), 7);
  });

  await test("task move vs a project-level session linking its row, overlapping (both orders): exactly one wins", async () => {
    const linkFor = (itemId) =>
      `SELECT work_session_create('${userA}', '{"project_id": "${project.id}", "session_date": "2026-10-04", "minutes": 9}'::jsonb, ARRAY['${itemId}']::uuid[], false);`;
    const moveTo = (taskId) => `UPDATE tasks SET project_id = '${otherProject.id}' WHERE id = '${taskId}';`;
    const linkCount = async (itemId) => {
      const { count } = await admin.from("work_session_items").select("session_id", { count: "exact", head: true }).eq("checklist_item_id", itemId);
      return count;
    };
    const t1 = await makeTask(userA, project.id, "Link race move first");
    const i1 = await makeItem(userA, t1.id, "Row 1");
    const r1 = await overlap(moveTo(t1.id), linkFor(i1.id));
    assert.ok(r1.secondBlocked, "the link waited for the move");
    assert.match(r1.second, /ERROR/);
    assert.equal(await linkCount(i1.id), 0, "no link to a row now in another project");
    const t2 = await makeTask(userA, project.id, "Link race link first");
    const i2 = await makeItem(userA, t2.id, "Row 1");
    const r2 = await overlap(linkFor(i2.id), moveTo(t2.id));
    assert.ok(r2.secondBlocked, "the move waited for the link");
    assert.match(r2.second, /ERROR: .*logged work sessions/);
    assert.equal(await linkCount(i2.id), 1);
    const { data: m2 } = await admin.from("tasks").select("project_id").eq("id", t2.id).single();
    assert.equal(m2.project_id, project.id);
  });

  await test("session writes on one task still don't deadlock: two RPC sessions + a project-level link overlap cleanly", async () => {
    const t = await makeTask(userA, project.id, "No deadlock");
    const i = await makeItem(userA, t.id, "Row 1");
    const create = (minutes, taskPart, items) =>
      `SELECT work_session_create('${userA}', '{"project_id": "${project.id}", ${taskPart}"session_date": "2026-10-04", "minutes": ${minutes}}'::jsonb, ${items}, false);`;
    const r = await overlap(create(10, `"task_id": "${t.id}", `, "'{}'::uuid[]"), create(20, "", `ARRAY['${i.id}']::uuid[]`));
    assert.doesNotMatch(r.first + r.second, /ERROR|deadlock/);
    const r2 = await overlap(create(5, `"task_id": "${t.id}", `, `ARRAY['${i.id}']::uuid[]`), create(6, `"task_id": "${t.id}", `, "'{}'::uuid[]"));
    assert.doesNotMatch(r2.first + r2.second, /ERROR|deadlock/);
    assert.equal(await actualMinutes(t.id), 21, "10 + 5 + 6 (the project-level one doesn't roll up)");
  });

  await test("two RPC sessions touching the same two tasks in opposite order (A→B vs B→A) overlap without a deadlock, and both totals are right", async () => {
    const t1 = await makeTask(userA, project.id, "Opposite order 1");
    const t2 = await makeTask(userA, project.id, "Opposite order 2");
    const i1 = await makeItem(userA, t1.id, "Row 1");
    const i2 = await makeItem(userA, t2.id, "Row 1");
    // Session A is for task 1 and links task 2's row (locks 1 → 2); session B is for task 2 and links task 1's row (locks 2 → 1).
    const create = (taskId, minutes, itemId) =>
      `SELECT work_session_create('${userA}', '{"project_id": "${project.id}", "task_id": "${taskId}", "session_date": "2026-10-04", "minutes": ${minutes}}'::jsonb, ARRAY['${itemId}']::uuid[], false);`;
    const forward = await overlap(create(t1.id, 10, i2.id), create(t2.id, 20, i1.id));
    assert.ok(forward.secondBlocked, "B waited for A's task locks");
    assert.doesNotMatch(forward.first + forward.second, /ERROR|deadlock/);
    assert.equal(await actualMinutes(t1.id), 10);
    assert.equal(await actualMinutes(t2.id), 20);
    // And the other way round (B holds, A waits): again no deadlock, totals add up.
    const backward = await overlap(create(t2.id, 5, i1.id), create(t1.id, 7, i2.id));
    assert.ok(backward.secondBlocked, "A waited for B's task locks");
    assert.doesNotMatch(backward.first + backward.second, /ERROR|deadlock/);
    assert.equal(await actualMinutes(t1.id), 17, "10 + 7");
    assert.equal(await actualMinutes(t2.id), 25, "20 + 5");
  });

  await test("059 rollback after sessions exist keeps tasks.actual_minutes as last rolled up (the documented contract)", async () => {
    const t = await makeTask(userA, project.id, "Rollback task");
    await insert("work_sessions", { user_id: userA, project_id: project.id, task_id: t.id, session_date: "2026-10-04", minutes: 13 });
    assert.equal(await actualMinutes(t.id), 13);
    psql(ROLLBACK + "\nNOTIFY pgrst, 'reload schema';");
    assert.equal(psql("SELECT to_regclass('public.work_sessions') IS NULL;"), "t");
    assert.equal(psql(`SELECT actual_minutes FROM tasks WHERE id = '${t.id}';`), "13", "kept, not restored to NULL");
    await waitForSchema(false);
    psql(MIGRATION + "\nNOTIFY pgrst, 'reload schema';");
    await waitForSchema(true);
    assert.equal(await actualMinutes(t.id), 13, "re-apply doesn't recompute it either");
  });

  // ── Part 2: API + MCP ──────────────────────────────────────────────────
  const paceProject = await makeProject(userA, "Pace DB API project", { target_date: "2026-12-05" });
  const swatch = await makeTask(userA, paceProject.id, "Step 3: Swatch tree band", { estimated_minutes: 30, status: "Planned" });
  const body = await makeTask(userA, paceProject.id, "Step 11: Tree band 1", { estimated_minutes: 120, status: "Backlog" });
  const swatchRows = [];
  for (let row = 10; row <= 16; row += 1) swatchRows.push(await makeItem(userA, swatch.id, `Row ${row} (band row ${row - 6}): 5-wide row`, { sort_order: row }));
  const bodyRows = [];
  for (let row = 10; row <= 12; row += 1) bodyRows.push(await makeItem(userA, body.id, `Row ${row}: waffle Row A`, { sort_order: row }));

  await test("MCP update_project: unit_label + pace_settings stored; an invalid size is an error", async () => {
    const settings = { size: { label: "width", current: 195, step: 12, offset: 3, min: 27, unit: "stitches", work_types: ["colorwork-dc", "waffle"] } };
    const ok = await callTool("update_project", { project_id: paceProject.id, unit_label: "Stitches", pace_settings: settings });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.equal(ok.data.unit_label, "stitches");
    assert.deepEqual(ok.data.pace_settings, settings);
    const bad = await callTool("update_project", { project_id: paceProject.id, pace_settings: { size: { ...settings.size, current: 196 } } });
    assert.equal(bad.isError, true);
    assert.match(bad.data.error, /offset \+ step/);
  });

  await test("slice 2: update_project accepts perimeter + gauge; the forecast (MCP and API) returns lane sections and inch lengths", async () => {
    const lanesProject = await makeProject(userA, "Pace DB lanes", { target_date: "2026-12-05" });
    const mkSection = async (name, order, start, end) =>
      insert("project_sections", { user_id: userA, project_id: lanesProject.id, name, sort_order: order, planned_start: start, planned_end: end });
    const bodySection = await mkSection("Body", 1, "2026-10-19", "2026-11-29");
    const finishSection = await mkSection("Finishing", 2, "2026-11-30", "2026-12-05");
    const bodyTask = await makeTask(userA, lanesProject.id, "Body rows", { estimated_minutes: 100, unit_count: 1000, work_type: "waffle", section_id: bodySection.id });
    const borderTask = await makeTask(userA, lanesProject.id, "Border", { estimated_minutes: 100, unit_count: 1000, work_type: "sc", section_id: finishSection.id });
    const size = { label: "width", current: 195, step: 12, offset: 3, min: 27, unit: "stitches", work_types: ["waffle", "sc"] };
    const bad = await callTool("update_project", {
      project_id: lanesProject.id, unit_label: "stitches",
      pace_settings: { size: { ...size, perimeter: { task_ids: ["nope"], side: 300 }, gauge: { units: 18, length: 4, length_unit: "in" } } },
    });
    assert.equal(bad.isError, true, "a non-uuid perimeter task id is rejected");
    const settings = { size: { ...size, perimeter: { task_ids: [borderTask.id], side: 300 }, gauge: { units: 18, length: 4, length_unit: "in" } } };
    const ok = await callTool("update_project", { project_id: lanesProject.id, unit_label: "stitches", pace_settings: settings });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.pace_settings, settings, "perimeter and gauge are stored, not stripped");
    for (let n = 0; n < 3; n += 1) {
      const logged = await callTool("log_work_session", { task_id: bodyTask.id, date: "2026-10-04", minutes: 28 });
      assert.equal(logged.isError, false, JSON.stringify(logged.data));
    }
    const forecast = await callTool("get_project_forecast", { project_id: lanesProject.id, today: "2026-10-04" });
    assert.equal(forecast.isError, false, JSON.stringify(forecast.data));
    const f = forecast.data.forecast;
    assert.deepEqual(f.sections.map((entry) => entry.section_id), [bodySection.id, finishSection.id]);
    const body = f.sections[0];
    assert.deepEqual([body.planned_start, body.planned_end, body.units_left, body.health_basis], ["2026-10-19", "2026-11-29", 1000, "time"]);
    assert.ok(["on_track", "behind"].includes(body.health));
    assert.ok(body.projected_end > body.planned_end, "6 min a day against 100 min of work runs past Nov 29");
    assert.equal(body.health, "behind");
    const widths = f.size_fit.widths;
    assert.equal(widths.at(-1).size, 195);
    assert.equal(widths.at(-1).length, 43.3, "195 ÷ 18 × 4 in");
    assert.equal(widths.at(-1).length_unit, "in");
    assert.ok(f.size_fit.perimeter_minutes_left > 0);
    assert.equal(f.size_fit.current_length, 43.3);
    // The same through the HTTP route.
    const response = await forecastRoute.GET(
      new NextRequest(`http://localhost/api/projects/${lanesProject.id}/forecast?today=2026-10-04`, { headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY } }),
      { params: Promise.resolve({ id: lanesProject.id }) }
    );
    assert.equal(response.status, 200);
    const viaApi = await response.json();
    assert.equal(viaApi.forecast.sections.length, 2);
    assert.equal(viaApi.forecast.size_fit.widths.at(-1).length, 43.3);
    // The border (perimeter) shrinks less than linear: 27 wide leaves more than 27/195 of the work.
    const at27 = widths.find((entry) => entry.size === 27);
    assert.ok(at27.minutes_left > (200 * 27) / 195 + 10, "perimeter scaling, not linear");
  });

  await test("MCP update_task_checklist: units + work type; invalid → nothing written; missing row → reported, not skipped", async () => {
    const ok = await callTool("update_task_checklist", {
      task_id: swatch.id,
      items: swatchRows.map((row) => ({ id: row.id, unit_count: 27, work_type: "colorwork-dc" })),
    });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.equal(ok.data.length, swatchRows.length);
    await callTool("update_task_checklist", { task_id: body.id, items: bodyRows.map((row) => ({ id: row.id, unit_count: 195, work_type: "waffle" })) });
    const invalid = await callTool("update_task_checklist", { task_id: swatch.id, items: [{ id: swatchRows[0].id, unit_count: 30 }, { id: swatchRows[1].id, work_type: "Bad Type" }] });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.data.failed[0].index, 1);
    const { data: unchanged } = await admin.from("task_checklist_items").select("unit_count").eq("id", swatchRows[0].id).single();
    assert.equal(Number(unchanged.unit_count), 27, "validated first: nothing written");
    const partial = await callTool("update_task_checklist", { task_id: swatch.id, items: [{ id: swatchRows[0].id, is_done: false }, { id: bodyRows[0].id, is_done: true }] });
    assert.equal(partial.isError, true, "207 is reported as an error");
    assert.deepEqual(partial.data.failed, [{ id: bodyRows[0].id, error: "not found on this task" }]);
    assert.equal(partial.data.updated.length, 1);
    const empty = await callTool("update_task_checklist", { task_id: swatch.id, items: [{ id: swatchRows[0].id }] });
    assert.equal(empty.isError, true, "an item needs at least one field");
  });

  await test("MCP create_task / update_task: unit_count, work_type, is_sample", async () => {
    const created = await callTool("create_task", { title: "Border round 1", project_id: paceProject.id, unit_count: 970, work_type: "sc", is_sample: false, tags: ["personal"] });
    assert.equal(created.isError, false, JSON.stringify(created.data));
    assert.deepEqual([Number(created.data.unit_count), created.data.work_type, created.data.is_sample], [970, "sc", false]);
    const updated = await callTool("update_task", { task_id: swatch.id, is_sample: true });
    assert.equal(updated.isError, false);
    assert.equal(updated.data.is_sample, true);
    const bad = await callTool("update_task", { task_id: swatch.id, unit_count: -3 });
    assert.equal(bad.isError, true);
    const badType = await callTool("create_task", { title: "x", work_type: "Not A Slug" });
    assert.equal(badType.isError, true);
  });

  let loggedId;
  await test("MCP log_work_session: rows + ET times → session, rows ticked at the end time, rollup, one-line forecast", async () => {
    const result = await callTool("log_work_session", { task_id: swatch.id, date: "2026-10-04", start: "13:38", end: "2:39 PM", rows: "11-15" });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    const { session, summary, marked_done } = result.data;
    loggedId = session.id;
    assert.deepEqual([session.minutes, session.started_at.slice(0, 16), session.ended_at.slice(0, 16), session.source, session.project_id],
      [61, "2026-10-04T17:38", "2026-10-04T18:39", "agent", paceProject.id]);
    assert.equal(session.item_ids.length, 5);
    assert.equal(marked_done, 5);
    const { data: rows } = await admin.from("task_checklist_items").select("text, is_done, completed_at").in("id", session.item_ids);
    assert.ok(rows.every((row) => row.is_done && new Date(row.completed_at).toISOString() === "2026-10-04T18:39:00.000Z"));
    assert.equal(await actualMinutes(swatch.id), 61);
    assert.match(summary, /^Colorwork dc 27\.1 s\/stitch \(swatch, 1 session\)/);
    assert.match(summary, /needs \d+ min\/day to finish by Dec 5/);
    assert.match(summary, /at 60 min\/day a \d+-stitch width fits/);
  });

  await test("log_work_session errors: ambiguous / missing rows (never guesses), minutes disagree, task not in project, rows from another project", async () => {
    const ambiguous = await callTool("log_work_session", { project_id: paceProject.id, minutes: 10, rows: "10-12" });
    assert.equal(ambiguous.isError, true);
    assert.deepEqual(ambiguous.data.details.ambiguous_rows.map((entry) => entry.row), [10, 11, 12]);
    const missing = await callTool("log_work_session", { task_id: swatch.id, minutes: 10, rows: "16-18" });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.data.details.missing_rows, [17, 18]);
    const disagree = await callTool("log_work_session", { task_id: swatch.id, start: "13:00", end: "14:00", minutes: 20 });
    assert.equal(disagree.isError, true);
    assert.match(disagree.data.error, /disagree/);
    const wrongProject = await callTool("log_work_session", { task_id: swatch.id, project_id: otherProject.id, minutes: 10 });
    assert.equal(wrongProject.isError, true);
    const otherTask = await makeTask(userA, otherProject.id, "Elsewhere");
    const otherItem = await makeItem(userA, otherTask.id, "Row 1");
    const foreignItem = await callTool("log_work_session", { project_id: paceProject.id, minutes: 10, item_ids: [otherItem.id] });
    assert.equal(foreignItem.isError, true);
    assert.deepEqual(foreignItem.data.details.not_found, [otherItem.id]);
    const none = await callTool("log_work_session", { minutes: 10 });
    assert.equal(none.isError, true);
    const { count } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("project_id", paceProject.id).gte("created_at", new Date(Date.now() - 60_000).toISOString()).neq("id", loggedId);
    assert.equal(count, 0, "no failed call left a session behind");
  });

  await test("MCP log_work_session: a project-level excluded sitting rolls up to no task; counts for cadence, not speed", async () => {
    const result = await callTool("log_work_session", {
      project_id: paceProject.id, date: "2026-10-03", minutes: 300, item_ids: [swatchRows[0].id], exclude_from_stats: true, exclude_reason: "learning", mark_items_done: false,
    });
    assert.equal(result.isError, false, JSON.stringify(result.data));
    assert.equal(result.data.session.task_id, null);
    assert.equal(result.data.marked_done, 0);
    assert.equal(await actualMinutes(swatch.id), 61);
    const forecast = await callTool("get_project_forecast", { project_id: paceProject.id, today: "2026-10-04" });
    assert.equal(forecast.isError, false);
    const f = forecast.data.forecast;
    assert.equal(f.counted_sessions, 1);
    assert.equal(f.excluded_sessions, 1);
    assert.equal(f.cadence_minutes_per_day, 25.8, "(300 + 61) ÷ 14");
    const colorwork = f.measured_speeds.find((speed) => speed.work_type === "colorwork-dc");
    assert.deepEqual([colorwork.scope, colorwork.seconds_per_unit, colorwork.n_sessions], ["sample", 27.11, 1]);
    assert.match(colorwork.label, /swatch\/sample/);
  });

  await test("MCP list_work_sessions / update_work_session / delete_work_session (rows stay ticked)", async () => {
    const all = await callTool("list_work_sessions", { project_id: paceProject.id });
    assert.equal(all.isError, false);
    assert.ok(all.data.sessions.length >= 2);
    const byTask = await callTool("list_work_sessions", { task_id: swatch.id });
    assert.deepEqual(byTask.data.sessions.map((session) => session.id), [loggedId]);
    const since = await callTool("list_work_sessions", { project_id: paceProject.id, since: "2026-10-04" });
    assert.ok(since.data.sessions.every((session) => session.session_date >= "2026-10-04"));

    const excluded = await callTool("update_work_session", { session_id: loggedId, exclude_from_stats: true, exclude_reason: "interrupted", minutes: 60 });
    assert.equal(excluded.isError, false, JSON.stringify(excluded.data));
    assert.deepEqual([excluded.data.session.exclude_from_stats, excluded.data.session.minutes], [true, 60]);
    assert.equal(await actualMinutes(swatch.id), 60, "rollup follows the edit");
    const badEdit = await callTool("update_work_session", { session_id: loggedId, start: "15:00", end: "14:00" });
    assert.equal(badEdit.isError, true);
    const rows = await callTool("update_work_session", { session_id: loggedId, rows: "16" });
    assert.equal(rows.isError, false);
    assert.deepEqual(rows.data.session.item_ids, [swatchRows[6].id]);

    const deleted = await callTool("delete_work_session", { session_id: loggedId });
    assert.equal(deleted.isError, false);
    assert.equal(await actualMinutes(swatch.id), null);
    const { data: stillTicked } = await admin.from("task_checklist_items").select("is_done").in("id", swatchRows.slice(1, 6).map((row) => row.id));
    assert.ok(stillTicked.every((row) => row.is_done), "rows it ticked stay ticked");
    const again = await callTool("delete_work_session", { session_id: loggedId });
    assert.equal(again.isError, true, "404 the second time");
  });

  await test("MCP get_pace_rates: measured speeds across projects with the unit, sample labelled; other_projects tier", async () => {
    // A second stitches project with a counted main-scope waffle session.
    const p2 = await makeProject(userA, "Scarf", { unit_label: "stitches" });
    const t2 = await makeTask(userA, p2.id, "Scarf rows");
    const i2 = await makeItem(userA, t2.id, "Row 1: waffle Row A", { unit_count: 100, work_type: "waffle" });
    await logWorkSession(admin, userA, { task_id: t2.id, minutes: 20, item_ids: [i2.id], date: "2026-10-02" });
    const rates = await callTool("get_pace_rates", { unit_label: "stitches", work_type: "waffle" });
    assert.equal(rates.isError, false, JSON.stringify(rates.data));
    assert.deepEqual(rates.data.rates.map((rate) => [rate.work_type, rate.scope, rate.seconds_per_unit]), [["waffle", "main", 12]]);
    const { forecast } = await getProjectForecast(admin, userA, paceProject.id, { today: "2026-10-04" });
    const waffle = forecast.work_left.find((row) => row.work_type === "waffle");
    assert.deepEqual([waffle.source, waffle.seconds_per_unit], ["other_projects", 12]);
    const missing = await callTool("get_pace_rates", { unit_label: "" });
    assert.equal(missing.isError, true);
  });


  // ── Fix round 1 ─────────────────────────────────────────────────────────
  await test("RPC atomicity: a failing create or update leaves the previous state (no session, links and fields unchanged)", async () => {
    const t = await makeTask(userA, paceProject.id, "Atomic task");
    const keep = await makeItem(userA, t.id, "Row 1", { unit_count: 10, work_type: "sc" });
    const elsewhere = await makeItem(userA, (await makeTask(userA, otherProject.id, "Elsewhere 2")).id, "Row 1");
    const created = await admin.rpc("work_session_create", {
      p_user_id: userA,
      p_session: { project_id: paceProject.id, task_id: t.id, session_date: "2026-10-04", minutes: 15, source: "manual", source_ref: "atomic-1" },
      p_item_ids: [keep.id, elsewhere.id],
      p_mark_done: true,
    });
    assert.ok(created.error, "an out-of-scope row fails the create");
    const { count } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("source_ref", "atomic-1");
    assert.equal(count, 0, "no half-written session");
    const { data: keepRow } = await admin.from("task_checklist_items").select("is_done").eq("id", keep.id).single();
    assert.equal(keepRow.is_done, false, "no row ticked");
    assert.equal(await actualMinutes(t.id), null);

    const ok = await admin.rpc("work_session_create", {
      p_user_id: userA,
      p_session: { project_id: paceProject.id, task_id: t.id, session_date: "2026-10-04", minutes: 15, source: "manual" },
      p_item_ids: [keep.id],
      p_mark_done: true,
    });
    assert.equal(ok.error, null, ok.error?.message);
    const sessionId = ok.data.session_id;
    assert.equal(ok.data.marked_done, 1);
    const bad = await admin.rpc("work_session_update", {
      p_user_id: userA, p_session_id: sessionId, p_changes: { minutes: 99, note: "changed" }, p_item_ids: [elsewhere.id],
    });
    assert.ok(bad.error, "an out-of-scope replacement row fails the update");
    const { data: after } = await admin.from("work_sessions").select("minutes, note").eq("id", sessionId).single();
    assert.deepEqual(after, { minutes: 15, note: null }, "fields unchanged");
    const { data: links } = await admin.from("work_session_items").select("checklist_item_id").eq("session_id", sessionId);
    assert.deepEqual(links.map((row) => row.checklist_item_id), [keep.id], "old links kept");
    assert.equal(await actualMinutes(t.id), 15);
    const otherUser = await admin.rpc("work_session_delete", { p_user_id: userB, p_session_id: sessionId });
    assert.equal(otherUser.error?.code, "P0002", "another user's session is not found");
  });

  await test("moving a task with logged sessions or linked rows to another project is rejected (409 API, DB guard); others move", async () => {
    const withSession = await makeTask(userA, paceProject.id, "Has a session");
    await logWorkSession(admin, userA, { task_id: withSession.id, minutes: 5, date: "2026-10-04" });
    const viaApi = await callTool("update_task", { task_id: withSession.id, project_id: otherProject.id });
    assert.equal(viaApi.isError, true);
    assert.match(viaApi.data.error, /work session/i);
    const direct = await admin.from("tasks").update({ project_id: otherProject.id }).eq("id", withSession.id);
    assert.equal(errCode(direct), "55006", "the DB guard covers every writer");
    const linkedOnly = await makeTask(userA, paceProject.id, "Only linked by a project-level session");
    const row = await makeItem(userA, linkedOnly.id, "Row 1");
    await logWorkSession(admin, userA, { project_id: paceProject.id, minutes: 5, item_ids: [row.id], date: "2026-10-04" });
    assert.equal(errCode(await admin.from("tasks").update({ project_id: otherProject.id }).eq("id", linkedOnly.id)), "55006");
    assert.equal(errCode(await admin.from("tasks").update({ project_id: null }).eq("id", linkedOnly.id)), "55006", "unlinking counts as a move");
    const linkedViaApi = await callTool("update_task", { task_id: linkedOnly.id, project_id: otherProject.id });
    assert.equal(linkedViaApi.isError, true);
    assert.match(linkedViaApi.data.error, /work session/i, "the DB guard's 55006 comes back as a plain 409");
    // A task with many rows: the move check must not build an over-long request.
    const big = await makeTask(userA, paceProject.id, "Many rows");
    const { data: bigRows, error: bigError } = await admin.from("task_checklist_items")
      .insert(Array.from({ length: 700 }, (_, n) => ({ user_id: userA, task_id: big.id, text: `Row ${n + 1}`, sort_order: n })))
      .select("id");
    if (bigError) throw bigError;
    await logWorkSession(admin, userA, { project_id: paceProject.id, minutes: 5, item_ids: [bigRows[699].id], date: "2026-10-04" });
    const bigMove = await callTool("update_task", { task_id: big.id, project_id: otherProject.id });
    assert.equal(bigMove.isError, true);
    assert.match(bigMove.data.error, /work session/i, "409, not a 500 from a long URL");
    const bigFree = await makeTask(userA, paceProject.id, "Many rows, no sessions");
    await admin.from("task_checklist_items").insert(Array.from({ length: 700 }, (_, n) => ({ user_id: userA, task_id: bigFree.id, text: `Row ${n + 1}`, sort_order: n })));
    const bigFreeMove = await callTool("update_task", { task_id: bigFree.id, project_id: otherProject.id });
    assert.equal(bigFreeMove.isError, false, JSON.stringify(bigFreeMove.data).slice(0, 300));
    // The route itself answers 409 (not just an error string in the MCP wrapper): a task with a session, and one only linked by a project-level session.
    const patchTask = async (id, payload) => {
      const response = await taskRoute.PATCH(
        new NextRequest(`http://localhost/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        { params: Promise.resolve({ id }) }
      );
      return { status: response.status, body: await response.json() };
    };
    const sessionMove = await patchTask(withSession.id, { project_id: otherProject.id });
    assert.equal(sessionMove.status, 409, "HTTP 409 for a task with a session");
    assert.match(sessionMove.body.error, /work session/i);
    const linkedMove = await patchTask(linkedOnly.id, { project_id: otherProject.id });
    assert.equal(linkedMove.status, 409, "HTTP 409 for a task only linked by a project-level session");
    const bigMoveHttp = await patchTask(big.id, { project_id: otherProject.id });
    assert.equal(bigMoveHttp.status, 409, "HTTP 409, not a 500, for a task with 700 rows");
    const unlinkHttp = await patchTask(withSession.id, { project_id: null });
    assert.equal(unlinkHttp.status, 409, "unlinking is a move too");
    const okHttp = await patchTask(bigFree.id, { title: "Renamed, not moved" });
    assert.equal(okHttp.status, 200);
    const free = await makeTask(userA, paceProject.id, "No sessions");
    const moved = await callTool("update_task", { task_id: free.id, project_id: otherProject.id });
    assert.equal(moved.isError, false, JSON.stringify(moved.data));
    const sameProject = await callTool("update_task", { task_id: withSession.id, project_id: paceProject.id, title: "Renamed" });
    assert.equal(sameProject.isError, false, "re-sending the same project is not a move");
  });

  await test("log_work_session idempotency_key: a retried call returns the first session instead of logging twice", async () => {
    const t = await makeTask(userA, paceProject.id, "Retry task");
    const first = await callTool("log_work_session", { task_id: t.id, minutes: 12, date: "2026-10-04", idempotency_key: "chat-msg-42" });
    assert.equal(first.isError, false, JSON.stringify(first.data));
    const again = await callTool("log_work_session", { task_id: t.id, minutes: 12, date: "2026-10-04", idempotency_key: "chat-msg-42" });
    assert.equal(again.isError, false, JSON.stringify(again.data));
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.session.id, first.data.session.id);
    const { count } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("task_id", t.id);
    assert.equal(count, 1);
    assert.equal(await actualMinutes(t.id), 12);
    assert.equal(again.data.forecast_line, first.data.forecast_line, "the retry describes the same project");
    // The same key for a different sitting (another task / project) is rejected, not answered with the old session.
    const otherTask = await makeTask(userA, otherProject.id, "Retry elsewhere");
    const mismatch = await callTool("log_work_session", { task_id: otherTask.id, minutes: 12, date: "2026-10-04", idempotency_key: "chat-msg-42" });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.data.error, /idempotency_key/);
    const sameProjectOtherTask = await makeTask(userA, paceProject.id, "Retry sibling");
    const mismatchTask = await callTool("log_work_session", { task_id: sameProjectOtherTask.id, minutes: 12, date: "2026-10-04", idempotency_key: "chat-msg-42" });
    assert.equal(mismatchTask.isError, true, "a different task in the same project is a different target too");
    const { count: total } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("source_ref", "client:chat-msg-42");
    assert.equal(total, 1);
  });

  await test("dates: date and ISO start must agree; PATCHing only the date moves the stored start/end to that day", async () => {
    const t = await makeTask(userA, paceProject.id, "Date task");
    const mismatch = await callTool("log_work_session", { task_id: t.id, date: "2026-10-03", start: "2026-10-04T17:38:00Z", end: "2026-10-04T18:39:00Z" });
    assert.equal(mismatch.isError, true);
    const logged = await callTool("log_work_session", { task_id: t.id, date: "2026-10-04", start: "13:38", end: "14:39" });
    assert.equal(logged.isError, false, JSON.stringify(logged.data));
    const moved = await callTool("update_work_session", { session_id: logged.data.session.id, date: "2026-10-03" });
    assert.equal(moved.isError, false, JSON.stringify(moved.data));
    const s = moved.data.session;
    assert.deepEqual([s.session_date, new Date(s.started_at).toISOString(), new Date(s.ended_at).toISOString(), s.minutes],
      ["2026-10-03", "2026-10-03T17:38:00.000Z", "2026-10-03T18:39:00.000Z", 61]);
    // Across the Nov 1 fall-back: 00:30–03:30 ET on Oct 31 is 180 min; moving only the date keeps 180 min.
    const night = await callTool("log_work_session", { task_id: t.id, date: "2026-10-31", start: "00:30", end: "03:30" });
    assert.equal(night.isError, false, JSON.stringify(night.data));
    const dst = await callTool("update_work_session", { session_id: night.data.session.id, date: "2026-11-01" });
    assert.equal(dst.isError, false, JSON.stringify(dst.data));
    assert.deepEqual([dst.data.session.session_date, new Date(dst.data.session.started_at).toISOString(), new Date(dst.data.session.ended_at).toISOString(), dst.data.session.minutes],
      ["2026-11-01", "2026-11-01T04:30:00.000Z", "2026-11-01T07:30:00.000Z", 180]);
    // Date AND minutes together, across the same change: start keeps its ET clock time, end = start + the minutes (was a 400).
    const night2 = await callTool("log_work_session", { task_id: t.id, date: "2026-10-31", start: "00:30", end: "03:30" });
    const dstMinutes = await callTool("update_work_session", { session_id: night2.data.session.id, date: "2026-11-01", minutes: 180 });
    assert.equal(dstMinutes.isError, false, JSON.stringify(dstMinutes.data));
    assert.deepEqual(
      [dstMinutes.data.session.session_date, new Date(dstMinutes.data.session.started_at).toISOString(), new Date(dstMinutes.data.session.ended_at).toISOString(), dstMinutes.data.session.minutes],
      ["2026-11-01", "2026-11-01T04:30:00.000Z", "2026-11-01T07:30:00.000Z", 180]
    );
    const longer = await callTool("update_work_session", { session_id: night2.data.session.id, date: "2026-11-02", minutes: 90 });
    assert.equal(longer.isError, false, JSON.stringify(longer.data));
    assert.deepEqual(
      [longer.data.session.minutes, new Date(longer.data.session.started_at).toISOString(), new Date(longer.data.session.ended_at).toISOString()],
      [90, "2026-11-02T05:30:00.000Z", "2026-11-02T07:00:00.000Z"],
      "a new date and new minutes: start at the same ET clock time (00:30 EST), end = start + 90"
    );
    // Explicit start/end in the body still win and must agree with the minutes.
    const clash = await callTool("update_work_session", { session_id: night2.data.session.id, date: "2026-11-03", start: "01:00", minutes: 30, end: "03:00" });
    assert.equal(clash.isError, true, "start–end 120 min vs minutes 30 still disagree");
    const badStart = await callTool("update_work_session", { session_id: s.id, start: "2026-10-05T17:00:00Z" });
    assert.equal(badStart.isError, true, "an ISO start on another day than the stored date");
  });

  await test("input edges: fractional minutes → 400; non-UUID checklist id → 400; get_pace_rates matches 'Stitches'", async () => {
    const t = await makeTask(userA, paceProject.id, "Edges task");
    const request = new NextRequest("http://localhost/api/work-sessions", {
      method: "POST",
      headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ task_id: t.id, minutes: 0.6 }),
    });
    const response = await workSessionsRoute.POST(request);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /whole number/);
    const badId = await callTool("update_task_checklist", { task_id: t.id, items: [{ id: "not-a-uuid", is_done: true }] });
    assert.equal(badId.isError, true);
    assert.match(badId.data.failed[0].error, /UUID/);
    const rates = await callTool("get_pace_rates", { unit_label: "Stitches" });
    assert.equal(rates.isError, false);
    assert.ok(rates.data.rates.length > 0, "unit_label is matched case-insensitively");
  });

  await test("another user's ids: forecast, log, list, update and delete all fail without leaking", async () => {
    const s = await logWorkSession(admin, userA, { task_id: swatch.id, minutes: 5 });
    process.env.MISSION_CONTROL_USER_ID = userB;
    try {
      const forecast = await callTool("get_project_forecast", { project_id: paceProject.id });
      assert.equal(forecast.isError, true);
      assert.match(forecast.data.error, /not found/i);
      assert.equal((await callTool("log_work_session", { task_id: swatch.id, minutes: 5 })).isError, true);
      const list = await callTool("list_work_sessions", { project_id: paceProject.id });
      assert.deepEqual(list.data.sessions, []);
      assert.equal((await callTool("update_work_session", { session_id: s.session.id, minutes: 50 })).isError, true);
      assert.equal((await callTool("delete_work_session", { session_id: s.session.id })).isError, true);
      const rates = await callTool("get_pace_rates", { unit_label: "stitches" });
      assert.deepEqual(rates.data.rates, []);
    } finally {
      process.env.MISSION_CONTROL_USER_ID = userA;
    }
    const { data } = await admin.from("work_sessions").select("minutes").eq("id", s.session.id).single();
    assert.equal(data.minutes, 5);
  });

  // ── Part 3: the blanket snapshot through the backfill CLI ───────────────
  if (snapshotPath) {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const userC = await makeUser("pace-blanket");
    await test("snapshot seeded locally (same ids) under a throwaway user", async () => {
      await insert("projects", { id: snapshot.project.id, user_id: userC, name: snapshot.project.name, target_date: snapshot.project.target_date, tags: snapshot.project.tags });
      for (const section of snapshot.sections) {
        await insert("project_sections", { ...section, user_id: userC, project_id: snapshot.project.id });
      }
      for (const task of snapshot.tasks) {
        await insert("tasks", {
          id: task.id, user_id: userC, project_id: snapshot.project.id, section_id: task.section_id, title: task.title,
          status: task.status, estimated_minutes: task.estimated_minutes, tags: task.tags,
        });
        for (const item of task.checklist) {
          await insert("task_checklist_items", { id: item.id, user_id: userC, task_id: task.id, text: item.text, is_done: item.is_done, sort_order: item.sort_order });
        }
        for (const comment of task.comments ?? []) {
          await insert("task_comments", { id: comment.id, user_id: userC, task_id: task.id, content: comment.content, created_at: comment.created_at, source: "manual" });
        }
      }
      // Rows ticked before 059 have no completed_at: clear the insert-time stamps to match.
      psql(`UPDATE task_checklist_items SET completed_at = NULL WHERE user_id = '${userC}';`);
    });

    const runCli = (extra) => execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--loader", "./scripts/alias-loader.mjs", "scripts/pace-backfill.mjs", "--today", "2026-10-04", ...extra],
      { encoding: "utf8", env: { ...process.env, PACE_BACKFILL_SUPABASE_URL: url, PACE_BACKFILL_SERVICE_ROLE_KEY: serviceKey }, stdio: ["ignore", "pipe", "pipe"] }
    );

    await test("backfill CLI: dry run writes nothing; --apply writes; a second --apply creates nothing new", async () => {
      const dry = runCli([]);
      assert.match(dry, /Dry run: nothing written/);
      assert.match(dry, /Couldn't match \(0\)/);
      const { count: before } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("user_id", userC);
      assert.equal(before, 0);
      const applied = runCli(["--apply"]);
      const result = JSON.parse(/Applied: (\{.*\})/.exec(applied)[1]);
      assert.deepEqual([result.sessions_created, result.sessions_skipped, result.tasks_updated, result.items_tagged, result.completed_at_set], [3, 0, 16, 167, 16]);
      const again = JSON.parse(/Applied: (\{.*\})/.exec(runCli(["--apply"]))[1]);
      assert.deepEqual([again.sessions_created, again.sessions_skipped, again.completed_at_set], [0, 3, 0]);
      const { count: after } = await admin.from("work_sessions").select("id", { count: "exact", head: true }).eq("user_id", userC);
      assert.equal(after, 3);
      console.log(`    dry-run forecast: ${/Forecast after the backfill[^\n]*\n {2}([^\n]*)/.exec(dry)[1]}`);
    });

    await test("acceptance: the blanket forecast on Oct 4 after the backfill", async () => {
      const { forecast, line } = await getProjectForecast(admin, userC, snapshot.project.id, { today: "2026-10-04" });
      const colorwork = forecast.work_left.find((row) => row.work_type === "colorwork-dc");
      assert.deepEqual([colorwork.source, colorwork.n_sessions], ["measured_sample", 1]);
      assert.ok(Math.abs(colorwork.seconds_per_unit - 27.1) < 0.05, `27.1 s/stitch, got ${colorwork.seconds_per_unit}`);
      assert.equal(forecast.counted_sessions, 1);
      assert.equal(forecast.excluded_sessions, 2);
      assert.equal(forecast.cadence_minutes_per_day, 26.7, "374 ÷ 14");
      assert.equal(forecast.plan_ratio.basis, "sample");
      assert.ok(Math.abs(forecast.plan_ratio.ratio - 3.5) < 0.05, `≈3.5×, got ${forecast.plan_ratio.ratio}`);
      for (const row of forecast.work_left.filter((r) => r.work_type !== "colorwork-dc")) assert.equal(row.source, "plan_x_ratio", row.work_type);
      assert.equal(forecast.health, "insufficient_data");
      assert.notEqual(forecast.size_fit, null);
      assert.equal(await actualMinutes("93f3c74e-ecd0-4a8a-a548-d26c19332847"), 74, "step 3: 13 + 61; Oct 3 is project-level");
      console.log(`    ${line}`);
      console.log(`    work left ${forecast.work_left_minutes} min (${forecast.work_left_hours} h), needs ${forecast.needed_minutes_per_day} min/day over ${forecast.available_days} days; widths ${forecast.size_fit.fits.map((fit) => `${fit.minutes_per_day}→${fit.widest ?? "none"}`).join(", ")}`);
    });
  } else {
    console.log("(Part 3 skipped: set PACE_TEST_SNAPSHOT to run the blanket backfill acceptance check)");
  }
} finally {
  globalThis.fetch = realFetch;
  for (const id of users) {
    await admin.from("work_sessions").delete().eq("user_id", id);
    await admin.from("tasks").delete().eq("user_id", id);
    await admin.from("projects").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
