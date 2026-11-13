#!/usr/bin/env node
// Craft S3 FR3, offline: checks (plain checklist steps) placed in pattern order and shown on the screen, the safe
// Change total (drops only "(est.)" or blank rows, renumbers the rest, refuses otherwise), adding rows with text and a
// work type, and the Parts list / sheet. Fake data shaped like the mittens (no live data). No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as C from "../src/lib/craft.ts";
import * as A from "../src/lib/craft/actions.ts";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e); } }

const CHECK_TEXT = "Check: cuff 4 in from cast-on? Then switch to US 7";
const GUSSET_CHECK = "Check: 48 sts, 13 between BOR and marker";
/**
 * A mitten like the live ones: Cuff (cast on, Rnd 1–21 rib, Rnd 22–28 (est.) rib, the US 7 check, Rnd 29–31 knit) and
 * Thumb gusset (Rnd 1–16, the 48-sts check, Rnd 17–20). `cuff` = the Cuff's rows as [row, text, type, done].
 */
function mitten({ cuffDone = 0, gussetDone = 0, cuff = null, castOnDone = false, active = null } = {}) {
  const cuffRows = cuff ?? [
    ...Array.from({ length: 21 }, (_, i) => [i + 1, `Rnd ${i + 1} · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 7 }, (_, i) => [i + 22, `Rnd ${i + 22} (est.) · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 3 }, (_, i) => [i + 29, `Rnd ${i + 29} · knit (US 7)`, "stockinette"]),
  ];
  const sortOf = (row) => (row <= 28 ? row : row + 1);
  const items = cuffRows.map(([row, text, type, done]) => ({ id: `cuff-${row}`, task_id: "cuff-task", sort_order: sortOf(row), craft_part_id: "cuff", craft_row: row, text,
    is_done: done ?? row <= cuffDone, completed_at: (done ?? row <= cuffDone) ? "2026-11-10T22:00:00Z" : null, unit_count: 36, work_type: type }));
  for (let row = 1; row <= 20; row++) items.push({ id: `gus-${row}`, task_id: "gusset-task", sort_order: row <= 16 ? row - 1 : row, craft_part_id: "gusset", craft_row: row,
    text: row === 1 ? "Rnd 1 (set-up) · k1, M1R, k1, pm" : `Rnd ${row} · gusset`, is_done: row <= gussetDone, completed_at: row <= gussetDone ? "2026-11-12T22:00:00Z" : null, unit_count: 36, work_type: "stockinette" });
  const total = Math.max(...cuffRows.map(([row]) => row));
  return {
    project: { id: "project", name: "Fake Mittens" }, craft_project: { craft: "knit", gear: null, active_part_id: active },
    parts: [
      { id: "cuff", name: "Cuff", total_rows: total, row_word: "round", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: 36 },
      { id: "gusset", name: "Thumb gusset", total_rows: 20, row_word: "round", sort_order: 1, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: null },
    ],
    items, segments: [{ id: "seg-cuff", part_id: "cuff", task_id: "cuff-task", name: "Mitten 1 · Cuff", from_row: 1, to_row: total, sort_order: 0, close_check: false },
      { id: "seg-gus", part_id: "gusset", task_id: "gusset-task", name: "Mitten 1 · Thumb gusset", from_row: 1, to_row: 20, sort_order: 0, close_check: false }],
    plain_items: [
      { id: "cast-on", task_id: "cuff-task", text: "Cast on 36 (long-tail, US 5), place BOR, join", is_done: castOnDone, sort_order: 0 },
      { id: "check-cuff", task_id: "cuff-task", text: CHECK_TEXT, is_done: false, sort_order: 29 },
      { id: "check-gus", task_id: "gusset-task", text: GUSSET_CHECK, is_done: false, sort_order: 16 },
    ],
    sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-12T23:00:00Z",
  };
}
/** Mitten 1 as Brent left it: the Cuff cut to 24 by S2's Change total (25–31 gone), all ticked; the Gusset unticked again. */
const mittenOneNow = () => mitten({ castOnDone: true, active: "gusset", cuff: Array.from({ length: 24 }, (_, i) => [i + 1, i < 21 ? `Rnd ${i + 1} · k1, p1 rib` : `Rnd ${i + 1} (est.) · k1, p1 rib`, "rib", true]) });
const ids = (list) => list.map((check) => check.id);

