// Tests for POST /api/intake/email: the default (n8n) mode, pinned exactly as it
// behaved before inbox-only mode existed, and the opt-in `mode: "inbox_only"`
// (store the inbox row with the excerpt; no AI extraction, no task). Also checks
// that the MCP fetch of an inbox-only item shows the excerpt as plain text.
//
// Offline: no database, no model, no network. The route runs for real; only its
// imports of "@/lib/extraction" and "@supabase/supabase-js", and server.ts's import
// of "next/headers", are swapped for the doubles in scripts/fixtures/intake-email/.
//
//   npm run test:intake-email

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_FILE = path.join(ROOT, "src/app/api/intake/email/route.ts");
const SERVER_FILE = path.join(ROOT, "src/lib/supabase/server.ts");
const FIXTURES = path.join(ROOT, "scripts/fixtures/intake-email");
const MOCKS = [
  { parent: ROUTE_FILE, specifier: "@/lib/extraction", file: "extraction-mock.mjs" },
  { parent: ROUTE_FILE, specifier: "@supabase/supabase-js", file: "supabase-js-mock.mjs" },
  { parent: SERVER_FILE, specifier: "next/headers", file: "next-headers-mock.mjs" },
];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentPath = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
    const mock = MOCKS.find((entry) => entry.specifier === specifier && entry.parent === parentPath);
    if (mock) {
      return { url: pathToFileURL(path.join(FIXTURES, mock.file)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const INTAKE_KEY = "test-intake-key-0123456789abcdef";
const USER_ID = "8e9f7cc9-0000-4000-8000-000000000001";
const SESSION_USER_ID = "8e9f7cc9-0000-4000-8000-000000000002";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.N8N_INTAKE_API_KEY = INTAKE_KEY;
process.env.DEFAULT_USER_ID = USER_ID;
delete process.env.MISSION_CONTROL_API_KEY;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;

// Any network call (a model provider, Supabase, anything) fails the test.
const networkCalls = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  networkCalls.push(url);
  throw new Error(`Unexpected network call in test: ${url}`);
};

globalThis.__intakeTest = { extractCalls: [], createClientCalls: [], serviceDb: null, extractResult: null, extractError: null };
const state = globalThis.__intakeTest;

const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const route = await import("../src/app/api/intake/email/route.ts");
const { fetchMissionControlItemById, searchMissionControlData } = await import("../src/lib/mcp/search.ts");

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

// ── Fake Supabase client ───────────────────────────────────────────────────
// Records every query (table, operation, payload, filters, selected columns) and
// answers the ones the intake route makes.
const INBOX_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const EXISTING_INBOX_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const TASK_ID = "cccccccc-0000-4000-8000-00000000000c";
const IMPL_ID = "dddddddd-0000-4000-8000-00000000000d";

function makeDb({ existingId = null, inboxInsertError = null, rows = {} } = {}) {
  const log = [];
  const respond = (q) => {
    const { table, op } = q;
    if (table === "inbox_items" && op === "select") {
      if (rows.inbox_items) {
        const matching = rows.inbox_items.filter((row) => q.filters.every(([kind, col, val]) => kind !== "eq" || row[col] === val));
        return q.single ? { data: matching[0] ?? null, error: null } : { data: matching, error: null };
      }
      return { data: existingId ? { id: existingId } : null, error: null };
    }
    if (table === "inbox_items" && op === "insert") {
      if (inboxInsertError) return { data: null, error: { message: inboxInsertError } };
      return { data: { id: INBOX_ID, ...q.payload }, error: null };
    }
    if (table === "implementations" && op === "select") {
      if (q.single) return { data: { id: IMPL_ID, name: "Stock & Stir" }, error: null };
      return { data: [{ id: IMPL_ID, name: "Stock & Stir", keywords: ["menu", "market"] }], error: null };
    }
    if (table === "stakeholders" && op === "select") return { data: [], error: null };
    if (table === "tasks" && op === "insert") return { data: { id: TASK_ID, ...q.payload }, error: null };
    if (op === "select" && q.single) return { data: null, error: null };
    return { data: op === "select" ? [] : null, error: null };
  };
  const client = {
    log,
    from(table) {
      const q = { table, op: "select", payload: null, filters: [], columns: null, single: null };
      let result = null;
      const run = () => {
        if (!result) {
          log.push(q);
          result = Promise.resolve(respond(q));
        }
        return result;
      };
      const builder = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") return (resolve, reject) => run().then(resolve, reject);
          if (prop === "insert" || prop === "update" || prop === "delete") {
            return (payload) => { q.op = prop; q.payload = payload; return builder; };
          }
          if (prop === "select") {
            return (columns) => { q.columns = columns ?? "*"; return builder; };
          }
          if (prop === "single" || prop === "maybeSingle") {
            return () => { q.single = prop; return run(); };
          }
          return (...args) => { q.filters.push([prop, ...args]); return builder; };
        },
      });
      return builder;
    },
  };
  return client;
}

