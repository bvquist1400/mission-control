#!/usr/bin/env node
// Craft S3 FR5, offline (the FR4 re-check findings): take-back only for rows a raise added (never Mitten 2's set-up
// rounds 29–31, at totals 27 and 24), a refused lowering names the real blocker and offers the total it can reach, a
// raise with no `how` before a step is refused in plain words, "Mark all done" past 50 steps, the before/after choice
// and the earlier-steps list placed so nothing sits under the sticky bars at 360 px, and the work type in the raise
// line. Fake data only (the FR4 mitten and scarf shapes). No network.
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
const { ChangeTotalSheet, EarlierSteps } = await import("../src/components/craft/CraftSheets.tsx");
const send = async () => ({ ok: true, status: 200, body: null, error: null });


const sheet = (view, part, initial) => renderToStaticMarkup(createElement(ChangeTotalSheet, { open: true, onClose: () => {}, view, part, send, initial }));
/** Mitten 2 as on 11/12: the rib ticked to 24, Rnd 25–28 (est.) and the set-up Rnd 29–31 · knit (US 7) unticked; the screen on the Cuff. */
const mittenTwo = () => C.buildCraftView(mitten({ castOnDone: true, cuffDone: 24, active: "cuff" }));
/** Mitten 1 after the wrong raise, with Rnd 25 ticked (knitted before the mistake was seen). */
const wrongRaiseTicked25 = () => { const v = mittenOneWrongRaise(); for (const item of v.items) if (item.id === "cuff-25") { item.is_done = true; item.completed_at = "2026-11-13T00:10:00Z"; } return v; };

