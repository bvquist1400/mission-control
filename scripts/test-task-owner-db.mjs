#!/usr/bin/env node
// Database tests for task owner + status line (migration 056), run against a
// LOCAL Supabase stack with every migration applied:
//
//   OWNER_TEST_SUPABASE_URL=http://127.0.0.1:56321 \
//   OWNER_TEST_ANON_KEY=... OWNER_TEST_SERVICE_ROLE_KEY=... \
//   npm run test:task-owner-db
//
// Part 1 checks the migration's defaults and constraints directly. Part 2 drives
// the real MCP tools (create_task / update_task / list_tasks) through the real
// /api/mcp handler; the tools' internal fetch to the API is routed to the real
// /api/tasks handlers in-process, which write to the local stack as a throwaway
// user. The user is deleted at the end.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.OWNER_TEST_SUPABASE_URL;
const anonKey = process.env.OWNER_TEST_ANON_KEY;
const serviceKey = process.env.OWNER_TEST_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("Set OWNER_TEST_SUPABASE_URL, OWNER_TEST_ANON_KEY and OWNER_TEST_SERVICE_ROLE_KEY (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users. Local stacks only.`);
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const email = `owner-test-${randomUUID().slice(0, 8)}@example.test`;
const { data: created, error: createUserError } = await admin.auth.admin.createUser({
  email,
  password: randomUUID(),
  email_confirm: true,
});
if (createUserError) throw createUserError;
const userId = created.user.id;

// The route handlers read these; point them at the local stack and the test user.
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.MISSION_CONTROL_API_KEY = `owner-test-${randomUUID()}`;
process.env.MISSION_CONTROL_USER_ID = userId;
process.env.DEPLOYMENT_ROLE = "main";
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;

const tasksRoute = await import("../src/app/api/tasks/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const { NextRequest } = await import("next/server.js");

// The MCP tools fetch the API over HTTP; route those calls to the handlers above.
const realFetch = globalThis.fetch;
const apiCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  // The MCP layer rewrites the tools' legacy origin to the request's own origin.
  const isApi = ["mission-control-orpin-chi.vercel.app", "localhost"].includes(target.hostname)
    && target.pathname.startsWith("/api/");
  if (!isApi) {
    return realFetch(input, init);
  }
  const request = new NextRequest(`http://localhost${target.pathname}${target.search}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
  apiCalls.push(`${request.method} ${target.pathname}${target.search}`);
  const match = /^\/api\/tasks\/([^/]+)$/.exec(target.pathname);
  if (target.pathname === "/api/tasks") {
    return request.method === "POST" ? tasksRoute.POST(request) : tasksRoute.GET(request);
  }
  if (match && request.method === "PATCH") {
    return taskRoute.PATCH(request, { params: Promise.resolve({ id: match[1] }) });
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

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

try {
  // ── Part 1: the migration ───────────────────────────────────────────────
  await test("056: a task inserted without owner fields gets owner 'agent' and no label or line", async () => {
    const { data, error } = await admin
      .from("tasks")
      .insert({ user_id: userId, title: "Legacy insert" })
      .select("owner, owner_label, status_line")
      .single();
    if (error) throw error;
    assert.deepEqual(data, { owner: "agent", owner_label: null, status_line: null });
  });

  await test("056: the owner check rejects anything but brent/agent, and owner can't be null", async () => {
    const bad = await admin.from("tasks").insert({ user_id: userId, title: "Bad owner", owner: "bob" });
    assert.equal(bad.error?.code, "23514");
    assert.match(bad.error.message, /tasks_owner_check/);
    const nul = await admin.from("tasks").insert({ user_id: userId, title: "Null owner", owner: null });
    assert.equal(nul.error?.code, "23502");
    const ok = await admin.from("tasks").insert({ user_id: userId, title: "Brent's", owner: "brent" }).select("owner").single();
    assert.equal(ok.data?.owner, "brent");
  });

  await test("056: blank or over-long owner_label / status_line are rejected by the database", async () => {
    const cases = [
      [{ owner_label: "   " }, /tasks_owner_label_check/],
      [{ owner_label: "x".repeat(41) }, /tasks_owner_label_check/],
      [{ status_line: "" }, /tasks_status_line_check/],
      [{ status_line: "y".repeat(281) }, /tasks_status_line_check/],
    ];
    for (const [fields, pattern] of cases) {
      const { error } = await admin.from("tasks").insert({ user_id: userId, title: "Limits", ...fields });
      assert.equal(error?.code, "23514", JSON.stringify(fields).slice(0, 60));
      assert.match(error.message, pattern);
    }
    const edge = await admin
      .from("tasks")
      .insert({ user_id: userId, title: "At the limits", owner_label: "x".repeat(40), status_line: "y".repeat(280) })
      .select("id")
      .single();
    assert.ok(edge.data?.id);
  });

  await test("056: existing rows are untouched apart from the defaults (update of other fields keeps owner)", async () => {
    const { data: row } = await admin.from("tasks").insert({ user_id: userId, title: "Keep me", owner: "brent", status_line: "Waiting on you." }).select("id").single();
    const { data, error } = await admin.from("tasks").update({ title: "Kept" }).eq("id", row.id).select("owner, status_line").single();
    if (error) throw error;
    assert.deepEqual(data, { owner: "brent", status_line: "Waiting on you." });
  });

  // ── Part 2: MCP tools, end to end ──────────────────────────────────────
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "owner-db-test", version: "1.0.0" },
  });
  assert.ok(init.result, "MCP initialize");

  let legacyId;
  let brentId;

  await test("create_task without owner fields (an existing caller) still works and defaults to agent", async () => {
    const result = await callTool("create_task", { title: "Old-style create", status: "Planned" });
    assert.equal(result.isError, false, result.raw);
    assert.equal(result.data.owner, "agent");
    assert.equal(result.data.owner_label, null);
    assert.equal(result.data.status_line, null);
    legacyId = result.data.id;
  });

  await test("create_task with owner brent, a label and a status line (whitespace collapsed)", async () => {
    const result = await callTool("create_task", {
      title: "Run the build 28 checklist",
      owner: "brent",
      owner_label: "  PM  ",
      status_line: "8 of 11 checks passed.\nLeft for you: Split View.",
    });
    assert.equal(result.isError, false, result.raw);
    assert.equal(result.data.owner, "brent");
    assert.equal(result.data.owner_label, "PM");
    assert.equal(result.data.status_line, "8 of 11 checks passed. Left for you: Split View.");
    brentId = result.data.id;
  });

  await test("create_task rejects an unknown owner and an over-long status line before any write", async () => {
    const before = apiCalls.length;
    const badOwner = await callTool("create_task", { title: "x", owner: "bob" });
    assert.equal(badOwner.isError, true);
    const longLine = await callTool("create_task", { title: "x", status_line: "z".repeat(281) });
    assert.equal(longLine.isError, true);
    assert.equal(apiCalls.length, before, "schema validation stops the call before the API");
  });

  await test("update_task hands a task to Brent with a status line, then back to an agent", async () => {
    const toBrent = await callTool("update_task", { task_id: legacyId, owner: "brent", status_line: "Needs your OK to deploy." });
    assert.equal(toBrent.isError, false, toBrent.raw);
    assert.equal(toBrent.data.owner, "brent");
    assert.equal(toBrent.data.status_line, "Needs your OK to deploy.");
    assert.equal(toBrent.data.status, "Planned", "other fields untouched");

    const back = await callTool("update_task", { task_id: legacyId, owner: "agent", owner_label: "Codex" });
    assert.equal(back.isError, false, back.raw);
    assert.equal(back.data.owner, "agent");
    assert.equal(back.data.owner_label, "Codex");
    assert.equal(back.data.status_line, "Needs your OK to deploy.", "status_line kept when not sent");
  });

  await test("update_task clears owner_label and status_line with null; other updates leave them alone", async () => {
    const cleared = await callTool("update_task", { task_id: legacyId, owner_label: null, status_line: null });
    assert.equal(cleared.isError, false, cleared.raw);
    assert.equal(cleared.data.owner_label, null);
    assert.equal(cleared.data.status_line, null);
    const other = await callTool("update_task", { task_id: brentId, title: "Run the build 28 checklist (renamed)" });
    assert.equal(other.isError, false, other.raw);
    assert.equal(other.data.owner, "brent");
    assert.equal(other.data.owner_label, "PM");
  });

  await test("update_task with only a status line is a valid update", async () => {
    const result = await callTool("update_task", { task_id: brentId, status_line: "  Split View left.  " });
    assert.equal(result.isError, false, result.raw);
    assert.equal(result.data.status_line, "Split View left.");
  });

  await test("update_task rejects an unknown owner (MCP schema) and the API rejects owner null", async () => {
    const bad = await callTool("update_task", { task_id: brentId, owner: "someone" });
    assert.equal(bad.isError, true);
    const request = new NextRequest(`http://localhost/api/tasks/${brentId}`, {
      method: "PATCH",
      headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ owner: null }),
    });
    const response = await taskRoute.PATCH(request, { params: Promise.resolve({ id: brentId }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Invalid owner/);
    const { data } = await admin.from("tasks").select("owner").eq("id", brentId).single();
    assert.equal(data.owner, "brent");
  });

  await test("list_tasks filters by owner; without the filter it returns both", async () => {
    const brent = await callTool("list_tasks", { owner: "brent", limit: 100 });
    assert.equal(brent.isError, false, brent.raw);
    assert.ok(brent.data.length >= 1);
    assert.ok(brent.data.every((task) => task.owner === "brent"));
    assert.ok(brent.data.some((task) => task.id === brentId));
    assert.ok(apiCalls.some((call) => call.includes("owner=brent")));

    const agent = await callTool("list_tasks", { owner: "agent", limit: 100 });
    assert.ok(agent.data.every((task) => task.owner === "agent"));
    assert.ok(agent.data.some((task) => task.id === legacyId));

    const everyone = await callTool("list_tasks", { limit: 100 });
    const owners = new Set(everyone.data.map((task) => task.owner));
    assert.deepEqual([...owners].sort(), ["agent", "brent"]);
  });

  await test("GET /api/tasks rejects an unknown owner filter with 400", async () => {
    const request = new NextRequest("http://localhost/api/tasks?owner=nobody", {
      headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY },
    });
    const response = await tasksRoute.GET(request);
    assert.equal(response.status, 400);
  });

  await test("the owner filter stays scoped to the caller's own tasks", async () => {
    const other = await admin.auth.admin.createUser({ email: `owner-other-${randomUUID().slice(0, 8)}@example.test`, password: randomUUID(), email_confirm: true });
    try {
      await admin.from("tasks").insert({ user_id: other.data.user.id, title: "Someone else's", owner: "brent" });
      const brent = await callTool("list_tasks", { owner: "brent", limit: 500 });
      assert.ok(brent.data.every((task) => task.user_id === userId));
    } finally {
      await admin.auth.admin.deleteUser(other.data.user.id);
    }
  });
} finally {
  globalThis.fetch = realFetch;
  await admin.from("tasks").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${passed} passed`);
