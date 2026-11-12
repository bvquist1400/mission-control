#!/usr/bin/env node
// Craft S1C on a disposable LOCAL stack (CRAFT_TEST_*): migration 072, Create and Remove through
// the real routes and functions, the fingerprint in SQL vs TypeScript, a tick racing Create, other
// users and anon, the rights clean-up, and 072's rollback. Destructive only to this local stack.
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
const up071 = readFileSync(new URL("../supabase/migrations/071_add_craft_tables.sql", import.meta.url), "utf8");
const down071 = readFileSync(new URL("../supabase/rollbacks/071_add_craft_tables.down.sql", import.meta.url), "utf8");
// 073 (S2) replaces three 072 functions: it is rolled back before any 072 rollback and re-applied after 072.
const up073 = readFileSync(new URL("../supabase/migrations/073_craft_rpcs.sql", import.meta.url), "utf8");
const down073 = readFileSync(new URL("../supabase/rollbacks/073_craft_rpcs.down.sql", import.meta.url), "utf8");
const has073 = () => psql("SELECT to_regprocedure('craft_rows(uuid,uuid,integer,integer,text,uuid)') IS NOT NULL;") === "t";
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
    async wait(marker) { for (let i = 0; i < 200; i++) { if (output.includes(marker) || output.includes("ERROR:")) return; await sleep(25); } throw new Error(`${label}: missing ${marker}: ${output}`); },
    async end() { child.stdin.end(); await closed; },
  };
}
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e.message, e.stderr?.toString() ?? ""); } }
const users = [];
async function user() {
  const password = randomUUID(), email = `craft-s1c-${randomUUID()}@example.test`;
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
process.env.MISSION_CONTROL_API_KEY = `craft-s1c-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const setupRoute = await import("../src/app/api/craft/setup/[projectId]/route.ts");
const detailRoute = await import("../src/app/api/craft/[projectId]/route.ts");
const { loadSetupSnapshot } = await import("../src/lib/craft/setup-service.ts");
const { planCraftSetup, craftSetupPayload } = await import("../src/lib/craft/setup.ts");
const { craftSetupFingerprint } = await import("../src/lib/craft/setup-fingerprint.ts");

const fixture = JSON.parse(readFileSync(new URL("./fixtures/craft/mittens.json", import.meta.url), "utf8"));
const CRAFT_TABLES = ["craft_projects", "craft_parts", "craft_segments", "craft_timers", "craft_sitting_details", "craft_notes", "craft_links", "craft_instructions", "craft_yarns"];
const FUNCTIONS = ["craft_setup_fingerprint(uuid,uuid)", "craft_setup_lock(uuid,uuid)", "craft_setup_plan(uuid,uuid)", "craft_setup_project(uuid,uuid,jsonb,text)", "craft_remove_blockers(uuid,uuid)", "craft_remove_project(uuid,uuid)"];
const FUNCTIONS_072 = "craft_check_ownership,craft_checklist_clear_deleted_part,craft_remove_blockers,craft_remove_project,craft_setup_fingerprint,craft_setup_lock,craft_setup_plan,craft_setup_project";
const rights = () => psql(`SELECT string_agg(t || ':' || r || ':' || p || ':' || has_table_privilege(r, t, p), ',' ORDER BY t, r, p)
  FROM unnest(ARRAY['${CRAFT_TABLES.join("','")}']) t, unnest(ARRAY['authenticated','service_role','anon']) r,
  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p;`);
const functionNames = () => psql("SELECT coalesce(string_agg(proname, ',' ORDER BY proname), '') FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'craft_%';");

/** A copy of the mittens for `owner`, with fresh ids and the fixture's titles, texts, ticks, units and order. */
async function seedMittens(owner, name = fixture.project.name) {
  const ids = new Map(), id = (old) => { if (!ids.has(old)) ids.set(old, randomUUID()); return ids.get(old); };
  const project = { id: id(fixture.project.id), user_id: owner, name, tags: fixture.project.tags, unit_label: "stitches" };
  assert.ifError((await admin.from("projects").insert(project)).error);
  assert.ifError((await admin.from("project_sections").insert(fixture.sections.map((s) => ({ id: id(s.id), user_id: owner, project_id: project.id, name: s.name, sort_order: s.sort_order })))).error);
  assert.ifError((await admin.from("tasks").insert(fixture.tasks.map((t) => ({ id: id(t.id), user_id: owner, project_id: project.id, section_id: id(t.section_id), title: t.title, status: t.status, is_sample: t.is_sample, created_at: t.created_at })))).error);
  assert.ifError((await admin.from("task_checklist_items").insert(fixture.items.map((i) => ({ id: id(i.id), user_id: owner, task_id: id(i.task_id), text: i.text, is_done: i.is_done, sort_order: i.sort_order, unit_count: i.unit_count, work_type: i.work_type, completed_at: i.completed_at })))).error);
  return { projectId: project.id, id };
}
const itemsSql = (projectId, without = "") => `SELECT md5(coalesce(string_agg((to_jsonb(i)${without})::text, ',' ORDER BY i.id), '')) FROM task_checklist_items i JOIN tasks t ON t.id = i.task_id WHERE t.project_id = '${projectId}';`;
const routeReq = (who, method, path, body) => {
  const r = new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: who.client, userId: who.id, user: { id: who.id }, authSource: "session" });
  return r;
};
const ctx = (projectId) => ({ params: Promise.resolve({ projectId }) });
const preview = async (who, projectId) => { const res = await setupRoute.GET(routeReq(who, "GET", `/api/craft/setup/${projectId}`), ctx(projectId)); assert.equal(res.status, 200); return res.json(); };
const create = async (who, projectId, pv, extra = {}) => setupRoute.POST(routeReq(who, "POST", `/api/craft/setup/${projectId}`, { fingerprint: pv.fingerprint, craft: pv.plan.default_craft, names: pv.plan.parts.map((p) => p.name), ...extra }), ctx(projectId));
const remove = (who, projectId) => detailRoute.DELETE(routeReq(who, "DELETE", `/api/craft/${projectId}`), ctx(projectId));
const linkedCount = (projectId) => psql(`SELECT count(*) FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.project_id='${projectId}' AND (i.craft_part_id IS NOT NULL OR i.craft_row IS NOT NULL);`);
const craftRowCount = (projectId) => psql(`SELECT (SELECT count(*) FROM craft_projects WHERE project_id='${projectId}') + (SELECT count(*) FROM craft_parts WHERE project_id='${projectId}') + (SELECT count(*) FROM craft_links WHERE project_id='${projectId}') + (SELECT count(*) FROM craft_notes WHERE project_id='${projectId}');`);

// FR1 helpers: a generic project seeded with psql (exact numeric literals and texts), the SQL plan, and lock waits.
const lit = (t) => `$lit$${t}$lit$`;
function seedProject(owner, name, tasks, { sections = ["Main"] } = {}) {
  const projectId = randomUUID(), sectionIds = sections.map(() => randomUUID()), taskIds = [];
  let sql = `INSERT INTO projects (id, user_id, name, tags, unit_label) VALUES ('${projectId}','${owner}',${lit(name)},ARRAY['knitting'],'stitches');\n`;
  sections.forEach((section, i) => { sql += `INSERT INTO project_sections (id, user_id, project_id, name, sort_order) VALUES ('${sectionIds[i]}','${owner}','${projectId}',${lit(section)},${i});\n`; });
  tasks.forEach((task, k) => {
    const taskId = task.id ?? randomUUID(); taskIds.push(taskId);
    const section = task.section === null ? "NULL" : `'${sectionIds[task.section ?? 0]}'`;
    const created = task.created_at ? `'${task.created_at}'::timestamptz` : `'2026-11-02T00:00:00Z'::timestamptz + interval '${k} seconds'`;
    sql += `INSERT INTO tasks (id, user_id, project_id, section_id, title, status, is_sample, created_at) VALUES ('${taskId}','${owner}','${projectId}',${section},${lit(task.title)},'Planned',${task.is_sample ? "true" : "false"},${created});\n`;
    task.rows.forEach(([text, done = false, units = null], j) => {
      sql += `INSERT INTO task_checklist_items (user_id, task_id, text, is_done, sort_order, unit_count) VALUES ('${owner}','${taskId}',${lit(text)},${done},${j},${units === null ? "NULL" : `'${units}'::numeric`});\n`;
    });
  });
  psql(sql);
  return { projectId, taskIds };
}
const rowsOf = (word, from, to, done = 0, units = null, extra = "") => Array.from({ length: to - from + 1 }, (_, i) => [`${word} ${from + i}${extra}`, from + i <= done, units]);
const projectPlan = (payload) => ({ active_part_index: payload.active_part_index, parts: payload.parts.map((p) => ({ row_word: p.row_word, total_rows: p.total_rows, stitch_count: p.stitch_count,
  segments: p.segments.map(({ task_id, from_row, to_row }) => ({ task_id, from_row, to_row })), rows: p.rows.map(({ item_id, row }) => ({ item_id, row })) })) });
async function sqlPlan(who, projectId) {
  const res = await who.client.rpc("craft_setup_plan", { p_user_id: who.id, p_project_id: projectId });
  assert.ifError(res.error);
  return res.data;
}
/** TypeScript planner vs 072's craft_setup_plan on the same rows: same ok-ness; when ok, the same parts, rows, segments and active part. */
async function parity(who, projectId, label) {
  const snap = await loadSetupSnapshot(who.client, who.id, projectId), plan = planCraftSetup(snap), sql = await sqlPlan(who, projectId);
  assert.equal(sql.stops.length === 0, plan.ok, `${label}: SQL stops ${JSON.stringify(sql.stops)} vs TS ${JSON.stringify(plan.stops)}`);
  if (plan.ok) assert.deepEqual({ active_part_index: sql.active_part_index, parts: sql.parts }, projectPlan(craftSetupPayload(plan, "knit", plan.parts.map((p) => p.name))), label);
  return { snap, plan, sql };
}
async function waitingOnLock(label) {
  for (let i = 0; i < 200; i++) {
    if (psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event_type='Lock';`) === "1") return true;
    await sleep(25);
  }
  return false;
}
const setupCall = (userId, projectId, plan, fp) => `SELECT craft_setup_project('${userId}','${projectId}', $json$${JSON.stringify(craftSetupPayload(plan, "knit", plan.parts.map((p) => p.name)))}$json$::jsonb, '${fp}')`;
/** Everything Remove could touch, hashed: the project's craft rows and every column of its items. */
const craftState = (projectId) => psql(`SELECT md5(concat_ws('|',
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.project_id), '') FROM craft_projects x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_parts x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_segments x JOIN craft_parts p ON p.id = x.part_id WHERE p.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_instructions x JOIN craft_parts p ON p.id = x.part_id WHERE p.project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_links x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_notes x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '') FROM craft_yarns x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.user_id), '') FROM craft_timers x WHERE project_id='${projectId}'),
  (SELECT coalesce(string_agg(to_jsonb(i)::text, ',' ORDER BY i.id), '') FROM task_checklist_items i JOIN tasks t ON t.id = i.task_id WHERE t.project_id='${projectId}')));`);

