#!/usr/bin/env node
// Craft S1C offline checks: planCraftSetup, the fingerprint, gaps on the craft screen, the
// before/after S1A render pin, the setup screen and Remove menu renders, and the real routes
// over a fake client. No network, no database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { buildCraftView } from "../src/lib/craft.ts";
import * as setup from "../src/lib/craft/setup.ts";
import { craftSetupFingerprint, craftSetupFingerprintText } from "../src/lib/craft/setup-fingerprint.ts";
import { writeInternalAuthContext } from "../src/lib/supabase/internal-auth.ts";
import { GET as setupGet, POST as setupPost } from "../src/app/api/craft/setup/[projectId]/route.ts";
import { DELETE as craftDelete } from "../src/app/api/craft/[projectId]/route.ts";
import { input, part, pinnedInputs, rows } from "./fixtures/craft/sample-views.mjs";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}`, e); }
}
const { planCraftSetup, parseRowLabel, parseCreateBody, craftSetupPayload, orderSetupTasks } = setup;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/craft/mittens.json", import.meta.url), "utf8"));
const mittens = () => ({
  project: { id: fixture.project.id, name: fixture.project.name, tags: fixture.project.tags },
  on_craft_screen: false,
  sections: fixture.sections.map(({ id, sort_order }) => ({ id, sort_order, created_at: null })),
  tasks: fixture.tasks.map(({ id, section_id, title, is_sample, created_at }) => ({ id, section_id, title, is_sample, created_at })),
  items: fixture.items.map(({ id, task_id, text, is_done, sort_order, unit_count, craft_part_id }) => ({ id, task_id, text, is_done, sort_order, unit_count, craft_part_id })),
});
const taskId = (snap, title) => snap.tasks.find((t) => t.title.startsWith(title)).id;
const itemOf = (snap, title, text) => snap.items.find((i) => i.task_id === taskId(snap, title) && i.text.startsWith(text));
// A small generic snapshot builder: tasks = [{ title, section, rows: [[text, done, units]] }]
function snapOf(tasks, { sections = ["s1"], tags = ["knitting"] } = {}) {
  let n = 0; const id = (p) => `${p}-${String(++n).padStart(4, "0")}`;
  const secs = sections.map((name, i) => ({ id: `sec-${name}`, sort_order: i, created_at: "2026-11-01T00:00:00Z" }));
  const out = { project: { id: "proj", name: "Test", tags }, on_craft_screen: false, sections: secs, tasks: [], items: [] };
  tasks.forEach((t, k) => {
    const task = { id: id("t"), section_id: t.section === null ? null : `sec-${t.section ?? sections[0]}`, title: t.title, is_sample: t.is_sample ?? false, created_at: `2026-11-02T00:00:${String(k).padStart(2, "0")}Z` };
    out.tasks.push(task);
    t.rows.forEach(([text, done = false, units = null], j) => out.items.push({ id: id("i"), task_id: task.id, text, is_done: done, sort_order: j, unit_count: units, craft_part_id: null }));
  });
  return out;
}
const rnds = (from, to, done = 0, units = 36) => Array.from({ length: to - from + 1 }, (_, i) => [`Rnd ${from + i} · knit`, from + i <= done, units]);

// ── planCraftSetup on the mittens ─────────────────────────────────────────
await test("Mittens: 8 parts in project order with the exact names, rounds, segments, current rounds and stitch counts", () => {
  const plan = planCraftSetup(mittens());
  assert.equal(plan.ok, true, plan.stops.join("; "));
  assert.deepEqual(plan.parts.map((p) => [p.name, p.row_word, p.total_rows, p.row_count, p.current_row, p.stitch_count, p.segments.map((s) => [s.name, s.from_row, s.to_row])]), [1, 2].flatMap((m) => [
    [`Mitten ${m} · Cuff`, "round", 31, 31, m === 1 ? 15 : 1, 36, [[`Mitten ${m} · Cuff: cast on + rnds 1–31`, 1, 31]]],
    [`Mitten ${m} · Hand`, "round", 45, 45, 1, null, [[`Mitten ${m} · Thumb gusset: rnds 1–17`, 1, 17], [`Mitten ${m} · Hand: rnds 18–45 (to 4 in)`, 18, 45]]],
    [`Mitten ${m} · Top decreases`, "round", 8, 8, 1, null, [[`Mitten ${m} · Top decreases: rnds 1–8`, 1, 8]]],
    [`Mitten ${m} · Thumb`, "round", 15, 15, 1, 14, [[`Mitten ${m} · Thumb: pick-up + rnds 1–15`, 1, 15]]],
  ]));
  assert.equal(plan.active_part_index, 0, "Mitten 1 · Cuff at round 15");
  assert.equal(plan.parts[0].done_count, 14);
  assert.deepEqual(plan.parts.map((p) => p.gaps), plan.parts.map(() => []));
  assert.equal(plan.default_craft, "knit");
});
await test("Mittens: the unnumbered items stay plain (cast-on, checks, pick-up, break yarn, finishing), none marked swatch", () => {
  const plan = planCraftSetup(mittens());
  assert.equal(plan.plain_items.length, 20);
  const texts = plan.plain_items.filter((i) => i.task_title.startsWith("Mitten 1")).map((i) => i.text.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(texts, ["Cast on", "Check: cuff", "Check: 48", "Check: hand", "Break yarn", "Pick-up rnd", "Check: thumb", "Break yarn,", "Sew the", "Weave in"]);
  assert.ok(plan.plain_items.every((i) => !i.swatch));
  assert.equal(plan.plain_items.filter((i) => i.is_done).length, 1, "the ticked cast-on");
  assert.equal(plan.parts.reduce((n, p) => n + p.rows.length, 0) + plan.plain_items.length, fixture.items.length, "every item is a row or a plain step");
});
await test("Mittens: rows sorted by number and linked to their own items; the payload carries names and kind", () => {
  const snap = mittens(), plan = planCraftSetup(snap);
  const hand = plan.parts[1];
  assert.deepEqual(hand.rows.map((r) => r.row), Array.from({ length: 45 }, (_, i) => i + 1));
  assert.equal(hand.rows[17].item_id, itemOf(snap, "Mitten 1 · Hand", "Rnd 18 ·").id);
  const names = plan.parts.map((p, i) => (i === 0 ? "Left cuff" : p.name));
  const payload = craftSetupPayload(plan, "knit", names);
  assert.equal(payload.parts[0].name, "Left cuff");
  assert.deepEqual(Object.keys(payload).sort(), ["active_part_index", "craft", "parts"]);
  assert.deepEqual(Object.keys(payload.parts[0]).sort(), ["name", "row_word", "rows", "segments", "sort_order", "stitch_count", "total_rows"]);
  assert.deepEqual(payload.parts[0].rows[14], { item_id: itemOf(snap, "Mitten 1 · Cuff", "Rnd 15 ·").id, row: 15 });
  assert.equal(payload.parts.reduce((n, p) => n + p.rows.length, 0), 198);
});
await test("Mittens: tags pick the default kind (knitting → knit, crochet → crochet, else other)", () => {
  assert.equal(setup.defaultCraftKind(["personal", "Crochet"]), "crochet");
  assert.equal(setup.defaultCraftKind(["personal"]), "other");
  assert.equal(setup.defaultCraftKind(null), "other");
});
await test("Mittens: active part follows the first unticked part; all ticked gives none", () => {
  const snap = mittens();
  for (const i of snap.items) if (i.task_id === taskId(snap, "Mitten 1 · Cuff")) i.is_done = true;
  assert.equal(planCraftSetup(snap).active_part_index, 1);
  for (const i of snap.items) i.is_done = true;
  const plan = planCraftSetup(snap);
  assert.equal(plan.active_part_index, null);
  assert.ok(plan.parts.every((p) => p.current_row === null));
});

// ── Gaps: allowed, named, and counted from the rows that exist ───────────────
await test("Gaps: the cuff stops at Rnd 21 (est. rounds 22–28 deleted) → total 31, 24 rows, one named gap", () => {
  const snap = mittens();
  const cuff = taskId(snap, "Mitten 1 · Cuff");
  snap.items = snap.items.filter((i) => !(i.task_id === cuff && /^Rnd (2[2-8]) /.test(i.text)));
  const plan = planCraftSetup(snap);
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.parts[0].total_rows, plan.parts[0].row_count, plan.parts[0].current_row], [31, 24, 15]);
  assert.deepEqual(plan.parts[0].gaps, [[22, 28]]);
  assert.deepEqual(plan.parts[0].gap_notes, ["Rounds 22–28 are not in the list; the screen goes from 21 to 29."]);
});
await test("Gaps: one missing number, a missing start, and Row wording", () => {
  const plan = planCraftSetup(snapOf([{ title: "Body", rows: [["Row 3"], ["Row 4"], ["Row 6"]] }]));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.parts[0].gap_notes, ["Rows 1–2 are not in the list; the screen starts at 3.", "Row 5 is not in the list; the screen goes from 4 to 6."]);
  assert.equal(setup.gapNote("round", [1, 1]), "Round 1 is not in the list; the screen starts at 2.");
});

// ── STOPs: never guess ────────────────────────────────────────────────
await test("STOP: a repeated round on a part names it; no Create", () => {
  const snap = mittens();
  itemOf(snap, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12 · knit (US 7)";
  const plan = planCraftSetup(snap);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.stops, ["Round 12 is listed twice on “Mitten 1 · Cuff”; fix it in the app first."]);
});
await test("STOP: Row and Rnd mixed in one task", () => {
  const plan = planCraftSetup(snapOf([{ title: "Mitten 1 · Cuff: rnds", rows: [["Rnd 1 · rib"], ["Row 2 · rib"]] }]));
  assert.equal(plan.ok, false);
  assert.match(plan.stops[0], /^“Mitten 1 · Cuff: rnds” mixes “Row” items with “Rnd”\/“Round” items/);
});
await test("STOP: no numbered items at all", () => {
  const plan = planCraftSetup(snapOf([{ title: "Finishing", rows: [["Weave in ends"], ["Block"]] }]));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.stops, ["No checklist item starts with “Row N”, “Rnd N” or “Round N”, so there is nothing to count yet."]);
  assert.equal(planCraftSetup({ ...snapOf([]), tasks: [], items: [] }).ok, false);
});
await test("STOP: an item already linked to a craft part", () => {
  const snap = mittens();
  itemOf(snap, "Mitten 2 · Thumb:", "Rnd 3 ·").craft_part_id = "some-part";
  const plan = planCraftSetup(snap);
  assert.equal(plan.ok, false);
  assert.match(plan.stops[0], /^One checklist item is already linked to a craft part \(for example “Rnd 3 · knit” on “Mitten 2 · Thumb: pick-up \+ rnds 1–15”\)\.$/);
});
await test("STOP: more than 2,000 rows in one part; 2,000 is fine", () => {
  const big = (n) => snapOf([{ title: "Blanket", rows: Array.from({ length: n }, (_, i) => [`Row ${i + 1}`]) }]);
  assert.equal(planCraftSetup(big(2000)).ok, true);
  const plan = planCraftSetup(big(2001));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.stops, ["“Blanket” goes up to row 2,001; one part can hold at most 2,000."]);
  assert.equal(planCraftSetup(snapOf([{ title: "B", rows: [["Row 1"], ["Row 5000"]] }])).ok, false);
});
await test("STOP: a range or a zero is never read as one row", () => {
  for (const text of ["Rnd 1–3 · knit", "Rnd 1-3", "Row 4 to 6: knit", "Round 2 and 3", "Row 1.5", "Row 7, 8"]) {
    const plan = planCraftSetup(snapOf([{ title: "Cuff", rows: [["Rnd 4"], [text]] }]));
    assert.equal(plan.ok, false, text);
    assert.match(plan.stops[0], /looks like a range of rows/, text);
  }
  assert.match(planCraftSetup(snapOf([{ title: "Cuff", rows: [["Rnd 0 · cast on"]] }])).stops[0], /numbered 0/);
});
await test("Projects already on the craft screen: the blanket- and scarf-shaped inputs STOP as already set up", () => {
  const blanket = snapOf([
    ...[["Foundation", 1, 1], ["Waffle 1", 2, 18], ["Tree 1", 19, 37], ["Waffle 2", 38, 52], ["Tree 2", 53, 71], ["Waffle 3", 72, 86], ["Tree 3", 87, 105], ["Waffle 4", 106, 120], ["Tree 4", 121, 139], ["Waffle 5", 140, 156], ["Final sc row", 157, 157]]
      .map(([title, from, to]) => ({ title: `Step ${title}`, rows: Array.from({ length: to - from + 1 }, (_, i) => [`Row ${from + i}: chart row`, from + i <= 58, 195]) })),
    { title: "Border", rows: [["Round 1"], ["Round 2"]] },
  ], { tags: ["crochet"] });
  const scarf = snapOf([0, 1, 2, 3, 4, 5].map((k) => ({ title: `Scarf rows ${k * 100 + 1}–${Math.min(519, k * 100 + 100)}`, rows: Array.from({ length: Math.min(519, k * 100 + 100) - k * 100 }, (_, i) => [`Row ${k * 100 + i + 1}`, k * 100 + i < 118, 30]) })));
  // What the generic rule would make of them (they keep their S1 setup):
  const b = planCraftSetup(blanket), s = planCraftSetup(scarf);
  assert.deepEqual(b.parts.map((p) => [p.name, p.row_word, p.total_rows, p.segments.length, p.current_row, p.stitch_count]), [["Step Final sc row", "row", 157, 11, 59, 195], ["Border", "round", 2, 1, 1, null]]);
  assert.deepEqual(s.parts.map((p) => [p.total_rows, p.segments.length, p.current_row, p.stitch_count]), [[519, 6, 119, 30]]);
  assert.equal(b.default_craft, "crochet");
  for (const snap of [blanket, scarf]) {
    const plan = planCraftSetup({ ...snap, on_craft_screen: true });
    assert.equal(plan.ok, false);
    assert.match(plan.stops[0], /^This project is already on the craft screen\./);
  }
});

// ── Grouping and parsing rules ────────────────────────────────────────
await test("Grouping: continues only in the same section with the same word and the next number", () => {
  const plan = planCraftSetup(snapOf([
    { title: "A · One: r", section: "s1", rows: rnds(1, 5) },
    { title: "A · Two: r", section: "s1", rows: rnds(6, 8) },          // continues
    { title: "A · Three: r", section: "s1", rows: rnds(10, 12) },      // 10 ≠ 9: new part (and a gap 1–9)
    { title: "B · Four: r", section: "s2", rows: rnds(13, 14) },       // other section: new part
    { title: "B · Five", section: "s2", rows: [["Row 15"], ["Row 16"]] }, // other word: new part
  ], { sections: ["s1", "s2"] }));
  assert.deepEqual(plan.parts.map((p) => [p.name, p.segments.length, p.total_rows]), [["A · Two", 2, 8], ["A · Three", 1, 12], ["B · Four", 1, 14], ["B · Five", 1, 16]]);
});
await test("Order: sections by sort order, tasks by creation then id, unsectioned last", () => {
  const snap = snapOf([{ title: "late", section: "b", rows: [] }, { title: "early", section: "a", rows: [] }, { title: "loose", section: null, rows: [] }], { sections: ["a", "b"] });
  snap.sections.reverse(); snap.sections[0].sort_order = 5; // b now sorts after a by sort_order
  assert.deepEqual(orderSetupTasks(snap).map((t) => t.title), ["early", "late", "loose"]);
  const tie = snapOf([{ title: "x", rows: [] }, { title: "y", rows: [] }]);
  tie.tasks.forEach((t) => { t.created_at = "2026-11-02T00:00:00.000500Z"; });
  tie.tasks[0].id = "t-b"; tie.tasks[1].id = "t-a";
  assert.deepEqual(orderSetupTasks(tie).map((t) => t.title), ["y", "x"]);
});
await test("Row labels: case as written, (est.) allowed, unnumbered and plural labels plain", () => {
  const cases = [["Rnd 15 (est.) · knit", 15, "round"], ["Round 3", 3, "round"], ["Row 1: sc across", 1, "row"], ["Rnd  2 · knit", 2, "round"], ["Row 12 (band row 3)", 12, "row"]];
  for (const [text, row, word] of cases) assert.deepEqual(parseRowLabel(text), { kind: "row", word, label: text.split(" ")[0], row }, text);
  for (const text of ["rnd 3 · knit", "ROW 3", "Rnds 1–3", "Rows 4", "Pick-up rnd · knit", "Cast on 36", "Check: 48 sts", "Row 12a", " Row 3", "Roww 3"]) assert.deepEqual(parseRowLabel(text), { kind: "plain" }, text);
});
await test("Swatch tasks: their row items stay plain and are marked [swatch]", () => {
  const plan = planCraftSetup(snapOf([{ title: "Gauge swatch", is_sample: true, rows: [["Row 1"], ["Row 2"]] }, { title: "Body", rows: [["Row 1"]] }]));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.parts.map((p) => p.name), ["Body"]);
  assert.deepEqual(plan.plain_items.map((i) => [i.text, i.swatch]), [["Row 1", true], ["Row 2", true]]);
});
await test("Stitch counts: one shared whole number, else none", () => {
  const sc = (units) => planCraftSetup(snapOf([{ title: "P", rows: units.map((u, i) => [`Row ${i + 1}`, false, u]) }])).parts[0].stitch_count;
  assert.equal(sc([30, 30, 30]), 30);
  assert.equal(sc([30, null]), null);
  assert.equal(sc([null, null]), null);
  assert.equal(sc([30, 28]), null);
  assert.equal(sc([0, 0]), null);
  assert.equal(sc([12.5, 12.5]), null);
});
await test("Long names: parts and segments are cut to 80 characters (code points), never split a character", () => {
  const long = `Mitten 1 · ${"Cuff ".repeat(30)}: rnds`;
  const plan = planCraftSetup(snapOf([{ title: long, rows: rnds(1, 2) }, { title: `🧶${"x".repeat(100)}`, section: "s2", rows: [["Row 1"]] }], { sections: ["s1", "s2"] }));
  assert.ok(plan.parts.every((p) => Array.from(p.name).length <= 80 && p.segments.every((s) => Array.from(s.name).length <= 80)));
  assert.equal(plan.parts[1].name, `🧶${"x".repeat(79)}`);
  assert.equal(setup.partNameFromTitle("Hat"), "Hat");
  assert.equal(setup.partNameFromTitle("Sock 2 · Heel flap"), "Sock 2 · Heel flap");
});

// ── The Create body and the fingerprint ─────────────────────────────────
await test("Create body: fingerprint, craft and one name per part; anything else is refused", () => {
  const fp = "a".repeat(64);
  assert.deepEqual(parseCreateBody({ fingerprint: fp, craft: "knit", names: [" Cuff "] }, 1), { ok: true, value: { fingerprint: fp, craft: "knit", names: ["Cuff"] } });
  for (const [body, error] of [
    [null, /JSON object/], [{ fingerprint: fp, craft: "knit", names: ["a"], extra: 1 }, /Unknown field: extra/], [{ fingerprint: "x", craft: "knit", names: ["a"] }, /fingerprint/],
    [{ fingerprint: fp, craft: "weave", names: ["a"] }, /craft must be/], [{ fingerprint: fp, craft: "knit", names: [] }, /one name per part/],
    [{ fingerprint: fp, craft: "knit", names: ["  "] }, /needs a name/], [{ fingerprint: fp, craft: "knit", names: ["x".repeat(81)] }, /at most 80/],
    [{ fingerprint: fp, craft: "knit", names: ["a\u0007"] }, /control/], [{ fingerprint: fp, craft: "knit", names: [5] }, /text/],
  ]) { const r = parseCreateBody(body, 1); assert.equal(r.ok, false); assert.match(r.error, error); }
  assert.equal(parseCreateBody({ fingerprint: fp, craft: "knit", names: ["🧶".repeat(80)] }, 1).ok, true);
});
await test("Fingerprint: stable, order-independent, and changed by any tick, text, order, title, section, units, link or new item", () => {
  const base = craftSetupFingerprint(mittens());
  assert.match(base, /^[0-9a-f]{64}$/);
  const shuffled = mittens(); shuffled.items.reverse(); shuffled.tasks.reverse();
  assert.equal(craftSetupFingerprint(shuffled), base);
  assert.equal(craftSetupFingerprint({ ...mittens(), project: { ...mittens().project, name: "Renamed" } }), base, "project name and tags are not plan inputs");
  const edits = [
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").is_done = true; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").text += " "; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").sort_order = 99; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").unit_count = 34; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").craft_part_id = "p"; },
    (s) => { s.tasks[0].title += "!"; },
    (s) => { s.tasks[0].section_id = s.sections[1].id; },
    (s) => { s.tasks[0].created_at = "2026-11-12T00:00:00Z"; },
    (s) => { s.tasks[0].is_sample = true; },
    (s) => { s.sections[0].sort_order = 7; },
    (s) => { s.items.push({ ...s.items[0], id: "ffffffff-0000-4000-8000-000000000000" }); },
    (s) => { s.items.pop(); },
  ];
  for (const [k, edit] of edits.entries()) { const s = mittens(); edit(s); assert.notEqual(craftSetupFingerprint(s), base, `edit ${k}`); }
  const text = craftSetupFingerprintText(mittens()).split("\n");
  assert.equal(text[0], `craft-setup-v1|${fixture.project.id}`);
  assert.match(text[1], /^s\|[0-9a-f-]{36}\|[01]\|$/, "sections without created_at have an empty ms field");
  assert.match(text.find((l) => l.startsWith("t|")), /^t\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|\d{13}\|0\|[0-9a-f]{64}$/);
  assert.match(text.find((l) => l.startsWith("i|")), /^i\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|\d+\|[01]\|(\d+(\.\d+)?)?\|\|[0-9a-f]{64}$/);
});

// ── Gaps on the craft screen (buildCraftView) and the pinned S1A renders ─────
const gapPart = () => {
  const items = rows("Cuff", 31, 21).filter((r) => r.craft_row <= 21 || r.craft_row >= 29).map((r) => ({ ...r, text: `Rnd ${r.craft_row} · knit` }));
  const data = input([part("Cuff", 31, { row_word: "round", stitch_count: 36 })], items);
  data.segments = [{ id: "seg", part_id: "Cuff", task_id: "t", name: "Mitten 1 · Cuff: cast on + rnds 1–31", from_row: 1, to_row: 31, sort_order: 0, close_check: false }];
  return data;
};
await test("buildCraftView with gaps: current = lowest unticked existing row, next rows skip missing numbers, counts use existing rows", () => {
  const v = buildCraftView(gapPart());
  assert.equal(v.active_part.current_row, 29);
  assert.deepEqual(v.next_rows.map((r) => r.row), [29, 30, 31]);
  assert.deepEqual([v.active_part.done_rows, v.active_part.row_count, v.active_part.total_rows, v.active_part.finished], [21, 24, 31, false]);
  assert.equal(v.segments[0].state, "current");
  const done = gapPart(); done.items.forEach((r) => { r.is_done = true; });
  const f = buildCraftView(done).parts[0];
  assert.deepEqual([f.finished, f.current_row, f.row_label, f.done_rows, f.row_count], [true, 32, "Finished", 24, 24]);
  const early = gapPart(); early.items.forEach((r) => { r.is_done = r.craft_row <= 10; });
  assert.deepEqual(buildCraftView(early).next_rows.map((r) => r.row), [11, 12, 13, 14, 15]);
  const across = gapPart(); across.items.forEach((r) => { r.is_done = r.craft_row <= 20; });
  assert.deepEqual(buildCraftView(across).next_rows.map((r) => r.row), [21, 29, 30, 31]);
});

registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const { CraftScreen } = await import("../src/components/craft/CraftScreen.tsx");
const { CraftSetupScreen, partFacts, sendCreate } = await import("../src/components/craft/CraftSetupScreen.tsx");
const { CraftScreenMenu, REMOVE_KEEPS, sendRemove } = await import("../src/components/craft/CraftScreenMenu.tsx");
const renderScreen = (data) => renderToStaticMarkup(createElement(CraftScreen, { view: buildCraftView(data) }));
const MENU = /<div class="craft-menu">.*?<\/div><\/div>/;

await test("Before/after: the blanket and scarf screens render byte for byte as at ca00c76, apart from the new header menu", () => {
  const pinned = JSON.parse(readFileSync(new URL("./fixtures/craft/screen-s1a.snapshot.json", import.meta.url), "utf8"));
  const now = pinnedInputs();
  assert.deepEqual(Object.keys(now), Object.keys(pinned));
  for (const [name, html] of Object.entries(pinned)) {
    const after = renderScreen(now[name]);
    assert.match(after, MENU, `${name}: menu`);
    assert.equal(after.replace(MENU, ""), html, `${name} changed`);
  }
});
await test("SSR gaps: the craft screen says 21 of 24 rounds ticked, of 31, and lists 29–31 next", () => {
  const html = renderScreen(gapPart());
  assert.match(html, /<span class="craft-pf-num">29<\/span><span class="craft-pf-of">of 31<\/span>/);
  assert.match(html, /· 21 of 24 rounds ticked/);
  assert.match(html, /<li><span>round 30<\/span><p>Rnd 30 · knit<\/p><\/li><li><span>round 31<\/span>/);
});
await test("SSR menu: a labelled disclosure (closed) with Remove from craft screen; the sheet says what stays", () => {
  const html = renderToStaticMarkup(createElement(CraftScreenMenu, { projectId: "p1", projectName: "Mittens" }));
  assert.match(html, /aria-label="Craft screen menu" aria-expanded="false" aria-controls="([^"]+)">⋯<\/button><div id="\1" class="craft-menu-panel" hidden="">/);
  assert.match(html, /<button type="button" class="craft-menu-item">Remove from craft screen<\/button>/);
  assert.equal(REMOVE_KEEPS, "Your ticks, stitch counts and sittings stay.");
  const source = readFileSync(new URL("../src/components/craft/CraftScreenMenu.tsx", import.meta.url), "utf8");
  assert.match(source, /<Modal open=\{confirming\} onClose=\{close\} title="Remove from craft screen\?">/);
  assert.match(source, /<strong>\{REMOVE_KEEPS\}<\/strong>/);
  assert.match(source, /variant="danger"[^>]*>\{state\.busy \? "Removing…" : "Remove"\}/);
});
const renderSetup = (snap) => { const plan = planCraftSetup(snap); return renderToStaticMarkup(createElement(CraftSetupScreen, { projectId: snap.project.id, plan, fingerprint: craftSetupFingerprint(snap) })); };
await test("SSR setup preview (mittens): 8 named parts as labelled inputs, facts, segments, plain steps, kind and Create", () => {
  const html = renderSetup(mittens());
  assert.match(html, /<h1>Set up craft screen<\/h1>/);
  assert.match(html, /Preview · nothing is saved until Create/);
  assert.equal((html.match(/<input [^>]*value="Mitten \d · [^"]+"/g) ?? []).length, 8);
  assert.match(html, /<label class="craft-setup-name"><span>Part 1 name<\/span><input maxLength="100" value="Mitten 1 · Cuff"\/><\/label>/);
  assert.match(html, /Rounds · 31 in all · now round 15 · 36 stitches · 14 of 31 rounds ticked/);
  assert.match(html, /Rounds · 45 in all · now round 1 · stitches change · 0 of 45 rounds ticked/);
  assert.match(html, /<li data-active="true">/);
  assert.equal((html.match(/data-active/g) ?? []).length, 1);
  assert.match(html, /<li><span>Mitten 1 · Thumb gusset: rnds 1–17<\/span><span>rounds 1–17<\/span><\/li><li><span>Mitten 1 · Hand: rnds 18–45 \(to 4 in\)<\/span><span>rounds 18–45<\/span><\/li>/);
  assert.match(html, /Plain steps <span class="craft-setup-count">20<\/span>/);
  assert.match(html, /<summary>Show the 20 plain steps<\/summary>/);
  assert.match(html, /<legend>Craft<\/legend><label><input type="radio" name="craft-kind" checked="" value="knit"\/>Knitting<\/label>/);
  assert.match(html, /<button type="button"[^>]*>Create 8 parts on the craft screen<\/button>/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /Claude|Anthropic|OpenAI|ChatGPT|GPT/);
});
await test("SSR setup preview: gaps are named, swatch items marked, and a STOP shows the reason with no Create", () => {
  const gap = mittens();
  const cuff = taskId(gap, "Mitten 1 · Cuff");
  gap.items = gap.items.filter((i) => !(i.task_id === cuff && /^Rnd (2[2-8]) /.test(i.text)));
  assert.match(renderSetup(gap), /<p class="craft-setup-gap">Rounds 22–28 are not in the list; the screen goes from 21 to 29\.<\/p>/);
  assert.match(renderSetup(gap), /14 of 24 rounds ticked/);
  assert.match(renderSetup(snapOf([{ title: "Swatch", is_sample: true, rows: [["Row 1"]] }, { title: "Body", rows: [["Row 1"]] }])), /<strong>\[swatch\] <\/strong>Row 1/);
  const stop = mittens(); itemOf(stop, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12 · knit";
  const html = renderSetup(stop);
  assert.match(html, /<section class="craft-setup-stop" role="alert" aria-labelledby="craft-setup-stop-title"><h3 id="craft-setup-stop-title">This project can’t be set up yet<\/h3><ul><li>Round 12 is listed twice on “Mitten 1 · Cuff”; fix it in the app first\.<\/li><\/ul>/);
  assert.doesNotMatch(html, /Create \d+ part|name="craft-kind"/);
  assert.match(html, /<input maxLength="100" disabled="" value="Mitten 1 · Cuff"\/>/);
  const set = renderSetup({ ...mittens(), on_craft_screen: true });
  assert.match(set, /href="\/craft\/6c30a08d-9210-54f1-a43a-78ef6e472f95">Open craft screen<\/a>/);
});
await test("partFacts, sendCreate and sendRemove turn replies into plain words", async () => {
  assert.equal(partFacts({ ...planCraftSetup(mittens()).parts[3], current_row: null }), "Rounds · 15 in all · all ticked · 14 stitches · 0 of 15 rounds ticked");
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await sendCreate("p", {}, reply(201, {})), { ok: true });
  assert.deepEqual(await sendCreate("p", {}, reply(409, { error: setup.CRAFT_SETUP_CHANGED, reason: "changed" })), { ok: false, changed: true, message: setup.CRAFT_SETUP_CHANGED });
  assert.deepEqual(await sendCreate("p", {}, async () => { throw new Error("offline"); }), { ok: false, changed: false, message: "Create didn't reach the server. Check the connection and try again." });
  assert.deepEqual(await sendRemove("p", reply(200, {})), { ok: true });
  assert.deepEqual(await sendRemove("p", reply(404, {})), { ok: true }, "already gone is fine");
  assert.deepEqual(await sendRemove("p", reply(500, { error: "Internal server error" })), { ok: false, message: "Internal server error" });
  let call; await sendRemove("p9", async (url, init) => { call = [url, init.method]; return new Response("{}"); });
  assert.deepEqual(call, ["/api/craft/p9", "DELETE"]);
});
await test("CSS: setup and menu rules use tokens only, 12px floor, 44px touch targets", () => {
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  const s1c = css.slice(css.indexOf("/* S1C"));
  assert.ok(s1c.length > 1000);
  assert.doesNotMatch(s1c, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
  for (const size of s1c.matchAll(/font-size: (\d+)px/g)) assert.ok(Number(size[1]) >= 12, size[0]);
  assert.match(s1c, /\.craft-menu-item \{[^}]*min-height: 44px;/);
  assert.match(s1c, /\.craft-setup-kind label \{[^}]*min-height: 44px;[^}]*font-size: 16px;/);
  assert.doesNotMatch(s1c, /outline: none|outline: 0/);
});

// ── Routes over a fake client ───────────────────────────────────────────
const UID = "user-1", PID = fixture.project.id;
function fakeDb(snap, { rpc = () => ({ data: { project_id: PID, parts: 8, segments: 10, rows_linked: 198, active_part_id: "x" }, error: null }), craftRow = null, failTable = null } = {}) {
  const log = [], rpcCalls = [];
  const tables = {
    projects: [{ ...snap.project, user_id: UID }],
    craft_projects: craftRow ? [{ project_id: PID, user_id: UID }] : [],
    project_sections: snap.sections.map((s) => ({ ...s, user_id: UID, project_id: PID })),
    tasks: snap.tasks.map((t) => ({ ...t, user_id: UID, project_id: PID })),
    task_checklist_items: snap.items.map((i) => ({ ...i, user_id: UID })),
  };
  return { log, rpcCalls,
    rpc(name, args) { rpcCalls.push([name, args]); return Promise.resolve(rpc(name, args)); },
    from(table) {
      const entry = { table, filters: [] }, conds = []; log.push(entry);
      const rows = () => (tables[table] ?? []).filter((row) => conds.every((c) => c(row)));
      const fail = () => ({ data: null, error: { code: "XX000", message: "boom" } });
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, filter() { return q; },
        eq(col, val) { entry.filters.push(`eq ${col}`); conds.push((r) => r[col] === val); return q; },
        in(col, vals) { entry.filters.push(`in ${col}`); conds.push((r) => vals.includes(r[col])); return q; },
        range(from, to) { return Promise.resolve(failTable === table ? fail() : { data: rows().slice(from, to + 1), error: null }); },
        single() { const f = rows(); return Promise.resolve(f.length === 1 ? { data: f[0], error: null } : { data: null, error: { code: "PGRST116", message: "none" } }); },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      };
      return q;
    } };
}
const req = (db, method = "GET", body) => {
  const r = new NextRequest(`http://localhost/api/craft/setup/${PID}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: db, userId: UID, user: { id: UID }, authSource: "session" });
  return r;
};
const ctx = (id = PID) => ({ params: Promise.resolve({ projectId: id }) });
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const createBody = (snap, extra = {}) => ({ fingerprint: craftSetupFingerprint(snap), craft: "knit", names: planCraftSetup(snap).parts.map((p) => p.name), ...extra });

