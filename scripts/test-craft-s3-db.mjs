#!/usr/bin/env node
// Craft S3 on a disposable LOCAL stack (CRAFT_TEST_*): migration 074 (rows in progress, Ripped back, the S2 follow-ups
// F1–F3 and F5 in SQL) through the real routes and as SQL: every path that rewrites a sitting's links, craft_frog's
// rules and guards, pace parity and 074's rollback. Destructive only to this local stack. Fake data only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.CRAFT_TEST_SUPABASE_URL, anon = process.env.CRAFT_TEST_ANON_KEY, key = process.env.CRAFT_TEST_SERVICE_ROLE_KEY, container = process.env.CRAFT_TEST_DB_CONTAINER;
if (!url || !anon || !key || container !== "supabase_db_mc-pace" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error("Set CRAFT_TEST_SUPABASE_URL, CRAFT_TEST_ANON_KEY, CRAFT_TEST_SERVICE_ROLE_KEY and CRAFT_TEST_DB_CONTAINER=supabase_db_mc-pace (disposable local stack only).");
  process.exit(2);
}
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
// 074 (S3) sits on 073: rolled back before 073's rollback and re-applied after it.
const up074 = readFileSync(new URL("../supabase/migrations/074_craft_progress.sql", import.meta.url), "utf8");
const down074 = readFileSync(new URL("../supabase/rollbacks/074_craft_progress.down.sql", import.meta.url), "utf8");
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connection(label) {
  const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"]);
  let output = "";
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    send: (sql) => child.stdin.write(sql + "\n"),
    output: () => output,
    async wait(marker) { for (let i = 0; i < 400; i++) { if (output.includes(marker) || output.includes("ERROR:")) return; await sleep(25); } throw new Error(`${label}: missing ${marker}: ${output}`); },
    async end() { child.stdin.end(); await closed; },
  };
}
async function waitingOnLock(label) {
  for (let i = 0; i < 200; i++) {
    if (psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event_type='Lock';`) === "1") return true;
    await sleep(25);
  }
  return false;
}
let passed = 0, failed = 0;
const only = process.env.CRAFT_S3_ONLY ? new RegExp(process.env.CRAFT_S3_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-s3-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-s3-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const rowRoute = await import("../src/app/api/craft/[projectId]/row/route.ts");
const timerRoute = await import("../src/app/api/craft/[projectId]/timer/route.ts");
const sittingsRoute = await import("../src/app/api/craft/[projectId]/sittings/route.ts");
const totalRoute = await import("../src/app/api/craft/[projectId]/total/route.ts");
const notesRoute = await import("../src/app/api/craft/[projectId]/notes/route.ts");
const detailRoute = await import("../src/app/api/craft/[projectId]/route.ts");
const { loadSetupSnapshot } = await import("../src/lib/craft/setup-service.ts");
const { planCraftSetup, craftSetupPayload } = await import("../src/lib/craft/setup.ts");
const { getProjectPace, getProjectForecast, logWorkSession } = await import("../src/lib/work-sessions/service.ts");
const { fixCountPlan, setTotalPlan, sittingPlan } = await import("../src/lib/craft/actions.ts");

const lit = (t) => `$lit$${t}$lit$`;
const ctx = (projectId) => ({ params: Promise.resolve({ projectId }) });
const req = (who, method, path, body) => {
  const r = new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  return r;
};
const post = async (route, who, projectId, path, body, method = "POST") => {
  const res = await route[method](req(who, method, `/api/craft/${projectId}/${path}`, body), ctx(projectId));
  return { status: res.status, body: await res.json() };
};
const rpc = async (who, name, args) => who.client.rpc(name, args);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

/**
 * A craft project seeded with SQL: one section, one task per band holding its "Row N" items (units = stitch count,
 * work type per band) and, when given, a plain "Count …" item; craft project, parts, segments and the row links.
 * parts: [{ name, word, total, done, stitch, quarters, ridges, bands: [[name, from, to, close, countText]], gaps: [rows] }]
 */
function seedCraft(owner, name, parts, { craft = "crochet", unitLabel = "stitches" } = {}) {
  const projectId = randomUUID(), sectionId = randomUUID(), out = { projectId, parts: [], tasks: {}, items: {} };
  let sql = `INSERT INTO projects (id, user_id, name, tags, unit_label) VALUES ('${projectId}','${owner}',${lit(name)},ARRAY['crochet'],${unitLabel ? `'${unitLabel}'` : "NULL"});
INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionId}','${owner}','${projectId}','Main',0);
INSERT INTO craft_projects (project_id, user_id, craft) VALUES ('${projectId}','${owner}','${craft}');\n`;
  let k = 0;
  parts.forEach((part, pi) => {
    const partId = randomUUID();
    out.parts.push(partId);
    sql += `INSERT INTO craft_parts (id, user_id, project_id, name, sort_order, total_rows, row_word, quarters, ridges, stitch_count) VALUES ('${partId}','${owner}','${projectId}',${lit(part.name)},${pi},${part.total},'${part.word === "Row" ? "row" : "round"}',${part.quarters ? "true" : "false"},${part.ridges ? "true" : "false"},${part.stitch ?? "NULL"});\n`;
    (part.bands ?? [[part.name, 1, part.total, false, null]]).forEach(([band, from, to, close, countText], bi) => {
      const taskId = randomUUID(), segId = randomUUID();
      out.tasks[band] = taskId;
      // Bands finished before the screen are Done with their count ticked, as on the live blanket (rows 1–52).
      const bandDone = to <= (part.done ?? 0);
      sql += `INSERT INTO tasks (id, user_id, project_id, section_id, title, status, created_at) VALUES ('${taskId}','${owner}','${projectId}','${sectionId}',${lit(band)},'${bandDone ? "Done" : "Planned"}','2026-11-02T00:00:00Z'::timestamptz + interval '${k++} seconds');\n`;
      sql += `INSERT INTO craft_segments (id, user_id, part_id, task_id, name, from_row, to_row, sort_order, close_check) VALUES ('${segId}','${owner}','${partId}','${taskId}',${lit(band)},${from},${to},${bi},${close ? "true" : "false"});\n`;
      out.tasks[`${band}:segment`] = segId;
      for (let n = from; n <= to; n++) {
        if ((part.gaps ?? []).includes(n)) continue;
        const itemId = randomUUID();
        out.items[`${part.name}:${n}`] = itemId;
        sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row) VALUES ('${itemId}','${owner}','${taskId}',${lit(`${part.word} ${n}`)},${n <= (part.done ?? 0)},${n <= (part.done ?? 0) ? "'2026-11-05T23:00:00Z'" : "NULL"},${n},${part.stitch ?? "NULL"},${lit(part.type ?? "waffle")},'${partId}',${n});\n`;
      }
      if (countText) {
        const countId = randomUUID();
        out.items[`${band}:count`] = countId;
        sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${countId}','${owner}','${taskId}',${lit(countText)},${bandDone},1000);\n`;
      }
    });
  });
  psql(sql);
  return out;
}
const BLANKET_BANDS = [["Foundation", 1, 1, false, null], ["Waffle 1", 2, 18, true, "Count the last row: 195 stitches"], ["Tree 1", 19, 37, true, "Count the last row: 195 stitches"],
  ["Waffle 2", 38, 52, true, "Count the last row: 195 stitches"], ["Tree 2", 53, 71, true, "Count the last row: 195 stitches"], ["Waffle 3", 72, 86, true, null],
  ["Tree 3", 87, 105, true, "Count the last row: 195 stitches"], ["Waffle 4", 106, 120, true, "Count the last row: 195 stitches"], ["Tree 4", 121, 139, true, "Count the last row: 195 stitches"],
  ["Waffle 5", 140, 156, true, "Count the last row: 195 stitches"], ["Final row", 157, 157, false, "Count: 195 stitches"]];