// ── Checks in pattern order ───────────────────────────────────────────────────
await test("Checks are placed in pattern order: Cast on before Cuff round 1; the US 7 check before round 29; the gusset's check between rounds 16 and 17", () => {
  const checks = C.buildCraftView(mitten()).checks;
  assert.deepEqual(checks.map((c) => [c.id, c.part_id, c.row, c.other_part]), [["cast-on", "cuff", 1, false], ["check-cuff", "cuff", 29, false], ["check-gus", "gusset", 17, false]]);
  assert.equal(C.checkBeforeText(checks[1]), "Before Round 29:");
});
await test("A check after a part's last row shows before the next part's first row (Mitten 1 now): \"Before Round 1 (Thumb gusset): Check: cuff 4 in…\"", () => {
  const view = C.buildCraftView(mittenOneNow());
  assert.equal(view.active_part.id, "gusset");
  assert.deepEqual(ids(view.due_checks), ["check-cuff"]);
  assert.equal(C.checkBeforeText(view.due_checks[0]), "Before Round 1 (Thumb gusset):");
  assert.equal(view.due_checks[0].text, CHECK_TEXT);
});
await test("A check from the screen part's own task before row 1 shows (Mitten 2's Cast on); ticked checks never show", () => {
  assert.deepEqual(ids(C.buildCraftView(mitten()).due_checks), ["cast-on"]);
  assert.equal(C.checkBeforeText(C.buildCraftView(mitten()).due_checks[0]), "Before Round 1:");
  assert.deepEqual(ids(C.buildCraftView(mitten({ castOnDone: true })).due_checks), []);
});
await test("Due checks: before the current row and after the last ticked row (gusset 16 ticked → the 48-sts check before round 17); rows ticked by Fix count past a check leave it showing", () => {
  const at17 = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" }));
  assert.deepEqual(ids(at17.due_checks), ["check-gus"]);
  assert.equal(C.checkBeforeText(at17.due_checks[0]), "Before Round 17:");
  const at15 = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 14, active: "gusset" }));
  assert.deepEqual(ids(at15.due_checks), []);
  // Fix count 15 → 18 ticks 15, 16, 17: the check stays unticked and on the screen.
  const fixed = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 17, active: "gusset" }));
  assert.equal(fixed.active_part.current_row, 18);
  assert.deepEqual(ids(fixed.due_checks), ["check-gus"]);
});
await test("Upcoming rows list checks in order with their text, a row ahead (round 28 now: the check comes before round 29); the inside list too", () => {
  const view = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 27 }));
  assert.equal(view.active_part.current_row, 28);
  assert.deepEqual(ids(view.upcoming_checks), ["check-cuff"]);
  const entries = C.upcomingWithChecks(view.next_rows.filter((r) => r.row > 28).slice(0, 3), view.upcoming_checks, "cuff");
  assert.deepEqual(entries.map((e) => (e.kind === "row" ? e.row : e.check.text)), [CHECK_TEXT, 29, 30, 31]);
  // Near the end of the Cuff, the check before the Gusset's first round shows up ahead too (Mitten 1's shape).
  const m1 = mittenOneNow(); m1.items.filter((i) => i.craft_part_id === "cuff" && i.craft_row > 22).forEach((i) => { i.is_done = false; });
  m1.craft_project.active_part_id = "cuff";
  const near = C.buildCraftView(m1);
  assert.deepEqual(ids(near.upcoming_checks), ["check-cuff"]);
  assert.equal(C.checkBeforeText(near.upcoming_checks[0]), "Before Round 1 (Thumb gusset):");
});
await test("A band close's \"Count …\" item (S2) is not a check: it never shows twice", () => {
  const v = mitten({ castOnDone: true });
  v.segments[0].close_check = true;
  v.plain_items.push({ id: "count", task_id: "cuff-task", text: "Count: 36 stitches", is_done: false, sort_order: 30 });
  assert.ok(!ids(C.buildCraftView(v).checks).includes("count"));
  v.segments[0].close_check = false;
  assert.ok(ids(C.buildCraftView(v).checks).includes("count"), "on a task without a band close it is a plain check");
});

