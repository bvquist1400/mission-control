#!/usr/bin/env node
// Database tests for the FamCal scoped key (task 87c256c0, S0 fix round 2), against a
// LOCAL Supabase stack with every migration applied (scripts/test-stack/up.sh):
//
//   FAMCAL_TEST_SUPABASE_URL=$STACK_API_URL FAMCAL_TEST_ANON_KEY=$STACK_ANON_KEY \
//   FAMCAL_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY FAMCAL_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:famcal-db
//
// Part 1: migration 060 (famcal_add_personal_task_comment): rollback and re-apply,
//         grants, the function's rules, and two overlapping transactions (a retag
//         and a comment) in both orders: a comment never lands on a task that
//         isn't personal when it commits.
// Part 2: the real route handlers with the FamCal key's context on the real
//         database: comment POST/GET (R1/R2, incl. a failing insert leaving
//         nothing), the work-relation projection on list/detail/PATCH/park (R3),
//         and the status compare-and-set under a concurrent change (R4).
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.FAMCAL_TEST_SUPABASE_URL;
const anonKey = process.env.FAMCAL_TEST_ANON_KEY;
const serviceKey = process.env.FAMCAL_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.FAMCAL_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set FAMCAL_TEST_SUPABASE_URL, FAMCAL_TEST_ANON_KEY, FAMCAL_TEST_SERVICE_ROLE_KEY and FAMCAL_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/060_famcal_personal_task_comment.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/060_famcal_personal_task_comment.down.sql", import.meta.url), "utf8");
const FN = "famcal_add_personal_task_comment";

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** `first` runs its statement and holds the transaction; `second` must block on it until `first` commits. */
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

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function waitForFunction(present) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { error } = await admin.rpc(FN, { p_user_id: randomUUID(), p_task_id: randomUUID(), p_content: "probe", p_source: "manual" });
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

const userA = await makeUser("famcal-a");
const userB = await makeUser("famcal-b");

process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.DEPLOYMENT_ROLE = "main";

const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
const parkRoute = await import("../src/app/api/tasks/park/[id]/route.ts");

function routeRequest(supabase, authSource, method, path, body) {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase, user: { id: userA }, userId: userA, authSource });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

