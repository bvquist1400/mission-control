#!/usr/bin/env node
// Craft S3 FR3 on a disposable LOCAL stack (CRAFT_TEST_*): 074's safe Change total (drops only unticked "(est.)" or
// blank rows, renumbers the rest and everything that names a row), checks on the screen (craft_check), "Work on this
// part" (craft_pick_part), one screen-part rule (craft_screen_part, craft_timer), Mitten 1's repair end to end and the
// lock order under concurrent calls. Fake data shaped like the mittens only. Destructive only to this local stack.
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
const only = process.env.CRAFT_FR3_ONLY ? new RegExp(process.env.CRAFT_FR3_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-fr3-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-fr3-test-${randomUUID()}`;
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

// FR4: craft_set_total takes a 7th argument (p_how).
const NEW = ["craft_screen_part(uuid,uuid)", "craft_set_total(uuid,uuid,integer,integer,text,text,text)", "craft_check(uuid,uuid,uuid[])", "craft_pick_part(uuid,uuid,uuid)"];

let a, b;
try {
  a = await user(); b = await user();
  process.env.MISSION_CONTROL_USER_ID = a.id;

  await test("074 FR3: craft_screen_part, the 7-argument (FR4) craft_set_total, craft_check and craft_pick_part are SECURITY INVOKER with EXECUTE for authenticated and service_role only; 073's 4-argument craft_set_total is gone; craft_timer keeps its signature", () => {
    for (const fn of NEW) {
      assert.equal(psql(`SELECT to_regprocedure('${fn}') IS NOT NULL;`), "t", fn);
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), "f", `${fn} SECURITY INVOKER`);
      for (const [role, can] of [["authenticated", "t"], ["service_role", "t"], ["anon", "f"]]) assert.equal(psql(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE');`), can, `${fn} ${role}`);
      assert.equal(psql(`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = '${fn}'::regprocedure AND x.grantee = 0);`), "f", `${fn}: PUBLIC`);
    }
    assert.equal(psql("SELECT to_regprocedure('craft_set_total(uuid,uuid,integer,integer)') IS NULL;"), "t");
    assert.equal(psql("SELECT has_function_privilege('authenticated', 'craft_timer(uuid,text,uuid,uuid,integer,integer,boolean)', 'EXECUTE');"), "t");
  });

  await test("Mitten 2 lowered to 27: drops Rnd 25–28 (est.), Rnd 29–31 become Rnd 25–27 (text, type, units, tick and sitting links kept); segments, notes, frogs, sitting details, the timer and the quarter move with them; the check now comes before Round 25", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 24, active: "cuff" });
    const old = { r29: m.items["cuff:29"], r30: m.items["cuff:30"], r31: m.items["cuff:31"], r26: m.items["cuff:26"] };
    // Round 31 ticked ahead and finished in a sitting; round 30 linked in progress there; details, notes, a frog, the timer, a quarter.
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id='${old.r31}';`);
    const sid = psql(`SELECT (work_session_create('${a.id}', jsonb_build_object('project_id','${m.projectId}','session_date','2026-11-11','minutes',20,'in_progress_item_ids', jsonb_build_array('${old.r30}')), ARRAY['${old.r31}']::uuid[], false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row, in_progress_row) VALUES ('${sid}','${a.id}','${m.cuff}',30,31,30);
      INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${a.id}','${m.projectId}','${m.cuff}',30,'note on 30'), ('${a.id}','${m.projectId}','${m.cuff}',26,'note on 26'), ('${a.id}','${m.projectId}','${m.cuff}',12,'note on 12');
      INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, idempotency_key) VALUES ('${a.id}','${m.cuff}',29,30,'fr3-frog');
      INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, running_since, start_row, version) VALUES ('${a.id}','${m.projectId}','${m.cuff}', now(), now(), 30, 4);
      UPDATE craft_parts SET quarter = 2, quarter_row = 30 WHERE id='${m.cuff}';`);
    const plan = A.setTotalPlan(rowStates(m.cuff), 31, 27);
    assert.equal(A.renumberText("round", rowStates(m.cuff), plan), "Drops Rnd 25–28 (est.). Rnd 29–31 · knit (US 7) become Rnd 25–27. New total 27.");
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 31 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    assert.deepEqual([r.body.result.dropped, r.body.result.removed, r.body.result.renumbered, r.body.result.total], [[25, 26, 27, 28], 4, 3, 27]);
    assert.equal(cuffText(m).split(" | ").slice(23).join(" | "), "24=Rnd 24 (est.) · k1, p1 rib/rib/true | 25=Rnd 25 · knit (US 7)/stockinette/false | 26=Rnd 26 · knit (US 7)/stockinette/false | 27=Rnd 27 · knit (US 7)/stockinette/true");
    assert.deepEqual([rowOf(old.r29), rowOf(old.r30), rowOf(old.r31), rowOf(old.r26)], ["25", "26", "27", "gone"], "the same items, renumbered; the (est.) rows gone");
    assert.equal(psql(`SELECT string_agg(trim_scale(unit_count)::text, ',' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND craft_row >= 25;`), "36,36,36");
    assert.equal(psql(`SELECT string_agg(checklist_item_id::text || CASE WHEN in_progress THEN '~' ELSE '' END, ',' ORDER BY in_progress) FROM work_session_items WHERE session_id='${sid}';`), `${old.r31},${old.r30}~`, "sitting links kept");
    assert.equal(psql(`SELECT string_agg(name || ' ' || from_row || '-' || to_row, ', ' ORDER BY sort_order) FROM craft_segments WHERE part_id='${m.cuff}';`), "Mitten · Cuff 1-27, Knit (US 7) 25-27", "the (est.)-only band goes");
    assert.equal(psql(`SELECT string_agg(text || '@' || coalesce(row::text, '-'), ', ' ORDER BY text) FROM craft_notes WHERE part_id='${m.cuff}';`), "note on 12@12, note on 26@24, note on 30@26");
    assert.equal(psql(`SELECT from_row || '-' || to_row FROM craft_frogs WHERE idempotency_key='fr3-frog';`), "25-26");
    assert.equal(psql(`SELECT from_row || '-' || to_row || '/' || in_progress_row FROM craft_sitting_details WHERE session_id='${sid}';`), "26-27/26");
    assert.equal(psql(`SELECT start_row || '/' || version FROM craft_timers WHERE user_id='${a.id}';`), "26/5", "start row moved, version bumped");
    assert.equal(psql(`SELECT total_rows || '/' || quarter || '/' || quarter_row FROM craft_parts WHERE id='${m.cuff}';`), "27/2/26");
    assert.equal(psql(`SELECT sort_order || ':' || is_done FROM task_checklist_items WHERE id='${m.items.check}';`), "29:false", "the check stays where it was");
    psql(`DELETE FROM craft_timers WHERE user_id='${a.id}';`);
    const view = await getView(a, m.projectId);
    assert.equal(view.active_part.current_row, 25);
    assert.deepEqual(view.due_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Round 25:", CHECK]]);
    assert.equal(view.next_rows[0].text, "Rnd 25 · knit (US 7)");
  });

  await test("Lowering refuses, in plain words, a total that would drop a pattern row (not_est), a ticked (est.) row (ticked) or one in a sitting (in_sitting); nothing changes; the TS plan says the same", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 24, active: "cuff" });
    const before = itemsHash(m);
    const tooFar = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 20, expected_total: 31 });
    assert.deepEqual([tooFar.status, tooFar.body.reason, tooFar.body.result.rows, tooFar.body.result.need], [409, "not_est", [22, 23, 24, 25, 26, 27, 28], 11]);
    assert.equal(tooFar.body.error, "Can't drop 11 rounds: only rounds 22–28 are (est.) or blank rounds. Rounds with pattern steps are never dropped.");
    assert.deepEqual(A.setTotalPlan(rowStates(m.cuff), 31, 20), { kind: "refused", total: 20, reason: "not_est", rows: [22, 23, 24, 25, 26, 27, 28], need: 11 });
    const ticked = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 25, expected_total: 31 });
    assert.deepEqual([ticked.status, ticked.body.reason, ticked.body.result.rows], [409, "ticked", [23, 24]]);
    assert.match(ticked.body.error, /Can't remove rounds 23–24: they are ticked/);
    psql(`SELECT work_session_create('${a.id}', jsonb_build_object('project_id','${m.projectId}','session_date','2026-11-11','minutes',5,'in_progress_item_ids', jsonb_build_array('${m.items["cuff:27"]}')), '{}'::uuid[], false);`);
    const linked = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 31 });
    assert.deepEqual([linked.status, linked.body.reason, linked.body.result.rows], [409, "in_sitting", [27]]);
    assert.equal(itemsHash(m), before, "nothing dropped or renumbered");
    assert.equal(psql(`SELECT total_rows FROM craft_parts WHERE id='${m.cuff}';`), "31");
    // S2's own 4-argument call (the live screen before the app ships) gets the same rule: 24 would need the 7 highest
    // (est.) rounds, 22–28, and 22–24 are ticked (S2 deleted 25–31 here, Brent's 11/12 incident).
    const direct = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 24, p_expected_total: 31 });
    assert.equal(direct.error, null);
    assert.deepEqual([direct.data.status, direct.data.reason, direct.data.rows], ["refused", "ticked", [22, 23, 24]]);
  });

  await test("Raising with text and a work type: Rnd 25–27 \"knit (US 7)\" / stockinette, unticked, after the check, the part's 36 stitches, the segment extended, and the part becomes the screen's part; a bad work type is a 400", async () => {
    const m = mittenOne(a.id);
    const bad = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "Stocking Stitch" });
    assert.equal(bad.status, 400);
    // FR4: "after the check" is the sheet's "New rounds after it" (how after_steps); the default goes right after Rnd 24.
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(psql(`SELECT string_agg(text || '/' || work_type || '/' || is_done || '/' || trim_scale(unit_count)::text || '/' || (sort_order > 29), ' | ' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND craft_row > 24;`),
      "Rnd 25 · knit (US 7)/stockinette/false/36/true | Rnd 26 · knit (US 7)/stockinette/false/36/true | Rnd 27 · knit (US 7)/stockinette/false/36/true");
    assert.equal(psql(`SELECT to_row FROM craft_segments WHERE part_id='${m.cuff}';`), "27");
    assert.equal(psql(`SELECT active_part_id FROM craft_projects WHERE project_id='${m.projectId}';`), m.cuff);
    // No text: the bare label and the last row's type, as S2.
    const s2 = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 28, expected_total: 27 });
    assert.equal(s2.status, 200);
    assert.equal(psql(`SELECT text || '/' || work_type FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND craft_row = 28;`), "Rnd 28/stockinette");
  });

  await test("Mitten 1's repair end to end: the screen shows the cuff check before Gusset round 1; Parts → Cuff → Change total 24 → 27 with \"knit (US 7)\" and stockinette; the screen then shows \"Before Round 25: Check: cuff 4 in…\" and Round 25 · knit (US 7); Done ticks the check; Row done counts round 25", async () => {
    const m = mittenOne(a.id);
    const first = await getView(a, m.projectId);
    assert.deepEqual([first.active_part.name, first.active_part.current_row], ["Thumb gusset", 1]);
    assert.deepEqual(first.due_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Round 1 (Thumb gusset):", CHECK]]);
    const cuffPart = first.parts.find((p) => p.id === m.cuff);
    assert.equal(cuffPart.finished, true);
    const plan = A.setTotalPlan(first.part_rows[m.cuff], 24, 27);
    assert.deepEqual(plan, { kind: "add", total: 27, add: [25, 26, 27] });
    // FR4: the sheet asks where the new rounds go (the check sits right after Rnd 24): Brent picks "New rounds after it".
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const v = r.body.view;
    assert.deepEqual([v.active_part.name, v.active_part.current_row, v.active_part.total_rows], ["Cuff", 25, 27]);
    assert.deepEqual(v.due_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Round 25:", CHECK]]);
    assert.equal(v.next_rows[0].text, "Rnd 25 · knit (US 7)");
    assert.equal(psql(`SELECT count(*) FILTER (WHERE NOT is_done) || '/' || count(*) FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND craft_row > 24;`), "3/3");
    const done = await post(checkRoute, a, m.projectId, "check", { item_ids: v.due_checks.map((c) => c.id) });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    assert.deepEqual(done.body.view.due_checks, []);
    const row = await post(rowRoute, a, m.projectId, "row", { part_id: m.cuff, mode: "done", expected_row: 25 });
    assert.equal(row.status, 200);
    assert.equal(row.body.view.active_part.current_row, 26);
    // Once the Cuff's three rounds are done, the screen goes back to the Gusset (the stored part is finished).
    for (const n of [26, 27]) assert.equal((await post(rowRoute, a, m.projectId, "row", { part_id: m.cuff, mode: "done", expected_row: n })).status, 200);
    const after = await getView(a, m.projectId);
    assert.deepEqual([after.active_part.name, after.active_part.current_row, after.due_checks], ["Thumb gusset", 1, []]);
  });

  await test("Checks: Mitten 2's Cast on shows before Cuff round 1; the gusset's check between rounds 16 and 17; Done ticks the item (again = already); Fix count past a check leaves it unticked and showing", async () => {
    const m = seedMitten(a.id, { active: "cuff" });
    const v = await getView(a, m.projectId);
    assert.deepEqual(v.due_checks.map((c) => [C.checkBeforeText(c), c.id]), [["Before Round 1:", m.items.castOn]]);
    const done = await post(checkRoute, a, m.projectId, "check", { item_ids: [m.items.castOn] });
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.result.ticked, [m.items.castOn]);
    assert.equal(psql(`SELECT is_done || ':' || (completed_at IS NOT NULL) FROM task_checklist_items WHERE id='${m.items.castOn}';`), "true:true");
    const again = await post(checkRoute, a, m.projectId, "check", { item_ids: [m.items.castOn] });
    assert.deepEqual([again.status, again.body.result.ticked, again.body.result.already], [200, [], [m.items.castOn]]);
    const g = seedMitten(a.id, { castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" });
    const gv = await getView(a, g.projectId);
    assert.deepEqual(gv.due_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Round 17:", GUSSET_CHECK]]);
    psql(`UPDATE task_checklist_items SET is_done = false WHERE id IN ('${g.items["gus:15"]}','${g.items["gus:16"]}');`);
    assert.deepEqual((await getView(a, g.projectId)).due_checks, [], "on round 15 the check isn't due yet");
    const fix = await post(rowRoute, a, g.projectId, "row", { part_id: g.gusset, mode: "fix", expected_row: 15, to_row: 18 });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.view.active_part.current_row, 18);
    // FR4: passed, it is no longer a card that Row done asks about; it shows on the "earlier steps not ticked" list.
    assert.deepEqual(fix.body.view.due_checks, []);
    assert.deepEqual(fix.body.view.earlier_checks.map((c) => c.text), [GUSSET_CHECK], "Fix count past it: still unticked and showing");
    assert.equal(psql(`SELECT is_done FROM task_checklist_items WHERE id='${g.items.gussetCheck}';`), "f");
  });

  await test("Row done with a check showing: Yes = the check, then the row (both ticked); Not yet = neither call (both stay); the server itself never blocks Row done (chat, the task panel)", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" });
    const v = await getView(a, m.projectId);
    assert.equal(v.due_checks.length, 1);
    assert.equal(psql(`SELECT count(*) FILTER (WHERE is_done) FROM task_checklist_items WHERE id IN ('${m.items.gussetCheck}','${m.items["gus:17"]}');`), "0", "Not yet: nothing sent, both unticked");
    const c = await post(checkRoute, a, m.projectId, "check", { item_ids: v.due_checks.map((x) => x.id) });
    assert.equal(c.status, 200);
    const r = await post(rowRoute, a, m.projectId, "row", { part_id: m.gusset, mode: "done", expected_row: 17 });
    assert.equal(r.status, 200);
    assert.equal(psql(`SELECT count(*) FILTER (WHERE is_done) FROM task_checklist_items WHERE id IN ('${m.items.gussetCheck}','${m.items["gus:17"]}');`), "2");
  });

  await test("craft_check guards: a row item, another project's item, a band close's Count item or another user's call is refused (409 stale / 404 / 403) and ticks nothing", async () => {
    const m = seedMitten(a.id, { active: "cuff" });
    const other = seedMitten(a.id, { active: "cuff" });
    const row = await post(checkRoute, a, m.projectId, "check", { item_ids: [m.items["cuff:1"]] });
    assert.deepEqual([row.status, row.body.reason], [409, "stale"]);
    const elsewhere = await post(checkRoute, a, m.projectId, "check", { item_ids: [other.items.castOn, m.items.castOn] });
    assert.deepEqual([elsewhere.status, elsewhere.body.reason], [409, "stale"]);
    assert.equal(psql(`SELECT count(*) FILTER (WHERE is_done) FROM task_checklist_items WHERE id IN ('${other.items.castOn}','${m.items.castOn}');`), "0", "all or nothing");
    const countId = randomUUID();
    psql(`UPDATE craft_segments SET close_check = true WHERE task_id='${m.cuffTask}'; INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${countId}','${a.id}','${m.cuffTask}','Count: 36 stitches',false,40);`);
    const count = await post(checkRoute, a, m.projectId, "check", { item_ids: [countId] });
    assert.deepEqual([count.status, count.body.reason], [409, "stale"]);
    const bogus = await post(checkRoute, a, m.projectId, "check", { item_ids: ["not-a-uuid"] });
    assert.equal(bogus.status, 400);
    const stranger = await post(checkRoute, b, m.projectId, "check", { item_ids: [m.items.castOn] });
    assert.equal(stranger.status, 404);
    const forged = await b.client.rpc("craft_check", { p_user_id: a.id, p_project_id: m.projectId, p_item_ids: [m.items.castOn] });
    assert.ok(forged.error, "another user's id");
    const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    assert.ok((await anonClient.rpc("craft_check", { p_user_id: a.id, p_project_id: m.projectId, p_item_ids: [m.items.castOn] })).error, "anon");
    assert.equal(psql(`SELECT is_done FROM task_checklist_items WHERE id='${m.items.castOn}';`), "f");
  });

  await test("Work on this part: craft_pick_part sets the screen's part (guarded by the part the screen showed); a finished part is refused (Change total… brings it back); another user 404", async () => {
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 20, gussetDone: 3, active: "gusset" });
    const stale = await post(partRoute, a, m.projectId, "part", { part_id: m.cuff, expected_part_id: m.cuff });
    assert.deepEqual([stale.status, stale.body.reason], [409, "stale"]);
    const ok = await post(partRoute, a, m.projectId, "part", { part_id: m.cuff, expected_part_id: m.gusset });
    assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
    assert.deepEqual([ok.body.view.active_part.name, ok.body.view.active_part.current_row], ["Cuff", 21]);
    const one = mittenOne(a.id);
    const finished = await post(partRoute, a, one.projectId, "part", { part_id: one.cuff, expected_part_id: one.gusset });
    assert.deepEqual([finished.status, finished.body.reason], [409, "finished"]);
    assert.equal(psql(`SELECT active_part_id FROM craft_projects WHERE project_id='${one.projectId}';`), one.gusset);
    const stranger = await post(partRoute, b, m.projectId, "part", { part_id: m.gusset, expected_part_id: m.cuff });
    assert.equal(stranger.status, 404);
  });

  await test("One screen-part rule: craft_screen_part equals the view's active part in every case (stored unfinished, stored finished, none stored, all finished with and without a stored part); craft_timer start with no part starts on it", async () => {
    const cases = [
      ["stored unfinished", { cuffDone: 10, gussetDone: 0, active: "gusset" }],
      ["stored finished", { cuffDone: 31, gussetDone: 2, active: "cuff" }],
      ["none stored, first finished", { cuffDone: 31, gussetDone: 2, active: null }],
      ["none stored", { cuffDone: 5, gussetDone: 0, active: null }],
      ["all finished, stored", { cuffDone: 31, gussetDone: 20, active: "gusset" }],
      ["all finished, none stored", { cuffDone: 31, gussetDone: 20, active: null }],
    ];
    for (const [name, opts] of cases) {
      const m = seedMitten(a.id, { castOnDone: true, ...opts });
      const sql = psql(`SELECT coalesce(craft_screen_part('${a.id}','${m.projectId}')::text, 'none');`);
      const view = await getView(a, m.projectId);
      assert.equal(sql, view.active_part?.id ?? "none", name);
    }
    // 073 started a timer with no part on the stored part even when it was finished (the Cuff); 074 FR3 uses the screen's part.
    const m = seedMitten(a.id, { castOnDone: true, cuffDone: 31, gussetDone: 2, active: "cuff" });
    psql(`DELETE FROM craft_timers WHERE user_id='${a.id}';`);
    const t = await post(timerRoute, a, m.projectId, "timer", { action: "start" });
    assert.equal(t.status, 200, JSON.stringify(t.body).slice(0, 300));
    assert.deepEqual([psql(`SELECT part_id || '/' || start_row FROM craft_timers WHERE user_id='${a.id}';`)], [`${m.gusset}/3`]);
    psql(`DELETE FROM craft_timers WHERE user_id='${a.id}';`);
  });

  await test("Lock order: a held renumbering Change total makes Ripped back, a chat sitting create and Row done wait (and the reverse: a held rip-back, chat edit or Row done makes Change total wait); every call finishes, no 40P01", async () => {
    const pairs = [];
    const run = async (holdSql, waitSql, waitMarker, label) => {
      const one = connection(`hold-${label}`), two = connection(`wait-${label}`);
      const app = `fr3-${label}-${randomUUID().slice(0, 8)}`; // application_name keeps 63 characters
      try {
        one.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; ${holdSql}; SELECT 'held';`);
        await one.wait("held");
        assert.doesNotMatch(one.output(), /ERROR/, one.output());
        two.send(`SET application_name='${app}'; SET deadlock_timeout='100ms'; ${waitSql};`);
        assert.ok(await waitingOnLock(app), `${label}: the second call waits: ${one.output()} | ${two.output()}`);
        one.send("COMMIT; SELECT 'committed';");
        await one.wait("committed");
        await two.wait(waitMarker);
        assert.doesNotMatch(one.output() + two.output(), /deadlock|ERROR/, `${label}: ${one.output()} | ${two.output()}`);
        pairs.push(label);
        return two.output();
      } finally { await Promise.all([one.end(), two.end()]); }
    };
    // Each pair on a fresh mitten: Cuff on round 25, rows 21–24 ticked and finished in a sitting (rip-back has something to take).
    const fresh = () => {
      const m = seedMitten(a.id, { castOnDone: true, cuffDone: 24, active: "cuff" });
      const sid = psql(`SELECT (work_session_create('${a.id}', jsonb_build_object('project_id','${m.projectId}','session_date','2026-11-11','minutes',20), ARRAY['${m.items["cuff:23"]}','${m.items["cuff:24"]}']::uuid[], false))->>'session_id';`);
      return { m, sid };
    };
    const lower = (m) => `SELECT 'st:' || ((craft_set_total('${a.id}','${m.cuff}',27,31))->>'status')`;
    const frog = (m) => `SELECT 'fr:' || ((craft_frog('${a.id}','${m.cuff}',25,23,24,NULL,'{}','${randomUUID()}'))->>'status')`;
    let f = fresh();
    let out = await run(lower(f.m), frog(f.m), "fr:", "total-then-frog");
    assert.match(out, /fr:ok/);
    assert.equal(rowOf(f.m.items["cuff:29"]), "25");
    f = fresh();
    out = await run(frog(f.m), lower(f.m), "st:", "frog-then-total");
    assert.match(out, /st:ok/);
    f = fresh();
    out = await run(lower(f.m), `SELECT 'ws:' || ((work_session_create('${a.id}', jsonb_build_object('project_id','${f.m.projectId}','session_date','${today()}','minutes',5), ARRAY['${f.m.items["cuff:30"]}']::uuid[], false))->>'session_id')`, "ws:", "total-then-chat-create");
    assert.match(out, /ws:[0-9a-f-]{36}/);
    assert.equal(rowOf(f.m.items["cuff:30"]), "26", "the chat sitting links the renumbered row");
    f = fresh();
    // A chat edit that re-links the sitting's rows (session first, then the rows' tasks: 059's order).
    out = await run(`SELECT (work_session_update('${a.id}','${f.sid}','{"note":"chat edit"}'::jsonb, ARRAY['${f.m.items["cuff:22"]}','${f.m.items["cuff:23"]}','${f.m.items["cuff:24"]}']::uuid[]))->>'session_id'`, lower(f.m), "st:", "chat-edit-then-total");
    assert.match(out, /st:ok/);
    f = fresh();
    out = await run(lower(f.m), `SELECT 'rd:' || ((craft_rows('${a.id}','${f.m.cuff}',25,NULL,'done'))->>'status')`, "rd:", "total-then-rowdone");
    assert.match(out, /rd:ok/);
    f = fresh();
    out = await run(`SELECT (craft_rows('${a.id}','${f.m.cuff}',25,NULL,'done'))->>'status'`, lower(f.m), "st:", "rowdone-then-total");
    assert.match(out, /st:(ok|refused)/);
    assert.equal(pairs.length, 6);
  });
} finally {
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft S3 FR3 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