// ── Change total: lowering ───────────────────────────────────────────────────
await test("Lowering Mitten 2's Cuff to 27 drops Rnd 25–28 (est.) and renumbers 29–31 to 25–27; the sheet says exactly that; \"Last (est.) round needed: 24\" gives the same total", () => {
  const view = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24 }));
  const rows = view.part_rows.cuff;
  const plan = A.setTotalPlan(rows, 31, 27);
  assert.deepEqual(plan, { kind: "remove", total: 27, remove: [25, 26, 27, 28], moves: [{ from: 29, to: 25 }, { from: 30, to: 26 }, { from: 31, to: 27 }] });
  assert.equal(A.renumberText("round", rows, plan), "Drops Rnd 25–28 (est.). Rnd 29–31 · knit (US 7) become Rnd 25–27. New total 27.");
  assert.deepEqual(A.estRange(rows, 31), { min: 24, max: 28 }, "from the round before the lowest unticked (est.) round");
  assert.equal(A.totalForLastEst(rows, 31, 24), 27);
  assert.equal(A.totalForLastEst(rows, 31, 28), 31);
});
await test("Lowering refuses what would drop a pattern row (not_est), a ticked (est.) row (ticked) or one in a sitting (in_sitting), in plain words", () => {
  const rows = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24 })).part_rows.cuff;
  const tooFar = A.setTotalPlan(rows, 31, 20);
  assert.deepEqual(tooFar, { kind: "refused", total: 20, reason: "not_est", rows: [22, 23, 24, 25, 26, 27, 28], need: 11 });
  assert.equal(A.setTotalRefusalText("round", tooFar), "Can't drop 11 rounds: only rounds 22–28 are (est.) or blank rounds. Rounds with pattern steps are never dropped.");
  const ticked = A.setTotalPlan(rows, 31, 25);
  assert.deepEqual(ticked, { kind: "refused", total: 25, reason: "ticked", rows: [23, 24] });
  const linked = rows.map((s) => (s.row === 27 ? { ...s, in_progress: true } : s));
  assert.deepEqual(A.setTotalPlan(linked, 31, 27), { kind: "refused", total: 27, reason: "in_sitting", rows: [27] });
  const noEst = rows.filter((s) => s.row <= 21 || s.row >= 29);
  assert.equal(A.setTotalRefusalText("round", A.setTotalPlan(noEst, 31, 30)), "Can't drop 1 round: this part has no (est.) or blank rounds left. Rounds with pattern steps are never dropped.");
});
await test("The scarf's blank \"Row N\" ending still lowers as in S2 (trailing rows, nothing renumbered)", () => {
  const rows = Array.from({ length: 519 }, (_, i) => ({ row: i + 1, done: i < 150, linked: false, today: false, text: `Row ${i + 1}` }));
  const plan = A.setTotalPlan(rows, 519, 455);
  assert.equal(plan.kind, "remove");
  assert.deepEqual([plan.remove[0], plan.remove.at(-1), plan.remove.length, plan.moves.length], [456, 519, 64, 0]);
  assert.equal(A.renumberText("row", rows, plan), "Drops Row 456–519. New total 455.");
});

// ── Change total: raising ────────────────────────────────────────────────────
await test("Raising: new rows get the label, the text typed and the last row's separator (\"Rnd 25 · knit (US 7)\"); a typed label is not doubled; no text = the bare label (as S2)", () => {
  assert.equal(A.newRowItemText("Rnd 24 (est.) · k1, p1 rib", "round", 25, "knit (US 7)"), "Rnd 25 · knit (US 7)");
  assert.equal(A.newRowItemText("Rnd 24 · k1, p1 rib", "round", 25, "Rnd 25 · knit (US 7)"), "Rnd 25 · knit (US 7)");
  assert.equal(A.newRowItemText("Row 3: sc across", "row", 4, "sc across"), "Row 4: sc across");
  assert.equal(A.newRowItemText("Rnd 24", "round", 25, ""), "Rnd 25");
  assert.equal(A.rowDescription("Rnd 24 (est.) · k1, p1 rib"), "k1, p1 rib");
  assert.equal(A.rowDescription("Row 519"), "");
});

// ── Rendered ─────────────────────────────────────────────────────────────────
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
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
const { ChangeTotalSheet, CheckFirstSheet, PartsSheet } = await import("../src/components/craft/CraftSheets.tsx");
const send = async () => ({ ok: true, status: 200, body: null, error: null });