const ops = (db, table, op) => db.log.filter((q) => q.table === table && q.op === op);
const stages = (db) => ops(db, "ingestion_events", "insert").map((q) => q.payload.stage);

const EXTRACTION = {
  title: "Fix list sync for a customer",
  suggested_tasks: [],
  suggested_checklist: ["Reproduce on iOS 27", "Reply to the customer"],
  task_type: "Task",
  estimated_minutes: 30,
  due_guess_iso: null,
  due_confidence: 0,
  implementation_guess: "Stock & Stir",
  implementation_confidence: 0.9,
  stakeholder_mentions: ["Ann"],
  priority_score: 60,
  needs_review: false,
  blocker: false,
  waiting_on: null,
};

function resetState({ serviceDb = makeDb(), extractError = null } = {}) {
  state.extractCalls = [];
  state.createClientCalls = [];
  state.serviceDb = serviceDb;
  state.extractResult = { extraction: structuredClone(EXTRACTION), model: "test-model", confidence: 0.9 };
  state.extractError = extractError;
  networkCalls.length = 0;
  return serviceDb;
}

const BASE_BODY = {
  subject: "M&M support: List will not sync",
  from_email: "mm-support-sender@intake.invalid",
  received_at: "2026-10-19T09:15:00-04:00",
  from_name: "Ann",
  message_id: "support-email:18f3a9c2b7d4e001",
  source_url: "https://mail.google.com/mail/u/B.Vanderquist%40studycoor.com/#all/18f3a9c2b7d4e001",
  body_snippet: "Hi,\nThe list will not sync.\n\nThanks",
};