const blanket = (owner, done = 58) => seedCraft(owner, "Fake Tree Blanket", [{ name: "Blanket", word: "Row", total: 157, done, stitch: 195, bands: BLANKET_BANDS }, { name: "Border", word: "Round", total: 2, done: 0, stitch: null }]);
const scarf = (owner, done = 96) => seedCraft(owner, "Fake Scarf", [{ name: "Body", word: "Row", total: 519, done, stitch: 30, quarters: true, ridges: true, type: "garter",
  bands: [["Scarf rows 1–100", 1, 100, false, null], ["Scarf rows 101–200", 101, 200, false, null], ["Scarf rows 201–519", 201, 519, false, null]] }], { craft: "knit" });
const current = (partId) => Number(psql(`SELECT COALESCE(min(craft_row), (SELECT total_rows FROM craft_parts WHERE id='${partId}') + 1) FROM task_checklist_items WHERE craft_part_id='${partId}' AND NOT is_done AND craft_row <= (SELECT total_rows FROM craft_parts WHERE id='${partId}');`));
const doneRows = (partId) => psql(`SELECT coalesce(string_agg(craft_row::text, ',' ORDER BY craft_row), '') FROM task_checklist_items WHERE craft_part_id='${partId}' AND is_done;`);
const rowStates = (partId) => JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('row', craft_row, 'done', is_done, 'linked', EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id), 'today', false) ORDER BY craft_row), '[]') FROM task_checklist_items i WHERE craft_part_id='${partId}';`));
const total = (partId) => Number(psql(`SELECT total_rows FROM craft_parts WHERE id='${partId}';`));
const up073 = readFileSync(new URL("../supabase/migrations/073_craft_rpcs.sql", import.meta.url), "utf8");
const down073 = readFileSync(new URL("../supabase/rollbacks/073_craft_rpcs.down.sql", import.meta.url), "utf8");
const frogRoute = await import("../src/app/api/craft/[projectId]/frog/route.ts");
const sessionRoute = await import("../src/app/api/work-sessions/[id]/route.ts");
const sessionsRoute = await import("../src/app/api/work-sessions/route.ts");
const A = await import("../src/lib/craft/actions.ts");
const NEW_FUNCTIONS = ["craft_sitting_rows(uuid,uuid,uuid)", "craft_frog(uuid,uuid,integer,integer,integer,text,uuid[],text)",
  "craft_save_sitting(uuid,uuid,boolean,integer,integer,date,timestamp with time zone,timestamp with time zone,integer,integer,integer,integer,text,text,boolean)"];
const REPLACED = ["work_session_create(uuid,jsonb,uuid[],boolean)", "work_session_update(uuid,uuid,jsonb,uuid[])", "craft_rows(uuid,uuid,integer,integer,text,uuid)",
  "craft_log_sitting(uuid,uuid,boolean,integer,integer,date,timestamp with time zone,timestamp with time zone,integer,integer,integer,integer,text,text)", "craft_remove_blockers(uuid,uuid)"];
/** Every craft_/work_session function's body and grants, work_session_items' columns, the craft tables and their policies: what 074's rollback must give back. */
const schemaState = () => psql(`SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'craft_%' OR p.proname LIKE 'work_session%');
SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'work_session_items';
SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'craft_%' OR tablename LIKE 'work_session%');
SELECT md5(coalesce(string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname), '')) FROM pg_policies WHERE schemaname = 'public' AND (tablename LIKE 'craft_%' OR tablename LIKE 'work_session%');
SELECT md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.relname), '')) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND (c.relname LIKE 'craft_%' OR c.relname LIKE 'work_session%');`);
/** A sitting's links: "Blanket:61,Blanket:62,Blanket:63~" (~ = in progress). */
const links = (sessionId) => psql(`SELECT coalesce(string_agg(p.name || ':' || i.craft_row || CASE WHEN w.in_progress THEN '~' ELSE '' END, ',' ORDER BY p.sort_order, i.craft_row), '') FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id JOIN craft_parts p ON p.id = i.craft_part_id WHERE w.session_id='${sessionId}';`);
const timerRow = (owner) => JSON.parse(psql(`SELECT coalesce(to_json(t)::text, 'null') FROM craft_timers t WHERE user_id='${owner}';`) || "null");
const clearTimer = (owner) => psql(`DELETE FROM craft_timers WHERE user_id='${owner}';`);
const getView = async (who, projectId) => (await detailRoute.GET(req(who, "GET", `/api/craft/${projectId}`), ctx(projectId))).json();
const mittensTwo = (owner, cuffDone) => seedCraft(owner, "Fake Mittens", [{ name: "Cuff", word: "Rnd", total: 31, done: cuffDone, stitch: 36, type: "rib" }, { name: "Hand", word: "Rnd", total: 45, done: 0, stitch: 36, type: "stockinette" }], { craft: "knit" });
const startTimerAgo = async (who, s, partId, minutes) => {
  const st = await post(timerRoute, who, s.projectId, "timer", { action: "start", part_id: partId });
  assert.equal(st.status, 200, JSON.stringify(st.body).slice(0, 300));
  psql(`UPDATE craft_timers SET running_since = now() - interval '${minutes} minutes', sitting_started_at = now() - interval '${minutes} minutes' WHERE user_id='${who.id}';`);
};
const rowDone = async (who, s, partId, from, to) => { for (let row = from; row <= to; row++) assert.equal((await post(rowRoute, who, s.projectId, "row", { part_id: partId, mode: "done", expected_row: row })).status, 200, `row ${row}`); };
/** A typed-minutes sitting (no timer): rows (from, to], partway or not. */
const typed = (who, s, partId, from, to, expected, minutes, inProgress, extra = {}) => post(sittingsRoute, who, s.projectId, "sittings",
  { part_id: partId, use_timer: false, minutes, from_row: from, to_row: to, expected_row: expected, in_progress: inProgress, idempotency_key: randomUUID(), ...extra });
const version = (owner) => timerRow(owner)?.version;
const minutesOf = (taskId) => psql(`SELECT coalesce(actual_minutes::text, 'null') FROM tasks WHERE id='${taskId}';`);
const excl = (sessionId) => psql(`SELECT exclude_from_stats || ':' || coalesce(exclude_reason, '') FROM work_sessions WHERE id='${sessionId}';`);
const strip = (pace) => JSON.parse(JSON.stringify(pace, (k, v) => (["id", "session_id", "created_at", "item_ids", "in_progress_item_ids"].includes(k) ? undefined : v)));
const patchSession = async (who, id, body) => {
  const r = new NextRequest(`http://localhost/api/work-sessions/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  const res = await sessionRoute.PATCH(r, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};
