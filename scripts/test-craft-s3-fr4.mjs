#!/usr/bin/env node
// Craft S3 FR4, offline (the FR3 review follow-ups): a raise can't go wrong silently (no prefill from an "(est.)" row,
// Save waits for text or "Same as round N", where the new rows go when a step follows the last row), the take-back of
// rows a raise added (named, asked twice), passed checks as one quiet "earlier steps" line, Change total opening on no
// change, check order and the step after the last row, the payload, and the renumber edges. Fake data only. No network.
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
/** The FR3 mitten (Cuff: cast on, Rnd 1–21 rib, 22–28 (est.) rib, the US 7 check, 29–31 knit; Thumb gusset 1–16, a check, 17–20). */
function mitten({ cuffDone = 0, gussetDone = 0, cuff = null, castOnDone = false, active = null, checkDone = false } = {}) {
  const cuffRows = cuff ?? [
    ...Array.from({ length: 21 }, (_, i) => [i + 1, `Rnd ${i + 1} · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 7 }, (_, i) => [i + 22, `Rnd ${i + 22} (est.) · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 3 }, (_, i) => [i + 29, `Rnd ${i + 29} · knit (US 7)`, "stockinette"]),
  ];
  const sortOf = (row) => (row <= 28 ? row : row + 1);
  // FR5: the rows' items were made before the set-up made the parts (set-up links items that already exist).
  const items = cuffRows.map(([row, text, type, done]) => ({ id: `cuff-${row}`, task_id: "cuff-task", sort_order: sortOf(row), craft_part_id: "cuff", craft_row: row, text,
    is_done: done ?? row <= cuffDone, completed_at: (done ?? row <= cuffDone) ? "2026-11-10T22:00:00Z" : null, unit_count: 36, work_type: type, created_at: "2026-11-01T12:00:00.123456+00:00" }));
  for (let row = 1; row <= 20; row++) items.push({ id: `gus-${row}`, task_id: "gusset-task", sort_order: row <= 16 ? row - 1 : row, craft_part_id: "gusset", craft_row: row,
    text: row === 1 ? "Rnd 1 (set-up) · k1, M1R, k1, pm" : `Rnd ${row} · gusset`, is_done: row <= gussetDone, completed_at: row <= gussetDone ? "2026-11-12T22:00:00Z" : null, unit_count: 36, work_type: "stockinette" });
  const total = Math.max(...cuffRows.map(([row]) => row));
  return {
    project: { id: "project", name: "Fake Mittens" }, craft_project: { craft: "knit", gear: null, active_part_id: active },
    parts: [
      { id: "cuff", name: "Cuff", total_rows: total, row_word: "round", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: 36, created_at: "2026-11-11T20:00:00.5+00:00" },
      { id: "gusset", name: "Thumb gusset", total_rows: 20, row_word: "round", sort_order: 1, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: null, created_at: "2026-11-11T20:00:00.5+00:00" },
    ],
    items, segments: [{ id: "seg-cuff", part_id: "cuff", task_id: "cuff-task", name: "Mitten 1 · Cuff", from_row: 1, to_row: total, sort_order: 0, close_check: false },
      { id: "seg-gus", part_id: "gusset", task_id: "gusset-task", name: "Mitten 1 · Thumb gusset", from_row: 1, to_row: 20, sort_order: 0, close_check: false }],
    plain_items: [
      { id: "cast-on", task_id: "cuff-task", text: "Cast on 36 (long-tail, US 5), place BOR, join", is_done: castOnDone, sort_order: 0 },
      { id: "check-cuff", task_id: "cuff-task", text: CHECK_TEXT, is_done: checkDone, sort_order: 29 },
      { id: "check-gus", task_id: "gusset-task", text: GUSSET_CHECK, is_done: false, sort_order: 16 },
    ],
    sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-12T23:00:00Z",
  };
}
/** Mitten 1 as Brent left it: the Cuff cut to 24 by S2 (25–31 gone), all ticked; the screen on the Gusset. */
const mittenOneNow = (opts = {}) => mitten({ castOnDone: true, active: "gusset", ...opts, cuff: Array.from({ length: 24 }, (_, i) => [i + 1, i < 21 ? `Rnd ${i + 1} · k1, p1 rib` : `Rnd ${i + 1} (est.) · k1, p1 rib`, "rib", true]) });
/** Mitten 1 after the WRONG raise (Fable R13): Rnd 25–27 "k1, p1 rib" / rib, unticked, after the US 7 check. */
const mittenOneWrongRaise = () => {
  const v = mitten({ castOnDone: true, active: "cuff", cuff: [
    ...Array.from({ length: 24 }, (_, i) => [i + 1, i < 21 ? `Rnd ${i + 1} · k1, p1 rib` : `Rnd ${i + 1} (est.) · k1, p1 rib`, "rib", true]),
    ...Array.from({ length: 3 }, (_, i) => [i + 25, `Rnd ${i + 25} · k1, p1 rib`, "rib", false]),
  ] });
  for (const item of v.items) if (item.craft_part_id === "cuff" && item.craft_row >= 25) { item.sort_order = item.craft_row + 5; item.created_at = "2026-11-12T23:30:00.000001+00:00"; } // after the check (29), made by the raise
  return v;
};
/** A scarf: rows 1..n bare "Row N" (sort 2r) on one task, steps after given rows (sort 2r+1). */
function scarf({ n = 455, done = 0, steps = [], textRows = {} } = {}) {
  const items = [];
  for (let r = 1; r <= n; r++) items.push({ id: `row-${String(r).padStart(4, "0")}`, task_id: "scarf-task", sort_order: 2 * r, craft_part_id: "scarf", craft_row: r, text: textRows[r] ?? `Row ${r}`,
    is_done: r <= done, completed_at: r <= done ? "2026-11-05T23:00:00Z" : null, unit_count: 40, work_type: "garter" });
  return {
    project: { id: "scarf-project", name: "Fake Scarf" }, craft_project: { craft: "knit", gear: null, active_part_id: "scarf" },
    parts: [{ id: "scarf", name: "Scarf", total_rows: n, row_word: "row", sort_order: 0, quarters: true, quarter: 0, quarter_row: null, ridges: true, stitch_count: 40 }],
    items, segments: [{ id: "seg-scarf", part_id: "scarf", task_id: "scarf-task", name: "Scarf rows", from_row: 1, to_row: n, sort_order: 0, close_check: false }],
    plain_items: steps.map(([after, text, id], i) => ({ id: id ?? `step-${i}`, task_id: "scarf-task", text, is_done: false, sort_order: 2 * after + 1 })),
    sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-12T23:00:00Z",
  };
}
const ids = (list) => list.map((check) => check.id);

