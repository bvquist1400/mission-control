#!/usr/bin/env node
// Craft S3, offline: rows in progress ("Partway through row N"), "Ripped back", the S2 review follow-ups
// F2/F3/F5/F6 in TypeScript, the view model's in-progress rows, rip-back sittings and history, and the
// rendered screen and sheets. No network, fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as C from "../src/lib/craft.ts";
const { buildCraftView, removeBlockersText, RIP_CHOICES } = C;
import * as A from "../src/lib/craft/actions.ts";
import { blanketInput, input, part, rows } from "./fixtures/craft/sample-views.mjs";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e); } }
const states = (total, done, extra = {}) => Array.from({ length: total }, (_, i) => ({ row: i + 1, done: i < done, linked: false, today: false, ...extra }));
const timer = (extra = {}) => ({ running: true, paused_at: null, elapsed_seconds: 48 * 60, ...extra });
const NOW = "2026-11-12T23:00:00Z";
const minutesBefore = (m) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

// ── Partway through row N ─────────────────────────────────────────────────────
await test("Partway row: the next existing row after \"last full row\"; none past the end; a row ticked ahead can't be partway", () => {
  assert.equal(A.partwayRow(states(157, 62), 157, 62), 63);
  assert.equal(A.partwayRow(states(157, 157), 157, 157), null);
  const gap = states(31, 21).filter((s) => s.row < 22 || s.row > 28);
  assert.equal(A.partwayRow(gap, 31, 21), 29, "gaps skipped");
  const ahead = states(100, 62).map((s) => (s.row === 64 ? { ...s, done: true } : s));
  assert.equal(A.partwayRow(ahead, 100, 63), null, "row 64 is ticked ahead (chat)");
  // A row after "last full row" below the current row is unticked by the save, so it can be partway.
  assert.equal(A.partwayRow(states(100, 63), 100, 62), 63);
});
await test("Partway default with the timer: ON more than 2 min after the last Row done (or with no Row done), OFF within 2 min; paused timers stop at the pause", () => {
  const s = states(157, 62);
  const form = { from: 60, to: 62 };
  assert.equal(A.partwayDefault(s, 157, form, timer(), NOW, minutesBefore(15)), true, "15 min since row 62");
  assert.equal(A.partwayDefault(s, 157, form, timer(), NOW, minutesBefore(2)), false, "exactly 2 min: off");
  assert.equal(A.partwayDefault(s, 157, form, timer(), NOW, minutesBefore(1)), false);
  assert.equal(A.partwayDefault(s, 157, form, timer(), NOW, null), true, "no Row done in the sitting");
  // Paused 1 minute after the last Row done, saved 30 minutes later: the timer only ran 1 minute after it.
  const paused = timer({ running: false, paused_at: minutesBefore(29) });
  assert.equal(A.partwayDefault(s, 157, form, paused, NOW, minutesBefore(30)), false);
  // Never more than the timer itself shows (a 1-minute timer can't have run 10 min after anything).
  assert.equal(A.partwayDefault(s, 157, form, timer({ elapsed_seconds: 60 }), NOW, minutesBefore(10)), false);
  assert.equal(A.partwayDefault(states(157, 157), 157, { from: 150, to: 157 }, timer(), NOW, null), false, "no row left");
});
await test("Partway default with typed minutes (no timer): OFF while rows are saved, ON when none are (the minutes went into the row being worked)", () => {
  const s = states(157, 62);
  assert.equal(A.partwayDefault(s, 157, { from: 59, to: 62 }, null, NOW, null), false);
  assert.equal(A.partwayDefault(s, 157, { from: 62, to: 62 }, null, NOW, null), true);
});
await test("The Log sitting preview says it: \"Saves rows 61–62 and part of row 63, 48 min\"; across parts the row in progress is named by part", () => {
  const s = states(157, 62);
  const plan = A.sittingPlan(s, 157, 60, 62);
  assert.equal(A.sittingSummary("row", "Blanket", plan, [], 48, 63), "Saves rows 61–62 and part of row 63, 48 min");
  assert.equal(A.sittingSummary("row", "Blanket", plan, [], 48), "Saves rows 61–62, 48 min", "S2's line when off");
  assert.equal(A.sittingSummary("row", "Blanket", A.sittingPlan(s, 157, 62, 62), [], 30, 63), "Saves part of row 63, 30 min");
  const other = [{ part_id: "cuff", name: "Cuff", word: "round", rows: [29, 30, 31] }];
  assert.equal(A.sittingSummary("round", "Hand", A.sittingPlan(states(45, 0), 45, 0, 0), other, 52, 1), "Saves Cuff rounds 29–31 and part of Hand round 1, 52 min");
});
await test("Log sitting body: in_progress follows the toggle; a quarter is always partway; S2's \"next update\" warning is gone", () => {
  const form = { from: 60, to: 62, quarter: 0, note: "", key: "k", minutesTouched: false };
  assert.equal(A.logSittingBody({ id: "p", current_row: 63 }, { version: 2, over_cap: false }, { ...form, partway: true }, 48).in_progress, true);
  assert.equal(A.logSittingBody({ id: "p", current_row: 63 }, { version: 2, over_cap: false }, { ...form, partway: false }, 48).in_progress, false);
  assert.equal(A.logSittingBody({ id: "p", current_row: 63 }, null, { ...form, quarter: 2 }, 48).in_progress, true);
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sheets, /once the next update ships/);
  assert.match(sheets, /Partway through \{word\} \{partRow\}/);
});
await test("Change total refuses to remove a row in progress in a sitting (074 counts it as in the sitting)", () => {
  const s = states(10, 6).map((r) => (r.row === 10 ? { ...r, in_progress: true } : r));
  assert.deepEqual(A.setTotalPlan(s, 10, 8), { kind: "refused", total: 8, reason: "in_sitting", rows: [10] });
});

