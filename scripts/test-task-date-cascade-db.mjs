#!/usr/bin/env node
// Database tests for cascade due dates (Baseline task 6fcad51b, slice S1), against a
// LOCAL Supabase stack with every migration applied (scripts/test-stack/up.sh):
//
//   CASCADE_TEST_SUPABASE_URL=$STACK_API_URL CASCADE_TEST_ANON_KEY=$STACK_ANON_KEY \
//   CASCADE_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY CASCADE_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:task-date-cascade-db
//
// Part 1: migration 061 itself: rollback and re-apply, grants (incl. famcal_eligible
//         for the app session), the loop guard (direct, through other tasks,
//         resolved links, re-activation, other users, two opposite adds at once),
//         and apply_task_date_cascade's rules (root re-check, compare-and-set,
//         FamCal scope, comment redaction, project flags, log rows, refusals, the
//         caller check under the authenticated role).
// Part 2: the real PATCH route on the real database: the OnCore-shaped 7-task
//         chain, Done/Parked, an existing loop, a diamond, FamCal both ways, a row
//         lock that outlasts lock_timeout (the two-statement seam), and two
//         concurrent date moves on the same chain.
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

const MIGRATION = readFileSync(new URL("../supabase/migrations/061_task_date_cascade.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/061_task_date_cascade.down.sql", import.meta.url), "utf8");
// 062 (S2) builds on 061: roll it back first and re-apply it after, so this suite
// leaves the database at the latest migration.
const MIGRATION_062 = readFileSync(new URL("../supabase/migrations/062_task_date_cascade_undo.sql", import.meta.url), "utf8");
const ROLLBACK_062 = readFileSync(new URL("../supabase/rollbacks/062_task_date_cascade_undo.down.sql", import.meta.url), "utf8");
const FN = "apply_task_date_cascade";
const FN_SIG = "public.apply_task_date_cascade(uuid, uuid, timestamptz, timestamptz, text, integer, text, text, jsonb, text, boolean)";

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

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForFunction(present) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { error } = await admin.rpc(FN, {
      p_user_id: randomUUID(), p_root_task_id: randomUUID(), p_root_old_due_at: null, p_root_new_due_at: "2026-10-20T00:00:00Z",
      p_mode: "same_gap", p_delta_workdays: 0, p_scope: "all", p_source: "probe", p_moves: [],
      p_root_title: "probe", p_root_was_visible: false,
    });
    const missing = error?.code === "PGRST202";
    if (present ? !missing : missing) return;
    await sleep(250);
  }
  throw new Error(`schema cache never ${present ? "saw" : "dropped"} ${FN}`);
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

async function insert(table, row) {
  const { data, error } = await admin.from(table).insert(row).select("*").single();
  if (error) throw error;
  return data;
}

const userA = await makeUser("cascade-a");
const userB = await makeUser("cascade-b");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.DEPLOYMENT_ROLE = "main";

const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
const dependenciesRoute = await import("../src/app/api/tasks/[id]/dependencies/route.ts");
const cascade = await import("../src/lib/task-date-cascade.ts");
const famcal = await import("../src/lib/famcal-api-key.ts");

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

// ET instants (October 2026 is EDT until Sun Nov 1).
const etAt = (date, time = "17:00") => new Date(`${date}T${time}:00${date >= "2026-11-01" ? "-05:00" : "-04:00"}`).toISOString();
const etDateSql = (taskId) => psql(`SELECT (due_at AT TIME ZONE 'America/New_York')::date FROM tasks WHERE id = '${taskId}';`);
const comments = (taskId) => psql(`SELECT coalesce(string_agg(source || ': ' || content, E'\\n' ORDER BY created_at, id), '') FROM task_comments WHERE task_id = '${taskId}';`);

async function chain(titles, dates, extra = {}) {
  const rows = [];
  for (let index = 0; index < titles.length; index += 1) {
    rows.push(await insert("tasks", { user_id: userA, title: titles[index], tags: ["work"], due_at: dates[index] ? etAt(dates[index]) : null, ...(extra[titles[index]] ?? {}), ...(extra.all ?? {}) }));
  }
  for (let index = 1; index < rows.length; index += 1) {
    await insert("task_dependencies", { user_id: userA, task_id: rows[index].id, depends_on_task_id: rows[index - 1].id });
  }
  return rows;
}
const link = (waiting, on, userId = userA) => insert("task_dependencies", { user_id: userId, task_id: waiting, depends_on_task_id: on });

function rpcArgs(root, overrides = {}) {
  return {
    p_user_id: userA, p_root_task_id: root.id, p_root_old_due_at: null, p_root_new_due_at: root.due_at,
    p_mode: "same_gap", p_delta_workdays: 1, p_scope: "all", p_source: "db-test", p_moves: [],
    p_root_title: root.title, p_root_was_visible: false, ...overrides,
  };
}
const move = (task, newDue, extra = {}) => ({ task_id: task.id, old_due_at: task.due_at, new_due_at: newDue, priority_score: 55, comment: `named ${task.title}`, comment_redacted: `redacted ${task.title}`, ...extra });

