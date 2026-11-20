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
import { buildCraftView, buildCraftProjectList, craftProjectOptionLabel } from "../src/lib/craft.ts";
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
  sections: fixture.sections.map(({ id, sort_order, name }) => ({ id, sort_order, created_at: null, name })),
  tasks: fixture.tasks.map(({ id, section_id, title, is_sample, created_at, unit_count, work_type }) => ({ id, section_id, title, is_sample, created_at, unit_count: unit_count == null ? null : String(unit_count), work_type: work_type ?? null })),
  // The loader reads unit_count as the database's numeric text (FR1), never through a JS number.
  items: fixture.items.map(({ id, task_id, text, is_done, sort_order, unit_count, craft_part_id, work_type }) => ({ id, task_id, text, is_done, sort_order, unit_count: unit_count === null ? null : String(unit_count), craft_part_id, work_type: work_type ?? null })),
});
const taskId = (snap, title) => snap.tasks.find((t) => t.title.startsWith(title)).id;
const itemOf = (snap, title, text) => snap.items.find((i) => i.task_id === taskId(snap, title) && i.text.startsWith(text));
// A small generic snapshot builder: tasks = [{ title, section, rows: [[text, done, units]] }]
function snapOf(tasks, { sections = ["s1"], tags = ["knitting"] } = {}) {
  let n = 0; const id = (p) => `${p}-${String(++n).padStart(4, "0")}`;
  // S4: a part is named after its section ("1. s1" → "s1").
  const secs = sections.map((name, i) => ({ id: `sec-${name}`, sort_order: i, created_at: "2026-11-01T00:00:00Z", name: `${i + 1}. ${name}` }));
  const out = { project: { id: "proj", name: "Test", tags }, on_craft_screen: false, sections: secs, tasks: [], items: [] };
  tasks.forEach((t, k) => {
    const task = { id: id("t"), section_id: t.section === null ? null : `sec-${t.section ?? sections[0]}`, title: t.title, is_sample: t.is_sample ?? false, created_at: `2026-11-02T00:00:${String(k).padStart(2, "0")}Z` };
    out.tasks.push(task);
    t.rows.forEach(([text, done = false, units = null], j) => out.items.push({ id: id("i"), task_id: task.id, text, is_done: done, sort_order: j, unit_count: units === null ? null : String(units), craft_part_id: null }));
  });
  return out;
}
const rnds = (from, to, done = 0, units = 36) => Array.from({ length: to - from + 1 }, (_, i) => [`Rnd ${from + i} · knit`, from + i <= done, units]);

// ── planCraftSetup on the mittens ─────────────────────────────────────────
// Craft S4 (pick 1, Brent 11/19): one part per section. The live mittens keep their S1C 8-part setup (grouping only
// runs at Set up / Reset); planned again today they are one part per mitten, the restarting round numbers counted
// straight through (the 8-part shape the craft screen reads is legacyMittenParts() below).
await test("Mittens (S4): one part per mitten section, rounds counted straight through, names from the sections", () => {
  const plan = planCraftSetup(mittens());
  assert.equal(plan.ok, true, plan.stops.join("; "));
  assert.deepEqual(plan.parts.map((p) => [p.name, p.row_word, p.total_rows, p.row_count, p.current_row, p.stitch_count, p.numbering, p.segments.map((s) => [s.name, s.from_row, s.to_row])]), [1, 2].map((m) => [
    `Mitten ${m}`, "round", 99, 99, m === 1 ? 15 : 1, null, "straight", [[`Mitten ${m} · Cuff: cast on + rnds 1–31`, 1, 31], [`Mitten ${m} · Thumb gusset: rnds 1–17`, 32, 48],
      [`Mitten ${m} · Hand: rnds 18–45 (to 4 in)`, 49, 76], [`Mitten ${m} · Top decreases: rnds 1–8`, 77, 84], [`Mitten ${m} · Thumb: pick-up + rnds 1–15`, 85, 99]],
  ]));
  assert.equal(plan.active_part_index, 0, "Mitten 1 at round 15");
  assert.equal(plan.parts[0].done_count, 14);
  assert.deepEqual(plan.parts.map((p) => p.gaps), plan.parts.map(() => []));
  assert.equal(plan.default_craft, "knit");
  assert.deepEqual(plan.stitch_fills, [], "every round already has its count: nothing is filled, nothing overwritten");
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
  const first = plan.parts[0];
  assert.deepEqual(first.rows.map((r) => r.row), Array.from({ length: 99 }, (_, i) => i + 1));
  assert.equal(first.rows[48].item_id, itemOf(snap, "Mitten 1 · Hand", "Rnd 18 ·").id, "the hand's Rnd 18 is round 49 of Mitten 1");
  const names = plan.parts.map((p, i) => (i === 0 ? "Left cuff" : p.name));
  const payload = craftSetupPayload(plan, "knit", names);
  assert.equal(payload.parts[0].name, "Left cuff");
  assert.deepEqual(Object.keys(payload).sort(), ["active_part_index", "craft", "parts", "units"]);
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
  assert.equal(planCraftSetup(snap).active_part_index, 0, "the rest of Mitten 1 is still to knit");
  for (const i of snap.items) if (snap.tasks.find((t) => t.id === i.task_id).title.startsWith("Mitten 1")) i.is_done = true;
  assert.equal(planCraftSetup(snap).active_part_index, 1);
  for (const i of snap.items) i.is_done = true;
  const plan = planCraftSetup(snap);
  assert.equal(plan.active_part_index, null);
  assert.ok(plan.parts.every((p) => p.current_row === null));
});