const listSessions = async (who, projectId) => {
  const r = new NextRequest(`http://localhost/api/work-sessions?project_id=${projectId}`, { method: "GET" });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  const res = await sessionsRoute.GET(r);
  return { status: res.status, body: await res.json() };
};

let a, b;
try {
  a = await user(); b = await user();
  process.env.MISSION_CONTROL_USER_ID = a.id;

  // ── The migration ──────────────────────────────────────────────────────────
  await test("074 applies on 001..073: in_progress (NOT NULL, default false), craft_frogs with owner RLS and only SELECT/INSERT/UPDATE/DELETE for the API roles, new functions SECURITY INVOKER for authenticated + service_role only, replaced ones keep their signatures and grants", () => {
    assert.equal(psql("SELECT data_type || ':' || is_nullable || ':' || column_default FROM information_schema.columns WHERE table_name='work_session_items' AND column_name='in_progress';"), "boolean:NO:false");
    assert.equal(psql("SELECT relrowsecurity FROM pg_class WHERE oid='public.craft_frogs'::regclass;"), "t");
    assert.equal(psql("SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE tablename='craft_frogs' AND qual IS DISTINCT FROM NULL OR (tablename='craft_frogs' AND cmd='INSERT');"), "DELETE,INSERT,SELECT,UPDATE");
    for (const role of ["authenticated", "service_role"]) {
      for (const right of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal(psql(`SELECT has_table_privilege('${role}', 'craft_frogs', '${right}');`), "t", `${role} ${right}`);
      for (const right of ["TRUNCATE", "REFERENCES", "TRIGGER"]) assert.equal(psql(`SELECT has_table_privilege('${role}', 'craft_frogs', '${right}');`), "f", `${role} ${right}`);
    }
    for (const right of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal(psql(`SELECT has_table_privilege('anon', 'craft_frogs', '${right}');`), "f", `anon ${right}`);
    assert.equal(psql("SELECT count(*) FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid='public.craft_frogs'::regclass AND x.grantee = 0;"), "0", "nothing for PUBLIC");
    assert.equal(psql("SELECT count(*) FROM pg_trigger WHERE tgrelid='public.craft_frogs'::regclass AND tgname='trg_craft_frogs_ownership';"), "1");
    for (const fn of [...NEW_FUNCTIONS, ...REPLACED]) {
      assert.equal(psql(`SELECT to_regprocedure('${fn}') IS NOT NULL;`), "t", fn);
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), "f", `${fn} SECURITY INVOKER`);
      for (const [role, can] of [["authenticated", "t"], ["service_role", "t"], ["anon", "f"]]) assert.equal(psql(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE');`), can, `${fn} ${role}`);
      assert.equal(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = '${fn}'::regprocedure AND x.grantee = 0);`), "f", `${fn}: PUBLIC`);
    }
    assert.equal(psql("SELECT count(*) FROM pg_proc WHERE proname IN ('craft_log_sitting', 'craft_rows', 'work_session_create', 'work_session_update') AND pronamespace = 'public'::regnamespace;"), "4", "no overloads");
  });

  // ── Rows in progress ───────────────────────────────────────────────────────
  await test("A blanket row over two evenings: the timer sitting ends partway through row 63 (in progress, not ticked); the next evening finishes it (linked normally there, ticked)", async () => {
    clearTimer(a.id);
    const s = blanket(a.id, 60), [part] = s.parts;
    await startTimerAgo(a, s, part, 48);
    await rowDone(a, s, part, 61, 62);
    psql(`UPDATE task_checklist_items SET completed_at = now() - interval '20 minutes' WHERE craft_part_id='${part}' AND craft_row IN (61, 62);`);
    const view = await getView(a, s.projectId);
    const d = A.logSittingDefaults(view.row_states, 157, view.timer);
    assert.equal(A.partwayDefault(view.row_states, 157, d, view.timer, view.server_now, view.timer_last_done_at), true, "20 min after the last Row done");
    const first = await post(sittingsRoute, a, s.projectId, "sittings", A.logSittingBody(view.active_part, view.timer, { ...d, quarter: 0, note: "", key: randomUUID(), minutesTouched: false, partway: true }, d.minutes));
    assert.equal(first.status, 201, JSON.stringify(first.body).slice(0, 300));
    assert.equal(links(first.body.result.session_id), "Blanket:61,Blanket:62,Blanket:63~");
    assert.deepEqual([first.body.result.saved_rows, first.body.result.in_progress_row], [[61, 62], 63]);
    assert.equal(doneRows(part).split(",").at(-1), "62", "row 63 is not ticked");
    assert.equal(psql(`SELECT in_progress_row FROM craft_sitting_details WHERE session_id='${first.body.result.session_id}';`), "63");
    const second = await typed(a, s, part, 62, 63, 63, 25, false);
    assert.equal(second.status, 201, JSON.stringify(second.body).slice(0, 300));
    assert.equal(links(second.body.result.session_id), "Blanket:63", "finished in the second sitting");
    assert.equal(links(first.body.result.session_id), "Blanket:61,Blanket:62,Blanket:63~", "still in progress in the first");
    assert.equal(current(part), 64);
    const pace = await getProjectPace(a.client, a.id, s.projectId, { now: new Date(), today: today() });
    assert.deepEqual(pace.sessions.map((r) => r.rows), ["row 63", "rows 61–62 · part of row 63"]);
  });

  await test("A row over three evenings (in progress in sittings 1–2, finished in 3): every sitting's minutes land with its type, the units once", async () => {
    clearTimer(a.id);
    const s = blanket(a.id, 62), [part] = s.parts;
    psql(`UPDATE projects SET target_date = '2026-12-23' WHERE id='${s.projectId}';`);
    const one = await typed(a, s, part, 62, 62, 63, 20, true);
    const two = await typed(a, s, part, 62, 62, 63, 30, true);
    const three = await typed(a, s, part, 62, 63, 63, 25, false);
    for (const r of [one, two, three]) assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual([links(one.body.result.session_id), links(two.body.result.session_id), links(three.body.result.session_id)], ["Blanket:63~", "Blanket:63~", "Blanket:63"]);
    const forecast = (await getProjectForecast(a.client, a.id, s.projectId, { now: new Date(), today: today() })).forecast;
    const tree = forecast.measured_speeds.find((m) => m.work_type === "waffle");
    assert.equal(tree.units, 195);
    assert.equal(Math.round(tree.minutes), 75, "20 + 30 + 25");
    assert.equal(tree.n_sessions, 3);
  });

  await test("A timed sitting across parts with a row in progress: Cuff rounds 29–31 finished, partway through Hand round 1; details name the Hand (F1), with its row in progress", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 28), [cuff, hand] = s.parts;
    await startTimerAgo(a, s, cuff, 40);
    await rowDone(a, s, cuff, 29, 31);
    const view = await getView(a, s.projectId);
    assert.deepEqual([view.active_part.id, view.timer.on_active_part], [hand, false]);
    const d = A.logSittingDefaults(view.row_states, 45, view.timer);
    assert.equal(A.sittingSummary("round", "Hand", A.sittingPlan(view.row_states, 45, d.from, d.to), view.timer_rows, d.minutes, 1), "Saves Cuff rounds 29–31 and part of Hand round 1, 40 min");
    const r = await post(sittingsRoute, a, s.projectId, "sittings", A.logSittingBody(view.active_part, view.timer, { ...d, quarter: 0, note: "", key: randomUUID(), minutesTouched: false, partway: true }, d.minutes));
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(links(r.body.result.session_id), "Cuff:29,Cuff:30,Cuff:31,Hand:1~");
    assert.deepEqual([r.body.result.saved_rows, r.body.result.in_progress_row, r.body.result.other_rows], [[], 1, [{ part_id: cuff, rows: [29, 30, 31] }]]);
    assert.equal(psql(`SELECT (part_id = '${hand}') || ':' || from_row || ':' || to_row || ':' || in_progress_row FROM craft_sitting_details WHERE session_id='${r.body.result.session_id}';`), "true:0:0:1");
    assert.equal(A.savedSittingText(r.body.result, "round", "Hand", r.body.view.parts), "Saved Cuff rounds 29–31 and part of Hand round 1, 40 min.");
  });

  await test("F1: Cuff 29–31 + Gusset 1–2 saved from the Thumb with nothing on the Thumb: the details say Gusset 0–2, not Thumb 0–0", async () => {
    clearTimer(a.id);
    const s = seedCraft(a.id, "Fake Mitten parts", [{ name: "Cuff", word: "Rnd", total: 31, done: 28, stitch: 36 }, { name: "Gusset", word: "Rnd", total: 2, done: 0, stitch: 36 }, { name: "Thumb", word: "Rnd", total: 15, done: 0, stitch: 12 }], { craft: "knit" });
    const [cuff, gusset, thumb] = s.parts;
    await startTimerAgo(a, s, cuff, 30);
    await rowDone(a, s, cuff, 29, 31);
    await rowDone(a, s, gusset, 1, 2);
    const view = await getView(a, s.projectId);
    assert.equal(view.active_part.id, thumb);
    const d = A.logSittingDefaults(view.row_states, 15, view.timer);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", A.logSittingBody(view.active_part, view.timer, { ...d, quarter: 0, note: "", key: randomUUID(), minutesTouched: false, partway: false }, d.minutes));
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(links(r.body.result.session_id), "Cuff:29,Cuff:30,Cuff:31,Gusset:1,Gusset:2");
    assert.equal(psql(`SELECT CASE part_id WHEN '${gusset}' THEN 'Gusset' WHEN '${thumb}' THEN 'Thumb' ELSE 'other' END || ' ' || from_row || '-' || to_row FROM craft_sitting_details WHERE session_id='${r.body.result.session_id}';`), "Gusset 0-2");
  });

  await test("A quarter is partway: the S2 body (craft_log_sitting, 14 arguments) with ½ of the next row links that row in progress", async () => {
    clearTimer(a.id);
    const s = scarf(a.id, 96), [part] = s.parts;
    const r = await rpc(a, "craft_log_sitting", { p_user_id: a.id, p_part_id: part, p_use_timer: false, p_timer_version: null, p_minutes: 20, p_date: null, p_started_at: null, p_ended_at: null,
      p_from_row: 96, p_to_row: 98, p_to_quarter: 2, p_expected_row: 97, p_note: null, p_idempotency_key: randomUUID() });
    assert.equal(r.error, null, r.error?.message);
    assert.equal(links(r.data.session_id), "Body:97,Body:98,Body:99~");
    assert.equal(r.data.in_progress_row, 99);
  });

  await test("Never both in one sitting; a row in progress must be unticked; partway with no next row or a ticked-ahead next row is refused in plain words", async () => {
    const s = blanket(a.id, 60), [part] = s.parts;
    const item = (n) => s.items[`Blanket:${n}`];
    let r = await rpc(a, "work_session_create", { p_user_id: a.id, p_session: { project_id: s.projectId, session_date: today(), minutes: 5, in_progress_item_ids: [item(61)] }, p_item_ids: [item(61)], p_mark_done: true });
    assert.equal(r.error?.code, "22023");
    r = await rpc(a, "work_session_create", { p_user_id: a.id, p_session: { project_id: s.projectId, session_date: today(), minutes: 5, in_progress_item_ids: [item(60)] }, p_item_ids: [], p_mark_done: true });
    assert.equal(r.error?.code, "22023", "row 60 is ticked");
    const last = blanket(a.id, 157);
    r = await typed(a, last, last.parts[0], 156, 157, 158, 10, true);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /There is no row after 157 to be partway through/);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row = 62;`);
    r = await typed(a, s, part, 60, 60, 61, 10, true);
    assert.equal(r.status, 201, "row 61 (the current row) is unticked");
    r = await typed(a, s, part, 61, 61, 61, 10, true, { idempotency_key: randomUUID() });
    assert.equal(r.status, 400, "after row 61 comes 62, ticked ahead");
    assert.match(r.body.error, /Row 62 is already ticked/);
  });

  await test("Paths that rewrite links keep in_progress right: PATCH rows (chat's update_work_session) keeps it, naming the row makes it finished; delete drops it; Undo / Fix count leave links alone", async () => {
    const s = blanket(a.id, 60), [part] = s.parts;
    const r = await typed(a, s, part, 60, 62, 61, 30, true);
    const id = r.body.result.session_id;
    assert.equal(links(id), "Blanket:61,Blanket:62,Blanket:63~");
    let p = await patchSession(a, id, { rows: "61" });
    assert.equal(p.status, 200, JSON.stringify(p.body).slice(0, 300));
    assert.equal(links(id), "Blanket:61,Blanket:63~", "rows replace the finished rows; the row in progress stays");
    assert.deepEqual([p.body.session.item_ids.length, p.body.session.in_progress_item_ids.length], [1, 1]);
    p = await patchSession(a, id, { rows: "61-63" });
    assert.equal(links(id), "Blanket:61,Blanket:62,Blanket:63", "a row in progress named in rows becomes finished in that sitting");
    p = await patchSession(a, id, { rows: "61-62" });
    assert.equal(links(id), "Blanket:61,Blanket:62");
    // A fresh partway sitting, then Undo and Fix count around it: links never change.
    const r2 = await typed(a, s, part, 62, 62, 63, 15, true);
    const id2 = r2.body.result.session_id;
    assert.equal(links(id2), "Blanket:63~");
    assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 63, to_row: 61 })).status, 200);
    assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "fix", expected_row: 61, to_row: 65 })).status, 200);
    assert.deepEqual([links(id), links(id2)], ["Blanket:61,Blanket:62", "Blanket:63~"], "Fix count and Undo leave speed alone");
    // Row 63 is ticked now (Fix count); a later sitting can't be partway through it, but it stays in progress in its sitting.
    assert.equal(current(part), 65);
    const del = await rpc(a, "work_session_delete", { p_user_id: a.id, p_session_id: id2 });
    assert.equal(del.error, null);
    assert.equal(psql(`SELECT count(*) FROM work_session_items WHERE session_id='${id2}';`), "0");
  });

  await test("A row ticked from chat or the task panel while in progress stays in progress in its sitting; the sitting that finishes it (chat's log_work_session) links it normally", async () => {
    const s = blanket(a.id, 62), [part] = s.parts;
    const first = await typed(a, s, part, 62, 62, 63, 20, true);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row = 63;`);
    assert.equal(links(first.body.result.session_id), "Blanket:63~");
    const chat = await logWorkSession(a.client, a.id, { task_id: s.tasks["Tree 2"], minutes: 15, rows: "63", idempotency_key: randomUUID() }, { now: new Date() });
    assert.equal(links(chat.session.id), "Blanket:63");
    assert.equal(links(first.body.result.session_id), "Blanket:63~");
    const list = await listSessions(a, s.projectId);
    assert.equal(list.status, 200);
    const firstOut = list.body.sessions.find((x) => x.id === first.body.result.session_id), chatOut = list.body.sessions.find((x) => x.id === chat.session.id);
    assert.deepEqual([firstOut.item_ids, firstOut.in_progress_item_ids], [[], [s.items["Blanket:63"]]], "list_work_sessions never reports a row in progress as finished");
    assert.deepEqual([chatOut.item_ids, chatOut.in_progress_item_ids], [[s.items["Blanket:63"]], []]);
  });

  await test("Change total refuses to remove a row in progress in a sitting (in_sitting); the move guard keeps a task with only an in-progress link in its project (55006)", async () => {
    const s = scarf(a.id, 96), [part] = s.parts;
    psql(`UPDATE task_checklist_items SET craft_part_id = NULL, craft_row = NULL WHERE craft_part_id='${part}' AND craft_row BETWEEN 101 AND 519; UPDATE craft_parts SET total_rows = 100 WHERE id='${part}';`);
    const r = await typed(a, s, part, 96, 98, 97, 10, true);
    assert.equal(links(r.body.result.session_id), "Body:97,Body:98,Body:99~");
    const t = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 98, expected_total: 100 });
    assert.deepEqual([t.status, t.body.reason, t.body.result.rows], [409, "in_sitting", [99]]);
    // A task whose only link is in progress (a project sitting, no craft rows on it) can't move away.
    const proj = randomUUID(), other = randomUUID(), task = randomUUID(), item = randomUUID();
    psql(`INSERT INTO projects (id, user_id, name) VALUES ('${proj}','${a.id}','Fake A'), ('${other}','${a.id}','Fake B');
      INSERT INTO tasks (id, user_id, project_id, title, status) VALUES ('${task}','${a.id}','${proj}','Fake task','Planned');
      INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${item}','${a.id}','${task}','Row 1',false,0);`);
    const c = await rpc(a, "work_session_create", { p_user_id: a.id, p_session: { project_id: proj, session_date: today(), minutes: 5, in_progress_item_ids: [item] }, p_item_ids: [], p_mark_done: true });
    assert.equal(c.error, null, c.error?.message);
    assert.throws(() => psql(`UPDATE tasks SET project_id='${other}' WHERE id='${task}';`), /55006|logged work sessions/);
  });

  await test("Remove from craft screen keeps in-progress links (only the craft columns go); frogs block Remove (MC72R \"frogs\")", async () => {
    const s = mittensTwo(a.id, 0), [cuff] = s.parts;
    const c = await rpc(a, "work_session_create", { p_user_id: a.id, p_session: { project_id: s.projectId, session_date: today(), minutes: 7, in_progress_item_ids: [s.items["Cuff:1"]] }, p_item_ids: [], p_mark_done: true });
    assert.equal(c.error, null, c.error?.message);
    const removed = await detailRoute.DELETE(req(a, "DELETE", `/api/craft/${s.projectId}`), ctx(s.projectId));
    assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()).slice(0, 200));
    assert.equal(psql(`SELECT in_progress FROM work_session_items WHERE session_id='${c.data.session_id}';`), "t");
    const m = mittensTwo(a.id, 3);
    psql(`INSERT INTO craft_frogs (user_id, part_id, from_row, to_row) VALUES ('${a.id}','${m.parts[0]}',3,3);`);
    assert.deepEqual((await rpc(a, "craft_remove_blockers", { p_user_id: a.id, p_project_id: m.projectId })).data, ["frogs"]);
    const refused = await detailRoute.DELETE(req(a, "DELETE", `/api/craft/${m.projectId}`), ctx(m.projectId));
    assert.equal(refused.status, 409);
    void cuff;
  });

  await test("Parity: a craft-screen sitting with a row in progress = the same sitting through the API (POST /api/work-sessions, then the 059 update's in_progress_item_ids): identical getProjectPace() and getProjectForecast()", async () => {
    const s = blanket(a.id, 60), [part] = s.parts;
    psql(`UPDATE projects SET target_date = '2026-12-23' WHERE id='${s.projectId}';`);
    const start = new Date(Date.now() - 90 * 60_000), end = new Date(Date.now() - 30 * 60_000);
    const startEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(start);
    const opts = { now: new Date(), today: today() };
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: false, minutes: 55, started_at: start.toISOString(), ended_at: end.toISOString(), from_row: 60, to_row: 62, expected_row: 61, in_progress: true, note: "same sitting", idempotency_key: randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.equal(links(r.body.result.session_id), "Blanket:61,Blanket:62,Blanket:63~");
    const craftPace = strip(await getProjectPace(a.client, a.id, s.projectId, opts));
    const craftForecast = strip(await getProjectForecast(a.client, a.id, s.projectId, opts));
    psql(`DELETE FROM work_sessions WHERE id='${r.body.result.session_id}'; UPDATE task_checklist_items SET is_done=false WHERE craft_part_id='${part}' AND craft_row BETWEEN 61 AND 62;`);
    const page = await logWorkSession(a.client, a.id, { task_id: s.tasks["Tree 2"], date: startEt, start: start.toISOString(), end: end.toISOString(), minutes: 55, rows: "61-62", note: "same sitting", idempotency_key: randomUUID() }, opts);
    const u = await rpc(a, "work_session_update", { p_user_id: a.id, p_session_id: page.session.id, p_changes: { in_progress_item_ids: [s.items["Blanket:63"]] }, p_item_ids: null });
    assert.equal(u.error, null, u.error?.message);
    const pagePace = strip(await getProjectPace(a.client, a.id, s.projectId, opts));
    const pageForecast = strip(await getProjectForecast(a.client, a.id, s.projectId, opts));
    assert.deepEqual(craftForecast, pageForecast);
    assert.deepEqual(craftPace, pagePace);
    assert.equal(craftPace.sessions[0].rows, "rows 61–62 · part of row 63");
  });

  // ── Ripped back ────────────────────────────────────────────────────────────
  await test("Ripped back, all ripped: rows 61–62 unticked, every link to them and to row 63 removed, the sitting left out with \"ripped back rows 61–62\"; its minutes stay (daily time, actual_minutes); the frog is recorded", async () => {
    clearTimer(a.id);
    const s = blanket(a.id, 60), [part] = s.parts;
    const sit = await typed(a, s, part, 60, 62, 61, 40, true);
    const id = sit.body.result.session_id;
    const before = minutesOf(s.tasks["Tree 2"]);
    const view = await getView(a, s.projectId);
    const plan = A.frogPlan(view.row_states, 157, part, view.rip_sittings, 61);
    assert.deepEqual([plan.ripped, plan.partway, plan.all.map((x) => x.id), plan.partly.length], [[61, 62], 63, [id], 0]);
    const key = randomUUID();
    const r = await post(frogRoute, a, s.projectId, "frog", A.frogBody(view.active_part, plan, { note: "dropped a stitch", key, exclude: [] }));
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual([r.body.result.unticked, r.body.result.current_row, r.body.result.excluded, r.body.result.reason], [[61, 62], 61, [id], "ripped back rows 61–62"]);
    assert.equal(links(id), "");
    assert.equal(excl(id), "true:ripped back rows 61–62");
    assert.equal(minutesOf(s.tasks["Tree 2"]), before, "actual_minutes unchanged");
    assert.equal(psql(`SELECT minutes FROM work_sessions WHERE id='${id}';`), "40");
    assert.equal(current(part), 61);
    assert.equal(psql(`SELECT from_row || '-' || to_row || ':' || note || ':' || (session_ids = ARRAY['${id}']::uuid[]) FROM craft_frogs WHERE id='${r.body.result.frog_id}';`), "61-62:dropped a stitch:true");
    assert.deepEqual(r.body.view.frogs.map((f) => [f.from_row, f.to_row, f.sittings_left_out]), [[61, 62, 1]]);
    assert.equal(r.body.view.today.minutes >= 40, true, "still in daily time");
    // Idempotent: the same key again changes nothing and says duplicate.
    const again = await post(frogRoute, a, s.projectId, "frog", A.frogBody(view.active_part, plan, { note: "dropped a stitch", key, exclude: [] }));
    assert.deepEqual([again.status, again.body.result.status, again.body.result.frog_id], [200, "duplicate", r.body.result.frog_id]);
    assert.equal(psql(`SELECT count(*) FROM craft_frogs WHERE part_id='${part}';`), "1");
    assert.equal(current(part), 61);
    // The pace engine no longer counts it: no counted sitting for its type.
    const forecast = (await getProjectForecast(a.client, a.id, s.projectId, { now: new Date(), today: today() })).forecast;
    assert.equal(forecast.counted_sessions, 0);
  });

  await test("Ripped back, partly ripped: a sitting that keeps other rows is listed and left in speed unless ticked; the ticked one is left out and recorded; the other keeps its rows", async () => {
    const s = blanket(a.id, 55), [part] = s.parts;
    const keep = await typed(a, s, part, 55, 58, 56, 30, false);   // rows 56–58
    const pick = await typed(a, s, part, 58, 60, 59, 20, false);   // rows 59–60
    const view = await getView(a, s.projectId);
    const plan = A.frogPlan(view.row_states, 157, part, view.rip_sittings, 58);
    assert.deepEqual([plan.ripped, plan.all.length, plan.partly.map((x) => x.id).sort()], [[58, 59, 60], 1, [keep.body.result.session_id]]);
    assert.equal(plan.all[0].id, pick.body.result.session_id);
    // Brent's rule (11/12): partly ripped sittings stay counted unless he ticks them.
    let r = await post(frogRoute, a, s.projectId, "frog", A.frogBody(view.active_part, plan, { note: "", key: randomUUID(), exclude: [] }));
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual([excl(keep.body.result.session_id), links(keep.body.result.session_id)], ["false:", "Blanket:56,Blanket:57"]);
    assert.equal(excl(pick.body.result.session_id), "true:ripped back rows 58–60");
    // Now rip 57 and tick the partly ripped sitting.
    const v2 = await getView(a, s.projectId);
    const p2 = A.frogPlan(v2.row_states, 157, part, v2.rip_sittings, 57);
    assert.deepEqual([p2.partly.map((x) => x.id), p2.already.map((x) => x.id)], [[keep.body.result.session_id], []]);
    r = await post(frogRoute, a, s.projectId, "frog", A.frogBody(v2.active_part, p2, { note: "", key: randomUUID(), exclude: [keep.body.result.session_id] }));
    assert.equal(r.status, 201);
    assert.deepEqual([excl(keep.body.result.session_id), links(keep.body.result.session_id)], ["true:ripped back row 57", "Blanket:56"]);
    assert.deepEqual(r.body.result.excluded, [keep.body.result.session_id]);
    // A sitting the rip doesn't touch can't be picked.
    const other = await typed(a, s, part, 56, 56, 57, 5, false); // the time only (no rows)
    assert.equal(other.status, 201);
    const bad = await rpc(a, "craft_frog", { p_user_id: a.id, p_part_id: part, p_expected_row: 57, p_from_row: 56, p_to_row: 56, p_note: null, p_exclude_session_ids: [other.body.result.session_id], p_idempotency_key: randomUUID() });
    assert.equal(bad.error?.code, "22023");
  });

  await test("Ripped back guards: stale count (409, nothing changed), not the screen's part (409 other_part), rows must end at the row before the current row (400), another user (404 / 42501 / P0002), anon (no EXECUTE)", async () => {
    const s = blanket(a.id, 60), [part, border] = s.parts;
    const body = { part_id: part, expected_row: 60, from_row: 59, to_row: 60, idempotency_key: randomUUID() };
    let r = await post(frogRoute, a, s.projectId, "frog", body);
    assert.deepEqual([r.status, r.body.reason], [409, "stale"]);
    assert.equal(current(part), 61);
    r = await post(frogRoute, a, s.projectId, "frog", { ...body, expected_row: 61, to_row: 59 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /end at the row before the current row \(60\)/);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${border}' AND craft_row = 1; UPDATE craft_projects SET active_part_id='${border}' WHERE project_id='${s.projectId}';`);
    r = await post(frogRoute, a, s.projectId, "frog", { ...body, expected_row: 61 });
    assert.deepEqual([r.status, r.body.reason], [409, "other_part"]);
    psql(`UPDATE craft_projects SET active_part_id='${part}' WHERE project_id='${s.projectId}';`);
    r = await post(frogRoute, b, s.projectId, "frog", { ...body, expected_row: 61 });
    assert.equal(r.status, 404);
    const as = await rpc(b, "craft_frog", { p_user_id: a.id, p_part_id: part, p_expected_row: 61, p_from_row: 59, p_to_row: 60, p_note: null, p_exclude_session_ids: [], p_idempotency_key: randomUUID() });
    assert.equal(as.error?.code, "42501");
    const own = await rpc(b, "craft_frog", { p_user_id: b.id, p_part_id: part, p_expected_row: 61, p_from_row: 59, p_to_row: 60, p_note: null, p_exclude_session_ids: [], p_idempotency_key: randomUUID() });
    assert.equal(own.error?.code, "P0002");
    const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const no = await anonClient.rpc("craft_frog", { p_user_id: a.id, p_part_id: part, p_expected_row: 61, p_from_row: 59, p_to_row: 60, p_note: null, p_exclude_session_ids: [], p_idempotency_key: randomUUID() });
    assert.ok(no.error && /permission denied/i.test(no.error.message), no.error?.message);
    assert.equal(current(part), 61, "nothing was ripped");
    assert.equal(psql(`SELECT count(*) FROM craft_frogs WHERE part_id='${part}';`), "0");
  });

  await test("Ripped back below the timer's start row lowers it (version bumped), like Undo; rows done again belong to the timed sitting", async () => {
    clearTimer(a.id);
    const s = blanket(a.id, 60), [part] = s.parts;
    await startTimerAgo(a, s, part, 30);
    await rowDone(a, s, part, 61, 62);
    psql(`UPDATE craft_timers SET start_row = 61 WHERE user_id='${a.id}';`);
    const v0 = version(a.id);
    const r = await post(frogRoute, a, s.projectId, "frog", { part_id: part, expected_row: 63, from_row: 59, to_row: 62, idempotency_key: randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual([timerRow(a.id).start_row, version(a.id)], [59, v0 + 1]);
    clearTimer(a.id);
  });

  await test("Ripped back lock order: a chat edit of the sitting held open (session, then tasks) makes the rip-back wait; a held Row done does too; both finish with no 40P01", async () => {
    const s = blanket(a.id, 60), [part] = s.parts;
    const sit = await typed(a, s, part, 60, 62, 61, 30, false);
    assert.equal(sit.status, 201);
    const id = sit.body.result.session_id;
    const label = `craft-s3-frog-${randomUUID()}`;
    const one = connection("chat"), two = connection("frog");
    try {
      one.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SELECT (work_session_update('${a.id}','${id}','{"note":"chat edit"}'::jsonb, NULL))->>'session_id'; SELECT 'held';`);
      await one.wait("held");
      two.send(`SET application_name='${label}'; SET deadlock_timeout='100ms'; SELECT 'fr:' || ((craft_frog('${a.id}','${part}',63,61,62,NULL,'{}','${randomUUID()}'))->>'status');`);
      assert.ok(await waitingOnLock(label), `the rip-back waits for the sitting: ${one.output()} | ${two.output()}`);
      one.send("COMMIT; SELECT 'committed';");
      await one.wait("committed");
      await two.wait("fr:");
      assert.match(two.output(), /fr:ok/);
      assert.doesNotMatch(one.output() + two.output(), /deadlock/);
    } finally { await Promise.all([one.end(), two.end()]); }
    assert.equal(excl(id), "true:ripped back rows 61–62");
    const three = connection("rowdone"), four = connection("frog2");
    const label2 = `craft-s3-frog2-${randomUUID()}`;
    try {
      three.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SELECT (craft_rows('${a.id}','${part}',61,NULL,'done'))->>'status'; SELECT 'held';`);
      await three.wait("held");
      four.send(`SET application_name='${label2}'; SET deadlock_timeout='100ms'; SELECT 'fr:' || ((craft_frog('${a.id}','${part}',62,61,61,NULL,'{}','${randomUUID()}'))->>'status');`);
      assert.ok(await waitingOnLock(label2), `the rip-back waits for Row done: ${three.output()} | ${four.output()}`);
      three.send("COMMIT; SELECT 'committed';");
      await three.wait("committed");
      await four.wait("fr:");
      assert.match(four.output(), /fr:ok/);
      assert.doesNotMatch(three.output() + four.output(), /deadlock/);
    } finally { await Promise.all([three.end(), four.end()]); }
    assert.equal(current(part), 61);
  });

  // ── Follow-ups in SQL ─────────────────────────────────────────────────────
  await test("F2: the Row done toast's body called directly while rows 60–63 are ticked refuses stale and unticks nothing (S2's plain undo unticked 59–63)", async () => {
    const s = blanket(a.id, 58), [part] = s.parts;
    const before = Array.from({ length: 157 }, (_, i) => ({ row: i + 1, done: i < 58, linked: false, today: false }));
    const toast = A.toastUndo(before, 157, 59, 60);
    await rowDone(a, s, part, 59, 63);
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, ...toast.body, expected_row: 64 });
    assert.deepEqual([r.status, r.body.reason], [409, "stale"]);
    assert.equal(current(part), 64, "59–63 stay ticked");
    const ok = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo_one", to_row: 63, expected_row: 64 });
    assert.deepEqual([ok.status, ok.body.result.unticked], [200, [63]]);
  });

  await test("F3: another sitting takes some of the rows while the Log sitting sheet is open: the reply names the rows actually saved", async () => {
    const s = blanket(a.id, 58), [part] = s.parts;
    await rowDone(a, s, part, 59, 62);
    const view = await getView(a, s.projectId);
    const preview = A.sittingSummary("row", "Blanket", A.sittingPlan(view.row_states, 157, 58, 62), [], 30);
    assert.equal(preview, "Saves rows 59–62, 30 min");
    await logWorkSession(a.client, a.id, { task_id: s.tasks["Tree 2"], minutes: 10, rows: "59-60", idempotency_key: randomUUID() }, { now: new Date() });
    const r = await typed(a, s, part, 58, 62, 63, 30, false);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.result.saved_rows, [61, 62]);
    assert.equal(A.savedSittingText(r.body.result, "row", "Blanket", r.body.view.parts), "Saved rows 61–62, 30 min.");
  });

  await test("F5 (SQL): Change total re-checks the rows under its lock: a row past the new total ticked after the sheet opened refuses the save (409 ticked), nothing removed", async () => {
    const s = scarf(a.id, 96), [part] = s.parts;
    const view = await getView(a, s.projectId);
    assert.equal(A.setTotalPlan(view.row_states, 519, 455).kind, "remove");
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row = 500;`);
    const r = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 455, expected_total: 519 });
    assert.deepEqual([r.status, r.body.reason], [409, "ticked"]);
    assert.equal(total(part), 519);
  });

  // ── 074's rollback ──────────────────────────────────────────────────────
  await test("074 down returns the schema to 073 exactly (functions, bodies, grants, no in_progress, no craft_frogs) on a fresh 073 capture; sittings stay, in-progress links go; 074 re-applies", () => {
    const sessions = () => psql("SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id), '')) FROM work_sessions s;");
    const kept = sessions();
    const finished = psql("SELECT count(*) FROM work_session_items WHERE NOT in_progress;");
    assert.notEqual(psql("SELECT count(*) FROM work_session_items WHERE in_progress;"), "0", "there are in-progress links to drop");
    psql(down074);
    psql(down073);
    psql(up073);
    const fresh073 = schemaState();
    psql(up074);
    assert.notEqual(schemaState(), fresh073);
    psql(down074);
    assert.equal(schemaState(), fresh073);
    assert.equal(psql("SELECT to_regclass('public.craft_frogs') IS NULL;"), "t");
    assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_name='work_session_items' AND column_name='in_progress';"), "0");
    for (const fn of NEW_FUNCTIONS) assert.equal(psql(`SELECT to_regprocedure('${fn}') IS NULL;`), "t", fn);
    assert.equal(sessions(), kept, "sittings (and the exclusions a rip-back made) stay");
    assert.equal(psql("SELECT count(*) FROM work_session_items;"), finished, "only the in-progress links went");
    psql(up074);
    for (const fn of [...NEW_FUNCTIONS, ...REPLACED]) assert.equal(psql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), "t", fn);
  });
} finally {
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft S3 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