// ── F3: the rows actually saved ───────────────────────────────────────────────
await test("F3: the confirmation names the rows the server saved, not the preview's (rows another sitting took are gone)", () => {
  const parts = [{ id: "Blanket", name: "Blanket", row_word: "row" }];
  // The sheet previewed 59–62; another sitting took 59–60 meanwhile, so 61–62 and part of 63 were saved.
  assert.equal(A.savedSittingText({ status: "ok", saved_rows: [61, 62], in_progress_row: 63, other_rows: [], minutes: 48 }, "row", "Blanket", parts),
    "Saved rows 61–62 and part of row 63, 48 min.");
  assert.equal(A.savedSittingText({ status: "ok", saved_rows: [], in_progress_row: null, other_rows: [], minutes: 20 }, "row", "Blanket", parts), "Saved 20 min, the time only (no rows).");
  const mittens = [{ id: "cuff", name: "Cuff", row_word: "round" }, { id: "hand", name: "Hand", row_word: "round" }];
  assert.equal(A.savedSittingText({ status: "ok", saved_rows: [1, 2], in_progress_row: null, other_rows: [{ part_id: "cuff", rows: [29, 30, 31] }], minutes: 52 }, "round", "Hand", mittens),
    "Saved Cuff rounds 29–31 and Hand rounds 1–2, 52 min.");
  assert.equal(A.savedSittingText({ status: "duplicate", saved_rows: [61], minutes: 9 }, "row", "Blanket", parts), "Already saved: row 61, 9 min.");
  const screen = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /onSaved=\{\(reply\) => \{ setSheet\(null\); onSittingSaved\(reply\); \}\}/);
  assert.match(screen, /confirm\(savedSittingText\(result,/);
});

// ── F2 / F5 / F6 ──────────────────────────────────────────────────────────────
await test("F2: the Row done toast's Undo sends the server's one-row mode (undo_one), never plain undo", () => {
  assert.deepEqual(A.toastUndo(states(157, 58), 157, 59, 60), { kind: "one", body: { mode: "undo_one", to_row: 59, expected_row: 60 } });
  const service = readFileSync(new URL("../src/lib/craft/write-service.ts", import.meta.url), "utf8");
  assert.match(service, /mode !== "undo_one"/);
});
await test("F5: Undo, Fix count and Change total sheets go stale on a timer-only or total-only change (S2 watched those only for Log sitting / Change total)", () => {
  const before = { part_id: "p", part_name: "Blanket", word: "row", current_row: 63, total: 157, timer_version: 4, timer_part_id: "p" };
  assert.equal(A.sheetChangeText(before, { ...before, timer_version: 5 }), "Your timer changed on another screen. Check and save again.");
  assert.equal(A.sheetChangeText(before, { ...before, timer_part_id: null, timer_version: null }), "Your timer changed on another screen. Check and save again.");
  assert.equal(A.sheetChangeText(before, { ...before, total: 160 }), "Your total changed on another screen (now 160 rows). Check and save again.");
  assert.equal(A.sheetChangeText(before, { ...before }), null);
  // The sheets use the default (no opt-out).
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sheets, /timer: false|total: false/);
});
await test("F6: \"N rounds this sitting\" counts every part the sitting saves; \"Use the new count\" keeps a typed note and minutes", () => {
  const other = [{ part_id: "cuff", name: "Cuff", word: "round", rows: [15, 16, 17] }];
  assert.equal(A.sittingCountText("round", 0, 2, other), "5 rounds this sitting (3 on Cuff)");
  assert.equal(A.sittingCountText("round", 0, 0, other), "3 rounds this sitting (3 on Cuff)");
  assert.equal(A.sittingCountText("row", 60, 61, []), "1 row this sitting");
  const typed = { minutes: 41, minutesTouched: true, from: 58, to: 61, quarter: 0, note: "tension tight", key: "k1", partway: true, partwayTouched: true };
  const fresh = { minutes: 48, minutesTouched: false, from: 58, to: 62, quarter: 0, note: "", key: "k2", partway: false, partwayTouched: false };
  assert.deepEqual(A.retakeLogForm(typed, fresh), { ...fresh, note: "tension tight", minutes: 41, minutesTouched: true, key: "k1" });
  assert.deepEqual(A.retakeLogForm({ ...typed, minutesTouched: false, minutes: 40 }, fresh).minutes, 48, "untouched minutes follow the timer");
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(sheets, /setForm\(\(f\) => retakeLogForm\(f, logForm\(live, livePart\)\)\)/);
  assert.match(sheets, /hint=\{sittingCountText\(word, form\.from, form\.to, other\)\}/);
});