await test("GET preview: the plan and fingerprint, no-store, every read filtered by user, no writes", async () => {
  const snap = mittens(), db = fakeDb(snap);
  const res = await setupGet(req(db), ctx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.fingerprint, craftSetupFingerprint(snap));
  assert.equal(body.plan.parts.length, 8);
  assert.deepEqual(db.log.map((q) => q.table).sort(), ["craft_projects", "project_sections", "projects", "task_checklist_items", "tasks"]);
  for (const q of db.log) assert.ok(q.filters.includes("eq user_id"), q.table);
  assert.equal(db.rpcCalls.length, 0);
});
await test("GET preview: another user's or a missing project is 404 (PGRST116 only); bad id 400; DB errors 500", async () => {
  const snap = mittens();
  snap.project.id = "someone-else";
  assert.equal((await setupGet(req(fakeDb(snap)), ctx())).status, 404);
  assert.equal((await setupGet(req(fakeDb(mittens())), ctx("nope"))).status, 400);
  assert.equal((await quiet(() => setupGet(req(fakeDb(mittens(), { failTable: "tasks" })), ctx()))).status, 500);
});
await test("POST Create: a fresh read with the same fingerprint makes one 072 call with the plan, names and kind", async () => {
  const snap = mittens(), db = fakeDb(snap);
  const body = createBody(snap, { craft: "other" }); body.names[2] = "Top";
  const res = await setupPost(req(db, "POST", body), ctx());
  assert.equal(res.status, 201);
  assert.equal(db.rpcCalls.length, 1);
  const [name, args] = db.rpcCalls[0];
  assert.equal(name, "craft_setup_project");
  assert.deepEqual(Object.keys(args).sort(), ["p_fingerprint", "p_plan", "p_project_id", "p_user_id"]);
  assert.equal(args.p_user_id, UID); assert.equal(args.p_project_id, PID); assert.equal(args.p_fingerprint, body.fingerprint);
  assert.equal(args.p_plan.craft, "other");
  assert.equal(args.p_plan.parts[2].name, "Top");
  assert.equal(args.p_plan.active_part_index, 0);
});
await test("POST Create: a tick since the preview is refused before any write, in the preview's words", async () => {
  const before = mittens(), after = mittens();
  itemOf(after, "Mitten 1 · Cuff", "Rnd 15 ·").is_done = true;
  const db = fakeDb(after);
  const res = await setupPost(req(db, "POST", createBody(before)), ctx());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Something changed since the preview. Open it again.", reason: "changed" });
  assert.equal(db.rpcCalls.length, 0);
  const more = mittens(); more.items = more.items.filter((i) => i.task_id !== taskId(more, "Mitten 2 · Thumb"));
  const fewer = fakeDb(more);
  assert.equal((await setupPost(req(fewer, "POST", createBody(mittens())), ctx())).status, 409, "a part count change is a change, not a 400");
});
await test("POST Create: STOPs, bad bodies and every 072 refusal map to plain 4xx; anything else is a 500", async () => {
  const stop = mittens(); itemOf(stop, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12 · knit";
  const stopped = await setupPost(req(fakeDb(stop), "POST", createBody(stop)), ctx());
  assert.equal(stopped.status, 409);
  assert.deepEqual((await stopped.json()).stops, ["Round 12 is listed twice on “Mitten 1 · Cuff”; fix it in the app first."]);
  const set = await setupPost(req(fakeDb(mittens(), { craftRow: true }), "POST", createBody(mittens())), ctx());
  assert.equal(set.status, 409);
  assert.match((await set.json()).error, /already on the craft screen/);
  assert.equal((await setupPost(req(fakeDb(mittens()), "POST", "{not json"), ctx())).status, 400);
  assert.equal((await setupPost(req(fakeDb(mittens()), "POST", { ...createBody(mittens()), craft: "weave" }), ctx())).status, 400);
  for (const [code, status, reason] of [["MC072", 409, "changed"], ["23505", 409, "exists"], ["P0002", 409, "changed"], ["22023", 400, "invalid"], ["XX000", 500, undefined], ["42501", 500, undefined]]) {
    const db = fakeDb(mittens(), { rpc: () => ({ data: null, error: { code, message: "db" } }) });
    const res = await quiet(() => setupPost(req(db, "POST", createBody(mittens())), ctx()));
    assert.equal(res.status, status, code);
    if (reason) assert.equal((await res.json()).reason, reason);
  }
});
await test("DELETE Remove: 404 when not on the craft screen (PGRST116), one 072 call when it is, P0002 race is 409, errors 500", async () => {
  const none = fakeDb(mittens());
  assert.equal((await craftDelete(req(none, "DELETE"), ctx())).status, 404);
  assert.equal(none.rpcCalls.length, 0);
  const db = fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: { project_id: PID, items_unlinked: 198, parts_removed: 8, segments_removed: 10 }, error: null }) });
  const res = await craftDelete(req(db, "DELETE"), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(db.rpcCalls, [["craft_remove_project", { p_user_id: UID, p_project_id: PID }]]);
  assert.equal((await res.json()).items_unlinked, 198);
  assert.ok(db.log.every((q) => q.filters.includes("eq user_id")));
  assert.equal((await craftDelete(req(fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: null, error: { code: "P0002", message: "gone" } }) }), "DELETE"), ctx())).status, 409);
  assert.equal((await quiet(() => craftDelete(req(fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: null, error: { code: "40P01", message: "x" } }) }), "DELETE"), ctx()))).status, 500);
  assert.equal((await craftDelete(req(fakeDb(mittens()), "DELETE"), ctx("bad"))).status, 400);
});
await test("Wiring: project page offers Set up only with row items and no craft row; setup page and routes exist", () => {
  const page = readFileSync(new URL("../src/app/projects/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(!hasCraft && /);
  assert.match(page, /canSetUpCraft = await projectHasRowItems\(client, user\.id, id\);/);
  assert.match(page, /\{canSetUpCraft && \(\s*<Link href=\{craftSetupHref\(id\)\}[\s\S]*?Set up craft screen/);
  assert.match(page, /\{hasCraft && \([\s\S]*?Open craft screen/);
  const service = readFileSync(new URL("../src/lib/craft/setup-service.ts", import.meta.url), "utf8");
  assert.match(service, /\.eq\("is_sample", false\)/);
  assert.match(service, /\.filter\("text", "match", "\^\(Row\|Rnd\|Round\)\[\[:space:\]\]\+\[0-9\]"\)\.limit\(1\)/);
  assert.equal(setup.craftSetupHref("abc"), "/craft/setup/abc");
  const setupPage = readFileSync(new URL("../src/app/craft/setup/[projectId]/page.tsx", import.meta.url), "utf8");
  assert.match(setupPage, /key=\{preview\.fingerprint\}/);
});

console.log(`\nCraft setup: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
