#!/usr/bin/env node
// Craft S3 FR5 on a disposable LOCAL stack (CRAFT_TEST_*), the FR4 re-check findings in 074 and the routes: take_back
// only for rows a raise added (Mitten 2's set-up Rnd 29–31 survive at totals 27 and 24, by the route and by a direct
// call), R13's wrong-raise take-back still works, the refusal names the real blocker (round 25 ticked after a wrong
// raise), a raise with no `how` before a step is refused (the route, the S2 four-argument call), and "Mark all done"
// with 51 earlier steps. Fake data shaped like the mittens and the scarf only. Destructive only to this local stack.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.CRAFT_TEST_SUPABASE_URL, anon = process.env.CRAFT_TEST_ANON_KEY, key = process.env.CRAFT_TEST_SERVICE_ROLE_KEY, container = process.env.CRAFT_TEST_DB_CONTAINER;
if (!url || !anon || !key || container !== "supabase_db_mc-pace" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error("Set CRAFT_TEST_SUPABASE_URL, CRAFT_TEST_ANON_KEY, CRAFT_TEST_SERVICE_ROLE_KEY and CRAFT_TEST_DB_CONTAINER=supabase_db_mc-pace (disposable local stack only).");
  process.exit(2);
}
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
let passed = 0, failed = 0;
const only = process.env.CRAFT_FR5_ONLY ? new RegExp(process.env.CRAFT_FR5_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-fr5-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-fr5-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const rowRoute = await import("../src/app/api/craft/[projectId]/row/route.ts");
const totalRoute = await import("../src/app/api/craft/[projectId]/total/route.ts");
const checkRoute = await import("../src/app/api/craft/[projectId]/check/route.ts");
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
    // FR5: the items were made before the set-up made the parts (as live: set-up links items that already exist).
    sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row, created_at) VALUES ('${id}','${owner}','${task}',${lit(text)},${done},${done ? "'2026-11-10T23:00:00Z'" : "NULL"},${sort},${units ?? "NULL"},${type ? lit(type) : "NULL"},${partId ? `'${partId}'` : "NULL"},${row ?? "NULL"},'2026-11-01T00:00:00Z');\n`;
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
INSERT INTO task_checklist_items (user_id, task_id, text, is_done, completed_at, sort_order, unit_count, work_type, craft_part_id, craft_row, created_at)
  SELECT '${owner}','${task}','Row ' || r, r <= ${done}, CASE WHEN r <= ${done} THEN '2026-11-05T23:00:00Z'::timestamptz END, 2 * r, 40, 'garter', '${part}', r, '2026-11-01T00:00:00Z' FROM generate_series(1, ${n}) r;
UPDATE craft_projects SET active_part_id = '${part}' WHERE project_id = '${projectId}';\n`;
  for (const [after, text] of steps) { const id = randomUUID(); out.steps[text] = id;
    sql += `INSERT INTO task_checklist_items (id, user_id, task_id, text, is_done, sort_order) VALUES ('${id}','${owner}','${task}',${lit(text)},false,${2 * after + 1});\n`; }
  psql(sql);
  return out;
}

const knitIds = (m) => psql(`SELECT string_agg(id::text, ',' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${m.cuff}' AND text LIKE '%knit (US 7)%';`);
/** Mitten 2 on 11/12: the rib ticked to 24, (est.) 25–28 and the set-up knit 29–31 unticked; the screen on the Cuff. */
const mittenTwo = (owner) => seedMitten(owner, { castOnDone: true, cuffDone: 24, active: "cuff" });