// ── Ripped back ───────────────────────────────────────────────────────────────
const rip = (id, links, extra = {}) => ({ id, date: "2026-11-12", minutes: 48, excluded: false, exclude_reason: null, extra_units: 0, links, ...extra });
const L = (row, in_progress = false, part_id = "Blanket") => ({ part_id, row, in_progress });
await test("Ripped back plan: rows N to current − 1; all-ripped sittings are left out, partly ripped ones are listed, excluded ones keep their reason; the current row's partial work goes too", () => {
  const s = states(157, 62); // current row 63
  const sittings = [
    rip("all", [L(61), L(62), L(63, true)]),
    rip("partly", [L(58), L(59), L(60), L(61)], { minutes: 30, date: "2026-11-11" }),
    rip("already", [L(62)], { excluded: true, exclude_reason: "interrupted" }),
    rip("elsewhere", [L(10)]),
    rip("extra", [L(61)], { extra_units: 20 }),
  ];
  const plan = A.frogPlan(s, 157, "Blanket", sittings, 61);
  assert.deepEqual([plan.from, plan.to, plan.current, plan.ripped, plan.partway], [61, 62, 63, [61, 62], 63]);
  assert.deepEqual(plan.all.map((x) => x.id), ["all"]);
  assert.deepEqual(plan.partly.map((x) => x.id), ["partly", "extra"], "extra units are work that wasn't ripped");
  assert.deepEqual(plan.already.map((x) => x.id), ["already"]);
  assert.equal(A.keepsText("row", "Blanket", plan.partly[0].keeps), "keeps rows 58–60");
  assert.equal(A.keepsText("round", "Hand", [L(30, false, "Cuff"), L(1, false, "Hand")]), "keeps round 1 and 1 row of other parts");
  assert.equal(A.frogReason("row", 61, 62), "ripped back rows 61–62");
  assert.equal(A.frogReason("round", 3, 3), "ripped back round 3");
  const body = A.frogBody({ id: "Blanket", current_row: 63 }, plan, { note: "  dropped a stitch ", key: "k", exclude: ["partly", "all", "nope"] });
  assert.deepEqual(body, { part_id: "Blanket", expected_row: 63, from_row: 61, to_row: 62, note: "dropped a stitch", exclude_session_ids: ["partly"], idempotency_key: "k" });
  assert.equal(A.frogPlan(s, 157, "Blanket", [], 62).partway, null, "no work on the current row in any sitting");
});
await test("Ripped back is offered for the last 40 ticked rows (contiguous up to the current row)", () => {
  assert.equal(RIP_CHOICES, 40);
  const choices = A.undoChoices(states(157, 62), 157, RIP_CHOICES);
  assert.deepEqual([choices.length, choices[0], choices.at(-1)], [40, 62, 23]);
});

