#!/usr/bin/env node
// Offline model, real route error handling and paged-loader checks; no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCraftView } from "../src/lib/craft.ts";
import { writeInternalAuthContext } from "../src/lib/supabase/internal-auth.ts";
import { NextRequest } from "next/server";
import { GET as detailGet } from "../src/app/api/craft/[projectId]/route.ts";
import { GET as lastGet } from "../src/app/api/craft/route.ts";
let passed = 0, failed = 0;
async function test(name, fn) { try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}
catch (e) {
    failed++;
    console.error(`FAIL - ${name}`, e);
} }
const part = (id, total_rows, extra = {}) => ({ id, name: id, total_rows, row_word: "row", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: null, ...extra });
const rows = (id, total, done) => Array.from({ length: total }, (_, i) => ({ id: `${id}-${i + 1}`, craft_part_id: id, craft_row: i + 1, text: `Row ${i + 1}`, is_done: i < done, completed_at: i < done ? "2026-11-07T18:00:00Z" : null }));
const input = (parts = [], items = []) => ({ project: { id: "project", name: "Sample" }, craft_project: { craft: "knit", gear: "5 mm needles", active_part_id: null }, parts, items, segments: [], sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-08T18:00:00Z" });
const scarf = input([part("Body", 519, { quarters: true, ridges: true, stitch_count: 30 })], rows("Body", 519, 118));
scarf.segments = Array.from({ length: 6 }, (_, i) => ({ id: `chunk-${i}`, part_id: "Body", task_id: `task-${i}`, name: `Rows ${i * 100 + 1}–${Math.min(519, (i + 1) * 100)}`, from_row: i * 100 + 1, to_row: Math.min(519, (i + 1) * 100), sort_order: i, close_check: false }));
const bands = [["Foundation", 1, 1], ["Waffle 1", 2, 18], ["Tree 1", 19, 37], ["Waffle 2", 38, 52], ["Tree 2", 53, 71], ["Waffle 3", 72, 86], ["Tree 3", 87, 105], ["Waffle 4", 106, 120], ["Tree 4", 121, 139], ["Waffle 5", 140, 156], ["Final sc row", 157, 157]];
const blanket = input([part("Blanket", 157, { stitch_count: 195 }), part("Border", 2, { sort_order: 1, row_word: "round" })], [...rows("Blanket", 157, 58), ...rows("Border", 2, 0).map((row) => ({ ...row, text: `Round ${row.craft_row}` }))]);
blanket.craft_project.craft = "crochet";
blanket.segments = bands.map(([name, from_row, to_row], i) => ({ id: `band-${i}`, part_id: "Blanket", task_id: `task-${i}`, name, from_row, to_row, sort_order: i, close_check: true }));
await test("Scarf: row 119, ridge 60, 30 stitches, 519 rows", () => { const v = buildCraftView(scarf); assert.equal(v.active_part.current_row, 119); assert.equal(v.active_part.ridge, 60); assert.equal(v.active_part.row_label, "Row 119 · ridge 60"); assert.equal(v.active_part.stitch_count, 30); assert.equal(v.active_part.total_rows, 519); });
await test("Scarf chunks show done/current/upcoming, with next chunk peek", () => { const v = buildCraftView(scarf); assert.deepEqual(v.segments.map(s => s.state), ["done", "current", "upcoming", "upcoming", "upcoming", "upcoming"]); assert.equal(v.next_segment.from_row, 201); assert.equal(v.segments.at(-1).to_row, 519); });
await test("Next five unticked checklist texts", () => { assert.deepEqual(buildCraftView(scarf).next_rows.map(r => r.text), [119, 120, 121, 122, 123].map(n => `Row ${n}`)); });
await test("Blanket: row 59 is Tree 2, next Waffle 3, exact 11 bands", () => { const v = buildCraftView(blanket); assert.equal(v.active_part.current_row, 59); assert.equal(v.active_part.stitch_count, 195); assert.equal(v.current_segment.name, "Tree 2"); assert.equal(v.next_segment.name, "Waffle 3"); assert.equal(v.segments.length, 11); assert.equal(v.active_part.quarter, 0); });
await test("Border has its own two-round counter", () => { const v = structuredClone(blanket); v.craft_project.active_part_id = "Border"; const out = buildCraftView(v); assert.equal(out.active_part.row_label, "Round 1"); assert.equal(out.active_part.total_rows, 2); assert.equal(out.next_rows[0].text, "Round 1"); assert.equal(out.segments.length, 0); });
await test("Finished part is past last row; fallback chooses next unfinished by sort order", () => { const v = structuredClone(blanket); v.items.forEach(r => { if (r.craft_part_id === "Blanket")
    r.is_done = true; }); const out = buildCraftView(v); assert.equal(out.parts[0].current_row, 158); assert.equal(out.parts[0].finished, true); assert.equal(out.parts[0].row_label, "Finished"); assert.equal(out.active_part.id, "Border"); });
await test("Explicit finished active part remains selected", () => { const v = structuredClone(scarf); v.items.forEach(r => r.is_done = true); v.craft_project.active_part_id = "Body"; const out = buildCraftView(v); assert.equal(out.active_part.current_row, 520); assert.equal(out.active_part.ridge, null); assert.equal(out.next_rows.length, 0); });
await test("All finished with no explicit active part has no active part", () => { const v = structuredClone(scarf); v.items.forEach(r => r.is_done = true); assert.equal(buildCraftView(v).active_part, null); });
await test("Gap: row 5 unticked while 6–10 ticked gives row 5", () => { const v = input([part("Body", 10)], rows("Body", 10, 10)); v.items[4].is_done = false; assert.equal(buildCraftView(v).active_part.current_row, 5); });
await test("Quarter appears only on its current row", () => { const v = structuredClone(scarf); v.parts[0].quarter = 2; v.parts[0].quarter_row = 119; assert.equal(buildCraftView(v).active_part.quarter, 2); v.parts[0].quarter_row = 118; assert.equal(buildCraftView(v).active_part.quarter, 0); v.parts[0].quarter_row = 120; assert.equal(buildCraftView(v).active_part.quarter, 0); });
await test("Quarters disabled hides stored fraction", () => { const v = structuredClone(scarf); Object.assign(v.parts[0], { quarters: false, quarter: 3, quarter_row: 119 }); assert.equal(buildCraftView(v).active_part.quarter, 0); });
await test("Ridge labels: odd/even rows, always explicitly labelled", () => { for (const [row, ridge] of [[1, 1], [2, 1], [95, 48], [96, 48], [119, 60]]) {
    const v = input([part("Body", 120, { ridges: true })], rows("Body", 120, row - 1));
    assert.equal(buildCraftView(v).active_part.row_label, `Row ${row} · ridge ${ridge}`);
} });
await test("Empty project is a valid empty view", () => { const out = buildCraftView(input()); assert.equal(out.active_part, null); assert.deepEqual(out.parts, []); assert.deepEqual(out.today, { date: "2026-11-08", rows: 0, minutes: 0 }); });
await test("ET midnight: UTC same date can belong to yesterday", () => { const v = input([part("Body", 4)], rows("Body", 4, 4)); v.items.forEach((r, i) => r.completed_at = ["2026-11-08T04:59:59Z", "2026-11-08T05:00:00Z", "2026-11-09T04:59:59Z", null][i]); assert.equal(buildCraftView(v).today.rows, 2); });
await test("ET day across spring and fall DST boundaries", () => { for (const [now, before, after] of [["2026-03-08T17:00:00Z", "2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z"], ["2026-11-01T17:00:00Z", "2026-11-01T03:59:59Z", "2026-11-01T04:00:00Z"]]) {
    const v = input([part("Body", 2)], rows("Body", 2, 2));
    v.server_now = now;
    v.items[0].completed_at = before;
    v.items[1].completed_at = after;
    assert.equal(buildCraftView(v).today.rows, 1);
} });
await test("Today minutes include excluded sittings and use ET session_date", () => { const v = input(); v.sessions = [{ id: "old", session_date: "2026-11-07", created_at: "2026-11-08T04:59:00Z", minutes: 40, note: null, exclude_from_stats: false }, { id: "new", session_date: "2026-11-08", created_at: "2026-11-08T05:00:00Z", minutes: 25, note: "learning", exclude_from_stats: true }]; assert.equal(buildCraftView(v).today.minutes, 25); assert.equal(buildCraftView(v).recent_sittings[0].excluded_from_stats, true); });
await test("Recent sittings: newest 10, linked row and note", () => { const v = structuredClone(scarf); v.sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, session_date: `2026-11-${String(i + 1).padStart(2, "0")}`, created_at: "2026-11-08T00:00:00Z", minutes: 10, note: `note ${i}`, exclude_from_stats: false })); v.session_items = [{ session_id: "s11", checklist_item_id: "Body-118" }]; const out = buildCraftView(v); assert.equal(out.recent_sittings.length, 10); assert.equal(out.recent_sittings[0].note, "note 11"); assert.equal(out.recent_sittings[0].rows[0].row, 118); });
await test("Pure builder does not mutate input, server_now is echoed", () => { const before = JSON.stringify(scarf); assert.equal(buildCraftView(scarf).server_now, scarf.server_now); assert.equal(JSON.stringify(scarf), before); });
await test("Stored timer does not expose a running timer in S1", () => { const v = structuredClone(scarf); v.timer = { running_since: "2026-11-08T17:00:00Z" }; assert.equal("timer" in buildCraftView(v), false); });
function errorClient(code) { return { from() { return { select() { return this; }, eq() { return this; }, single() { return Promise.resolve({ data: null, error: { code, message: "test failure" } }); } }; } }; }
function request(db, path = "/api/craft/11111111-1111-4111-8111-111111111111") { const req = new NextRequest(`http://localhost${path}`); writeInternalAuthContext(req, { supabase: db, userId: "user", user: { id: "user" }, authSource: "session" }); return req; }
await test("Real GET detail maps PGRST116 to 404 with no-store", async () => { const res = await detailGet(request(errorClient("PGRST116")), { params: Promise.resolve({ projectId: "11111111-1111-4111-8111-111111111111" }) }); assert.equal(res.status, 404); assert.equal(res.headers.get("cache-control"), "no-store"); });
await test("Real GET detail preserves DB failures as 500", async () => { const original = console.error; console.error = () => { }; try {
    for (const code of ["42501", "PGRST205", "XX000"]) {
        const res = await detailGet(request(errorClient(code)), { params: Promise.resolve({ projectId: "11111111-1111-4111-8111-111111111111" }) });
        assert.equal(res.status, 500);
    }
}
finally {
    console.error = original;
} });
await test("Real GET detail rejects invalid UUID after auth", async () => { const res = await detailGet(request({}), { params: Promise.resolve({ projectId: "bad" }) }); assert.equal(res.status, 400); });
await test("Real GET last-used accepts Next route context without treating it as an id", async () => { const db = { from() { return { select() { return this; }, eq() { return this; }, order() { return this; }, range() { return Promise.resolve({ data: [], error: null }); } }; } }; const res = await lastGet(request(db, "/api/craft"), { params: Promise.resolve({}) }); assert.equal(res.status, 404); });
// Render the actual component without launching a browser. CSS layout is a PM visual check.
registerHooks({ load(url, context, nextLoad) {
        if (url.startsWith("file:") && url.endsWith(".css"))
            return { format: "module", source: "export {};", shortCircuit: true };
        if (url.startsWith("file:") && url.endsWith(".tsx")) {
            const fileName = fileURLToPath(url);
            const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName,
                compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
            return { format: "module", source: result.outputText, shortCircuit: true };
        }
        return nextLoad(url, context);
    } });
