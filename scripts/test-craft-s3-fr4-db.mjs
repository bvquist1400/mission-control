#!/usr/bin/env node
// Craft S3 FR4 on a disposable LOCAL stack (CRAFT_TEST_*), the FR3 review follow-ups in 074's craft_set_total and the
// view: where raised rows go (p_how after_row / after_steps), the take-back of rows a raise added (p_how take_back,
// Fable R13 end to end: the wrong raise, the take-back, the right raise), its refusals, the renumber edges in SQL
// (case, a leading range, later numbers) against the TS mirror, passed checks as earlier steps (Row done with Not yet),
// the step after the last row, an Undo below a ticked check, the ticked cuff check after the repair (Fable R14) and the
// payload. Fake data shaped like the mittens and the scarf only. Destructive only to this local stack.
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
const only = process.env.CRAFT_FR4_ONLY ? new RegExp(process.env.CRAFT_FR4_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-fr4-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-fr4-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const rowRoute = await import("../src/app/api/craft/[projectId]/row/route.ts");
const totalRoute = await import("../src/app/api/craft/[projectId]/total/route.ts");
const checkRoute = await import("../src/app/api/craft/[projectId]/check/route.ts");
const partRoute = await import("../src/app/api/craft/[projectId]/part/route.ts");
const timerRoute = await import("../src/app/api/craft/[projectId]/timer/route.ts");
const detailRoute = await import("../src/app/api/craft/[projectId]/route.ts");
const A = await import("../src/lib/craft/actions.ts");
const C = await import("../src/lib/craft.ts");

const lit = (t) => `$lit$${t}$lit$`;
const ctx = (projectId) => ({ params: Promise.resolve({ projectId }) });
const req = (who, method, path, body) => {
  const r = new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  return r;
};
const post = async (route, who, projectId, path, body) => {
  const res = await route.POST(req(who, "POST", `/api/craft/${projectId}/${path}`, body), ctx(projectId));
  return { status: res.status, body: await res.json() };
};
const getView = async (who, projectId) => (await detailRoute.GET(req(who, "GET", `/api/craft/${projectId}`), ctx(projectId))).json();

const CHECK = "Check: cuff 4 in from cast-on? Then switch to US 7";
const GUSSET_CHECK = "Check: 48 sts, 13 between BOR and marker";
/**
 * A mitten seeded with SQL, shaped like the live ones: task "Mitten · Cuff" (Cast on (sort 0), Rnd 1–21 rib, Rnd
 * 22–28 (est.) rib, the US 7 check (sort 29), Rnd 29–31 knit (US 7) (sort 30–32), stockinette), task "Mitten · Thumb
 * gusset" (Rnd 1–16, the 48-sts check (sort 16), Rnd 17–20). cuffRows overrides the Cuff's rows: [row, text, type].
 */
function seedMitten(owner, { cuffDone = 0, gussetDone = 0, castOnDone = false, active = "gusset", cuffRows = null, extraSegments = true } = {}) {
  const projectId = randomUUID(), sectionId = randomUUID(), cuff = randomUUID(), gusset = randomUUID(), cuffTask = randomUUID(), gussetTask = randomUUID();
  const out = { projectId, cuff, gusset, cuffTask, gussetTask, items: {} };
  const rowsOf = cuffRows ?? [
    ...Array.from({ length: 21 }, (_, i) => [i + 1, `Rnd ${i + 1} · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 7 }, (_, i) => [i + 22, `Rnd ${i + 22} (est.) · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 3 }, (_, i) => [i + 29, `Rnd ${i + 29} · knit (US 7)`, "stockinette"]),
  ];
  const cuffTotal = Math.max(...rowsOf.map(([row]) => row));
  let sql = `INSERT INTO projects (id, user_id, name, tags, unit_label) VALUES ('${projectId}','${owner}','Fake Mittens',ARRAY['knitting'],'stitches');
INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionId}','${owner}','${projectId}','Mitten',0);
INSERT INTO craft_projects (project_id, user_id, craft) VALUES ('${projectId}','${owner}','knit');
INSERT INTO craft_parts (id, user_id, project_id, name, sort_order, total_rows, row_word, quarters, stitch_count) VALUES
  ('${cuff}','${owner}','${projectId}','Cuff',0,${cuffTotal},'round',true,36), ('${gusset}','${owner}','${projectId}','Thumb gusset',1,20,'round',false,NULL);
INSERT INTO tasks (id, user_id, project_id, section_id, title, status, created_at) VALUES
  ('${cuffTask}','${owner}','${projectId}','${sectionId}','Mitten · Cuff','Planned','2026-11-02T00:00:00Z'), ('${gussetTask}','${owner}','${projectId}','${sectionId}','Mitten · Thumb gusset','Planned','2026-11-02T00:00:01Z');
INSERT INTO craft_segments (id, user_id, part_id, task_id, name, from_row, to_row, sort_order) VALUES
  ('${randomUUID()}','${owner}','${cuff}','${cuffTask}','Mitten · Cuff',1,${cuffTotal},0), ('${randomUUID()}','${owner}','${gusset}','${gussetTask}','Mitten · Thumb gusset',1,20,0);\n`;
  const add = (keyName, task, text, sort, done, partId = null, row = null, type = null, units = null) => {
    const id = randomUUID(); out.items[keyName] = id;
    sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row) VALUES ('${id}','${owner}','${task}',${lit(text)},${done},${done ? "'2026-11-10T23:00:00Z'" : "NULL"},${sort},${units ?? "NULL"},${type ? lit(type) : "NULL"},${partId ? `'${partId}'` : "NULL"},${row ?? "NULL"});\n`;
  };
  add("castOn", cuffTask, "Cast on 36 (long-tail, US 5), place BOR, join", 0, castOnDone);
  for (const [row, text, type] of rowsOf) add(`cuff:${row}`, cuffTask, text, row <= 28 ? row : row + 1, row <= cuffDone, cuff, row, type, 36);
  add("check", cuffTask, CHECK, 29, false);
  for (let row = 1; row <= 20; row++) add(`gus:${row}`, gussetTask, row === 1 ? "Rnd 1 (set-up) · k1, M1R, k1, pm" : `Rnd ${row} · gusset`, row <= 16 ? row - 1 : row, row <= gussetDone, gusset, row, "stockinette", 36 + row);
  add("gussetCheck", gussetTask, GUSSET_CHECK, 16, false);
  if (active) sql += `UPDATE craft_projects SET active_part_id = '${active === "cuff" ? cuff : gusset}' WHERE project_id = '${projectId}';\n`;
  if (extraSegments && !cuffRows) {
    // Two more Cuff bands so the shift is seen: the (est.) rib and the knit rounds.
    out.estSeg = randomUUID(); out.knitSeg = randomUUID();
    sql += `INSERT INTO craft_segments (id, user_id, part_id, name, from_row, to_row, sort_order) VALUES ('${out.estSeg}','${owner}','${cuff}','Rib (est.)',25,28,1), ('${out.knitSeg}','${owner}','${cuff}','Knit (US 7)',29,31,2);\n`;
  }
  psql(sql);
  return out;
}
/** Mitten 1 as Brent left it on 11/12: S2's Change total cut the Cuff to 24 (25–31 gone), every round ticked; the Gusset unticked again (ripped). */
const mittenOne = (owner) => seedMitten(owner, { castOnDone: true, cuffDone: 24, active: "gusset", cuffRows: Array.from({ length: 24 }, (_, i) => [i + 1, i < 21 ? `Rnd ${i + 1} · k1, p1 rib` : `Rnd ${i + 1} (est.) · k1, p1 rib`, "rib"]) });
const cuffText = (m) => psql(`SELECT string_agg(craft_row || '=' || text || '/' || coalesce(work_type, '-') || '/' || is_done, ' | ' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${m.cuff}';`);
const itemsHash = (m) => psql(`SELECT md5(string_agg(id || ':' || coalesce(craft_row::text, '-') || ':' || text || ':' || is_done, ',' ORDER BY id)) FROM task_checklist_items WHERE task_id IN ('${m.cuffTask}','${m.gussetTask}');`);
const rowOf = (itemId) => psql(`SELECT coalesce(craft_row::text, 'gone') FROM task_checklist_items WHERE id='${itemId}' UNION ALL SELECT 'gone' WHERE NOT EXISTS (SELECT 1 FROM task_checklist_items WHERE id='${itemId}') LIMIT 1;`);
const rowStates = (partId) => JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('row', craft_row, 'done', is_done, 'linked', EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND NOT w.in_progress), 'in_progress', EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND w.in_progress), 'today', false, 'text', text) ORDER BY craft_row), '[]') FROM task_checklist_items i WHERE craft_part_id='${partId}';`));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());


/** A scarf-like part on one task: rows 1..n bare "Row N" (sort 2r), steps after rows (sort 2r+1). */
function seedScarf(owner, { n = 455, done = 0, steps = [] } = {}) {
  const projectId = randomUUID(), sectionId = randomUUID(), part = randomUUID(), task = randomUUID();
  const out = { projectId, part, task, items: {}, steps: {} };
  let sql = `INSERT INTO projects (id, user_id, name, tags, unit_label) VALUES ('${projectId}','${owner}','Fake Scarf',ARRAY['knitting'],'stitches');
INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionId}','${owner}','${projectId}','Scarf',0);
INSERT INTO craft_projects (project_id, user_id, craft, active_part_id) VALUES ('${projectId}','${owner}','knit',NULL);
INSERT INTO craft_parts (id, user_id, project_id, name, sort_order, total_rows, row_word, quarters, ridges, stitch_count) VALUES ('${part}','${owner}','${projectId}','Scarf',0,${n},'row',true,true,40);
INSERT INTO tasks (id, user_id, project_id, section_id, title, status) VALUES ('${task}','${owner}','${projectId}','${sectionId}','Scarf rows','Planned');
INSERT INTO craft_segments (id, user_id, part_id, task_id, name, from_row, to_row, sort_order) VALUES ('${randomUUID()}','${owner}','${part}','${task}','Scarf rows',1,${n},0);
INSERT INTO task_checklist_items (user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row)
  SELECT '${owner}','${task}','Row ' || r, r <= ${done}, CASE WHEN r <= ${done} THEN '2026-11-05T23:00:00Z'::timestamptz END, 2 * r, 40, 'garter', '${part}', r FROM generate_series(1, ${n}) r;
UPDATE craft_projects SET active_part_id = '${part}' WHERE project_id = '${projectId}';\n`;
  for (const [after, text] of steps) { const id = randomUUID(); out.steps[text] = id;
    sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${id}','${owner}','${task}',${lit(text)},false,${2 * after + 1});\n`; }
  psql(sql);
  return out;
}