function keyRequest(body, { key = INTAKE_KEY, raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (key !== null) headers["x-api-key"] = key;
  return new NextRequest("http://localhost/api/intake/email", {
    method: "POST",
    headers,
    body: raw ? body : JSON.stringify(body),
  });
}

function sessionRequest(db, body) {
  const request = new NextRequest("http://localhost/api/intake/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase: db, user: { id: SESSION_USER_ID }, userId: SESSION_USER_ID, authSource: "session" });
}

async function post(request) {
  const response = await route.POST(request);
  return { status: response.status, body: await response.json() };
}

// The insert the route made before inbox-only mode existed (dedupe = sha256(user|message_id)).
import { createHash } from "node:crypto";
const dedupeFor = (userId, messageId) => createHash("sha256").update(`${userId}|${messageId}`).digest("hex");
const DEFAULT_INBOX_INSERT = {
  user_id: USER_ID,
  received_at: BASE_BODY.received_at,
  from_name: "Ann",
  from_email: BASE_BODY.from_email,
  subject: BASE_BODY.subject,
  source: "ActionIntakeEmail",
  source_message_id: BASE_BODY.message_id,
  source_url: BASE_BODY.source_url,
  dedupe_key: dedupeFor(USER_ID, BASE_BODY.message_id),
  triage_state: "New",
  extraction_version: 1,
};

// ── 1. Default mode: exactly as before ─────────────────────────────────────
await test("default mode (no mode field): inbox row, AI extraction, Backlog task + checklist, 200", async () => {
  const db = resetState();
  const { status, body } = await post(keyRequest(BASE_BODY));
  assert.equal(status, 200);
  assert.deepEqual(body, {
    success: true,
    inbox_item_id: INBOX_ID,
    task_id: TASK_ID,
    needs_review: false,
    extraction: {
      title: EXTRACTION.title,
      task_type: "Task",
      estimated_minutes: 30,
      priority_score: body.extraction.priority_score,
      implementation_guess: "Stock & Stir",
      confidence: 0.9,
    },
  });
  assert.equal(typeof body.extraction.priority_score, "number");
  assert.deepEqual(state.createClientCalls.map((c) => [c.url, c.key]), [["http://127.0.0.1:1", "test-service-role"]]);
  assert.deepEqual(ops(db, "inbox_items", "insert").map((q) => q.payload), [DEFAULT_INBOX_INSERT]);
  assert.equal(state.extractCalls.length, 1);
  assert.equal(state.extractCalls[0].body_snippet, BASE_BODY.body_snippet);
  assert.equal(state.extractCalls[0].userId, USER_ID);
  assert.deepEqual(state.extractCalls[0].implementation_names, ["Stock & Stir"]);
  assert.deepEqual(ops(db, "inbox_items", "update").map((q) => q.payload), [
    { llm_extraction_json: EXTRACTION, extraction_model: "test-model", extraction_confidence: 0.9, triage_state: "Processed" },
  ]);
  const taskInserts = ops(db, "tasks", "insert");
  assert.equal(taskInserts.length, 1);
  const task = taskInserts[0].payload;
  assert.deepEqual(
    { ...task, priority_score: "x" },
    {
      user_id: USER_ID,
      title: EXTRACTION.title,
      implementation_id: IMPL_ID,
      status: "Backlog",
      task_type: "Task",
      base_priority: 60,
      priority_score: "x",
      estimated_minutes: 30,
      estimate_source: "llm",
      due_at: null,
      needs_review: false,
      blocker: false,
      waiting_on: null,
      stakeholder_mentions: ["Ann"],
      source_type: "Email",
      source_url: BASE_BODY.source_url,
      inbox_item_id: INBOX_ID,
    }
  );
  assert.deepEqual(ops(db, "task_checklist_items", "insert").map((q) => q.payload), [[
    { user_id: USER_ID, task_id: TASK_ID, text: "Reproduce on iOS 27", is_done: false, sort_order: 0 },
    { user_id: USER_ID, task_id: TASK_ID, text: "Reply to the customer", is_done: false, sort_order: 1 },
  ]]);
  assert.deepEqual(stages(db), ["received", "extracted", "task_created"]);
  assert.deepEqual(networkCalls, []);
});

await test("default mode: an unknown extra field is still ignored (no new required fields)", async () => {
  const db = resetState();
  const { status } = await post(keyRequest({ ...BASE_BODY, something_else: "x" }));
  assert.equal(status, 200);
  assert.equal(ops(db, "tasks", "insert").length, 1);
});

await test("default mode: extraction failure -> 500, inbox row kept with processing_error, no task", async () => {
  const db = resetState({ extractError: "model down" });
  const { status, body } = await post(keyRequest(BASE_BODY));
  assert.equal(status, 500);
  assert.deepEqual(body, { error: "Extraction failed", detail: "model down", inbox_item_id: INBOX_ID });
  assert.deepEqual(ops(db, "inbox_items", "update").map((q) => q.payload), [{ processing_error: "model down" }]);
  assert.equal(ops(db, "tasks", "insert").length, 0);
  assert.deepEqual(stages(db), ["received", "extracted"]);
});

await test("default mode: a repeat message_id -> 200 duplicate, nothing inserted, no extraction", async () => {
  const db = resetState({ serviceDb: makeDb({ existingId: EXISTING_INBOX_ID }) });
  const { status, body } = await post(keyRequest(BASE_BODY));
  assert.equal(status, 200);
  assert.deepEqual(body, { message: "Duplicate email, already processed", inbox_item_id: EXISTING_INBOX_ID });
  assert.equal(ops(db, "inbox_items", "insert").length, 0);
  assert.equal(state.extractCalls.length, 0);
  assert.deepEqual(stages(db), ["deduped"]);
});

await test("default mode: missing required fields -> 400 before any database call", async () => {
  for (const field of ["subject", "from_email", "received_at"]) {
    const db = resetState();
    const body = { ...BASE_BODY };
    delete body[field];
    const res = await post(keyRequest(body));
    assert.equal(res.status, 400, field);
    assert.deepEqual(res.body, { error: "Missing required fields: subject, from_email, received_at" });
    assert.equal(db.log.length, 0, field);
  }
});

// ── 2. Auth (unchanged) ────────────────────────────────────────────────────
await test("auth: no key, wrong key, wrong-length key -> 401; nothing touched", async () => {
  for (const key of [null, "x".repeat(INTAKE_KEY.length), "short"]) {
    const db = resetState();
    const res = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only" }, { key }));
    assert.equal(res.status, 401, String(key));
    assert.deepEqual(res.body, { error: "Authentication required. Provide session cookie or X-API-Key header." });
    assert.equal(db.log.length, 0);
    assert.equal(state.createClientCalls.length, 0);
  }
});

await test("auth: right key but DEFAULT_USER_ID or N8N_INTAKE_API_KEY unset -> 401", async () => {
  for (const name of ["DEFAULT_USER_ID", "N8N_INTAKE_API_KEY"]) {
    const saved = process.env[name];
    delete process.env[name];
    try {
      const db = resetState();
      const res = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only" }));
      assert.equal(res.status, 401, name);
      assert.equal(db.log.length, 0);
    } finally {
      process.env[name] = saved;
    }
  }
});

await test("auth: a signed-in session uses its own client and user id (inbox only)", async () => {
  const serviceDb = resetState();
  const sessionDb = makeDb();
  const { status, body } = await post(sessionRequest(sessionDb, { ...BASE_BODY, mode: "inbox_only" }));
  assert.equal(status, 201);
  assert.equal(body.inbox_item_id, INBOX_ID);
  assert.equal(serviceDb.log.length, 0);
  assert.equal(state.createClientCalls.length, 0);
  const insert = ops(sessionDb, "inbox_items", "insert")[0].payload;
  assert.equal(insert.user_id, SESSION_USER_ID);
  assert.equal(insert.dedupe_key, dedupeFor(SESSION_USER_ID, BASE_BODY.message_id));
});

// ── 3. Inbox-only mode ─────────────────────────────────────────────────────
await test("inbox_only: stores the row with the excerpt, no AI call, no task, 201 with the id", async () => {
  const db = resetState();
  const { status, body } = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only" }));
  assert.equal(status, 201);
  assert.deepEqual(body, { success: true, mode: "inbox_only", inbox_item_id: INBOX_ID, task_id: null });
  assert.deepEqual(ops(db, "inbox_items", "insert").map((q) => q.payload), [{
    ...DEFAULT_INBOX_INSERT,
    llm_extraction_json: { intake_mode: "inbox_only", body_snippet: BASE_BODY.body_snippet, body_snippet_truncated: false },
  }]);
  assert.equal(state.extractCalls.length, 0, "no AI extraction");
  for (const table of ["tasks", "task_checklist_items", "implementations", "stakeholders"]) {
    assert.equal(db.log.filter((q) => q.table === table).length, 0, `${table} not touched`);
  }
  assert.deepEqual(ops(db, "inbox_items", "update"), [], "row stays triage_state New");
  assert.deepEqual(stages(db), ["received"]);
  assert.match(ops(db, "ingestion_events", "insert")[0].payload.detail, /inbox only/i);
  assert.deepEqual(networkCalls, []);
});

await test("inbox_only: a repeat message_id -> 200 duplicate (same answer as default), nothing inserted", async () => {
  const db = resetState({ serviceDb: makeDb({ existingId: EXISTING_INBOX_ID }) });
  const { status, body } = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only" }));
  assert.equal(status, 200);
  assert.deepEqual(body, { message: "Duplicate email, already processed", inbox_item_id: EXISTING_INBOX_ID });
  assert.equal(ops(db, "inbox_items", "insert").length, 0);
  assert.equal(state.extractCalls.length, 0);
  assert.deepEqual(stages(db), ["deduped"]);
});

await test("inbox_only: no body_snippet -> stored as null; empty string kept as empty", async () => {
  let db = resetState();
  const noSnippet = { ...BASE_BODY, mode: "inbox_only" };
  delete noSnippet.body_snippet;
  assert.equal((await post(keyRequest(noSnippet))).status, 201);
  assert.deepEqual(ops(db, "inbox_items", "insert")[0].payload.llm_extraction_json, { intake_mode: "inbox_only", body_snippet: null, body_snippet_truncated: false });
  db = resetState();
  assert.equal((await post(keyRequest({ ...BASE_BODY, mode: "inbox_only", body_snippet: "" }))).status, 201);
  assert.equal(ops(db, "inbox_items", "insert")[0].payload.llm_extraction_json.body_snippet, "");
});

await test("inbox_only: excerpt is capped at 2,000 characters without splitting an emoji", async () => {
  const db = resetState();
  const long = "a".repeat(1999) + "😊" + "b".repeat(500);
  assert.equal((await post(keyRequest({ ...BASE_BODY, mode: "inbox_only", body_snippet: long }))).status, 201);
  const json = ops(db, "inbox_items", "insert")[0].payload.llm_extraction_json;
  assert.equal(json.body_snippet_truncated, true);
  assert.equal(Array.from(json.body_snippet).length, 2000);
  assert.ok(json.body_snippet.endsWith("😊"));
  assert.equal(json.body_snippet.isWellFormed(), true);
});

await test("inbox_only: characters Postgres JSON cannot store (NUL, lone surrogates) are cleaned", async () => {
  const db = resetState();
  const snippet = "nul\u0000here, lone \uD83D end, low \uDE0A end";
  assert.equal((await post(keyRequest({ ...BASE_BODY, mode: "inbox_only", body_snippet: snippet }))).status, 201);
  const stored = ops(db, "inbox_items", "insert")[0].payload.llm_extraction_json.body_snippet;
  assert.equal(stored, "nulhere, lone � end, low � end");
});

await test("inbox_only: a non-string body_snippet -> 400, nothing stored", async () => {
  for (const snippet of [123, { a: 1 }, ["x"], true]) {
    const db = resetState();
    const res = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only", body_snippet: snippet }));
    assert.equal(res.status, 400, JSON.stringify(snippet));
    assert.match(res.body.error, /body_snippet/);
    assert.equal(db.log.length, 0);
  }
});

await test("inbox_only: missing required fields -> 400 (same message as default)", async () => {
  const db = resetState();
  const body = { ...BASE_BODY, mode: "inbox_only" };
  delete body.received_at;
  const res = await post(keyRequest(body));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "Missing required fields: subject, from_email, received_at" });
  assert.equal(db.log.length, 0);
});

