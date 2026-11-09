#!/usr/bin/env node
// Destructive only to this disposable local stack; own CRAFT_TEST_* namespace.
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
const migration = readFileSync(new URL("../supabase/migrations/071_add_craft_tables.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("../supabase/rollbacks/071_add_craft_tables.down.sql", import.meta.url), "utf8");
const psql = (sql) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const asyncSql = (sql) => new Promise(resolve => { const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"]); let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(sql); });
// Interactive sessions make the reviewed lock order reproducible, without timing luck.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function connection(label) {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-q", "-t", "-A"]);
    let output = "";
    child.stdout.on("data", c => output += c);
    child.stderr.on("data", c => output += c);
    const closed = new Promise(resolve => child.on("close", resolve));
    return {
        send: sql => child.stdin.write(sql + "\n"),
        output: () => output,
        async wait(marker) {
            for (let i = 0; i < 200; i++) {
                if (output.includes(marker) || output.includes("ERROR:")) return;
                await sleep(25);
            }
            throw new Error(`${label}: missing ${marker}: ${output}`);
        },
        async end() { child.stdin.end(); await closed; },
    };
}
async function childTaskRace(lockSql, childSql, parentSql) {
    const parent = connection("parent"), child = connection("child");
    const label = `craft-race-${randomUUID()}`;
    try {
        parent.send(`BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL deadlock_timeout='100ms'; ${lockSql} SELECT 'parent-ready';`);
        await parent.wait("parent-ready");
        assert.doesNotMatch(parent.output(), /ERROR:/);
        child.send(`BEGIN; SET LOCAL application_name='${label}'; SET LOCAL statement_timeout='5s'; SET LOCAL deadlock_timeout='100ms'; ${childSql} ROLLBACK; SELECT 'child-done';`);
        let reached = false;
        for (let i = 0; i < 100; i++) {
            if (/child-done|ERROR:/.test(child.output()) || psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${label}' AND wait_event_type='Lock'`) === "1") { reached = true; break; }
            await sleep(10);
        }
        assert.ok(reached, "child completed or reached the task lock");
        parent.send(`${parentSql} ROLLBACK; SELECT 'parent-done';`);
        await Promise.all([parent.wait("parent-done"), child.wait("child-done")]);
    } finally {
        await Promise.all([parent.end(), child.end()]);
    }
    return parent.output() + child.output();
}
let passed = 0, failed = 0;
async function test(name, fn) { try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}
catch (e) {
    failed++;
    console.error(`FAIL - ${name}`, e.message, e.stderr?.toString());
} }
async function insert(table, row) { const { data, error } = await admin.from(table).insert(row).select().single(); if (error)
    throw error; return data; }
async function rejects(table, row, code = "23503") { const { error } = await admin.from(table).insert(row); assert.equal(error?.code, code, `${table}: ${error?.message ?? "unexpected success"}`); }
const users = [];
async function user() { const password = randomUUID(); const email = `craft-${randomUUID()}@example.test`; const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (error)
    throw error; users.push(data.user.id); const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }); const login = await client.auth.signInWithPassword({ email, password }); if (login.error)
    throw login.error; return { id: data.user.id, client }; }
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
process.env.SUPABASE_SERVICE_ROLE_KEY = key;
process.env.MISSION_CONTROL_API_KEY = `craft-test-${randomUUID()}`;
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const craftRoute = await import("../src/app/api/craft/route.ts");
const craftDetailRoute = await import("../src/app/api/craft/[projectId]/route.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
try {
    const a = await user(), b = await user();
    process.env.MISSION_CONTROL_USER_ID = a.id;
    const project = await insert("projects", { user_id: a.id, name: "Craft local A" });
    const project2 = await insert("projects", { user_id: a.id, name: "Craft local B" });
    const foreign = await insert("projects", { user_id: b.id, name: "Craft other" });
    const task = await insert("tasks", { user_id: a.id, project_id: project.id, title: "Rows", status: "Planned" });
    const task2 = await insert("tasks", { user_id: a.id, project_id: project2.id, title: "Other project", status: "Planned" });
    const foreignTask = await insert("tasks", { user_id: b.id, project_id: foreign.id, title: "Other owner", status: "Planned" });
    await insert("craft_projects", { user_id: a.id, project_id: project.id, craft: "knit" });
    await insert("craft_projects", { user_id: a.id, project_id: project2.id, craft: "crochet" });
    const makePart = (owner, proj, name) => insert("craft_parts", { user_id: owner, project_id: proj, name, total_rows: 3 });
    const p = await makePart(a.id, project.id, "Body"), p2 = await makePart(a.id, project2.id, "Blanket"), fp = await makePart(b.id, foreign.id, "Foreign");
    const makeSession = (owner, proj, day) => insert("work_sessions", { user_id: owner, project_id: proj, session_date: day, minutes: 20 });
    const s = await makeSession(a.id, project.id, "2026-11-08"), s2 = await makeSession(a.id, project2.id, "2026-11-07"), fs = await makeSession(b.id, foreign.id, "2026-11-08");
    const seg = await insert("craft_segments", { user_id: a.id, part_id: p.id, task_id: task.id, name: "Band", from_row: 1, to_row: 3 });
    const seg2 = await insert("craft_segments", { user_id: a.id, part_id: p2.id, name: "Other band", from_row: 1, to_row: 3 });
    const fseg = await insert("craft_segments", { user_id: b.id, part_id: fp.id, name: "Foreign band", from_row: 1, to_row: 3 });
    const link = await insert("craft_links", { user_id: a.id, project_id: project.id, part_id: p.id, segment_id: seg.id, kind: "pdf", title: "Pattern", url: "https://example.test/pattern" });
    const link2 = await insert("craft_links", { user_id: a.id, project_id: project2.id, kind: "web", title: "Other", url: "https://example.test/other" });
    const flink = await insert("craft_links", { user_id: b.id, project_id: foreign.id, kind: "web", title: "Foreign", url: "https://example.test/foreign" });
    const fixtures = {
        craft_projects: { user_id: a.id, project_id: project.id, craft: "knit" },
        craft_parts: { user_id: a.id, project_id: project.id, name: "Part", total_rows: 3 },
        craft_segments: { user_id: a.id, part_id: p.id, name: "Band", from_row: 1, to_row: 3 },
        craft_timers: { user_id: a.id, project_id: project.id, part_id: p.id, sitting_started_at: "2026-11-08T12:00:00Z", start_row: 1 },
        craft_sitting_details: { user_id: a.id, session_id: s.id, part_id: p.id, from_row: 1, to_row: 2 },
        craft_notes: { user_id: a.id, project_id: project.id, part_id: p.id, session_id: s.id, text: "Note" },
        craft_links: { user_id: a.id, project_id: project.id, part_id: p.id, kind: "web", title: "Pattern", url: "https://example.test" },
        craft_instructions: { user_id: a.id, part_id: p.id, from_row: 1, to_row: 3, kind: "instruction", text: "Knit", link_id: link.id },
        craft_yarns: { user_id: a.id, project_id: project.id, part_id: p.id, name: "Wool" },
    };
    // Ensure every table has an owned row before trying the other user's SELECT.
    for (const t of ["craft_timers", "craft_sitting_details", "craft_notes", "craft_instructions", "craft_yarns"])
        await insert(t, fixtures[t]);
    for (const [table, row] of Object.entries(fixtures)) {
        await test(`${table}: four RLS policies, grants and updated_at trigger`, () => {
            assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE tablename='${table}'`), "4");
            for (const role of ["authenticated", "service_role"])
                assert.equal(psql(`SELECT bool_and(has_table_privilege('${role}','${table}', privilege)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege`), "t");
            assert.equal(psql(`SELECT count(*) FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='trg_${table}_updated'`), "1");
        });
        await test(`${table}: anon and PUBLIC have no table privileges`, () => {
            assert.equal(psql(`SELECT bool_or(has_table_privilege('anon','${table}', privilege)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS privilege`), "f");
            assert.equal(psql(`SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) acl WHERE c.oid='${table}'::regclass AND acl.grantee=0`), "0");
        });
        await test(`${table}: other user sees none and cannot insert/update/delete`, async () => {
            const seen = await b.client.from(table).select("*").eq("user_id", a.id);
            assert.ifError(seen.error);
            assert.equal(seen.data.length, 0);
            const result = await b.client.from(table).insert(row);
            assert.ok(["42501", "23503"].includes(result.error?.code), result.error?.message); // BEFORE ownership checks may reject before the RLS WITH CHECK.
            const changed = await b.client.from(table).update({ updated_at: "2020-01-01T00:00:00Z" }).eq("user_id", a.id).select();
            assert.ifError(changed.error);
            assert.equal(changed.data.length, 0);
            const deleted = await b.client.from(table).delete().eq("user_id", a.id).select();
            assert.ifError(deleted.error);
            assert.equal(deleted.data.length, 0);
        });
    }
    for (const table of ["craft_projects", "craft_parts", "craft_timers", "craft_notes", "craft_links", "craft_yarns"]) {
        await test(`${table}: service-role rejects cross-user project`, async () => { const row = { ...fixtures[table], project_id: foreign.id }; if (table === "craft_timers") {
            row.user_id = b.id;
            row.project_id = project.id;
        } await rejects(table, row); });
    }
    for (const table of ["craft_segments", "craft_timers", "craft_sitting_details", "craft_notes", "craft_links", "craft_instructions", "craft_yarns"]) {
        await test(`${table}: cross-user part refused`, async () => { await rejects(table, { ...fixtures[table], part_id: fp.id }); });
        // Part-only rows derive project from their part: use task/link to anchor it.
        await test(`${table}: cross-project reference refused`, async () => {
            const row = { ...fixtures[table], part_id: p2.id };
            if (table === "craft_segments")
                row.task_id = task.id;
            await rejects(table, row);
        });
    }
    await test("craft_projects: active part must have same owner and project", async () => { for (const id of [p2.id, fp.id]) {
        const { error } = await admin.from("craft_projects").update({ active_part_id: id }).eq("project_id", project.id);
        assert.equal(error?.code, "23503");
    } });
    await test("segments: task must have same owner and project", async () => { for (const id of [task2.id, foreignTask.id])
        await rejects("craft_segments", { ...fixtures.craft_segments, task_id: id }); });
    await test("notes: session must have same owner and project", async () => { for (const id of [s2.id, fs.id])
        await rejects("craft_notes", { ...fixtures.craft_notes, session_id: id }); });
    await test("sitting detail session owner rejected even with no part", async () => { await rejects("craft_sitting_details", { ...fixtures.craft_sitting_details, session_id: fs.id, part_id: null }); });
    await test("links: segment must have same owner and project", async () => { for (const id of [seg2.id, fseg.id])
        await rejects("craft_links", { ...fixtures.craft_links, segment_id: id }); });
    await test("instructions: link must have same owner and project", async () => { for (const id of [link2.id, flink.id])
        await rejects("craft_instructions", { ...fixtures.craft_instructions, link_id: id }); });
    const item = await insert("task_checklist_items", { user_id: a.id, task_id: task.id, text: "Row 1", craft_part_id: p.id, craft_row: 1, is_done: true });
    await insert("work_session_items", { user_id: a.id, session_id: s.id, checklist_item_id: item.id });
    // Roll back even a vulnerable successful UPDATE, so fail-before tests do not
    // contaminate later assertions. SET ROLE exercises the real owner RLS path.
    const anchorCases = Object.keys(fixtures).map(table => [table, "user_id", b.id]);
    anchorCases.push(["craft_parts", "project_id", project2.id], ["craft_links", "project_id", project2.id], ["craft_segments", "part_id", p2.id]);
    for (const [table, column, value] of anchorCases) {
        for (const role of ["authenticated", "service_role"]) {
            await test(`${table}.${column}: immutable for ${role} (55006)`, async () => {
                const result = await asyncSql(`\\set VERBOSITY verbose
BEGIN; SET LOCAL ROLE ${role}; SET LOCAL request.jwt.claim.sub='${a.id}'; SET LOCAL row_security=on;
UPDATE ${table} SET ${column}='${value}' WHERE user_id='${a.id}'; ROLLBACK;`);
                assert.match(result.stderr, /55006/, result.stderr || "anchor UPDATE unexpectedly succeeded");
                assert.match(result.stderr, /cannot change/i);
            });
        }
    }
    for (const role of ["authenticated", "service_role"]) {
        await test(`review repro: populated part A→B is refused for ${role}`, async () => {
            assert.equal(psql(`SELECT count(*) FROM task_checklist_items WHERE craft_part_id='${p.id}'`), "1");
            assert.equal(psql(`SELECT count(*) FROM craft_segments WHERE part_id='${p.id}' AND task_id='${task.id}'`), "1");
            const result = await asyncSql(`\\set VERBOSITY verbose
BEGIN; SET LOCAL ROLE ${role}; SET LOCAL request.jwt.claim.sub='${a.id}'; SET LOCAL row_security=on;
UPDATE craft_parts SET project_id='${project2.id}' WHERE id='${p.id}'; ROLLBACK;`);
            assert.match(result.stderr, /55006/, result.stderr || "populated part moved");
        });
    }
    await test("30 work_session_create vs craft_row-only UPDATE races: zero 40P01", async () => {
        const t = await insert("tasks", { user_id: a.id, project_id: project2.id, title: "Craft row race" });
        const part = await makePart(a.id, project2.id, "Race");
        const row = await insert("task_checklist_items", { user_id: a.id, task_id: t.id, text: "Row", craft_part_id: part.id, craft_row: 1 });
        let deadlocks = 0, errors = 0;
        for (let i = 0; i < 30; i++) {
            const output = await childTaskRace(
                `SELECT id FROM tasks WHERE id='${t.id}' FOR NO KEY UPDATE;`,
                `UPDATE task_checklist_items SET craft_row=2 WHERE id='${row.id}';`,
                `SELECT work_session_create('${a.id}', '{"project_id":"${project2.id}","task_id":"${t.id}","session_date":"2026-11-08","minutes":1}'::jsonb, ARRAY['${row.id}']::uuid[], true);`);
            deadlocks += (output.match(/ERROR:  40P01/g) ?? []).length;
            errors += (output.match(/ERROR:/g) ?? []).length;
        }
        console.log(`    craft-row races: 30; 40P01=${deadlocks}; total errors=${errors}`);
        assert.equal(deadlocks, 0);
        assert.equal(errors, 0);
    });
    await test("segment task_id UPDATE vs task DELETE: zero 40P01, busy retry allowed", async () => {
        const oldTask = await insert("tasks", { user_id: a.id, project_id: project2.id, title: "Segment old task" });
        const newTask = await insert("tasks", { user_id: a.id, project_id: project2.id, title: "Segment new task" });
        const segment = await insert("craft_segments", { ...fixtures.craft_segments, part_id: p2.id, task_id: oldTask.id });
        const output = await childTaskRace(
            `SELECT id FROM tasks WHERE id='${newTask.id}' FOR UPDATE;`,
            `UPDATE craft_segments SET task_id='${newTask.id}' WHERE id='${segment.id}';`,
            `DELETE FROM tasks WHERE id='${oldTask.id}';`);
        console.log(`    segment/delete race: 40P01=${(output.match(/ERROR:  40P01/g) ?? []).length}; 55P03=${(output.match(/ERROR:  55P03/g) ?? []).length}`);
        assert.doesNotMatch(output, /40P01/);
        assert.match(output, /55P03.*busy, retry/);
        assert.equal((output.match(/ERROR:/g) ?? []).length, 1);
    });
    await test("checklist reference UPDATE uses busy retry under a held task lock", async () => {
        const part = await makePart(a.id, project2.id, "Reference race");
        const row = await insert("task_checklist_items", { user_id: a.id, task_id: task2.id, text: "Reference race", craft_part_id: part.id, craft_row: 1 });
        const output = await childTaskRace(
            `SELECT id FROM tasks WHERE id='${task2.id}' FOR NO KEY UPDATE;`,
            `UPDATE task_checklist_items SET craft_part_id='${p2.id}' WHERE id='${row.id}';`,
            `SELECT id FROM task_checklist_items WHERE id='${row.id}' FOR UPDATE;`);
        assert.doesNotMatch(output, /40P01/);
        assert.match(output, /55P03.*busy, retry/);
        assert.equal((output.match(/ERROR:/g) ?? []).length, 1);
    });
    await test("checklist: cross-user part, cross-project part and task refused", async () => { for (const [part, taskId] of [[fp.id, task.id], [p2.id, task.id], [p.id, task2.id], [p.id, foreignTask.id]])
        await rejects("task_checklist_items", { user_id: a.id, task_id: taskId, text: "Row 2", craft_part_id: part, craft_row: 2 }); });
    await test("checklist pair CHECK, positive rows, partial UNIQUE and ordinary null rows", async () => {
        for (const extra of [{ craft_part_id: p.id }, { craft_row: 2 }, { craft_part_id: p.id, craft_row: 0 }])
            await rejects("task_checklist_items", { user_id: a.id, task_id: task.id, text: "Bad", ...extra }, "23514");
        await rejects("task_checklist_items", { user_id: a.id, task_id: task.id, text: "Duplicate", craft_part_id: p.id, craft_row: 1 }, "23505");
        for (let i = 0; i < 2; i++)
            await insert("task_checklist_items", { user_id: a.id, task_id: task.id, text: "Plain" });
    });
    for (const [table, field, value] of [["craft_projects", "craft", "sew"], ["craft_projects", "gear", "x".repeat(501)], ["craft_parts", "name", "x".repeat(81)], ["craft_parts", "total_rows", 0], ["craft_parts", "row_word", "ridge"], ["craft_parts", "quarter", 4], ["craft_parts", "quarter_row", 0], ["craft_parts", "stitch_count", 0], ["craft_segments", "name", "x".repeat(81)], ["craft_segments", "from_row", 0], ["craft_segments", "to_row", 0], ["craft_timers", "banked_seconds", -1], ["craft_timers", "start_row", 0], ["craft_timers", "start_quarter", 4], ["craft_timers", "version", -1], ["craft_sitting_details", "from_row", -1], ["craft_sitting_details", "from_quarter", 4], ["craft_sitting_details", "to_row", 0], ["craft_sitting_details", "to_quarter", 4], ["craft_sitting_details", "in_progress_row", 0], ["craft_notes", "text", "x".repeat(1001)], ["craft_notes", "row", 0], ["craft_instructions", "kind", "bad"], ["craft_instructions", "text", "x".repeat(1001)], ["craft_instructions", "every_rows", 0], ["craft_instructions", "page", 0], ["craft_links", "kind", "bad"], ["craft_links", "title", "x".repeat(121)], ["craft_links", "url", "http://example.test"], ["craft_links", "url", "https://" + "x".repeat(2000)], ["craft_links", "page", 0], ["craft_links", "start_seconds", -1], ["craft_yarns", "role", "x".repeat(41)], ["craft_yarns", "name", "x".repeat(121)], ["craft_yarns", "color", "x".repeat(61)], ["craft_yarns", "weight", "x".repeat(31)], ["craft_yarns", "yards_per_skein", -1], ["craft_yarns", "skeins_on_hand", -1], ["craft_yarns", "yards_needed", -1]]) {
        await test(`${table}: CHECK ${field} rejects invalid value`, async () => { const pk = table === "craft_projects" ? "project_id" : table === "craft_timers" ? "user_id" : table === "craft_sitting_details" ? "session_id" : "id"; const { data } = await admin.from(table).select(pk).eq("user_id", a.id).limit(1).single(); const { error } = await admin.from(table).update({ [field]: value }).eq(pk, data[pk]); assert.equal(error?.code, "23514", error?.message); });
    }
    await test("task project move: craft-only guard returns SQLSTATE 55006", async () => {
        const t = await insert("tasks", { user_id: a.id, project_id: project.id, title: "Only craft", status: "Planned" });
        await insert("task_checklist_items", { user_id: a.id, task_id: t.id, text: "Row 2", craft_part_id: p.id, craft_row: 2 });
        const { error } = await admin.from("tasks").update({ project_id: project2.id }).eq("id", t.id);
        assert.equal(error?.code, "55006");
        const req = new NextRequest(`http://localhost/api/tasks/${t.id}`, { method: "PATCH", headers: { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ project_id: project2.id }) });
        const res = await taskRoute.PATCH(req, { params: Promise.resolve({ id: t.id }) });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).error, "This task has sittings or craft rows, so it can't move to another project.");
    });
    await test("task lock serializes a craft insert against a concurrent project move", async () => {
        const t = await insert("tasks", { user_id: a.id, project_id: project.id, title: "Lock test", status: "Planned" });
        const job = asyncSql(`BEGIN; INSERT INTO task_checklist_items(user_id,task_id,text,craft_part_id,craft_row) VALUES('${a.id}','${t.id}','Row 3','${p.id}',3); SELECT pg_sleep(1.5); COMMIT;`);
        let locked = false;
        for (let i = 0; i < 30; i++) {
            if (psql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(1.5)%' AND state='active' AND pid <> pg_backend_pid()`) !== "0") {
                locked = true;
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        assert.ok(locked);
        const moved = await admin.from("tasks").update({ project_id: project2.id }).eq("id", t.id);
        assert.equal(moved.error?.code, "55006");
        assert.equal((await job).code, 0);
    });
    const routeRequest = (client, path) => { const req = new NextRequest(`http://localhost${path}`); writeInternalAuthContext(req, { supabase: client, userId: a.id, user: { id: a.id }, authSource: "session" }); return req; };
    await test("GET /api/craft picks latest session (not newest craft row); RLS loader returns linked rows", async () => { const res = await craftRoute.GET(routeRequest(a.client, "/api/craft")); assert.equal(res.status, 200); const view = await res.json(); assert.equal(view.project.id, project.id); assert.equal(view.active_part.current_row, 2); assert.equal(view.recent_sittings[0].rows[0].row, 1); assert.equal(view.recent_sittings[0].detail.part_id, p.id); });
    await test("GET detail: another user's craft project is 404", async () => { const res = await craftDetailRoute.GET(routeRequest(a.client, `/api/craft/${foreign.id}`), { params: Promise.resolve({ projectId: foreign.id }) }); assert.equal(res.status, 404); });
    await test("GET fallback: no sessions chooses newest craft project; no projects gives 404", async () => { const empty = await user(); const req = () => { const r = new NextRequest("http://localhost/api/craft"); writeInternalAuthContext(r, { supabase: empty.client, userId: empty.id, user: { id: empty.id }, authSource: "session" }); return r; }; assert.equal((await craftRoute.GET(req())).status, 404); const ep = await insert("projects", { user_id: empty.id, name: "New" }); await insert("craft_projects", { user_id: empty.id, project_id: ep.id, craft: "other" }); const res = await craftRoute.GET(req()); assert.equal(res.status, 200); assert.equal((await res.json()).project.id, ep.id); });
    await test("SET NULL: segment deletion preserves links", async () => { const { error } = await admin.from("craft_segments").delete().eq("id", seg.id); assert.ifError(error); const { data } = await admin.from("craft_links").select("segment_id").eq("id", link.id).single(); assert.equal(data.segment_id, null); });
    await test("SET NULL: link deletion preserves instructions", async () => { const { error } = await admin.from("craft_links").delete().eq("id", link.id); assert.ifError(error); const { data } = await admin.from("craft_instructions").select("link_id").eq("part_id", p.id).single(); assert.equal(data.link_id, null); });
    await test("SET NULL: task deletion preserves segments", async () => { const t = await insert("tasks", { user_id: a.id, project_id: project.id, title: "Delete task" }); const sg = await insert("craft_segments", { ...fixtures.craft_segments, task_id: t.id }); assert.ifError((await admin.from("tasks").delete().eq("id", t.id)).error); assert.equal((await admin.from("craft_segments").select("task_id").eq("id", sg.id).single()).data.task_id, null); });
    await test("CASCADE/SET NULL: part deletion clears checklist pair and optional refs, preserves ticks and sessions", async () => {
        assert.ifError((await admin.from("craft_projects").update({ active_part_id: p.id }).eq("project_id", project.id)).error);
        assert.ifError((await admin.from("craft_parts").delete().eq("id", p.id)).error);
        const { data } = await admin.from("task_checklist_items").select("craft_part_id,craft_row,is_done,completed_at").eq("id", item.id).single();
        assert.equal(data.craft_part_id, null);
        assert.equal(data.craft_row, null);
        assert.equal(data.is_done, true);
        assert.ok(data.completed_at);
        for (const t of ["craft_segments", "craft_instructions"])
            assert.equal((await admin.from(t).select("*").eq("part_id", p.id)).data.length, 0);
        for (const t of ["craft_notes", "craft_links", "craft_timers", "craft_yarns", "craft_sitting_details"]) {
            const result = await admin.from(t).select("part_id").eq("user_id", a.id);
            assert.ifError(result.error);
            assert.ok(result.data.some(r => r.part_id === null));
        }
        assert.equal((await admin.from("craft_projects").select("active_part_id").eq("project_id", project.id).single()).data.active_part_id, null);
        assert.equal((await admin.from("work_sessions").select("minutes").eq("id", s.id).single()).data.minutes, 20);
    });
    await test("session deletion cascades detail and nulls note's session", async () => { assert.ifError((await admin.from("work_sessions").delete().eq("id", s.id)).error); assert.equal((await admin.from("craft_sitting_details").select("*").eq("session_id", s.id)).data.length, 0); assert.equal((await admin.from("craft_notes").select("session_id").eq("user_id", a.id).single()).data.session_id, null); });
    await test("project deletion cascades craft metadata and preserves surviving task checklist", async () => { assert.ifError((await admin.from("projects").delete().eq("id", project.id)).error); for (const t of ["craft_projects", "craft_parts", "craft_notes", "craft_links", "craft_timers", "craft_yarns"])
        assert.equal((await admin.from(t).select("*").eq("project_id", project.id)).data.length, 0); assert.equal((await admin.from("task_checklist_items").select("is_done").eq("id", item.id).single()).data.is_done, true); });
    await test("loader paginates past 1000 rows and session links with RLS on", async () => {
        const owner = await user();
        const proj = await insert("projects", { user_id: owner.id, name: "Pagination" });
        await insert("craft_projects", { user_id: owner.id, project_id: proj.id, craft: "knit" });
        const part = await insert("craft_parts", { user_id: owner.id, project_id: proj.id, name: "Long body", total_rows: 1201 });
        const task = await insert("tasks", { user_id: owner.id, project_id: proj.id, title: "Long body" });
        const session = await makeSession(owner.id, proj.id, "2026-11-08");
        const rows = Array.from({ length: 1201 }, (_, index) => ({ id: randomUUID(), user_id: owner.id, task_id: task.id,
            craft_part_id: part.id, craft_row: index + 1, text: `Row ${index + 1}`, is_done: index < 1200 }));
        for (let offset = 0; offset < rows.length; offset += 200) {
            const batch = rows.slice(offset, offset + 200);
            assert.ifError((await admin.from("task_checklist_items").insert(batch)).error);
            assert.ifError((await admin.from("work_session_items").insert(batch.map(row => ({ user_id: owner.id, session_id: session.id, checklist_item_id: row.id })))).error);
        }
        const request = new NextRequest(`http://localhost/api/craft/${proj.id}`);
        writeInternalAuthContext(request, { supabase: owner.client, userId: owner.id, user: { id: owner.id }, authSource: "session" });
        const response = await craftDetailRoute.GET(request, { params: Promise.resolve({ projectId: proj.id }) });
        assert.equal(response.status, 200);
        const view = await response.json();
        assert.equal(view.active_part.current_row, 1201);
        assert.equal(view.active_part.done_rows, 1200);
        assert.equal(view.recent_sittings[0].rows.length, 1201);
    });
    await test("project CASCADE with live craft rows and active part preserves ordinary task ticks", async () => {
        const proj = await insert("projects", { user_id: a.id, name: "Cascade whole project" });
        const part = await makePart(a.id, proj.id, "Body");
        await insert("craft_projects", { user_id: a.id, project_id: proj.id, craft: "knit", active_part_id: part.id });
        const task = await insert("tasks", { user_id: a.id, project_id: proj.id, title: "Survives" });
        const item = await insert("task_checklist_items", { user_id: a.id, task_id: task.id, text: "Row 1", craft_part_id: part.id, craft_row: 1, is_done: true });
        const session = await makeSession(a.id, proj.id, "2026-11-08");
        await insert("craft_sitting_details", { user_id: a.id, session_id: session.id, part_id: part.id, from_row: 1, to_row: 1 });
        await insert("craft_notes", { user_id: a.id, project_id: proj.id, part_id: part.id, session_id: session.id, text: "Keep until project deletion" });
        assert.ifError((await admin.from("projects").delete().eq("id", proj.id)).error);
        assert.equal((await admin.from("craft_parts").select("id").eq("id", part.id)).data.length, 0);
        const saved = (await admin.from("task_checklist_items").select("is_done, craft_row, craft_part_id").eq("id", item.id).single()).data;
        assert.equal(saved.is_done, true);
        assert.equal(saved.craft_row, null);
        assert.equal(saved.craft_part_id, null);
    });
    await test("071 down then 071 applies cleanly; existing ticks, sessions, minutes and 059 guard survive", () => {
        const fingerprint = () => psql(`SELECT md5(coalesce(string_agg(row_to_json(s)::text,',' ORDER BY s.id),'')) FROM work_sessions s; SELECT md5(coalesce(string_agg((to_jsonb(i)-'craft_part_id'-'craft_row')::text,',' ORDER BY i.id),'')) FROM task_checklist_items i; SELECT md5(coalesce(string_agg((id::text||coalesce(actual_minutes::text,'')),',' ORDER BY id),'')) FROM tasks;`);
        const before = fingerprint();
        psql(down);
        assert.equal(psql("SELECT count(*) FROM pg_trigger WHERE tgname='trg_tasks_guard_project_move'"), "1");
        assert.equal(fingerprint(), before);
        psql(migration);
        assert.equal(fingerprint(), before);
        assert.equal(psql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'craft_%'"), "9");
    });
}
finally {
    for (const id of users.reverse()) {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) {
            failed++;
            console.error("cleanup failed", error.message);
        }
    }
}
console.log(`\nCraft DB: ${passed} passed, ${failed} failed`);
if (failed)
    process.exitCode = 1;
