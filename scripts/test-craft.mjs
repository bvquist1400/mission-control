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
import * as craftModel from "../src/lib/craft.ts";
import * as craftLoader from "../src/lib/craft/loader.ts";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
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
const withoutMenu = (html) => { const out = html.replace(/<div class="craft-menu">.*?<\/div><\/div>/, ""); assert.notEqual(out, html, "craft screen menu missing"); return out; };
await test("SSR: read-only screen has row/ridge, timer placeholder, no write controls", () => {
    const html = render(scarf);
    assert.match(html, /Row 119 · ridge 60/);
    assert.match(html, /Timer arrives in the next update/);
    // S1C: the header menu (Remove from craft screen) is the screen's only control; no row or timer writes.
    assert.doesNotMatch(withoutMenu(html), /<button|<input|<textarea|<select|disabled=|Start timer|Log sitting/);
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
// Pattern first (Brent 11/11): title, active part, pattern card, compact timer, Today.
const renderView = (view) => renderToStaticMarkup(createElement(CraftScreen, { view }));
const card = (html) => { const m = html.match(/<section class="craft-pf"[^>]*>([\s\S]*?)<\/section>/); assert.ok(m, "pattern card missing"); return m[0]; };
const nowText = (html) => card(html).match(/<p class="craft-pf-now">([\s\S]*?)<\/p>/)?.[1];
const thenRows = (html) => [...card(html).matchAll(/<li><span>([^<]*)<\/span><p>([^<]*)<\/p><\/li>/g)].map(m => [m[1], m[2]]);
const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
const chartBlanket = structuredClone(blanket);
chartBlanket.items.forEach(row => { if (row.craft_part_id === "Blanket") row.text = `Chart row ${row.craft_row}: ivory waffle as set; olive 3 sts per tree (trunk).`; });
await test("SSR pattern first: front order is title, part, pattern card, timer, Today", () => {
    const html = render(chartBlanket);
    const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
    const order = [at("<h2>Sample</h2>"), at('class="craft-part"'), at('aria-label="Current row instructions"'), at("Timer arrives in the next update"), at('aria-label="Today"'), at('aria-label="Project details"')];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});
await test("SSR pattern first: current row's own text is the card's big line, with NOW header and band", () => {
    const html = render(chartBlanket);
    assert.equal(nowText(html), "Chart row 59: ivory waffle as set; olive 3 sts per tree (trunk).");
    const c = card(html);
    assert.match(c, /<span class="craft-pf-lab">Now · row<\/span><span class="craft-pf-num">59<\/span><span class="craft-pf-of">of 157<\/span>/);
    assert.match(c, /<strong>Tree 2<\/strong> · 58 of 157 rows ticked/);
    assert.doesNotMatch(c, /craft-quarter|data-quarter|ridge/);
});
await test("SSR pattern first: next three rows follow the current row (CSS shows 2 on phones, 3 from 600px)", () => {
    assert.deepEqual(thenRows(render(chartBlanket)), [60, 61, 62].map(n => [`row ${n}`, `Chart row ${n}: ivory waffle as set; olive 3 sts per tree (trunk).`]));
    assert.match(css, /\.craft-pf-then li:nth-child\(n\+3\), \.craft-pf\[data-quarter\] \.craft-pf-then li:nth-child\(n\+2\) \{ display: none; \}/);
    assert.match(css, /@media \(min-width: 600px\) \{\n(?: {2}[^\n]*\n)*? {2}\.craft-pf-then li:nth-child\(n\+3\), \.craft-pf\[data-quarter\] \.craft-pf-then li:nth-child\(n\+2\) \{ display: grid; \}/);
});
await test("SSR pattern first: current row without a checklist item falls back to row_label", () => {
    const view = buildCraftView(chartBlanket);
    view.next_rows = view.next_rows.slice(1);
    const html = renderView(view);
    assert.equal(nowText(html), "Row 59");
    assert.deepEqual(thenRows(html).map(r => r[0]), ["row 60", "row 61", "row 62"]);
});
await test("SSR pattern first: quarter shows FINISH, the ½ chip and only one row on phones", () => {
    const data = structuredClone(scarf);
    Object.assign(data.parts[0], { quarter: 2, quarter_row: 119 });
    const c = card(render(data));
    assert.match(c, /^<section class="craft-pf" aria-label="Current row instructions" data-quarter="2">/);
    assert.match(c, /<span class="craft-pf-lab">Finish · row<\/span>/);
    assert.match(c, /<p class="craft-quarter">½ of this row done<\/p><p class="craft-pf-now">Row 119<\/p>/);
});
await test("SSR pattern first: scarf header shows row, total and ridge", () => {
    const c = card(render(scarf));
    assert.match(c, /Now · row<\/span><span class="craft-pf-num">119<\/span><span class="craft-pf-of">of 519<span class="craft-pf-ridge"> · ridge 60<\/span><\/span>/);
    assert.match(c, /<strong>Rows 101–200<\/strong> · 118 of 519 rows ticked/);
});
await test("SSR pattern first: Border counts rounds", () => {
    const data = structuredClone(blanket);
    data.craft_project.active_part_id = "Border";
    const html = render(data);
    assert.match(card(html), /Now · round<\/span><span class="craft-pf-num">1<\/span><span class="craft-pf-of">of 2<\/span>/);
    assert.equal(nowText(html), "Round 1");
    assert.deepEqual(thenRows(html), [["round 2", "Round 2"]]);
    assert.match(card(html), /No band for this row<\/strong> · 0 of 2 rounds ticked/);
});
await test("SSR pattern first: finished active part shows Finished in the card, no rows", () => {
    const data = structuredClone(scarf);
    data.items.forEach(row => row.is_done = true);
    data.craft_project.active_part_id = "Body";
    const html = render(data);
    const c = card(html);
    assert.match(c, /Part complete/);
    assert.match(c, /<p class="craft-finished">Finished<\/p>/);
    assert.match(c, /All rows ticked<\/strong> · 519 of 519 rows ticked/);
    assert.doesNotMatch(c, /craft-pf-now|craft-pf-then|craft-pf-num/);
    assert.ok(html.indexOf("craft-pf") < html.indexOf("Timer arrives in the next update"));
});
await test("SSR pattern first: no parts and all-finished have no card but keep the timer and Today", () => {
    const allDone = structuredClone(scarf);
    allDone.items.forEach(row => row.is_done = true);
    for (const [data, text] of [[input(), "This project has no craft parts yet."], [allDone, "Every part is finished. All rows are ticked."]]) {
        const html = render(data);
        assert.doesNotMatch(html, /craft-pf/);
        assert.ok(html.indexOf(text) >= 0 && html.indexOf(text) < html.indexOf("Timer arrives in the next update"));
        assert.ok(html.indexOf("Timer arrives in the next update") < html.indexOf('aria-label="Today"'));
    }
});
await test("SSR pattern first: card is a labelled region with no headings; lists keep aria-current", () => {
    const html = render(chartBlanket);
    assert.doesNotMatch(card(html), /<h[1-6]/);
    assert.match(html, /<li aria-current="true"><strong>Blanket<\/strong>/);
    assert.match(html, /<li data-state="current" aria-current="step"><span>Tree 2<\/span>/);
    assert.match(html, /<h2>Next rows<\/h2><ol class="craft-next">/);
});
await test("CSS pattern first: big instruction text wraps, number is medium, timer is a compact row", () => {
    const rule = (sel) => css.match(new RegExp(`^${sel.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    assert.match(rule(".craft-pf-now"), /font-size: 27px;.*font-weight: 600;.*line-height: 1\.27;.*overflow-wrap: anywhere;/);
    assert.match(rule(".craft-pf-num"), /font-size: 42px;/);
    assert.match(rule(".craft-pf"), /border-left: 5px solid var\(--accent\);/);
    assert.match(rule(".craft-timer"), /display: flex;.*min-height: 64px;/);
    assert.doesNotMatch(rule(".craft-timer"), /text-align: center/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
});
// Project switcher (Brent 11/11, "Dropdown by the title"): one list of every craft project, the URL is the state.
const scarfId = "11111111-1111-4111-8111-111111111111", blanketId = "22222222-2222-4222-8222-222222222222", emptyId = "33333333-3333-4333-8333-333333333333", foreignId = "44444444-4444-4444-8444-444444444444";
const listInput = () => {
    const owned = (rowsList, project_id) => rowsList.map((row) => ({ ...row, project_id }));
    return {
        craft_projects: [{ project_id: scarfId, craft: "knit", active_part_id: null }, { project_id: blanketId, craft: "crochet", active_part_id: null }, { project_id: emptyId, craft: "other", active_part_id: null }],
        projects: [{ id: scarfId, name: "Personal — Test Scarf" }, { id: blanketId, name: "Personal — Test Blanket" }, { id: emptyId, name: "Personal — Empty Craft" }],
        parts: [...owned(scarf.parts, scarfId), ...owned(blanket.parts, blanketId)],
        items: [...scarf.items, ...blanket.items].filter((item) => !item.is_done),
    };
};
await test("Switcher list: one entry per craft project with its active part's row word and current row", () => {
    const list = craftModel.buildCraftProjectList(listInput());
    assert.deepEqual(list, [
        { id: emptyId, name: "Personal — Empty Craft", craft: "other", progress: null },
        { id: blanketId, name: "Personal — Test Blanket", craft: "crochet", progress: "row 59" },
        { id: scarfId, name: "Personal — Test Scarf", craft: "knit", progress: "row 119" },
    ]);
    assert.deepEqual(list.map(craftModel.craftProjectOptionLabel), ["Personal — Empty Craft", "Personal — Test Blanket · row 59", "Personal — Test Scarf · row 119"]);
});
await test("Switcher list: rounds say round, a finished active part says done, all finished says done", () => {
    const data = listInput();
    data.craft_projects[1].active_part_id = "Border";
    data.craft_projects[0].active_part_id = "Body";
    data.items = data.items.filter((item) => item.craft_part_id !== "Body");
    assert.deepEqual(craftModel.buildCraftProjectList(data).map((p) => p.progress), [null, "round 1", "done"]);
    data.craft_projects[0].active_part_id = null;
    assert.equal(craftModel.buildCraftProjectList(data).find((p) => p.id === scarfId).progress, "done");
});
await test("Switcher list: matches the screen's own current row (only unticked rows are read for the list)", () => {
    for (const [data, id] of [[scarf, scarfId], [blanket, blanketId]]) {
        const fromList = craftModel.buildCraftProjectList(listInput()).find((p) => p.id === id).progress;
        const part = buildCraftView(data).active_part;
        assert.equal(fromList, `${part.row_word} ${part.current_row}`);
    }
});
await test("Switcher list: a craft project whose project row is not visible is left out", () => {
    const data = listInput();
    data.projects = data.projects.filter((p) => p.id !== blanketId);
    assert.deepEqual(craftModel.buildCraftProjectList(data).map((p) => p.id), [emptyId, scarfId]);
});
await test("Switcher navigation target: /craft/<projectId>, nothing for the current one", async () => {
    const { switchCraftProject } = await import("../src/components/craft/CraftProjectSwitcher.tsx");
    const pushed = [], router = { push: (href) => pushed.push(href) };
    assert.equal(switchCraftProject(router, scarfId, blanketId), `/craft/${blanketId}`);
    assert.equal(switchCraftProject(router, scarfId, scarfId), null);
    assert.equal(switchCraftProject(router, scarfId, ""), null);
    assert.deepEqual(pushed, [`/craft/${blanketId}`]);
    assert.equal(craftModel.craftProjectHref(emptyId), `/craft/${emptyId}`);
});
const routerStub = { push() { }, replace() { }, refresh() { }, back() { }, forward() { }, prefetch() { } };
const renderWithRouter = (view) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: routerStub }, createElement(CraftScreen, { view })));
const withProjects = (data, id, projects) => ({ ...buildCraftView({ ...data, project: { id, name: projects.find((p) => p.id === id)?.name ?? "Sample" } }), projects });
await test("SSR switcher: one craft project keeps the plain title, no select and no caret", () => {
    const one = craftModel.buildCraftProjectList(listInput()).filter((p) => p.id === scarfId);
    for (const view of [withProjects(scarf, scarfId, one), { ...buildCraftView(scarf), projects: [] }, buildCraftView(scarf)]) {
        const html = renderWithRouter(view);
        assert.match(html, /<div class="craft-project"><p class="craft-eyebrow">Knitting<\/p><h2>[^<]+<\/h2>/);
        assert.doesNotMatch(html, /<select|craft-switch|▾/);
    }
});
await test("SSR switcher: two or more projects make the title a labelled select listing each with its row, current marked", () => {
    const list = craftModel.buildCraftProjectList(listInput());
    const html = renderWithRouter(withProjects(blanket, blanketId, list));
    const block = html.match(/<div class="craft-switch">[\s\S]*?<\/select><\/div>/)?.[0];
    assert.ok(block, "switcher missing");
    assert.match(block, /^<div class="craft-switch"><h2>Personal — Test <span class="craft-switch-tail">Blanket<span class="craft-switch-caret" aria-hidden="true">▾<\/span><\/span><\/h2><select aria-label="Switch craft project">/);
    const options = [...block.matchAll(/<option value="([^"]+)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], Boolean(m[2]), m[3]]);
    assert.deepEqual(options, [
        [emptyId, false, "Personal — Empty Craft"],
        [blanketId, true, "Personal — Test Blanket · row 59 (current)"],
        [scarfId, false, "Personal — Test Scarf · row 119"],
    ]);
    assert.equal((html.match(/<select/g) ?? []).length, 1);
    assert.equal((html.match(/<h2>/g) ?? []).length, 1 + 4, "one title heading plus the four inside headings");
    assert.doesNotMatch(withoutMenu(html), /<button|<input|<textarea|<form|disabled=|Start timer|Log sitting/);
});
await test("SSR switcher: the shown project is always an option even if the list missed it", () => {
    const list = craftModel.buildCraftProjectList(listInput()).filter((p) => p.id !== blanketId);
    const html = renderWithRouter({ ...buildCraftView({ ...blanket, project: { id: blanketId, name: "Personal — Test Blanket" } }), projects: list });
    assert.match(html, new RegExp(`<select aria-label="Switch craft project"><option value="${blanketId}" selected="">Personal — Test Blanket \\(current\\)</option>`));
});
await test("SSR switcher: the caret stays with a short last word; a very long word is left free to wrap", () => {
    const list = craftModel.buildCraftProjectList(listInput());
    const title = (name) => renderWithRouter({ ...buildCraftView({ ...blanket, project: { id: blanketId, name } }), projects: list }).match(/<div class="craft-switch"><h2>([\s\S]*?)<\/h2>/)[1];
    const caret = '<span class="craft-switch-caret" aria-hidden="true">▾</span>';
    assert.equal(title("Scarf"), `<span class="craft-switch-tail">Scarf${caret}</span>`);
    const long = "x".repeat(340);
    assert.equal(title(`Personal — ${long}`), `Personal — ${long}<span class="craft-switch-tail">${caret}</span>`);
});
await test("CSS switcher: invisible select covers the title, 16px (no iOS zoom), visible focus, 44px on touch, tokens only", () => {
    const rule = (sel) => css.match(new RegExp(`^${sel.replace(/[.[\]():]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    assert.match(rule(".craft-switch"), /position: relative;/);
    assert.match(rule(".craft-switch select"), /position: absolute; inset: 0; width: 100%; height: 100%;.*opacity: 0; font-size: 16px; cursor: pointer;/);
    assert.match(css, /\.craft-switch:has\(select:focus-visible\) \{ outline: 2px solid var\(--focus-ring, var\(--accent-text\)\); outline-offset: 2px; \}/);
    assert.match(css, /\.craft-switch-tail \{ white-space: nowrap; \}/);
    assert.match(css, /@media \(pointer: coarse\) \{ \.craft-switch \{ display: flex; align-items: center; min-height: 44px; \} \}/);
    assert.doesNotMatch(css, /font-size:\s*(9|9\.5|10|10\.5|11|11\.5)px/);
});
// A fake PostgREST client over in-memory rows: applies eq/in filters, records every query.
function fakeDb(tables, { blockers = () => ({ data: [], error: null }) } = {}) {
    const log = [], rpcCalls = [];
    return { log, rpcCalls, rpc(name, args) { rpcCalls.push([name, args]); return Promise.resolve(name === "craft_remove_blockers" ? blockers(args) : { data: null, error: { code: "PGRST202", message: "no such function" } }); }, from(table) {
            const entry = { table, cols: null, filters: [] }, conds = [];
            log.push(entry);
            const rows = () => (tables[table] ?? []).filter((row) => conds.every((cond) => cond(row)));
            const q = {
                select(cols) { entry.cols = cols; return q; },
                eq(col, val) { entry.filters.push(`eq ${col}`); conds.push((row) => row[col] === val); return q; },
                in(col, vals) { entry.filters.push(`in ${col}`); conds.push((row) => vals.includes(row[col])); return q; },
                order() { return q; }, limit() { return q; },
                range(from, to) { return Promise.resolve({ data: rows().slice(from, to + 1), error: null }); },
                single() { const found = rows(); return Promise.resolve(found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: "PGRST116", message: "none" } }); },
                maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
                then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); },
            };
            return q;
        } };
}
const dbRows = () => {
    const mine = (row) => ({ ...row, user_id: "user" });
    const parts = [...scarf.parts.map((p) => ({ ...p, project_id: scarfId })), ...blanket.parts.map((p) => ({ ...p, project_id: blanketId }))].map(mine);
    return {
        projects: [{ id: scarfId, name: "Personal — Test Scarf" }, { id: blanketId, name: "Personal — Test Blanket" }, { id: foreignId, name: "Someone else" }].map(mine).map((p) => p.id === foreignId ? { ...p, user_id: "other" } : p),
        craft_projects: [{ project_id: scarfId, craft: "knit", gear: null, active_part_id: null, created_at: "2026-11-01T00:00:00Z" }, { project_id: blanketId, craft: "crochet", gear: null, active_part_id: null, created_at: "2026-11-02T00:00:00Z" }, { project_id: foreignId, craft: "knit", gear: null, active_part_id: null, created_at: "2026-11-03T00:00:00Z", user_id: "other" }].map((row) => ({ user_id: "user", ...row })),
        craft_parts: [...parts, { ...part("Foreign", 4), project_id: foreignId, user_id: "other" }],
        task_checklist_items: [...scarf.items, ...blanket.items].map(mine),
        craft_segments: [...scarf.segments, ...blanket.segments].map(mine),
        work_sessions: [], work_session_items: [], craft_sitting_details: [], craft_timers: [],
    };
};
await test("Loader: the switcher list is 4 reads however many projects (no per-project reads), all filtered by user", async () => {
    const db = fakeDb(dbRows());
    const list = await craftLoader.loadCraftProjects(db, "user");
    assert.deepEqual(list.map((p) => [p.name, p.progress]), [["Personal — Test Blanket", "row 59"], ["Personal — Test Scarf", "row 119"]]);
    assert.deepEqual(db.log.map((q) => q.table), ["craft_projects", "projects", "craft_parts", "task_checklist_items"]);
    for (const q of db.log)
        assert.ok(q.filters.includes("eq user_id"), `${q.table} not filtered by user`);
    assert.ok(db.log[3].filters.includes("eq is_done"), "only unticked rows are read for the list");
    assert.ok(!db.log[3].cols.includes("text"), "the list never reads row text");
    const rows = dbRows();
    for (let i = 0; i < 5; i++) {
        const id = `5555555${i}-5555-4555-8555-555555555555`;
        rows.projects.push({ id, name: `More ${i}`, user_id: "user" });
        rows.craft_projects.push({ project_id: id, craft: "knit", gear: null, active_part_id: null, created_at: "2026-11-04T00:00:00Z", user_id: "user" });
    }
    const more = fakeDb(rows);
    assert.equal((await craftLoader.loadCraftProjects(more, "user")).length, 7);
    assert.equal(more.log.length, 4);
});
await test("Real GET detail and last-used carry the projects list, with the same auth path", async () => {
    const detail = await detailGet(request(fakeDb(dbRows()), `/api/craft/${blanketId}`), { params: Promise.resolve({ projectId: blanketId }) });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.project.id, blanketId);
    assert.deepEqual(body.projects, [{ id: blanketId, name: "Personal — Test Blanket", craft: "crochet", progress: "row 59" }, { id: scarfId, name: "Personal — Test Scarf", craft: "knit", progress: "row 119" }]);
    const last = await lastGet(request(fakeDb(dbRows()), "/api/craft"), { params: Promise.resolve({}) });
    assert.equal(last.status, 200);
    assert.equal((await last.json()).projects.length, 2);
});
await test("FR1 loader: can_remove and remove_blockers come from one craft_remove_blockers call for the shown project", async () => {
    const db = fakeDb(dbRows(), { blockers: () => ({ data: ["links", "quarters"], error: null }) });
    const view = await craftLoader.loadCraftView(db, "user", scarfId);
    assert.deepEqual(db.rpcCalls, [["craft_remove_blockers", { p_user_id: "user", p_project_id: scarfId }]]);
    assert.deepEqual([view.can_remove, view.remove_blockers], [false, ["links", "quarters"]]);
    const clean = await craftLoader.loadCraftView(fakeDb(dbRows()), "user", scarfId);
    assert.deepEqual([clean.can_remove, clean.remove_blockers], [true, []]);
    // Before 072 is applied (function missing) the screen still loads, without Remove.
    const original = console.error;
    console.error = () => { };
    try {
        const missing = await craftLoader.loadCraftView(fakeDb(dbRows(), { blockers: () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) }), "user", scarfId);
        assert.deepEqual([missing.can_remove, missing.remove_blockers], [false, null]);
        await assert.rejects(craftLoader.loadCraftView(fakeDb(dbRows(), { blockers: () => ({ data: null, error: { code: "XX000", message: "boom" } }) }), "user", scarfId));
    }
    finally {
        console.error = original;
    }
});
await test("Real GET: the view's own 404 wins when the list read fails too; a list failure alone is a 500", async () => {
    const res = await detailGet(request(errorClient("PGRST116")), { params: Promise.resolve({ projectId: scarfId }) });
    assert.equal(res.status, 404);
    const rows = dbRows();
    const db = fakeDb(rows), from = db.from.bind(db);
    db.from = (table) => { const q = from(table); if (table === "craft_projects") q.range = () => Promise.resolve({ data: null, error: { code: "XX000", message: "list failed" } }); return q; };
    const original = console.error;
    console.error = () => { };
    try {
        const failed = await detailGet(request(db, `/api/craft/${scarfId}`), { params: Promise.resolve({ projectId: scarfId }) });
        assert.equal(failed.status, 500);
        assert.equal(failed.headers.get("cache-control"), "no-store");
    }
    finally {
        console.error = original;
    }
});
console.log(`\nCraft: ${passed} passed, ${failed} failed`);
if (failed)
    process.exitCode = 1;
