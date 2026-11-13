#!/usr/bin/env node
// Craft S2 on a disposable LOCAL stack (CRAFT_TEST_*): migration 073's functions through the real routes and as SQL,
// the expected-row guard, other users and anon, the timer, Log sitting = a project-page sitting, Change total, the
// 059 lock order, the S1C carry-overs a–d and 073's rollback. Destructive only to this local stack. Fake data only.
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
const up072 = readFileSync(new URL("../supabase/migrations/072_craft_setup.sql", import.meta.url), "utf8");
const down072 = readFileSync(new URL("../supabase/rollbacks/072_craft_setup.down.sql", import.meta.url), "utf8");
const up073 = readFileSync(new URL("../supabase/migrations/073_craft_rpcs.sql", import.meta.url), "utf8");
const down073 = readFileSync(new URL("../supabase/rollbacks/073_craft_rpcs.down.sql", import.meta.url), "utf8");
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
const only = process.env.CRAFT_S2_ONLY ? new RegExp(process.env.CRAFT_S2_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-s2-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-s2-test-${randomUUID()}`;
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
const FUNCTIONS_073 = ["craft_timer_elapsed(integer,integer,timestamp with time zone,timestamp with time zone)", "craft_current_row(uuid,uuid,integer)", "craft_part_lock(uuid,uuid)", "craft_band_check(uuid,uuid)",
  "craft_rows(uuid,uuid,integer,integer,text,uuid)", "craft_timer_state(uuid,timestamp with time zone)", "craft_timer(uuid,text,uuid,uuid,integer,integer,boolean)",
  "craft_log_sitting(uuid,uuid,boolean,integer,integer,date,timestamp with time zone,timestamp with time zone,integer,integer,integer,integer,text,text)", "craft_set_total(uuid,uuid,integer,integer)"];
// S3 FR3: 074 replaces 073's 4-argument craft_set_total with a 6-argument one (text and work type for added rows), so
// on a stack with 074 on top that is the one to check; 073's own list still holds while 074 is rolled back.
const FUNCTIONS_073_UNDER_074 = FUNCTIONS_073.map((fn) => (fn === "craft_set_total(uuid,uuid,integer,integer)" ? "craft_set_total(uuid,uuid,integer,integer,text,text)" : fn));
/** Every craft function's definition and grants, and craft_timers' columns: the schema 073's rollback must give back. */
const schemaState = () => psql(`SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'craft_%';
SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'craft_timers';`);

let a, b;
try {
  a = await user(); b = await user();
  process.env.MISSION_CONTROL_USER_ID = a.id;

  // ── The migration ──────────────────────────────────────────────────────────
  await test("073 applies on 001..072: nine functions, SECURITY INVOKER, EXECUTE for authenticated and service_role only; craft_timers.paused_at added", () => {
    for (const fn of FUNCTIONS_073_UNDER_074) {
      assert.equal(psql(`SELECT to_regprocedure('${fn}') IS NOT NULL;`), "t", fn);
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), "f", `${fn} must be SECURITY INVOKER`);
      for (const [role, can] of [["authenticated", "t"], ["service_role", "t"], ["anon", "f"]]) assert.equal(psql(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE');`), can, `${fn} ${role}`);
      assert.equal(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = '${fn}'::regprocedure AND x.grantee = 0);`), "f", `${fn}: PUBLIC`);
    }
    assert.equal(psql("SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_name='craft_timers' AND column_name='paused_at';"), "timestamp with time zone:YES");
    for (const fn of ["craft_setup_project(uuid,uuid,jsonb,text)", "craft_setup_plan(uuid,uuid)", "craft_remove_blockers(uuid,uuid)"]) {
      assert.equal(psql(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE');`), "f", `${fn} anon after replace`);
    }
  });

  // ── Row done / Undo / Fix count ────────────────────────────────────────────
  await test("Row done through the route: row 59 ticked (completed now), current 60, the part becomes the active part; the view comes back with it", async () => {
    const s = blanket(a.id);
    const [part] = s.parts;
    psql(`UPDATE craft_projects SET active_part_id = '${s.parts[1]}' WHERE project_id='${s.projectId}';`);
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 59 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.result.status, r.body.result.previous_row, r.body.result.current_row, r.body.result.ticked], ["ok", 59, 60, [59]]);
    assert.equal(r.body.view.active_part.current_row, 60);
    assert.equal(psql(`SELECT completed_at > now() - interval '1 minute' FROM task_checklist_items WHERE id='${s.items["Blanket:59"]}';`), "t");
    assert.equal(psql(`SELECT active_part_id FROM craft_projects WHERE project_id='${s.projectId}';`), part);
  });

  await test("Expected-row guard: a double tap (same expected row twice) counts once; the second is a 409 stale with the current row", async () => {
    const s = blanket(a.id), [part] = s.parts;
    const first = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 59 });
    const second = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 59 });
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.deepEqual([second.body.reason, second.body.result.current_row, second.body.view.active_part.current_row], ["stale", 60, 60]);
    assert.equal(current(part), 60);
  });

  await test("Two screens at once: 8 concurrent Row dones with the same expected row tick exactly one row", async () => {
    const s = blanket(a.id), [part] = s.parts;
    const replies = await Promise.all(Array.from({ length: 8 }, () => rpc(a, "craft_rows", { p_user_id: a.id, p_part_id: part, p_expected_row: 59, p_to_row: null, p_mode: "done" })));
    for (const r of replies) assert.ifError(r.error);
    assert.deepEqual(replies.map((r) => r.data.status).sort(), ["ok", ...Array(7).fill("stale")]);
    assert.equal(current(part), 60);
  });

  await test("Undo back to row 57 unticks 57–58 only; undo forward is refused (400); fix to 65 ticks 59–64 and the TS preview said the same", async () => {
    const s = blanket(a.id), [part] = s.parts;
    let r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 59, to_row: 57 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.result.unticked, r.body.result.current_row], [[57, 58], 57]);
    r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 57, to_row: 60 });
    assert.equal(r.status, 400);
    const plan = fixCountPlan(rowStates(part), 157, 65);
    r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "fix", expected_row: 57, to_row: 65 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result.ticked, plan.tick);
    assert.equal(r.body.result.current_row, plan.next);
    assert.deepEqual(r.body.result.ticked, [57, 58, 59, 60, 61, 62, 63, 64]);
    r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "fix", expected_row: 65, to_row: 61 });
    assert.deepEqual([r.body.result.unticked, r.body.result.current_row], [[61, 62, 63, 64], 61]);
  });

  await test("Fix count only touches rows between the old and new row: a row ticked ahead (by chat) stays ticked", async () => {
    const s = blanket(a.id), [part] = s.parts;
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id='${s.items["Blanket:70"]}';`);
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "fix", expected_row: 59, to_row: 62 });
    assert.deepEqual(r.body.result.ticked, [59, 60, 61]);
    assert.match(doneRows(part), /,70$/);
    const back = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 62, to_row: 60 });
    assert.deepEqual(back.body.result.unticked, [60, 61]);
    assert.match(doneRows(part), /,70$/);
  });

  await test("Gaps (mittens' deleted (est.) rounds 22–28): Row done on round 21 moves to 29; the view says 21 of 24", async () => {
    const s = seedCraft(a.id, "Fake Mittens", [{ name: "Mitten 1 · Cuff", word: "Rnd", total: 31, done: 20, stitch: 36, gaps: [22, 23, 24, 25, 26, 27, 28] }], { craft: "knit" });
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: s.parts[0], mode: "done", expected_row: 21 });
    assert.deepEqual([r.body.result.current_row, r.body.view.active_part.current_row, r.body.view.active_part.done_rows, r.body.view.active_part.row_count], [29, 29, 21, 24]);
    const undo = await post(rowRoute, a, s.projectId, "row", { part_id: s.parts[0], mode: "undo", expected_row: 29, to_row: 21 });
    assert.deepEqual([undo.body.result.unticked, undo.body.result.current_row], [[21], 21]);
  });

  await test("A stored quarter is cleared once its row is done; the quarter stays while its row is still current", async () => {
    const s = scarf(a.id), [part] = s.parts;
    psql(`UPDATE craft_parts SET quarter = 2, quarter_row = 97 WHERE id='${part}';`);
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 97 });
    assert.equal(r.body.view.active_part.quarter, 0);
    assert.equal(psql(`SELECT quarter || ':' || coalesce(quarter_row::text, 'null') FROM craft_parts WHERE id='${part}';`), "0:null");
  });

  // ── Band close ────────────────────────────────────────────────────────────
  await test("Band close: Row done on Tree 2's last row returns needs_check \"195\" from the count item; Cancel leaves the row ticked and the band open (shown as a pending check)", async () => {
    const s = blanket(a.id, 70), [part] = s.parts;
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 71 });
    const check = r.body.result.needs_check;
    assert.equal(check.name, "Tree 2");
    assert.deepEqual([check.count, check.count_source, check.item_id, check.item_text, check.task_status], [195, "item", s.items["Tree 2:count"], "Count the last row: 195 stitches", "Planned"]);
    assert.equal(current(part), 72, "the row is ticked before the question");
    assert.equal(psql(`SELECT status FROM tasks WHERE id='${s.tasks["Tree 2"]}';`), "Planned");
    assert.deepEqual(r.body.view.pending_checks.map((p) => [p.name, p.count, p.item_id, p.count_source]), [["Tree 2", 195, s.items["Tree 2:count"], "item"]]);
  });

  await test("Band close Confirm: ticks the count item and sets the band task Done (status transition recorded); a second Confirm changes nothing", async () => {
    const s = blanket(a.id, 70), [part] = s.parts;
    assert.ok((await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 71 })).body.result.needs_check);
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "close", segment_id: s.tasks["Tree 2:segment"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.result.closed.from_status, r.body.result.closed.count], ["Planned", 195]);
    assert.equal(psql(`SELECT status FROM tasks WHERE id='${s.tasks["Tree 2"]}';`), "Done");
    assert.equal(psql(`SELECT is_done FROM task_checklist_items WHERE id='${s.items["Tree 2:count"]}';`), "t");
    assert.deepEqual(r.body.view.pending_checks, []);
    await sleep(300);
    assert.equal(psql(`SELECT count(*) FROM task_status_transitions WHERE task_id='${s.tasks["Tree 2"]}' AND to_status='Done';`), "1");
    const again = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "close", segment_id: s.tasks["Tree 2:segment"] });
    assert.equal(again.body.result.closed.from_status, "Done");
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items WHERE task_id='${s.tasks["Tree 2"]}' AND is_done;`), "20");
  });

  await test("Band close: a band without a count item asks for the part's stitch count (source part); an unticked row refuses the close (409); a closed band never asks again", async () => {
    const s = blanket(a.id, 85), [part] = s.parts;
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 86 });
    assert.deepEqual([r.body.result.needs_check.name, r.body.result.needs_check.count, r.body.result.needs_check.count_source, r.body.result.needs_check.item_id], ["Waffle 3", 195, "part", null]);
    await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 87, to_row: 86 });
    const refused = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "close", segment_id: s.tasks["Waffle 3:segment"] });
    assert.deepEqual([refused.status, refused.body.reason], [409, "open_rows"]);
    assert.equal(psql(`SELECT status FROM tasks WHERE id='${s.tasks["Waffle 3"]}';`), "Planned");
    psql(`UPDATE tasks SET status='Done' WHERE id='${s.tasks["Waffle 3"]}';`);
    const again = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 86 });
    assert.equal(again.body.result.needs_check, null);
  });

  await test("The Final row's count item \"Count: 195 stitches\" is read the same way; a plain row band (Foundation) never asks", async () => {
    const s = blanket(a.id, 156), [part] = s.parts;
    const r = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 157 });
    assert.equal(r.body.result.needs_check, null, "Final row has close_check false, as on the live blanket");
    assert.equal(psql(`SELECT craft_band_check('${a.id}', '${s.tasks["Final row:segment"]}')->>'count';`), "195");
    const f = blanket(a.id, 0);
    const first = await post(rowRoute, a, f.projectId, "row", { part_id: f.parts[0], mode: "done", expected_row: 1 });
    assert.equal(first.body.result.needs_check, null);
  });

  // ── Other users, anon, routes ─────────────────────────────────────────────
  await test("Another user: every S2 route on A's project is 404 and nothing changes; the functions refuse B acting as A (42501) and B's own id on A's part (P0002)", async () => {
    const s = blanket(a.id), [part] = s.parts;
    for (const [route, path, body, method] of [[rowRoute, "row", { part_id: part, mode: "done", expected_row: 59 }], [timerRoute, "timer", { action: "start", part_id: part }],
      [sittingsRoute, "sittings", { part_id: part, use_timer: false, minutes: 10, from_row: 58, to_row: 58, expected_row: 59, idempotency_key: randomUUID() }],
      [totalRoute, "total", { part_id: part, total: 160, expected_total: 157 }], [notesRoute, "notes", { part_id: part, row: 59, text: "x" }]]) {
      const r = await post(route, b, s.projectId, path, body, method);
      assert.equal(r.status, 404, `${path}: ${JSON.stringify(r.body)}`);
    }
    // Timer with no part: the craft project itself is the 404.
    assert.equal((await post(timerRoute, b, s.projectId, "timer", { action: "start" })).status, 404);
    for (const [name, args] of [["craft_rows", { p_part_id: part, p_expected_row: 59, p_to_row: null, p_mode: "done" }], ["craft_set_total", { p_part_id: part, p_total: 160, p_expected_total: 157 }],
      ["craft_timer", { p_action: "start", p_project_id: s.projectId }]]) {
      const asA = await rpc(b, name, { p_user_id: a.id, ...args });
      assert.equal(asA.error?.code, "42501", `${name} as A`);
      const own = await rpc(b, name, { p_user_id: b.id, ...args });
      assert.equal(own.error?.code, "P0002", `${name} own id`);
    }
    const sit = await rpc(b, "craft_log_sitting", { p_user_id: b.id, p_part_id: part, p_use_timer: false, p_timer_version: null, p_minutes: 10, p_date: null, p_started_at: null, p_ended_at: null, p_from_row: 58, p_to_row: 58, p_to_quarter: 0, p_expected_row: 59, p_note: null, p_idempotency_key: randomUUID() });
    assert.equal(sit.error?.code, "P0002");
    assert.equal(current(part), 59);
    assert.equal(psql(`SELECT count(*) FROM craft_timers WHERE user_id IN ('${a.id}','${b.id}');`), "0");
  });

  await test("anon: no EXECUTE on any 073 function (permission denied before the body runs)", async () => {
    const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const [name, args] of [["craft_rows", { p_user_id: a.id, p_part_id: randomUUID(), p_expected_row: 1, p_to_row: null, p_mode: "done" }], ["craft_timer", { p_user_id: a.id, p_action: "start", p_project_id: randomUUID() }],
      ["craft_set_total", { p_user_id: a.id, p_part_id: randomUUID(), p_total: 2, p_expected_total: 1 }], ["craft_band_check", { p_user_id: a.id, p_segment_id: randomUUID() }],
      ["craft_log_sitting", { p_user_id: a.id, p_part_id: randomUUID(), p_use_timer: false, p_timer_version: null, p_minutes: 1, p_date: null, p_started_at: null, p_ended_at: null, p_from_row: 0, p_to_row: 0, p_to_quarter: 0, p_expected_row: 1, p_note: null, p_idempotency_key: "k" }]]) {
      const { error } = await anonClient.rpc(name, args);
      assert.equal(error?.code, "42501", `${name}: ${error?.message}`);
    }
  });

  await test("Routes: bad input is a 400 before the database; an unknown part in the project is a 404; a part of another project of the same user is a 404", async () => {
    const s = blanket(a.id), other = scarf(a.id);
    for (const body of [{ part_id: s.parts[0], mode: "jump", expected_row: 59 }, { part_id: "x", mode: "done", expected_row: 59 }, { part_id: s.parts[0], mode: "done" }, { part_id: s.parts[0], mode: "done", expected_row: 59, extra: 1 }]) {
      assert.equal((await post(rowRoute, a, s.projectId, "row", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: randomUUID(), mode: "done", expected_row: 1 })).status, 404);
    assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: other.parts[0], mode: "done", expected_row: 97 })).status, 404);
    assert.equal((await post(totalRoute, a, s.projectId, "total", { part_id: s.parts[0], total: 0, expected_total: 157 })).status, 400);
    assert.equal(current(s.parts[0]), 59);
  });

  await test("Notes: a row note and a project note are saved and shown newest first; a note for another project's part is 404; delete removes it; Remove now lists notes", async () => {
    const s = blanket(a.id), [part] = s.parts;
    const first = await post(notesRoute, a, s.projectId, "notes", { part_id: part, row: 59, text: "extra dc in the turning chain" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await post(notesRoute, a, s.projectId, "notes", { text: "Ivory skein 3 started" });
    assert.deepEqual(second.body.view.notes.map((n) => [n.row, n.text]), [[null, "Ivory skein 3 started"], [59, "extra dc in the turning chain"]]);
    const other = scarf(a.id);
    assert.equal((await post(notesRoute, a, s.projectId, "notes", { part_id: other.parts[0], row: 1, text: "x" })).status, 404);
    const gone = await post(notesRoute, a, s.projectId, "notes", { id: second.body.note.id }, "DELETE");
    assert.equal(gone.status, 200);
    assert.equal(gone.body.view.notes.length, 1);
    assert.equal((await post(notesRoute, a, s.projectId, "notes", { id: second.body.note.id }, "DELETE")).status, 404);
  });

  // ── Timer ─────────────────────────────────────────────────────────────────
  const timerRow = (owner) => JSON.parse(psql(`SELECT coalesce(to_json(t)::text, 'null') FROM craft_timers t WHERE user_id='${owner}';`) || "null");
  const clearTimer = (owner) => psql(`DELETE FROM craft_timers WHERE user_id='${owner}';`);

  await test("Timer: start (start row = the current row), pause banks the stretch and stamps paused_at, resume, toggle, ± minutes, discard; each change bumps the version", async () => {
    clearTimer(a.id);
    const s = scarf(a.id), [part] = s.parts;
    let r = await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: part });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.result.timer.start_row, r.body.result.timer.version, r.body.view.timer.running], [97, 1, true]);
    psql(`UPDATE craft_timers SET running_since = running_since - interval '10 minutes', sitting_started_at = sitting_started_at - interval '10 minutes' WHERE user_id='${a.id}';`);
    r = await post(timerRoute, a, s.projectId, "timer", { action: "pause", expected_version: 1 });
    assert.equal(r.body.result.timer.running_since, null);
    assert.ok(r.body.result.timer.banked_seconds >= 600 && r.body.result.timer.banked_seconds < 610, String(r.body.result.timer.banked_seconds));
    assert.ok(r.body.result.timer.paused_at);
    r = await post(timerRoute, a, s.projectId, "timer", { action: "adjust", minutes: 2, expected_version: 2 });
    assert.equal(r.body.result.timer.adjust_seconds, 120);
    assert.equal(r.body.view.timer.elapsed_seconds >= 720, true);
    r = await post(timerRoute, a, s.projectId, "timer", { action: "adjust", minutes: -60, expected_version: 3 });
    assert.equal(r.status, 400);
    r = await post(timerRoute, a, s.projectId, "timer", { action: "toggle", expected_version: 3 });
    assert.deepEqual([r.body.result.action, r.body.view.timer.running, r.body.result.timer.paused_at], ["resume", true, null]);
    r = await post(timerRoute, a, s.projectId, "timer", { action: "toggle", expected_version: 4 });
    assert.equal(r.body.result.action, "pause");
    r = await post(timerRoute, a, s.projectId, "timer", { action: "discard", expected_version: 5 });
    assert.deepEqual([r.status, r.body.view.timer], [200, null]);
    assert.equal(timerRow(a.id), null);
  });

  await test("Timer: a stale version is a 409 with the current timer; nothing changes", async () => {
    clearTimer(a.id);
    const s = scarf(a.id);
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: s.parts[0] });
    await post(timerRoute, a, s.projectId, "timer", { action: "pause", expected_version: 1 });
    const r = await post(timerRoute, a, s.projectId, "timer", { action: "resume", expected_version: 1 });
    assert.deepEqual([r.status, r.body.reason, r.body.result.timer.version, r.body.view.timer.running], [409, "stale", 2, false]);
    clearTimer(a.id);
  });

  await test("Timer: stopped X min ago pauses as of then (paused_at and banked time); further back than the stretch is refused; while paused it says not running", async () => {
    clearTimer(a.id);
    const s = scarf(a.id);
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: s.parts[0] });
    psql(`UPDATE craft_timers SET running_since = now() - interval '30 minutes', sitting_started_at = now() - interval '30 minutes' WHERE user_id='${a.id}';`);
    const tooFar = await post(timerRoute, a, s.projectId, "timer", { action: "stopped_ago", minutes: 45, expected_version: 1 });
    assert.equal(tooFar.status, 400);
    assert.match(tooFar.body.error, /only run 30 min/);
    const r = await post(timerRoute, a, s.projectId, "timer", { action: "stopped_ago", minutes: 5, expected_version: 1 });
    assert.equal(r.status, 200);
    const banked = r.body.result.timer.banked_seconds;
    assert.ok(banked >= 25 * 60 - 2 && banked <= 25 * 60 + 2, String(banked));
    assert.equal(psql(`SELECT abs(extract(epoch FROM paused_at - (now() - interval '5 minutes'))) < 5 FROM craft_timers WHERE user_id='${a.id}';`), "t");
    const paused = await post(timerRoute, a, s.projectId, "timer", { action: "stopped_ago", minutes: 1, expected_version: 2 });
    assert.deepEqual([paused.status, paused.body.reason], [409, "not_running"]);
    clearTimer(a.id);
  });

  await test("Timer conflict: starting the blanket while the scarf's timer holds time returns the scarf and its minutes and changes nothing; after the scarf's discard the blanket starts", async () => {
    clearTimer(a.id);
    const sc = scarf(a.id), bl = blanket(a.id);
    await post(timerRoute, a, sc.projectId, "timer", { action: "start", part_id: sc.parts[0] });
    psql(`UPDATE craft_timers SET running_since = now() - interval '23 minutes' WHERE user_id='${a.id}';`);
    const before = JSON.stringify(timerRow(a.id));
    const r = await post(timerRoute, a, bl.projectId, "timer", { action: "start", part_id: bl.parts[0] });
    assert.deepEqual([r.status, r.body.reason, r.body.result.other.project_id, r.body.result.other.project_name], [409, "conflict", sc.projectId, "Fake Scarf"]);
    assert.ok(r.body.result.other.elapsed_seconds >= 23 * 60);
    assert.equal(r.body.view.other_timer.project_name, "Fake Scarf");
    assert.equal(r.body.view.timer, null);
    assert.equal(JSON.stringify(timerRow(a.id)), before);
    const off = await post(timerRoute, a, sc.projectId, "timer", { action: "discard", expected_version: r.body.result.other.version });
    assert.equal(off.status, 200);
    const ok = await post(timerRoute, a, bl.projectId, "timer", { action: "start", part_id: bl.parts[0] });
    assert.deepEqual([ok.status, ok.body.view.timer.project_id, ok.body.view.timer.start_row], [200, bl.projectId, 59]);
    clearTimer(a.id);
  });

  await test("Timer new ET day: resuming a sitting that started yesterday (ET) asks first (409 new_day, nothing changes); with force it resumes as one sitting", async () => {
    clearTimer(a.id);
    const s = scarf(a.id);
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: s.parts[0] });
    await post(timerRoute, a, s.projectId, "timer", { action: "pause", expected_version: 1 });
    psql(`UPDATE craft_timers SET sitting_started_at = ((now() AT TIME ZONE 'America/New_York')::date - 1 + time '21:30') AT TIME ZONE 'America/New_York', banked_seconds = 2400 WHERE user_id='${a.id}';`);
    const r = await post(timerRoute, a, s.projectId, "timer", { action: "resume", expected_version: 2 });
    assert.deepEqual([r.status, r.body.reason, r.body.view.timer.new_day, r.body.view.timer.running], [409, "new_day", true, false]);
    const forced = await post(timerRoute, a, s.projectId, "timer", { action: "resume", expected_version: 2, force: true });
    assert.deepEqual([forced.status, forced.body.view.timer.running], [200, true]);
    clearTimer(a.id);
  });

  await test("1,440-minute cap: a timer over 24 h can't be saved with its own minutes (400 in plain words); typed minutes up to 1,440 save; the view marks long runs and over-cap", async () => {
    clearTimer(a.id);
    const s = scarf(a.id), [part] = s.parts;
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: part });
    psql(`UPDATE craft_timers SET running_since = now() - interval '25 hours', sitting_started_at = now() - interval '25 hours' WHERE user_id='${a.id}';`);
    const v = (await detailRoute.GET(req(a, "GET", `/api/craft/${s.projectId}`), ctx(s.projectId)).then((x) => x.json())).timer;
    assert.deepEqual([v.long_run, v.over_cap], [true, true]);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: true, timer_version: 1, to_row: 96, expected_row: 97, idempotency_key: randomUUID() });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /at most 1440 minutes/);
    const ok = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: true, timer_version: 1, minutes: 90, to_row: 96, expected_row: 97, idempotency_key: randomUUID() });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.result.minutes, 90);
    clearTimer(a.id);
  });

  // ── Log sitting ──────────────────────────────────────────────────────────
  await test("Log sitting with the timer: 40 min, three Row dones, saved as one 059 sitting (rows linked, band task, minutes rolled up), sitting details, the timer cleared", async () => {
    clearTimer(a.id);
    const s = blanket(a.id), [part] = s.parts;
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: part });
    psql(`UPDATE craft_timers SET running_since = now() - interval '40 minutes', sitting_started_at = now() - interval '40 minutes' WHERE user_id='${a.id}';`);
    for (const row of [59, 60, 61]) assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: row })).status, 200);
    const key = randomUUID();
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: true, timer_version: 1, to_row: 61, expected_row: 62, note: "trunks lined up", idempotency_key: key });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const session = JSON.parse(psql(`SELECT to_json(s) FROM work_sessions s WHERE id='${r.body.result.session_id}';`));
    assert.deepEqual([session.minutes, session.task_id, session.note, session.source, session.source_ref, session.session_date], [40, s.tasks["Tree 2"], "trunks lined up", "manual", `client:${key}`, today()]);
    assert.ok(Math.abs(Date.parse(session.ended_at) - Date.now()) < 60_000);
    assert.equal(psql(`SELECT string_agg(i.craft_row::text, ',' ORDER BY i.craft_row) FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id WHERE w.session_id='${session.id}';`), "59,60,61");
    assert.equal(psql(`SELECT actual_minutes FROM tasks WHERE id='${s.tasks["Tree 2"]}';`), "40");
    assert.equal(psql(`SELECT from_row || ':' || to_row || ':' || adjust_minutes FROM craft_sitting_details WHERE session_id='${session.id}';`), "58:61:0");
    assert.equal(timerRow(a.id), null);
    assert.equal(r.body.view.recent_sittings[0].minutes, 40);
    assert.equal(r.body.view.today.minutes, 40);
  });

  await test("Log sitting is idempotent: the same key again is the same sitting (200 duplicate, nothing new); the key used on another project is a 409", async () => {
    const s = blanket(a.id), [part] = s.parts, key = randomUUID();
    const body = { part_id: part, use_timer: false, minutes: 25, from_row: 58, to_row: 60, expected_row: 59, idempotency_key: key };
    const first = await post(sittingsRoute, a, s.projectId, "sittings", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await post(sittingsRoute, a, s.projectId, "sittings", { ...body, expected_row: 61 });
    assert.deepEqual([again.status, again.body.result.status, again.body.result.session_id], [200, "duplicate", first.body.result.session_id]);
    const racing = await Promise.all([1, 2, 3].map(() => post(sittingsRoute, a, s.projectId, "sittings", { ...body, expected_row: 61 })));
    assert.ok(racing.every((x) => x.status === 200 && x.body.result.session_id === first.body.result.session_id));
    assert.equal(psql(`SELECT count(*) FROM work_sessions WHERE source_ref='client:${key}';`), "1");
    const other = scarf(a.id);
    const elsewhere = await post(sittingsRoute, a, other.projectId, "sittings", { part_id: other.parts[0], use_timer: false, minutes: 25, from_row: 96, to_row: 96, expected_row: 97, idempotency_key: key });
    assert.equal(elsewhere.status, 409);
  });

  await test("Log sitting without the timer: minutes typed, rows 59–61 ticked and linked, rows already in another sitting are ticked but not linked twice, \"last full row\" lower than the taps unticks the extra rows", async () => {
    const s = blanket(a.id), [part] = s.parts;
    // A row linked to an earlier sitting, then unticked (a counting mistake): it is ticked again but stays with its sitting.
    const earlier = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: false, minutes: 10, from_row: 58, to_row: 59, expected_row: 59, idempotency_key: randomUUID() });
    await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "undo", expected_row: 60, to_row: 59 });
    for (const row of [59, 60, 61, 62, 63]) await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: row });
    const plan = sittingPlan(rowStates(part), 157, 58, 61);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: false, minutes: 32, from_row: 58, to_row: 61, expected_row: 64, idempotency_key: randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.result.unticked, r.body.result.current_row, r.body.result.rows_linked], [[62, 63], 62, 2]);
    assert.deepEqual(plan.link, [60, 61]);
    assert.deepEqual(plan.untick, [62, 63]);
    assert.equal(psql(`SELECT string_agg(i.craft_row::text, ',' ORDER BY i.craft_row) FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id WHERE w.session_id='${r.body.result.session_id}';`), "60,61");
    assert.equal(psql(`SELECT count(*) FROM work_session_items w WHERE w.session_id='${earlier.body.result.session_id}';`), "1");
    assert.equal(psql(`SELECT session_date || ':' || minutes || ':' || (started_at IS NULL) FROM work_sessions WHERE id='${r.body.result.session_id}';`), `${today()}:32:true`);
  });

  await test("Log sitting: quarters only on a part with quarters (the scarf), stored as the next row's quarter; minutes added to the timer move the start back; details keep the adjust", async () => {
    clearTimer(a.id);
    const s = scarf(a.id), [part] = s.parts;
    await post(timerRoute, a, s.projectId, "timer", { action: "start", part_id: part });
    psql(`UPDATE craft_timers SET running_since = now() - interval '20 minutes', sitting_started_at = now() - interval '20 minutes' WHERE user_id='${a.id}';`);
    await post(timerRoute, a, s.projectId, "timer", { action: "adjust", minutes: 13, expected_version: 1 });
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: true, timer_version: 2, to_row: 98, to_quarter: 2, expected_row: 97, idempotency_key: randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.result.minutes, 33);
    assert.ok(Math.abs((Date.parse(r.body.result.ended_at) - Date.parse(r.body.result.started_at)) / 60000 - 33) < 0.1, "start moved back to make room for 33 min");
    assert.equal(psql(`SELECT quarter || ':' || quarter_row FROM craft_parts WHERE id='${part}';`), "2:99");
    assert.deepEqual([r.body.view.active_part.current_row, r.body.view.active_part.quarter], [99, 2]);
    assert.equal(psql(`SELECT from_row || ':' || to_row || ':' || to_quarter || ':' || adjust_minutes FROM craft_sitting_details WHERE session_id='${r.body.result.session_id}';`), "96:98:2:13");
    const bl = blanket(a.id);
    const refused = await post(sittingsRoute, a, bl.projectId, "sittings", { part_id: bl.parts[0], use_timer: false, minutes: 5, from_row: 58, to_row: 58, to_quarter: 1, expected_row: 59, idempotency_key: randomUUID() });
    assert.equal(refused.status, 400);
  });

  await test("Log sitting = a project-page sitting: the same sitting via craft_log_sitting and via POST /api/work-sessions gives the same getProjectPace() and getProjectForecast()", async () => {
    const s = blanket(a.id, 58), [part] = s.parts;
    psql(`UPDATE projects SET target_date = '2026-12-23' WHERE id='${s.projectId}';`);
    const start = new Date(Date.now() - 90 * 60_000), end = new Date(Date.now() - 30 * 60_000);
    const startEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(start);
    const opts = { now: new Date(), today: today() };
    const strip = (pace) => JSON.parse(JSON.stringify(pace, (k, v) => (["id", "session_id", "created_at"].includes(k) ? undefined : v)));
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: part, use_timer: false, minutes: 55, started_at: start.toISOString(), ended_at: end.toISOString(), from_row: 58, to_row: 61, expected_row: 59, note: "same sitting", idempotency_key: randomUUID() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const craftPace = strip(await getProjectPace(a.client, a.id, s.projectId, opts));
    const craftForecast = strip(await getProjectForecast(a.client, a.id, s.projectId, opts));
    // Put the project back exactly as it was, then log the same sitting the project page's way.
    psql(`DELETE FROM work_sessions WHERE id='${r.body.result.session_id}'; UPDATE task_checklist_items SET is_done=false WHERE craft_part_id='${part}' AND craft_row BETWEEN 59 AND 61;`);
    const page = await logWorkSession(a.client, a.id, { task_id: s.tasks["Tree 2"], date: startEt, start: start.toISOString(), end: end.toISOString(), minutes: 55, rows: "59-61", note: "same sitting", idempotency_key: randomUUID() }, opts);
    assert.equal(page.session.minutes, 55);
    const pagePace = strip(await getProjectPace(a.client, a.id, s.projectId, opts));
    const pageForecast = strip(await getProjectForecast(a.client, a.id, s.projectId, opts));
    assert.deepEqual(craftForecast, pageForecast);
    assert.deepEqual(craftPace, pagePace);
    assert.equal(craftPace.sessions.length, 1);
    assert.equal(craftPace.sessions[0].minutes, 55);
  });

  // ── FR1 (fix round 1): timed sittings across a part end / a count fix, stale sheets, the toast, minutes, total ──
  const A = await import("../src/lib/craft/actions.ts");
  const getView = async (who, projectId) => (await detailRoute.GET(req(who, "GET", `/api/craft/${projectId}`), ctx(projectId))).json();
  /** The body LogSittingSheet sends from a view, untouched form (minutes only when typed or with no timer). */
  const sheetBody = (view, minutes = null) => {
    const part = view.active_part, timer = view.timer, d = A.logSittingDefaults(view.row_states, part.total_rows, timer);
    return A.logSittingBody(part, timer, { from: d.from, to: d.to, quarter: 0, note: "", key: `craft-${randomUUID()}`, minutesTouched: minutes !== null }, minutes ?? d.minutes ?? 30);
  };
  const preview = (view) => {
    const part = view.active_part, d = A.logSittingDefaults(view.row_states, part.total_rows, view.timer);
    return A.sittingSummary(part.row_word, part.name, A.sittingPlan(view.row_states, part.total_rows, d.from, d.to), view.timer && !view.timer.on_active_part ? view.timer_rows : [], d.minutes);
  };
  const linkedRows = (sessionId) => psql(`SELECT string_agg(p.name || ':' || i.craft_row, ',' ORDER BY p.sort_order, i.craft_row) FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id JOIN craft_parts p ON p.id = i.craft_part_id WHERE w.session_id='${sessionId}';`);
  const range = (name, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${name}:${from + i}`).join(",");
  const mittensTwo = (owner, cuffDone) => seedCraft(owner, "Fake Mittens", [{ name: "Cuff", word: "Rnd", total: 31, done: cuffDone, stitch: 36, type: "rib" }, { name: "Hand", word: "Rnd", total: 45, done: 0, stitch: 36, type: "stockinette" }], { craft: "knit" });
  const startTimerAgo = async (who, s, partId, minutes) => {
    const st = await post(timerRoute, who, s.projectId, "timer", { action: "start", part_id: partId });
    assert.equal(st.status, 200, JSON.stringify(st.body).slice(0, 300));
    psql(`UPDATE craft_timers SET running_since = now() - interval '${minutes} minutes', sitting_started_at = now() - interval '${minutes} minutes' WHERE user_id='${who.id}';`);
  };
  const rowDone = async (who, s, partId, from, to) => { for (let row = from; row <= to; row++) assert.equal((await post(rowRoute, who, s.projectId, "row", { part_id: partId, mode: "done", expected_row: row })).status, 200, `row ${row}`); };

  await test("FR1 F1a: mittens, timer started on the Cuff at round 15, Row done through 31, the screen moves to the Hand; Log sitting with the sheet's exact body saves Cuff rounds 15–31 (the preview said so), the minutes, and clears the timer", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 14), [cuff, hand] = s.parts;
    await startTimerAgo(a, s, cuff, 35);
    await rowDone(a, s, cuff, 15, 31);
    const view = await getView(a, s.projectId);
    assert.deepEqual([view.active_part.id, view.timer.part_id, view.timer.on_active_part], [hand, cuff, false]);
    assert.equal(preview(view), "Saves Cuff rounds 15–31, 35 min");
    const body = sheetBody(view);
    assert.deepEqual([body.part_id, body.to_row, body.expected_row, "from_row" in body, "minutes" in body], [hand, 0, 1, false, false]);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", body);
    assert.equal(r.status, 201, `${r.status} ${r.body.error}`);
    assert.equal(linkedRows(r.body.result.session_id), range("Cuff", 15, 31));
    assert.deepEqual([r.body.result.minutes, r.body.result.task_id, r.body.result.rows_linked], [35, s.tasks.Cuff, 17]);
    assert.deepEqual(r.body.result.other_rows, [{ part_id: cuff, rows: Array.from({ length: 17 }, (_, i) => 15 + i) }]);
    // S3 (074) F1: the details name the part the sitting ended on: no Hand rows, so the Cuff's 15–31 (S2 wrote Hand 0–0).
    assert.equal(psql(`SELECT part_id || ':' || from_row || ':' || to_row FROM craft_sitting_details WHERE session_id='${r.body.result.session_id}';`), `${cuff}:14:31`);
    assert.equal(timerRow(a.id), null);
    assert.equal(psql(`SELECT actual_minutes FROM tasks WHERE id='${s.tasks.Cuff}';`), "35");
  });

  await test("FR1 F1a + 3 Hand rounds: links Cuff 29–31 and Hand 1–3 (task NULL across two tasks), exactly the view's preview; Hand rounds ticked before the sitting are not linked", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 28), [cuff, hand] = s.parts;
    // Hand round 1 was ticked last week (before this sitting) and is in no sitting: not this sitting's.
    psql(`UPDATE task_checklist_items SET is_done = true, completed_at = '2026-11-01T17:00:00Z' WHERE craft_part_id='${hand}' AND craft_row = 1;`);
    await startTimerAgo(a, s, cuff, 50);
    await rowDone(a, s, cuff, 29, 31);
    await rowDone(a, s, hand, 2, 4);
    const view = await getView(a, s.projectId);
    assert.equal(preview(view), "Saves Cuff rounds 29–31 and Hand rounds 2–4, 50 min");
    const r = await post(sittingsRoute, a, s.projectId, "sittings", sheetBody(view));
    assert.equal(r.status, 201, `${r.status} ${r.body.error}`);
    assert.equal(linkedRows(r.body.result.session_id), `${range("Cuff", 29, 31)},${range("Hand", 2, 4)}`);
    assert.deepEqual([r.body.result.task_id, r.body.result.from_row, r.body.result.minutes], [null, 1, 50]);
  });

  await test("FR1 part end with 0 rows in the next part, timer started on round 1 of the Cuff (Astra's zero-row case): the sitting saves all 31 Cuff rounds and the minutes, never a zero-row Hand sitting that drops them", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 0), [cuff] = s.parts;
    await startTimerAgo(a, s, cuff, 90);
    assert.equal(timerRow(a.id).start_row, 1);
    await rowDone(a, s, cuff, 1, 31);
    const view = await getView(a, s.projectId);
    assert.equal(preview(view), "Saves Cuff rounds 1–31, 1 h 30 min");
    const r = await post(sittingsRoute, a, s.projectId, "sittings", sheetBody(view));
    assert.equal(r.status, 201, `${r.status} ${r.body.error}`);
    assert.deepEqual([r.body.result.rows_linked, r.body.result.minutes], [31, 90]);
    assert.equal(linkedRows(r.body.result.session_id), range("Cuff", 1, 31));
  });

  await test("FR1 F1b: blanket timer started on row 61, Fix count back to 59 lowers the timer's start row (version bumped), row 59 done; Log sitting with the sheet's exact body saves row 59; an Undo below the start row lowers it too", async () => {
    clearTimer(a.id);
    const s = blanket(a.id, 60), [part] = s.parts;
    await startTimerAgo(a, s, part, 25);
    assert.equal(timerRow(a.id).start_row, 61);
    assert.equal((await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "fix", expected_row: 61, to_row: 59 })).status, 200);
    assert.deepEqual([timerRow(a.id).start_row, timerRow(a.id).version], [59, 2]);
    await rowDone(a, s, part, 59, 59);
    const view = await getView(a, s.projectId);
    assert.equal(preview(view), "Saves row 59, 25 min");
    const r = await post(sittingsRoute, a, s.projectId, "sittings", sheetBody(view));
    assert.equal(r.status, 201, `${r.status} ${r.body.error}`);
    assert.equal(linkedRows(r.body.result.session_id), "Blanket:59");
    // Undo below the start row (and a body sent straight to the function with a start row past the saved row) never raises.
    const s2 = blanket(a.id, 62), [p2] = s2.parts;
    await startTimerAgo(a, s2, p2, 10);
    assert.equal((await post(rowRoute, a, s2.projectId, "row", { part_id: p2, mode: "undo", expected_row: 63, to_row: 60 })).status, 200);
    assert.deepEqual([timerRow(a.id).start_row, timerRow(a.id).version], [60, 2]);
    psql(`UPDATE craft_timers SET start_row = 63 WHERE user_id='${a.id}';`);
    const r2 = await post(sittingsRoute, a, s2.projectId, "sittings", { part_id: p2, use_timer: true, timer_version: 2, to_row: 59, expected_row: 60, idempotency_key: randomUUID() });
    assert.equal(r2.status, 201, `${r2.status} ${r2.body.error}`);
    assert.deepEqual([r2.body.result.rows_linked, timerRow(a.id)], [0, null]);
  });

  await test("FR1 pace parity across two parts: the Cuff 29–31 + Hand 1–3 sitting via craft_log_sitting = the same sitting via the project page's service (same getProjectPace() and getProjectForecast())", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 28), [cuff, hand] = s.parts;
    psql(`UPDATE projects SET target_date = '2026-12-20' WHERE id='${s.projectId}';`);
    await startTimerAgo(a, s, cuff, 45);
    await rowDone(a, s, cuff, 29, 31);
    await rowDone(a, s, hand, 1, 3);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", sheetBody(await getView(a, s.projectId)));
    assert.equal(r.status, 201, `${r.status} ${r.body.error}`);
    const opts = { now: new Date(), today: today() };
    const strip = (pace) => JSON.parse(JSON.stringify(pace, (k, v) => (["id", "session_id", "created_at"].includes(k) ? undefined : v)));
    const craftPace = strip(await getProjectPace(a.client, a.id, s.projectId, opts)), craftForecast = strip(await getProjectForecast(a.client, a.id, s.projectId, opts));
    const itemIds = psql(`SELECT string_agg(checklist_item_id::text, ',') FROM work_session_items WHERE session_id='${r.body.result.session_id}';`).split(",");
    psql(`DELETE FROM work_sessions WHERE id='${r.body.result.session_id}';`);
    const page = await logWorkSession(a.client, a.id, { project_id: s.projectId, date: r.body.result.session_date, start: r.body.result.started_at, end: r.body.result.ended_at,
      minutes: r.body.result.minutes, item_ids: itemIds, idempotency_key: randomUUID() }, opts);
    assert.equal(page.session.minutes, 45);
    assert.deepEqual(strip(await getProjectForecast(a.client, a.id, s.projectId, opts)), craftForecast);
    assert.deepEqual(strip(await getProjectPace(a.client, a.id, s.projectId, opts)), craftPace);
    assert.equal(craftPace.sessions.length, 1);
  });

  await test("FR1 links stay in scope: a timer whose part is in another project is not this sitting's (no_timer), and the function refuses to link rows that are not ticked rows of this project (23503 guard present)", async () => {
    clearTimer(a.id);
    const s = mittensTwo(a.id, 14), other = mittensTwo(a.id, 14);
    await startTimerAgo(a, other, other.parts[0], 20);
    const r = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: s.parts[1], use_timer: true, timer_version: 1, to_row: 0, expected_row: 1, idempotency_key: randomUUID() });
    assert.deepEqual([r.status, r.body.reason], [409, "no_timer"]);
    assert.notEqual(timerRow(a.id), null, "the other project's timer and its minutes stay");
    // S3 (074): the body moved to craft_save_sitting (craft_log_sitting calls it).
    assert.match(psql("SELECT pg_get_functiondef('craft_save_sitting(uuid,uuid,boolean,integer,integer,date,timestamp with time zone,timestamp with time zone,integer,integer,integer,integer,text,text,boolean)'::regprocedure);"),
      /a linked row is not a ticked row of this project' USING ERRCODE = '23503'/);
    clearTimer(a.id);
  });

  await test("FR1 stale sheets (Astra 1): Log sitting opened with row 61 finished, another screen finishes 62, the refresh arrives; the sheet says so and its captured body is refused (409 stale): row 62 stays ticked, no sitting", async () => {
    const s = blanket(a.id, 61), [part] = s.parts;
    const opened = await getView(a, s.projectId);
    const body = A.logSittingBody(opened.active_part, opened.timer, { from: 58, to: 61, quarter: 0, note: "", key: `craft-${randomUUID()}`, minutesTouched: true }, 30);
    assert.equal((await rpc(a, "craft_rows", { p_user_id: a.id, p_part_id: part, p_expected_row: 62, p_to_row: null, p_mode: "done" })).data.status, "ok");
    const refreshed = await getView(a, s.projectId);
    assert.equal(A.sheetChangeText(A.sheetFactsOf(opened), A.sheetFactsOf(refreshed), { timer: true }), "Your count changed on another screen (now row 63). Check and save again.");
    const r = await post(sittingsRoute, a, s.projectId, "sittings", body);
    assert.deepEqual([r.status, r.body.reason, r.body.result.current_row], [409, "stale", 63]);
    assert.equal(doneRows(part).split(",").includes("62"), true);
    assert.equal(psql(`SELECT count(*) FROM work_sessions WHERE project_id='${s.projectId}';`), "0");
    // Undo rows opened on row 64 (go back to 60), another screen ticks 64: the captured body is refused, nothing unticked.
    const u = blanket(a.id, 63), [up] = u.parts;
    const openedU = await getView(a, u.projectId);
    await rowDone(a, u, up, 64, 64);
    const ru = await post(rowRoute, a, u.projectId, "row", { part_id: up, mode: "undo", expected_row: openedU.active_part.current_row, to_row: 60 });
    assert.deepEqual([ru.status, ru.body.reason], [409, "stale"]);
    assert.equal(current(up), 65);
  });

  await test("FR1 Undo toast (Fable R3): Row done 59 with rows 60–63 already ticked → the toast opens Undo rows… (nothing sent); without rows ahead the toast's body unticks only row 59", async () => {
    const s = blanket(a.id, 58), [part] = s.parts;
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row BETWEEN 60 AND 63;`);
    const before = (await getView(a, s.projectId)).row_states;
    const done = await post(rowRoute, a, s.projectId, "row", { part_id: part, mode: "done", expected_row: 59 });
    assert.deepEqual(A.toastUndo(before, 157, 59, done.body.result.current_row), { kind: "sheet", to: 59 });
    assert.equal(doneRows(part).split(",").filter((r) => Number(r) >= 59).join(","), "59,60,61,62,63");
    const t = blanket(a.id, 58), [tp] = t.parts;
    const beforeT = (await getView(a, t.projectId)).row_states;
    const doneT = await post(rowRoute, a, t.projectId, "row", { part_id: tp, mode: "done", expected_row: 59 });
    const undo = A.toastUndo(beforeT, 157, 59, doneT.body.result.current_row);
    assert.equal(undo.kind, "one");
    const r = await post(rowRoute, a, t.projectId, "row", { part_id: tp, ...undo.body });
    assert.deepEqual(r.body.result.unticked, [59]);
  });

  await test("FR1 Delete note: the screen's old POST { id } was a 400 that deleted nothing; DELETE { id } removes the note", async () => {
    const s = blanket(a.id), [part] = s.parts;
    const note = await post(notesRoute, a, s.projectId, "notes", { part_id: part, row: 59, text: "extra dc" });
    const wrong = await post(notesRoute, a, s.projectId, "notes", { id: note.body.note.id });
    assert.equal(wrong.status, 400);
    assert.equal(psql(`SELECT count(*) FROM craft_notes WHERE id='${note.body.note.id}';`), "1");
    const right = await post(notesRoute, a, s.projectId, "notes", { id: note.body.note.id }, "DELETE");
    assert.deepEqual([right.status, right.body.deleted, right.body.view.notes.length], [200, note.body.note.id, 0]);
  });

  await test("FR1 typed minutes vs start–end (F0's rule): 11 typed minutes in a 10-minute span save with the start unmoved; 12 are refused with the project page's words; fewer is fine; with the timer, typed minutes over its span + 1 are refused too", async () => {
    const s = blanket(a.id, 58), [part] = s.parts;
    const end = new Date(Date.now() - 5 * 60_000), start = new Date(end.getTime() - 10 * 60_000);
    const body = (minutes) => ({ part_id: part, use_timer: false, minutes, started_at: start.toISOString(), ended_at: end.toISOString(), from_row: 58, to_row: 58, expected_row: 59, idempotency_key: randomUUID() });
    const over = await post(sittingsRoute, a, s.projectId, "sittings", body(12));
    assert.equal(over.status, 400);
    assert.equal(over.body.error, "minutes (12) are more than start–end (10 min); minutes can be less (breaks taken off) but not more");
    const edge = await post(sittingsRoute, a, s.projectId, "sittings", body(11));
    assert.equal(edge.status, 201, JSON.stringify(edge.body).slice(0, 300));
    assert.equal(Date.parse(edge.body.result.started_at), start.getTime(), "the start never moves");
    const less = await post(sittingsRoute, a, s.projectId, "sittings", body(4));
    assert.equal(less.status, 201);
    clearTimer(a.id);
    const t = blanket(a.id, 58), [tp] = t.parts;
    await startTimerAgo(a, t, tp, 20);
    const timed = await post(sittingsRoute, a, t.projectId, "sittings", { part_id: tp, use_timer: true, timer_version: 1, minutes: 40, to_row: 58, expected_row: 59, idempotency_key: randomUUID() });
    assert.equal(timed.status, 400);
    assert.match(timed.body.error, /^minutes \(40\) are more than start–end \(20 min\)/);
    assert.notEqual(timerRow(a.id), null, "a refused save keeps the timer's minutes");
    const ok = await post(sittingsRoute, a, t.projectId, "sittings", { part_id: tp, use_timer: true, timer_version: 1, minutes: 21, to_row: 58, expected_row: 59, idempotency_key: randomUUID() });
    assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 300));
  });

  await test("FR1 Change total (Fable R9): a part with no stitch count adds rounds that copy the last round's units and type; on the scarf a lower total lowers the stitches left in the pace forecast", async () => {
    const s = seedCraft(a.id, "Fake Mittens 3", [{ name: "Hand", word: "Rnd", total: 10, done: 2, stitch: null, type: "stockinette" }], { craft: "knit" });
    const [part] = s.parts;
    psql(`UPDATE task_checklist_items SET unit_count = 36 + craft_row WHERE craft_part_id='${part}';`);
    const r = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 12, expected_total: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(psql(`SELECT string_agg(text || '=' || unit_count || '/' || work_type, ' ' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row > 10;`), "Rnd 11=46/stockinette Rnd 12=46/stockinette");
    const sc = scarf(a.id), [body] = sc.parts;
    const opts = { now: new Date(), today: today() };
    const left = async () => (await getProjectForecast(a.client, a.id, sc.projectId, opts)).forecast.work_types.reduce((sum, w) => sum + w.units_left, 0);
    const before = await left();
    const cut = await post(totalRoute, a, sc.projectId, "total", { part_id: body, total: 500, expected_total: 519 });
    assert.equal(cut.status, 200, JSON.stringify(cut.body).slice(0, 200));
    assert.equal(before - (await left()), 19 * 30);
  });

  // ── Change total ─────────────────────────────────────────────────────────
  await test("Change total, more: \"Row 520\"–\"Row 522\" added at the end of the last task with 30 stitches and the last row's work type; the last segment grows; the TS plan said the same", async () => {
    const s = scarf(a.id), [part] = s.parts;
    const plan = setTotalPlan(rowStates(part), 519, 522);
    const r = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 522, expected_total: 519 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(plan.add, [520, 521, 522]);
    assert.equal(r.body.result.added, 3);
    assert.equal(psql(`SELECT string_agg(text || '|' || trim_scale(unit_count)::text || '|' || work_type || '|' || craft_row || '|' || (task_id = '${s.tasks["Scarf rows 201–519"]}'), ',' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row > 519;`),
      "Row 520|30|garter|520|true,Row 521|30|garter|521|true,Row 522|30|garter|522|true");
    assert.equal(psql(`SELECT to_row FROM craft_segments WHERE id='${s.tasks["Scarf rows 201–519:segment"]}';`), "522");
    assert.equal(r.body.view.active_part.total_rows, 522);
    const stale = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 530, expected_total: 519 });
    assert.deepEqual([stale.status, stale.body.reason], [409, "stale"]);
  });

  await test("Change total, fewer: trailing unticked rows in no sitting are removed (segment cut, empty segment removed); a ticked or sitting-linked trailing row refuses in plain words, nothing changed", async () => {
    const s = scarf(a.id), [part] = s.parts;
    const r = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 150, expected_total: 519 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.removed, 369);
    assert.equal(psql(`SELECT count(*) || ':' || max(craft_row) FROM task_checklist_items WHERE craft_part_id='${part}';`), "150:150");
    assert.equal(psql(`SELECT string_agg(name || ' ' || from_row || '-' || to_row, ',' ORDER BY from_row) FROM craft_segments WHERE part_id='${part}';`), "Scarf rows 1–100 1-100,Scarf rows 101–200 101-150");
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row = 140;`);
    const plan = setTotalPlan(rowStates(part), 150, 120);
    const ticked = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 120, expected_total: 150 });
    assert.deepEqual([ticked.status, ticked.body.reason, ticked.body.result.rows, plan.kind, plan.rows], [409, "ticked", [140], "refused", [140]]);
    assert.match(ticked.body.error, /Can't remove row 140: it is ticked/);
    psql(`UPDATE task_checklist_items SET is_done = false WHERE craft_part_id='${part}' AND craft_row = 140;`);
    psql(`SELECT work_session_create('${a.id}', jsonb_build_object('project_id','${s.projectId}','session_date','2026-11-08','minutes',5), ARRAY[(SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row=145)], false);`);
    const linked = await post(totalRoute, a, s.projectId, "total", { part_id: part, total: 120, expected_total: 150 });
    assert.deepEqual([linked.status, linked.body.reason, linked.body.result.rows], [409, "in_sitting", [145]]);
    assert.match(linked.body.error, /part of a saved sitting/);
    assert.equal(total(part), 150);
  });

  await test("Change total keeps the S1C row rule: after adding \"Rnd 32\"–\"Rnd 33\" and Remove, the TS planner and 072/073's SQL plan both read them as rounds of the cuff (33 rounds)", async () => {
    const s = seedCraft(a.id, "Fake Mittens total", [{ name: "Mitten 1 · Cuff", word: "Rnd", total: 31, done: 14, stitch: 36 }], { craft: "knit" });
    const r = await post(totalRoute, a, s.projectId, "total", { part_id: s.parts[0], total: 33, expected_total: 31 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const removed = await detailRoute.DELETE(req(a, "DELETE", `/api/craft/${s.projectId}`), ctx(s.projectId));
    assert.equal(removed.status, 200, await removed.clone().text());
    const snap = await loadSetupSnapshot(a.client, a.id, s.projectId), plan = planCraftSetup(snap);
    assert.ok(plan.ok, JSON.stringify(plan.stops));
    assert.deepEqual(plan.parts.map((p) => [p.row_word, p.total_rows, p.stitch_count, p.rows.length]), [["round", 33, 36, 33]]);
    const sql = (await rpc(a, "craft_setup_plan", { p_user_id: a.id, p_project_id: s.projectId })).data;
    assert.deepEqual([sql.stops, sql.parts[0].total_rows, sql.parts[0].rows.length, sql.parts[0].stitch_count], [[], 33, 33, 36]);
  });

  // ── Lock order (059) ─────────────────────────────────────────────────────
  await test("Concurrent Row done + task move (059 lock order): a held Row done makes the move wait, then the move is refused (55006); a held task edit makes Row done wait, then it counts once; no 40P01", async () => {
    const s = blanket(a.id), [part] = s.parts;
    const other = (await admin.from("projects").insert({ user_id: a.id, name: "Elsewhere" }).select().single()).data;
    const label = `craft-s2-move-${randomUUID()}`;
    const one = connection("rowdone"), two = connection("move");
    try {
      one.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SELECT (craft_rows('${a.id}','${part}',59,NULL,'done'))->>'status'; SELECT 'held';`);
      await one.wait("held");
      two.send(`SET application_name='${label}'; SET deadlock_timeout='100ms'; UPDATE tasks SET project_id='${other.id}' WHERE id='${s.tasks["Tree 2"]}'; SELECT 'moved';`);
      assert.ok(await waitingOnLock(label), "the move waits for Row done's task lock");
      one.send("COMMIT; SELECT 'committed';");
      await one.wait("committed");
      await two.wait("moved");
      assert.match(two.output(), /ERROR:.*craft rows/);
      assert.doesNotMatch(one.output() + two.output(), /deadlock/);
    } finally { await Promise.all([one.end(), two.end()]); }
    assert.equal(current(part), 60);
    const three = connection("edit"), four = connection("rowdone2");
    const label2 = `craft-s2-edit-${randomUUID()}`;
    try {
      three.send(`BEGIN; UPDATE tasks SET status='In Progress' WHERE id='${s.tasks["Tree 2"]}'; SELECT 'held';`);
      await three.wait("held");
      four.send(`SET application_name='${label2}'; SET deadlock_timeout='100ms'; SELECT 'rd:' || ((craft_rows('${a.id}','${part}',60,NULL,'done'))->>'status');`);
      assert.ok(await waitingOnLock(label2), `Row done waits for the task edit: ${three.output()} | ${four.output()}`);
      three.send("COMMIT; SELECT 'committed';");
      await three.wait("committed");
      await four.wait("rd:");
      assert.match(four.output(), /rd:ok/);
    } finally { await Promise.all([three.end(), four.end()]); }
    assert.equal(current(part), 61);
  });

  // ── Carry-overs a–d ──────────────────────────────────────────────────────
  await test("Carry-over a: a craft sitting on a removable project makes Remove refuse (MC72R → 409 \"sittings\"); the sitting detail keeps its part", async () => {
    const s = seedCraft(a.id, "Fake Mittens sit", [{ name: "Mitten 1 · Cuff", word: "Rnd", total: 31, done: 14, stitch: 36 }], { craft: "knit" });
    assert.equal(psql(`SELECT array_to_string(craft_remove_blockers('${a.id}','${s.projectId}'), ',');`), "");
    const sit = await post(sittingsRoute, a, s.projectId, "sittings", { part_id: s.parts[0], use_timer: false, minutes: 20, from_row: 14, to_row: 16, expected_row: 15, idempotency_key: randomUUID() });
    assert.equal(sit.status, 201, JSON.stringify(sit.body));
    assert.equal(psql(`SELECT array_to_string(craft_remove_blockers('${a.id}','${s.projectId}'), ',');`), "sittings");
    const res = await detailRoute.DELETE(req(a, "DELETE", `/api/craft/${s.projectId}`), ctx(s.projectId));
    const body = await res.json();
    assert.deepEqual([res.status, body.reason], [409, "keeps"]);
    assert.match(body.error, /craft screen sittings/);
    assert.equal(psql(`SELECT part_id FROM craft_sitting_details WHERE session_id='${sit.body.result.session_id}';`), s.parts[0]);
    assert.equal(psql(`SELECT count(*) FROM craft_projects WHERE project_id='${s.projectId}';`), "1");
  });

  await test("Carry-over b: a 062 date cascade holding the project FOR SHARE, then taking its tasks, while Create waits: no 40P01, Create then succeeds", async () => {
    const owner = a.id, projectId = randomUUID(), sectionId = randomUUID(), taskId = randomUUID();
    psql(`INSERT INTO projects (id, user_id, name) VALUES ('${projectId}','${owner}','Fake Cascade Mittens');
INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionId}','${owner}','${projectId}','Main',0);
INSERT INTO tasks (id, user_id, project_id, section_id, title, status) VALUES ('${taskId}','${owner}','${projectId}','${sectionId}','Mitten 1 · Cuff','Planned');
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) SELECT '${owner}','${taskId}','Rnd ' || n, n FROM generate_series(1,5) n;`);
    const snap = await loadSetupSnapshot(a.client, owner, projectId), plan = planCraftSetup(snap);
    const fp = (await import("../src/lib/craft/setup-fingerprint.ts")).craftSetupFingerprint(snap);
    const payload = JSON.stringify(craftSetupPayload(plan, "knit", plan.parts.map((p) => p.name)));
    const label = `craft-s2-setup-${randomUUID()}`;
    const cascade = connection("cascade"), setup = connection("setup");
    try {
      cascade.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SELECT 1 FROM projects WHERE id='${projectId}' FOR SHARE; SELECT 'share-held';`);
      await cascade.wait("share-held");
      setup.send(`SET application_name='${label}'; SET deadlock_timeout='100ms'; SELECT 'setup:' || ((craft_setup_project('${owner}','${projectId}', $j$${payload}$j$::jsonb, '${fp}'))->>'parts');`);
      assert.ok(await waitingOnLock(label), `Create waits on the project before taking any task lock: ${cascade.output()} | ${setup.output()}`);
      cascade.send(`SELECT 'locked:' || cardinality(task_date_cascade_lock('${owner}', ARRAY['${taskId}']::uuid[], 'all')); COMMIT; SELECT 'cascade-done';`);
      await cascade.wait("cascade-done");
      await setup.wait("setup:");
      assert.doesNotMatch(cascade.output() + setup.output(), /deadlock|40P01|ERROR/);
      assert.match(cascade.output(), /locked:1/);
      assert.match(setup.output(), /setup:1/);
    } finally { await Promise.all([cascade.end(), setup.end()]); }
  });

  await test("Carry-over d: two sections with one sort_order made in the same whole second: the TS planner and the SQL plan put the earlier-created first (sort_order, created_at to the millisecond, id)", async () => {
    const owner = a.id, projectId = randomUUID();
    // The later section gets the lower id, so an id tie-break alone would flip them.
    const early = "ffffffff-0000-4000-8000-000000000001", late = "00000000-0000-4000-8000-000000000002";
    psql(`DELETE FROM project_sections WHERE id IN ('${early}','${late}');
INSERT INTO projects (id, user_id, name) VALUES ('${projectId}','${owner}','Fake Same Second');
INSERT INTO project_sections (id, user_id, project_id, name, sort_order, created_at) VALUES
  ('${early}','${owner}','${projectId}','Mitten 1',0,'2026-11-10T12:00:00+00:00'),
  ('${late}','${owner}','${projectId}','Mitten 2',0,'2026-11-10T12:00:00.5+00:00');`);
    for (const [section, title] of [[late, "Mitten 2 · Cuff"], [early, "Mitten 1 · Cuff"]]) {
      const taskId = randomUUID();
      psql(`INSERT INTO tasks (id, user_id, project_id, section_id, title, status, created_at) VALUES ('${taskId}','${owner}','${projectId}','${section}',${lit(title)},'Planned','2026-11-10T12:00:01Z');
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) SELECT '${owner}','${taskId}','Rnd ' || n, n FROM generate_series(1,3) n;`);
    }
    const snap = await loadSetupSnapshot(a.client, owner, projectId), plan = planCraftSetup(snap);
    assert.ok(plan.ok, JSON.stringify(plan.stops));
    assert.deepEqual(plan.parts.map((p) => p.name), ["Mitten 1 · Cuff", "Mitten 2 · Cuff"]);
    const sql = (await rpc(a, "craft_setup_plan", { p_user_id: owner, p_project_id: projectId })).data;
    assert.deepEqual(sql.parts.map((p) => p.segments[0].task_id), plan.parts.map((p) => p.segments[0].task_id));
  });

  // ── 073's rollback ──────────────────────────────────────────────────────
  await test("073 down returns the schema to 072 exactly (every craft function's body and grants, craft_timers' columns) on a fresh 072 capture; craft rows and sittings stay; 073 re-applies", () => {
    const keep = () => psql("SELECT md5(coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id), '')) FROM work_sessions s; SELECT md5(coalesce(string_agg(to_jsonb(d)::text, ',' ORDER BY d.session_id), '')) FROM craft_sitting_details d; SELECT md5(coalesce(string_agg((to_jsonb(i) - 'is_done' - 'completed_at')::text, ',' ORDER BY i.id), '')) FROM task_checklist_items i;");
    const rows = keep();
    psql(down074);
    psql(down073);
    psql(down072);
    psql(up072);
    const fresh072 = schemaState();
    psql(up073);
    assert.notEqual(schemaState(), fresh072);
    psql(down073);
    assert.equal(schemaState(), fresh072);
    for (const fn of FUNCTIONS_073) assert.equal(psql(`SELECT to_regprocedure('${fn}') IS NULL;`), "t", fn);
    assert.equal(keep(), rows);
    psql(up073);
    assert.equal(keep(), rows);
    psql(up074);
    for (const fn of FUNCTIONS_073_UNDER_074) assert.equal(psql(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), "t", fn);
  });
} finally {
  // Big fake projects (519-row scarves) make GoTrue's own cascade slow: remove the projects first, as the database owner.
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft S2 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