const { CraftScreen } = await import("../src/components/craft/CraftScreen.tsx");
const render = (data) => renderToStaticMarkup(createElement(CraftScreen, { view: buildCraftView(data) }));
await test("SSR: read-only screen has row/ridge, timer placeholder, no write controls", () => {
    const html = render(scarf);
    assert.match(html, /Row 119 · ridge 60/);
    assert.match(html, /Timer arrives in the next update/);
    assert.doesNotMatch(html, /<button|<input|<textarea|<select|disabled=|Start timer|Log sitting/);
    assert.match(html, /aria-label="Back to project"/);
});
await test("SSR: blanket shows bands, next rows and separate border count", () => {
    const html = render(blanket);
    for (const word of ["Tree 2", "Waffle 3", "Row 59", "Round 1"])
        assert.ok(html.includes(word));
});
await test("SSR: empty craft project renders a useful empty state", () => {
    assert.match(render(input()), /This project has no craft parts yet/);
});
await test("SSR: all finished differs from a project without parts", () => {
    const data = structuredClone(scarf);
    data.items.forEach(row => row.is_done = true);
    const html = render(data);
    assert.match(html, /All parts finished/);
    assert.doesNotMatch(html, /no craft parts yet|No parts yet/);
});
console.log(`\nCraft: ${passed} passed, ${failed} failed`);
if (failed)
    process.exitCode = 1;