// ── Rendering: TSX through TypeScript, CSS and the Modal stubbed (as test-craft-s3-fr3.mjs) ──
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
const { ChangeTotalSheet, CheckFirstSheet, EarlierSteps } = await import("../src/components/craft/CraftSheets.tsx");
const send = async () => ({ ok: true, status: 200, body: null, error: null });

// ── 1. A raise can't go wrong silently ──────────────────────────────────────────
await test("FR4 1 raise defaults: never from an (est.) row: \"Same as round 21: k1, p1 rib\" and the work type of round 21 (Mitten 1); Mitten 2's last pattern row is round 31 knit (US 7) / stockinette", () => {
  const one = C.buildCraftView(mittenOneNow());
  assert.deepEqual(A.raiseDefaults(C.partRowsOf(one, "cuff")), { same: { row: 21, text: "k1, p1 rib" }, type: "rib" });
  const two = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24, active: "cuff" }));
  assert.deepEqual(A.raiseDefaults(C.partRowsOf(two, "cuff")), { same: { row: 31, text: "knit (US 7)" }, type: "stockinette" });
  assert.deepEqual(A.raiseDefaults([{ row: 1, done: false, linked: false, today: false, text: "Rnd 1 (est.) · rib", type: "rib" }]), { same: null, type: null });
  assert.deepEqual(A.raiseDefaults(C.partRowsOf(C.buildCraftView(scarf()), "scarf")), { same: { row: 455, text: "" }, type: "garter" }, "a bare label: \"just the label\"");
});
await test("FR4 1 raise sheet (Mitten 1's Cuff 24 → 27): the text starts EMPTY with the placeholder, Save stays disabled with the reason, \"Same as round 21\" is offered, and the sheet asks where the rounds go (the US 7 check follows Rnd 24)", () => {
  const view = C.buildCraftView(mittenOneNow());
  const cuff = view.parts.find((p) => p.id === "cuff");
  const html = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 27 } }));
  assert.match(html, /<input[^>]*id="craft-total-text"[^>]*placeholder="e\.g\. knit \(US 7\)"[^>]*value=""|<input[^>]*id="craft-total-text"[^>]*value=""[^>]*placeholder="e\.g\. knit \(US 7\)"/);
  assert.doesNotMatch(html, /value="k1, p1 rib"/, "never prefilled");
  assert.match(html, /aria-pressed="false"[^>]*>Same as round 21: k1, p1 rib<\/button>/);
  assert.match(html, /<option value="rib" selected="">rib<\/option>/, "work type: the last non-(est.) row's");
  assert.match(html, /After Rnd 24 comes the step “Check: cuff 4 in from cast-on\? Then switch to US 7”\./);
  assert.match(html, /aria-pressed="false"[^>]*>New rounds before it<\/button>[\s\S]*aria-pressed="false"[^>]*>New rounds after it<\/button>/);
  assert.match(html, /<p class="craft-sheet-preview">Type the pattern text for the new rounds, or pick “Same as round 21”\.<\/p>/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Save total<\/button>/);
  // Text typed but no place picked: still disabled, and says why.
  const typed = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 27, text: "knit (US 7)", type: "stockinette" } }));
  assert.match(typed, /Pick where the new rounds go: before or after the step after Rnd 24\./);
  assert.match(typed, /<button type="submit"[^>]*disabled=""[^>]*>Save total<\/button>/);
  // Filled: the line before Save, and Save on.
  const filled = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 27, text: "knit (US 7)", type: "stockinette", place: "after_steps" } }));
  assert.match(filled, /<p class="craft-sheet-preview">Adds Rnd 25–27 · knit \(US 7\) at the end \(stockinette\), 36 stitches each\. The step “Check: cuff 4 in from cast-on\? Then switch to US 7” stays before Rnd 25\. The screen moves to this part\.<\/p>/);
  assert.doesNotMatch(filled, /<button type="submit"[^>]*disabled=""/);
  const before = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 27, text: "knit (US 7)", type: "stockinette", place: "after_row" } }));
  assert.match(before, /<p class="craft-sheet-preview">Adds Rnd 25–27 · knit \(US 7\) right after Rnd 24 \(stockinette\), 36 stitches each\. The step “Check: cuff 4 in from cast-on\? Then switch to US 7” moves after Rnd 27\. The screen moves to this part\.<\/p>/);
  // No step after the last row (Mitten 2 from 31): the plain line, the FR3 review's words.
  const v2 = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24, active: "gusset" }));
  const two = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view: v2, part: v2.parts.find((p) => p.id === "cuff"), send, initial: { total: 34, text: "knit (US 7)", type: "stockinette" } }));
  assert.match(two, /Adds Rnd 32–34 · knit \(US 7\) at the end \(stockinette\), 36 stitches each\. The screen moves to this part\./);
  assert.doesNotMatch(two, /New rounds before it/);
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /const textOk = typed !== "" \|\| text\.same;/);
  assert.match(src, /onClick=\{\(\) => setText\(\{ value: defaults\.same\?\.text \?\? "", same: true \}\)\}/, "Same as … is a deliberate pick");
  assert.match(src, /onChange=\{\(e\) => setText\(\{ value: e\.target\.value, same: false \}\)\}/);
});
await test("FR4 1 the raise's line names where the rows go when a step follows the last row (the scarf's Bind off): before it (the step moves after the new rows) or after it", () => {
  const steps = [{ id: "s", text: "Bind off loosely" }];
  const base = { label: "Row", add: [456, 457, 458], lastRow: 455, text: "knit", type: "garter", units: 40, onScreen: true, steps };
  assert.equal(A.raiseSummary({ ...base, place: "after_row" }), "Adds Row 456–458 · knit right after Row 455 (garter), 40 stitches each. The step “Bind off loosely” moves after Row 458.");
  assert.equal(A.raiseSummary({ ...base, place: "after_steps" }), "Adds Row 456–458 · knit at the end (garter), 40 stitches each. The step “Bind off loosely” stays before Row 456.");
  assert.equal(A.raiseSummary({ ...base, steps: [], place: null, onScreen: false }), "Adds Row 456–458 · knit at the end (garter), 40 stitches each. The screen moves to this part.");
  const view = C.buildCraftView(scarf({ steps: [[455, "Bind off loosely"]] }));
  assert.deepEqual(C.trailingStepsOf(view, "scarf"), [{ id: "step-0", text: "Bind off loosely" }]);
  assert.deepEqual(C.trailingStepsOf(C.buildCraftView(mittenOneNow()), "cuff"), [{ id: "check-cuff", text: CHECK_TEXT }]);
  assert.deepEqual(C.trailingStepsOf(C.buildCraftView(mittenOneNow({ checkDone: true })), "cuff"), [], "a ticked step isn't asked about");
});