let passed = 0;
const failed = [];
async function test(name, fn) {
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
  // ── Part 1: migration 061 ───────────────────────────────────────────────
  await test("061 rollback drops the trigger, function and log tables; re-apply restores them; a second apply is a no-op", async () => {
    psql(ROLLBACK_062);
    psql(ROLLBACK);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('${FN}', 'task_dependencies_guard_loop', 'task_graph_lock_key');`), "0");
    assert.equal(psql("SELECT count(*) FROM pg_tables WHERE tablename IN ('task_date_cascades', 'task_date_cascade_moves');"), "0");
    assert.equal(psql("SELECT has_function_privilege('authenticated', 'public.famcal_eligible(tasks)', 'execute');"), "f");
    await waitForFunction(false);
    psql(MIGRATION);
    psql(MIGRATION);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname IN ('${FN}', 'task_dependencies_guard_loop', 'task_graph_lock_key');`), "3");
    psql(MIGRATION_062);
    assert.equal(psql("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_task_dependencies_guard_loop';"), "1");
    await waitForFunction(true);
  });

  await test("061 grants: authenticated + service_role execute the apply function, anon doesn't; SECURITY INVOKER; famcal_eligible for the app session; RLS on both log tables", async () => {
    assert.equal(psql(`SELECT has_function_privilege('service_role', '${FN_SIG}', 'execute');`), "t");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', '${FN_SIG}', 'execute');`), "t");
    assert.equal(psql(`SELECT has_function_privilege('anon', '${FN_SIG}', 'execute');`), "f");
    assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE proname = '${FN}';`), "f");
    assert.equal(psql("SELECT has_function_privilege('authenticated', 'public.famcal_eligible(tasks)', 'execute');"), "t");
    assert.equal(psql("SELECT has_function_privilege('anon', 'public.famcal_eligible(tasks)', 'execute');"), "f");
    assert.equal(psql("SELECT string_agg(relname || '=' || relrowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('task_date_cascades', 'task_date_cascade_moves');"), "task_date_cascade_moves=true,task_date_cascades=true");
    assert.equal(psql("SELECT count(*) FROM pg_policies WHERE tablename IN ('task_date_cascades', 'task_date_cascade_moves');"), "8");
  });

  // Loop guard
  const g = {};
  for (const name of ["a", "b", "c", "d"]) g[name] = await insert("tasks", { user_id: userA, title: `Loop ${name}`, tags: ["work"] });
  const gB = await insert("tasks", { user_id: userB, title: "B's task", tags: ["work"] });

  await test("loop guard: a direct loop and a loop through other tasks are refused (MC061); nothing is written", async () => {
    await link(g.b.id, g.a.id); // b waits on a
    const direct = await admin.from("task_dependencies").insert({ user_id: userA, task_id: g.a.id, depends_on_task_id: g.b.id });
    assert.equal(direct.error?.code, "MC061");
    await link(g.c.id, g.b.id); // c waits on b
    const through = await admin.from("task_dependencies").insert({ user_id: userA, task_id: g.a.id, depends_on_task_id: g.c.id });
    assert.equal(through.error?.code, "MC061");
    assert.match(through.error.message, /would make a loop/);
    assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE task_id = '${g.a.id}';`), "0");
    // A link that doesn't loop is fine.
    assert.equal((await admin.from("task_dependencies").insert({ user_id: userA, task_id: g.d.id, depends_on_task_id: g.c.id })).error, null);
  });

  await test("loop guard: a resolved link doesn't count; re-activating it into a loop is refused", async () => {
    const loose = await insert("tasks", { user_id: userA, title: "Loop e", tags: ["work"] });
    const old = await link(loose.id, g.d.id); // e waits on d
    psql(`UPDATE task_dependencies SET is_resolved = true, resolved_at = now() WHERE id = '${old.id}';`);
    // d → e is fine now (the e → d link is resolved)…
    const dToE = await insert("task_dependencies", { user_id: userA, task_id: g.d.id, depends_on_task_id: loose.id });
    // …and re-activating e → d would close d → e → d.
    assert.throws(() => psql(`UPDATE task_dependencies SET is_resolved = false, resolved_at = NULL WHERE id = '${old.id}';`), /would make a loop/);
    psql(`DELETE FROM task_dependencies WHERE id = '${dToE.id}';`);
  });

  await test("loop guard: other users' links are never followed", async () => {
    // B's link points from B's task to A's task (a malformed row); it must not make A's add look like a loop.
    psql(`INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) VALUES ('${userB}', '${g.a.id}', '${gB.id}');`);
    const res = await admin.from("task_dependencies").insert({ user_id: userA, task_id: gB.id, depends_on_task_id: g.a.id });
    // (A link to another user's task is odd, but the guard's job is loops within one user's links.)
    assert.equal(res.error, null);
  });

  await test("loop guard: two opposite adds at once: the second waits on the first, then is refused (no A<->B ever commits)", async () => {
    const x = await insert("tasks", { user_id: userA, title: "Race x", tags: ["work"] });
    const y = await insert("tasks", { user_id: userA, title: "Race y", tags: ["work"] });
    const first = psqlConnection("first");
    const second = psqlConnection("second");
    try {
      first.send(`BEGIN; INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) VALUES ('${userA}', '${x.id}', '${y.id}'); SELECT 'first-ready';`);
      await first.waitFor("first-ready");
      second.send(`BEGIN; INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) VALUES ('${userA}', '${y.id}', '${x.id}'); COMMIT; SELECT 'second-done';`);
      await sleep(1200);
      assert.equal(second.output().includes("second-done") || second.output().includes("ERROR"), false, "second waited");
      first.send("COMMIT; SELECT 'first-done';");
      await first.waitFor("first-done");
      await second.waitFor("second-done");
      assert.match(second.output(), /would make a loop/);
    } finally {
      await first.end();
      await second.end();
    }
    assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE is_resolved = false AND ((task_id = '${x.id}' AND depends_on_task_id = '${y.id}') OR (task_id = '${y.id}' AND depends_on_task_id = '${x.id}'));`), "1");
  });

  await test("loop guard through the add route: a loop the app check missed (inserted behind it) comes back 400, not 500", async () => {
    const p = await insert("tasks", { user_id: userA, title: "Route p", tags: ["work"] });
    const q = await insert("tasks", { user_id: userA, title: "Route q", tags: ["work"] });
    await link(q.id, p.id); // q waits on p
    // Hide the link from the app check only: the route's loop walk sees no links.
    const hiding = new Proxy(admin, {
      get(target, prop) {
        if (prop === "from") {
          return (table) => {
            const builder = target.from(table);
            if (table !== "task_dependencies") return builder;
            return new Proxy(builder, {
              get(inner, innerProp) {
                if (innerProp === "select") {
                  return (columns, ...rest) => (columns === "id, task_id, depends_on_task_id" ? inner.select(columns, ...rest).eq("id", randomUUID()) : inner.select(columns, ...rest));
                }
                const value = inner[innerProp];
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = writeInternalAuthContext(
      new NextRequest(`http://localhost/api/tasks/${p.id}/dependencies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depends_on_task_id: q.id }) }),
      { supabase: hiding, user: { id: userA }, userId: userA, authSource: "legacy_api_key" }
    );
    const response = await dependenciesRoute.POST(request, params(p.id));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /would make a loop/);
    assert.equal(psql(`SELECT count(*) FROM task_dependencies WHERE task_id = '${p.id}';`), "0");
  });

  // apply_task_date_cascade
  const project = await insert("projects", { user_id: userA, name: "Apply project", tags: ["work"], rag: "Green", target_date: "2026-10-23" });
  const redProject = await insert("projects", { user_id: userA, name: "Red project", tags: ["work"], rag: "Red", target_date: "2026-10-23" });
  const root = await insert("tasks", { user_id: userA, title: "Apply root (work)", tags: ["work"], due_at: etAt("2026-10-21") });
  const t1 = await insert("tasks", { user_id: userA, title: "t1 work", tags: ["work"], due_at: etAt("2026-10-21"), project_id: project.id });
  const t2 = await insert("tasks", { user_id: userA, title: "t2 personal", tags: ["personal"], due_at: etAt("2026-10-21") });
  const t3 = await insert("tasks", { user_id: userA, title: "t3 red", tags: ["work"], due_at: etAt("2026-10-21"), project_id: redProject.id });
  const t4 = await insert("tasks", { user_id: userA, title: "t4 changed", tags: ["work"], due_at: etAt("2026-10-21") });

  await test("apply: moves, compare-and-set skip, comment redaction on a personal task, project flags (Green→Yellow, Red stays), log rows", async () => {
    const stale = { ...t4, due_at: etAt("2026-10-19") }; // planned from an old read: must be skipped
    const { data, error } = await admin.rpc(FN, rpcArgs(root, {
      p_moves: [move(t1, etAt("2026-10-26")), move(t2, etAt("2026-10-26")), move(t3, etAt("2026-10-26")), move(stale, etAt("2026-10-26"))],
    }));
    assert.equal(error, null);
    assert.equal(data.status, "moved");
    assert.deepEqual(data.moved.map((m) => m.task_id).sort(), [t1.id, t2.id, t3.id].sort());
    assert.deepEqual(data.skipped, [{ task_id: t4.id, reason: "changed" }]);
    assert.equal(etDateSql(t4.id), "2026-10-21");
    assert.equal(comments(t1.id), "system: named t1 work");
    assert.equal(comments(t2.id), "system: redacted t2 personal");
    assert.equal(psql(`SELECT priority_score FROM tasks WHERE id = '${t1.id}';`), "55");
    assert.equal(psql(`SELECT rag FROM projects WHERE id = '${project.id}';`), "Yellow");
    assert.equal(psql(`SELECT rag FROM projects WHERE id = '${redProject.id}';`), "Red");
    assert.equal(psql(`SELECT target_date || '|' || status_summary || '|' FROM projects WHERE id = '${project.id}';`), "2026-10-23||");
    assert.deepEqual(data.project_flags.map((f) => [f.name, f.rag_before, f.rag_after, f.tasks_past_target]), [["Apply project", "Green", "Yellow", 1], ["Red project", "Red", "Red", 1]]);
    assert.match(comments(root.id), /Moving this task pushed 1 task in "Apply project" past the project's target date \(Fri 10\/23; latest now Mon 10\/26\)\. The project went from Green to Yellow\./);
    assert.equal(psql(`SELECT moved_count || ' ' || mode || ' ' || scope || ' ' || source FROM task_date_cascades WHERE id = '${data.cascade_id}';`), "3 same_gap all db-test");
    assert.equal(psql(`SELECT count(*) FROM task_date_cascade_moves WHERE cascade_id = '${data.cascade_id}' AND comment_id IS NOT NULL AND old_priority_score = 50;`), "3");
  });

  await test("apply: the root no longer has the saved date → superseded, nothing written", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Superseded root", tags: ["work"], due_at: etAt("2026-10-22") });
    const f = await insert("tasks", { user_id: userA, title: "Follower", tags: ["work"], due_at: etAt("2026-10-23") });
    const { data, error } = await admin.rpc(FN, rpcArgs(r, { p_root_new_due_at: etAt("2026-10-21"), p_moves: [move(f, etAt("2026-10-26"))] }));
    assert.equal(error, null);
    assert.equal(data.status, "superseded");
    assert.equal(etDateSql(f.id), "2026-10-23");
    assert.equal(comments(f.id), "");
  });

  await test("apply scope famcal: an ineligible task is never moved or commented, even if it was in the plan", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Personal root", tags: ["personal"], due_at: etAt("2026-10-22") });
    const ok = await insert("tasks", { user_id: userA, title: "Personal follower", tags: ["personal"], due_at: etAt("2026-10-23") });
    const work = await insert("tasks", { user_id: userA, title: "Work follower", tags: ["work"], due_at: etAt("2026-10-23") });
    const inWork = await insert("tasks", { user_id: userA, title: "Personal in work project", tags: ["personal"], due_at: etAt("2026-10-23"), project_id: project.id });
    const { data, error } = await admin.rpc(FN, rpcArgs(r, { p_scope: "famcal", p_root_was_visible: true, p_moves: [move(ok, etAt("2026-10-26")), move(work, etAt("2026-10-26")), move(inWork, etAt("2026-10-26"))] }));
    assert.equal(error, null);
    assert.deepEqual(data.moved.map((m) => m.task_id), [ok.id]);
    assert.equal(etDateSql(work.id), "2026-10-23");
    assert.equal(etDateSql(inWork.id), "2026-10-23");
    assert.equal(comments(work.id), "");
    // Named, not redacted: the root is personal too.
    assert.equal(comments(ok.id), "system: named Personal follower");
    // A work root is never a FamCal root.
    const workRoot = await admin.rpc(FN, rpcArgs(root, { p_scope: "famcal", p_root_new_due_at: psql(`SELECT due_at FROM tasks WHERE id = '${root.id}';`) }));
    assert.equal(workRoot.data.status, "superseded");
  });

  await test("apply refuses bad input (earlier dates, unknown keys, duplicates, the root itself, bad mode) with 22023 and writes nothing", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Refusal root", tags: ["work"], due_at: etAt("2026-10-22") });
    const f = await insert("tasks", { user_id: userA, title: "Refusal follower", tags: ["work"], due_at: etAt("2026-10-23") });
    for (const [label, args] of [
      ["earlier", rpcArgs(r, { p_moves: [move(f, etAt("2026-10-22"))] })],
      ["unknown key", rpcArgs(r, { p_moves: [move(f, etAt("2026-10-26"), { colour: "red" })] })], // (062 accepts status/title/mentions/via as score and path inputs)
      ["duplicate", rpcArgs(r, { p_moves: [move(f, etAt("2026-10-26")), move(f, etAt("2026-10-27"))] })],
      ["root", rpcArgs(r, { p_moves: [move(r, etAt("2026-10-26"))] })],
      ["mode", rpcArgs(r, { p_mode: "everything" })],
      ["no comment", rpcArgs(r, { p_moves: [move(f, etAt("2026-10-26"), { comment: " " })] })],
    ]) {
      const { error } = await admin.rpc(FN, args);
      assert.equal(error?.code, "22023", label);
    }
    assert.equal(etDateSql(f.id), "2026-10-23");
    assert.equal(psql(`SELECT count(*) FROM task_date_cascades WHERE root_task_id = '${r.id}';`), "0");
  });

  await test("apply under the authenticated role (the app session): works for your own id, 42501 for another user's", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Session root", tags: ["work"], due_at: etAt("2026-10-22") });
    const f = await insert("tasks", { user_id: userA, title: "Session follower (personal)", tags: ["personal"], due_at: etAt("2026-10-23") });
    const movesJson = JSON.stringify([move(f, etAt("2026-10-26"))]).replace(/'/g, "''");
    const asUser = (userId) => `BEGIN; SET LOCAL role authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${userA}","role":"authenticated"}', true);
      SELECT ${FN}('${userId}', '${r.id}', NULL, '${r.due_at}', 'same_gap', 1, 'all', 'session', '${movesJson}'::jsonb, 'Session root', false)->>'status'; COMMIT;`;
    assert.throws(() => psql(asUser(userB)), /cannot move tasks for another user/);
    assert.match(psql(asUser(userA)), /moved/);
    assert.equal(etDateSql(f.id), "2026-10-26");
    assert.equal(comments(f.id), "system: redacted Session follower (personal)");
  });

  // ── Part 2: PATCH on the real database ──────────────────────────────────
  const ONCORE = ["Calendar build", "MCA review", "Budget build", "Coverage analysis", "Regulatory sign-off", "Test plan", "Go-live checklist"];
  const DATES = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"];

  await test("OnCore 7-task chain: calendar +2 working days moves all 6 after it +2 working days, with comments, a log and the project flag", async () => {
    const oncoreProject = await insert("projects", { user_id: userA, name: "OnCore Workflow Testing", tags: ["work"], rag: "Green", target_date: "2026-10-29" });
    const rows = await chain(ONCORE, DATES, { all: { project_id: oncoreProject.id } });
    const result = await patch(rows[0].id, { due_at: etAt("2026-10-22") });
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
    assert.equal(result.body.cascade.status, "moved");
    assert.equal(result.body.cascade.moves.length, 6);
    assert.deepEqual(rows.slice(1).map((r) => etDateSql(r.id)), ["2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    assert.equal(comments(rows[6].id), 'system: Due date moved from Wed 10/28 to Fri 10/30 because "Calendar build" slipped 2 working days.');
    assert.deepEqual(result.body.cascade.project_flags.map((f) => [f.name, f.rag_after, f.latest_due_date]), [["OnCore Workflow Testing", "Yellow", "2026-10-30"]]);
    assert.equal(psql(`SELECT rag FROM projects WHERE id = '${oncoreProject.id}';`), "Yellow");
    assert.equal(psql(`SELECT count(*) FROM task_date_cascade_moves m JOIN task_date_cascades c ON c.id = m.cascade_id WHERE c.id = '${result.body.cascade.cascade_id}' AND c.root_old_due_at = '${rows[0].due_at}' AND c.delta_workdays = 2;`), "6");
    // Priority recomputed for the moved tasks (they're further away now, so not higher than before).
    assert.ok(Number(psql(`SELECT priority_score FROM tasks WHERE id = '${rows[1].id}';`)) <= rows[1].priority_score);
  });

  await test("Done stops the walk; Parked and undated tasks are walked through, not moved", async () => {
    const rows = await chain(["R", "s1", "Parked step", "s3", "No date step", "s5", "Done step", "s7"],
      ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", null, "2026-10-27", "2026-10-28", "2026-10-29"],
      { "Parked step": { status: "Parked" }, "Done step": { status: "Done" } });
    const result = await patch(rows[0].id, { due_at: etAt("2026-10-21") });
    assert.deepEqual(result.body.cascade.moves.map((m) => m.title), ["s1", "s3", "s5"]);
    assert.deepEqual(rows.map((r) => (r.due_at ? etDateSql(r.id) : null)), ["2026-10-21", "2026-10-22", "2026-10-22", "2026-10-26", null, "2026-10-28", "2026-10-28", "2026-10-29"]);
    assert.deepEqual(result.body.cascade.skipped.map((s) => [s.title, s.reason]).sort(), [["Done step", "done"], ["No date step", "no_due_date"], ["Parked step", "parked"]]);
  });

  await test("A loop already in the data (made before 061) can't spin the cascade: each task moves once", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Loop root", tags: ["work"], due_at: etAt("2026-10-20") });
    const b = await insert("tasks", { user_id: userA, title: "Loop b", tags: ["work"], due_at: etAt("2026-10-21") });
    const c = await insert("tasks", { user_id: userA, title: "Loop c", tags: ["work"], due_at: etAt("2026-10-22") });
    await link(b.id, r.id);
    await link(c.id, b.id);
    psql(`ALTER TABLE task_dependencies DISABLE TRIGGER trg_task_dependencies_guard_loop;
          INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) VALUES ('${userA}', '${b.id}', '${c.id}'), ('${userA}', '${r.id}', '${c.id}');
          ALTER TABLE task_dependencies ENABLE TRIGGER trg_task_dependencies_guard_loop;`);
    const result = await patch(r.id, { due_at: etAt("2026-10-21") });
    assert.equal(result.status, 200);
    assert.equal(result.body.cascade.moves.length, 2);
    assert.equal(etDateSql(r.id), "2026-10-21");
    assert.equal(etDateSql(b.id), etDateSql(c.id)); // the floor inside the loop
  });

  await test("Diamond: the task after two branches moves once and never ends before either branch", async () => {
    const a = await insert("tasks", { user_id: userA, title: "Diamond a", tags: ["work"], due_at: etAt("2026-10-20") });
    const b = await insert("tasks", { user_id: userA, title: "Diamond b", tags: ["work"], due_at: etAt("2026-10-21") });
    const c = await insert("tasks", { user_id: userA, title: "Diamond c", tags: ["work"], due_at: etAt("2026-10-21") });
    const e = await insert("tasks", { user_id: userA, title: "Diamond e", tags: ["work"], due_at: etAt("2026-10-23") });
    const d = await insert("tasks", { user_id: userA, title: "Diamond d", tags: ["work"], due_at: etAt("2026-10-22") });
    for (const [w, o] of [[b, a], [c, a], [e, c], [d, b], [d, e]]) await link(w.id, o.id);
    const result = await patch(a.id, { due_at: etAt("2026-10-21") });
    assert.equal(result.body.cascade.moves.filter((m) => m.task_id === d.id).length, 1);
    assert.equal(etDateSql(d.id), "2026-10-26");
    assert.equal(etDateSql(e.id), "2026-10-26");
    assert.match(comments(d.id), /kept on or after the task it waits on/);
  });

  await test("FamCal moves a personal task: the personal follower moves; the work task after it and the personal task behind that work task don't; reply is projectTaskForFamcal", async () => {
    const license = await insert("tasks", { user_id: userA, title: "MA driver's license transfer", tags: ["personal"], due_at: etAt("2026-10-20") });
    const voter = await insert("tasks", { user_id: userA, title: "Voter registration", tags: ["personal"], due_at: etAt("2026-10-22") });
    const workAfter = await insert("tasks", { user_id: userA, title: "Secret work follow-on", tags: ["work"], due_at: etAt("2026-10-23") });
    const behindWork = await insert("tasks", { user_id: userA, title: "Personal behind work", tags: ["personal"], due_at: etAt("2026-10-26") });
    await link(voter.id, license.id);
    await link(workAfter.id, license.id);
    await link(behindWork.id, workAfter.id);
    const result = await patch(license.id, { due_at: etAt("2026-10-22") }, "famcal_api_key");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(etDateSql(voter.id), "2026-10-26");
    assert.equal(etDateSql(workAfter.id), "2026-10-23");
    assert.equal(etDateSql(behindWork.id), "2026-10-26");
    assert.equal(comments(voter.id), "system: Due date moved from Thu 10/22 to Mon 10/26 because \"MA driver's license transfer\" slipped 2 working days.");
    assert.equal(comments(workAfter.id), "");
    const { data: row } = await admin.from("tasks").select("*, project:projects(*)").eq("id", license.id).single();
    assert.deepEqual(Object.keys(result.body).sort(), Object.keys(famcal.projectTaskForFamcal(row)).sort());
    assert.equal(JSON.stringify(result.body).includes("Secret work"), false);
    assert.equal(psql(`SELECT scope || ' ' || source FROM task_date_cascades WHERE root_task_id = '${license.id}';`), "famcal famcal_api_key");
  });

  await test("Brent moves a work task: the personal task after it moves, and its comment (which FamCal can read) never names the work task", async () => {
    const workRoot = await insert("tasks", { user_id: userA, title: "Secret work milestone", tags: ["work"], due_at: etAt("2026-10-20") });
    const plates = await insert("tasks", { user_id: userA, title: "Pick up the new plates", tags: ["personal"], due_at: etAt("2026-10-21") });
    await link(plates.id, workRoot.id);
    const result = await patch(workRoot.id, { due_at: etAt("2026-10-22") });
    assert.equal(result.body.cascade.moves[0].task_id, plates.id);
    assert.equal(etDateSql(plates.id), "2026-10-23");
    const response = await commentsRoute.GET(routeRequest("famcal_api_key", "GET", `/api/tasks/${plates.id}/comments`), params(plates.id));
    assert.equal(response.status, 200);
    const text = JSON.stringify(await response.json());
    assert.match(text, /because a task it depends on moved later\./);
    assert.equal(text.includes("Secret work"), false);
  });

  await test("The two-statement seam on a real lock: a follower held past lock_timeout → 200, cascade failed, a system comment on the task, follower unchanged", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Seam root", tags: ["work"], due_at: etAt("2026-10-20") });
    const f = await insert("tasks", { user_id: userA, title: "Seam follower", tags: ["work"], due_at: etAt("2026-10-21") });
    await link(f.id, r.id);
    const holder = psqlConnection("holder");
    try {
      holder.send(`BEGIN; SELECT id FROM tasks WHERE id = '${f.id}' FOR UPDATE; SELECT 'held';`);
      await holder.waitFor("held");
      const result = await patch(r.id, { due_at: etAt("2026-10-22") });
      assert.equal(result.status, 200);
      assert.equal(result.body.cascade.status, "failed");
      assert.equal(etDateSql(r.id), "2026-10-22");
      assert.equal(etDateSql(f.id), "2026-10-21");
      assert.equal(comments(r.id), `system: ${cascade.cascadeRootNotice("failed")}`);
      assert.equal(psql(`SELECT count(*) FROM task_date_cascades WHERE root_task_id = '${r.id}';`), "0");
    } finally {
      holder.send("ROLLBACK;");
      await holder.end();
    }
  });

  await test("Two date moves on the same chain at once: nothing moves twice from stale data; every date matches its log", async () => {
    const rows = await chain(["Race root", "Race 1", "Race 2", "Race 3"], ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    const [first, second] = await Promise.all([
      patch(rows[0].id, { due_at: etAt("2026-10-22") }),
      patch(rows[0].id, { due_at: etAt("2026-10-23") }),
    ]);
    // Since fix round 1 the root save is a compare-and-set on the date the plan
    // was made from: a PATCH that lost the race is a 409 with nothing saved.
    for (const result of [first, second]) assert.ok([200, 409].includes(result.status), String(result.status));
    assert.ok(first.status === 200 || second.status === 200, "at least one move lands");
    for (const r of rows.slice(1)) {
      const log = psql(`SELECT coalesce(string_agg(m.old_due_at || '>' || m.new_due_at, ',' ORDER BY c.created_at, m.created_at), '') FROM task_date_cascade_moves m JOIN task_date_cascades c ON c.id = m.cascade_id WHERE m.task_id = '${r.id}';`);
      const now = psql(`SELECT due_at FROM tasks WHERE id = '${r.id}';`);
      const steps = log ? log.split(",") : [];
      // Each step starts where the one before ended (no overwrite of a newer date)…
      let at = psql(`SELECT '${r.due_at}'::timestamptz;`);
      for (const step of steps) {
        const [from, to] = step.split(">");
        assert.equal(from, at, `${r.title}: step ${step} starts at ${at}`);
        at = to;
      }
      // …and the task ends where its log says.
      assert.equal(now, at, r.title);
      assert.ok(steps.length <= 2, r.title);
    }
    for (const result of [first, second]) {
      if (result.status === 200) assert.ok(["moved", "superseded", "not_applicable"].includes(result.body.cascade.status), result.body.cascade.status);
    }
    // With one winner, the chain sits exactly at the winner's gap from where it started.
    if (first.status !== second.status) {
      const winner = first.status === 200 ? etAt("2026-10-22") : etAt("2026-10-23");
      assert.equal(psql(`SELECT due_at = '${winner}'::timestamptz FROM tasks WHERE id = '${rows[0].id}';`), "t");
      const expected = winner === etAt("2026-10-22") ? ["2026-10-23", "2026-10-26", "2026-10-27"] : ["2026-10-26", "2026-10-27", "2026-10-28"];
      assert.deepEqual(rows.slice(1).map((r) => etDateSql(r.id)), expected);
    }
  });
  // ── Part 3: fix round 1 (Fable ecd121ca, Codex Astra) ───────────────────
  async function famcalCommentsText(taskId) {
    const response = await commentsRoute.GET(routeRequest("famcal_api_key", "GET", `/api/tasks/${taskId}/comments`), params(taskId));
    assert.equal(response.status, 200);
    return JSON.stringify(await response.json());
  }

  await test("R1 P1-1: rename + re-tag work→personal + later date in one PATCH: FamCal never reads the old work title on the follower", async () => {
    const root = await insert("tasks", { user_id: userA, title: "Secret work launch", tags: ["work"], due_at: etAt("2026-10-20") });
    const follower = await insert("tasks", { user_id: userA, title: "Book the movers", tags: ["personal"], due_at: etAt("2026-10-21") });
    await link(follower.id, root.id);
    const result = await patch(root.id, { title: "Personal reminder", tags: ["personal"], due_at: etAt("2026-10-22") });
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300));
    assert.equal(etDateSql(follower.id), "2026-10-23");
    const text = await famcalCommentsText(follower.id);
    assert.equal(text.includes("Secret work launch"), false);
    assert.match(text, /a task it depends on moved later/);
  });

  await test("R1 P1-2 A: a redacted comment carries no date or gap of the hidden task (only_collisions and same_gap)", async () => {
    for (const mode of ["only_collisions", "same_gap"]) {
      const root = await insert("tasks", { user_id: userA, title: `Hidden ${mode}`, tags: ["work"], due_at: etAt("2026-10-20") });
      const follower = await insert("tasks", { user_id: userA, title: `Personal ${mode}`, tags: ["personal"], due_at: etAt("2026-10-21") });
      await link(follower.id, root.id);
      await patch(root.id, { due_at: etAt("2026-10-22"), cascade_mode: mode });
      const text = await famcalCommentsText(follower.id);
      assert.doesNotMatch(text, /moved to|slipped|working day/, mode);
      assert.match(text, /because a task it depends on moved later\./, mode);
    }
  });

  await test("R1 P2-3: a FamCal-visible root gets NO comment about a work project past its target (the caller's reply keeps the flag)", async () => {
    const workProject = await insert("projects", { user_id: userA, name: "Secret work program", tags: ["work"], rag: "Green", target_date: "2026-10-22" });
    const root = await insert("tasks", { user_id: userA, title: "Personal errand root", tags: ["personal"], due_at: etAt("2026-10-20") });
    const workDep = await insert("tasks", { user_id: userA, title: "Work step", tags: ["work"], due_at: etAt("2026-10-21"), project_id: workProject.id });
    await link(workDep.id, root.id);
    const result = await patch(root.id, { due_at: etAt("2026-10-22") });
    assert.equal(etDateSql(workDep.id), "2026-10-23");
    assert.equal(psql(`SELECT rag FROM projects WHERE id = '${workProject.id}';`), "Yellow");
    assert.deepEqual(result.body.cascade.project_flags.map((f) => f.name), ["Secret work program"]);
    assert.equal(comments(root.id), "");
    const text = await famcalCommentsText(root.id);
    for (const leak of ["Secret work program", "another project", "target date", "Yellow", "Thu 10/22"]) assert.equal(text.includes(leak), false, leak);
  });

  await test("R1 P1-3: 600 hidden work tasks waiting on a personal task change nothing FamCal sees: the personal follower moves, no notice", async () => {
    const root = await insert("tasks", { user_id: userA, title: "Personal fan root", tags: ["personal"], due_at: etAt("2026-10-20") });
    const follower = await insert("tasks", { user_id: userA, title: "Personal fan follower", tags: ["personal"], due_at: etAt("2026-10-22") });
    await link(follower.id, root.id);
    psql(`WITH made AS (
            INSERT INTO tasks (user_id, title, tags, due_at)
            SELECT '${userA}', 'Hidden fan ' || g, ARRAY['work'], '${etAt("2026-10-22")}'::timestamptz FROM generate_series(1, 600) g
            RETURNING id)
          INSERT INTO task_dependencies (user_id, task_id, depends_on_task_id) SELECT '${userA}', id, '${root.id}' FROM made;`);
    const result = await patch(root.id, { due_at: etAt("2026-10-22") }, "famcal_api_key");
    assert.equal(result.status, 200);
    assert.equal("cascade" in result.body, false);
    assert.equal(etDateSql(follower.id), "2026-10-26");
    assert.equal(comments(root.id), "");
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE user_id = '${userA}' AND title LIKE 'Hidden fan %' AND (due_at AT TIME ZONE 'America/New_York')::date <> '2026-10-22';`), "0");
  });

  // Pauses the first `select('*')…single()` read of tasks (the PATCH's own read
  // of the task) until resume() is called.
  function pausedClient() {
    let armed = true;
    let signal;
    let release;
    const read = new Promise((resolve) => { signal = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const wrap = (builder, ops) => new Proxy(builder, {
      get(inner, prop) {
        if (prop === "then") {
          const capture = armed && ops.some(([name]) => name === "single") && ops.some(([name, args]) => name === "select" && args[0] === "*");
          if (capture) armed = false;
          return (resolve, reject) => inner.then(async (result) => {
            if (capture) { signal(); await gate; }
            return result;
          }).then(resolve, reject);
        }
        const value = inner[prop];
        if (typeof value !== "function") return value;
        return (...args) => wrap(value.apply(inner, args), [...ops, [prop, args]]);
      },
    });
    const client = new Proxy(admin, {
      get(target, prop) {
        if (prop === "from") return (table) => (table === "tasks" ? wrap(target.from(table), []) : target.from(table));
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { client, read, resume: () => release() };
  }

  await test("R1 P2-1: two overlapping PATCHes on one task: the stale one is a 409 with nothing saved (no extra shift); a retry gives the serial gap", async () => {
    const root = await insert("tasks", { user_id: userA, title: "Overlap root", tags: ["work"], due_at: etAt("2026-10-20") });
    const child = await insert("tasks", { user_id: userA, title: "Overlap child", tags: ["work"], due_at: etAt("2026-10-22") });
    await link(child.id, root.id);
    const paused = pausedClient();
    const pending = patch(root.id, { due_at: etAt("2026-10-22") }, "legacy_api_key", paused.client);
    await paused.read;
    const intervening = await patch(root.id, { due_at: etAt("2026-10-21") });
    assert.equal(intervening.body.cascade.status, "moved");
    assert.equal(etDateSql(child.id), "2026-10-23");
    paused.resume();
    const stale = await pending;
    assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 300));
    assert.equal(etDateSql(root.id), "2026-10-21");
    assert.equal(etDateSql(child.id), "2026-10-23");
    const retry = await patch(root.id, { due_at: etAt("2026-10-22") });
    assert.equal(retry.status, 200);
    // Serial: Tue→Wed moved the child Thu→Fri; Wed→Thu moves it Fri→Mon.
    assert.equal(etDateSql(child.id), "2026-10-26");
  });

  await test("R1 P2-2: a project re-tag that is in flight when the cascade runs is waited for; the comment follows the committed tags (redacted)", async () => {
    const personalProject = await insert("projects", { user_id: userA, name: "Home move", tags: ["personal"], rag: "Green" });
    const root = await insert("tasks", { user_id: userA, title: "Root in a personal project", tags: ["personal"], due_at: etAt("2026-10-20"), project_id: personalProject.id });
    const follower = await insert("tasks", { user_id: userA, title: "Standalone personal follower", tags: ["personal"], due_at: etAt("2026-10-21") });
    await link(follower.id, root.id);
    const retag = psqlConnection("retag");
    let result;
    try {
      retag.send(`BEGIN; UPDATE projects SET tags = ARRAY['work'] WHERE id = '${personalProject.id}'; SELECT 'retag-held';`);
      await retag.waitFor("retag-held");
      const pending = patch(root.id, { due_at: etAt("2026-10-22") });
      let done = false;
      pending.then(() => { done = true; });
      await sleep(1500);
      assert.equal(done, false, "the cascade waited for the project re-tag");
      retag.send("COMMIT; SELECT 'retag-done';");
      await retag.waitFor("retag-done");
      result = await pending;
    } finally {
      await retag.end();
    }
    assert.equal(result.status, 200);
    assert.equal(etDateSql(follower.id), "2026-10-23");
    assert.equal(comments(follower.id), "system: Due date moved from Wed 10/21 to Fri 10/23 because a task it depends on moved later.");
  });

  await test("R1 LOW a: the function refuses a root that became Done (or recurring) after planning: superseded, nothing moves", async () => {
    for (const change of ["status = 'Done'", `recurring_template_id = '${g.a.id}'`]) {
      const r = await insert("tasks", { user_id: userA, title: "Finished root", tags: ["work"], due_at: etAt("2026-10-22") });
      const f = await insert("tasks", { user_id: userA, title: "After a finished root", tags: ["work"], due_at: etAt("2026-10-23") });
      psql(`UPDATE tasks SET ${change} WHERE id = '${r.id}';`);
      const { data, error } = await admin.rpc(FN, rpcArgs(r, { p_moves: [move(f, etAt("2026-10-26"))] }));
      assert.equal(error, null, change);
      assert.equal(data.status, "superseded", change);
      assert.equal(etDateSql(f.id), "2026-10-23", change);
    }
  });

  await test("R1 P2-4 (low): a base-priority edit after planning keeps its own score; an unchanged base gets the planned one", async () => {
    const r = await insert("tasks", { user_id: userA, title: "Priority root", tags: ["work"], due_at: etAt("2026-10-22") });
    const edited = await insert("tasks", { user_id: userA, title: "Edited meanwhile", tags: ["work"], due_at: etAt("2026-10-23"), base_priority: 50, priority_score: 50 });
    const plain = await insert("tasks", { user_id: userA, title: "Not edited", tags: ["work"], due_at: etAt("2026-10-23"), base_priority: 50, priority_score: 50 });
    psql(`UPDATE tasks SET base_priority = 90, priority_score = 90 WHERE id = '${edited.id}';`);
    const { data, error } = await admin.rpc(FN, rpcArgs(r, {
      p_moves: [move(edited, etAt("2026-10-26"), { base_priority: 50 }), move(plain, etAt("2026-10-26"), { base_priority: 50 })],
    }));
    assert.equal(error, null);
    assert.equal(data.moved.length, 2);
    assert.equal(psql(`SELECT priority_score FROM tasks WHERE id = '${edited.id}';`), "90");
    assert.equal(psql(`SELECT priority_score FROM tasks WHERE id = '${plain.id}';`), "55");
    assert.equal(psql(`SELECT new_priority_score FROM task_date_cascade_moves WHERE task_id = '${edited.id}';`), "90");
  });
} finally {
  for (const id of users) {
    psql(`DELETE FROM task_comments WHERE user_id = '${id}' OR task_id IN (SELECT id FROM tasks WHERE user_id = '${id}');`);
    psql(`DELETE FROM task_dependencies WHERE user_id = '${id}' OR task_id IN (SELECT id FROM tasks WHERE user_id = '${id}');`);
    await admin.from("task_date_cascades").delete().eq("user_id", id);
    await admin.from("tasks").delete().eq("user_id", id);
    await admin.from("projects").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