let a, b;
try {
  a = await user(); b = await user();
  process.env.MISSION_CONTROL_USER_ID = a.id;

  await test("FR4 074: craft_set_total(uuid,uuid,integer,integer,text,text,text) is SECURITY INVOKER, EXECUTE for authenticated and service_role only; no 6-argument one; p_how other than after_row / after_steps / take_back, or the wrong way round, is 22023 (the route: 400 before the database)", async () => {
    const fn = "craft_set_total(uuid,uuid,integer,integer,text,text,text)";
    assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), "f");
    for (const [role, can] of [["authenticated", "t"], ["service_role", "t"], ["anon", "f"]]) assert.equal(psql(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE');`), can, role);
    assert.equal(psql("SELECT to_regprocedure('craft_set_total(uuid,uuid,integer,integer,text,text)') IS NULL AND to_regprocedure('craft_set_total(uuid,uuid,integer,integer)') IS NULL;"), "t");
    const m = mittenOne(a.id);
    for (const [args, label] of [[{ p_total: 27, p_expected_total: 24, p_how: "sideways" }, "unknown how"], [{ p_total: 27, p_expected_total: 24, p_how: "take_back" }, "take_back raising"], [{ p_total: 20, p_expected_total: 24, p_how: "after_steps" }, "after_steps lowering"]]) {
      const r = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, ...args });
      assert.equal(r.error?.code, "22023", label);
    }
    for (const body of [{ total: 27, expected_total: 24, how: "sideways" }, { total: 27, expected_total: 24, how: "take_back" }, { total: 20, expected_total: 24, how: "after_row" }]) {
      const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    // The S2 screen's 4-argument call still resolves (named arguments).
    const s2 = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 24, p_expected_total: 24 });
    assert.deepEqual([s2.error, s2.data?.status], [null, "ok"]);
  });

  await test("FR4 1 Fable R13 end to end: the wrong raise (Rnd 25–27 k1, p1 rib, after the check), the usual lowering refuses (22–24 ticked), the take-back drops 25–27 (nothing else changes), then the right raise: \"Before Round 25: Check…\" and Round 25 · knit (US 7)", async () => {
    const m = mittenOne(a.id);
    const before = itemsHash(m);
    const segBefore = psql(`SELECT string_agg(from_row || '-' || to_row, ',' ORDER BY sort_order) FROM craft_segments WHERE part_id='${m.cuff}';`);
    const wrong = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "k1, p1 rib", work_type: "rib", how: "after_steps" });
    assert.equal(wrong.status, 200, JSON.stringify(wrong.body).slice(0, 300));
    assert.equal(cuffText(m).split(" | ").slice(24).join(" | "), "25=Rnd 25 · k1, p1 rib/rib/false | 26=Rnd 26 · k1, p1 rib/rib/false | 27=Rnd 27 · k1, p1 rib/rib/false");
    const usual = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27 });
    assert.deepEqual([usual.status, usual.body.reason], [409, "ticked"]);
    assert.equal(usual.body.error, "Can't remove rounds 22–24: they are ticked. Undo them first if that was a mistake.");
    // The sheet's take-back plan names exactly these rows.
    const tb = A.takeBackPlan(C.partRowsOf(usual.body.view, m.cuff), 27, 24);
    assert.deepEqual(tb, { kind: "remove", total: 24, remove: [25, 26, 27], moves: [] });
    assert.equal(A.takeBackRowsText("round", C.partRowsOf(usual.body.view, m.cuff), tb.remove), "pattern rounds 25–27 · k1, p1 rib");
    const back = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27, how: "take_back" });
    assert.equal(back.status, 200, JSON.stringify(back.body).slice(0, 300));
    assert.deepEqual([back.body.result.removed, back.body.result.renumbered, back.body.result.dropped], [3, 0, [25, 26, 27]]);
    assert.equal(itemsHash(m), before, "every other item exactly as before the wrong raise");
    assert.equal(psql(`SELECT total_rows FROM craft_parts WHERE id='${m.cuff}';`), "24");
    assert.equal(psql(`SELECT string_agg(from_row || '-' || to_row, ',' ORDER BY sort_order) FROM craft_segments WHERE part_id='${m.cuff}';`), segBefore);
    assert.equal(back.body.view.active_part.name, "Thumb gusset", "the Cuff is finished again: the screen goes back to the Gusset");
    const right = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(right.status, 200, JSON.stringify(right.body).slice(0, 300));
    const v = right.body.view;
    assert.deepEqual([v.active_part.name, v.active_part.current_row, v.next_rows[0].text], ["Cuff", 25, "Rnd 25 · knit (US 7)"]);
    assert.deepEqual(v.due_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Round 25:", CHECK]]);
    assert.deepEqual(v.earlier_checks, [], "the Cast on is ticked");
  });

  await test("FR4 1 take-back refusals: a ticked row or a row in a sitting above the new total refuses it (nothing changes)", async () => {
    const m = mittenOne(a.id);
    assert.equal((await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "k1, p1 rib", work_type: "rib", how: "after_steps" })).status, 200);
    const ids = JSON.parse(psql(`SELECT json_object_agg(craft_row, id) FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND craft_row > 24;`));
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id = '${ids[26]}';`);
    let before = itemsHash(m);
    let r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27, how: "take_back" });
    assert.deepEqual([r.status, r.body.reason, r.body.result.rows], [409, "ticked", [26]]);
    assert.equal(itemsHash(m), before);
    psql(`UPDATE task_checklist_items SET is_done = false WHERE id = '${ids[26]}';`);
    psql(`SELECT work_session_create('${a.id}', jsonb_build_object('project_id','${m.projectId}','session_date','2026-11-11','minutes',20,'in_progress_item_ids', jsonb_build_array('${ids[27]}')), ARRAY[]::uuid[], false);`);
    before = itemsHash(m);
    r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27, how: "take_back" });
    assert.deepEqual([r.status, r.body.reason, r.body.result.rows], [409, "in_sitting", [27]]);
    assert.equal(itemsHash(m), before);
  });

  await test("FR4 6 a raise goes right after the part's last ROW by default: a trailing step (Bind off) moves after the new rows and the view shows it after the new last row; how after_steps keeps it before them", async () => {
    const s = seedScarf(a.id, { n: 455, done: 300, steps: [[455, "Bind off loosely"]] });
    let r = await post(totalRoute, a, s.projectId, "total", { part_id: s.part, total: 458, expected_total: 455, text: "knit", work_type: "garter" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(psql(`SELECT string_agg(coalesce(craft_row::text, text) || '@' || sort_order, ',' ORDER BY sort_order) FROM task_checklist_items WHERE task_id='${s.task}' AND sort_order > 908;`),
      "455@910,456@911,457@912,458@913,Bind off loosely@914");
    let bind = r.body.view.checks.find((c) => c.text === "Bind off loosely");
    assert.deepEqual([bind.row, bind.after_last, bind.after_row], [458, true, 458]);
    // The same with how after_row (explicit) on the mitten: the US 7 check moves after the new rounds (before the Gusset).
    const m = mittenOne(a.id);
    r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_row" });
    assert.equal(r.status, 200);
    assert.equal(psql(`SELECT sort_order FROM task_checklist_items WHERE id='${m.items.check}';`), "32");
    assert.deepEqual(r.body.view.checks.filter((c) => c.text === CHECK).map((c) => [C.checkBeforeText(c), c.after_row]), [["Before Round 1 (Thumb gusset):", 27]]);
    // after_steps on the scarf: the new rows after Bind off.
    const s2 = seedScarf(a.id, { n: 455, done: 300, steps: [[455, "Bind off loosely"]] });
    r = await post(totalRoute, a, s2.projectId, "total", { part_id: s2.part, total: 457, expected_total: 455, text: "knit", work_type: "garter", how: "after_steps" });
    assert.equal(r.status, 200);
    bind = r.body.view.checks.find((c) => c.text === "Bind off loosely");
    assert.deepEqual([C.checkBeforeText(bind), bind.after_last], ["Before Row 456:", false]);
  });

  await test("FR4 6 renumber edges in SQL (Fable R3) match the TS mirror: rnd / RND / Round N:, a leading range as a whole, numbers later in the text left alone", async () => {
    const rows = [
      [1, "Rnd 1 · rib", "rib"], [2, "Rnd 2 (est.) · rib", "rib"], [3, "Rnd 3 (est.) · rib", "rib"],
      [4, "Rnd 4–6 · knit", "st"], [5, "Round 5: knit, as Rnd 4", "st"], [6, "rnd 6 · knit", "st"], [7, "RND 7 · knit", "st"], [8, "Rnd  8 - k2tog (see Rnd 3)", "st"], [9, "K to end (Rnd 9)", "st"],
    ];
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 1, active: "cuff", cuffRows: rows });
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 7, expected_total: 9 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual(r.body.result.dropped, [2, 3]);
    assert.equal(cuffText(m), "1=Rnd 1 · rib/rib/true | 2=Rnd 2–4 · knit/st/false | 3=Round 3: knit, as Rnd 4/st/false | 4=rnd 4 · knit/st/false | 5=RND 5 · knit/st/false | 6=Rnd  6 - k2tog (see Rnd 3)/st/false | 7=K to end (Rnd 9)/st/false");
    for (const [from, text] of rows.filter(([row]) => row >= 4)) {
      const now = psql(`SELECT text FROM task_checklist_items WHERE id='${m.items[`cuff:${from}`]}';`);
      assert.equal(now, A.renumberRowText(text, from - 2), `row ${from}`);
    }
  });

  await test("FR4 2 passed checks don't nag: Fix count past the gusset check leaves it an earlier step (not a card); Row done with Not yet at a current-row check ticks the row and leaves the check unticked, now an earlier step; Mark all done ticks them all", async () => {
    const g = seedMitten(a.id, { castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" });
    let v = await getView(a, g.projectId);
    assert.deepEqual(v.due_checks.map((c) => c.text), [GUSSET_CHECK]);
    // Not yet = Row done alone (the server never blocks Row done).
    const row = await post(rowRoute, a, g.projectId, "row", { part_id: g.gusset, mode: "done", expected_row: 17 });
    assert.equal(row.status, 200);
    v = row.body.view;
    assert.deepEqual([v.active_part.current_row, v.due_checks, v.earlier_checks.map((c) => [C.checkBeforeText(c), c.text])], [18, [], [["Before Round 17:", GUSSET_CHECK]]]);
    assert.equal(psql(`SELECT is_done FROM task_checklist_items WHERE id='${g.items.gussetCheck}';`), "f");
    // The scarf at row 301 with two passed steps: no card, two earlier steps; Mark all done = one craft_check with both.
    const s = seedScarf(a.id, { n: 455, done: 300, steps: [[120, "Re-time at 15 in"], [250, "Join skein 2"]] });
    v = await getView(a, s.projectId);
    assert.deepEqual([v.due_checks, v.earlier_checks.map((c) => c.text)], [[], ["Re-time at 15 in", "Join skein 2"]]);
    const all = await post(checkRoute, a, s.projectId, "check", { item_ids: v.earlier_checks.map((c) => c.id) });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.view.earlier_checks, []);
  });

  await test("FR4 4 the step after the project's last row: \"After the last round (Thumb gusset)\" once round 20 is ticked, from any screen; Done ticks it", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 31, gussetDone: 19, active: "gusset" });
    const bind = randomUUID();
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id = '${m.items.gussetCheck}';
      INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${bind}','${a.id}','${m.gussetTask}','Bind off, weave in',false,99);`);
    let v = await getView(a, m.projectId);
    assert.deepEqual([v.after_last_checks, v.upcoming_checks.map((c) => c.text)], [[], ["Bind off, weave in"]]);
    const row = await post(rowRoute, a, m.projectId, "row", { part_id: m.gusset, mode: "done", expected_row: 20 });
    assert.equal(row.status, 200);
    v = row.body.view;
    assert.deepEqual(v.after_last_checks.map((c) => [C.checkBeforeText(c, v.active_part?.id ?? null), c.text]), [["After the last round:", "Bind off, weave in"]]);
    psql(`UPDATE craft_projects SET active_part_id = '${m.cuff}' WHERE project_id = '${m.projectId}';`);
    v = await getView(a, m.projectId);
    assert.deepEqual(v.after_last_checks.map((c) => C.checkBeforeText(c, v.active_part?.id ?? null)), ["After the last round (Thumb gusset):"]);
    const done = await post(checkRoute, a, m.projectId, "check", { item_ids: [bind] });
    assert.deepEqual([done.status, done.body.view.after_last_checks], [200, []]);
  });

  await test("FR4 6 Undo below a ticked check (Fable R6): the check stays ticked and never shows again (by design: a step is never unticked on its own)", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 28, active: "cuff" });
    assert.equal((await post(checkRoute, a, m.projectId, "check", { item_ids: [m.items.check] })).status, 200);
    assert.equal((await post(rowRoute, a, m.projectId, "row", { part_id: m.cuff, mode: "done", expected_row: 29 })).status, 200);
    const r = await post(rowRoute, a, m.projectId, "row", { part_id: m.cuff, mode: "undo", expected_row: 30, to_row: 26 });
    assert.equal(r.status, 200);
    assert.equal(psql(`SELECT is_done FROM task_checklist_items WHERE id='${m.items.check}';`), "t");
    assert.deepEqual([r.body.view.active_part.current_row, r.body.view.due_checks, r.body.view.earlier_checks, r.body.view.upcoming_checks], [26, [], [], []]);
  });

  await test("FR4 7 Fable R14 pinned: Done on the cuff check from the Gusset screen, then the repair (after the step): no \"Before Round 25\" card and no earlier step for it; Round 25 · knit (US 7) is Now", async () => {
    const m = mittenOne(a.id);
    assert.equal((await post(checkRoute, a, m.projectId, "check", { item_ids: [m.items.check] })).status, 200);
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(r.status, 200);
    const v = r.body.view;
    assert.deepEqual([v.active_part.name, v.active_part.current_row, v.next_rows[0].text, v.due_checks, v.earlier_checks], ["Cuff", 25, "Rnd 25 · knit (US 7)", [], []]);
  });

  await test("FR4 5 payload (Fable R4/R17): the reply for a 455-row scarf carries its rows once (part_rows empty for a one-part project)", async () => {
    const s = seedScarf(a.id, { n: 455, done: 300, steps: [[120, "Re-time at 15 in"], [250, "Join skein 2"]] });
    const res = await detailRoute.GET(req(a, "GET", `/api/craft/${s.projectId}`), ctx(s.projectId));
    const text = await res.text();
    const v = JSON.parse(text);
    assert.deepEqual(Object.keys(v.part_rows), []);
    assert.equal(v.row_states.length, 455);
    console.log(`    GET /api/craft/<scarf>: ${text.length} bytes (row_states ${JSON.stringify(v.row_states).length})`);
    assert.ok(text.length < 2 * JSON.stringify(v.row_states).length);
  });
} finally {
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) { const { error } = await admin.auth.admin.deleteUser(id); if (error) { failed++; console.error("cleanup failed", error.message); } }
}
console.log(`\nCraft S3 FR4 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