// ── 1. Take back rows a raise added ─────────────────────────────────────────────
await test("FR4 1 take back (Fable R13): after the wrong raise the usual lowering 27 → 24 refuses (22–24 ticked); the take-back drops Rnd 25–27 whatever their text, named first", () => {
  const view = C.buildCraftView(mittenOneWrongRaise());
  const rows = C.partRowsOf(view, "cuff");
  assert.deepEqual(A.setTotalPlan(rows, 27, 24), { kind: "refused", total: 24, reason: "ticked", rows: [22, 23, 24] });
  const plan = A.takeBackPlan(rows, 27, 24);
  assert.deepEqual(plan, { kind: "remove", total: 24, remove: [25, 26, 27], moves: [] });
  assert.equal(A.takeBackRowsText("round", rows, plan.remove), "pattern rounds 25–27 · k1, p1 rib");
  // Never a ticked row or one in a sitting.
  assert.deepEqual(A.takeBackPlan(rows.map((s) => (s.row === 26 ? { ...s, done: true } : s)), 27, 24), { kind: "refused", total: 24, reason: "ticked", rows: [26], remove: [25, 26, 27] });
  assert.deepEqual(A.takeBackPlan(rows.map((s) => (s.row === 27 ? { ...s, in_progress: true } : s)), 27, 24), { kind: "refused", total: 24, reason: "in_sitting", rows: [27], remove: [25, 26, 27] });
  // Not offered when it is what the usual lowering does (the scarf's blank tail) or for a raise.
  const s = C.partRowsOf(C.buildCraftView(scarf({ n: 519, done: 300 })), "scarf");
  assert.equal(A.takeBackPlan(s, 519, 455), null);
  assert.equal(A.takeBackPlan(rows, 27, 30), null);
  assert.equal(A.takeBackRowsText("round", [{ row: 5, text: "Rnd 5 · a" }, { row: 6, text: "Rnd 6 · b" }], [5, 6]), "pattern rounds 5 · a and 6 · b");
});
await test("FR4 1 take-back sheet: the refusal, then \"Remove the last 3 rounds instead (Rnd 25–27)…\"; the second, explicit question \"Also remove pattern rounds 25–27 · k1, p1 rib?\" with Keep them / Yes, remove them; the body says take_back", () => {
  const view = C.buildCraftView(mittenOneWrongRaise());
  const cuff = view.active_part;
  const html = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 24 } }));
  // FR5: the refusal names what is ticked and never says to undo knitted rounds.
  assert.match(html, /<p class="craft-sheet-warn">Rounds 22–24 are ticked; no unticked \(est\.\) rounds are left to drop\.<\/p>/);
  assert.match(html, />Remove the last 3 rounds instead \(Rnd 25–27\)…<\/button>/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Save total<\/button>/, "the usual Save can't do it");
  const ask = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send, initial: { total: 24, takeBack: true } }));
  assert.match(ask, /<p class="craft-check-q">Also remove pattern rounds 25–27 · k1, p1 rib\?<\/p>/);
  assert.match(ask, /A raise added them; they are unticked and in no sitting\. Their pattern text goes with them\. New total 24\./);
  assert.match(ask, />Keep them<\/button>[\s\S]*<button type="submit"[^>]*>Yes, remove them<\/button>/);
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /void save\(asking \? "take_back" : null\);/);
  assert.match(src, /\.\.\.\(how \? \{ how \} : \{\}\) \}\);/);
  // The usual lowering stays the default: Mitten 2 at round 25 lowering to 27 drops the (est.) rounds; the take-back is only offered beside it.
  const v2 = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24, active: "cuff" }));
  const two = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view: v2, part: v2.active_part, send, initial: { total: 27 } }));
  assert.match(two, /<p class="craft-sheet-preview">Drops Rnd 25–28 \(est\.\)\. Rnd 29–31 · knit \(US 7\) become Rnd 25–27\. New total 27\.<\/p>/);
  assert.doesNotMatch(two, /Also remove/);
});