await test("Screen: a check card above Now (\"Before Round 1 (Thumb gusset):\", its text, a Done button); the upcoming list shows checks; Parts by the part's name", () => {
  const html = renderToStaticMarkup(createElement(CraftScreen, { view: C.buildCraftView(mittenOneNow()) }));
  assert.match(html, /<ul class="craft-due-checks" aria-label="Checks before this row"><li class="craft-due-check"><div><small>Before Round 1 \(Thumb gusset\):<\/small><p>Check: cuff 4 in from cast-on\? Then switch to US 7<\/p><\/div><button[^>]*aria-label="Done: Check: cuff 4 in[^"]*"[^>]*>Done<\/button>/);
  assert.ok(html.indexOf("craft-due-checks") < html.indexOf('class="craft-pf"'), "above Now");
  assert.match(html, /class="craft-parts-open"[^>]*>Parts<\/button>/);
  assert.match(html, /aria-label="Work on this part: Cuff"|aria-label="Change total: Cuff"/);
  const at16 = renderToStaticMarkup(createElement(CraftScreen, { view: C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 15, active: "gusset" })) }));
  assert.match(at16, /<li class="craft-then-check"><span>check<\/span><p>Before Round 17: Check: 48 sts, 13 between BOR and marker<\/p><\/li>/);
  assert.match(at16, /<li class="craft-next-check">Before Round 17: Check: 48 sts/);
  assert.doesNotMatch(html + at16, /Claude|Anthropic|OpenAI|ChatGPT/);
});
await test("Row done with a check showing asks first: \"Not done yet\" lists the check; Yes ticks it then the row; Not yet keeps both (source + sheet)", () => {
  const src = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(dueChecks\.length\) \{ setSheet\("check-first"\); return; \}/);
  assert.match(src, /const reply = await send\("check", \{ item_ids: dueChecks\.map\(\(check\) => check\.id\) \}\);\n    if \(!reply\.ok\) return reply\.error;\n    setSheet\(null\);\n    rowDoneNow\(\);/);
  const view = C.buildCraftView(mittenOneNow());
  const html = renderToStaticMarkup(createElement(CheckFirstSheet, { checks: view.due_checks, onClose: () => {}, onYes: async () => null }));
  assert.match(html, /aria-label="Not done yet"[\s\S]*<small>Before Round 1 \(Thumb gusset\):<\/small><p>Check: cuff 4 in/);
  assert.match(html, /Done it\?[\s\S]*Yes ticks the check, then the round\. Not yet leaves both as they are\.[\s\S]*>Not yet<\/button>[\s\S]*>Yes, done<\/button>/);
});
await test("Parts sheet: each part has Work on this part (unfinished, not on the screen) and Change total… (finished parts too)", () => {
  const view = C.buildCraftView(mittenOneNow());
  const html = renderToStaticMarkup(createElement(PartsSheet, { open: true, onClose: () => {}, view, send, onChangeTotal: () => {} }));
  assert.match(html, /<li><strong>Cuff<\/strong><span>Finished<\/span><div class="craft-part-buttons"><button[^>]*aria-label="Change total: Cuff"[^>]*>Change total…<\/button><\/div><\/li>/);
  assert.match(html, /<li aria-current="true"><strong>Thumb gusset<\/strong><span>Round 1 · on the screen<\/span>/);
  const v = mittenOneNow(); v.craft_project.active_part_id = null; v.items.find((i) => i.id === "cuff-24").is_done = false;
  const two = renderToStaticMarkup(createElement(PartsSheet, { open: true, onClose: () => {}, view: C.buildCraftView(v), send, onChangeTotal: () => {} }));
  assert.match(two, /aria-label="Work on this part: Thumb gusset"[^>]*>Work on this part</);
});
await test("Change total sheet, lowering Mitten 2 at round 25: \"Last (est.) round needed\" (24) and the exact renumber line before Save", () => {
  const view = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24 }));
  const html = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: view.active_part, send }));
  assert.match(html, /aria-pressed="true"[^>]*>Last \(est\.\) round needed<\/button>/);
  assert.match(html, /<label for="craft-total-est">Last \(est\.\) round needed<span>total 27<\/span><\/label>[\s\S]*value="24"/);
  assert.match(html, /<p class="craft-sheet-preview">Drops Rnd 25–28 \(est\.\)\. Rnd 29–31 · knit \(US 7\) become Rnd 25–27\. New total 27\.<\/p>/);
});
await test("Change total sheet on a finished part (Mitten 1's Cuff from the Parts list): the total stepper, and when raising the text field and work type picker", () => {
  const view = C.buildCraftView(mittenOneNow());
  const cuff = view.parts.find((p) => p.id === "cuff");
  const html = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send }));
  assert.match(html, /Cuff: 24 rounds now, all ticked\./);
  assert.match(html, /<label for="craft-total">Total rounds<\/label>/);
  assert.match(html, /Same as now\./);
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /<Input id="craft-total-text" value=\{text\} maxLength=\{200\} placeholder="e\.g\. knit \(US 7\)"/);
  assert.match(src, /<Select id="craft-total-type" value=\{type\}/);
  assert.match(src, /\.\.\.\(plan\.kind === "add" \? \{ text: text\.trim\(\) \|\| null, work_type: type \|\| null \} : \{\}\)/);
  assert.deepEqual(view.work_types, ["rib", "stockinette"]);
});
await test("CSS (FR3): tokens only, nothing under 12px, check cards and Done at least 48px", () => {
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
  assert.doesNotMatch(css, /font-size:\s*(\d|1[01])(\.\d+)?px/);
  assert.match(css, /\.craft-due-check > button \{ min-width: 88px; min-height: 48px; \}/);
});

console.log(`\nCraft S3 FR3: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