await test("inbox_only: inbox insert fails -> 500, no extraction, no task", async () => {
  const db = resetState({ serviceDb: makeDb({ inboxInsertError: "duplicate key value violates unique constraint" }) });
  const res = await post(keyRequest({ ...BASE_BODY, mode: "inbox_only" }));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "Internal server error");
  assert.equal(state.extractCalls.length, 0);
  assert.equal(db.log.filter((q) => q.table === "tasks").length, 0);
});

await test("bad mode values -> 400 before any database call or AI call", async () => {
  for (const mode of ["INBOX_ONLY", "inbox-only", "", " inbox_only", "default", "task", null, 1, true, {}, ["inbox_only"]]) {
    const db = resetState();
    const res = await post(keyRequest({ ...BASE_BODY, mode }));
    assert.equal(res.status, 400, JSON.stringify(mode));
    assert.deepEqual(res.body, { error: 'Invalid mode. Leave it out, or send "inbox_only".' }, JSON.stringify(mode));
    assert.equal(db.log.length, 0, JSON.stringify(mode));
    assert.equal(state.extractCalls.length, 0);
  }
});

// ── 4. MCP search + fetch show the excerpt ─────────────────────────────────
const INBOX_ONLY_ROW = {
  id: INBOX_ID,
  user_id: USER_ID,
  subject: BASE_BODY.subject,
  from_name: "Ann",
  from_email: BASE_BODY.from_email,
  source: "ActionIntakeEmail",
  source_url: BASE_BODY.source_url,
  created_at: "2026-10-19T13:15:05Z",
  received_at: "2026-10-19T13:15:00Z",
  triage_state: "New",
  llm_extraction_json: { intake_mode: "inbox_only", body_snippet: "Hi,\nThe list will not sync.\n\nThanks", body_snippet_truncated: false },
};
const EXTRACTED_ROW = {
  ...INBOX_ONLY_ROW,
  id: EXISTING_INBOX_ID,
  triage_state: "Processed",
  llm_extraction_json: { title: "Fix list sync", task_type: "Task" },
};