// ── 2. Passed checks don't nag ──────────────────────────────────────────────────
await test("FR4 2 only a check at the CURRENT row gates Row done; older passed, unticked ones are \"N earlier steps not ticked\" (the scarf on row 301: two, no card)", () => {
  const s = C.buildCraftView(scarf({ n: 455, done: 300, steps: [[120, "Re-time at 15 in"], [250, "Join skein 2"]] }));
  assert.equal(s.active_part.current_row, 301);
  assert.deepEqual(s.due_checks, []);
  assert.deepEqual(s.earlier_checks.map((c) => [C.checkBeforeText(c), c.text]), [["Before Row 121:", "Re-time at 15 in"], ["Before Row 251:", "Join skein 2"]]);
  assert.equal(C.earlierStepsText(2), "2 earlier steps not ticked");
  assert.equal(C.earlierStepsText(1), "1 earlier step not ticked");
  // The current-row check card stays as it is (Gusset round 17).
  const g = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" }));
  assert.deepEqual(ids(g.due_checks), ["check-gus"]);
  assert.deepEqual(g.earlier_checks, []);
  const src = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(dueChecks\.length\) \{ setSheet\("check-first"\); return; \}/);
  assert.match(src, /const dueChecks = view\.due_checks \?\? \[\];/);
});
await test("FR4 2 the screen: one quiet line (collapsed), its list with Done on each and Mark all done; the card above Now only for the current row", () => {
  const view = C.buildCraftView(scarf({ n: 455, done: 300, steps: [[120, "Re-time at 15 in"], [250, "Join skein 2"]] }));
  const html = renderToStaticMarkup(createElement(CraftScreen, { view }));
  assert.match(html, /<button type="button" class="craft-earlier-line" aria-expanded="false" aria-controls="craft-earlier-list"><span>2 earlier steps not ticked<\/span>/);
  assert.doesNotMatch(html, /craft-due-checks/);
  const list = renderToStaticMarkup(createElement(EarlierSteps, { checks: view.earlier_checks, busy: null, onDone: () => {}, defaultOpen: true }));
  assert.match(list, /aria-expanded="true"/);
  assert.match(list, /<small>Before Row 121:<\/small><p>Re-time at 15 in<\/p><\/div><button[^>]*aria-label="Done: Re-time at 15 in"[^>]*>Done<\/button>/);
  assert.match(list, /<small>Before Row 251:<\/small><p>Join skein 2<\/p>/);
  assert.match(list, />Mark all done<\/button>/);
  const one = renderToStaticMarkup(createElement(EarlierSteps, { checks: view.earlier_checks.slice(0, 1), busy: null, onDone: () => {}, defaultOpen: true }));
  assert.doesNotMatch(one, /Mark all done/, "one step: just its Done");
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /onClick=\{\(\) => onDone\("check-earlier", checks\.map\(\(check\) => check\.id\)\)\}>Mark all done/);
});
await test("FR4 2 \"Not yet\" lets Brent carry on: Row done ticks the row and the check stays, listed with the earlier steps (source + the sheet's words)", () => {
  const src = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /onNotYet=\{\(\) => \{ setSheet\(null\); rowDoneNow\(\); \}\}/);
  const g = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 16, active: "gusset" }));
  const html = renderToStaticMarkup(createElement(CheckFirstSheet, { checks: g.due_checks, onClose: () => {}, onYes: async () => null, onNotYet: () => {} }));
  assert.match(html, /Yes ticks the step, then round 17\. Not yet ticks round 17 only; the step stays on the list of earlier steps not ticked\./);
  // After that Row done (round 17 ticked, the check not), the check is an earlier step and Row done no longer asks.
  const after = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 31, gussetDone: 17, active: "gusset" }));
  assert.deepEqual([after.active_part.current_row, ids(after.due_checks), ids(after.earlier_checks)], [18, [], ["check-gus"]]);
});