// ── Gaps: allowed, named, and counted from the rows that exist ───────────────
await test("Gaps: a cuff on its own that stops at Rnd 21 (est. rounds 22–28 deleted) → total 31, 24 rows, one named gap", () => {
  const snap = mittens();
  const cuff = taskId(snap, "Mitten 1 · Cuff");
  snap.items = snap.items.filter((i) => !(i.task_id === cuff && /^Rnd (2[2-8]) /.test(i.text)));
  // S4: gaps only exist where the labels run on, so the cuff alone in its section.
  snap.tasks = snap.tasks.filter((t) => t.id === cuff);
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
await test("S4: a repeated round is a restart, not a STOP: the part is counted straight through and the row keeps its text", () => {
  const snap = mittens();
  itemOf(snap, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12 · knit (US 7)";
  const plan = planCraftSetup(snap);
  assert.equal(plan.ok, true, plan.stops.join("; "));
  assert.deepEqual([plan.parts[0].numbering, plan.parts[0].total_rows], ["straight", 99]);
  assert.equal(plan.parts[0].rows[12].text, "Rnd 12 · knit (US 7)");
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
  assert.deepEqual(plan.stops, ["“s1” goes up to row 2,001; one part can hold at most 2,000."]);
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
  assert.deepEqual(b.parts.map((p) => [p.name, p.row_word, p.total_rows, p.segments.length, p.current_row, p.stitch_count]), [["s1", "row", 157, 11, 59, 195], ["s1 2", "round", 2, 1, 1, null]]);
  assert.deepEqual(s.parts.map((p) => [p.total_rows, p.segments.length, p.current_row, p.stitch_count]), [[519, 6, 119, 30]]);
  assert.equal(b.default_craft, "crochet");
  for (const snap of [blanket, scarf]) {
    const plan = planCraftSetup({ ...snap, on_craft_screen: true });
    assert.equal(plan.ok, false);
    assert.match(plan.stops[0], /^This project is already on the craft screen\./);
  }
});

// ── Grouping and parsing rules ────────────────────────────────────────
await test("Grouping (S4): one part per section and row word; never across a section; labels that run on keep their numbers (gaps named)", () => {
  const plan = planCraftSetup(snapOf([
    { title: "A · One: r", section: "s1", rows: rnds(1, 5) },
    { title: "A · Two: r", section: "s1", rows: rnds(6, 8) },          // runs on
    { title: "A · Three: r", section: "s1", rows: rnds(10, 12) },      // still runs on, with a gap at 9
    { title: "B · Four: r", section: "s2", rows: rnds(13, 14) },       // other section: new part
    { title: "B · Five", section: "s2", rows: [["Row 15"], ["Row 16"]] }, // other word: new part
  ], { sections: ["s1", "s2"] }));
  assert.deepEqual(plan.parts.map((p) => [p.name, p.segments.length, p.total_rows, p.numbering]), [["s1", 3, 12, "labels"], ["s2", 1, 14, "labels"], ["s2 2", 1, 16, "labels"]]);
  assert.deepEqual(plan.parts[0].gaps, [[9, 9]]);
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
  assert.deepEqual(plan.parts.map((p) => p.name), ["s1"]);
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
  const longSection = `🧶${"x".repeat(100)}`;
  const plan = planCraftSetup(snapOf([{ title: long, section: "s1", rows: rnds(1, 2) }, { title: "Body", section: longSection, rows: [["Row 1"]] }], { sections: ["s1", longSection] }));
  assert.ok(plan.parts.every((p) => Array.from(p.name).length <= 80 && p.segments.every((s) => Array.from(s.name).length <= 80)));
  assert.equal(plan.parts[1].name, `🧶${"x".repeat(79)}`, "S4: the section's name, cut the same way");
  assert.equal(setup.partNameFromTitle("Hat"), "Hat");
  assert.equal(setup.partNameFromTitle("Sock 2 · Heel flap"), "Sock 2 · Heel flap");
});

// ── Fix round 1: the row rule, units as text, near-misses ──────────────────
await test("FR1 row rule (F3): spaces or tabs after the word, ASCII digits, then a non-word character or the end; NBSP, FEFF and other separators are plain", () => {
  for (const [text, row] of [["Rnd 15", 15], ["Rnd\t15 · knit", 15], ["Round 5: knit", 5], ["Rnd 015 (est.)", 15], ["Row 7.", 7], ["Rnd 9·k", 9]]) {
    const parsed = parseRowLabel(text);
    assert.equal(parsed.kind, "row", JSON.stringify(text)); assert.equal(parsed.row, row, JSON.stringify(text));
  }
  for (const text of ["Rnd 15 · knit", "Rnd﻿15", "﻿Rnd 15", "Rnd 15", "Rnd 15", "Rnd\n15", "Rnd 15a", "Rnd 15_b", "Rnd16"]) {
    assert.deepEqual(parseRowLabel(text), { kind: "plain" }, JSON.stringify(text));
  }
  // The range check keeps the same whitespace as before (JavaScript's \s), written out so 072 can use the same class.
  for (const text of ["Rnd 3 – 5", "Rnd 3 to 5", "Rnd 3﻿-5", "Row 4 TO 6", "Row 4 thru 6", "Row 4.5"]) {
    assert.deepEqual(parseRowLabel(text), { kind: "bad", reason: "range" }, JSON.stringify(text));
  }
  for (const text of ["Row 4 tonight 6", "Row 4 and then 6", "Row 4, k2"]) assert.equal(parseRowLabel(text).kind, "row", JSON.stringify(text));
});
await test("FR1 units (F3/F5): unit_count is the database's numeric text, canonical like trim_scale(); one value however it is written", () => {
  const c = setup.canonicalUnitText;
  assert.equal(typeof c, "function");
  for (const [raw, want] of [["36", "36"], ["36.0", "36"], ["36.500", "36.5"], ["0", "0"], ["0.000", "0"], ["0.0000001", "0.0000001"], ["1000000000000000000000", "1000000000000000000000"], ["123456.789", "123456.789"], ["NaN", "NaN"], ["Infinity", "Infinity"], [null, null]]) {
    assert.equal(c(raw), want, String(raw));
  }
  const tiny = mittens(); itemOf(tiny, "Mitten 1 · Cuff", "Rnd 15 ·").unit_count = "0.0000001";
  assert.match(craftSetupFingerprintText(tiny), /\|0\.0000001\|[a-z-]*\|\|[0-9a-f]{64}(\n|$)/, "never 1e-7");
  const big = mittens(); itemOf(big, "Mitten 1 · Cuff", "Rnd 15 ·").unit_count = "1000000000000000000000";
  assert.match(craftSetupFingerprintText(big), /\|1000000000000000000000\|[a-z-]*\|\|/, "never 1e+21");
  const a = mittens(), b = mittens();
  itemOf(a, "Mitten 1 · Cuff", "Rnd 15 ·").unit_count = "36.0";
  assert.equal(craftSetupFingerprint(a), craftSetupFingerprint(b), "36.0 and 36 are the same value");
  const sc = (units) => planCraftSetup(snapOf([{ title: "P", rows: units.map((u, i) => [`Row ${i + 1}`, false, u]) }])).parts[0].stitch_count;
  assert.equal(sc(["36.0", "36"]), 36);
  assert.equal(sc(["2147483647", "2147483647"]), 2147483647);
  assert.equal(sc(["2147483648", "2147483648"]), null, "above the integer column");
  assert.equal(sc(["1000000000000000000000", "1000000000000000000000"]), null);
  assert.equal(sc(["NaN", "NaN"]), null);
  assert.equal(sc(["0.0000001", "0.0000001"]), null);
});
await test("FR1 near-misses (F4): items that look numbered but don't match the rule are listed with their task; mittens has none", () => {
  assert.deepEqual(planCraftSetup(mittens()).near_misses, []);
  const plan = planCraftSetup(snapOf([
    { title: "Mitten 1 · Cuff: r", rows: [["Rnd 1 · knit"], [" Rnd 16 · knit"], ["rnd 31 · knit"], ["Rnd16 · knit"], ["Round5: knit"], ["ROUND 6: knit"], ["Rnd 7"], ["﻿Rnd 8"], ["Rnd 9a"], ["Rnd. 10"], ["Pick-up rnd · knit"], ["Cast on 36"], ["Rounding the top"], ["Row of purl"]] },
    { title: "Swatch", is_sample: true, rows: [["rnd 1"]] },
  ]));
  assert.equal(plan.ok, true, plan.stops.join("; "));
  assert.deepEqual(plan.parts.map((p) => [p.name, p.total_rows, p.row_count]), [["s1", 1, 1]]);
  assert.deepEqual(plan.near_misses.map((n) => [n.text, n.task_title]), [" Rnd 16 · knit", "rnd 31 · knit", "Rnd16 · knit", "Round5: knit", "ROUND 6: knit", "Rnd 7", "﻿Rnd 8", "Rnd 9a", "Rnd. 10"].map((t) => [t, "Mitten 1 · Cuff: r"]));
  assert.ok(plan.near_misses.every((n) => plan.plain_items.some((i) => i.id === n.id)), "near-misses are plain steps too");
  assert.equal(plan.plain_items.length, 14, "13 on the cuff task plus the swatch item");
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
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").unit_count = "34"; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").craft_part_id = "p"; },
    (s) => { s.tasks[0].title += "!"; },
    (s) => { s.tasks[0].section_id = s.sections[1].id; },
    (s) => { s.tasks[0].created_at = "2026-11-12T00:00:00Z"; },
    (s) => { s.tasks[0].is_sample = true; },
    (s) => { s.sections[0].sort_order = 7; },
    (s) => { s.items.push({ ...s.items[0], id: "ffffffff-0000-4000-8000-000000000000" }); },
    (s) => { s.items.pop(); },
    // v2 (S4): the stitch-count step's inputs.
    (s) => { s.tasks[0].unit_count = "1111"; },
    (s) => { s.tasks[0].work_type = "garter"; },
    (s) => { itemOf(s, "Mitten 1 · Cuff", "Rnd 15 ·").work_type = "seed"; },
  ];
  for (const [k, edit] of edits.entries()) { const s = mittens(); edit(s); assert.notEqual(craftSetupFingerprint(s), base, `edit ${k}`); }
  const text = craftSetupFingerprintText(mittens()).split("\n");
  assert.equal(text[0], `craft-setup-v2|${fixture.project.id}`);
  assert.match(text[1], /^s\|[0-9a-f-]{36}\|[01]\|$/, "sections without created_at have an empty ms field");
  assert.match(text.find((l) => l.startsWith("t|")), /^t\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|\d{13}\|0\|(\d+)?\|[a-z-]*\|[0-9a-f]{64}$/);
  assert.match(text.find((l) => l.startsWith("i|")), /^i\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|\d+\|[01]\|(\d+(\.\d+)?)?\|[a-z-]*\|\|[0-9a-f]{64}$/);
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

// The mittens as they are on the craft screen today (set up by S1C before S4's one-part-per-section rule): per mitten
// Cuff, Hand (thumb gusset + hand), Top decreases, Thumb, rows numbered by their labels.
function legacyMittenParts() {
  const snap = mittens(), byTask = (title) => snap.tasks.find((t) => t.title.startsWith(title));
  return [1, 2].flatMap((m) => [["Cuff", ["Cuff"]], ["Hand", ["Thumb gusset", "Hand"]], ["Top decreases", ["Top decreases"]], ["Thumb", ["Thumb:"]]].map(([name, stages]) => {
    const tasks = stages.map((stage) => byTask(`Mitten ${m} · ${stage}`));
    const rows = tasks.flatMap((task) => snap.items.filter((i) => i.task_id === task.id).map((i) => ({ i, parsed: setup.parseRowLabel(i.text) }))
      .filter(({ parsed }) => parsed.kind === "row").map(({ i, parsed }) => ({ item_id: i.id, row: parsed.row, is_done: i.is_done, text: i.text, units: i.unit_count })));
    rows.sort((a, b) => a.row - b.row);
    const units = new Set(rows.map((r) => r.units));
    return { name: `Mitten ${m} · ${name}`, row_word: "round", total_rows: Math.max(...rows.map((r) => r.row)), stitch_count: units.size === 1 && rows[0].units ? Number(rows[0].units) : null, rows,
      segments: tasks.map((task) => { const n = rows.filter((r) => snap.items.find((i) => i.id === r.item_id).task_id === task.id).map((r) => r.row); return { task_id: task.id, name: task.title, from_row: Math.min(...n), to_row: Math.max(...n) }; }) };
  }));
}
// The mittens as the craft screen reads them: parts p0..p7, stored active part = Mitten 1 · Cuff.
function mittensView(tick = () => false, extra = {}) {
  const plan = { parts: legacyMittenParts() };
  const data = input(plan.parts.map((p, i) => part(`p${i}`, p.total_rows, { name: p.name, sort_order: i, row_word: p.row_word, stitch_count: p.stitch_count })),
    plan.parts.flatMap((p, i) => p.rows.map((r) => ({ id: r.item_id, craft_part_id: `p${i}`, craft_row: r.row, text: r.text, is_done: r.is_done || tick(i, r.row), completed_at: null }))));
  data.project = { id: PID_MITTENS, name: fixture.project.name };
  data.segments = plan.parts.flatMap((p, i) => p.segments.map((g, k) => ({ id: `s${i}-${k}`, part_id: `p${i}`, task_id: g.task_id, name: g.name, from_row: g.from_row, to_row: g.to_row, sort_order: k, close_check: false })));
  data.craft_project.active_part_id = "p0";
  return Object.assign(data, extra);
}
const PID_MITTENS = fixture.project.id;
const listOf = (data) => buildCraftProjectList({ craft_projects: [{ project_id: data.project.id, craft: "knit", active_part_id: data.craft_project.active_part_id }],
  projects: [data.project], parts: data.parts.map((p) => ({ ...p, project_id: data.project.id })), items: data.items.filter((i) => !i.is_done) })[0];
await test("FR1 active part (F2): a finished stored part gives way to the first unfinished part; the switcher label follows", () => {
  const before = buildCraftView(mittensView());
  assert.deepEqual([before.active_part.name, before.active_part.current_row], ["Mitten 1 · Cuff", 15]);
  const cuffDone = mittensView((i) => i === 0);
  const v = buildCraftView(cuffDone);
  assert.deepEqual([v.active_part.id, v.active_part.name, v.active_part.current_row, v.active_part.row_label, v.active_part.finished], ["p1", "Mitten 1 · Hand", 1, "Round 1", false]);
  assert.equal(v.current_segment.name, "Mitten 1 · Thumb gusset: rnds 1–17");
  assert.equal(v.parts[0].row_label, "Finished", "the cuff itself still reads Finished in the parts list");
  assert.equal(cuffDone.craft_project.active_part_id, "p0", "the stored value is not changed (S2 writes it)");
  assert.equal(listOf(cuffDone).progress, "round 1");
  assert.equal(craftProjectOptionLabel(listOf(cuffDone)), `${fixture.project.name} · round 1`);
  const html = renderToStaticMarkup(createElement(CraftScreen, { view: v }));
  assert.match(html, /<h3>Mitten 1 · Hand<\/h3>/);
  assert.match(html, /<span class="craft-pf-num">1<\/span><span class="craft-pf-of">of 45<\/span>/);
  // A stored part that is not finished still wins, even with an earlier unfinished part.
  const stored = mittensView(); stored.craft_project.active_part_id = "p2";
  assert.equal(buildCraftView(stored).active_part.name, "Mitten 1 · Top decreases");
  // Everything ticked: Finished / done as before.
  const all = mittensView(() => true);
  assert.deepEqual([buildCraftView(all).active_part.id, buildCraftView(all).active_part.row_label], ["p0", "Finished"]);
  assert.equal(listOf(all).progress, "done");
  const none = mittensView(() => true); none.craft_project.active_part_id = null;
  assert.equal(buildCraftView(none).active_part, null);
  assert.equal(listOf(none).progress, "done");
});
await test("FR1 view model (F1): can_remove comes from the server's remove_blockers; unknown means no", () => {
  assert.deepEqual([buildCraftView(mittensView(undefined, { remove_blockers: [] })).can_remove, buildCraftView(mittensView(undefined, { remove_blockers: [] })).remove_blockers], [true, []]);
  const kept = buildCraftView(mittensView(undefined, { remove_blockers: ["links", "instructions"] }));
  assert.deepEqual([kept.can_remove, kept.remove_blockers], [false, ["links", "instructions"]]);
  assert.equal(buildCraftView(mittensView()).can_remove, false, "no answer from the server: Remove is not offered");
  assert.equal(buildCraftView(pinnedInputs().scarf).can_remove, false);
});


// S2 (073) changes exactly three places on these screens: the header's "Read only" label becomes the (empty until
// held) "screen on" chip, and the timer placeholder becomes the timer card plus the action bar (Log sitting, Row
// done, Undo/Fix/Note). Everything else must still render byte for byte as at ca00c76.
const S1_TIMER = '<div class="craft-timer"><span aria-hidden="true">--:--</span><p>Timer arrives in the next update</p></div>';
const S2_BLOCK = /<div class="craft-s2">[\s\S]*?(?=<section class="craft-today")/;
// S3 FR3 adds the Parts button by the part's name and, in the inside Parts list, each part's "Work on this part" /
// "Change total…" buttons and "on the screen" (these fixtures have no checks, so nothing else may change).
const s3fr3 = (html) => html.replace(/<button type="button" class="craft-parts-open"[^>]*>Parts<\/button>/, "")
  .replace('<ul class="craft-parts craft-parts-act">', '<ul class="craft-parts">').replace(/<div class="craft-part-buttons">[\s\S]*?<\/div>/g, "")
  .replace(/ · on the screen<\/span>/g, "</span>");
await test("Before/after: the blanket and scarf screens render byte for byte as at ca00c76, apart from the header menu and S2's screen-on chip, timer card and action bar", () => {
  const pinned = JSON.parse(readFileSync(new URL("./fixtures/craft/screen-s1a.snapshot.json", import.meta.url), "utf8"));
  const now = pinnedInputs();
  assert.deepEqual(Object.keys(now), Object.keys(pinned));
  for (const [name, html] of Object.entries(pinned)) {
    const after = renderScreen(now[name]);
    assert.match(after, MENU, `${name}: menu`);
    assert.match(after, S2_BLOCK, `${name}: S2 controls`);
    const s1 = s3fr3(after.replace(MENU, "").replace('<span class="craft-awake"></span>', '<span class="craft-readonly">Read only</span>').replace(S2_BLOCK, S1_TIMER));
    assert.equal(s1, html, `${name} changed outside the S2 controls`);
  }
});
await test("SSR gaps: the craft screen says 21 of 24 rounds ticked, of 31, and lists 29–31 next", () => {
  const html = renderScreen(gapPart());
  assert.match(html, /<span class="craft-pf-num">29<\/span><span class="craft-pf-of">of 31<\/span>/);
  assert.match(html, /· 21 of 24 rounds ticked/);
  assert.match(html, /<li><span>round 30<\/span><p>Rnd 30 · knit<\/p><\/li><li><span>round 31<\/span>/);
});
await test("SSR menu: a labelled disclosure (closed) with Remove from craft screen; the sheet says what stays", () => {
  const html = renderToStaticMarkup(createElement(CraftScreenMenu, { projectId: "p1", projectName: "Mittens", canRemove: true, partCount: 8, blockers: [] }));
  assert.match(html, /aria-label="Craft screen menu" aria-expanded="false" aria-controls="([^"]+)">⋯<\/button><div id="\1" class="craft-menu-panel" hidden="">/);
  assert.match(html, /<button type="button" class="craft-menu-item">Remove from craft screen<\/button>/);
  assert.equal(REMOVE_KEEPS, "Your ticks, stitch counts and sittings stay.");
  const source = readFileSync(new URL("../src/components/craft/CraftScreenMenu.tsx", import.meta.url), "utf8");
  assert.match(source, /<Modal open=\{confirming\} onClose=\{close\} title="Remove from craft screen\?">/);
  assert.match(source, /<strong>\{REMOVE_KEEPS\}<\/strong>/);
  assert.match(source, /\{removeGoes\(partCount\)\}/);
  assert.match(source, /variant="danger"[^>]*>\{state\.busy \? "Removing…" : "Remove"\}/);
});
await test("FR1 Remove (F1): the menu offers Remove only when the server allows it; the sheet says exactly what goes", async () => {
  const menu = await import("../src/components/craft/CraftScreenMenu.tsx");
  assert.equal(menu.removeGoes(8), "Removes the craft screen setup for this project: 8 parts and their row links.");
  assert.equal(menu.removeGoes(1), "Removes the craft screen setup for this project: 1 part and its row links.");
  assert.equal(`${menu.removeGoes(8)} ${REMOVE_KEEPS}`, "Removes the craft screen setup for this project: 8 parts and their row links. Your ticks, stitch counts and sittings stay.");
  const kept = renderToStaticMarkup(createElement(CraftScreenMenu, { projectId: "p1", projectName: "Scarf", canRemove: false, partCount: 1, blockers: ["links", "instructions", "quarters", "ridges"] }));
  assert.doesNotMatch(kept, /Remove from craft screen<\/button>/);
  assert.match(kept, /<p class="craft-menu-note">Remove from craft screen isn’t offered here: this project has links, instructions, quarter rows and ridge counts that Set up can’t make again\.<\/p>/);
  // On the real screen: the scarf (S1 setup, no answer or blockers) has no Remove; the mittens after Create do.
  assert.doesNotMatch(renderScreen(pinnedInputs().scarf), /Remove from craft screen<\/button>/);
  assert.doesNotMatch(renderScreen(Object.assign(pinnedInputs().scarf, { remove_blockers: ["links", "instructions", "quarters", "ridges"] })), /Remove from craft screen<\/button>/);
  assert.match(renderScreen(mittensView(undefined, { remove_blockers: [] })), /<button type="button" class="craft-menu-item">Remove from craft screen<\/button>/);
  const source = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(source, /<CraftScreenMenu projectId=\{view\.project\.id\} projectName=\{view\.project\.name\} canRemove=\{view\.can_remove\} partCount=\{view\.parts\.length\} blockers=\{view\.remove_blockers\}/);
});
const renderSetup = (snap) => { const plan = planCraftSetup(snap); return renderToStaticMarkup(createElement(CraftSetupScreen, { projectId: snap.project.id, plan, fingerprint: craftSetupFingerprint(snap) })); };
await test("SSR setup preview (mittens, S4): 2 named parts as labelled inputs, facts, the straight-through note, stitch counts, segments, plain steps, kind and Create", () => {
  const html = renderSetup(mittens());
  assert.match(html, /<h1>Set up craft screen<\/h1>/);
  assert.match(html, /Preview · nothing is saved until Create/);
  assert.equal((html.match(/<input [^>]*value="Mitten \d"/g) ?? []).length, 2);
  assert.match(html, /<label class="craft-setup-name"><span>Part 1 name<\/span><input maxLength="100" value="Mitten 1"\/><\/label>/);
  assert.match(html, /Rounds · 99 in all · now round 15 · stitches change · 14 of 99 rounds ticked/);
  assert.match(html, /Rounds · 99 in all · now round 1 · stitches change · 0 of 99 rounds ticked/);
  assert.match(html, /The round numbers start again inside this part, so the screen counts its rounds straight through, 1 to 99\. Each round keeps its pattern text\./);
  assert.match(html, /Stitch counts: nothing to fill · 3,288 stitches in all/);
  assert.match(html, /<li data-active="true">/);
  assert.equal((html.match(/data-active/g) ?? []).length, 1);
  assert.match(html, /<li><span>Mitten 1 · Thumb gusset: rnds 1–17<\/span><span>rounds 32–48<\/span><\/li><li><span>Mitten 1 · Hand: rnds 18–45 \(to 4 in\)<\/span><span>rounds 49–76<\/span><\/li>/);
  assert.match(html, /Plain steps <span class="craft-setup-count">20<\/span>/);
  assert.match(html, /<summary>Show the 20 plain steps<\/summary>/);
  assert.match(html, /<legend>Craft<\/legend><label><input type="radio" name="craft-kind" checked="" value="knit"\/>Knitting<\/label>/);
  assert.match(html, /<button type="button"[^>]*>Create 2 parts on the craft screen<\/button>/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /Claude|Anthropic|OpenAI|ChatGPT|GPT/);
});
await test("SSR setup preview: gaps are named, swatch items marked, and a STOP shows the reason with no Create", () => {
  const gap = mittens();
  const cuff = taskId(gap, "Mitten 1 · Cuff");
  gap.items = gap.items.filter((i) => !(i.task_id === cuff && /^Rnd (2[2-8]) /.test(i.text)));
  gap.tasks = gap.tasks.filter((t) => t.id === cuff);
  assert.match(renderSetup(gap), /<p class="craft-setup-gap">Rounds 22–28 are not in the list; the screen goes from 21 to 29\.<\/p>/);
  assert.match(renderSetup(gap), /14 of 24 rounds ticked/);
  assert.match(renderSetup(snapOf([{ title: "Swatch", is_sample: true, rows: [["Row 1"]] }, { title: "Body", rows: [["Row 1"]] }])), /<strong>\[swatch\] <\/strong>Row 1/);
  const stop = mittens(); itemOf(stop, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12–13 · knit";
  const html = renderSetup(stop);
  assert.match(html, /<section class="craft-setup-stop" role="alert" aria-labelledby="craft-setup-stop-title"><h3 id="craft-setup-stop-title">This project can’t be set up yet<\/h3><ul><li>“Rnd 12–13 · knit” on “Mitten 1 · Cuff: cast on \+ rnds 1–31” looks like a range of rows; give each one its own checklist item in the app first\.<\/li><\/ul>/);
  assert.doesNotMatch(html, /Create \d+ part|name="craft-kind"/);
  assert.match(html, /<input maxLength="100" disabled="" value="Mitten 1"\/>/);
  const set = renderSetup({ ...mittens(), on_craft_screen: true });
  assert.match(set, /href="\/craft\/6c30a08d-9210-54f1-a43a-78ef6e472f95">Open craft screen<\/a>/);
});
await test("FR1 SSR near-misses (F4): listed under “Not counted as rounds/rows” with their task; absent for the mittens", () => {
  assert.doesNotMatch(renderSetup(mittens()), /Not counted as rounds\/rows/);
  const snap = mittens();
  itemOf(snap, "Mitten 2 · Cuff", "Rnd 31 ").text = "rnd 31 · knit";
  itemOf(snap, "Mitten 2 · Thumb gusset", "Rnd 16 ").text = " Rnd 16 · knit";
  const html = renderSetup(snap);
  assert.match(html, /<section class="craft-setup-section" aria-labelledby="craft-setup-near"><h2 id="craft-setup-near">Not counted as rounds\/rows <span class="craft-setup-count">2<\/span><\/h2>/);
  assert.match(html, /<ul class="craft-setup-near"><li><span>rnd 31 · knit<\/span><small>Mitten 2 · Cuff: cast on \+ rnds 1–31<\/small><\/li><li><span> Rnd 16 · knit<\/span><small>Mitten 2 · Thumb gusset: rnds 1–17<\/small><\/li><\/ul>/);
  assert.match(html, /Create 2 parts on the craft screen/, "near-misses don't stop Create");
});
await test("partFacts, sendCreate and sendRemove turn replies into plain words", async () => {
  assert.equal(partFacts({ ...planCraftSetup(snapOf([{ title: "Thumb", rows: rnds(1, 15, 0, 14) }])).parts[0], current_row: null }), "Rounds · 15 in all · all ticked · 14 stitches · 0 of 15 rounds ticked");
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
  assert.equal(body.plan.parts.length, 2);
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
  const body = createBody(snap, { craft: "other" }); body.names[1] = "Right mitten";
  const res = await setupPost(req(db, "POST", body), ctx());
  assert.equal(res.status, 201);
  assert.equal(db.rpcCalls.length, 1);
  const [name, args] = db.rpcCalls[0];
  assert.equal(name, "craft_setup_project");
  assert.deepEqual(Object.keys(args).sort(), ["p_fingerprint", "p_plan", "p_project_id", "p_user_id"]);
  assert.equal(args.p_user_id, UID); assert.equal(args.p_project_id, PID); assert.equal(args.p_fingerprint, body.fingerprint);
  assert.equal(args.p_plan.craft, "other");
  assert.equal(args.p_plan.parts[1].name, "Right mitten");
  assert.equal(args.p_plan.active_part_index, 0);
  assert.deepEqual(args.p_plan.units, [], "S4: the stitch-count step's writes ride in the plan (none for the mittens)");
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
  const stop = mittens(); itemOf(stop, "Mitten 1 · Cuff", "Rnd 13 ·").text = "Rnd 12–13 · knit";
  const stopped = await setupPost(req(fakeDb(stop), "POST", createBody(stop)), ctx());
  assert.equal(stopped.status, 409);
  assert.deepEqual((await stopped.json()).stops, ["“Rnd 12–13 · knit” on “Mitten 1 · Cuff: cast on + rnds 1–31” looks like a range of rows; give each one its own checklist item in the app first."]);
  const set = await setupPost(req(fakeDb(mittens(), { craftRow: true }), "POST", createBody(mittens())), ctx());
  assert.equal(set.status, 409);
  assert.match((await set.json()).error, /already on the craft screen/);
  assert.equal((await setupPost(req(fakeDb(mittens()), "POST", "{not json"), ctx())).status, 400);
  assert.equal((await setupPost(req(fakeDb(mittens()), "POST", { ...createBody(mittens()), craft: "weave" }), ctx())).status, 400);
  for (const [code, status, reason] of [["MC072", 409, "changed"], ["23505", 409, "exists"], ["P0002", 409, "changed"], ["22023", 400, "invalid"], ["40P01", 409, "changed"], ["55P03", 409, "changed"], ["XX000", 500, undefined], ["42501", 500, undefined]]) {
    const db = fakeDb(mittens(), { rpc: () => ({ data: null, error: { code, message: "db" } }) });
    const res = await quiet(() => setupPost(req(db, "POST", createBody(mittens())), ctx()));
    assert.equal(res.status, status, code);
    if (reason) assert.equal((await res.json()).reason, reason);
  }
});
await test("DELETE Remove: 404 when not on the craft screen (PGRST116), one 072 call when it is, P0002 race is 409, 40P01 is 409 (S2 carry-over c), errors 500", async () => {
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
  assert.equal((await craftDelete(req(fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: null, error: { code: "40P01", message: "x" } }) }), "DELETE"), ctx())).status, 409);
  assert.equal((await quiet(() => craftDelete(req(fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: null, error: { code: "XX000", message: "x" } }) }), "DELETE"), ctx()))).status, 500);
  const keeps = await craftDelete(req(fakeDb(mittens(), { craftRow: true, rpc: () => ({ data: null, error: { code: "MC72R", message: "CRAFT_REMOVE_KEEPS", details: "links,notes" } }) }), "DELETE"), ctx());
  assert.equal(keeps.status, 409, "FR1: a project with things Set up can't remake is refused");
  assert.deepEqual(await keeps.json(), { error: "This project can’t be removed from the craft screen: it has links and notes that Set up can’t make again.", reason: "keeps" });
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
  assert.match(service, /\.filter\("text", "match", CRAFT_ROW_ITEM_MATCH\)\.limit\(1\)/);
  assert.equal(setup.CRAFT_ROW_ITEM_MATCH, "^(Row|Rnd|Round)[ \\t]+[0-9]+([^0-9A-Za-z_]|$)", "the button uses the same rule as the planner and 072");
  assert.equal(setup.craftSetupHref("abc"), "/craft/setup/abc");
  const setupPage = readFileSync(new URL("../src/app/craft/setup/[projectId]/page.tsx", import.meta.url), "utf8");
  assert.match(setupPage, /key=\{preview\.fingerprint\}/);
});

console.log(`\nCraft setup: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
