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
const FUNCTIONS = ["craft_setup_fingerprint(uuid,uuid)", "craft_setup_lock(uuid,uuid)", "craft_setup_project(uuid,uuid,jsonb,text)", "craft_remove_project(uuid,uuid)"];
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

let rights071, functions071;
try {
  // The stack's 071 state: 072 rolled back (up.sh's GRANT ALL already gave the API roles everything, like hosted).
  await test("072 rolls back to the 071 state, then applies on top of 071", () => {
    if (functionNames().includes("craft_setup_project")) psql(down072);
    rights071 = rights(); functions071 = functionNames();
    assert.equal(functions071, "craft_check_ownership,craft_checklist_clear_deleted_part");
    psql(up072);
    assert.equal(functionNames(), "craft_check_ownership,craft_checklist_clear_deleted_part,craft_remove_project,craft_setup_fingerprint,craft_setup_lock,craft_setup_project");
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
    assert.ok(rights071.includes("craft_parts:service_role:TRUNCATE:true"), "the 071 state on this stack had them (like hosted)");
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

  // ── Remove ──────────────────────────────────────────────────────────
  await test("Remove: unlinks first, then the craft rows go; items byte-identical apart from the two craft columns; sittings and links stay", async () => {
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
    const res = await remove(a, m1.projectId);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { project_id: m1.projectId, items_unlinked: 198, parts_removed: 8, segments_removed: 10 });
    assert.equal(linkedCount(m1.projectId), "0");
    assert.equal(craftRowCount(m1.projectId), "0");
    assert.equal(psql(`SELECT count(*) FROM craft_segments WHERE part_id IN ('${parts.map((p) => p.id).join("','")}');`), "0");
    assert.equal(psql(itemsSql(m1.projectId)), before.all, "every column of every item is as before setup");
    assert.equal(sessions(), sessionsBefore, "sittings and their row links unchanged");
    assert.equal(tasksHash(), tasksBefore, "tasks unchanged (actual_minutes included)");
    assert.equal(psql(`SELECT part_id IS NULL FROM craft_sitting_details WHERE session_id='${s.data.session_id}';`), "t", "the sitting detail stays, its part cleared");
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
    psql(down072);
    assert.equal(functionNames(), functions071);
    assert.equal(rights(), rights071);
    assert.equal(data(), kept);
    psql(up072);
    assert.ok(functionNames().includes("craft_setup_project"));
    assert.equal(psql("SELECT has_table_privilege('authenticated','craft_parts','TRUNCATE');"), "f");
  });
} finally {
  for (const id of users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) { failed++; console.error("cleanup failed", error.message); }
  }
}
console.log(`\nCraft setup DB: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