// ── 3. Change total starts on no change ─────────────────────────────────────────
await test("FR4 3 Change total opens on the current total everywhere, before the (est.) rounds too (Mitten 2 on round 10): \"Same as now.\" and Save disabled", () => {
  for (const cuffDone of [9, 24, 31]) {
    const view = C.buildCraftView(mitten({ castOnDone: true, cuffDone, active: cuffDone === 31 ? "gusset" : "cuff" }));
    const cuff = view.parts.find((p) => p.id === "cuff");
    const html = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: cuff, send }));
    assert.match(html, /<input id="craft-total" type="number"[^>]*value="31"/, `cuff done to ${cuffDone}`);
    assert.match(html, /Same as now\./);
    assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Save total<\/button>/);
  }
  // The "(est.)" mode, once picked, waits for the stepper too.
  const view = C.buildCraftView(mitten({ castOnDone: true, cuffDone: 9, active: "cuff" }));
  const est = renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part: view.active_part, send, initial: { mode: "est" } }));
  assert.match(est, /<label for="craft-total-est">Last \(est\.\) round needed<span>total 31<\/span><\/label>/);
  assert.match(est, /Same as now\./);
});

// ── 4. Check order and the step after the last row ─────────────────────────────
await test("FR4 4 (Astra 1) consecutive checks keep their sort order; the id only breaks a tie", () => {
  const v = scarf({ n: 4, steps: [] });
  v.plain_items = [{ id: "z-first", task_id: "scarf-task", text: "First", is_done: false, sort_order: 3 }, { id: "a-second", task_id: "scarf-task", text: "Second", is_done: false, sort_order: 4 },
    { id: "b-tie", task_id: "scarf-task", text: "Tie b", is_done: false, sort_order: 5 }, { id: "a-tie", task_id: "scarf-task", text: "Tie a", is_done: false, sort_order: 5 }];
  v.items.find((i) => i.craft_row === 2).sort_order = 6; v.items.find((i) => i.craft_row === 3).sort_order = 8; v.items.find((i) => i.craft_row === 4).sort_order = 10;
  assert.deepEqual(C.buildCraftView(v).checks.map((c) => [c.text, c.row]), [["First", 2], ["Second", 2], ["Tie a", 2], ["Tie b", 2]]);
});
await test("FR4 4 (Astra 2) a step after the project's last row (\"Bind off\") is the part's \"After the last row\" card once that row is ticked; listed ahead near the end; never a Row done gate", () => {
  const steps = [[455, "Bind off loosely", "bind-off"]];
  const early = C.buildCraftView(scarf({ done: 300, steps }));
  assert.deepEqual(early.checks.map((c) => [c.text, c.row, c.after_last]), [["Bind off loosely", 455, true]]);
  assert.deepEqual([early.due_checks, early.earlier_checks, early.after_last_checks, early.upcoming_checks], [[], [], [], []]);
  const near = C.buildCraftView(scarf({ done: 453, steps }));
  assert.deepEqual(ids(near.upcoming_checks), ["bind-off"]);
  const entries = C.upcomingWithChecks(near.next_rows.filter((r) => r.row > 454), near.upcoming_checks, "scarf");
  assert.deepEqual(entries.map((e) => (e.kind === "row" ? e.row : e.check.text)), [455, "Bind off loosely"], "after the last row, not before it");
  const done = C.buildCraftView(scarf({ done: 455, steps }));
  assert.deepEqual(ids(done.after_last_checks), ["bind-off"]);
  assert.deepEqual(done.due_checks, []);
  assert.equal(C.checkBeforeText(done.after_last_checks[0], done.active_part?.id ?? null), "After the last row:");
  const html = renderToStaticMarkup(createElement(CraftScreen, { view: done }));
  assert.match(html, /<ul class="craft-due-checks" aria-label="After the last row"><li class="craft-due-check"><div><small>After the last row:<\/small><p>Bind off loosely<\/p><\/div><button[^>]*aria-label="Done: Bind off loosely"[^>]*>Done<\/button>/);
  // On a two-part project the last part's step shows from the other part's screen with the part's name.
  const m = mitten({ castOnDone: true, cuffDone: 31, gussetDone: 20, active: "cuff" });
  m.plain_items.push({ id: "bind", task_id: "gusset-task", text: "Bind off", is_done: false, sort_order: 99 });
  const mv = C.buildCraftView(m);
  assert.equal(C.checkBeforeText(mv.after_last_checks[0], "cuff"), "After the last round (Thumb gusset):");
});

