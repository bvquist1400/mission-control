#!/usr/bin/env node
// Craft estimates E3 on a disposable LOCAL stack (CRAFT_TEST_*): "Add rows to a sitting already logged" through the
// real route (POST /api/craft/[id]/sitting-rows) as a signed-in user (RLS on): Fix count's craft_rows ticks, then ONE
// work_session_update links. No migration: nothing is rolled back or re-applied here. Fake data only; local only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.CRAFT_TEST_SUPABASE_URL, anon = process.env.CRAFT_TEST_ANON_KEY, key = process.env.CRAFT_TEST_SERVICE_ROLE_KEY, container = process.env.CRAFT_TEST_DB_CONTAINER;
if (!url || !anon || !key || container !== "supabase_db_mc-pace" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error("Set CRAFT_TEST_SUPABASE_URL, CRAFT_TEST_ANON_KEY, CRAFT_TEST_SERVICE_ROLE_KEY and CRAFT_TEST_DB_CONTAINER=supabase_db_mc-pace (disposable local stack only).");
  process.exit(2);
}
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A second psql session that keeps its transaction open (for the lock schedules). */
function connection(label) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"]);
  let output = "";
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    send: (sql) => child.stdin.write(sql + "\n"),
    async wait(marker) { for (let i = 0; i < 400; i++) { if (output.includes(marker) || output.includes("ERROR:")) return; await sleep(25); } throw new Error(`${label}: missing ${marker}: ${output}`); },
    async end() { child.stdin.end(); await closed; },
  };
}
async function someoneWaitsOnALock() {
  for (let i = 0; i < 200; i++) {
    if (Number(psql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock';")) > 0) return true;
    await sleep(25);
  }
  return false;
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-e3-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client };
}
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
process.env.SUPABASE_SERVICE_ROLE_KEY = key;
process.env.MISSION_CONTROL_API_KEY = `craft-e3-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const route = await import("../src/app/api/craft/[projectId]/sitting-rows/route.ts");
const { getProjectForecast } = await import("../src/lib/work-sessions/service.ts");
const { getCraftPace } = await import("../src/lib/craft/pace-service.ts");

const lit = (t) => `$lit$${t}$lit$`;
const post = async (who, projectId, body) => {
  const r = new NextRequest(`http://localhost/api/craft/${projectId}/sitting-rows`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  const res = await route.POST(r, { params: Promise.resolve({ projectId }) });
  return { status: res.status, body: await res.json() };
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const daysAgo = (n) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/**
 * A knit project with one 40-row part (30 stitches a row), rows 1–`done` ticked two days ago, and sittings:
 * S1 (2 days ago, 90 min, no rows, on the rows' task), S2 (yesterday, 15 min, rows 1–5 finished), S3 (yesterday, 20 min, row 16 partway).
 */
function seed(owner, name, { done = 10 } = {}) {
  const projectId = randomUUID(), sectionId = randomUUID(), partId = randomUUID(), taskId = randomUUID();
  const items = {}, sessions = { S1: randomUUID(), S2: randomUUID(), S3: randomUUID() };
  let sql = `INSERT INTO projects (id, user_id, name, tags, unit_label, target_date) VALUES ('${projectId}','${owner}',${lit(name)},ARRAY['personal'],'stitches','${daysAgo(-30)}');
INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionId}','${owner}','${projectId}','1. Scarf',0);
INSERT INTO craft_projects (project_id, user_id, craft) VALUES ('${projectId}','${owner}','knit');
INSERT INTO tasks (id, user_id, project_id, section_id, title, status, estimated_minutes, work_type) VALUES ('${taskId}','${owner}','${projectId}','${sectionId}','Scarf rows','In Progress',200,'knit');
INSERT INTO craft_parts (id, user_id, project_id, name, sort_order, total_rows, row_word, stitch_count) VALUES ('${partId}','${owner}','${projectId}','Scarf',0,40,'row',30);
UPDATE craft_projects SET active_part_id = '${partId}' WHERE project_id = '${projectId}';\n`;
  for (let n = 1; n <= 40; n++) {
    const id = randomUUID();
    items[n] = id;
    sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row) VALUES ('${id}','${owner}','${taskId}','Row ${n}',${n <= done},${n <= done ? `'${daysAgo(2)}T23:00:00Z'` : "NULL"},${n},30,'knit','${partId}',${n});\n`;
  }
  sql += `INSERT INTO work_sessions (id, user_id, project_id, task_id, session_date, minutes, source) VALUES
 ('${sessions.S1}','${owner}','${projectId}','${taskId}','${daysAgo(2)}',90,'manual'),
 ('${sessions.S2}','${owner}','${projectId}',NULL,'${daysAgo(1)}',15,'manual'),
 ('${sessions.S3}','${owner}','${projectId}',NULL,'${daysAgo(1)}',20,'manual');
INSERT INTO work_session_items (session_id, checklist_item_id, user_id, in_progress) VALUES
${[1, 2, 3, 4, 5].map((n) => `('${sessions.S2}','${items[n]}','${owner}',false)`).join(",\n")},
('${sessions.S3}','${items[16]}','${owner}',true);\n`;
  psql(sql);
  return { projectId, partId, taskId, items, sessions };
}
const ticked = (partId) => psql(`SELECT coalesce(string_agg(craft_row::text, ',' ORDER BY craft_row), '') FROM task_checklist_items WHERE craft_part_id='${partId}' AND is_done;`);
const linksOf = (sessionId) => psql(`SELECT coalesce(string_agg(i.craft_row::text || CASE WHEN w.in_progress THEN 'p' ELSE '' END, ',' ORDER BY i.craft_row), '') FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id WHERE w.session_id='${sessionId}';`);
const sittingRow = (sessionId) => psql(`SELECT minutes || '|' || coalesce(task_id::text,'') || '|' || session_date || '|' || exclude_from_stats || '|' || coalesce(started_at::text,'') FROM work_sessions WHERE id='${sessionId}';`);
const actual = (taskId) => psql(`SELECT coalesce(actual_minutes::text, 'null') FROM tasks WHERE id='${taskId}';`);
const state = (s) => [ticked(s.partId), linksOf(s.sessions.S1), linksOf(s.sessions.S2), linksOf(s.sessions.S3), sittingRow(s.sessions.S1), actual(s.taskId)].join(" / ");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i).join(",");

const A = await user(), B = await user();
try {
  await test("E3: rows 6–15 to the sitting with no rows: 11–15 ticked, 6–15 linked as finished; its minutes, task, date and the task's actual minutes stay", async () => {
    const s = seed(A.id, "Fake Scarf E3a");
    const before = sittingRow(s.sessions.S1), actualBefore = actual(s.taskId);
    const forecastBefore = (await getProjectForecast(A.client, A.id, s.projectId)).forecast;
    const paceBefore = (await getCraftPace(A.client, A.id, s.projectId)).projects[0].estimate;
    const res = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 6, to_row: 15 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.result.ticked, [11, 12, 13, 14, 15]);
    assert.deepEqual(res.body.result.added, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.equal(res.body.result.minutes, 90);
    assert.equal(ticked(s.partId), range(1, 15));
    assert.equal(linksOf(s.sessions.S1), range(6, 15));
    assert.equal(linksOf(s.sessions.S2), range(1, 5), "the other sitting is untouched");
    assert.equal(linksOf(s.sessions.S3), "16p");
    assert.equal(sittingRow(s.sessions.S1), before, "minutes, task, date, left-out flag and start unchanged");
    assert.equal(actual(s.taskId), actualBefore, "actual minutes unchanged");
    assert.equal(res.body.view.active_part.current_row, 16, "the reply carries the fresh view");
    // The forecast moves the right way: one more sitting with rows, the same minutes, the sitting off the no-rows list.
    const forecastAfter = (await getProjectForecast(A.client, A.id, s.projectId)).forecast;
    assert.equal(forecastAfter.sittings_with_rows, forecastBefore.sittings_with_rows + 1);
    assert.equal(forecastAfter.cadence_minutes_per_day, forecastBefore.cadence_minutes_per_day);
    assert.ok(forecastAfter.work_left_minutes < forecastBefore.work_left_minutes, "rows 11–15 are done now");
    const paceAfter = (await getCraftPace(A.client, A.id, s.projectId)).projects[0].estimate;
    assert.ok(paceBefore.sittings_without_rows.some((x) => x.id === s.sessions.S1));
    assert.ok(!paceAfter.sittings_without_rows.some((x) => x.id === s.sessions.S1));
    // The same request again: nothing new, nothing written.
    const again = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 16, from_row: 6, to_row: 15 });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.result.added, []);
    assert.deepEqual(again.body.result.already, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.equal(linksOf(s.sessions.S1), range(6, 15));
  });

  await test("E3: a row partway in that sitting becomes finished; a row partway in another sitting can be added (that sitting keeps its link)", async () => {
    const s = seed(A.id, "Fake Scarf E3b", { done: 15 });
    const own = await post(A, s.projectId, { session_id: s.sessions.S3, part_id: s.partId, expected_row: 16, from_row: 16, to_row: 16 });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(linksOf(s.sessions.S3), "16", "in progress → finished");
    assert.equal(ticked(s.partId), range(1, 16));
    const t = seed(A.id, "Fake Scarf E3c", { done: 15 });
    const other = await post(A, t.projectId, { session_id: t.sessions.S1, part_id: t.partId, expected_row: 16, from_row: 11, to_row: 16 });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(linksOf(t.sessions.S1), range(11, 16));
    assert.equal(linksOf(t.sessions.S3), "16p");
  });

  await test("E3: rows another sitting finished are refused; nothing changes", async () => {
    const s = seed(A.id, "Fake Scarf E3d");
    const before = state(s);
    const res = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 3, to_row: 12 });
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "in_sitting");
    assert.equal(res.body.error, "Not saved: Rows 3–5 are already in a sitting. A row is finished in one sitting only.");
    assert.equal(state(s), before);
  });

  await test("E3: another project's part or sitting is a 404, another user's project too (RLS); a stale count and earlier unticked rows are refused; nothing changes", async () => {
    const s = seed(A.id, "Fake Scarf E3e"), other = seed(A.id, "Fake Other E3e");
    const before = state(s), otherBefore = state(other);
    const wrongPart = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: other.partId, expected_row: 11, from_row: 11, to_row: 12 });
    const wrongSitting = await post(A, s.projectId, { session_id: other.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 11, to_row: 12 });
    const stranger = await post(B, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 11, to_row: 12 });
    const stale = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 9, from_row: 11, to_row: 12 });
    const earlier = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 14, to_row: 15 });
    const minutes = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 11, to_row: 12, minutes: 5 });
    assert.deepEqual([wrongPart.status, wrongSitting.status, stranger.status, stale.status, earlier.status, minutes.status], [404, 404, 404, 409, 409, 400]);
    assert.equal(stale.body.reason, "stale");
    assert.equal(earlier.body.error, "Not saved: Rows 11–13 before row 14 aren't ticked. Start at row 11.");
    assert.equal(state(s), before);
    assert.equal(state(other), otherBefore);
  });

  await test("E3: the whole part in one go, to the last row", async () => {
    const s = seed(A.id, "Fake Scarf E3f", { done: 5 });
    psql(`DELETE FROM work_session_items WHERE session_id IN ('${s.sessions.S2}','${s.sessions.S3}');`);
    const res = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 6, from_row: 1, to_row: 40 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(ticked(s.partId), range(1, 40));
    assert.equal(linksOf(s.sessions.S1), range(1, 40));
    assert.equal(res.body.view.active_part.finished, true, "every row ticked: the part is finished");
  });
  await test("E3 (076): one transaction: a failure on the last link (after the ticks) leaves no row ticked and no link", async () => {
    const s = seed(A.id, "Fake Scarf E3g");
    const before = state(s);
    // Fail the insert of row 15's link, the last write the call makes (rows 11–15 are ticked first).
    psql(`CREATE FUNCTION e3_fail_link() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.checklist_item_id = '${s.items[15]}' THEN RAISE EXCEPTION 'forced failure for the test'; END IF; RETURN NEW; END $f$;
      CREATE TRIGGER e3_fail_link BEFORE INSERT ON work_session_items FOR EACH ROW EXECUTE FUNCTION e3_fail_link();`);
    let res;
    const quiet = console.error; console.error = () => {};
    try {
      res = await post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 6, to_row: 15 });
    } finally {
      console.error = quiet;
      psql("DROP TRIGGER e3_fail_link ON work_session_items; DROP FUNCTION e3_fail_link();");
    }
    assert.equal(res.status, 500);
    assert.equal(state(s), before, "rows 11–15 not ticked, no link, the sitting as it was");
    assert.equal(ticked(s.partId), range(1, 10));
    assert.equal(linksOf(s.sessions.S1), "");
  });

  await test("E3 (076): another sitting finishing one of the rows at the same moment: the call waits for it, then refuses; nothing written", async () => {
    const s = seed(A.id, "Fake Scarf E3h");
    const conn = connection("e3-race");
    // Another writer holds the rows' task (as every session writer does first) and links row 8 to S2, not committed yet.
    conn.send(`BEGIN; SELECT 1 FROM tasks WHERE id = '${s.taskId}' FOR NO KEY UPDATE;
      INSERT INTO work_session_items (session_id, checklist_item_id, user_id, in_progress) VALUES ('${s.sessions.S2}','${s.items[8]}','${A.id}',false); SELECT 'held';`);
    await conn.wait("held");
    const pending = post(A, s.projectId, { session_id: s.sessions.S1, part_id: s.partId, expected_row: 11, from_row: 6, to_row: 10 });
    assert.ok(await someoneWaitsOnALock(), "the call waits on the task lock");
    conn.send("COMMIT; SELECT 'done';");
    await conn.wait("done");
    await conn.end();
    const res = await pending;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.reason, "in_sitting");
    assert.equal(res.body.error, "Not saved: Row 8 is already in a sitting. A row is finished in one sitting only.");
    assert.equal(linksOf(s.sessions.S1), "", "row 8 is never in two sittings");
    assert.equal(linksOf(s.sessions.S2), "1,2,3,4,5,8");
    assert.equal(ticked(s.partId), range(1, 10));
  });

  await test("E3 (076): the function is SECURITY INVOKER with the craft RPCs' grants (authenticated + service_role, not anon or PUBLIC)", async () => {
    const sig = "craft_add_sitting_rows(uuid,uuid,uuid,uuid,integer,integer,integer)";
    assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), "f");
    assert.equal(psql(`SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), "search_path=public;lock_timeout=5s");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', '${sig}', 'EXECUTE')::text || has_function_privilege('service_role', '${sig}', 'EXECUTE')::text || has_function_privilege('anon', '${sig}', 'EXECUTE')::text;`), "truetruefalse");
    assert.equal(psql("SELECT has_function_privilege('anon', 'craft_frog(uuid,uuid,integer,integer,integer,text,uuid[],text)', 'EXECUTE')::text;"), "false", "same as craft_frog");
    // Another user can't write for A (work_sessions_assert_caller) and can't see A's sitting (RLS).
    const s = seed(A.id, "Fake Scarf E3i");
    const asOther = await B.client.rpc("craft_add_sitting_rows", { p_user_id: A.id, p_project_id: s.projectId, p_session_id: s.sessions.S1, p_part_id: s.partId, p_expected_row: 11, p_from_row: 6, p_to_row: 7 });
    assert.equal(asOther.error?.code, "42501");
    const ownId = await B.client.rpc("craft_add_sitting_rows", { p_user_id: B.id, p_project_id: s.projectId, p_session_id: s.sessions.S1, p_part_id: s.partId, p_expected_row: 11, p_from_row: 6, p_to_row: 7 });
    assert.equal(ownId.error?.code, "P0002");
    assert.equal(linksOf(s.sessions.S1), "");
  });
} finally {
  // Fake users only; the stack is disposable (down.sh deletes its volumes).
  console.log(`fake users made: ${users.length}`);
}
console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