async function commentCount(taskId) {
  const { count, error } = await admin.from("task_comments").select("id", { count: "exact", head: true }).eq("task_id", taskId);
  if (error) throw error;
  return count;
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
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

try {
  // ── Part 1: migration 060 ───────────────────────────────────────────────
  await test("060 rollback drops the function; re-apply restores it; a second apply is a no-op", async () => {
    psql(ROLLBACK);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname = '${FN}';`), "0");
    await waitForFunction(false);
    psql(MIGRATION);
    psql(MIGRATION);
    assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname = '${FN}';`), "1");
    await waitForFunction(true);
  });

  await test("060 grants: service_role may execute; anon and authenticated may not; SECURITY INVOKER", async () => {
    const sig = `public.${FN}(uuid, uuid, text, text)`;
    assert.equal(psql(`SELECT has_function_privilege('service_role', '${sig}', 'execute');`), "t");
    assert.equal(psql(`SELECT has_function_privilege('anon', '${sig}', 'execute');`), "f");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', '${sig}', 'execute');`), "f");
    assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE proname = '${FN}';`), "f");
    const viaAnon = await anon.rpc(FN, { p_user_id: userA, p_task_id: randomUUID(), p_content: "x", p_source: "manual" });
    assert.ok(viaAnon.error, "anon call refused");
  });

  const personal = await insert("tasks", { user_id: userA, title: "Register to vote", tags: ["personal"] });
  const work = await insert("tasks", { user_id: userA, title: "Day-job ticket", tags: ["work"] });
  const otherUsers = await insert("tasks", { user_id: userB, title: "B's errand", tags: ["personal"] });
  const upperTag = await insert("tasks", { user_id: userA, title: "Upper tag", tags: ["Personal"] });

  await test("function: personal task → one comment (trimmed); work, other user's, missing, 'Personal' → no rows, nothing written", async () => {
    const ok = await admin.rpc(FN, { p_user_id: userA, p_task_id: personal.id, p_content: "  From Sunday brief: done.  ", p_source: "system" });
    assert.equal(ok.error, null);
    assert.equal(ok.data.length, 1);
    assert.equal(ok.data[0].content, "From Sunday brief: done.");
    assert.equal(ok.data[0].source, "system");
    assert.equal(ok.data[0].user_id, userA);
    for (const [label, taskId] of [["work", work.id], ["other user", otherUsers.id], ["missing", randomUUID()], ["Personal (case)", upperTag.id]]) {
      const res = await admin.rpc(FN, { p_user_id: userA, p_task_id: taskId, p_content: "should not land", p_source: "manual" });
      assert.equal(res.error, null, label);
      assert.deepEqual(res.data, [], label);
    }
    assert.equal(await commentCount(work.id), 0);
    assert.equal(await commentCount(otherUsers.id), 0);
    assert.equal(await commentCount(upperTag.id), 0);
  });

  await test("function: empty/oversized content, bad source, null ids → error 22023 and nothing written", async () => {
    const before = await commentCount(personal.id);
    for (const args of [
      { p_content: "   ", p_source: "manual" },
      { p_content: "x".repeat(5001), p_source: "manual" },
      { p_content: "ok", p_source: "robot" },
    ]) {
      const res = await admin.rpc(FN, { p_user_id: userA, p_task_id: personal.id, ...args });
      assert.equal(res.error?.code, "22023", JSON.stringify(args).slice(0, 40));
    }
    assert.throws(() => psql(`SELECT * FROM ${FN}(NULL, '${personal.id}', 'x', 'manual');`), /user id and task id are required/);
    assert.equal(await commentCount(personal.id), before);
  });

  await test("concurrency: retag first, comment waits on it, then sees the task isn't personal and writes nothing", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Race: retag first", tags: ["personal"] });
    const result = await overlap(
      `UPDATE tasks SET tags = ARRAY['work'] WHERE id = '${task.id}';`,
      `SELECT count(*) || ' rows' FROM ${FN}('${userA}', '${task.id}', 'late comment', 'manual');`
    );
    assert.ok(result.secondBlocked, "the comment waited for the retag");
    assert.match(result.second, /0 rows/);
    assert.equal(await commentCount(task.id), 0, "never written");
  });

  await test("concurrency: comment first (task locked FOR SHARE), retag waits; the comment was written while personal", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Race: comment first", tags: ["personal"] });
    const result = await overlap(
      `SELECT count(*) || ' rows' FROM ${FN}('${userA}', '${task.id}', 'early comment', 'manual');`,
      `UPDATE tasks SET tags = ARRAY['work'] WHERE id = '${task.id}';`
    );
    assert.ok(result.secondBlocked, "the retag waited for the comment's transaction");
    assert.match(result.first, /1 rows/);
    assert.equal(await commentCount(task.id), 1);
    assert.equal(psql(`SELECT tags::text FROM tasks WHERE id = '${task.id}';`), "{work}");
  });

  // ── Part 2: real route handlers, FamCal context, real database ───────────
  await test("R1/R2 routes: POST 201, GET returns the task's own comments oldest first (another user's row excluded); work 404; empty 200 []", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Route comments", tags: ["personal"] });
    const first = await commentsRoute.POST(routeRequest(admin, "famcal_api_key", "POST", `/api/tasks/${task.id}/comments`, { content: "first" }), params(task.id));
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.deepEqual(Object.keys(firstBody).sort(), ["content", "created_at", "id", "source", "task_id", "updated_at", "user_id"]);
    await sleep(20);
    assert.equal((await commentsRoute.POST(routeRequest(admin, "famcal_api_key", "POST", `/api/tasks/${task.id}/comments`, { content: "second" }), params(task.id))).status, 201);
    psql(`INSERT INTO task_comments (task_id, user_id, content) VALUES ('${task.id}', '${userB}', 'foreign user row');`);
    const get = await commentsRoute.GET(routeRequest(admin, "famcal_api_key", "GET", `/api/tasks/${task.id}/comments`), params(task.id));
    assert.equal(get.status, 200);
    const rows = await get.json();
    assert.deepEqual(rows.map((row) => row.content), ["first", "second"]);
    assert.deepEqual(Object.keys(rows[0]).sort(), Object.keys(firstBody).sort(), "same row shape as before");
    const workGet = await commentsRoute.GET(routeRequest(admin, "famcal_api_key", "GET", `/api/tasks/${work.id}/comments`), params(work.id));
    assert.equal(workGet.status, 404);
    const workPost = await commentsRoute.POST(routeRequest(admin, "famcal_api_key", "POST", `/api/tasks/${work.id}/comments`, { content: "nope" }), params(work.id));
    assert.equal(workPost.status, 404);
    assert.equal(await commentCount(work.id), 0);
    const emptyTask = await insert("tasks", { user_id: userA, title: "No comments", tags: ["personal"] });
    const empty = await commentsRoute.GET(routeRequest(admin, "famcal_api_key", "GET", `/api/tasks/${emptyTask.id}/comments`), params(emptyTask.id));
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), []);
    // The legacy path is unchanged and still sees every row on the task.
    const legacy = await commentsRoute.GET(routeRequest(admin, "legacy_api_key", "GET", `/api/tasks/${task.id}/comments`), params(task.id));
    assert.equal((await legacy.json()).length, 2, "legacy filters by its own user id as before");
  });

  await test("R1 route: an insert that fails inside the function is a 500 and leaves no comment", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Insert fails", tags: ["personal"] });
    psql(`
      CREATE OR REPLACE FUNCTION famcal_test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.content = 'FAIL-ME' THEN RAISE EXCEPTION 'synthetic insert failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER famcal_test_fail_insert BEFORE INSERT ON task_comments FOR EACH ROW EXECUTE FUNCTION famcal_test_fail_insert();
    `);
    try {
      const response = await commentsRoute.POST(routeRequest(admin, "famcal_api_key", "POST", `/api/tasks/${task.id}/comments`, { content: "FAIL-ME" }), params(task.id));
      assert.equal(response.status, 500);
      assert.equal(await commentCount(task.id), 0, "nothing left behind");
      // The task row lock was released with the rollback: the task can be retagged right away.
      psql(`SET lock_timeout = '2s'; UPDATE tasks SET tags = ARRAY['personal','x'] WHERE id = '${task.id}';`);
    } finally {
      psql("DROP TRIGGER IF EXISTS famcal_test_fail_insert ON task_comments; DROP FUNCTION IF EXISTS famcal_test_fail_insert();");
    }
  });

  // R3 fixtures: a personal task filed under a work application/project/sprint/section,
  // and one under a personal project + section.
  const workApp = await insert("implementations", { user_id: userA, name: "Confidential Client App" });
  const workProject = await insert("projects", { user_id: userA, name: "Confidential Work Project", tags: ["work"], implementation_id: workApp.id });
  const workSprint = await insert("sprints", { user_id: userA, name: "Sprint Secret-42", start_date: "2026-10-12", end_date: "2026-10-23", theme: "Secret go-live theme" });
  const workSection = await insert("project_sections", { user_id: userA, project_id: workProject.id, name: "Secret cutover section" });
  const personalProject = await insert("projects", { user_id: userA, name: "Personal — House admin", tags: ["personal"] });
  const personalSection = await insert("project_sections", { user_id: userA, project_id: personalProject.id, name: "Paperwork" });
  const inWork = await insert("tasks", {
    user_id: userA, title: "Dentist (filed under work)", tags: ["personal"], status: "Planned",
    project_id: workProject.id, section_id: workSection.id, sprint_id: workSprint.id,
  });
  const inPersonal = await insert("tasks", {
    user_id: userA, title: "File the deed", tags: ["personal"], project_id: personalProject.id, section_id: personalSection.id,
  });
  const secrets = [workApp.id, workApp.name, workProject.id, workProject.name, workSprint.id, workSprint.name, workSprint.theme, workSection.id, workSection.name];

  function assertClean(task, label) {
    const text = JSON.stringify(task);
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${label}: leaked ${secret}`);
    for (const key of ["project", "project_id", "implementation", "implementation_id", "sprint", "sprint_id", "section_id", "section_name"]) {
      assert.equal(task[key], null, `${label}: ${key}`);
    }
    assert.equal("user_id" in task, false, `${label}: user_id`);
  }

  await test("R3 (real DB): the hierarchy trigger did put the work application on the task (precondition)", async () => {
    assert.equal(psql(`SELECT implementation_id FROM tasks WHERE id = '${inWork.id}';`), workApp.id);
  });

  await test("R3 routes: list, detail, PATCH and park never return the work relations of a personal task", async () => {
    const list = await tasksRoute.GET(routeRequest(admin, "famcal_api_key", "GET", "/api/tasks?tag=personal&limit=500"));
    assert.equal(list.status, 200);
    const listed = (await list.json()).find((row) => row.id === inWork.id);
    assert.ok(listed, "listed");
    assertClean(listed, "list");
    assert.equal(typeof listed.dependency_blocked, "boolean");
    const detail = await taskRoute.GET(routeRequest(admin, "famcal_api_key", "GET", `/api/tasks/${inWork.id}`), params(inWork.id));
    assertClean(await detail.json(), "detail");
    const patch = await taskRoute.PATCH(routeRequest(admin, "famcal_api_key", "PATCH", `/api/tasks/${inWork.id}`, { follow_up_at: "2026-11-02T04:59:00Z" }), params(inWork.id));
    assert.equal(patch.status, 200);
    assertClean(await patch.json(), "PATCH");
    const park = await parkRoute.POST(routeRequest(admin, "famcal_api_key", "POST", `/api/tasks/park/${inWork.id}`), params(inWork.id));
    assert.equal(park.status, 200);
    const parked = await park.json();
    assertClean(parked, "park");
    assert.equal(parked.status, "Parked");
  });

  await test("R3 routes: a personal project's metadata and section are kept; legacy still sees the work relations", async () => {
    const detail = await taskRoute.GET(routeRequest(admin, "famcal_api_key", "GET", `/api/tasks/${inPersonal.id}`), params(inPersonal.id));
    const body = await detail.json();
    assert.equal(body.project.name, "Personal — House admin");
    assert.deepEqual(body.project.tags, ["personal"]);
    assert.deepEqual(Object.keys(body.project).sort(), ["id", "name", "rag", "stage", "tags"]);
    assert.equal(body.section_name, "Paperwork");
    assert.equal(body.section_id, personalSection.id);
    const legacy = await taskRoute.GET(routeRequest(admin, "legacy_api_key", "GET", `/api/tasks/${inWork.id}`), params(inWork.id));
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.project.name, workProject.name);
    assert.equal(legacyBody.sprint.theme, workSprint.theme);
  });

  await test("R4 route: reopen while someone else changes the status → 409, their status stands; no race → 200", async () => {
    const task = await insert("tasks", { user_id: userA, title: "Reopen race", tags: ["personal"], status: "Done" });
    // A client whose tasks UPDATE is preceded by another writer setting Planned.
    const racing = new Proxy(admin, {
      get(target, prop) {
        if (prop === "from") {
          return (table) => {
            const builder = target.from(table);
            if (table !== "tasks") return builder;
            return new Proxy(builder, {
              get(inner, innerProp) {
                if (innerProp === "update") {
                  return (...args) => {
                    psql(`UPDATE tasks SET status = 'Planned' WHERE id = '${task.id}';`);
                    return inner.update(...args);
                  };
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
    const raced = await taskRoute.PATCH(routeRequest(racing, "famcal_api_key", "PATCH", `/api/tasks/${task.id}`, { status: "Backlog" }), params(task.id));
    assert.equal(raced.status, 409);
    assert.equal(psql(`SELECT status FROM tasks WHERE id = '${task.id}';`), "Planned");
    psql(`UPDATE tasks SET status = 'Done' WHERE id = '${task.id}';`);
    const clean = await taskRoute.PATCH(routeRequest(admin, "famcal_api_key", "PATCH", `/api/tasks/${task.id}`, { status: "Backlog" }), params(task.id));
    assert.equal(clean.status, 200);
    assert.equal(psql(`SELECT status FROM tasks WHERE id = '${task.id}';`), "Backlog");
  });
} finally {
  for (const id of users) {
    psql(`DELETE FROM task_comments WHERE user_id = '${id}' OR task_id IN (SELECT id FROM tasks WHERE user_id = '${id}');`);
    await admin.from("tasks").delete().eq("user_id", id);
    await admin.from("project_sections").delete().eq("user_id", id);
    await admin.from("projects").delete().eq("user_id", id);
    await admin.from("sprints").delete().eq("user_id", id);
    await admin.from("implementations").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