// ── 5. Payload ───────────────────────────────────────────────────────────────────
await test("FR4 5 (Fable R4/R17) the reply carries the screen part's rows once (row_states); part_rows holds only the other parts; a 455-row scarf's view is about half what it was", () => {
  const view = C.buildCraftView(scarf({ n: 455, done: 300 }));
  assert.deepEqual(Object.keys(view.part_rows), []);
  assert.equal(view.row_states.length, 455);
  assert.equal(C.partRowsOf(view, "scarf"), view.row_states);
  const bytes = JSON.stringify(view).length;
  console.log(`    scarf 455 rows: view ${bytes} bytes, row_states ${JSON.stringify(view.row_states).length}, part_rows ${JSON.stringify(view.part_rows).length}`);
  assert.ok(bytes < 2 * JSON.stringify(view.row_states).length, "the rows are no longer carried twice");
  const m = C.buildCraftView(mittenOneNow());
  assert.deepEqual(Object.keys(m.part_rows), ["cuff"], "the Gusset is on the screen; the Cuff's rows are there for its Change total");
});

// ── 6. Renumber edges ────────────────────────────────────────────────────────────
await test("FR4 6 renumbering (Fable R3): any case (rnd / Rnd / RND, row, round), a leading range as a whole, numbers later in the text left alone (TS mirror of 074)", () => {
  assert.equal(A.renumberRowText("rnd 6 · knit", 5), "rnd 5 · knit");
  assert.equal(A.renumberRowText("RND 6 · knit", 5), "RND 5 · knit");
  assert.equal(A.renumberRowText("row 12: purl", 9), "row 9: purl");
  assert.equal(A.renumberRowText("Round 5: knit, as Rnd 4", 4), "Round 4: knit, as Rnd 4");
  assert.equal(A.renumberRowText("Rnd 4–6 · knit", 3), "Rnd 3–5 · knit");
  assert.equal(A.renumberRowText("Rnd 4-6 · knit", 3), "Rnd 3-5 · knit");
  assert.equal(A.renumberRowText("Rnd  8 - k2tog (see Rnd 3)", 6), "Rnd  6 - k2tog (see Rnd 3)");
  assert.equal(A.renumberRowText("K to end (Rnd 9)", 7), "K to end (Rnd 9)");
  assert.equal(A.renumberRowText("Rnd 7 (EST.) · maybe", 5), "Rnd 5 (EST.) · maybe");
  assert.equal(A.rowLabelOf([{ text: "rnd 1 · rib" }], "round"), "rnd");
  assert.equal(A.rowDescription("Rnd 4–6 · knit"), "knit");
  assert.equal(A.rowDescription("rnd 6 · knit"), "knit");
});
await test("FR4 6 Undo below a ticked check leaves it ticked, by design (the screen can't tell whether the step itself was undone); a ticked step never shows again", () => {
  // A ticked plain item is not a check at all, whatever the rows around it do.
  const undone = mitten({ castOnDone: true, cuffDone: 26, active: "cuff", checkDone: true });
  const view = C.buildCraftView(undone);
  assert.equal(view.active_part.current_row, 27);
  assert.ok(!ids(view.checks).includes("check-cuff"));
  const docs = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  assert.ok(docs.includes("Undo or Ripped back below a ticked step leaves it ticked"), "CLAUDE.md says why, in one line");
});