// ── 1. P1: take back only rows a raise added (Mitten 2) ──────────────────────────
await test("FR5 1 rows a raise added are marked `raised` (item made after the part, to the microsecond); set-up rows and a part with no created_at never are", () => {
  const rows = C.partRowsOf(C.buildCraftView(mittenOneWrongRaise()), "cuff");
  assert.deepEqual(rows.filter((s) => s.raised).map((s) => s.row), [25, 26, 27]);
  assert.deepEqual(C.partRowsOf(mittenTwo(), "cuff").filter((s) => s.raised), [], "Mitten 2: every round came with the set-up");
  assert.ok(C.timestampMicros("2026-11-11T20:00:00.500001+00:00") > C.timestampMicros("2026-11-11T20:00:00.5+00:00"));
  assert.equal(C.timestampMicros("2026-11-11T20:00:00.5+00:00"), C.timestampMicros("2026-11-11T20:00:00.500000Z"));
  const noTimes = mittenOneWrongRaise(); for (const p of noTimes.parts) delete p.created_at;
  assert.deepEqual(C.partRowsOf(C.buildCraftView(noTimes), "cuff").filter((s) => s.raised), [], "unknown = set-up (never taken back)");
});
await test("FR5 1 Mitten 2 at total 27: the usual lowering (drop Rnd 25–28 (est.), Rnd 29–31 become 25–27) and NO take-back: no \"Remove the last 4 rounds instead (Rnd 28–31)\"", () => {
  const view = mittenTwo(), rows = C.partRowsOf(view, "cuff");
  assert.equal(A.takeBackPlan(rows, 31, 27), null);
  const html = sheet(view, view.active_part, { total: 27 });
  assert.match(html, /<p class="craft-sheet-preview">Drops Rnd 25–28 \(est\.\)\. Rnd 29–31 · knit \(US 7\) become Rnd 25–27\. New total 27\.<\/p>/);
  assert.doesNotMatch(html, /instead|Remove the last|Also remove/);
  // Even asked for directly (a stale screen), the confirm can't appear.
  assert.doesNotMatch(sheet(view, view.active_part, { total: 27, takeBack: true }), /Also remove|Yes, remove them/);
});
await test("FR5 1 Mitten 2 at total 24: no take-back (\"Remove the last 7 rounds instead (Rnd 25–31)\" is gone); the sheet says \"Can't remove rounds 22–24: they are ticked; drop only (est.) rounds 25–28 → total 27.\" and offers Use total 27, which is the usual plan", () => {
  const view = mittenTwo(), rows = C.partRowsOf(view, "cuff");
  assert.equal(A.takeBackPlan(rows, 31, 24), null);
  for (const next of [30, 29, 28, 26, 25, 24, 23, 20, 1]) assert.equal(A.takeBackPlan(rows, 31, next), null, `never for set-up rows (total ${next})`);
  assert.deepEqual(A.lowestTotalPlan(rows, 31), { total: 27, rows: [25, 26, 27, 28] });
  assert.deepEqual(A.lowerRefusal("round", rows, 31, 24), { text: "Can't remove rounds 22–24: they are ticked; drop only (est.) rounds 25–28 → total 27.", suggest: 27 });
  const html = sheet(view, view.active_part, { total: 24 });
  assert.match(html, /<p class="craft-sheet-warn">Can&#x27;t remove rounds 22–24: they are ticked; drop only \(est\.\) rounds 25–28 → total 27\.<\/p>/);
  assert.match(html, />Use total 27<\/button>/);
  assert.doesNotMatch(html, /instead|Remove the last|Undo/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Save total<\/button>/);
  const use = sheet(view, view.active_part, { total: 27 });
  assert.match(use, /Drops Rnd 25–28 \(est\.\)\. Rnd 29–31 · knit \(US 7\) become Rnd 25–27\. New total 27\./);
  // Too far: not_est, the same reachable total.
  assert.equal(A.lowerRefusal("round", rows, 31, 20).text, "Can't drop 11 rounds: only rounds 22–28 are (est.) or blank rounds. Rounds with pattern steps are never dropped. Drop only (est.) rounds 25–28 → total 27.");
  // Rows in a sitting: named, and the total above them.
  const sat = rows.map((s) => (s.row === 26 ? { ...s, in_progress: true } : s));
  assert.deepEqual(A.lowerRefusal("round", sat, 31, 28), { text: "Can't remove round 26: it is part of a saved sitting; drop only (est.) rounds 27–28 → total 29.", suggest: 29 });
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /onClick=\{\(\) => \{ const n = refusal\.suggest as number; setMode\("total"\); setValue\(n\); \}\}>Use total \{refusal\.suggest\}/);
});
await test("FR5 1 R13's wrong raise still offers the take-back of Rnd 25–27 (raised, unticked, in no sitting), with the confirm line saying a raise added them", () => {
  const view = C.buildCraftView(mittenOneWrongRaise()), rows = C.partRowsOf(view, "cuff");
  assert.deepEqual(A.takeBackPlan(rows, 27, 24), { kind: "remove", total: 24, remove: [25, 26, 27], moves: [] });
  const html = sheet(view, view.active_part, { total: 24 });
  assert.match(html, />Remove the last 3 rounds instead \(Rnd 25–27\)…<\/button>/);
  const ask = sheet(view, view.active_part, { total: 24, takeBack: true });
  assert.match(ask, /Also remove pattern rounds 25–27 · k1, p1 rib\?/);
  assert.match(ask, /A raise added them; they are unticked and in no sitting\. Their pattern text goes with them\. New total 24\./);
  assert.doesNotMatch(ask, /not \(est\.\)/, "FR4's wrong claim is gone");
  // A raised row that says "(est.)", or a set-up row above the new total: not offered.
  assert.equal(A.takeBackPlan(rows.map((s) => (s.row === 27 ? { ...s, text: "Rnd 27 (est.) · k1, p1 rib" } : s)), 27, 24), null);
  assert.equal(A.takeBackPlan(rows.map((s) => (s.row === 25 ? { ...s, raised: undefined } : s)), 27, 24), null);
  // Rows a raise added on top of Mitten 2 (wrong raise to 34): taken back beside the usual lowering, never past them.
  const v2 = mitten({ castOnDone: true, cuffDone: 24, active: "cuff", cuff: [
    ...Array.from({ length: 21 }, (_, i) => [i + 1, `Rnd ${i + 1} · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 7 }, (_, i) => [i + 22, `Rnd ${i + 22} (est.) · k1, p1 rib`, "rib"]),
    ...Array.from({ length: 6 }, (_, i) => [i + 29, `Rnd ${i + 29} · knit (US 7)`, "stockinette"]),
  ] });
  for (const item of v2.items) if (item.craft_part_id === "cuff" && item.craft_row >= 32) item.created_at = "2026-11-13T01:00:00Z";
  const r2 = C.partRowsOf(C.buildCraftView(v2), "cuff");
  assert.deepEqual(A.takeBackPlan(r2, 34, 31), { kind: "remove", total: 31, remove: [32, 33, 34], moves: [] });
  assert.equal(A.takeBackPlan(r2, 34, 30), null, "Rnd 31 came with the set-up");
});

// ── 2. P3: the real blocker after a wrong raise with Rnd 25 ticked ──────────────
await test("FR5 2 after the wrong raise with Rnd 25 ticked, lowering to 24 names round 25 (\"Can't take back rounds 25–27, added by a raise: round 25 is ticked.\"), never rounds 22–24 and never \"Undo\"", () => {
  const view = C.buildCraftView(wrongRaiseTicked25()), rows = C.partRowsOf(view, "cuff");
  assert.deepEqual(A.takeBackPlan(rows, 27, 24), { kind: "refused", total: 24, reason: "ticked", rows: [25], remove: [25, 26, 27] });
  assert.deepEqual(A.lowerRefusal("round", rows, 27, 24), { text: "Can't take back rounds 25–27, added by a raise: round 25 is ticked.", suggest: null });
  const html = sheet(view, view.active_part, { total: 24 });
  assert.match(html, /<p class="craft-sheet-warn">Can&#x27;t take back rounds 25–27, added by a raise: round 25 is ticked\.<\/p>/);
  assert.doesNotMatch(html, /22–24|Undo|instead/);
  // In a sitting instead: named the same way.
  const sat = rows.map((s) => (s.row === 25 ? { ...s, done: false } : s.row === 27 ? { ...s, linked: true } : s));
  assert.equal(A.lowerRefusal("round", sat, 27, 24).text, "Can't take back rounds 25–27, added by a raise: round 27 is part of a saved sitting.");
  // A blocker ABOVE the new total is named as the usual lowering names it (S2's words, no "Undo"): raised bare rows 11–15, 13 ticked, 15 → 12.
  const bare = Array.from({ length: 15 }, (_, i) => ({ row: i + 1, done: i + 1 <= 5 || i + 1 === 13, linked: false, today: false, text: `Row ${i + 1}`, ...(i + 1 > 10 ? { raised: true } : {}) }));
  assert.deepEqual(A.lowerRefusal("row", bare, 15, 12), { text: "Can't remove row 13: it is ticked; drop only rows 14–15 → total 13.", suggest: 13 });
  // The route's words for 074's not_raised.
  assert.equal(A.setTotalRefusalText("round", { reason: "not_raised", rows: [28, 29, 30, 31], remove: [28, 29, 30, 31] }),
    "Can't take back rounds 28–31: rounds 28–31 weren't added by a raise or are (est.). Only rounds a raise added can be taken back; (est.) rounds go with the usual lowering.");
  // The route (no button there) adds that raised rows can be taken back.
  const plain = C.partRowsOf(C.buildCraftView(mittenOneWrongRaise()), "cuff");
  assert.equal(A.lowerRefusal("round", plain, 27, 24, true).text, "Can't remove rounds 22–24: they are ticked; no unticked (est.) rounds are left to drop. Rounds 25–27 were added by a raise and can be taken back instead.");
});

// ── 3. P2: a raise with no `how` before a step ───────────────────────────────────
await test("FR5 3 a raise with no `how` while a step follows the last row: the route's words (\"Say whether the new rounds go before or after the step\"); the screen always asks and sends `how` then", () => {
  assert.equal(A.raiseWhereText("round", ["Check: cuff 4 in from cast-on? Then switch to US 7"], 24),
    "Not saved: the step “Check: cuff 4 in from cast-on? Then switch to US 7” comes after round 24. Say whether the new rounds go before or after the step.");
  assert.equal(A.raiseWhereText("row", ["Bind off", "Weave in ends"], 455), "Not saved: the steps “Bind off” and “Weave in ends” come after row 455. Say whether the new rows go before or after the steps.");
  const src = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(src, /const placeOk = !steps\.length \|\| place !== null;/);
  assert.match(src, /\.\.\.\(steps\.length && place \? \{ how: place \} : \{\}\)/);
  const ws = readFileSync(new URL("../src/lib/craft/write-service.ts", import.meta.url), "utf8");
  assert.match(ws, /reason === "where" \? raiseWhereText\(/);
  const sql = readFileSync(new URL("../supabase/migrations/074_craft_progress.sql", import.meta.url), "utf8");
  assert.match(sql, /IF p_how IS NULL THEN[\s\S]{0,1200}'reason', 'where', 'steps', v_steps, 'after_row', v_last\.craft_row/);
});

// ── 4. P3: Mark all done past 50 ────────────────────────────────────────────────
await test("FR5 4 \"Mark all done\" with 51 earlier steps sends them (limit 500 per call, more in order); the route's limit is the same constant", () => {
  const ids51 = Array.from({ length: 51 }, (_, i) => `id-${i}`);
  assert.equal(A.CRAFT_CHECK_IDS_MAX, 500);
  assert.deepEqual(A.checkBatches(ids51).map((b) => b.length), [51]);
  assert.deepEqual(A.checkBatches(Array.from({ length: 1001 }, (_, i) => `x${i}`)).map((b) => b.length), [500, 500, 1]);
  assert.deepEqual(A.checkBatches(ids51, 50).map((b) => b.length), [50, 1]);
  const s = C.buildCraftView(scarf({ n: 455, done: 300, steps: Array.from({ length: 51 }, (_, i) => [i + 1, `Step ${i + 1}`]) }));
  assert.equal(s.earlier_checks.length, 51);
  const list = renderToStaticMarkup(createElement(EarlierSteps, { checks: s.earlier_checks, busy: null, onDone: () => {}, defaultOpen: true }));
  assert.match(list, /51 earlier steps not ticked/);
  assert.match(list, />Mark all done<\/button>/);
  const ws = readFileSync(new URL("../src/lib/craft/write-service.ts", import.meta.url), "utf8");
  assert.match(ws, /raws\.length > CRAFT_CHECK_IDS_MAX\) bad\(/);
  const screen = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /for \(const batch of checkBatches\(ids\)\) if \(!\(await act\(label, "check", \{ item_ids: batch \}\)\)\.ok\) return;/);
  assert.match(screen, /<EarlierSteps checks=\{earlierChecks\} busy=\{busy\} onDone=\{\(label, ids\) => \{ void markChecks\(label, ids\); \}\} \/>/);
  const sql = readFileSync(new URL("../supabase/migrations/074_craft_progress.sql", import.meta.url), "utf8");
  assert.match(sql, /cardinality\(v_ids\) NOT BETWEEN 1 AND 500 THEN/);
});

// ── 5. P3: nothing under the sticky bars at 360 ─────────────────────────────────
await test("FR5 5 the before/after choice comes right under the total (above the text field, so it is in view above the sticky foot); the earlier-steps line comes after the Now card; scroll clearance in craft.css", () => {
  const view = C.buildCraftView(mittenOneNow());
  const html = sheet(view, view.parts.find((p) => p.id === "cuff"), { total: 27, text: "knit (US 7)", type: "stockinette" });
  const at = (re) => html.search(re);
  assert.ok(at(/id="craft-total"/) >= 0 && at(/id="craft-total"/) < at(/New rounds before it/), "after the stepper");
  assert.ok(at(/New rounds after it/) < at(/id="craft-total-text"/), "before the text field");
  const s = C.buildCraftView(scarf({ n: 455, done: 300, steps: [[120, "Re-time at 15 in"], [250, "Join skein 2"]] }));
  const screen = renderToStaticMarkup(createElement(CraftScreen, { view: s }));
  assert.ok(screen.indexOf('class="craft-pf"') > 0 && screen.indexOf('class="craft-pf"') < screen.indexOf('class="craft-earlier"'), "Now first, then the earlier steps");
  assert.ok(screen.indexOf('class="craft-earlier"') < screen.indexOf('class="craft-s2"'), "and both above the sticky bar");
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  assert.match(css, /\.craft-front \.craft-earlier, \.craft-front \.craft-pf, \.craft-front \.craft-due-checks \{ scroll-margin-bottom: 196px;/);
  assert.match(css, /\.craft-total-form \.craft-field, \.craft-total-form \.craft-toggle \{ scroll-margin-bottom: 220px; \}/);
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(sheets, /box\.current\?\.scrollIntoView\(\{ block: "nearest", behavior: "smooth" \}\)/);
});

// ── 6. Note: the work type in the raise line ───────────────────────────────────
await test("FR5 6 Mitten 1's cuff raise starts on rib (the default stays) and the line before Save says it: \"… at the end (rib) …\", so a wrong type is seen before Save", () => {
  const view = C.buildCraftView(mittenOneNow());
  const cuff = view.parts.find((p) => p.id === "cuff");
  const html = sheet(view, cuff, { total: 27, text: "knit (US 7)", place: "after_steps" });
  assert.match(html, /<option value="rib" selected="">rib<\/option>/);
  assert.match(html, /<p class="craft-sheet-preview">Adds Rnd 25–27 · knit \(US 7\) at the end \(rib\), 36 stitches each\. The step “Check: cuff 4 in from cast-on\? Then switch to US 7” stays before Rnd 25\. The screen moves to this part\.<\/p>/);
});

console.log(`\nCraft S3 FR5: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