let rights071, functions071;
try {
  // FR1 (F5): the 071 state is captured from a FRESH 071 apply (071 down, 071 up), never from after 072's down.
  await test("072 applies on top of a fresh 071; the 071 rights are captured from that fresh apply", () => {
    if (has073()) psql(down073);
    if (functionNames().includes("craft_setup_project")) psql(down072);
    psql(down071); psql(up071);
    rights071 = rights(); functions071 = functionNames();
    assert.equal(functions071, "craft_check_ownership,craft_checklist_clear_deleted_part");
    psql(up072);
    assert.equal(functionNames(), FUNCTIONS_072);
    // The rest runs on what ships: 072 with 073 over it.
    psql(up073);
  });
  await test("072 functions: SECURITY INVOKER, EXECUTE for authenticated and service_role only (not anon, not PUBLIC)", () => {
    for (const fn of FUNCTIONS) {
      assert.equal(psql(`SELECT prosecdef FROM pg_proc WHERE oid='${fn}'::regprocedure;`), "f", fn);
      assert.equal(psql(`SELECT has_function_privilege('authenticated','${fn}','EXECUTE') AND has_function_privilege('service_role','${fn}','EXECUTE') AND NOT has_function_privilege('anon','${fn}','EXECUTE');`), "t", fn);
      assert.equal(psql(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid='${fn}'::regprocedure AND a.grantee=0;`), "0", `${fn} PUBLIC`);
    }
  });
  await test("Rights clean-up: the API roles keep SELECT/INSERT/UPDATE/DELETE and lose TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on all nine craft tables", () => {
    assert.equal(psql("SHOW server_version_num;").slice(0, 2), "17", "local stack is Postgres 17, so MAINTAIN exists");
    for (const table of CRAFT_TABLES) for (const role of ["authenticated", "service_role"]) {
      assert.equal(psql(`SELECT bool_and(has_table_privilege('${role}','${table}',p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;`), "t", `${role} ${table} keeps SIUD`);
      assert.equal(psql(`SELECT bool_or(has_table_privilege('${role}','${table}',p)) FROM unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p;`), "f", `${role} ${table} extra rights`);
    }
    assert.ok(rights071.includes("craft_parts:service_role:TRUNCATE:true"), "a fresh 071 has them from the default privileges (like hosted)");
  });

  const a = await user(), b = await user();
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const m1 = await seedMittens(a.id);
  const fixtureItem = (title, text) => fixture.items.find((i) => i.task_id === fixture.tasks.find((t) => t.title.startsWith(title)).id && i.text.startsWith(text));

  await test("Fingerprint: SQL (072) and TypeScript agree on real rows, incl. microsecond timestamps and 36.0 units", async () => {
    psql(`UPDATE task_checklist_items SET unit_count = 36.0 WHERE id = '${m1.id(fixtureItem("Mitten 2 · Cuff", "Rnd 2 ·").id)}';`);
    const extra = await admin.from("tasks").insert({ user_id: a.id, project_id: m1.projectId, title: "Notes (no rows)", status: "Planned" }).select("id, created_at").single();
    assert.ifError(extra.error);
    assert.match(psql(`SELECT created_at::text FROM tasks WHERE id='${extra.data.id}';`), /\.\d{4,6}\+00$/, "a sub-millisecond created_at is in play");
    const snap = await loadSetupSnapshot(a.client, a.id, m1.projectId);
    const sql = await a.client.rpc("craft_setup_fingerprint", { p_user_id: a.id, p_project_id: m1.projectId });
    assert.ifError(sql.error);
    assert.equal(sql.data, craftSetupFingerprint(snap));
    assert.equal(psql(`SELECT craft_setup_fingerprint('${a.id}','${m1.projectId}');`), sql.data, "service role sees the same rows");
    assert.ifError((await admin.from("tasks").delete().eq("id", extra.data.id)).error);
  });
  await test("FR1 fingerprint parity (F3/F5): tricky numbers and texts give the same fingerprint in TypeScript and SQL, and Create accepts it", async () => {
    const units = ["0", "36", "36.0", "0.0000001", "1000000000000000000000", "123456.789", null, "NaN", "Infinity", "0.000"];
    const texts = ["Row 1 · knit", "Row 2 → 38 sts", "Row 3 × 2", "Row 4 – purl", "Row 5 ﻿with a BOM", "Row 6 · NBSP after", "Row 7 · “quotes” and ’", "Row 8 · emoji 🧶", "Row 9 · tab\there", "Row 10 · trailing space "];
    const { projectId } = seedProject(a.id, "Parity · numbers → texts", [
      { title: " Scarf · Body → × – ﻿", rows: texts.map((text, i) => [text, i < 2, units[i]]) },
      { title: "Notes · ﻿plain", rows: [["﻿Rnd 1 · BOM first"], ["Rnd 2 · NBSP"], ["Rnd﻿3 · BOM between"], ["Check: 36 → 38"]] },
    ]);
    const snap = await loadSetupSnapshot(a.client, a.id, projectId);
    assert.deepEqual(snap.items.filter((i) => i.unit_count !== null).map((i) => i.unit_count).sort(), ["0", "0", "1000000000000000000000", "123456.789", "36", "36", "Infinity", "NaN", "0.0000001"].sort(), "units arrive as canonical numeric text");
    const sql = await a.client.rpc("craft_setup_fingerprint", { p_user_id: a.id, p_project_id: projectId });
    assert.ifError(sql.error);
    assert.equal(craftSetupFingerprint(snap), sql.data);
    const { plan } = await parity(a, projectId, "parity project");
    assert.equal(plan.ok, true, plan.stops.join("; "));
    assert.deepEqual(plan.near_misses.map((n) => n.text), ["﻿Rnd 1 · BOM first", "Rnd 2 · NBSP", "Rnd﻿3 · BOM between"]);
    const pv = await preview(a, projectId);
    const res = await create(a, projectId, pv);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    assert.equal(psql(`SELECT s.name FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE p.project_id='${projectId}';`), pv.plan.parts[0].segments[0].name, "segment name: SQL trims like the preview");
    assert.equal(pv.plan.parts[0].segments[0].name, "Scarf · Body → × –");
    assert.equal(linkedCount(projectId), "10");
  });
  await test("FR1 plan parity (F4): 072's craft_setup_plan matches the TypeScript planner on the mittens, gaps, blanket- and scarf-shaped projects, ties, long names and every STOP", async () => {
    await parity(a, m1.projectId, "mittens");
    const gaps = await seedMittens(a.id, "Mittens gaps");
    const cuff = gaps.id(fixture.tasks.find((t) => t.title.startsWith("Mitten 1 · Cuff")).id);
    psql(`DELETE FROM task_checklist_items WHERE task_id='${cuff}' AND text ~ '^Rnd 2[2-8] ';`);
    assert.deepEqual((await parity(a, gaps.projectId, "gaps")).plan.parts[0].gaps, [[22, 28]]);
    const blanket = seedProject(a.id, "Blanket shape", [
      ...[["Foundation", 1, 1], ["Waffle 1", 2, 18], ["Tree 1", 19, 37], ["Waffle 2", 38, 52], ["Tree 2", 53, 71], ["Waffle 3", 72, 86], ["Tree 3", 87, 105], ["Waffle 4", 106, 120], ["Tree 4", 121, 139], ["Waffle 5", 140, 156], ["Final sc row", 157, 157]]
        .map(([title, from, to]) => ({ title: `Step ${title}`, rows: rowsOf("Row", from, to, 58, "195", ": chart row") })),
      { title: "Border", rows: [["Round 1"], ["Round 2"]] },
    ]);
    assert.deepEqual((await parity(a, blanket.projectId, "blanket")).sql.parts.map((p) => [p.row_word, p.total_rows, p.stitch_count, p.segments.length]), [["row", 157, 195, 11], ["round", 2, null, 1]]);
    const scarf = seedProject(a.id, "Scarf shape", [0, 1, 2, 3, 4, 5].map((k) => ({ title: `Scarf rows ${k * 100 + 1}–${Math.min(519, k * 100 + 100)}`, rows: rowsOf("Row", k * 100 + 1, Math.min(519, k * 100 + 100), 118, "30") })));
    assert.equal((await parity(a, scarf.projectId, "scarf")).sql.active_part_index, 0);
    // Sections, unsectioned last, a creation-time tie broken by id, a swatch, a word change and a non-continuing number.
    // Fresh ids every run (the stack outlives a run), ordered so tieA sorts before tieB.
    const [tieA, tieB] = [randomUUID(), randomUUID()].sort();
    const mixed = seedProject(a.id, "Order and grouping", [
      { title: "Loose · Edge: r", section: null, rows: rowsOf("Row", 1, 3) },
      { title: "B · Two: r", section: 1, rows: rowsOf("Rnd", 1, 2, 2, "12") },
      { id: tieB, title: "A · Later id: r", section: 0, created_at: "2026-11-03T00:00:00.000400Z", rows: rowsOf("Rnd", 4, 6, 0, "12") },
      { id: tieA, title: "A · Earlier id: r", section: 0, created_at: "2026-11-03T00:00:00.000900Z", rows: rowsOf("Rnd", 1, 3, 0, "12") },
      { title: "A · Rows now: r", section: 0, created_at: "2026-11-04T00:00:00Z", rows: rowsOf("Row", 7, 8) },
      { title: "A · Skip: r", section: 0, created_at: "2026-11-05T00:00:00Z", rows: rowsOf("Row", 10, 11) },
      { title: "Swatch", is_sample: true, section: 0, rows: rowsOf("Row", 1, 4) },
      { title: `🧶 ${"Long name ".repeat(12)}· Stage: r`, section: 1, rows: rowsOf("Round", 1, 1) },
    ], { sections: ["A", "B"] });
    const order = await parity(a, mixed.projectId, "order");
    assert.deepEqual(order.plan.parts.map((p) => [p.name, p.total_rows, p.segments.length]).slice(0, 3), [["A · Later id", 6, 2], ["A · Rows now", 8, 1], ["A · Skip", 11, 1]]);
    const orderPv = await preview(a, mixed.projectId);
    assert.equal((await create(a, mixed.projectId, orderPv)).status, 201);
    const written = psql(`SELECT string_agg(s.name, '|' ORDER BY p.sort_order, s.sort_order) FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE p.project_id='${mixed.projectId}';`);
    assert.equal(written, orderPv.plan.parts.flatMap((p) => p.segments.map((g) => g.name)).join("|"), "segment names (80-character cut included) match the preview");
    // Every STOP: SQL refuses the same projects.
    for (const [label, tasks] of [
      ["repeat", [{ title: "P", rows: [["Rnd 1"], ["Rnd 2"], ["Rnd 2 · again"]] }]],
      ["mixed", [{ title: "P", rows: [["Rnd 1"], ["Row 2"]] }]],
      ["range", [{ title: "P", rows: [["Rnd 1"], ["Rnd 2 – 3"]] }]],
      ["range to", [{ title: "P", rows: [["Rnd 1"], ["Rnd 2 TO 3"]] }]],
      ["decimal", [{ title: "P", rows: [["Rnd 1"], ["Rnd 2.5"]] }]],
      ["zero", [{ title: "P", rows: [["Rnd 0"], ["Rnd 1"]] }]],
      ["too big", [{ title: "P", rows: [["Rnd 1"], ["Rnd 1000001"]] }]],
      ["over 2000", [{ title: "P", rows: [["Row 1"], ["Row 2001"]] }]],
      ["no rows", [{ title: "P", rows: [["Cast on"], ["rnd 1"]] }]],
    ]) {
      const seeded = seedProject(a.id, `Stop ${label}`, tasks);
      const { sql } = await parity(a, seeded.projectId, label);
      assert.ok(sql.stops.length > 0, label);
    }
    const fine = seedProject(a.id, "Exactly 2000", [{ title: "P", rows: [["Row 1"], ["Row 2000"]] }]);
    assert.equal((await parity(a, fine.projectId, "2000")).plan.ok, true);
  });

  const before = { items: psql(itemsSql(m1.projectId, "-'craft_part_id'-'craft_row'")), all: psql(itemsSql(m1.projectId)) };
  let firstPreview;
  await test("GET preview through the real route: the mittens plan, nothing written", async () => {
    firstPreview = await preview(a, m1.projectId);
    const parts = firstPreview.plan.parts;
    assert.equal(firstPreview.plan.ok, true, firstPreview.plan.stops.join("; "));
    assert.deepEqual(parts.map((p) => [p.name, p.total_rows, p.current_row, p.stitch_count, p.segments.length]), [1, 2].flatMap((m) => [[`Mitten ${m} · Cuff`, 31, m === 1 ? 15 : 1, 36, 1], [`Mitten ${m} · Hand`, 45, 1, null, 2], [`Mitten ${m} · Top decreases`, 8, 1, null, 1], [`Mitten ${m} · Thumb`, 15, 1, 14, 1]]));
    assert.equal(craftRowCount(m1.projectId), "0");
    assert.equal(psql(itemsSql(m1.projectId)), before.all);
  });

  await test("Create writes exactly the planned rows and links: 1 craft project, 8 parts, 10 segments, 198 rows; nothing else on the items changes", async () => {
    const res = await create(a, m1.projectId, firstPreview);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const out = await res.json();
    assert.deepEqual([out.parts, out.segments, out.rows_linked], [8, 10, 198]);
    const cp = await a.client.from("craft_projects").select("*").eq("project_id", m1.projectId).single();
    assert.equal(cp.data.craft, "knit");
    const parts = (await a.client.from("craft_parts").select("*").eq("project_id", m1.projectId).order("sort_order")).data;
    assert.deepEqual(parts.map((p) => [p.name, p.row_word, p.total_rows, p.stitch_count, p.sort_order, p.quarters, p.ridges]), firstPreview.plan.parts.map((p, i) => [p.name, "round", p.total_rows, p.stitch_count, i, false, false]));
    assert.equal(cp.data.active_part_id, parts[0].id, "active part = Mitten 1 · Cuff");
    const segs = (await a.client.from("craft_segments").select("*").in("part_id", parts.map((p) => p.id))).data;
    assert.equal(segs.length, 10);
    for (const [k, p] of firstPreview.plan.parts.entries()) {
      const mine = segs.filter((s) => s.part_id === parts[k].id).sort((x, y) => x.sort_order - y.sort_order);
      assert.deepEqual(mine.map((s) => [s.task_id, s.name, s.from_row, s.to_row, s.close_check]), p.segments.map((s) => [s.task_id, s.name, s.from_row, s.to_row, false]));
    }
    // Every linked row's number is the number in its text; the plain items are untouched.
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items i JOIN tasks t ON t.id=i.task_id WHERE t.project_id='${m1.projectId}' AND i.craft_part_id IS NOT NULL AND i.craft_row = substring(i.text from '^(?:Row|Rnd|Round)\\s+(\\d+)')::int;`), "198");
    assert.equal(linkedCount(m1.projectId), "198");
    assert.equal(psql(itemsSql(m1.projectId, "-'craft_part_id'-'craft_row'")), before.items, "is_done, completed_at, units, work type, text, sort order unchanged");
  });
  await test("The craft screen reads it back: Mitten 1 · Cuff, round 15 next with its own text; 8 parts", async () => {
    const res = await detailRoute.GET(routeReq(a, "GET", `/api/craft/${m1.projectId}`), ctx(m1.projectId));
    assert.equal(res.status, 200);
    const view = await res.json();
    assert.equal(view.active_part.name, "Mitten 1 · Cuff");
    assert.deepEqual([view.active_part.current_row, view.active_part.total_rows, view.active_part.done_rows, view.active_part.row_count, view.active_part.row_word], [15, 31, 14, 31, "round"]);
    assert.equal(view.next_rows[0].text, fixtureItem("Mitten 1 · Cuff", "Rnd 15 ·").text);
    assert.equal(view.parts.length, 8);
    assert.ok(view.projects.some((p) => p.id === m1.projectId && p.progress === "round 15"), "the title switcher picks it up");
  });
  await test("Create again: the route STOPs (already on the craft screen) and the function refuses (23505); nothing more written", async () => {
    const res = await create(a, m1.projectId, firstPreview);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already on the craft screen/);
    const direct = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m1.projectId, p_plan: craftSetupPayload(firstPreview.plan, "knit", firstPreview.plan.parts.map((p) => p.name)), p_fingerprint: firstPreview.fingerprint });
    assert.equal(direct.error?.code, "23505");
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE project_id='${m1.projectId}';`), "8");
  });

  // ── The fingerprint guard ───────────────────────────────────────────
  const m2 = await seedMittens(a.id, "Mittens copy 2");
  const rnd15 = m2.id(fixtureItem("Mitten 1 · Cuff", "Rnd 15 ·").id);
  const untick = () => psql(`UPDATE task_checklist_items SET is_done=false WHERE id='${rnd15}';`);
  await test("A tick between preview and Create: the route refuses with the preview's words and writes nothing", async () => {
    const pv = await preview(a, m2.projectId);
    psql(`UPDATE task_checklist_items SET is_done=true WHERE id='${rnd15}';`);
    const res = await create(a, m2.projectId, pv);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "Something changed since the preview. Open it again.", reason: "changed" });
    assert.equal(craftRowCount(m2.projectId), "0"); assert.equal(linkedCount(m2.projectId), "0");
    untick();
  });
  await test("A tick after the route's own read but before 072 runs: 072 rebuilds the fingerprint under its locks and refuses (MC072 → 409), nothing written", async () => {
    const pv = await preview(a, m2.projectId);
    const sneaky = { id: a.id, client: new Proxy(a.client, { get(target, prop) {
      if (prop !== "rpc") return Reflect.get(target, prop);
      return (name, args) => { psql(`UPDATE task_checklist_items SET is_done=true WHERE id='${rnd15}';`); return target.rpc(name, args); };
    } }) };
    const res = await create(sneaky, m2.projectId, pv);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, "changed");
    assert.equal(craftRowCount(m2.projectId), "0"); assert.equal(linkedCount(m2.projectId), "0");
    untick();
  });
  await test("A tick held open while Create runs: Create waits on the row lock, then sees the tick and refuses; nothing written", async () => {
    const snap = await loadSetupSnapshot(a.client, a.id, m2.projectId);
    const plan = planCraftSetup(snap), fp = craftSetupFingerprint(snap);
    const holder = connection("tick");
    try {
      holder.send(`BEGIN; UPDATE task_checklist_items SET is_done=true WHERE id='${rnd15}'; SELECT 'held';`);
      await holder.wait("held");
      const label = `craft-s1c-${randomUUID()}`;
      const job = (async () => {
        const c = connection("create");
        c.send(`BEGIN; SET LOCAL application_name='${label}'; SET LOCAL statement_timeout='10s'; SELECT craft_setup_project('${a.id}','${m2.projectId}', $json$${JSON.stringify(craftSetupPayload(plan, "knit", plan.parts.map((p) => p.name)))}$json$::jsonb, '${fp}'); COMMIT; SELECT 'create-done';`);
        await c.wait("create-done"); const out = c.output(); await c.end(); return out;
      })();
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) { waiting = psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event_type='Lock';`) === "1"; if (!waiting) await sleep(25); }
      assert.ok(waiting, "Create is waiting on the held tick");
      holder.send("COMMIT; SELECT 'tick-done';");
      await holder.wait("tick-done");
      const out = await job;
      assert.match(out, /CRAFT_SETUP_CHANGED/);
      assert.doesNotMatch(out, /deadlock/i);
    } finally { await holder.end(); }
    assert.equal(craftRowCount(m2.projectId), "0"); assert.equal(linkedCount(m2.projectId), "0");
    untick();
  });
  await test("Two Creates at once: one 201, the other a plain 409; one set of craft rows", async () => {
    const pv = await preview(a, m2.projectId);
    const results = await Promise.all([create(a, m2.projectId, pv), create(a, m2.projectId, pv)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE project_id='${m2.projectId}';`), "8");
    assert.equal(linkedCount(m2.projectId), "198");
    assert.equal((await remove(a, m2.projectId)).status, 200);
  });

  // ── FR1 (Astra 2): inserts and moves racing Create, two sessions each ─────
  const cuffTaskOf = (seeded) => seeded.id(fixture.tasks.find((t) => t.title.startsWith("Mitten 1 · Cuff")).id);
  const planFor = async (projectId) => { const snap = await loadSetupSnapshot(a.client, a.id, projectId); return { plan: planCraftSetup(snap), fp: craftSetupFingerprint(snap) }; };
  async function heldThenCreate(projectId, holdSql, label) {
    const { plan, fp } = await planFor(projectId);
    const holder = connection(label);
    try {
      holder.send(`BEGIN; ${holdSql}; SELECT 'held';`);
      await holder.wait("held");
      assert.doesNotMatch(holder.output(), /ERROR/, holder.output());
      const tag = `craft-s1c-${randomUUID()}`;
      const job = (async () => {
        const c = connection("create");
        c.send(`BEGIN; SET LOCAL application_name='${tag}'; SET LOCAL statement_timeout='10s'; ${setupCall(a.id, projectId, plan, fp)}; COMMIT; SELECT 'create-done';`);
        await c.wait("create-done"); const out = c.output(); await c.end(); return out;
      })();
      const waited = await waitingOnLock(tag);
      holder.send("COMMIT; SELECT 'holder-done';");
      await holder.wait("holder-done");
      return { waited, out: await job };
    } finally { await holder.end(); }
  }
  async function createThenHeld(projectId, otherSql, label) {
    const { plan, fp } = await planFor(projectId);
    const c = connection("create");
    try {
      c.send(`BEGIN; ${setupCall(a.id, projectId, plan, fp)}; SELECT 'created';`);
      await c.wait("created");
      assert.doesNotMatch(c.output(), /ERROR/, c.output());
      const tag = `craft-s1c-${randomUUID()}`;
      const other = connection(label);
      other.send(`BEGIN; SET LOCAL application_name='${tag}'; SET LOCAL statement_timeout='10s'; ${otherSql}; COMMIT; SELECT 'other-done';`);
      const waited = await waitingOnLock(tag);
      c.send("COMMIT; SELECT 'create-done';");
      await c.wait("create-done");
      await other.wait("other-done"); const out = other.output(); await other.end();
      return { waited, out };
    } finally { await c.end(); }
  }
  await test("FR1 race: a duplicate “Rnd 15” inserted into a planned task and held open — Create waits for it, then refuses (MC072); nothing written", async () => {
    const seeded = await seedMittens(a.id, "Race insert first");
    const { waited, out } = await heldThenCreate(seeded.projectId, `INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ('${a.id}','${cuffTaskOf(seeded)}','Rnd 15 · knit (again)', 99)`, "insert");
    assert.ok(waited, "Create waits on the insert's key-share lock on the task");
    assert.match(out, /CRAFT_SETUP_CHANGED/);
    assert.equal(craftRowCount(seeded.projectId), "0"); assert.equal(linkedCount(seeded.projectId), "0");
  });
  await test("FR1 race: Create held open — a duplicate “Rnd 15” insert into a planned task waits until Create commits", async () => {
    const seeded = await seedMittens(a.id, "Race create first");
    const { waited, out } = await createThenHeld(seeded.projectId, `INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ('${a.id}','${cuffTaskOf(seeded)}','Rnd 15 · knit (again)', 99)`, "insert");
    assert.ok(waited, "the insert waits for Create (FOR UPDATE on the planned tasks)");
    assert.doesNotMatch(out, /ERROR/);
    assert.equal(linkedCount(seeded.projectId), "198", "Create committed first with exactly its plan");
    assert.equal(psql(`SELECT count(*) FROM task_checklist_items WHERE task_id='${cuffTaskOf(seeded)}' AND text LIKE 'Rnd 15 · knit (again)' AND craft_part_id IS NULL;`), "1", "the later insert is an ordinary unlinked item");
  });
  await test("FR1 race: a task moved into the project and held open — Create waits for it, then refuses; a planned task moved out — Create waits, then refuses", async () => {
    const seeded = await seedMittens(a.id, "Race move in");
    const elsewhere = seedProject(a.id, "Elsewhere", [{ title: "Extra · Rounds: r", section: null, rows: rowsOf("Rnd", 1, 2) }]);
    const moveIn = await heldThenCreate(seeded.projectId, `UPDATE tasks SET project_id='${seeded.projectId}' WHERE id='${elsewhere.taskIds[0]}'`, "move-in");
    assert.ok(moveIn.waited, "Create waits on the move's key-share lock on the project");
    assert.match(moveIn.out, /CRAFT_SETUP_CHANGED/);
    assert.equal(craftRowCount(seeded.projectId), "0");
    const out2 = await seedMittens(a.id, "Race move out");
    const moveOut = await heldThenCreate(out2.projectId, `UPDATE tasks SET project_id='${elsewhere.projectId}' WHERE id='${cuffTaskOf(out2)}'`, "move-out");
    assert.ok(moveOut.waited);
    assert.match(moveOut.out, /CRAFT_SETUP_CHANGED/);
    assert.equal(craftRowCount(out2.projectId), "0"); assert.equal(linkedCount(out2.projectId), "0");
  });
  await test("FR1 race: Create held open — moving a task in waits until Create commits; moving a planned task out waits, then 071 refuses it", async () => {
    const seeded = await seedMittens(a.id, "Race create then move in");
    const elsewhere = seedProject(a.id, "Elsewhere 2", [{ title: "Extra · Rounds: r", section: null, rows: rowsOf("Rnd", 1, 2) }]);
    const moveIn = await createThenHeld(seeded.projectId, `UPDATE tasks SET project_id='${seeded.projectId}' WHERE id='${elsewhere.taskIds[0]}'`, "move-in");
    assert.ok(moveIn.waited, "the move waits for Create (the project row is held FOR UPDATE)");
    assert.doesNotMatch(moveIn.out, /ERROR/);
    assert.equal(linkedCount(seeded.projectId), "198");
    const out2 = await seedMittens(a.id, "Race create then move out");
    const moveOut = await createThenHeld(out2.projectId, `UPDATE tasks SET project_id='${elsewhere.projectId}' WHERE id='${cuffTaskOf(out2)}'`, "move-out");
    assert.ok(moveOut.waited);
    assert.match(moveOut.out, /craft rows in its project/);
    assert.equal(psql(`SELECT project_id FROM tasks WHERE id='${cuffTaskOf(out2)}';`), out2.projectId);
  });

  // ── Other users and anon ────────────────────────────────────────────
  const m3 = await seedMittens(a.id, "Mittens copy 3");
  await test("Another user: preview, Create and Remove of A's project are 404; the functions refuse B for A, and for B on A's project", async () => {
    assert.equal((await setupRoute.GET(routeReq(b, "GET", `/api/craft/setup/${m3.projectId}`), ctx(m3.projectId))).status, 404);
    const pv = await preview(a, m3.projectId);
    assert.equal((await create(b, m3.projectId, pv)).status, 404);
    assert.equal((await remove(b, m1.projectId)).status, 404);
    const payload = craftSetupPayload(pv.plan, "knit", pv.plan.parts.map((p) => p.name));
    const asA = await b.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: payload, p_fingerprint: pv.fingerprint });
    assert.equal(asA.error?.code, "42501");
    const asB = await b.client.rpc("craft_setup_project", { p_user_id: b.id, p_project_id: m3.projectId, p_plan: payload, p_fingerprint: pv.fingerprint });
    assert.equal(asB.error?.code, "P0002");
    assert.equal((await b.client.rpc("craft_remove_project", { p_user_id: a.id, p_project_id: m1.projectId })).error?.code, "42501");
    assert.equal((await b.client.rpc("craft_remove_project", { p_user_id: b.id, p_project_id: m1.projectId })).error?.code, "P0002");
    assert.equal(craftRowCount(m3.projectId), "0");
    assert.equal(psql(`SELECT count(*) FROM craft_parts WHERE project_id='${m1.projectId}';`), "8");
  });
  await test("anon: no EXECUTE on any 072 function", async () => {
    for (const [name, args] of [["craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: {}, p_fingerprint: "0".repeat(64) }], ["craft_remove_project", { p_user_id: a.id, p_project_id: m1.projectId }], ["craft_setup_fingerprint", { p_user_id: a.id, p_project_id: m1.projectId }]]) {
      const res = await anonClient.rpc(name, args);
      assert.equal(res.error?.code, "42501", `${name}: ${res.error?.message}`);
    }
  });
  await test("A plan that doesn't match the rows is refused whole (22023), nothing written", async () => {
    const pv = await preview(a, m3.projectId);
    const payload = craftSetupPayload(pv.plan, "knit", pv.plan.parts.map((p) => p.name));
    const bad = structuredClone(payload); bad.parts[0].rows[0].item_id = m3.id(fixtureItem("Mitten 1 · Cuff", "Cast on").id); bad.parts[0].rows[0].row = 1;
    const wrongTask = structuredClone(payload); wrongTask.parts[0].rows[3].item_id = payload.parts[2].rows[3].item_id;
    for (const plan of [bad, wrongTask, { ...payload, extra: 1 }, { ...payload, craft: "weave" }, { ...payload, parts: [] }]) {
      const res = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: plan, p_fingerprint: pv.fingerprint });
      assert.ok(["22023", "23505"].includes(res.error?.code), res.error?.message);
    }
    assert.equal(craftRowCount(m3.projectId), "0"); assert.equal(linkedCount(m3.projectId), "0");
  });
  await test("FR1 binding (Astra 3): a valid fingerprint with a tampered plan is refused whole (22023): word, total, stitches, ranges, missing or extra rows, split or dropped parts, active part", async () => {
    const pv = await preview(a, m3.projectId);
    const payload = craftSetupPayload(pv.plan, "knit", pv.plan.parts.map((p) => p.name));
    const tamper = (fn) => { const copy = structuredClone(payload); fn(copy); return copy; };
    const handSplit = (copy) => {
      const hand = copy.parts[1], gusset = structuredClone(hand);
      gusset.segments = [hand.segments[0]]; gusset.rows = hand.rows.filter((r) => r.row <= 17); gusset.total_rows = 17; gusset.name = "Gusset";
      hand.segments = [hand.segments[1]]; hand.rows = hand.rows.filter((r) => r.row >= 18);
      copy.parts.splice(1, 0, gusset);
    };
    const cases = {
      "row word": (c) => { c.parts[0].row_word = "row"; },
      "total rows": (c) => { c.parts[0].total_rows = 40; },
      "stitch count": (c) => { c.parts[0].stitch_count = 34; },
      "stitch count on a changing part": (c) => { c.parts[1].stitch_count = 36; },
      "segment range": (c) => { c.parts[1].segments[1].from_row = 19; },
      "a missing row": (c) => { c.parts[0].rows.pop(); },
      "a row with another number": (c) => { c.parts[0].rows[30].row = 30; c.parts[0].rows[29].row = 31; },
      "a dropped part": (c) => { c.parts.pop(); },
      "a split part": handSplit,
      "an extra part": (c) => { c.parts.push({ ...structuredClone(c.parts[3]), name: "Again" }); },
      "parts reordered": (c) => { c.parts.reverse(); },
      "active part": (c) => { c.active_part_index = 1; },
      "no active part": (c) => { c.active_part_index = null; },
      "a segment dropped": (c) => { c.parts[1].segments.pop(); },
    };
    for (const [label, fn] of Object.entries(cases)) {
      const res = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: tamper(fn), p_fingerprint: pv.fingerprint });
      assert.equal(res.error?.code, "22023", `${label}: ${res.error?.message ?? "accepted"}`);
      assert.equal(craftRowCount(m3.projectId), "0", label); assert.equal(linkedCount(m3.projectId), "0", label);
    }
    // Only part names and the craft kind are the caller's: segment names and sort orders come from the rows.
    const renamed = tamper((c) => { c.craft = "crochet"; c.parts[0].name = "  Left cuff  "; c.parts[0].segments[0].name = "Injected"; c.parts[0].sort_order = 9; c.parts[0].segments[0].sort_order = 9; });
    for (const bad of [tamper((c) => { c.parts[0].name = "x".repeat(81); }), tamper((c) => { c.parts[0].name = "   "; }), tamper((c) => { c.parts[0].name = "a\u0007b"; }), tamper((c) => { c.parts[0].name = 5; })]) {
      assert.equal((await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: bad, p_fingerprint: pv.fingerprint })).error?.code, "22023");
    }
    const ok = await a.client.rpc("craft_setup_project", { p_user_id: a.id, p_project_id: m3.projectId, p_plan: renamed, p_fingerprint: pv.fingerprint });
    assert.ifError(ok.error);
    assert.equal(psql(`SELECT name || '|' || sort_order FROM craft_parts WHERE project_id='${m3.projectId}' ORDER BY sort_order LIMIT 1;`), "Left cuff|0");
    assert.equal(psql(`SELECT s.name || '|' || s.sort_order FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE p.project_id='${m3.projectId}' AND p.sort_order = 0;`), `${pv.plan.parts[0].segments[0].name}|0`);
    assert.equal(psql(`SELECT craft FROM craft_projects WHERE project_id='${m3.projectId}';`), "crochet");
    assert.equal(linkedCount(m3.projectId), "198");
    assert.equal((await remove(a, m3.projectId)).status, 200);
  });

  // ── Remove ──────────────────────────────────────────────────────────
  await test("Remove: refuses while a note, a link or a craft sitting detail exists (FR1; S2 carry-over a); then unlinks first and the craft rows go; items byte-identical apart from the two craft columns; sittings stay", async () => {
    const parts = (await a.client.from("craft_parts").select("id, name").eq("project_id", m1.projectId).order("sort_order")).data;
    const cuffRows = (await a.client.from("task_checklist_items").select("id").eq("craft_part_id", parts[0].id).lte("craft_row", 3)).data.map((r) => r.id);
    const s = await a.client.rpc("work_session_create", { p_user_id: a.id, p_session: { project_id: m1.projectId, session_date: "2026-11-10", minutes: 25, note: "cuff" }, p_item_ids: cuffRows, p_mark_done: false });
    assert.ifError(s.error);
    assert.ifError((await admin.from("craft_sitting_details").insert({ user_id: a.id, session_id: s.data.session_id, part_id: parts[0].id, from_row: 0, to_row: 3 })).error);
    assert.ifError((await admin.from("craft_notes").insert({ user_id: a.id, project_id: m1.projectId, part_id: parts[0].id, text: "Rnd 3: tight" })).error);
    assert.ifError((await admin.from("craft_links").insert({ user_id: a.id, project_id: m1.projectId, kind: "web", title: "Pattern", url: "https://example.test/mittens" })).error);
    const sessions = () => psql(`SELECT md5(coalesce(string_agg(row_to_json(w)::text, ',' ORDER BY w.id), '')) FROM work_sessions w WHERE project_id='${m1.projectId}'; SELECT md5(coalesce(string_agg(session_id::text||checklist_item_id::text, ',' ORDER BY session_id, checklist_item_id), '')) FROM work_session_items WHERE session_id='${s.data.session_id}';`);
    const tasksHash = () => psql(`SELECT md5(coalesce(string_agg(row_to_json(t)::text, ',' ORDER BY t.id), '')) FROM tasks t WHERE project_id='${m1.projectId}';`);
    const sessionsBefore = sessions(), tasksBefore = tasksHash();
    // FR1 (F1): the note and the link can't be made again by Set up, so Remove refuses first and changes nothing.
    const stateBefore = craftState(m1.projectId);
    const refused = await remove(a, m1.projectId);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "This project can’t be removed from the craft screen: it has links, notes and craft screen sittings that Set up can’t make again.", reason: "keeps" });
    assert.equal(craftState(m1.projectId), stateBefore);
    const kept = await (await detailRoute.GET(routeReq(a, "GET", `/api/craft/${m1.projectId}`), ctx(m1.projectId))).json();
    assert.deepEqual([kept.can_remove, kept.remove_blockers], [false, ["links", "notes", "sittings"]]);
    psql(`DELETE FROM craft_notes WHERE project_id='${m1.projectId}'; DELETE FROM craft_links WHERE project_id='${m1.projectId}';`);
    // S2 carry-over a (073): a craft sitting detail on one of the parts still blocks Remove, which would clear its part.
    const beforeSitting = craftState(m1.projectId);
    const sittingKept = await remove(a, m1.projectId);
    assert.deepEqual([sittingKept.status, (await sittingKept.json()).error], [409, "This project can’t be removed from the craft screen: it has craft screen sittings that Set up can’t make again."]);
    assert.equal(craftState(m1.projectId), beforeSitting, "nothing changed");
    assert.equal(psql(`SELECT part_id FROM craft_sitting_details WHERE session_id='${s.data.session_id}';`), parts[0].id);
    psql(`DELETE FROM craft_sitting_details WHERE session_id='${s.data.session_id}';`);
    const res = await remove(a, m1.projectId);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { project_id: m1.projectId, items_unlinked: 198, parts_removed: 8, segments_removed: 10 });
    assert.equal(linkedCount(m1.projectId), "0");
    assert.equal(craftRowCount(m1.projectId), "0");
    assert.equal(psql(`SELECT count(*) FROM craft_segments WHERE part_id IN ('${parts.map((p) => p.id).join("','")}');`), "0");
    assert.equal(psql(itemsSql(m1.projectId)), before.all, "every column of every item is as before setup");
    assert.equal(sessions(), sessionsBefore, "sittings and their row links unchanged");
    assert.equal(tasksHash(), tasksBefore, "tasks unchanged (actual_minutes included)");
    assert.equal(psql(`SELECT count(*) FROM work_sessions WHERE id='${s.data.session_id}';`), "1", "the sitting itself stays");
    assert.equal((await remove(a, m1.projectId)).status, 404, "removing again is a 404");
  });
  await test("Setup → Remove → setup again gives the same plan and fingerprint, and Create works again", async () => {
    const again = await preview(a, m1.projectId);
    assert.equal(again.fingerprint, firstPreview.fingerprint);
    assert.deepEqual(again.plan, firstPreview.plan);
    const res = await create(a, m1.projectId, again, { names: again.plan.parts.map((p, i) => (i === 0 ? "Left cuff" : p.name)), craft: "other" });
    assert.equal(res.status, 201);
    assert.equal(psql(`SELECT name FROM craft_parts WHERE project_id='${m1.projectId}' ORDER BY sort_order LIMIT 1;`), "Left cuff");
    assert.equal(psql(`SELECT craft FROM craft_projects WHERE project_id='${m1.projectId}';`), "other");
    assert.equal(linkedCount(m1.projectId), "198");
  });
  await test("FR1 Remove (F1/Astra 4): each thing Set up can't remake makes Remove refuse (MC72R → 409) with nothing changed; blanket- and scarf-shaped setups refuse; the mittens after Create remove cleanly", async () => {
    const seeded = await seedMittens(a.id, "Mittens remove guard");
    assert.equal((await create(a, seeded.projectId, await preview(a, seeded.projectId))).status, 201);
    const pid = seeded.projectId;
    const part0 = psql(`SELECT id FROM craft_parts WHERE project_id='${pid}' ORDER BY sort_order LIMIT 1;`);
    const seg0 = psql(`SELECT s.id FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE p.project_id='${pid}' ORDER BY p.sort_order, s.sort_order LIMIT 1;`);
    const blockers = {
      links: [`INSERT INTO craft_links (user_id, project_id, kind, title, url) VALUES ('${a.id}','${pid}','pdf','Pattern PDF','https://example.test/p.pdf')`, `DELETE FROM craft_links WHERE project_id='${pid}'`],
      instructions: [`INSERT INTO craft_instructions (user_id, part_id, kind, from_row, to_row, text) VALUES ('${a.id}','${part0}','marker',1,1,'Place marker')`, `DELETE FROM craft_instructions WHERE part_id='${part0}'`],
      notes: [`INSERT INTO craft_notes (user_id, project_id, text) VALUES ('${a.id}','${pid}','Tight cast-on')`, `DELETE FROM craft_notes WHERE project_id='${pid}'`],
      yarn: [`INSERT INTO craft_yarns (user_id, project_id, name) VALUES ('${a.id}','${pid}','Worsted')`, `DELETE FROM craft_yarns WHERE project_id='${pid}'`],
      timer: [`INSERT INTO craft_timers (user_id, project_id, sitting_started_at, start_row) VALUES ('${a.id}','${pid}', now(), 15)`, `DELETE FROM craft_timers WHERE user_id='${a.id}'`],
      gear: [`UPDATE craft_projects SET gear='US 7 needles' WHERE project_id='${pid}'`, `UPDATE craft_projects SET gear=NULL WHERE project_id='${pid}'`],
      quarters: [`UPDATE craft_parts SET quarters=true WHERE id='${part0}'`, `UPDATE craft_parts SET quarters=false WHERE id='${part0}'`],
      "quarter set": [`UPDATE craft_parts SET quarter=2, quarter_row=15 WHERE id='${part0}'`, `UPDATE craft_parts SET quarter=0, quarter_row=NULL WHERE id='${part0}'`, "quarters"],
      ridges: [`UPDATE craft_parts SET ridges=true WHERE id='${part0}'`, `UPDATE craft_parts SET ridges=false WHERE id='${part0}'`],
      close_checks: [`UPDATE craft_segments SET close_check=true WHERE id='${seg0}'`, `UPDATE craft_segments SET close_check=false WHERE id='${seg0}'`],
    };
    for (const [label, [add, undo, key = label]] of Object.entries(blockers)) {
      psql(`${add};`);
      const before = craftState(pid);
      const direct = await a.client.rpc("craft_remove_project", { p_user_id: a.id, p_project_id: pid });
      assert.equal(direct.error?.code, "MC72R", `${label}: ${direct.error?.message ?? "removed"}`);
      assert.equal(direct.error?.details, key, label);
      assert.equal(craftState(pid), before, `${label}: nothing changed`);
      assert.deepEqual((await a.client.rpc("craft_remove_blockers", { p_user_id: a.id, p_project_id: pid })).data, [key]);
      psql(`${undo};`);
    }
    // Blanket-shaped (close checks on every band, gear, a pattern link) and scarf-shaped (quarters, ridges, a PDF and a marker).
    psql(`UPDATE craft_segments SET close_check=true WHERE part_id IN (SELECT id FROM craft_parts WHERE project_id='${pid}'); UPDATE craft_projects SET gear='5 mm hook' WHERE project_id='${pid}'; ${blockers.links[0]};`);
    let before = craftState(pid), res = await remove(a, pid);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This project can’t be removed from the craft screen: it has links, gear notes and band checks that Set up can’t make again.", reason: "keeps" });
    assert.equal(craftState(pid), before);
    psql(`UPDATE craft_segments SET close_check=false WHERE part_id IN (SELECT id FROM craft_parts WHERE project_id='${pid}'); UPDATE craft_projects SET gear=NULL WHERE project_id='${pid}';`);
    psql(`UPDATE craft_parts SET quarters=true, ridges=true, quarter=1, quarter_row=15 WHERE id='${part0}'; ${blockers.instructions[0]};`);
    before = craftState(pid); res = await remove(a, pid);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /links, instructions, quarter rows and ridge counts/);
    assert.equal(craftState(pid), before);
    psql(`${blockers.links[1]}; ${blockers.instructions[1]}; UPDATE craft_parts SET quarters=false, ridges=false, quarter=0, quarter_row=NULL WHERE id='${part0}';`);
    // The mittens as Create made them: Remove is offered and works.
    const view = await (await detailRoute.GET(routeReq(a, "GET", `/api/craft/${pid}`), ctx(pid))).json();
    assert.deepEqual([view.can_remove, view.remove_blockers], [true, []]);
    res = await remove(a, pid);
    assert.equal(res.status, 200);
    assert.equal(linkedCount(pid), "0"); assert.equal(craftRowCount(pid), "0");
  });
  await test("Gaps on a real project: (est.) rounds 22–28 deleted, setup makes a 31-round cuff of 24 rows and the screen counts them", async () => {
    const m4 = await seedMittens(a.id, "Mittens copy 4");
    const cuff = m4.id(fixture.tasks.find((t) => t.title.startsWith("Mitten 1 · Cuff")).id);
    psql(`DELETE FROM task_checklist_items WHERE task_id='${cuff}' AND text ~ '^Rnd 2[2-8] ';`);
    const pv = await preview(a, m4.projectId);
    assert.deepEqual(pv.plan.parts[0].gap_notes, ["Rounds 22–28 are not in the list; the screen goes from 21 to 29."]);
    assert.equal((await create(a, m4.projectId, pv)).status, 201);
    psql(`UPDATE task_checklist_items SET is_done = true WHERE task_id='${cuff}' AND text ~ '^Rnd (1[5-9]|2[01]) ';`);
    const view = await (await detailRoute.GET(routeReq(a, "GET", `/api/craft/${m4.projectId}`), ctx(m4.projectId))).json();
    assert.deepEqual([view.active_part.current_row, view.active_part.done_rows, view.active_part.row_count, view.active_part.total_rows], [29, 21, 24, 31]);
    assert.deepEqual(view.next_rows.map((r) => r.row), [29, 30, 31]);
  });

  // ── Rollback ────────────────────────────────────────────────────────
  await test("072 down returns the schema to 071 (functions and rights), keeps craft rows; 072 re-applies", () => {
    const data = () => psql(`SELECT count(*) FROM craft_parts; SELECT count(*) FROM task_checklist_items WHERE craft_part_id IS NOT NULL;`);
    const kept = data();
    psql(down073);
    psql(down072);
    assert.equal(functionNames(), functions071);
    assert.equal(rights(), rights071);
    assert.equal(data(), kept);
    psql(up072);
    psql(up073);
    assert.ok(functionNames().includes("craft_setup_project"));
    assert.equal(psql("SELECT has_table_privilege('authenticated','craft_parts','TRUNCATE');"), "f");
  });
  await test("FR1 rollback ACLs (F5/Astra 5): with narrower default privileges, 072 down gives back only what a fresh 071 left (service_role without TRUNCATE/MAINTAIN stays without)", () => {
    const narrow = "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, MAINTAIN ON TABLES FROM service_role;";
    const widen = "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE, MAINTAIN ON TABLES TO service_role;";
    try {
      if (has073()) psql(down073);
      psql(down072); psql(down071); psql(narrow); psql(up071);
      const fresh = rights();
      assert.ok(fresh.includes("craft_parts:service_role:TRUNCATE:false") && fresh.includes("craft_parts:authenticated:TRUNCATE:true"), "the fresh 071 follows the narrowed defaults");
      psql(up072);
      assert.equal(psql("SELECT has_table_privilege('authenticated','craft_parts','TRUNCATE');"), "f");
      psql(down072);
      assert.equal(rights(), fresh, "down restored exactly the fresh 071 rights");
    } finally {
      psql(widen);
      if (has073()) psql(down073);
      if (functionNames().includes("craft_setup_project")) psql(down072);
      psql(down071); psql(up071); psql(up072);
    }
    assert.equal(functionNames(), FUNCTIONS_072);
    psql(up073);
    assert.equal(psql("SELECT has_table_privilege('service_role','craft_parts','SELECT') AND NOT has_table_privilege('service_role','craft_parts','TRUNCATE');"), "t", "the stack is left with 072 applied over a fresh 071");
  });
} finally {
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft setup DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