// ── 7. Fable 2: an already-ticked cuff check doesn't show after the repair ─────
await test("FR4 7 (Fable R14) Mitten 1 with the cuff check ticked from the Gusset screen, then repaired: no \"Before Round 25\" card, no earlier step for it, Round 25 is Now", () => {
  const repaired = mitten({ castOnDone: true, checkDone: true, active: "cuff", cuff: [
    ...Array.from({ length: 24 }, (_, i) => [i + 1, i < 21 ? `Rnd ${i + 1} · k1, p1 rib` : `Rnd ${i + 1} (est.) · k1, p1 rib`, "rib", true]),
    ...Array.from({ length: 3 }, (_, i) => [i + 25, `Rnd ${i + 25} · knit (US 7)`, "stockinette", false]),
  ] });
  for (const item of repaired.items) if (item.craft_part_id === "cuff" && item.craft_row >= 25) item.sort_order = item.craft_row + 5;
  const view = C.buildCraftView(repaired);
  assert.deepEqual([view.active_part.name, view.active_part.current_row, view.next_rows[0].text], ["Cuff", 25, "Rnd 25 · knit (US 7)"]);
  assert.deepEqual([view.due_checks, view.earlier_checks], [[], []]);
});

// ── CSS ──────────────────────────────────────────────────────────────────────────
await test("FR4 CSS: tokens only, nothing under 12px, the earlier-steps line and its Done buttons at least 44px", () => {
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
  assert.doesNotMatch(css, /font-size:\s*(\d|1[01])(\.\d+)?px/);
  assert.match(css, /\.craft-earlier-line \{[^}]*min-height: 44px;/);
  assert.match(css, /\.craft-earlier-list li > button \{ min-width: 72px; min-height: 44px; \}/);
});

console.log(`\nCraft S3 FR4: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