await test("MCP fetch email:<id> of an inbox-only item shows the excerpt as plain text", async () => {
  const db = makeDb({ rows: { inbox_items: [INBOX_ONLY_ROW] } });
  const result = await fetchMissionControlItemById(db, USER_ID, `email:${INBOX_ID}`, "https://example.test");
  assert.ok(result);
  assert.equal(result.id, `email:${INBOX_ID}`);
  assert.equal(result.title, BASE_BODY.subject);
  assert.match(result.text, /Email: mm-support-sender@intake\.invalid/);
  assert.match(result.text, /Triage state: New/);
  assert.match(result.text, /Intake mode: inbox only \(no task was created\)/);
  assert.ok(result.text.includes("Excerpt:\nHi,\nThe list will not sync.\n\nThanks"), result.text);
  assert.doesNotMatch(result.text, /intake_mode|\\n/);
  assert.equal(result.metadata.source_url, BASE_BODY.source_url);
});

await test("MCP fetch of a normal extracted item is unchanged (pretty JSON)", async () => {
  const db = makeDb({ rows: { inbox_items: [EXTRACTED_ROW] } });
  const result = await fetchMissionControlItemById(db, USER_ID, `email:${EXISTING_INBOX_ID}`, "https://example.test");
  assert.ok(result.text.endsWith(JSON.stringify(EXTRACTED_ROW.llm_extraction_json, null, 2)), result.text);
});

await test("MCP fetch notes a truncated excerpt", async () => {
  const row = { ...INBOX_ONLY_ROW, llm_extraction_json: { ...INBOX_ONLY_ROW.llm_extraction_json, body_snippet_truncated: true } };
  const result = await fetchMissionControlItemById(makeDb({ rows: { inbox_items: [row] } }), USER_ID, `email:${INBOX_ID}`, "https://example.test");
  assert.match(result.text, /cut at 2,000 characters/);
});

await test("MCP search 'mm-support-sender' lists the item with the excerpt in its text", async () => {
  const db = makeDb({ rows: { inbox_items: [INBOX_ONLY_ROW] } });
  const results = await searchMissionControlData(db, USER_ID, "mm-support-sender", "https://example.test");
  const hit = results.find((r) => r.id === `email:${INBOX_ID}`);
  assert.ok(hit, JSON.stringify(results.map((r) => r.id)));
  assert.match(hit.text, /Excerpt: Hi, The list will not sync\. Thanks/);
  assert.doesNotMatch(hit.text, /intake_mode/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