let a;
try {
  a = await user();
  process.env.MISSION_CONTROL_USER_ID = a.id;

  await test("FR5 1 Mitten 2 at total 27: no take-back is offered by the view, a take_back call is refused not_raised (route and direct), and Rnd 29–31 · knit (US 7) survive; the usual lowering renumbers them to 25–27", async () => {
    const m = mittenTwo(a.id);
    const v = await getView(a, m.projectId);
    const rows = C.partRowsOf(v, m.cuff);
    assert.deepEqual(rows.filter((s) => s.raised), [], "every round came with the set-up");
    assert.equal(A.takeBackPlan(rows, 31, 27), null);
    const knit = knitIds(m), before = itemsHash(m);
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 31, how: "take_back" });
    assert.deepEqual([r.status, r.body.reason, r.body.result.rows, r.body.result.above], [409, "not_raised", [28, 29, 30, 31], [28, 29, 30, 31]]);
    assert.equal(r.body.error, "Can't take back rounds 28–31: rounds 28–31 weren't added by a raise or are (est.). Only rounds a raise added can be taken back; (est.) rounds go with the usual lowering.");
    const direct = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 27, p_expected_total: 31, p_how: "take_back" });
    assert.deepEqual([direct.error, direct.data?.status, direct.data?.reason], [null, "refused", "not_raised"]);
    assert.equal(itemsHash(m), before, "nothing changed");
    const usual = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 31 });
    assert.equal(usual.status, 200, JSON.stringify(usual.body).slice(0, 300));
    assert.equal(knitIds(m), knit, "the same three items");
    assert.equal(cuffText(m).split(" | ").slice(24).join(" | "), "25=Rnd 25 · knit (US 7)/stockinette/false | 26=Rnd 26 · knit (US 7)/stockinette/false | 27=Rnd 27 · knit (US 7)/stockinette/false");
  });

  await test("FR5 1 Mitten 2 at total 24: take_back refused not_raised (route and direct; Rnd 29–31 survive); the usual lowering's refusal says \"Can't remove rounds 22–24: they are ticked; drop only (est.) rounds 25–28 → total 27.\" and that total saves", async () => {
    const m = mittenTwo(a.id);
    const rows = C.partRowsOf(await getView(a, m.projectId), m.cuff);
    assert.equal(A.takeBackPlan(rows, 31, 24), null);
    assert.equal(A.lowerRefusal("round", rows, 31, 24).suggest, 27);
    const knit = knitIds(m), before = itemsHash(m);
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 31, how: "take_back" });
    assert.deepEqual([r.status, r.body.reason, r.body.result.rows], [409, "not_raised", [25, 26, 27, 28, 29, 30, 31]]);
    const direct = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 24, p_expected_total: 31, p_how: "take_back" });
    assert.deepEqual([direct.data?.status, direct.data?.reason], ["refused", "not_raised"]);
    const usual = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 31 });
    assert.deepEqual([usual.status, usual.body.reason, usual.body.error], [409, "ticked", "Can't remove rounds 22–24: they are ticked; drop only (est.) rounds 25–28 → total 27."]);
    assert.equal(itemsHash(m), before, "nothing changed");
    assert.equal(knitIds(m), knit);
    // A service-role caller (the API path) is held to the same rule.
    const svc = psql(`SELECT craft_set_total('${a.id}','${m.cuff}',24,31,NULL,NULL,'take_back')->>'reason';`);
    assert.equal(svc, "not_raised");
    const use = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 31 });
    assert.equal(use.status, 200);
    assert.equal(knitIds(m), knit, "Rnd 29–31 kept (now 25–27)");
  });

  await test("FR5 1 R13's wrong raise still takes back: Mitten 1 raised 24 → 27 by mistake (k1, p1 rib), the view marks 25–27 raised, take_back drops exactly them, then the right raise", async () => {
    const m = mittenOne(a.id);
    const before = itemsHash(m);
    const wrong = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "k1, p1 rib", work_type: "rib", how: "after_steps" });
    assert.equal(wrong.status, 200);
    const rows = C.partRowsOf(wrong.body.view, m.cuff);
    assert.deepEqual(rows.filter((s) => s.raised).map((s) => s.row), [25, 26, 27]);
    assert.equal(psql(`SELECT bool_and(i.created_at > p.created_at) FROM task_checklist_items i JOIN craft_parts p ON p.id = i.craft_part_id WHERE i.craft_part_id='${m.cuff}' AND i.craft_row > 24;`), "t");
    assert.deepEqual(A.takeBackPlan(rows, 27, 24), { kind: "remove", total: 24, remove: [25, 26, 27], moves: [] });
    const back = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27, how: "take_back" });
    assert.equal(back.status, 200, JSON.stringify(back.body).slice(0, 300));
    assert.deepEqual(back.body.result.dropped, [25, 26, 27]);
    assert.equal(itemsHash(m), before);
    const right = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(right.status, 200);
    assert.equal(right.body.view.next_rows[0].text, "Rnd 25 · knit (US 7)");
  });

  await test("FR5 2 after the wrong raise with Rnd 25 ticked: take_back is refused naming round 25; the usual lowering to 24 says the same (\"Can't take back rounds 25–27, added by a raise: round 25 is ticked.\"), never \"Undo\" rounds 22–24", async () => {
    const m = mittenOne(a.id);
    const wrong = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "k1, p1 rib", work_type: "rib", how: "after_steps" });
    assert.equal(wrong.status, 200);
    const row = await post(rowRoute, a, m.projectId, "row", { part_id: m.cuff, mode: "done", expected_row: 25 });
    assert.equal(row.status, 200);
    const before = itemsHash(m);
    const back = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27, how: "take_back" });
    assert.deepEqual([back.status, back.body.reason, back.body.result.rows, back.body.error], [409, "ticked", [25], "Can't take back rounds 25–27, added by a raise: round 25 is ticked."]);
    const usual = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 24, expected_total: 27 });
    assert.deepEqual([usual.status, usual.body.error], [409, "Can't take back rounds 25–27, added by a raise: round 25 is ticked."]);
    assert.doesNotMatch(usual.body.error, /22–24|Undo/);
    assert.equal(itemsHash(m), before);
  });

  await test("FR5 3 a raise with no `how` while an unticked step follows the last row is refused (where; the route says to pick before or after the step; the S2 four-argument call too); nothing changes; with how it saves; a ticked step or a band's Count item doesn't ask", async () => {
    const m = mittenOne(a.id);
    const before = itemsHash(m);
    const r = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette" });
    assert.deepEqual([r.status, r.body.reason, r.body.result.steps, r.body.result.after_row], [409, "where", [CHECK], 24]);
    assert.equal(r.body.error, `Not saved: the step “${CHECK}” comes after round 24. Say whether the new rounds go before or after the step.`);
    const s2 = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 27, p_expected_total: 24 });
    assert.deepEqual([s2.error, s2.data?.status, s2.data?.reason], [null, "refused", "where"]);
    const six = await a.client.rpc("craft_set_total", { p_user_id: a.id, p_part_id: m.cuff, p_total: 27, p_expected_total: 24, p_text: "knit (US 7)", p_work_type: "stockinette" });
    assert.equal(six.data?.reason, "where");
    assert.equal(itemsHash(m), before, "nothing guessed");
    assert.equal(psql(`SELECT total_rows FROM craft_parts WHERE id='${m.cuff}';`), "24");
    const ok = await post(totalRoute, a, m.projectId, "total", { part_id: m.cuff, total: 27, expected_total: 24, text: "knit (US 7)", work_type: "stockinette", how: "after_steps" });
    assert.equal(ok.status, 200);
    // The scarf: no step after Row 455 → no `how` needed (S2 as before); a ticked step → none; a band's Count item → none.
    const plain = seedScarf(a.id, { n: 455, done: 300 });
    assert.equal((await post(totalRoute, a, plain.projectId, "total", { part_id: plain.part, total: 457, expected_total: 455 })).status, 200);
    const ticked = seedScarf(a.id, { n: 455, done: 300, steps: [[455, "Bind off loosely"]] });
    psql(`UPDATE task_checklist_items SET is_done = true WHERE id = '${ticked.steps["Bind off loosely"]}';`);
    assert.equal((await post(totalRoute, a, ticked.projectId, "total", { part_id: ticked.part, total: 457, expected_total: 455 })).status, 200);
    const band = seedScarf(a.id, { n: 455, done: 300, steps: [[455, "Count the last row: 40 stitches"]] });
    psql(`UPDATE craft_segments SET close_check = true WHERE part_id = '${band.part}';`);
    assert.equal((await post(totalRoute, a, band.projectId, "total", { part_id: band.part, total: 457, expected_total: 455 })).status, 200);
    // A step after a later row of the task, not right after the last row of this part, doesn't count either.
    const bind = seedScarf(a.id, { n: 455, done: 300, steps: [[455, "Bind off loosely"]] });
    const where = await post(totalRoute, a, bind.projectId, "total", { part_id: bind.part, total: 457, expected_total: 455, text: "knit" });
    assert.deepEqual([where.status, where.body.error], [409, "Not saved: the step “Bind off loosely” comes after row 455. Say whether the new rows go before or after the step."]);
  });

  await test("FR5 4 \"Mark all done\" with 51 earlier steps: one call ticks all 51 (200); 501 ids is 400 at the route and 22023 in craft_check", async () => {
    const s = seedScarf(a.id, { n: 455, done: 300, steps: Array.from({ length: 51 }, (_, i) => [i + 1, `Step ${i + 1}`]) });
    let v = await getView(a, s.projectId);
    assert.equal(v.earlier_checks.length, 51);
    const all = await post(checkRoute, a, s.projectId, "check", { item_ids: v.earlier_checks.map((c) => c.id) });
    assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 300));
    assert.equal(all.body.result.ticked.length, 51);
    assert.deepEqual(all.body.view.earlier_checks, []);
    const many = Array.from({ length: 501 }, () => randomUUID());
    assert.equal((await post(checkRoute, a, s.projectId, "check", { item_ids: many })).status, 400);
    const direct = await a.client.rpc("craft_check", { p_user_id: a.id, p_project_id: s.projectId, p_item_ids: many });
    assert.equal(direct.error?.code, "22023");
  });
} finally {
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) { const { error } = await admin.auth.admin.deleteUser(id); if (error) { failed++; console.error("cleanup failed", error.message); } }
}
console.log(`\nCraft S3 FR5 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