// ── The view ──────────────────────────────────────────────────────────────────
function blanketWithSittings() {
  const v = blanketInput();
  v.items.forEach((row) => { if (row.craft_part_id === "Blanket" && row.craft_row <= 62) { row.is_done = true; row.completed_at = row.craft_row >= 61 ? "2026-11-12T22:30:00Z" : "2026-11-07T18:00:00Z"; } });
  v.server_now = NOW;
  v.sessions = [
    { id: "s1", session_date: "2026-11-11", created_at: "2026-11-11T23:00:00Z", minutes: 20, note: null, exclude_from_stats: false, exclude_reason: null, extra_units: null },
    { id: "s2", session_date: "2026-11-12", created_at: "2026-11-12T22:40:00Z", minutes: 48, note: null, exclude_from_stats: false, exclude_reason: null, extra_units: null },
    { id: "s0", session_date: "2026-11-10", created_at: "2026-11-10T22:40:00Z", minutes: 30, note: null, exclude_from_stats: true, exclude_reason: "ripped back rows 55–56", extra_units: null },
  ];
  v.session_items = [
    { session_id: "s1", checklist_item_id: "Blanket-61", in_progress: true },
    { session_id: "s2", checklist_item_id: "Blanket-61" }, { session_id: "s2", checklist_item_id: "Blanket-62" },
    { session_id: "s2", checklist_item_id: "Blanket-63", in_progress: true },
  ];
  v.frogs = [{ id: "f1", part_id: "Blanket", from_row: 55, to_row: 56, note: "twisted stitches", session_ids: ["s0"], created_at: "2026-11-10T23:00:00Z" }];
  return v;
}
await test("View: a row in progress is not \"linked\" (finished) but in_progress; Recent sittings list it apart; excluded sittings carry their reason", () => {
  const view = buildCraftView(blanketWithSittings());
  const r = (n) => view.row_states.find((s) => s.row === n);
  assert.deepEqual([r(61).linked, r(61).in_progress, r(62).linked, r(63).linked, r(63).in_progress], [true, true, true, false, true]);
  const s2 = view.recent_sittings.find((s) => s.id === "s2");
  assert.deepEqual(s2.rows.map((x) => x.row), [61, 62]);
  assert.deepEqual(s2.in_progress_rows.map((x) => x.row), [63]);
  assert.equal(view.recent_sittings.find((s) => s.id === "s0").exclude_reason, "ripped back rows 55–56");
});
await test("View: rip-back sittings carry all their links; the history list has the frog with its sittings; Remove names it", () => {
  const view = buildCraftView(blanketWithSittings());
  assert.deepEqual(view.rip_sittings.map((s) => s.id), ["s2", "s1"]);
  assert.deepEqual(view.rip_sittings[0].links, [L(61), L(62), L(63, true)]);
  assert.deepEqual(view.frogs.map((f) => [f.from_row, f.to_row, f.note, f.sittings_left_out, f.part_name]), [[55, 56, "twisted stitches", 1, "Blanket"]]);
  assert.equal(removeBlockersText(["frogs"]), "ripped-back history");
  const plan = A.frogPlan(view.row_states, 157, "Blanket", view.rip_sittings, 61);
  assert.deepEqual([plan.all.map((s) => s.id), plan.partly.map((s) => s.id)], [["s2", "s1"], []]);
});
await test("View: the sitting's last Row done (any part) for the Partway default; none without a timer", () => {
  const v = blanketWithSittings();
  assert.equal(buildCraftView(v).timer_last_done_at, null);
  v.timer = { user_id: "u", project_id: "project", part_id: "Blanket", sitting_started_at: "2026-11-12T22:00:00Z", running_since: "2026-11-12T22:00:00Z", paused_at: null,
    banked_seconds: 0, adjust_seconds: 0, start_row: 61, start_quarter: 0, version: 3, created_at: "2026-11-12T22:00:00Z", updated_at: "2026-11-12T22:00:00Z" };
  const view = buildCraftView(v);
  assert.equal(view.timer_last_done_at, "2026-11-12T22:30:00Z");
  assert.equal(A.partwayDefault(view.row_states, 157, { from: 60, to: 62 }, view.timer, view.server_now, view.timer_last_done_at), true, "30 min after row 62");
});

