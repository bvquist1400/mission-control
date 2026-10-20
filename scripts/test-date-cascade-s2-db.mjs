#!/usr/bin/env node
// Database tests for cascade due dates, slice S2 (Baseline task 6fcad51b), against a
// LOCAL Supabase stack with every migration applied (scripts/test-stack/up.sh):
//
//   CASCADE_TEST_SUPABASE_URL=$STACK_API_URL CASCADE_TEST_ANON_KEY=$STACK_ANON_KEY \
//   CASCADE_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY CASCADE_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:date-cascade-s2-db
//
// P2 (carried from the S1 re-check): a cascade and a project PATCH that re-points
//   the application, paused at the exact interleaving that deadlocked under 061.
// Migration 062: rollback and re-apply, grants, the shared lock protocol.
// The new endpoint POST /api/tasks/{id}/date-cascade on the real database: Undo
//   (full, partial with a kept task, the edited task's own date, the health rule),
//   switching mode (replaces the first move), retry after a failed cascade, the
//   >25 confirm (nothing saved), plain failure text, and MCP undo_date_cascade.
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.CASCADE_TEST_SUPABASE_URL;
const anonKey = process.env.CASCADE_TEST_ANON_KEY;
const serviceKey = process.env.CASCADE_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.CASCADE_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set CASCADE_TEST_SUPABASE_URL, CASCADE_TEST_ANON_KEY, CASCADE_TEST_SERVICE_ROLE_KEY and CASCADE_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const ONLY = process.env.CASCADE_S2_ONLY ? new RegExp(process.env.CASCADE_S2_ONLY) : null;

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psqlConnection(label) {
  const child = spawn("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-q", "-t", "-A"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    send: (sql) => child.stdin.write(`${sql}\n`),
    output: () => output,
    async waitFor(marker, ms = 15000) {
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

/** Waits until some backend whose query matches `pattern` is waiting on a row/tuple lock. */
async function waitForLockWait(pattern, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) {
    const n = psql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '${pattern}';`);
    if (Number(n) > 0) return;
    await sleep(50);
  }
  throw new Error(`no backend matching ${pattern} ever waited on a lock`);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

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

async function insert(table, row) {
  const { data, error } = await admin.from(table).insert(row).select("*").single();
  if (error) throw error;
  return data;
}

const userA = await makeUser("cascade-s2-a");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.DEPLOYMENT_ROLE = "main";

const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const dateCascadeRoute = await import("../src/app/api/tasks/[id]/date-cascade/route.ts");

const MIGRATION_062 = readFileSync(new URL("../supabase/migrations/062_task_date_cascade_undo.sql", import.meta.url), "utf8");
const ROLLBACK_062 = readFileSync(new URL("../supabase/rollbacks/062_task_date_cascade_undo.down.sql", import.meta.url), "utf8");

function routeRequest(authSource, method, path, body, userId = userA, supabase = admin) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase, user: { id: userId }, userId, authSource });
}
const params = (id) => ({ params: Promise.resolve({ id }) });
async function patch(taskId, body, authSource = "legacy_api_key", supabase = admin) {
  const response = await taskRoute.PATCH(routeRequest(authSource, "PATCH", `/api/tasks/${taskId}`, body, userA, supabase), params(taskId));
  return { status: response.status, body: await response.json() };
}

async function dateCascade(taskId, body, authSource = "legacy_api_key") {
  const response = await dateCascadeRoute.POST(routeRequest(authSource, "POST", `/api/tasks/${taskId}/date-cascade`, body), params(taskId));
  return { status: response.status, body: await response.json() };
}

// ET instants (October 2026 is EDT until Sun Nov 1).
const etAt = (date, time = "17:00") => new Date(`${date}T${time}:00${date >= "2026-11-01" ? "-05:00" : "-04:00"}`).toISOString();
const etDateSql = (taskId) => psql(`SELECT coalesce((due_at AT TIME ZONE 'America/New_York')::date::text, 'none') FROM tasks WHERE id = '${taskId}';`);
const link = (waiting, on, userId = userA) => insert("task_dependencies", { user_id: userId, task_id: waiting, depends_on_task_id: on });
const comments = (taskId) => psql(`SELECT coalesce(string_agg(content, E'\\n' ORDER BY created_at, id), '') FROM task_comments WHERE task_id = '${taskId}';`);
const priorityOf = (taskId) => Number(psql(`SELECT priority_score FROM tasks WHERE id = '${taskId}';`));

/** Root R (Thu 10/22) with three tasks waiting on it (Fri 10/23) and a Done one; optional project for all. */
async function launchSet(label, extra = {}) {
  const root = await insert("tasks", { user_id: userA, title: `${label} release`, tags: ["work"], due_at: etAt("2026-10-22"), ...(extra.root ?? {}) });
  const deps = [];
  for (const name of ["analytics", "campaign links", "site swap"]) {
    const row = await insert("tasks", { user_id: userA, title: `${label} ${name}`, tags: ["work"], due_at: etAt("2026-10-23"), ...(extra.deps ?? {}) });
    await link(row.id, root.id);
    deps.push(row);
  }
  const done = await insert("tasks", { user_id: userA, title: `${label} press kit`, tags: ["work"], status: "Done", due_at: etAt("2026-10-21"), ...(extra.deps ?? {}) });
  await link(done.id, root.id);
  return { root, deps, done };
}

let passed = 0;
const failed = [];
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

try {
  // ── P2: the root-project lock vs a project re-pointing its application ────
  await test("P2: a cascade and a project PATCH re-pointing the application, paused at the 061 deadlock schedule: no deadlock, both commit", async () => {
    const app1 = await insert("implementations", { user_id: userA, name: "P2 app one" });
    const app2 = await insert("implementations", { user_id: userA, name: "P2 app two" });
    const proj = await insert("projects", { user_id: userA, name: "P2 project", tags: ["work"], rag: "Green", implementation_id: app1.id });
    const root = await insert("tasks", { user_id: userA, title: "P2 root in the project", tags: ["work"], due_at: etAt("2026-10-20"), project_id: proj.id });
    const child = await insert("tasks", { user_id: userA, title: "P2 standalone child", tags: ["work"], due_at: etAt("2026-10-21") });
    await link(child.id, root.id);

    const holder = psqlConnection("holder");
    const repoint = psqlConnection("repoint");
    let result;
    try {
      // 1. Something holds the child's row, so the cascade stops right after it
      //    has taken its first lock(s) and before it reaches the child.
      holder.send(`BEGIN; SELECT id FROM tasks WHERE id = '${child.id}' FOR UPDATE; SELECT 'held';`);
      await holder.waitFor("held");
      // 2. The cascade: the PATCH saves the root, then the function waits on the child.
      const pending = patch(root.id, { due_at: etAt("2026-10-22") });
      await waitForLockWait("%apply_task_date_cascade%");
      // 3. The project PATCH re-points the application: it locks the project row,
      //    then 046's trigger updates the project's tasks (the root among them).
      repoint.send(`BEGIN; UPDATE projects SET implementation_id = '${app2.id}' WHERE id = '${proj.id}'; SELECT 'repoint-updated';`);
      await sleep(300);
      // 4. Let the cascade go on. Under 061 it now asks for the project while the
      //    re-point waits for the root: a lock cycle, and Postgres aborts one side.
      holder.send("COMMIT; SELECT 'released';");
      await holder.waitFor("released");
      result = await pending;
      await repoint.waitFor("repoint-updated", 15000).catch(() => null);
      const repointOutput = repoint.output();
      repoint.send(repointOutput.includes("ERROR") ? "ROLLBACK; SELECT 'repoint-finished';" : "COMMIT; SELECT 'repoint-finished';");
      await repoint.waitFor("repoint-finished");
      assert.doesNotMatch(repointOutput, /deadlock detected/, `the project PATCH was aborted by a deadlock: ${repointOutput.replace(/\s+/g, " ").slice(0, 400)} (cascade: ${JSON.stringify(result?.body?.cascade?.status)})`);
      assert.doesNotMatch(repointOutput, /ERROR/, repointOutput);
    } finally {
      await holder.end();
      await repoint.end();
    }
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
    assert.equal(result.body.cascade.status, "moved", `cascade ${JSON.stringify(result.body.cascade).slice(0, 300)}`);
    assert.equal(etDateSql(child.id), "2026-10-23");
    assert.equal(psql(`SELECT implementation_id FROM projects WHERE id = '${proj.id}';`), app2.id);
    assert.equal(psql(`SELECT implementation_id FROM tasks WHERE id = '${root.id}';`), app2.id);
  });

  // ── Migration 062 ────────────────────────────────────────────────────────
  await test("062 rollback restores 061's apply function and drops the new functions and columns; re-apply restores them; a second apply is a no-op", async () => {
    const fns = "('undo_task_date_cascade', 'replace_task_date_cascade', 'task_date_cascade_lock', 'task_date_cascade_apply_core', 'task_date_cascade_undo_core', 'task_date_cascade_score_unchanged')";
    psql(ROLLBACK_062);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ${fns};`), "0");
    assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_name IN ('task_date_cascades', 'task_date_cascade_moves') AND column_name IN ('replaces_cascade_id', 'undone_reason', 'restored_at', 'restore_comment_id');"), "0");
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname = 'apply_task_date_cascade';"), "1");
    assert.match(psql("SELECT prosrc FROM pg_proc WHERE proname = 'apply_task_date_cascade';"), /FOR SHARE OF t;/);
    psql(MIGRATION_062);
    psql(MIGRATION_062);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ${fns};`), "6");
    assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_name IN ('task_date_cascades', 'task_date_cascade_moves') AND column_name IN ('replaces_cascade_id', 'undone_reason', 'restored_at', 'restore_comment_id');"), "4");
    assert.match(psql("SELECT prosrc FROM pg_proc WHERE proname = 'apply_task_date_cascade';"), /task_date_cascade_apply_core/);
    // The stale 9-argument draft is gone wherever it existed.
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname = 'apply_task_date_cascade' AND pronargs = 9;"), "0");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const { error } = await admin.rpc("undo_task_date_cascade", {
        p_user_id: randomUUID(), p_root_task_id: randomUUID(), p_cascade_id: null, p_root_expected_due_at: null,
        p_root_restore_due_at: null, p_restore_root: false, p_root_priority: null, p_restore: [],
      });
      if (error?.code !== "PGRST202") break;
      await sleep(250);
    }
  });

  await test("062 grants: authenticated + service_role execute the new functions, anon doesn't; all SECURITY INVOKER with lock_timeout 5s; a signed-in user can't act for another", async () => {
    const sigs = [
      "public.undo_task_date_cascade(uuid, uuid, uuid, timestamptz, timestamptz, boolean, jsonb, jsonb)",
      "public.replace_task_date_cascade(uuid, uuid, uuid, timestamptz, timestamptz, text, integer, text, jsonb, text, boolean, jsonb)",
      "public.task_date_cascade_lock(uuid, uuid[], text, uuid[])",
      "public.task_date_cascade_apply_core(uuid, uuid, timestamptz, timestamptz, text, integer, text, text, jsonb, text, boolean, uuid)",
      "public.task_date_cascade_undo_core(uuid, uuid, jsonb, text)",
    ];
    for (const sig of sigs) {
      assert.equal(psql(`SELECT has_function_privilege('service_role', '${sig}', 'execute');`), "t", sig);
      assert.equal(psql(`SELECT has_function_privilege('authenticated', '${sig}', 'execute');`), "t", sig);
      assert.equal(psql(`SELECT has_function_privilege('anon', '${sig}', 'execute');`), "f", sig);
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), "f", sig);
      assert.match(psql(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), /lock_timeout=5s/, sig);
    }
    const other = randomUUID();
    const out = psql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${other}"}', true);
      DO $$ BEGIN PERFORM undo_task_date_cascade('${userA}', '${randomUUID()}', NULL, now(), now(), true, NULL, '[]'::jsonb);
      RAISE EXCEPTION 'not refused'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'refused'; END $$; ROLLBACK; SELECT 'done';`);
    assert.match(out, /done/);
  });

  // ── Undo ─────────────────────────────────────────────────────────────────
  await test("Undo (full): every moved task back on its old date with a comment, the edited task back too, priorities as before, the log marked undone", async () => {
    const { root, deps, done } = await launchSet("Undo full");
    const before = Object.fromEntries([root, ...deps].map((row) => [row.id, priorityOf(row.id)]));
    const moved = await patch(root.id, { due_at: etAt("2026-10-26") });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.cascade.status, "moved");
    assert.equal(moved.body.cascade.root_old_due_at, root.due_at);
    assert.equal(moved.body.cascade.root_new_due_at, etAt("2026-10-26"));
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27");
    const undo = await dateCascade(root.id, { action: "undo", cascade_id: moved.body.cascade.cascade_id });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(undo.body.status, "undone");
    assert.equal(undo.body.cascade.restored.length, 3);
    assert.deepEqual(undo.body.cascade.kept, []);
    assert.equal(undo.body.root.restored, true);
    assert.equal(etDateSql(root.id), "2026-10-22");
    for (const row of deps) {
      assert.equal(etDateSql(row.id), "2026-10-23");
      assert.match(comments(row.id), /Due date moved back from Tue 10\/27 to Fri 10\/23 because the change that moved it was undone\.$/);
    }
    assert.equal(etDateSql(done.id), "2026-10-21");
    for (const row of [root, ...deps]) assert.equal(priorityOf(row.id), before[row.id], row.title);
    assert.equal(psql(`SELECT (undone_at IS NOT NULL) || ',' || undone_reason FROM task_date_cascades WHERE id = '${moved.body.cascade.cascade_id}';`), "true,undo");
    assert.equal(psql(`SELECT count(*) FROM task_date_cascade_moves WHERE cascade_id = '${moved.body.cascade.cascade_id}' AND restored_at IS NOT NULL;`), "3");
    // A second undo puts nothing back and leaves the root alone (it's already back).
    const again = await dateCascade(root.id, { action: "undo", cascade_id: moved.body.cascade.cascade_id });
    assert.equal(again.status, 200);
    assert.equal(again.body.cascade, null);
    assert.equal(again.body.root.restored, false);
    assert.equal(etDateSql(root.id), "2026-10-22");
  });

  await test("Undo (partial): a task changed since the move is kept and listed; the edited task changed since is kept too", async () => {
    const { root, deps } = await launchSet("Undo partial");
    const moved = await patch(root.id, { due_at: etAt("2026-10-26") });
    psql(`UPDATE tasks SET due_at = '${etAt("2026-10-28")}' WHERE id = '${deps[1].id}';`);
    psql(`UPDATE tasks SET due_at = '${etAt("2026-10-29")}' WHERE id = '${root.id}';`);
    const undo = await dateCascade(root.id, { action: "undo", cascade_id: moved.body.cascade.cascade_id });
    assert.equal(undo.status, 200);
    assert.deepEqual(undo.body.cascade.restored.map((r) => r.title).sort(), [deps[0].title, deps[2].title].sort());
    assert.deepEqual(undo.body.cascade.kept.map((k) => [k.title, k.due_at && new Date(k.due_at).toISOString(), new Date(k.cascade_due_at).toISOString()]), [[deps[1].title, etAt("2026-10-28"), etAt("2026-10-27")]]);
    assert.equal(etDateSql(deps[1].id), "2026-10-28");
    assert.equal(etDateSql(deps[0].id), "2026-10-23");
    assert.equal(undo.body.root.restored, false);
    assert.equal(etDateSql(root.id), "2026-10-29");
    assert.equal(comments(deps[1].id).includes("moved back"), false);
  });

  await test("Undo with no cascade (the change moved nothing else): puts the edited task back, only while it still has the date the change set", async () => {
    const lone = await insert("tasks", { user_id: userA, title: "Undo lone", tags: ["work"], due_at: etAt("2026-10-22") });
    const moved = await patch(lone.id, { due_at: etAt("2026-10-26") });
    assert.equal(moved.body.cascade.status, "nothing_to_move");
    const undo = await dateCascade(lone.id, { action: "undo", from_due_at: moved.body.cascade.root_old_due_at, to_due_at: moved.body.cascade.root_new_due_at });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(undo.body.root.restored, true);
    assert.equal(etDateSql(lone.id), "2026-10-22");
    const stale = await dateCascade(lone.id, { action: "undo", from_due_at: etAt("2026-10-20"), to_due_at: etAt("2026-10-26") });
    assert.equal(stale.body.root.restored, false);
    assert.equal(etDateSql(lone.id), "2026-10-22");
  });

  await test("Undo and health: Green again only if the move made it Yellow, nothing changed on the project since, and all its tasks went back", async () => {
    const cases = [
      ["clean", () => null, "Green", null],
      ["project edited since", (p) => psql(`UPDATE projects SET name = name || ' (renamed)' WHERE id = '${p.id}';`), "Yellow", "changed_since"],
      ["set Red by hand", (p) => psql(`UPDATE projects SET rag = 'Red' WHERE id = '${p.id}';`), "Red", "changed_since"],
      ["a task kept", (_p, set) => psql(`UPDATE tasks SET due_at = '${etAt("2026-10-29")}' WHERE id = '${set.deps[0].id}';`), "Yellow", "tasks_kept"],
    ];
    for (const [label, between, expected, reason] of cases) {
      const project = await insert("projects", { user_id: userA, name: `Health ${label}`, tags: ["work"], rag: "Green", target_date: "2026-10-23" });
      const set = await launchSet(`Health ${label}`, { root: { project_id: project.id }, deps: { project_id: project.id } });
      const moved = await patch(set.root.id, { due_at: etAt("2026-10-26") });
      assert.deepEqual(moved.body.cascade.project_flags.map((f) => [f.rag_before, f.rag_after]), [["Green", "Yellow"]], label);
      assert.equal("rag_set_at" in moved.body.cascade.project_flags[0], false, label);
      assert.equal(psql(`SELECT rag FROM projects WHERE id = '${project.id}';`), "Yellow", label);
      between(project, set);
      const undo = await dateCascade(set.root.id, { action: "undo", cascade_id: moved.body.cascade.cascade_id });
      assert.equal(undo.status, 200, label);
      assert.equal(psql(`SELECT rag FROM projects WHERE id = '${project.id}';`), expected, label);
      assert.deepEqual(undo.body.cascade.projects.map((p) => [p.rag_after, p.kept_reason]), [[expected, reason]], label);
      assert.equal(psql(`SELECT target_date FROM projects WHERE id = '${project.id}';`), "2026-10-23", label);
    }
  });

  // ── Switching how far (replace) ──────────────────────────────────────────
  await test("Switch how far: same gap → only what collides → just this task → same gap again; each switch replaces the last (no stacking); Undo then puts everything back", async () => {
    const { root, deps } = await launchSet("Switch");
    const first = await patch(root.id, { due_at: etAt("2026-10-26") });
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27");

    const collide = await dateCascade(root.id, { action: "apply", cascade_id: first.body.cascade.cascade_id, mode: "only_collisions" });
    assert.equal(collide.status, 200, JSON.stringify(collide.body));
    assert.equal(collide.body.cascade.status, "moved");
    assert.equal(collide.body.cascade.mode, "only_collisions");
    assert.equal(collide.body.replaced.restored.length, 3);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-26");
    const secondId = collide.body.cascade.cascade_id;
    assert.equal(psql(`SELECT replaces_cascade_id FROM task_date_cascades WHERE id = '${secondId}';`), first.body.cascade.cascade_id);
    assert.equal(psql(`SELECT undone_reason FROM task_date_cascades WHERE id = '${first.body.cascade.cascade_id}';`), "replaced");
    assert.match(comments(deps[0].id), /moved back from Tue 10\/27 to Fri 10\/23 because the change that moved it was replaced\./);

    const none = await dateCascade(root.id, { action: "apply", cascade_id: secondId, mode: "none" });
    assert.equal(none.status, 200);
    assert.equal(none.body.cascade.status, "off");
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-23");
    assert.equal(etDateSql(root.id), "2026-10-26");

    // Back to the same gap from the (now undone) second cascade: planned from the log's dates, no double shift.
    const again = await dateCascade(root.id, { action: "apply", cascade_id: secondId, mode: "same_gap" });
    assert.equal(again.status, 200);
    assert.equal(again.body.replaced, null);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27");
    assert.equal(again.body.cascade.root_old_due_at, root.due_at);

    const undo = await dateCascade(root.id, { action: "undo", cascade_id: again.body.cascade.cascade_id });
    assert.equal(undo.body.root.restored, true);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-23");
    assert.equal(etDateSql(root.id), "2026-10-22");
  });

  await test("Switch how far after the edited task moved again: 409, nothing changed", async () => {
    const { root, deps } = await launchSet("Switch stale");
    const first = await patch(root.id, { due_at: etAt("2026-10-26") });
    psql(`UPDATE tasks SET due_at = '${etAt("2026-10-27")}' WHERE id = '${root.id}';`);
    const result = await dateCascade(root.id, { action: "apply", cascade_id: first.body.cascade.cascade_id, mode: "only_collisions" });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /changed since/);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27");
    assert.equal(psql(`SELECT undone_at IS NULL FROM task_date_cascades WHERE id = '${first.body.cascade.cascade_id}';`), "t");
  });

  // ── Failure, retry, plain text ───────────────────────────────────────────
  await test("A failed cascade answers with plain words (reason busy, no database text); Try again moves the linked tasks", async () => {
    const { root, deps } = await launchSet("Retry");
    const holder = psqlConnection("retry-holder");
    let failed;
    try {
      holder.send(`BEGIN; SELECT id FROM tasks WHERE id = '${deps[1].id}' FOR UPDATE; SELECT 'held';`);
      await holder.waitFor("held");
      failed = await patch(root.id, { due_at: etAt("2026-10-26") });
    } finally {
      holder.send("ROLLBACK;");
      await holder.end();
    }
    assert.equal(failed.status, 200);
    assert.equal(failed.body.cascade.status, "failed");
    assert.equal(failed.body.cascade.reason, "busy");
    const text = JSON.stringify(failed.body).toLowerCase();
    for (const raw of ["lock timeout", "canceling statement", "55p03", "could not obtain lock", "statement timeout"]) assert.equal(text.includes(raw), false, raw);
    assert.match(failed.body.cascade.message, /Baseline was busy/);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-23");
    const retry = await dateCascade(root.id, { action: "apply", mode: "same_gap", from_due_at: failed.body.cascade.root_old_due_at, to_due_at: failed.body.cascade.root_new_due_at });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.cascade.status, "moved");
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27");
    // A second Try again (a double click, or MCP without the id) replaces the first instead of moving the tasks again.
    const repeat = await dateCascade(root.id, { action: "apply", mode: "same_gap", from_due_at: failed.body.cascade.root_old_due_at, to_due_at: failed.body.cascade.root_new_due_at });
    assert.equal(repeat.status, 200);
    for (const row of deps) assert.equal(etDateSql(row.id), "2026-10-27", "a repeat never shifts again");
  });

  await test("More than 25: the PATCH saves nothing (not even the edited task); Just this task saves only it; a switch over 25 asks too and changes nothing until confirmed", async () => {
    const root = await insert("tasks", { user_id: userA, title: "Big root", tags: ["work"], due_at: etAt("2026-10-22") });
    psql(`WITH made AS (
            INSERT INTO tasks (user_id, title, tags, due_at)
            SELECT '${userA}', 'Big follower ' || g, ARRAY['work'], '${etAt("2026-10-23")}'::timestamptz FROM generate_series(1, 26) g
            RETURNING id)
          INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) SELECT '${userA}', id, '${root.id}' FROM made;`);
    const refused = await patch(root.id, { due_at: etAt("2026-10-26") });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.cascade.status, "needs_confirm");
    assert.equal(refused.body.cascade.moves.length, 26);
    assert.equal(etDateSql(root.id), "2026-10-22");
    assert.equal(psql(`SELECT count(*) FROM task_date_cascades WHERE root_task_id = '${root.id}';`), "0");
    assert.equal(comments(root.id), "");

    const only = await patch(root.id, { due_at: etAt("2026-10-26"), cascade: false });
    assert.equal(only.status, 200);
    assert.equal(only.body.cascade.status, "off");
    assert.equal(etDateSql(root.id), "2026-10-26");
    const followersOn = () => psql(`SELECT string_agg(DISTINCT (due_at AT TIME ZONE 'America/New_York')::date::text, ',') FROM tasks WHERE user_id = '${userA}' AND title LIKE 'Big follower %';`);
    assert.equal(followersOn(), "2026-10-23");

    const ask = await dateCascade(root.id, { action: "apply", mode: "same_gap", from_due_at: only.body.cascade.root_old_due_at, to_due_at: only.body.cascade.root_new_due_at });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.cascade.status, "needs_confirm");
    assert.equal(followersOn(), "2026-10-23");
    const confirmed = await dateCascade(root.id, { action: "apply", mode: "same_gap", confirm: true, from_due_at: only.body.cascade.root_old_due_at, to_due_at: only.body.cascade.root_new_due_at });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.cascade.moves.length, 26);
    assert.equal(followersOn(), "2026-10-27");
  });

  await test("The new route: FamCal key refused (403); bad bodies are 400s; an unknown cascade is a 404", async () => {
    const { root } = await launchSet("Route guard");
    assert.equal((await dateCascade(root.id, { action: "undo", from_due_at: root.due_at, to_due_at: root.due_at }, "famcal_api_key")).status, 403);
    assert.equal((await dateCascade(root.id, { action: "redo" })).status, 400);
    assert.equal((await dateCascade(root.id, { action: "apply", cascade_id: randomUUID() })).status, 400);
    assert.equal((await dateCascade(root.id, { action: "undo", cascade_id: randomUUID(), mode: "same_gap" })).status, 400);
    assert.equal((await dateCascade(root.id, { action: "undo", extra: 1 })).status, 400);
    assert.equal((await dateCascade(root.id, { action: "undo", cascade_id: randomUUID() })).status, 404);
    assert.equal((await dateCascade(randomUUID(), { action: "undo", from_due_at: root.due_at, to_due_at: root.due_at })).status, 404);
  });

  // ── Carried LOWs (S1 re-check) ───────────────────────────────────────────
  await test("L1: a task between the edited one and a moved one became Done after planning → that move is skipped (path_changed), the rest still move", async () => {
    const r = await insert("tasks", { user_id: userA, title: "L1 root", tags: ["work"], due_at: etAt("2026-10-22") });
    const b = await insert("tasks", { user_id: userA, title: "L1 middle", tags: ["work"], due_at: etAt("2026-10-23") });
    const c = await insert("tasks", { user_id: userA, title: "L1 last", tags: ["work"], due_at: etAt("2026-10-26") });
    const side = await insert("tasks", { user_id: userA, title: "L1 side", tags: ["work"], due_at: etAt("2026-10-23") });
    psql(`UPDATE tasks SET status = 'Done' WHERE id = '${b.id}';`);
    const mv = (t, to, via = []) => ({ task_id: t.id, old_due_at: t.due_at, new_due_at: to, priority_score: 50, base_priority: 50, status: "Planned", title: t.title, stakeholder_mentions: [], via, comment: "named", comment_redacted: "redacted" });
    const { data, error } = await admin.rpc("apply_task_date_cascade", {
      p_user_id: userA, p_root_task_id: r.id, p_root_old_due_at: null, p_root_new_due_at: r.due_at, p_mode: "same_gap", p_delta_workdays: 1,
      p_scope: "all", p_source: "db-test", p_moves: [mv(c, etAt("2026-10-27"), [b.id]), mv(side, etAt("2026-10-26"))], p_root_title: r.title, p_root_was_visible: false,
    });
    assert.equal(error, null);
    assert.deepEqual(data.skipped.map((s) => [s.task_id, s.reason]), [[c.id, "path_changed"]]);
    assert.deepEqual(data.moved.map((m) => m.task_id), [side.id]);
    assert.equal(etDateSql(c.id), "2026-10-26");
    assert.equal(etDateSql(side.id), "2026-10-26");
  });

  await test("L2: any score input changed after planning (status, title, mentions, base) keeps the task's current priority; unchanged inputs get the planned score", async () => {
    const r = await insert("tasks", { user_id: userA, title: "L2 root", tags: ["work"], due_at: etAt("2026-10-22") });
    const rows = {};
    for (const key of ["status", "title", "mentions", "base", "none"]) {
      rows[key] = await insert("tasks", { user_id: userA, title: `L2 ${key}`, tags: ["work"], status: "Planned", due_at: etAt("2026-10-23"), base_priority: 50, priority_score: 50 });
    }
    psql(`UPDATE tasks SET status = 'Blocked/Waiting', priority_score = 30 WHERE id = '${rows.status.id}';
          UPDATE tasks SET title = 'L2 title URGENT', priority_score = 75 WHERE id = '${rows.title.id}';
          UPDATE tasks SET stakeholder_mentions = ARRAY['Dana'], priority_score = 70 WHERE id = '${rows.mentions.id}';
          UPDATE tasks SET base_priority = 90, priority_score = 90 WHERE id = '${rows.base.id}';`);
    const mv = (t) => ({ task_id: t.id, old_due_at: t.due_at, new_due_at: etAt("2026-10-26"), priority_score: 55, base_priority: 50, status: "Planned", title: t.title, stakeholder_mentions: [], comment: "named", comment_redacted: "redacted" });
    const { error } = await admin.rpc("apply_task_date_cascade", {
      p_user_id: userA, p_root_task_id: r.id, p_root_old_due_at: null, p_root_new_due_at: r.due_at, p_mode: "same_gap", p_delta_workdays: 1,
      p_scope: "all", p_source: "db-test", p_moves: Object.values(rows).map(mv), p_root_title: r.title, p_root_was_visible: false,
    });
    assert.equal(error, null);
    assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([key, t]) => [key, priorityOf(t.id)])), { status: 30, title: 75, mentions: 70, base: 90, none: 55 });
  });
} finally {
  for (const id of users) {
    psql(`DELETE FROM task_comments WHERE user_id = '${id}' OR task_id IN (SELECT id FROM tasks WHERE user_id = '${id}');`);
    psql(`DELETE FROM task_dependencies WHERE user_id = '${id}' OR task_id IN (SELECT id FROM tasks WHERE user_id = '${id}');`);
    await admin.from("task_date_cascades").delete().eq("user_id", id);
    await admin.from("tasks").delete().eq("user_id", id);
    await admin.from("projects").delete().eq("user_id", id);
    await admin.from("implementations").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
