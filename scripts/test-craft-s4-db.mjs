#!/usr/bin/env node
// Craft S4 on a disposable LOCAL stack (CRAFT_TEST_*), migration 075 and the routes: projects set up the old way
// (074) are byte for byte the same after 075; the TS and SQL plans agree on the One Row Scarf and Sophie Hood shapes;
// Create fills stitch counts (never over one already there, refused when a task doesn't add up); the heal on row
// deletes (a part with history is kept, hidden); the delete guard; inserted rows and edited rows keep their links;
// Reset in one transaction with sittings, notes, rip-backs, instructions, the timer, links and yarn re-pointed (by
// item, then by task + row number), the preview's can't-carry list, its refusals and lock order; 075's rollback.
// Fake data only (shapes from the plan); destructive only to this local stack.
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
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const up075 = readFileSync(new URL("../supabase/migrations/075_craft_reset.sql", import.meta.url), "utf8");
const down075 = readFileSync(new URL("../supabase/rollbacks/075_craft_reset.down.sql", import.meta.url), "utf8");
const has075 = () => psql("SELECT to_regprocedure('craft_reset_project(uuid,uuid,jsonb,text)') IS NOT NULL;") === "t";
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
const only = process.env.CRAFT_S4_ONLY ? new RegExp(process.env.CRAFT_S4_ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); }
  // A test that took 075 off puts it back before the next one, pass or fail.
  if (!has075()) { psql(up075); await waitForRpc(true); }
}
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-s4-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-s4-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const setupRoute = await import("../src/app/api/craft/setup/[projectId]/route.ts");
const resetRoute = await import("../src/app/api/craft/[projectId]/reset/route.ts");
const detailRoute = await import("../src/app/api/craft/[projectId]/route.ts");
const rowRoute = await import("../src/app/api/craft/[projectId]/row/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const checklistRoute = await import("../src/app/api/tasks/[id]/checklist/route.ts");
const { loadSetupSnapshot } = await import("../src/lib/craft/setup-service.ts");
const { planCraftSetup, craftSetupPayload } = await import("../src/lib/craft/setup.ts");
const { craftSetupFingerprint, craftSetupFingerprintText } = await import("../src/lib/craft/setup-fingerprint.ts");
const { oneRowScarf, sophieHood, insertSql } = await import("./fixtures/craft/s4-fixtures.mjs");

const lit = (t) => `$lit$${t}$lit$`;
const req = (who, method, path, body) => {
  const r = new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  return r;
};
const ctx = (projectId) => ({ params: Promise.resolve({ projectId }) });
const call = async (handler, who, method, path, params, body) => { const res = await handler(req(who, method, path, body), { params: Promise.resolve(params) }); return { status: res.status, body: await res.json() }; };
const getView = async (who, projectId) => (await detailRoute.GET(req(who, "GET", `/api/craft/${projectId}`), ctx(projectId))).json();
const setupPreview = (who, projectId) => call(setupRoute.GET, who, "GET", `/api/craft/setup/${projectId}`, { projectId });
const resetPreview = (who, projectId) => call(resetRoute.GET, who, "GET", `/api/craft/${projectId}/reset`, { projectId });
async function create(who, projectId, names) {
  const preview = await setupPreview(who, projectId);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return call(setupRoute.POST, who, "POST", `/api/craft/setup/${projectId}`, { projectId },
    { fingerprint: preview.body.fingerprint, craft: "knit", names: names ?? preview.body.plan.parts.map((p) => p.name) });
}
async function doReset(who, projectId, names) {
  const preview = await resetPreview(who, projectId);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const res = await call(resetRoute.POST, who, "POST", `/api/craft/${projectId}/reset`, { projectId }, { fingerprint: preview.body.fingerprint, names: names ?? preview.body.plan.parts.map((p) => p.name) });
  return { preview: preview.body, ...res };
}
const seed = (who, desc) => { const made = insertSql(desc, who.id, randomUUID); psql(made.sql); return made; };
const itemId = (taskId, text) => psql(`SELECT id FROM task_checklist_items WHERE task_id='${taskId}' AND text = ${lit(text)};`);
const itemLike = (taskId, prefix) => psql(`SELECT id FROM task_checklist_items WHERE task_id='${taskId}' AND starts_with(text, ${lit(prefix)}) ORDER BY sort_order LIMIT 1;`);
/** Everything a set-up craft project is: craft rows, row links, ticks, units, sittings and their links. */
const projectState = (projectId) => psql(`SELECT md5(concat_ws('|',
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.project_id), '') FROM craft_projects x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg((to_jsonb(x) - 'row_numbering')::text, ',' ORDER BY x.id), '') FROM craft_parts x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(s)::text, ',' ORDER BY s.id), '') FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE p.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(d)::text, ',' ORDER BY d.session_id), '') FROM craft_sitting_details d JOIN work_sessions w ON w.id = d.session_id WHERE w.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_notes x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(f)::text, ',' ORDER BY f.id), '') FROM craft_frogs f JOIN craft_parts p ON p.id = f.part_id WHERE p.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.user_id), '') FROM craft_timers x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(w)::text, ',' ORDER BY w.id), '') FROM work_sessions w WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(l)::text, ',' ORDER BY l.session_id, l.checklist_item_id), '') FROM work_session_items l JOIN work_sessions w ON w.id = l.session_id WHERE w.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(i)::text, ',' ORDER BY i.id), '') FROM task_checklist_items i JOIN tasks t ON t.id = i.task_id WHERE t.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id), '') FROM tasks t WHERE project_id='${projectId}')));`);
/** Ticks, units and sitting links of the items only (what Reset must never touch). */
const itemFacts = (projectId) => psql(`SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', i.id, i.is_done, i.completed_at, i.unit_count, i.work_type, i.text), ',' ORDER BY i.id), '')) FROM task_checklist_items i JOIN tasks t ON t.id = i.task_id WHERE t.project_id='${projectId}';
SELECT md5(coalesce(string_agg(to_jsonb(l)::text, ',' ORDER BY l.session_id, l.checklist_item_id), '')) FROM work_session_items l JOIN work_sessions w ON w.id = l.session_id WHERE w.project_id='${projectId}';
SELECT md5(coalesce(string_agg(to_jsonb(w)::text, ',' ORDER BY w.id), '')) FROM work_sessions w WHERE w.project_id='${projectId}';`);
async function waitForRpc(present) {
  for (let i = 0; i < 80; i++) {
    const { error } = await admin.rpc("craft_reset_blockers", { p_user_id: randomUUID(), p_project_id: randomUUID() });
    if (present ? !error : error?.code === "PGRST202") return;
    psql("NOTIFY pgrst, 'reload schema';");
    await sleep(250);
  }
  throw new Error(`PostgREST never saw 075 ${present ? "applied" : "removed"}`);
}

/** A mitten in one section, the way the live mittens are listed: Cuff (cast-on + Rnd 1–31), gusset 1–17, hand 18–45, top 1–8, thumb 1–15. */
const rnds = (from, to, text = "knit") => Array.from({ length: to - from + 1 }, (_, i) => `Rnd ${from + i} · ${text}`);
const mitten = () => ({
  project: { name: "Fake Mitten", tags: ["knitting"] },
  sections: [{ key: "m", name: "1. Mitten 1" }, { key: "fin", name: "2. Finishing" }],
  tasks: [
    { key: "cuff", section: "m", title: "Mitten 1 · Cuff: cast on + rnds 1–31", unit_count: null, work_type: "rib", created: 0, items: ["Cast on 36 (long-tail), join", ...rnds(1, 31, "k1, p1 rib"), "Check: cuff 4 in"] },
    { key: "gusset", section: "m", title: "Mitten 1 · Thumb gusset: rnds 1–17", unit_count: null, work_type: null, created: 1, items: rnds(1, 17, "gusset") },
    { key: "hand", section: "m", title: "Mitten 1 · Hand: rnds 18–45 (to 4 in)", unit_count: null, work_type: null, created: 2, items: rnds(18, 45) },
    { key: "top", section: "m", title: "Mitten 1 · Top decreases: rnds 1–8", unit_count: null, work_type: null, created: 3, items: rnds(1, 8, "dec") },
    { key: "thumb", section: "m", title: "Mitten 1 · Thumb: pick-up + rnds 1–15", unit_count: null, work_type: null, created: 4, items: ["Pick up 14 sts", ...rnds(1, 15)] },
    { key: "fin", section: "fin", title: "Finishing", unit_count: null, work_type: null, created: 5, items: ["Weave in ends"] },
  ],
});
/** 074 Set up from SQL (run while 075 is off): 073's plan and v1 fingerprint, named like the live parts. */
function setUpOldWay(owner, projectId, names) {
  const out = psql(`SELECT craft_setup_project('${owner}','${projectId}', (SELECT jsonb_build_object('craft','knit','active_part_index', pl->'active_part_index',
    'parts', (SELECT jsonb_agg(x.value || jsonb_build_object('name', (ARRAY[${names.map(lit).join(",")}]::text[])[x.ordinality], 'sort_order', x.ordinality - 1) ORDER BY x.ordinality)
      FROM jsonb_array_elements(pl->'parts') WITH ORDINALITY x)) FROM (SELECT craft_setup_plan('${owner}','${projectId}') AS pl) z), craft_setup_fingerprint('${owner}','${projectId}'))->>'parts';`);
  return Number(out);
}

let a, b;
try {
  a = await user(); b = await user();
  assert.ok(has075(), "the stack has 075 (bash scripts/test-stack/up.sh applies every migration)");

  // ── MUST HOLD: projects set up the old way are unchanged by 075 ──────────
  let old = {};
  await test("075 leaves projects set up the old way untouched: mittens (4 parts, sittings, notes, rip-back, timer), a blanket (quarters, band checks), a garter scarf (ridges) hash the same before and after; they keep working", async () => {
    psql(down075); await waitForRpc(false);
    const m = seed(a, mitten());
    assert.equal(setUpOldWay(a.id, m.projectId, ["Mitten 1 · Cuff", "Mitten 1 · Hand", "Mitten 1 · Top decreases", "Mitten 1 · Thumb"]), 4);
    const parts = Object.fromEntries(psql(`SELECT name || '=' || id FROM craft_parts WHERE project_id='${m.projectId}';`).split("\n").map((l) => l.split("=")).map(([n, id]) => [n.split(" · ")[1].split(" ")[0], id]));
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id = '${parts.Cuff}' AND craft_row <= 20;`);
    const session = psql(`SELECT (work_session_create('${a.id}', jsonb_build_object('project_id','${m.projectId}','session_date','2026-11-10','minutes',40),
      ARRAY(SELECT id FROM task_checklist_items WHERE craft_part_id='${parts.Cuff}' AND craft_row BETWEEN 15 AND 20), false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row, in_progress_row) VALUES ('${session}','${a.id}','${parts.Cuff}',14,20,NULL);
INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${a.id}','${m.projectId}','${parts.Hand}',20,'Gusset done, hand from here'), ('${a.id}','${m.projectId}','${parts.Cuff}',99,'a row that is not there');
INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, note) VALUES ('${a.id}','${parts.Cuff}',18,19,'twisted rib'), ('${a.id}','${parts.Top}',7,12,'past the end');
INSERT INTO craft_instructions (user_id, part_id, kind, from_row, to_row, text) VALUES ('${a.id}','${parts.Top}','instruction',2,3,'k2tog at each marker');
INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, start_row) VALUES ('${a.id}','${m.projectId}','${parts.Thumb}', now() - interval '10 minutes', 3);
INSERT INTO craft_links (user_id, project_id, part_id, kind, title, url) VALUES ('${a.id}','${m.projectId}','${parts.Hand}','web','Thumb video','https://example.test/v');
INSERT INTO craft_yarns (user_id, project_id, part_id, name) VALUES ('${a.id}','${m.projectId}','${parts.Cuff}','Fake wool');`);
    const blanketDesc = { project: { name: "Fake Blanket", tags: ["crochet"] }, sections: [{ key: "s", name: "1. Body" }], tasks: [
      { key: "b1", section: "s", title: "Band 1", unit_count: null, work_type: null, created: 0, items: Array.from({ length: 5 }, (_, i) => `Row ${i + 1}: sc across`) },
      { key: "b2", section: "s", title: "Band 2", unit_count: null, work_type: null, created: 1, items: [...Array.from({ length: 5 }, (_, i) => `Row ${i + 6}: sc across`), "Count 195"] }] };
    const bl = seed(a, blanketDesc);
    setUpOldWay(a.id, bl.projectId, ["Blanket"]);
    psql(`UPDATE craft_parts SET quarters = true WHERE project_id='${bl.projectId}'; UPDATE craft_segments SET close_check = true WHERE part_id IN (SELECT id FROM craft_parts WHERE project_id='${bl.projectId}');`);
    const gs = seed(a, { project: { name: "Fake Garter Scarf", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Scarf" }], tasks: [
      { key: "r", section: "s", title: "Rows 1–40", unit_count: null, work_type: null, created: 0, items: Array.from({ length: 40 }, (_, i) => `Row ${i + 1} · knit`) }] });
    setUpOldWay(a.id, gs.projectId, ["Body"]);
    psql(`UPDATE craft_parts SET ridges = true WHERE project_id='${gs.projectId}'; UPDATE task_checklist_items SET is_done = true WHERE craft_part_id IN (SELECT id FROM craft_parts WHERE project_id='${gs.projectId}') AND craft_row <= 12;`);
    const before = [m, bl, gs].map((p) => projectState(p.projectId));
    psql(up075); await waitForRpc(true);
    assert.deepEqual([m, bl, gs].map((p) => projectState(p.projectId)), before, "every craft row, link, tick, unit and sitting is as 074 left it (075's one new column aside)");
    // FR2: 075 records how each old part is numbered, from its rows: every S1C-made part reads its labels as row numbers.
    assert.equal(psql(`SELECT string_agg(DISTINCT row_numbering, ',') FROM craft_parts WHERE project_id IN ('${m.projectId}','${bl.projectId}','${gs.projectId}');`), "label");
    // And they keep working under 075: Row done on the cuff, the screens read them.
    const view = await getView(a, m.projectId);
    assert.deepEqual([view.parts.map((p) => p.name), view.active_part.name, view.active_part.current_row, view.hidden_parts], [["Mitten 1 · Cuff", "Mitten 1 · Hand", "Mitten 1 · Top decreases", "Mitten 1 · Thumb"], "Mitten 1 · Cuff", 21, 0]);
    const done = await call(rowRoute.POST, a, "POST", `/api/craft/${m.projectId}/row`, { projectId: m.projectId }, { part_id: parts.Cuff, expected_row: 21, mode: "done" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.view.active_part.current_row, 22);
    psql(`UPDATE task_checklist_items SET is_done = false, completed_at = NULL WHERE craft_part_id = '${parts.Cuff}' AND craft_row = 21;`);
    old = { m, parts, session, bl, gs };
  });

  // ── TS / SQL parity, Create with stitch counts ─────────────────────────
  let scarf, sophie;
  await test("Parity: the TS plan and 075's SQL plan agree (parts, rows, segments, active part) and the v2 fingerprints match on real rows: scarf, Sophie Hood, the mitten", async () => {
    scarf = seed(a, oneRowScarf()); sophie = seed(a, sophieHood());
    const plain = seed(a, mitten());
    for (const p of [scarf, sophie, plain]) {
      const snap = await loadSetupSnapshot(a.client, a.id, p.projectId), plan = planCraftSetup(snap);
      assert.ok(plan.ok, plan.stops.join("; "));
      const sql = JSON.parse(psql(`SELECT craft_setup_plan('${a.id}','${p.projectId}');`));
      assert.deepEqual(sql.stops, []);
      assert.equal(sql.active_part_index, plan.active_part_index);
      assert.deepEqual(sql.parts.map(({ stitch_count: _s, ...rest }) => rest), plan.parts.map((x) => ({ row_word: x.row_word, total_rows: x.total_rows,
        segments: x.segments.map(({ task_id, from_row, to_row }) => ({ task_id, from_row, to_row })), rows: x.rows.map(({ item_id, row }) => ({ item_id, row })) })));
      assert.equal(psql(`SELECT craft_setup_fingerprint('${a.id}','${p.projectId}');`), craftSetupFingerprint(snap), craftSetupFingerprintText(snap).slice(0, 60));
    }
  });
  await test("Create the scarf (route): 1 part “Scarf”, 385 rows, opening on Cast on 30; every row and the cast-on get 30 (cast-on typed); checks none; task sums hold; stitch count 30", async () => {
    const res = await create(a, scarf.projectId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.parts, res.body.rows_linked, res.body.units_filled], [1, 385, 386]);
    assert.equal(psql(`SELECT name || '|' || total_rows || '|' || stitch_count || '|' || row_numbering FROM craft_parts WHERE project_id='${scarf.projectId}';`), "Scarf|385|30|label");
    assert.equal(psql(`SELECT unit_count || '|' || work_type FROM task_checklist_items WHERE task_id='${scarf.taskIds.r1}' AND text='Cast on 30';`), "30|cast-on");
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.project_id='${scarf.projectId}' AND i.text LIKE 'Check:%' AND i.unit_count IS NOT NULL;`), "0");
    assert.equal(psql(`SELECT count(*) FROM tasks t WHERE t.project_id='${scarf.projectId}' AND t.unit_count IS NOT NULL AND t.unit_count <> (SELECT sum(unit_count) FROM task_checklist_items WHERE task_id=t.id);`), "0");
    const view = await getView(a, scarf.projectId);
    assert.deepEqual([view.active_part.name, view.active_part.current_row, view.due_checks.map((c) => c.text)], ["Scarf", 1, ["Cast on 30"]]);
  });
  await test("Create Sophie Hood (route): 3 parts 318 / 135 / 317 counted straight through; per-row counts follow the needle (holder rows the count after); a task that doesn't add up keeps no counts", async () => {
    const desc = sophieHood(); desc.tasks.find((t) => t.key === "left").unit_count = 1300;
    const s2 = seed(a, desc);
    const res = await create(a, s2.projectId);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(psql(`SELECT string_agg(name || ':' || total_rows || ':' || row_numbering, ',' ORDER BY sort_order) FROM craft_parts WHERE project_id='${s2.projectId}';`), "Scarf 1 (increases):318:straight,Hood:135:straight,Scarf 2 (decreases):317:straight");
    assert.equal(psql(`SELECT craft_row FROM task_checklist_items WHERE task_id='${s2.taskIds.inc}' AND starts_with(text, 'Row 1 (rep 2)');`), "15", "6 tip rows, rep 1's 8, then rep 2's Row 1");
    assert.equal(psql(`SELECT string_agg(coalesce(unit_count::text, '-'), ',' ORDER BY sort_order) FROM task_checklist_items WHERE task_id='${s2.taskIds.inc}' AND sort_order < 10;`), "6,7,7,7,7,7,7,7,7,8");
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items WHERE task_id='${s2.taskIds.left}' AND unit_count IS NOT NULL;`), "0", "the mismatched task is left alone");
    assert.equal(psql(`SELECT unit_count FROM task_checklist_items WHERE task_id='${s2.taskIds.right}' AND sort_order = 0;`), "42");
    assert.equal(psql(`SELECT string_agg(unit_count::text, ',' ORDER BY sort_order) FROM task_checklist_items WHERE task_id='${s2.taskIds.rejoin}' AND sort_order < 2;`), "42,45");
    assert.equal(res.body.units_filled, 318 + 1 + 135 - 33 + 317);
  });
  await test("075's stitch-count rules hold on their own: a count already there, a check, another project's row or a wrong sum is refused (22023) and nothing is written", async () => {
    const p = seed(a, oneRowScarf());
    const snap = await loadSetupSnapshot(a.client, a.id, p.projectId), plan = planCraftSetup(snap), fp = craftSetupFingerprint(snap);
    const payload = craftSetupPayload(plan, "knit", ["Scarf"]);
    const row1 = itemLike(p.taskIds.r1, "Row 1 ·"), check = itemLike(p.taskIds.r1, "Check:");
    const tries = [
      (x) => { x.units.push({ item_id: check, unit_count: 30, work_type: null }); },
      (x) => { x.units.find((u) => u.item_id === row1).unit_count = 31; },
      (x) => { x.units.push({ item_id: itemLike(scarf.taskIds.r1, "Row 1 ·"), unit_count: 30, work_type: null }); },
      (x) => { x.units.push({ ...x.units[0] }); },
      (x) => { x.units[0].unit_count = 0; },
    ];
    for (const [k, tamper] of tries.entries()) {
      const bad = structuredClone(payload); tamper(bad);
      const r = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: p.projectId, p_plan: bad, p_fingerprint: fp });
      assert.equal(r.error?.code, "22023", `try ${k}: ${JSON.stringify(r.error)}`);
    }
    psql(`UPDATE task_checklist_items SET unit_count = 30 WHERE id = '${row1}';`);
    const snap2 = await loadSetupSnapshot(a.client, a.id, p.projectId), plan2 = planCraftSetup(snap2);
    const stale = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: p.projectId, p_plan: payload, p_fingerprint: craftSetupFingerprint(snap2) });
    assert.equal(stale.error?.code, "22023", "a count already on a row is never written over, even when the caller asks");
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.project_id='${p.projectId}' AND i.unit_count IS NOT NULL;`), "1", "nothing was written");
    assert.equal(psql(`SELECT count(*) FROM craft_projects WHERE project_id='${p.projectId}';`), "0");
    assert.ok(!plan2.stitch_fills.some((f) => f.item_id === row1));
    const ok = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: p.projectId, p_plan: craftSetupPayload(plan2, "knit", ["Scarf"]), p_fingerprint: craftSetupFingerprint(snap2) });
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.data.units_filled, 385);
  });

  // ── A: the heal and the delete guard ───────────────────────────────────
  await test("Heal: deleting every row of a part with no history removes it, and the craft project with it (Set up is offered again); a part with a sitting stays, hidden", async () => {
    const small = { project: { name: "Fake Hat", tags: ["knitting"] }, sections: [{ key: "a", name: "1. Brim" }, { key: "b", name: "2. Crown" }], tasks: [
      { key: "brim", section: "a", title: "Brim", unit_count: null, work_type: null, created: 0, items: ["Row 1 · k", "Row 2 · k"] },
      { key: "crown", section: "b", title: "Crown", unit_count: null, work_type: null, created: 1, items: ["Rnd 1 · k", "Rnd 2 · k"] }] };
    const h = seed(a, small);
    assert.equal((await create(a, h.projectId)).status, 201);
    const brimPart = psql(`SELECT id FROM craft_parts WHERE project_id='${h.projectId}' AND name='Brim';`);
    const del = await call(checklistRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.brim}/checklist?itemId=${itemLike(h.taskIds.brim, "Row 1")}`, { id: h.taskIds.brim });
    assert.equal(del.status, 200);
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE id='${brimPart}';`), "1", "one row left: the part stays");
    await call(checklistRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.brim}/checklist?itemId=${itemLike(h.taskIds.brim, "Row 2")}`, { id: h.taskIds.brim });
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE id='${brimPart}';`), "0", "no rows and no history: the part goes");
    // The crown's task deleted (no ticks, no sittings: no force needed): its rows go with it and so does the last part.
    const gone = await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.crown}`, { id: h.taskIds.crown });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE project_id='${h.projectId}'; SELECT count(*) FROM craft_projects WHERE project_id='${h.projectId}';`), "0\n0");
    // With a sitting on it the part stays, hidden as empty (pick 3).
    const k = seed(a, small);
    assert.equal((await create(a, k.projectId)).status, 201);
    const brim = psql(`SELECT id FROM craft_parts WHERE project_id='${k.projectId}' AND name='Brim';`);
    const s = psql(`SELECT (work_session_create('${a.id}', jsonb_build_object('project_id','${k.projectId}','session_date','2026-11-11','minutes',15), ARRAY[]::uuid[], false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row) VALUES ('${s}','${a.id}','${brim}',0,2);`);
    psql(`DELETE FROM task_checklist_items WHERE task_id='${k.taskIds.brim}';`);
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE id='${brim}';`), "1");
    const view = await getView(a, k.projectId);
    assert.deepEqual([view.parts.map((p) => p.name), view.hidden_parts, view.active_part.name], [["Crown"], 1, "Crown"]);
  });
  await test("Heal never waits: a delete while another session holds the craft project is refused busy (409) and nothing is deleted", async () => {
    const h = seed(a, { project: { name: "Fake Busy", tags: [] }, sections: [{ key: "a", name: "1. Body" }], tasks: [{ key: "t", section: "a", title: "T", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2"] }] });
    assert.equal((await create(a, h.projectId)).status, 201);
    const hold = connection("hold");
    try {
      hold.send(`BEGIN; SELECT 1 FROM craft_projects WHERE project_id='${h.projectId}' FOR UPDATE; SELECT 'held';`);
      await hold.wait("held");
      const r = await call(checklistRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.t}/checklist?itemId=${itemLike(h.taskIds.t, "Row 1")}`, { id: h.taskIds.t });
      assert.deepEqual([r.status, r.body.reason], [409, "busy"]);
      assert.equal(psql(`SELECT count(*) FROM task_checklist_items WHERE task_id='${h.taskIds.t}';`), "2");
      hold.send("COMMIT; SELECT 'done';"); await hold.wait("done");
    } finally { await hold.end(); }
  });
  await test("Delete guard: a task with ticked craft rows or sittings is refused (409, counts), force deletes it; MCP's force reaches delete_task_checked", async () => {
    const h = seed(a, { project: { name: "Fake Guard", tags: [] }, sections: [{ key: "a", name: "1. Body" }], tasks: [
      { key: "t", section: "a", title: "T", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 3"] },
      { key: "u", section: "a", title: "Plain", unit_count: null, work_type: null, created: 1, items: ["Wash"] }] });
    assert.equal((await create(a, h.projectId)).status, 201);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE task_id='${h.taskIds.t}' AND text IN ('Row 1','Row 2');`);
    const refused = await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.t}`, { id: h.taskIds.t });
    assert.deepEqual([refused.status, refused.body.reason, refused.body.ticked_craft_rows, refused.body.sittings], [409, "craft_history", 2, 0]);
    psql(`SELECT work_session_create('${a.id}', jsonb_build_object('project_id','${h.projectId}','task_id','${h.taskIds.u}','session_date','2026-11-11','minutes',5), ARRAY[]::uuid[], false);`);
    const sat = await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.u}`, { id: h.taskIds.u });
    assert.deepEqual([sat.status, sat.body.sittings], [409, 1]);
    const forced = await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${h.taskIds.t}?force=true`, { id: h.taskIds.t });
    assert.equal(forced.status, 200);
    assert.equal(psql(`SELECT count(*) FROM tasks WHERE id='${h.taskIds.t}';`), "0");
    const other = await call(taskRoute.DELETE, b, "DELETE", `/api/tasks/${h.taskIds.u}?force=true`, { id: h.taskIds.u });
    assert.equal(other.status, 404, "another user's task is not found");
    const direct = await b.client.rpc("delete_task_checked", { p_user_id: a.id, p_task_id: h.taskIds.u, p_force: true });
    assert.equal(direct.error?.code, "42501");
  });
  await test("E: rows inserted after a craft row move the rest down and keep every link; a text edit keeps the row's craft link", async () => {
    const t = scarf.taskIds.r1;
    const row28 = itemLike(t, "Row 28 ·"), row29 = itemLike(t, "Row 29 ·");
    const linkOf = (id) => psql(`SELECT craft_part_id || ':' || craft_row || ':' || sort_order FROM task_checklist_items WHERE id='${id}';`);
    const [, row29row, row29sort] = linkOf(row29).split(":");
    const added = await call(checklistRoute.POST, a, "POST", `/api/tasks/${t}/checklist`, { id: t }, { items: [{ text: "Check: measure again", unit_count: null }], after_item_id: row28 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body[0].sort_order, Number(linkOf(row28).split(":")[2]) + 1);
    assert.deepEqual(linkOf(row29).split(":").slice(1), [row29row, String(Number(row29sort) + 1)], "Row 29 keeps craft row 29, one place down");
    const edited = await call(checklistRoute.PATCH, a, "PATCH", `/api/tasks/${t}/checklist`, { id: t }, { items: [{ id: row29, text: "Row 29 · (k2, k1tbl, p1) ×7, k2 → 30 (fixed)" }] });
    assert.equal(edited.status, 200);
    assert.equal(linkOf(row29).split(":")[1], row29row);
  });

  // ── B: Reset ───────────────────────────────────────────────────────────
  await test("Reset the old-way mitten (route): one part per section; ticks, units and sitting links untouched; sitting, notes, rip-back, instruction, timer, link and yarn re-pointed by item; what can't move is listed and handled", async () => {
    const { m, parts, session } = old;
    const facts = itemFacts(m.projectId);
    const timerVersion = Number(psql(`SELECT version FROM craft_timers WHERE user_id='${a.id}';`));
    const { preview, status, body } = await doReset(a, m.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.plan.parts.map((p) => [p.name, p.total_rows, p.numbering]), [["Mitten 1", 99, "straight"]]);
    assert.deepEqual(preview.old_parts.map((p) => p.name), ["Mitten 1 · Cuff", "Mitten 1 · Hand", "Mitten 1 · Top decreases", "Mitten 1 · Thumb"]);
    assert.deepEqual(preview.carry.lost.map((l) => l.kind).sort(), ["frog", "note"]);
    assert.match(preview.carry_lines.join("\n"), /Moves with its rows: 1 sitting, 1 note, 1 rip-back, 1 instruction, 1 timer, 1 link and 1 yarn\./);
    assert.deepEqual([body.parts, body.old_parts, body.carried, body.lost], [1, 4, { sitting: 1, note: 1, frog: 1, instruction: 1, timer: 1, link: 1, yarn: 1 }, { note: 1, frog: 1 }]);
    const part = psql(`SELECT id FROM craft_parts WHERE project_id='${m.projectId}';`);
    assert.ok(!Object.values(parts).includes(part), "a new part");
    assert.equal(itemFacts(m.projectId), facts, "ticks, units, texts, sittings and their row links are as they were");
    assert.equal(psql(`SELECT part_id = '${part}' AND from_row = 14 AND to_row = 20 FROM craft_sitting_details WHERE session_id='${session}';`), "t");
    assert.equal(psql(`SELECT row FROM craft_notes WHERE project_id='${m.projectId}' AND text LIKE 'Gusset%' AND part_id='${part}';`), "51", "Hand round 20 is round 31 + 20");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || coalesce(row::text, 'none') FROM craft_notes WHERE text = 'a row that is not there';`), "none:none");
    assert.equal(psql(`SELECT from_row || '-' || to_row FROM craft_frogs WHERE part_id='${part}';`), "18-19");
    assert.equal(psql(`SELECT count(*) FROM craft_frogs WHERE note='past the end';`), "0", "a rip-back past the rows goes with the old part");
    assert.equal(psql(`SELECT from_row || '-' || to_row FROM craft_instructions WHERE part_id='${part}';`), "78-79");
    assert.equal(psql(`SELECT start_row || ':' || version || ':' || (part_id = '${part}') FROM craft_timers WHERE user_id='${a.id}';`), `87:${timerVersion + 1}:true`);
    assert.equal(psql(`SELECT (SELECT count(*) FROM craft_links WHERE part_id='${part}') || ':' || (SELECT count(*) FROM craft_yarns WHERE part_id='${part}');`), "1:1");
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE id IN (${Object.values(parts).map((id) => `'${id}'`).join(",")});`), "0");
    assert.equal(psql(`SELECT active_part_id FROM craft_projects WHERE project_id='${m.projectId}';`), part);
    const view = await getView(a, m.projectId);
    assert.deepEqual([view.active_part.name, view.active_part.current_row, view.active_part.done_rows], ["Mitten 1", 21, 20]);
  });
  await test("Reset re-points by task + row number when the row's item was deleted and made again in the same task", async () => {
    const m = seed(a, mitten());
    psql(down075); await waitForRpc(false);
    setUpOldWay(a.id, m.projectId, ["Mitten 1 · Cuff", "Mitten 1 · Hand", "Mitten 1 · Top decreases", "Mitten 1 · Thumb"]);
    psql(up075); await waitForRpc(true);
    const cuff = psql(`SELECT id FROM craft_parts WHERE project_id='${m.projectId}' AND name LIKE '%Cuff';`);
    psql(`INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${a.id}','${m.projectId}','${cuff}',30,'note on round 30');`);
    const sort = psql(`SELECT sort_order FROM task_checklist_items WHERE task_id='${m.taskIds.cuff}' AND starts_with(text, 'Rnd 30 ·');`);
    psql(`DELETE FROM task_checklist_items WHERE task_id='${m.taskIds.cuff}' AND starts_with(text, 'Rnd 30 ·');
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ('${a.id}','${m.taskIds.cuff}','Rnd 30 · k1, p1 rib (made again)',${sort});`);
    const { status, body, preview } = await doReset(a, m.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(preview.carry.lost.length, 0, JSON.stringify(preview.carry.lost));
    assert.equal(psql(`SELECT n.row || ':' || (n.part_id = i.craft_part_id) FROM craft_notes n, task_checklist_items i WHERE n.text='note on round 30' AND i.text='Rnd 30 · k1, p1 rib (made again)' AND i.task_id='${m.taskIds.cuff}';`), "30:true");
  });
  await test("The live scarf's break: the old part's tasks deleted and made again (force), the part kept hidden with its sittings; Set up refuses; Reset sets up “Scarf” and lists the sittings that can't be matched", async () => {
    const p = seed(a, { project: { name: "Fake One Row Scarf (old)", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Scarf" }], tasks: [
      { key: "o1", section: "s", title: "Old rows 1–50", unit_count: null, work_type: null, created: 0, items: Array.from({ length: 50 }, (_, i) => `Row ${i + 1}`) }] });
    psql(down075); await waitForRpc(false);
    setUpOldWay(a.id, p.projectId, ["Body"]);
    psql(up075); await waitForRpc(true);
    const bodyPart = psql(`SELECT id FROM craft_parts WHERE project_id='${p.projectId}';`);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE task_id='${p.taskIds.o1}' AND craft_row <= 10;`);
    const s = psql(`SELECT (work_session_create('${a.id}', jsonb_build_object('project_id','${p.projectId}','session_date','2026-11-09','minutes',30), ARRAY(SELECT id FROM task_checklist_items WHERE task_id='${p.taskIds.o1}' AND craft_row <= 10), false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row) VALUES ('${s}','${a.id}','${bodyPart}',0,10);`);
    const refused = await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${p.taskIds.o1}`, { id: p.taskIds.o1 });
    assert.deepEqual([refused.status, refused.body.ticked_craft_rows, refused.body.sittings], [409, 10, 1]);
    assert.equal((await call(taskRoute.DELETE, a, "DELETE", `/api/tasks/${p.taskIds.o1}?force=true`, { id: p.taskIds.o1 })).status, 200);
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE id='${bodyPart}';`), "1", "kept: it has a sitting");
    // The agent's rebuild: the four row tasks made again in the same section (201+ first, as live).
    const sectionId = psql(`SELECT id FROM project_sections WHERE project_id='${p.projectId}';`);
    psql(oneRowScarf().tasks.filter((t) => t.section === "scarf").flatMap((t) => {
      const id = randomUUID();
      return [`INSERT INTO tasks (id, user_id, project_id, section_id, title, status, unit_count, work_type, created_at) VALUES ('${id}','${a.id}','${p.projectId}','${sectionId}',${lit(t.title)},'Planned',${t.unit_count},${lit(t.work_type)},'2026-11-19T20:00:0${t.created}Z');`,
        `INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ${t.items.map((x, j) => `('${a.id}','${id}',${lit(x)},${j})`).join(",")};`];
    }).join("\n"));
    const setupStop = await setupPreview(a, p.projectId);
    assert.match(setupStop.body.plan.stops[0], /already on the craft screen\. Use Reset craft screen/);
    const view = await getView(a, p.projectId);
    assert.deepEqual([view.parts.length, view.hidden_parts], [0, 1]);
    const { preview, status, body } = await doReset(a, p.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.old_parts.map((x) => [x.name, x.row_count]), [["Body", 0]]);
    assert.match(preview.carry_lines[1], /^Can’t be matched to a row \(1 sitting\); each keeps its minutes and rows ticked, but no longer names a part on the craft screen: Nov 9 on Body, rows 1–10\.$/);
    assert.deepEqual([body.parts, body.rows_linked, body.lost], [1, 385, { sitting: 1 }]);
    assert.equal(psql(`SELECT name || '|' || total_rows FROM craft_parts WHERE project_id='${p.projectId}';`), "Scarf|385");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') FROM craft_sitting_details WHERE session_id='${s}'; SELECT minutes FROM work_sessions WHERE id='${s}';`), "none\n30", "the sitting stays, without a part");
  });
  await test("FR1 P2: on a part counted straight through, a deleted row is never matched by task + label (labels aren't its row numbers): the sitting, note, timer and rip-back on it are listed, not re-pointed", async () => {
    const c = await user();
    const p = seed(c, { project: { name: "Fake Straight Scarf", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Scarf" }], tasks: [
      { key: "tip", section: "s", title: "Tip", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 3", "Row 4"] },
      { key: "reps", section: "s", title: "Reps", unit_count: null, work_type: null, created: 1, items: ["Row 1", "Row 2", "Row 3", "Row 4", "Row 5", "Row 6"] }] });
    const made = await create(c, p.projectId);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const part = psql(`SELECT id || '|' || total_rows FROM craft_parts WHERE project_id='${p.projectId}';`).split("|");
    assert.equal(part[1], "10", "one part, 10 rows straight through");
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part[0]}' AND craft_row <= 6;`);
    const s = psql(`SELECT (work_session_create('${c.id}', jsonb_build_object('project_id','${p.projectId}','session_date','2026-11-12','minutes',20), ARRAY(SELECT id FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row BETWEEN 4 AND 6), false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row) VALUES ('${s}','${c.id}','${part[0]}',3,6);
INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${c.id}','${p.projectId}','${part[0]}',6,'note on screen row 6');
INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, note) VALUES ('${c.id}','${part[0]}',6,6,'ripped row 6');
INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, start_row) VALUES ('${c.id}','${p.projectId}','${part[0]}', now(), 6);`);
    // Screen row 6 is the Reps task's "Row 2"; the Reps task still has a "Row 6" (screen row 10).
    assert.equal(psql(`SELECT text FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 6 AND task_id='${p.taskIds.reps}';`), "Row 2");
    psql(`DELETE FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 6;`);
    const { preview, status, body } = await doReset(c, p.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.carry.lost.map((l) => l.kind).sort(), ["frog", "note", "sitting", "timer"], JSON.stringify(preview.carry.lost));
    assert.deepEqual(body.lost, { sitting: 1, note: 1, frog: 1, timer: 1 });
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') FROM craft_sitting_details WHERE session_id='${s}';`), "none");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || coalesce(row::text, 'none') FROM craft_notes WHERE text='note on screen row 6';`), "none:none");
    assert.equal(psql(`SELECT count(*) FROM craft_frogs WHERE note='ripped row 6';`), "0");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || start_row FROM craft_timers WHERE user_id='${c.id}';`), "none:6");
  });
  await test("FR2 P2 (Codex): on a straight part, survivors whose labels happen to equal their rows don't let a new, unrelated row stand in for the deleted one: everything on it is listed, not moved", async () => {
    const c = await user();
    const p = seed(c, { project: { name: "Fake Coincidence", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Scarf" }], tasks: [
      { key: "a", section: "s", title: "A", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 1 (repeat 2)", "Row 4"] },
      { key: "b", section: "s", title: "B", unit_count: null, work_type: null, created: 1, items: ["Row 1"] }] });
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id || '|' || total_rows FROM craft_parts WHERE project_id='${p.projectId}';`).split("|");
    assert.equal(part[1], "5");
    const numbering = psql(`SELECT to_jsonb(p) ->> 'row_numbering' FROM craft_parts p WHERE id='${part[0]}';`);
    assert.equal(psql(`SELECT text FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 3;`), "Row 1 (repeat 2)");
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part[0]}' AND craft_row <= 3;`);
    const s = psql(`SELECT (work_session_create('${c.id}', jsonb_build_object('project_id','${p.projectId}','session_date','2026-11-13','minutes',10), ARRAY(SELECT id FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 3), false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row) VALUES ('${s}','${c.id}','${part[0]}',2,3);
INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${c.id}','${p.projectId}','${part[0]}',3,'note on screen row 3');
INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, note) VALUES ('${c.id}','${part[0]}',3,3,'ripped screen row 3');
INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, start_row) VALUES ('${c.id}','${p.projectId}','${part[0]}', now(), 3);
DELETE FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 3;
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ('${c.id}','${p.taskIds.a}','Row 3 (new step)',4);`);
    const { preview, status, body } = await doReset(c, p.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.carry.lost.map((l) => l.kind).sort(), ["frog", "note", "sitting", "timer"], JSON.stringify(preview.carry.lost));
    assert.deepEqual(body.lost, { sitting: 1, note: 1, frog: 1, timer: 1 });
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || from_row || '-' || to_row FROM craft_sitting_details WHERE session_id='${s}';`), "none:2-3");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') FROM craft_notes WHERE text='note on screen row 3';`), "none");
    assert.equal(psql(`SELECT count(*) FROM craft_frogs WHERE note='ripped screen row 3';`), "0");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || start_row FROM craft_timers WHERE user_id='${c.id}';`), "none:3");
    assert.equal(numbering, "straight", "Create recorded the part as counted straight through");
  });
  await test("FR2: a part built by its labels (the S4 scarf) still re-points by task + row number when a row is deleted and made again", async () => {
    const c = await user();
    const p = seed(c, oneRowScarf());
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id || '|' || row_numbering FROM craft_parts WHERE project_id='${p.projectId}';`).split("|");
    assert.equal(part[1], "label");
    // FR3: a wording edit that keeps the label (through the checklist PATCH) keeps the part 'label'.
    const row6 = itemLike(p.taskIds.r1, "Row 6 ·");
    const edit = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.r1}/checklist`, { id: p.taskIds.r1 }, { items: [{ id: row6, text: "Row 6 · (k2, k1tbl, p1) ×7, knit 2 → 30" }] });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(psql(`SELECT row_numbering FROM craft_parts WHERE id='${part[0]}';`), "label");
    psql(`INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${c.id}','${p.projectId}','${part[0]}',150,'note on row 150');
INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, start_row) VALUES ('${c.id}','${p.projectId}','${part[0]}', now(), 150);`);
    const sort = psql(`SELECT sort_order FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 150;`);
    psql(`DELETE FROM task_checklist_items WHERE craft_part_id='${part[0]}' AND craft_row = 150;
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order, unit_count) VALUES ('${c.id}','${p.taskIds.r101}','Row 150 · (k2, k1tbl, p1) ×7, k2 → 30 (made again)',${sort},30);`);
    const { preview, status, body } = await doReset(c, p.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.carry.lost, []);
    assert.equal(psql(`SELECT n.row || ':' || (n.part_id = i.craft_part_id) FROM craft_notes n, task_checklist_items i WHERE n.text='note on row 150' AND starts_with(i.text, 'Row 150 ·') AND i.task_id='${p.taskIds.r101}';`), "150:true");
    assert.equal(psql(`SELECT start_row FROM craft_timers WHERE user_id='${c.id}';`), "150");
    assert.equal(psql(`SELECT t.part_id = p.id FROM craft_timers t, craft_parts p WHERE t.user_id='${c.id}' AND p.project_id='${p.projectId}';`), "t", "the timer follows to the new part");
    assert.equal(psql(`SELECT row_numbering FROM craft_parts WHERE project_id='${p.projectId}';`), "label", "Reset records the new part's numbering too");
  });
  const labelRepro = () => ({ project: { name: "Fake Edited Labels", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Scarf" }], tasks: [
    { key: "a", section: "s", title: "A", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 3", "Row 4"] },
    { key: "b", section: "s", title: "B", unit_count: null, work_type: null, created: 1, items: ["Row 5"] }] });
  async function editedLabelReset(c, p, part) {
    psql(`UPDATE task_checklist_items SET is_done = true WHERE craft_part_id='${part}' AND craft_row <= 3;`);
    const s = psql(`SELECT (work_session_create('${c.id}', jsonb_build_object('project_id','${p.projectId}','session_date','2026-11-14','minutes',10), ARRAY(SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = 3), false))->>'session_id';`);
    psql(`INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, to_row) VALUES ('${s}','${c.id}','${part}',2,3);
INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${c.id}','${p.projectId}','${part}',3,'note on edited row 3');
INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, note) VALUES ('${c.id}','${part}',3,3,'ripped edited row 3');
INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, start_row) VALUES ('${c.id}','${p.projectId}','${part}', now(), 3);
DELETE FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = 3;
INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ('${c.id}','${p.taskIds.a}','Row 3 (new step)',4);`);
    const { preview, status, body } = await doReset(c, p.projectId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(preview.carry.lost.map((l) => l.kind).sort(), ["frog", "note", "sitting", "timer"], JSON.stringify(preview.carry.lost));
    assert.deepEqual(body.lost, { sitting: 1, note: 1, frog: 1, timer: 1 });
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || coalesce(row::text, 'none') FROM craft_notes WHERE text='note on edited row 3';`), "none:none");
    assert.equal(psql(`SELECT coalesce(part_id::text, 'none') || ':' || from_row || '-' || to_row FROM craft_sitting_details WHERE session_id='${s}';`), "none:2-3");
  }
  await test("FR3 P2 (Codex, PATCH): text edits that make labels stop matching rows turn a 'label' part 'straight' for good; delete + append + Reset then lists the history, never moves it", async () => {
    const c = await user();
    const p = seed(c, labelRepro());
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id FROM craft_parts WHERE project_id='${p.projectId}';`);
    const label = () => psql(`SELECT to_jsonb(p) ->> 'row_numbering' FROM craft_parts p WHERE id='${part}';`);
    assert.equal(label(), "label");
    const r3 = psql(`SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = 3;`), r5 = psql(`SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = 5;`);
    for (const [task, id, text] of [[p.taskIds.a, r3, "Row 1 (repeat 2)"], [p.taskIds.b, r5, "Row 1"]]) {
      const r = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${task}/checklist`, { id: task }, { items: [{ id, text }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const flagAfterEdit = label();
    const r3back = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r3, text: "Row 3" }] });
    assert.equal(r3back.status, 200);
    const flagAfterBack = label();
    await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r3, text: "Row 1 (repeat 2)" }] });
    await editedLabelReset(c, p, part);
    assert.deepEqual([flagAfterEdit, flagAfterBack], ["straight", "straight"], "one-way: putting the label back doesn't make it 'label' again");
  });
  // MCP calls the REST API through fetch: send its checklist calls to the real route as the test's user. The MCP
  // route keeps the fetch it saw when it was first imported, so that one shim reads the caller at call time.
  let mcpCaller = null;
  async function withMcpAs(c, fn) {
    const realFetch = globalThis.fetch;
    mcpCaller = c;
    globalThis.fetch = async (input, init = {}) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      const m = u.pathname.match(/^\/api\/tasks\/([^/]+)\/checklist$/);
      if (!m || !mcpCaller) return realFetch(input, init);
      const who = mcpCaller;
      const r = new NextRequest(`http://localhost${u.pathname}${u.search}`, { method: init.method ?? "GET", ...(init.body ? { body: init.body, headers: { "content-type": "application/json" } } : {}) });
      writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
      return checklistRoute[(init.method ?? "GET").toUpperCase()](r, { params: Promise.resolve({ id: m[1] }) });
    };
    try {
      process.env.MISSION_CONTROL_USER_ID = c.id; process.env.DEPLOYMENT_ROLE = "main";
      const mcpRoute = await import("../src/app/api/mcp/route.ts");
      const rpc = async (body) => {
        const res = await mcpRoute.POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
          "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "mcp-session-id": "stateless", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(body) }));
        const text = await res.text();
        return JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
      };
      await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s4-db", version: "1" } } });
      return await fn(rpc);
    } finally { globalThis.fetch = realFetch; mcpCaller = null; }
  }
  await test("FR3 P2 (Codex, MCP update_task_checklist): the same edit through MCP turns the part 'straight' too", async () => {
    const c = await user();
    const p = seed(c, labelRepro());
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id FROM craft_parts WHERE project_id='${p.projectId}';`);
    const r3 = psql(`SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = 3;`);
    const out = await withMcpAs(c, (rpc) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_task_checklist", arguments: { task_id: p.taskIds.a, items: [{ id: r3, text: "Row 1 (repeat 2)" }] } } }));
    assert.notEqual(out.result?.isError, true, JSON.stringify(out));
    assert.equal(psql(`SELECT text || '|' || craft_row FROM task_checklist_items WHERE id='${r3}';`), "Row 1 (repeat 2)|3", "the edit landed and the row keeps its link");
    assert.equal(psql(`SELECT to_jsonb(p) ->> 'row_numbering' FROM craft_parts p WHERE id='${part}';`), "straight");
  });

  // ── FR4: the numbering flip under concurrent locks ───────────────────────
  // FU-A: a part held FOR UPDATE elsewhere makes the flip's NOWAIT fail (55P03): the checklist PATCH and MCP say
  // "busy" in plain words, never database text, and nothing is saved. FU-B: the flip takes FOR NO KEY UPDATE, so an
  // uncommitted insert of a row hung on the part (its foreign key's FOR KEY SHARE) no longer makes it fail.
  const RAW_DB_TEXT = /could not obtain|lock_not_available|55P03|NOWAIT|craft_parts|relation|row_numbering/i;
  async function labelPart() {
    const c = await user();
    const p = seed(c, labelRepro());
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id FROM craft_parts WHERE project_id='${p.projectId}';`);
    const row = (n) => psql(`SELECT id FROM task_checklist_items WHERE craft_part_id='${part}' AND craft_row = ${n};`);
    assert.equal(psql(`SELECT row_numbering FROM craft_parts WHERE id='${part}';`), "label");
    return { c, p, part, r1: row(1), r3: row(3) };
  }
  const facts = (part, id) => psql(`SELECT (SELECT text FROM task_checklist_items WHERE id='${id}') || '|' || row_numbering FROM craft_parts WHERE id='${part}';`);
  await test("FR4 FU-A (PATCH): a mismatching edit while another session holds the part FOR UPDATE is 409 busy in plain words, nothing saved, still 'label'; with two rows the busy one is listed busy (207)", async () => {
    const { c, p, part, r1, r3 } = await labelPart();
    const holder = connection("holder");
    try {
      holder.send(`BEGIN; SELECT 1 FROM craft_parts WHERE id='${part}' FOR UPDATE; SELECT 'part-held';`);
      await holder.wait("part-held");
      const one = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r3, text: "Row 1 (repeat 2)" }] });
      assert.deepEqual([one.status, one.body.reason], [409, "busy"], JSON.stringify(one.body));
      assert.match(one.body.error, /busy, try again in a moment/i);
      assert.doesNotMatch(JSON.stringify(one.body), RAW_DB_TEXT);
      assert.equal(facts(part, r3), "Row 3|label", "nothing saved");
      // Two rows: a wording edit that keeps its label saves; the mismatching one is the busy one.
      const two = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r1, text: "Row 1 · cast on" }, { id: r3, text: "Row 1 (repeat 2)" }] });
      assert.equal(two.status, 207, JSON.stringify(two.body));
      assert.deepEqual(two.body.updated.map((r) => r.id), [r1]);
      assert.deepEqual(two.body.failed.map((f) => [f.id, f.reason]), [[r3, "busy"]]);
      assert.match(two.body.failed[0].error, /busy, try again in a moment/i);
      assert.doesNotMatch(JSON.stringify(two.body), RAW_DB_TEXT);
      assert.equal(facts(part, r3), "Row 3|label");
      assert.equal(psql(`SELECT text FROM task_checklist_items WHERE id='${r1}';`), "Row 1 · cast on");
      holder.send("ROLLBACK; SELECT 'released';");
      await holder.wait("released");
      const after = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r3, text: "Row 1 (repeat 2)" }] });
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(facts(part, r3), "Row 1 (repeat 2)|straight", "once the lock is gone the same edit goes through");
    } finally { await holder.end(); }
  });
  await test("FR4 FU-A (MCP update_task_checklist): the same busy edit through MCP is an error reply saying busy, try again (no crash, no database text), nothing saved", async () => {
    const { c, p, part, r3 } = await labelPart();
    const holder = connection("holder-mcp");
    try {
      holder.send(`BEGIN; SELECT 1 FROM craft_parts WHERE id='${part}' FOR UPDATE; SELECT 'part-held';`);
      await holder.wait("part-held");
      const out = await withMcpAs(c, (rpc) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_task_checklist", arguments: { task_id: p.taskIds.a, items: [{ id: r3, text: "Row 1 (repeat 2)" }] } } }));
      assert.equal(out.error, undefined, JSON.stringify(out));
      assert.equal(out.result?.isError, true, JSON.stringify(out));
      const text = out.result.content.map((x) => x.text).join("\n");
      assert.match(text, /busy, try again in a moment/i);
      assert.match(text, /"reason":\s*"busy"/);
      assert.doesNotMatch(text, RAW_DB_TEXT);
      assert.equal(facts(part, r3), "Row 3|label", "nothing saved");
    } finally { await holder.end(); }
  });
  await test("FR4 FU-B: while another session has an uncommitted note on the part (its foreign key holds FOR KEY SHARE), the flip goes through: 200, 'straight'; the note then commits", async () => {
    const { c, p, part, r3 } = await labelPart();
    const holder = connection("holder-keyshare");
    try {
      holder.send(`BEGIN; INSERT INTO craft_notes (user_id, project_id, part_id, row, text) VALUES ('${c.id}','${p.projectId}','${part}',2,'note in flight'); SELECT 'note-held';`);
      await holder.wait("note-held");
      // The held insert's row lock is FOR KEY SHARE: a FOR UPDATE NOWAIT on the part fails, FOR NO KEY UPDATE NOWAIT doesn't.
      assert.match(psql(`BEGIN; SELECT 1 FROM craft_parts WHERE id='${part}' FOR NO KEY UPDATE NOWAIT; ROLLBACK;`), /^1$/);
      const r = await call(checklistRoute.PATCH, c, "PATCH", `/api/tasks/${p.taskIds.a}/checklist`, { id: p.taskIds.a }, { items: [{ id: r3, text: "Row 1 (repeat 2)" }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(facts(part, r3), "Row 1 (repeat 2)|straight");
      holder.send("COMMIT; SELECT 'note-done';");
      await holder.wait("note-done");
      assert.doesNotMatch(holder.output(), /ERROR/);
      assert.equal(psql(`SELECT count(*) FROM craft_notes WHERE part_id='${part}' AND text='note in flight';`), "1");
    } finally { await holder.end(); }
  });
  await test("FR3: Change total on a 'label' part (dropping an (est.) row renumbers the rest, labels with them; a raise adds labelled rows) keeps 'label'", async () => {
    const c = await user();
    const p = seed(c, { project: { name: "Fake Total", tags: ["knitting"] }, sections: [{ key: "s", name: "1. Body" }], tasks: [
      { key: "t", section: "s", title: "Rows 1–5", unit_count: null, work_type: null, created: 0, items: ["Row 1 · k", "Row 2 (est.) · k", "Row 3 · k", "Row 4 · k", "Row 5 · k"] }] });
    assert.equal((await create(c, p.projectId)).status, 201);
    const part = psql(`SELECT id FROM craft_parts WHERE project_id='${p.projectId}';`);
    const lower = JSON.parse(psql(`SELECT craft_set_total('${c.id}','${part}',4,5);`));
    assert.equal(lower.status, "ok", JSON.stringify(lower));
    assert.equal(psql(`SELECT string_agg(craft_row || '=' || text, ',' ORDER BY craft_row) FROM task_checklist_items WHERE craft_part_id='${part}';`), "1=Row 1 · k,2=Row 2 · k,3=Row 3 · k,4=Row 4 · k");
    assert.equal(psql(`SELECT row_numbering FROM craft_parts WHERE id='${part}';`), "label", "the +1000000 step never trips it: the check runs on the rows as committed");
    const raise = JSON.parse(psql(`SELECT craft_set_total('${c.id}','${part}',6,4,'k',NULL,NULL);`));
    assert.equal(raise.status, "ok", JSON.stringify(raise));
    assert.equal(psql(`SELECT count(*) || ':' || (SELECT row_numbering FROM craft_parts WHERE id='${part}') FROM task_checklist_items WHERE craft_part_id='${part}';`), "6:label");
  });
  await test("FR2 backfill: 075 marks an old part 'label' only when every row it holds still reads its label as its row; a changed label or no rows at all is 'straight' (no task + row guessing)", async () => {
    const c = await user();
    const desc = () => ({ project: { name: "Fake Old Hat", tags: ["knitting"] }, sections: [{ key: "a", name: "1. Brim" }, { key: "b", name: "2. Crown" }], tasks: [
      { key: "brim", section: "a", title: "Brim · Rows: r", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 3"] },
      { key: "crown", section: "b", title: "Crown · Rnds: r", unit_count: null, work_type: null, created: 1, items: ["Rnd 1", "Rnd 2"] },
      { key: "top", section: "b", title: "Top · Rnds: r", unit_count: null, work_type: null, created: 2, items: ["Rnd 3"] }] });
    const p = seed(c, desc());
    psql(down075); await waitForRpc(false);
    setUpOldWay(c.id, p.projectId, ["Brim", "Crown"]);
    const parts = Object.fromEntries(psql(`SELECT name || '=' || id FROM craft_parts WHERE project_id='${p.projectId}';`).split("\n").map((l) => l.split("=")));
    psql(`UPDATE task_checklist_items SET text = 'Row 7 · (renamed)' WHERE task_id='${p.taskIds.brim}' AND text = 'Row 2';`);
    const empty = randomUUID();
    psql(`INSERT INTO craft_parts (id, user_id, project_id, name, sort_order, total_rows) VALUES ('${empty}','${c.id}','${p.projectId}','Empty',2,4);`);
    psql(up075); await waitForRpc(true);
    assert.deepEqual(psql(`SELECT name || ':' || row_numbering FROM craft_parts WHERE project_id='${p.projectId}' ORDER BY sort_order;`).split("\n"), ["Brim:straight", "Crown:label", "Empty:straight"]);
    assert.ok(parts.Brim && parts.Crown);
  });
  await test("Reset refuses what it can't make again (quarters, band checks, ridges: MC75K), a change since the preview (409), another user, and leaves everything as it was when its compare fails (one transaction)", async () => {
    const { bl, gs } = old;
    for (const p of [bl, gs]) {
      const before = projectState(p.projectId);
      const pv = await resetPreview(a, p.projectId);
      assert.equal(pv.body.plan.ok, false);
      assert.match(pv.body.plan.stops[0], /can’t be reset/);
      const r = await a.client.rpc("craft_reset_project", { p_user_id: a.id, p_project_id: p.projectId, p_plan: { active_part_index: 0, parts: [{ name: "x", row_word: "row", total_rows: 1, segments: [], rows: [] }], units: [] }, p_fingerprint: pv.body.fingerprint });
      assert.equal(r.error?.code, "MC75K");
      assert.equal(projectState(p.projectId), before);
    }
    const desc = sophieHood();
    const s = seed(a, desc);
    assert.equal((await create(a, s.projectId)).status, 201);
    psql(`UPDATE task_checklist_items SET unit_count = NULL WHERE task_id='${s.taskIds.top}';`);
    const pv = await resetPreview(a, s.projectId);
    psql(`INSERT INTO craft_notes (user_id, project_id, text) VALUES ('${a.id}','${s.projectId}','a new note after the preview');`);
    const stale = await call(resetRoute.POST, a, "POST", `/api/craft/${s.projectId}/reset`, { projectId: s.projectId }, { fingerprint: pv.body.fingerprint, names: pv.body.plan.parts.map((p) => p.name) });
    assert.deepEqual([stale.status, stale.body.reason], [409, "changed"]);
    // A compare that fails after the stitch counts were written rolls them back with everything else.
    const before = projectState(s.projectId);
    const fresh = await resetPreview(a, s.projectId);
    const snap = await loadSetupSnapshot(a.client, a.id, s.projectId);
    const plan = planCraftSetup(snap, { reset: true });
    const { craft: _c, ...payload } = craftSetupPayload(plan, "knit", plan.parts.map((p) => p.name));
    assert.ok(payload.units.length > 0, "the top's rows would be filled");
    payload.parts[1].total_rows = 136;
    const bad = await a.client.rpc("craft_reset_project", { p_user_id: a.id, p_project_id: s.projectId, p_plan: payload, p_fingerprint: fresh.body.fingerprint });
    assert.equal(bad.error?.code, "22023");
    assert.equal(projectState(s.projectId), before, "nothing changed: units, parts, links");
    const other = await b.client.rpc("craft_reset_project", { p_user_id: a.id, p_project_id: s.projectId, p_plan: payload, p_fingerprint: fresh.body.fingerprint });
    assert.equal(other.error?.code, "42501");
    assert.equal((await resetPreview(b, s.projectId)).status, 404);
    const good = await doReset(a, s.projectId);
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.units_filled, 69, "the top's 69 empty rows get their 42s");
  });
  await test("Reset's lock order: a session holding a task (as Row done does) and then the craft project makes Reset wait, never deadlock; Reset then succeeds", async () => {
    const h = seed(a, { project: { name: "Fake Lock", tags: [] }, sections: [{ key: "a", name: "1. Body" }], tasks: [{ key: "t", section: "a", title: "T", unit_count: null, work_type: null, created: 0, items: ["Row 1", "Row 2", "Row 3"] }] });
    assert.equal((await create(a, h.projectId)).status, 201);
    const pv = await resetPreview(a, h.projectId);
    const label = `craft-s4-reset-${randomUUID()}`;
    const rows = connection("rows"), resetter = connection("reset");
    const payload = { active_part_index: 0, units: [], parts: pv.body.plan.parts.map((p) => ({ name: p.name, row_word: p.row_word, total_rows: p.total_rows, stitch_count: p.stitch_count, sort_order: p.sort_order,
      segments: p.segments.map(({ task_id, from_row, to_row, sort_order }) => ({ task_id, from_row, to_row, sort_order })), rows: p.rows.map(({ item_id, row }) => ({ item_id, row })) })) };
    try {
      rows.send(`BEGIN; SET LOCAL deadlock_timeout='100ms'; SELECT 1 FROM tasks WHERE id='${h.taskIds.t}' FOR NO KEY UPDATE; SELECT 'task-held';`);
      await rows.wait("task-held");
      resetter.send(`SET application_name='${label}'; SET deadlock_timeout='100ms'; SELECT 'reset:' || ((craft_reset_project('${a.id}','${h.projectId}', $j$${JSON.stringify(payload)}$j$::jsonb, '${pv.body.fingerprint}'))->>'parts');`);
      assert.ok(await waitingOnLock(label), `Reset waits on the task: ${resetter.output()}`);
      rows.send(`SELECT 1 FROM craft_projects WHERE project_id='${h.projectId}' FOR NO KEY UPDATE; SELECT 1 FROM craft_parts WHERE project_id='${h.projectId}' FOR UPDATE; COMMIT; SELECT 'rows-done';`);
      await rows.wait("rows-done");
      await resetter.wait("reset:");
      assert.doesNotMatch(rows.output() + resetter.output(), /deadlock|40P01|ERROR/);
      assert.match(resetter.output(), /reset:1/);
    } finally { await Promise.all([rows.end(), resetter.end()]); }
  });

  // ── 075's rollback ─────────────────────────────────────────────────────
  await test("075 down puts 072's fingerprint and 073's plan and Set up back exactly (bodies, grants) and drops everything else 075 made; data stays; 075 re-applies", async () => {
    const fn = (sig) => psql(`SELECT md5(pg_get_functiondef('${sig}'::regprocedure)) || ':' || has_function_privilege('authenticated','${sig}','EXECUTE') || ':' || has_function_privilege('anon','${sig}','EXECUTE');`);
    const sigs = ["craft_setup_fingerprint(uuid,uuid)", "craft_setup_plan(uuid,uuid)", "craft_setup_project(uuid,uuid,jsonb,text)"];
    const data = () => psql("SELECT count(*) FROM craft_parts; SELECT count(*) FROM task_checklist_items WHERE unit_count IS NOT NULL; SELECT count(*) FROM craft_sitting_details;");
    const kept = data();
    psql(down075);
    const at074 = sigs.map(fn);
    for (const gone of ["craft_reset_project(uuid,uuid,jsonb,text)", "craft_plan_core(uuid,uuid,boolean)", "delete_task_checked(uuid,uuid,boolean)", "checklist_insert_items(uuid,uuid,jsonb,uuid,boolean)", "craft_checklist_heal()", "craft_checklist_numbering_check()"]) {
      assert.equal(psql(`SELECT to_regprocedure('${gone}') IS NULL;`), "t", gone);
    }
    assert.equal(psql("SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_checklist_craft_heal','trg_checklist_craft_numbering');"), "0");
    assert.equal(psql("SELECT count(*) FROM information_schema.columns WHERE table_name='craft_parts' AND column_name='row_numbering';"), "0");
    assert.equal(data(), kept);
    // 074 down + up from the migration files gives the same three bodies: 075 down restored them exactly.
    psql(readFileSync(new URL("../supabase/rollbacks/074_craft_progress.down.sql", import.meta.url), "utf8"));
    psql(readFileSync(new URL("../supabase/rollbacks/073_craft_rpcs.down.sql", import.meta.url), "utf8"));
    psql(readFileSync(new URL("../supabase/migrations/073_craft_rpcs.sql", import.meta.url), "utf8"));
    psql(readFileSync(new URL("../supabase/migrations/074_craft_progress.sql", import.meta.url), "utf8"));
    assert.deepEqual(sigs.map(fn), at074, "the same as a fresh 073 + 074");
    psql(up075);
    assert.ok(has075());
    assert.equal(psql("SELECT has_function_privilege('authenticated','craft_reset_project(uuid,uuid,jsonb,text)','EXECUTE') AND NOT has_function_privilege('anon','craft_reset_project(uuid,uuid,jsonb,text)','EXECUTE');"), "t");
    await waitForRpc(true);
  });
} finally {
  if (!has075()) { try { psql(up075); } catch (e) { failed++; console.error("restore 075 failed", e.message); } }
  for (const id of users) psql(`DELETE FROM craft_timers WHERE user_id='${id}'; DELETE FROM work_sessions WHERE user_id='${id}'; DELETE FROM projects WHERE user_id='${id}';`);
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft S4 DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