// ── Rendered ──────────────────────────────────────────────────────────────────
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  // Sheets render through Modal's portal; on the server render the panel inline.
  if (url.startsWith("file:") && url.endsWith("/components/ui/Modal.tsx")) {
    return { format: "module", shortCircuit: true, source: `import { jsx, jsxs } from "react/jsx-runtime";
export function Modal({ open, title, children }) { return open ? jsxs("div", { role: "dialog", "aria-modal": "true", "aria-label": title, children: [jsx("h2", { children: title }), children] }) : null; }` };
  }
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const { CraftScreen } = await import("../src/components/craft/CraftScreen.tsx");
const { LogSittingSheet, UndoRowsSheet } = await import("../src/components/craft/CraftSheets.tsx");
const send = async () => ({ ok: true, status: 200, body: null, error: null });
await test("Screen: Recent sittings say \"part of row 63\" and a ripped-back sitting's reason; the Ripped back history sits under Parts; Ripped back… is in the menu row", () => {
  const html = renderToStaticMarkup(createElement(CraftScreen, { view: buildCraftView(blanketWithSittings()) }));
  assert.match(html, /Blanket: row 61 · Blanket: row 62 · Blanket: part of row 63/);
  assert.match(html, /Blanket: part of row 61</);
  assert.match(html, /Left out of speed: ripped back rows 55–56/);
  assert.match(html, /<h2>Parts<\/h2>[\s\S]*<div class="craft-frogs"><h3>Ripped back<\/h3><ol aria-label="Ripped back history">[\s\S]*Blanket · rows 55–56[\s\S]*twisted stitches[\s\S]*1 sitting left out of speed/);
  assert.match(html, />Ripped back…<\/button>/);
  assert.doesNotMatch(html, /Claude|Anthropic|OpenAI|ChatGPT/);
});
await test("Log sitting sheet: the Partway through toggle is a labelled checkbox, on by default 30 min after the last Row done; the preview says \"and part of row 63\"", () => {
  const v = blanketWithSittings();
  v.session_items = [];
  v.timer = { user_id: "u", project_id: "project", part_id: "Blanket", sitting_started_at: "2026-11-12T22:00:00Z", running_since: "2026-11-12T22:00:00Z", paused_at: null,
    banked_seconds: 0, adjust_seconds: 0, start_row: 61, start_quarter: 0, version: 3, created_at: "2026-11-12T22:00:00Z", updated_at: "2026-11-12T22:00:00Z" };
  const view = buildCraftView(v);
  const html = renderToStaticMarkup(createElement(LogSittingSheet, { open: true, onClose: () => {}, view, part: view.active_part, send, onSaved: () => {} }));
  assert.match(html, /<label class="craft-partway" data-on="true"><input type="checkbox" checked=""\/><span>Partway through row 63<\/span>/);
  assert.match(html, /Saves rows 61–62 and part of row 63, 1 h/);
  assert.match(html, /2 rows this sitting/);
});
await test("Undo sheet: Wrong count and Ripped back are two clearly named choices; Ripped back lists left-out and partly ripped sittings (unticked by default) and says how to put rows back", () => {
  const v = blanketWithSittings();
  v.session_items.push({ session_id: "s9", checklist_item_id: "Blanket-58" }, { session_id: "s9", checklist_item_id: "Blanket-61" });
  v.sessions.push({ id: "s9", session_date: "2026-11-09", created_at: "2026-11-09T22:00:00Z", minutes: 35, note: null, exclude_from_stats: false, exclude_reason: null, extra_units: null });
  const view = buildCraftView(v);
  const html = renderToStaticMarkup(createElement(UndoRowsSheet, { open: true, onClose: () => {}, view, part: view.active_part, send, initialMode: "rip", initialTo: 61 }));
  assert.match(html, /aria-label="What happened"[\s\S]*>Wrong count<[\s\S]*aria-pressed="true"[^>]*>Ripped back</);
  assert.match(html, /First row pulled out/);
  assert.match(html, /Left out of speed \(every row in them ripped\)[\s\S]*Nov 12 · 48 min[\s\S]*Nov 11 · 20 min/);
  assert.match(html, /Partly ripped: tick to leave out of speed too[\s\S]*<input type="checkbox"\/><span>Nov 9 · 35 min<\/span><small>keeps row 58<\/small>/);
  assert.match(html, /There is no un-rip: to put rows back, use Fix count\./);
  assert.match(html, /Unticks rows 61–62 and takes the part of row 63 out of its sitting\. 2 sittings left out of speed\. Row 61 next\./);
  // The default is the last row only; that sitting (rows 61–62) is then only partly ripped.
  const one = renderToStaticMarkup(createElement(UndoRowsSheet, { open: true, onClose: () => {}, view, part: view.active_part, send, initialMode: "rip" }));
  assert.match(one, /<span>Nov 12 · 48 min<\/span><small>keeps row 61<\/small>/);
  assert.match(one, /Speed: no sitting left out\./);
  assert.match(html, />Rip back</);
  const undo = renderToStaticMarkup(createElement(UndoRowsSheet, { open: true, onClose: () => {}, view, part: view.active_part, send }));
  assert.match(undo, /Ticked by mistake\? This unticks them\. Sittings and speed stay as they are \(like Fix count\)\./);
});
await test("CSS (S3): tokens only, nothing under 12px, 48px+ rows for the new toggles and checkboxes", () => {
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
  assert.doesNotMatch(css, /font-size:\s*(\d|1[01])(\.\d+)?px/);
  assert.match(css, /\.craft-partway \{[^}]*min-height: 52px;/);
  assert.match(css, /\.craft-rip-partly label \{[^}]*min-height: 48px;/);
});

console.log(`\nCraft S3: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
