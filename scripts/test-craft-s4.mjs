#!/usr/bin/env node
// Craft S4 offline checks (Baseline 690e174c): the one-part-per-section grouping (C), section part names (D), the
// cast-on as a step before Row 1 (pick 2), the stitch-count step (H) on the One Row Scarf and Sophie Hood shapes,
// the Reset words (B), the checklist row inputs (E, G), the delete guard's route (A), the reset route, the MCP tools
// through the real /api/mcp handler, the screens, and 075's text. No network, no database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const LEGACY_KEY = "test-legacy-key-aaaaaaaaaaaaaaaa";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_USER_ID = "00000000-0000-4000-8000-000000000001";
process.env.DEPLOYMENT_ROLE = "main";
const mcpCalls = [];
let mcpResponder = () => new Response(JSON.stringify({ error: "no responder" }), { status: 500 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const call = { url, method: (init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : undefined };
  mcpCalls.push(call);
  return mcpResponder(call);
};

const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const setup = await import("../src/lib/craft/setup.ts");
const reset = await import("../src/lib/craft/reset.ts");
const input = await import("../src/lib/checklist-input.ts");
const { buildCraftView } = await import("../src/lib/craft.ts");
const { craftSetupFingerprint, craftResetFingerprint } = await import("../src/lib/craft/setup-fingerprint.ts");
const { oneRowScarf, sophieHood, snapshotOf } = await import("./fixtures/craft/s4-fixtures.mjs");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const checklistRoute = await import("../src/app/api/tasks/[id]/checklist/route.ts");
const resetRoute = await import("../src/app/api/craft/[projectId]/reset/route.ts");
const mcpRoute = await import("../src/app/api/mcp/route.ts");
const { planCraftSetup } = setup;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL - ${name}`, e); }
}
const plan = (desc, opts) => planCraftSetup(snapshotOf(desc), opts);
const fillsOf = (snap, p) => new Map(p.stitch_fills.map((f) => [f.item_id, f]));
const itemsOfTask = (snap, title) => { const t = snap.tasks.find((x) => x.title === title); return snap.items.filter((i) => i.task_id === t.id).sort((a, b) => a.sort_order - b.sort_order); };

// ── C, D, pick 2: the One Row Scarf ─────────────────────────────────────
await test("Scarf (C): one part “Scarf”, 385 rows by their own numbers, tasks by first row number though 201+ were made first", () => {
  const p = plan(oneRowScarf());
  assert.equal(p.ok, true, p.stops.join("; "));
  assert.deepEqual(p.parts.map((x) => [x.name, x.row_word, x.total_rows, x.row_count, x.numbering, x.current_row, x.gaps.length]), [["Scarf", "row", 385, 385, "labels", 1, 0]]);
  assert.deepEqual(p.parts[0].segments.map((s) => [s.name, s.from_row, s.to_row]), [
    ["Cast on 30 + rows 1–100", 1, 100], ["Rows 101–200", 101, 200], ["Rows 201–300", 201, 300], ["Rows 301–385 + bind off (provisional)", 301, 385]]);
  assert.equal(p.active_part_index, 0);
});
await test("Scarf (pick 2): Cast on 30 and the checks are plain steps; Finishing has no rows and no part; Create opens on Cast on 30 before Row 1", () => {
  const snap = snapshotOf(oneRowScarf()), p = planCraftSetup(snap);
  assert.deepEqual(p.plain_items.filter((i) => !i.task_title.startsWith("Finishing")).map((i) => i.text.split(" ").slice(0, 3).join(" ")),
    ["Bind off (provisional),", "Cast on 30", "Check: gauge at", "Check: still 30"]);
  assert.ok(p.parts[0].rows.every((r) => /^Row \d+ ·/.test(r.text)));
  // The craft screen as Create leaves it: the cast-on is a due step before Row 1.
  const items = p.parts[0].rows.map((r) => ({ id: r.item_id, craft_part_id: "scarf", craft_row: r.row, text: r.text, is_done: false, completed_at: null }));
  const plain = snap.items.filter((i) => !p.parts[0].rows.some((r) => r.item_id === i.id) && snap.tasks.find((t) => t.id === i.task_id).title !== "Finishing")
    .map(({ id, task_id, text, is_done, sort_order }) => ({ id, task_id, text, is_done, sort_order }));
  items.forEach((item) => { item.task_id = snap.items.find((i) => i.id === item.id).task_id; item.sort_order = snap.items.find((i) => i.id === item.id).sort_order; });
  const view = buildCraftView({ project: { id: "p", name: "Scarf" }, craft_project: { craft: "knit", gear: null, active_part_id: "scarf" },
    parts: [{ id: "scarf", name: "Scarf", total_rows: 385, row_word: "row", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: 30 }],
    items, segments: [], sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-20T00:00:00Z", plain_items: plain });
  assert.equal(view.active_part.current_row, 1);
  assert.deepEqual(view.due_checks.map((c) => c.text), ["Cast on 30"], "the screen opens on the cast-on, a step before Row 1");
});
await test("Scarf (H): Cast on 30 → 30 (cast-on), every row 30, checks and bind-off none; sums 3030 / 3000 / 3000 / 2550; stitch count 30", () => {
  const snap = snapshotOf(oneRowScarf()), p = planCraftSetup(snap), fills = fillsOf(snap, p);
  assert.equal(p.stitch_fills.length, 386);
  const first = itemsOfTask(snap, "Cast on 30 + rows 1–100");
  assert.deepEqual(fills.get(first[0].id), { item_id: first[0].id, unit_count: 30, work_type: "cast-on" });
  assert.ok(first.filter((i) => i.text.startsWith("Row")).every((i) => fills.get(i.id).unit_count === 30 && fills.get(i.id).work_type === null));
  assert.ok(first.filter((i) => i.text.startsWith("Check")).every((i) => !fills.has(i.id)));
  for (const [title, sum] of [["Cast on 30 + rows 1–100", 3030], ["Rows 101–200", 3000], ["Rows 201–300", 3000], ["Rows 301–385 + bind off (provisional)", 2550]]) {
    assert.equal(itemsOfTask(snap, title).reduce((n, i) => n + (fills.get(i.id)?.unit_count ?? 0), 0), sum, title);
  }
  assert.ok(!fills.has(itemsOfTask(snap, "Rows 301–385 + bind off (provisional)").at(-1).id), "bind off gets none");
  assert.deepEqual(p.parts[0].stitches, { rows_filled: 385, cast_ons_filled: 1, total_stitches: 11580, skipped: [] });
  assert.equal(p.parts[0].stitch_count, 30);
});

// ── C, D, H: the Sophie Hood ────────────────────────────────────────────
await test("Sophie Hood (pick 1): 3 parts in order, named from the sections, rows counted straight through: 318, 135, 317", () => {
  const p = plan(sophieHood());
  assert.equal(p.ok, true, p.stops.join("; "));
  assert.deepEqual(p.parts.map((x) => [x.name, x.total_rows, x.row_count, x.numbering, x.gaps.length]),
    [["Scarf 1 (increases)", 318, 318, "straight"], ["Hood", 135, 135, "straight"], ["Scarf 2 (decreases)", 317, 317, "straight"]].map((r) => [...r, 0]));
  assert.deepEqual(p.parts[0].segments.map((s) => [s.from_row, s.to_row]), [[1, 6], [7, 46], [47, 318]]);
  assert.equal(p.parts[0].rows[6].text, "Row 1 (rep 1) · WS inc: k2, kfb, k to end → 7", "the pattern text stays the row text");
  assert.ok(!p.parts.some((x) => x.segments.some((s) => /Prep|Finishing/.test(s.name))), "the prep task and Finishing have no rows");
});
await test("Sophie Hood (H): before-count rule, holder rows work the after-count, every task adds up to its own count", () => {
  const snap = snapshotOf(sophieHood()), p = planCraftSetup(snap), fills = fillsOf(snap, p);
  const units = (title) => itemsOfTask(snap, title).map((i) => fills.get(i.id)?.unit_count ?? null);
  assert.deepEqual(units("Scarf 1 · Tip: cast on + rows 1–6 (6 sts)"), [6, 6, 6, 6, 6, 6, 6]);
  const inc = units("Increases reps 1–5");
  assert.deepEqual(inc.slice(0, 9), [6, 7, 7, 7, 7, 7, 7, 7, 7], "rep 1's Row 1 works the 6 on the needle; rows 2–8 work 7");
  assert.equal(inc.at(-1), null, "the check gets none");
  assert.deepEqual(units("Hood · Right side straight: rows 1–33 (42 sts)").slice(0, 2), [42, 42], "3 sts to holder: the row works the 42 left");
  assert.deepEqual(units("Scarf 2 · Rejoin: rows 1–7"), [42, 45, 45, 45, 45, 45, 45], "putting held stitches back works the 42 before it");
  const dec = units("Scarf 2 · Decreases reps 1–5");
  assert.deepEqual([dec[0], dec[1], dec[8], dec[9]], [45, 44, 44, 43]);
  for (const t of sophieHood().tasks.filter((x) => x.unit_count !== null)) {
    assert.equal(itemsOfTask(snap, t.title).reduce((n, i) => n + (fills.get(i.id)?.unit_count ?? 0), 0), t.unit_count, t.title);
  }
  assert.deepEqual(p.parts.map((x) => x.stitches.skipped), [[], [], []]);
  assert.deepEqual(p.parts.map((x) => [x.stitches.rows_filled, x.stitches.cast_ons_filled, x.stitches.total_stitches]), [[318, 1, 3389], [135, 0, 5670], [317, 0, 12797]]);
});
await test("H guard: a task whose rows don't add up is listed and left without counts (no partial fill); the rest are filled", () => {
  const desc = sophieHood(); desc.tasks.find((t) => t.key === "right").unit_count = 1389;
  const snap = snapshotOf(desc), p = planCraftSetup(snap), fills = fillsOf(snap, p);
  assert.ok(itemsOfTask(snap, "Hood · Right side straight: rows 1–33 (42 sts)").every((i) => !fills.has(i.id)));
  assert.deepEqual(p.parts[1].stitches.skipped.map((s) => [s.task_title, s.reason]), [["Hood · Right side straight: rows 1–33 (42 sts)", "Its rows add up to 1,386 stitches but the task says 1,389, so this task is left without counts."]]);
  assert.equal(p.parts[1].stitches.rows_filled, 102);
  assert.ok(itemsOfTask(snap, "Hood · Top: rows 1–69").every((i) => fills.get(i.id)?.unit_count === 42), "the count still carries past a skipped task");
  assert.equal(p.ok, true, "a skipped task never blocks Create");
});
await test("H guard: a row with no “→ N” and no count before it is a skip reason, never a guess", () => {
  const p = plan({ project: { name: "P", tags: [] }, sections: [{ key: "a", name: "1. Body" }], tasks: [
    { key: "t", section: "a", title: "Rows 1–3", unit_count: null, work_type: null, created: 0, items: ["Row 1 · knit", "Row 2 · knit → 20", "Row 3 · knit"] }] });
  assert.deepEqual(p.stitch_fills, []);
  assert.match(p.parts[0].stitches.skipped[0].reason, /^“Row 1 · knit” has no stitch count before it/);
});
await test("H: a count already on a row is never overwritten (and counts in the sum); a constant-width task carries its count only when its total can check it", () => {
  const desc = oneRowScarf(), snap = snapshotOf(desc);
  const row5 = itemsOfTask(snap, "Cast on 30 + rows 1–100")[5];
  row5.unit_count = "30";
  const p = planCraftSetup(snap);
  assert.ok(!p.stitch_fills.some((f) => f.item_id === row5.id));
  assert.equal(p.stitch_fills.length, 385);
  const odd = snapshotOf(desc); itemsOfTask(odd, "Cast on 30 + rows 1–100")[5].unit_count = "31";
  const q = planCraftSetup(odd);
  assert.match(q.parts[0].stitches.skipped[0].reason, /add up to 3,031 stitches but the task says 3,030/);
  // No task total: rows that all say "→ N" are filled; a task that carries a count over rows without one is not.
  const free = oneRowScarf(); free.tasks.forEach((t) => { t.unit_count = null; });
  const f = plan(free);
  assert.equal(f.stitch_fills.length, 1 + 100 + 100, "Cast on + rows 1–100 and 101–200 say → 30 on every row");
  assert.deepEqual(f.parts[0].stitches.skipped.map((x) => [x.task_title, x.reason]), ["Rows 201–300", "Rows 301–385 + bind off (provisional)"]
    .map((title) => [title, "Some rows have no “→ N” and the task has no stitch total to check the carried count against, so this task is left without counts."]));
});
await test("H: the cast-on keeps a work type it already has; a sample (swatch) task gets nothing", () => {
  const snap = snapshotOf(oneRowScarf());
  const castOn = itemsOfTask(snap, "Cast on 30 + rows 1–100")[0]; castOn.work_type = "long-tail";
  assert.equal(planCraftSetup(snap).stitch_fills.find((f) => f.item_id === castOn.id).work_type, null);
  const swatch = snapshotOf(oneRowScarf()); swatch.tasks.forEach((t) => { t.is_sample = true; });
  assert.deepEqual(planCraftSetup(swatch).stitch_fills, []);
  assert.equal(setup.stitchesAfter("Row 1 · k → 30 (was → 28)"), 28, "the last arrow is the count after the row");
  assert.equal(setup.stitchesAfter("Row 1 · knit"), null);
  assert.ok(setup.movesToHolder("3 sts to holder, k to last 3") && setup.movesToHolder("slip 3 sts onto the holder") && !setup.movesToHolder("put the 3 held i-cord sts back"));
});

// ── C, D: the rules on small cases ─────────────────────────────────────
const small = (tasks, sections = [{ key: "a", name: "1. Body" }]) => ({ project: { name: "P", tags: ["crochet"] }, sections, tasks: tasks.map((t, i) => ({ unit_count: null, work_type: null, created: i, section: "a", ...t })) });
await test("C: labels that restart inside a section (by creation) → straight through; that run on but were made out of order → by first number", () => {
  const restart = plan(small([{ key: "x", title: "Second made first", items: ["Row 1 · b", "Row 2 · b"], created: 0 }, { key: "y", title: "Made later", items: ["Row 1 · a", "Row 2 · a"], created: 1 }]));
  assert.deepEqual(restart.parts[0].segments.map((s) => [s.name, s.from_row, s.to_row]), [["Second made first", 1, 2], ["Made later", 3, 4]], "created order breaks the tie");
  const runOn = plan(small([{ key: "x", title: "Rows 11–12", items: ["Row 11", "Row 12"], created: 0 }, { key: "y", title: "Rows 1–10", items: Array.from({ length: 10 }, (_, i) => `Row ${i + 1}`), created: 1 }]));
  assert.deepEqual([runOn.parts[0].numbering, runOn.parts[0].segments.map((s) => s.name)], ["labels", ["Rows 1–10", "Rows 11–12"]]);
  const overlap = plan(small([{ key: "x", title: "A", items: ["Row 1", "Row 5"] }, { key: "y", title: "B", items: ["Row 3", "Row 8"] }]));
  assert.deepEqual([overlap.parts[0].numbering, overlap.parts[0].total_rows], ["straight", 4], "overlapping numbers are not a run");
});
await test("C: a part never crosses a section or a change of word; D: names are the section's without its number, else “Body”, never a task title", () => {
  const p = plan(small([
    { key: "a", section: "a", title: "Brim: rows 1–2", items: ["Row 1", "Row 2"] },
    { key: "b", section: "a", title: "Crown", items: ["Rnd 3", "Rnd 4"] },
    { key: "c", section: "b", title: "Ear flap", items: ["Row 1"] },
    { key: "d", section: null, title: "Loose task", items: ["Row 1"] },
  ], [{ key: "a", name: "1. Hat" }, { key: "b", name: "2) Ear flaps" }]));
  assert.deepEqual(p.parts.map((x) => [x.name, x.row_word, x.total_rows]), [["Hat", "row", 2], ["Hat 2", "round", 4], ["Ear flaps", "row", 1], ["Body", "row", 1]]);
  assert.equal(setup.partNameFromSection("12. Sleeves"), "Sleeves");
  // FR1 N3: only a leading list number "N. " / "N) " goes; years, decimals and anything else stay.
  assert.equal(setup.partNameFromSection("2026 plan"), "2026 plan");
  assert.equal(setup.partNameFromSection("1.5 Body"), "1.5 Body");
  assert.equal(setup.partNameFromSection("3.Sleeves"), "3.Sleeves");
  assert.equal(setup.partNameFromSection("10) Collar"), "Collar");
  assert.equal(setup.partNameFromSection("3."), "3.");
  assert.equal(setup.partNameFromSection("  "), "Body");
  assert.equal(setup.partNameFromSection(null), "Body");
});
await test("Reset mode plans as if the project weren't on the screen: no “already on the craft screen” or “already linked” STOP", () => {
  const snap = snapshotOf(oneRowScarf(), { onCraftScreen: true });
  snap.items[3].craft_part_id = "old-part";
  assert.equal(planCraftSetup(snap).ok, false);
  assert.match(planCraftSetup(snap).stops[0], /already on the craft screen\. Use Reset craft screen there/);
  const r = planCraftSetup(snap, { reset: true });
  assert.equal(r.ok, true, r.stops.join("; "));
  assert.equal(r.parts[0].total_rows, 385);
});
await test("Payload: units ride with the plan; craftSetupPayload never sends a count the plan didn't make", () => {
  const p = plan(oneRowScarf());
  const payload = setup.craftSetupPayload(p, "knit", ["Scarf"]);
  assert.equal(payload.units.length, 386);
  assert.deepEqual(Object.keys(payload.units[0]).sort(), ["item_id", "unit_count", "work_type"]);
  const stopped = planCraftSetup({ ...snapshotOf(oneRowScarf()), on_craft_screen: true });
  assert.deepEqual(stopped.stitch_fills, [], "a stopped plan fills nothing");
});

// ── B: Reset words ─────────────────────────────────────────────────────
await test("Reset words: carry counts, every piece that can't be matched and what happens to it, the blockers, the body", () => {
  const rows = [
    { kind: "sitting", id: "s1", old_part_id: "p", new_part: 0, from_row: 0, to_row: 3, at_row: null },
    { kind: "sitting", id: "s2", old_part_id: "p", new_part: null, from_row: null, to_row: null, at_row: null, date: "2026-11-03", old_from_row: 4, old_to_row: 9 },
    { kind: "note", id: "n1", old_part_id: "p", new_part: 0, at_row: 2 },
    { kind: "frog", id: "f1", old_part_id: "p", new_part: null, old_to_row: 12 },
    { kind: "timer", id: null, old_part_id: "p", new_part: 0, at_row: 4 },
  ];
  const carry = reset.resetCarry(rows, [{ id: "p", name: "Scarf", row_word: "row", total_rows: 385, row_count: 0 }]);
  assert.deepEqual(carry.carried, { sitting: 1, note: 1, frog: 0, instruction: 0, timer: 1, link: 0, yarn: 0 });
  assert.deepEqual(reset.resetCarryLines(carry), [
    "Moves with its rows: 1 sitting, 1 note and 1 timer.",
    "Can’t be matched to a row (1 sitting); each keeps its minutes and rows ticked, but no longer names a part on the craft screen: Nov 3 on Scarf, rows 5–9.",
    "Can’t be matched to a row (1 rip-back); each is removed from the rip-back history (the sittings it left out stay left out): Ripped back on Scarf to row 12.",
  ]);
  assert.deepEqual(reset.resetCarryLines(reset.resetCarry([], [])), ["No sittings, notes or rip-backs to move."]);
  assert.equal(reset.resetBlockerStop(["quarters", "ridges"]), "This project has quarter rows and ridge counts that a reset can’t make again, so it can’t be reset.");
  assert.deepEqual(reset.parseResetBody({ fingerprint: "a".repeat(64), names: [" Scarf "] }, 1), { ok: true, value: { fingerprint: "a".repeat(64), names: ["Scarf"] } });
  for (const [body, error] of [[{ fingerprint: "a".repeat(64), names: ["x"], craft: "knit" }, /Unknown field: craft/], [{ fingerprint: "x", names: ["x"] }, /fingerprint/], [{ fingerprint: "a".repeat(64), names: [] }, /one name per part/]]) {
    const r = reset.parseResetBody(body, 1); assert.equal(r.ok, false); assert.match(r.error, error);
  }
  assert.equal(craftResetFingerprint("a", "b"), craftResetFingerprint("a", "b"));
  assert.notEqual(craftResetFingerprint("a", "b"), craftResetFingerprint("a", "c"));
  assert.equal(reset.craftResetHref("x"), "/craft/setup/x?reset=1");
});

// ── E, G: checklist inputs ─────────────────────────────────────────────
await test("G: initial_checklist takes strings and { text, unit_count?, work_type? }; bad rows are a 400 naming the row; blanks dropped as before", () => {
  assert.deepEqual(input.parseInitialChecklist(["Cast on 30", " ", { text: "Row 1 · k → 30", unit_count: 30, work_type: "one-row" }]), { ok: true, rows: [
    { text: "Cast on 30", unit_count: null, work_type: null }, { text: "Row 1 · k → 30", unit_count: 30, work_type: "one-row" }] });
  assert.deepEqual(input.parseInitialChecklist(undefined), { ok: true, rows: [] });
  for (const [value, error] of [["x", /must be a list/], [[{ text: "" }], /initial_checklist\[0\]: text/], [[{ text: "a", unit_count: -1 }], /unit_count/], [[{ text: "a", work_type: "Bad Type" }], /lowercase slug/], [[{ text: "a", is_done: true }], /unknown field is_done/], [[5], /each row must be/]]) {
    const r = input.parseInitialChecklist(value); assert.equal(r.ok, false, JSON.stringify(value)); assert.match(r.error, error);
  }
});
await test("E: the checklist POST batch: rows, after_item_id or at_start (not both), 1–500 rows", () => {
  const after = "00000000-0000-4000-8000-00000000000A";
  assert.deepEqual(input.parseChecklistAdd({ items: ["Row 29 · k", { text: "Check: 30", is_done: true }], after_item_id: after }),
    { ok: true, rows: [{ text: "Row 29 · k", unit_count: null, work_type: null }, { text: "Check: 30", unit_count: null, work_type: null, is_done: true }], after_item_id: after.toLowerCase(), at_start: false });
  for (const [body, error] of [[{ items: [] }, /1 to 500/], [{ items: ["a"], after_item_id: "x" }, /UUID/], [{ items: ["a"], after_item_id: after, at_start: true }, /not both/], [{ items: ["a"], extra: 1 }, /Unknown field/]]) {
    const r = input.parseChecklistAdd(body); assert.equal(r.ok, false); assert.match(r.error, error);
  }
  assert.equal(input.taskDeleteRefusalText(3, 1), "This task has 3 ticked craft rows and 1 sitting. Deleting it loses them from the craft screen and the pace numbers. Delete it anyway only if you mean to (force).");
});

// ── Routes over a fake client ───────────────────────────────────────────
const UID = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-0000000000bb";
function fakeClient({ rpc = () => ({ data: null, error: null }), tables = {} } = {}) {
  const calls = { rpc: [], from: [] };
  return { calls,
    rpc(name, args) { calls.rpc.push([name, args]); return Promise.resolve(rpc(name, args)); },
    from(table) {
      calls.from.push(table);
      const conds = [];
      const rows = () => (tables[table] ?? []).filter((r) => conds.every((c) => c(r)));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, filter() { return q; },
        eq(col, val) { conds.push((r) => r[col] === val); return q; }, in(col, vals) { conds.push((r) => vals.includes(r[col])); return q; },
        range(from, to) { return Promise.resolve({ data: rows().slice(from, to + 1), error: null }); },
        single() { const f = rows(); return Promise.resolve(f.length === 1 ? { data: f[0], error: null } : { data: null, error: { code: "PGRST116", message: "none" } }); },
        maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
        insert() { throw new Error(`insert into ${table} not expected`); }, delete() { throw new Error(`delete on ${table} not expected`); },
      };
      return q;
    } };
}
const req = (db, url, method = "GET", body) => {
  const r = new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: db, userId: UID, user: { id: UID }, authSource: "session" });
  return r;
};
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

await test("A: DELETE /api/tasks/[id] is one delete_task_checked call; a refusal is 409 craft_history with counts; ?force=true passes through; busy 409; missing 404", async () => {
  const refuse = fakeClient({ rpc: () => ({ data: { status: "refused", ticked_craft_rows: 12, sittings: 2 }, error: null }) });
  const res = await taskRoute.DELETE(req(refuse, `/api/tasks/${TASK}`, "DELETE"), { params: Promise.resolve({ id: TASK }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: input.taskDeleteRefusalText(12, 2), reason: "craft_history", ticked_craft_rows: 12, sittings: 2 });
  assert.deepEqual(refuse.calls.rpc, [["delete_task_checked", { p_user_id: UID, p_task_id: TASK, p_force: false }]]);
  assert.deepEqual(refuse.calls.from, [], "no read-then-delete: the function checks under the task's lock");
  const forced = fakeClient({ rpc: () => ({ data: { status: "deleted" }, error: null }) });
  const ok = await taskRoute.DELETE(req(forced, `/api/tasks/${TASK}?force=true`, "DELETE"), { params: Promise.resolve({ id: TASK }) });
  assert.equal(ok.status, 200);
  assert.equal(forced.calls.rpc[0][1].p_force, true);
  assert.equal((await taskRoute.DELETE(req(forced, `/api/tasks/${TASK}?force=yes`, "DELETE"), { params: Promise.resolve({ id: TASK }) })).status, 400);
  const gone = fakeClient({ rpc: () => ({ data: { status: "not_found" }, error: null }) });
  assert.equal((await taskRoute.DELETE(req(gone, `/api/tasks/${TASK}`, "DELETE"), { params: Promise.resolve({ id: TASK }) })).status, 404);
  const busy = fakeClient({ rpc: () => ({ data: null, error: { code: "55P03", message: "lock" } }) });
  assert.equal((await taskRoute.DELETE(req(busy, `/api/tasks/${TASK}`, "DELETE"), { params: Promise.resolve({ id: TASK }) })).status, 409);
  assert.equal((await taskRoute.DELETE(req(busy, "/api/tasks/nope", "DELETE"), { params: Promise.resolve({ id: "nope" }) })).status, 404);
});
await test("E: POST /api/tasks/[id]/checklist with items is one checklist_insert_items call; refusals map to 400/404/409", async () => {
  const db = fakeClient({ rpc: () => ({ data: [{ id: "new" }], error: null }) });
  const after = "00000000-0000-4000-8000-0000000000cc";
  const res = await checklistRoute.POST(req(db, `/api/tasks/${TASK}/checklist`, "POST", { items: [{ text: "Row 29 · k", unit_count: 30 }], after_item_id: after }), { params: Promise.resolve({ id: TASK }) });
  assert.equal(res.status, 201);
  assert.deepEqual(db.calls.rpc, [["checklist_insert_items", { p_user_id: UID, p_task_id: TASK, p_items: [{ text: "Row 29 · k", unit_count: 30, work_type: null }], p_after_item_id: after, p_at_start: false }]]);
  for (const [code, message, status] of [["P0002", "that item is not on this task", 404], ["P0002", "task not found", 404], ["22023", "x", 400], ["55P03", "x", 409]]) {
    const r = await checklistRoute.POST(req(fakeClient({ rpc: () => ({ data: null, error: { code, message } }) }), `/api/tasks/${TASK}/checklist`, "POST", { items: ["Row 1"] }), { params: Promise.resolve({ id: TASK }) });
    assert.equal(r.status, status, `${code} ${message}`);
  }
  assert.equal((await checklistRoute.POST(req(db, `/api/tasks/${TASK}/checklist`, "POST", { items: [] }), { params: Promise.resolve({ id: TASK }) })).status, 400);
});
await test("G: POST /api/tasks refuses a bad initial_checklist row before the task is made", async () => {
  const db = fakeClient();
  const res = await tasksRoute.POST(req(db, "/api/tasks", "POST", { title: "Scarf rows", initial_checklist: ["Row 1", { text: "Row 2", unit_count: "thirty" }] }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /initial_checklist\[1\]: unit_count/);
  assert.deepEqual(db.calls.from.filter((t) => t === "tasks"), [], "nothing was written");
});
await test("B: GET /api/craft/[id]/reset: the plan (reset mode), 075's fingerprint and carry list; a moved row between the two reads is read again, then busy", async () => {
  const snap = snapshotOf(oneRowScarf(), { projectId: "00000000-0000-4000-8000-0000000000aa", onCraftScreen: true });
  const tables = {
    projects: [{ ...snap.project, user_id: UID }], craft_projects: [{ project_id: snap.project.id, user_id: UID }],
    project_sections: snap.sections.map((s) => ({ ...s, user_id: UID, project_id: snap.project.id })),
    tasks: snap.tasks.map((t) => ({ ...t, user_id: UID, project_id: snap.project.id })),
    task_checklist_items: snap.items.map((i) => ({ ...i, user_id: UID })),
  };
  const setupFp = craftSetupFingerprint(snap);
  const reply = (fp) => ({ data: { on_craft_screen: true, setup_fingerprint: fp, state_fingerprint: "s", fingerprint: "f".repeat(64), blockers: [], old_parts: [{ id: "old", name: "Body", row_word: "row", total_rows: 519, row_count: 0 }],
    carry: [{ kind: "sitting", id: "s1", old_part_id: "old", new_part: null, date: "2026-11-01", old_from_row: 0, old_to_row: 3 }] }, error: null });
  const db = fakeClient({ tables, rpc: () => reply(setupFp) });
  const res = await resetRoute.GET(req(db, `/api/craft/${snap.project.id}/reset`), { params: Promise.resolve({ projectId: snap.project.id }) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.fingerprint, "f".repeat(64));
  assert.deepEqual([body.plan.ok, body.plan.parts.length, body.plan.parts[0].total_rows], [true, 1, 385]);
  assert.match(body.carry_lines[1], /^Can’t be matched to a row \(1 sitting\)/);
  assert.deepEqual(db.calls.rpc, [["craft_reset_preview", { p_user_id: UID, p_project_id: snap.project.id }]]);
  const moving = fakeClient({ tables, rpc: () => reply("0".repeat(64)) });
  const busy = await resetRoute.GET(req(moving, `/api/craft/${snap.project.id}/reset`), { params: Promise.resolve({ projectId: snap.project.id }) });
  assert.deepEqual([busy.status, (await busy.json()).reason, moving.calls.rpc.length], [409, "busy", 2]);
  const blocked = fakeClient({ tables, rpc: () => ({ data: { ...reply(setupFp).data, blockers: ["quarters"] }, error: null }) });
  const b = await (await resetRoute.GET(req(blocked, `/api/craft/${snap.project.id}/reset`), { params: Promise.resolve({ projectId: snap.project.id }) })).json();
  assert.deepEqual([b.plan.ok, b.plan.stops[0], b.plan.stitch_fills.length], [false, reset.resetBlockerStop(["quarters"]), 0]);
  // POST: one craft_reset_project call with the plan (no craft kind) and its stitch counts; 075's refusals in plain words.
  const commit = fakeClient({ tables, rpc: (name) => (name === "craft_reset_preview" ? reply(setupFp) : { data: { parts: 1 }, error: null }) });
  const ok = await resetRoute.POST(req(commit, `/api/craft/${snap.project.id}/reset`, "POST", { fingerprint: "f".repeat(64), names: ["Scarf"] }), { params: Promise.resolve({ projectId: snap.project.id }) });
  assert.equal(ok.status, 200);
  const [name, args] = commit.calls.rpc.at(-1);
  assert.equal(name, "craft_reset_project");
  assert.deepEqual(Object.keys(args.p_plan).sort(), ["active_part_index", "parts", "units"]);
  assert.equal(args.p_plan.units.length, 386);
  assert.equal(args.p_fingerprint, "f".repeat(64));
  for (const [code, status, why] of [["MC072", 409, "changed"], ["MC75K", 409, "keeps"], ["P0002", 409, "not_on_screen"], ["22023", 400, "invalid"], ["55P03", 409, "busy"], ["40P01", 409, "busy"], ["XX000", 500, undefined]]) {
    const db2 = fakeClient({ tables, rpc: (n) => (n === "craft_reset_preview" ? reply(setupFp) : { data: null, error: { code, message: "x", details: "quarters" } }) });
    const r = await quiet(() => resetRoute.POST(req(db2, `/api/craft/${snap.project.id}/reset`, "POST", { fingerprint: "f".repeat(64), names: ["Scarf"] }), { params: Promise.resolve({ projectId: snap.project.id }) }));
    assert.equal(r.status, status, code);
    if (why) assert.equal((await r.json()).reason, why, code);
  }
  const stale = await resetRoute.POST(req(commit, `/api/craft/${snap.project.id}/reset`, "POST", { fingerprint: "e".repeat(64), names: ["Scarf"] }), { params: Promise.resolve({ projectId: snap.project.id }) });
  assert.deepEqual([stale.status, (await stale.json()).reason], [409, "changed"]);
  const notOn = fakeClient({ tables: { ...tables, craft_projects: [] } });
  assert.equal((await resetRoute.GET(req(notOn, `/api/craft/${snap.project.id}/reset`), { params: Promise.resolve({ projectId: snap.project.id }) })).status, 409);
});

// ── MCP tools through the real /api/mcp handler ──────────────────────────
async function mcpRpc(body) {
  const request = new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    "x-mission-control-key": LEGACY_KEY, "mcp-session-id": "stateless", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(body) });
  const text = await (await mcpRoute.POST(request)).text();
  return JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "" : text);
}
async function callTool(name, args) {
  mcpCalls.length = 0;
  const result = await mcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  if (result.error) throw new Error(JSON.stringify(result.error));
  return { isError: result.result.isError === true, data: JSON.parse(result.result.content[0].text).data, calls: [...mcpCalls] };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
await mcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s4-test", version: "1" } } });

await test("MCP: craft_setup / craft_reset exist with preview + commit; delete_task takes force; update_task_checklist edits text and position and adds/deletes rows; plain descriptions", async () => {
  const tools = new Map((await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(tools.get("craft_setup").inputSchema.properties).sort(), ["action", "craft", "fingerprint", "names", "project_id"]);
  assert.deepEqual(Object.keys(tools.get("craft_reset").inputSchema.properties).sort(), ["action", "fingerprint", "names", "project_id"]);
  assert.deepEqual(tools.get("craft_reset").inputSchema.properties.action.enum, ["preview", "commit"]);
  assert.ok(tools.get("delete_task").inputSchema.properties.force);
  assert.deepEqual(Object.keys(tools.get("update_task_checklist").inputSchema.properties).sort(), ["add", "after_item_id", "at_start", "delete_item_ids", "items", "task_id"]);
  assert.deepEqual(Object.keys(tools.get("update_task_checklist").inputSchema.properties.items.items.properties).sort(), ["id", "is_done", "sort_order", "text", "unit_count", "work_type"]);
  assert.ok(tools.get("create_task").inputSchema.properties.initial_checklist.items.anyOf);
  for (const name of ["craft_setup", "craft_reset", "delete_task", "update_task_checklist"]) assert.doesNotMatch(tools.get(name).description, /claude|anthropic/i, name);
});
await test("MCP craft_reset: preview is a GET of the reset route (slimmed plan, carry lines); commit sends the preview's names and the given fingerprint", async () => {
  const preview = { fingerprint: "f".repeat(64), plan: { ok: true, stops: [], parts: [{ name: "Scarf", rows: [{ item_id: "x", row: 1 }], segments: [{ task_id: "t", name: "Rows", from_row: 1, to_row: 1, sort_order: 0, row_count: 1 }] }], plain_items: [], stitch_fills: [{}, {}] },
    old_parts: [], carry: { carried: {}, lost: [{ kind: "sitting", text: "Nov 3" }] }, carry_lines: ["Moves with its rows: 2 sittings."] };
  mcpResponder = (call) => (call.method === "GET" ? json(preview) : json({ parts: 1 }));
  const p = await callTool("craft_reset", { project_id: "proj", action: "preview" });
  assert.equal(p.isError, false);
  assert.deepEqual(p.calls.map((c) => [c.method, new URL(c.url).pathname]), [["GET", "/api/craft/proj/reset"]]);
  assert.equal(p.data.plan.parts[0].rows, undefined, "row lists stay out of the reply");
  assert.deepEqual([p.data.carry, p.data.cannot_carry, p.data.plan.stitch_fills], [["Moves with its rows: 2 sittings."], [{ kind: "sitting", text: "Nov 3" }], 2]);
  const c = await callTool("craft_reset", { project_id: "proj", action: "commit", fingerprint: "f".repeat(64) });
  assert.deepEqual(c.calls.map((x) => [x.method, new URL(x.url).pathname]), [["GET", "/api/craft/proj/reset"], ["POST", "/api/craft/proj/reset"]]);
  assert.deepEqual(c.calls[1].body, { fingerprint: "f".repeat(64), names: ["Scarf"] });
  assert.equal((await callTool("craft_reset", { project_id: "proj", action: "commit" })).isError, true, "no fingerprint, no commit");
  mcpResponder = (call) => (call.method === "GET" ? json({ ...preview, plan: { ...preview.plan, default_craft: "knit" } }) : json({ error: "Something changed since the preview. Open it again.", reason: "changed" }, 409));
  const s = await callTool("craft_setup", { project_id: "proj", action: "commit", fingerprint: "a".repeat(64), names: ["Left"] });
  assert.equal(s.isError, true);
  assert.deepEqual(s.calls.map((x) => [x.method, new URL(x.url).pathname]), [["GET", "/api/craft/setup/proj"], ["POST", "/api/craft/setup/proj"]]);
  assert.deepEqual(s.calls[1].body, { fingerprint: "a".repeat(64), craft: "knit", names: ["Left"] });
});
await test("MCP update_task_checklist: edits (text, sort_order) PATCH, adds POST once with after_item_id, deletes one DELETE each; edits alone keep the old reply", async () => {
  mcpResponder = (call) => (call.method === "PATCH" ? json([{ id: "a" }]) : call.method === "POST" ? json([{ id: "n" }], 201) : json({ success: true }));
  const r = await callTool("update_task_checklist", { task_id: "t1", items: [{ id: "a", text: "Row 5 · k2tog → 29", sort_order: 7 }], add: [{ text: "Row 6 · k → 29", unit_count: 29 }], after_item_id: "a", delete_item_ids: ["d1", "d2"] });
  assert.equal(r.isError, false);
  assert.deepEqual(r.calls.map((c) => [c.method, new URL(c.url).pathname + new URL(c.url).search]), [
    ["PATCH", "/api/tasks/t1/checklist"], ["POST", "/api/tasks/t1/checklist"], ["DELETE", "/api/tasks/t1/checklist?itemId=d1"], ["DELETE", "/api/tasks/t1/checklist?itemId=d2"]]);
  assert.deepEqual(r.calls[0].body, { items: [{ id: "a", text: "Row 5 · k2tog → 29", sort_order: 7 }] });
  assert.deepEqual(r.calls[1].body, { items: [{ text: "Row 6 · k → 29", unit_count: 29 }], after_item_id: "a" });
  assert.deepEqual(r.data, { updated: [{ id: "a" }], added: [{ id: "n" }], deleted: ["d1", "d2"] });
  const only = await callTool("update_task_checklist", { task_id: "t1", items: [{ id: "a", is_done: true }] });
  assert.deepEqual(only.data, [{ id: "a" }]);
  mcpResponder = (call) => (call.method === "DELETE" ? json({ error: "The craft screen was busy and nothing was deleted. Try again in a moment.", reason: "busy" }, 409) : json([]));
  const busy = await callTool("update_task_checklist", { task_id: "t1", delete_item_ids: ["d1"] });
  assert.deepEqual([busy.isError, busy.data.not_deleted[0].id], [true, "d1"]);
  assert.equal((await callTool("update_task_checklist", { task_id: "t1" })).isError, true);
  mcpResponder = () => json({ error: input.taskDeleteRefusalText(1, 0), reason: "craft_history" }, 409);
  const d = await callTool("delete_task", { task_id: "t1" });
  assert.deepEqual([d.isError, new URL(d.calls[0].url).search], [true, ""]);
  mcpResponder = () => json({ success: true });
  assert.equal(new URL((await callTool("delete_task", { task_id: "t1", force: true })).calls[0].url).search, "?force=true");
});

// ── Screens ─────────────────────────────────────────────────────────────
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const { CraftSetupScreen, stitchFacts, sendReset } = await import("../src/components/craft/CraftSetupScreen.tsx");
const { CraftScreenMenu, hiddenPartsText } = await import("../src/components/craft/CraftScreenMenu.tsx");
const { CraftScreen } = await import("../src/components/craft/CraftScreen.tsx");
await test("Screens: the setup preview shows each part's stitch counts, the straight-through note and skipped tasks; no vendor names", () => {
  const desc = sophieHood(); desc.tasks.find((t) => t.key === "right").unit_count = 1389;
  const snap = snapshotOf(desc), p = planCraftSetup(snap);
  const html = renderToStaticMarkup(createElement(CraftSetupScreen, { projectId: "p", plan: p, fingerprint: "f" }));
  assert.match(html, /Stitch counts: fills 318 rows and 1 cast-on · 3,389 stitches in all/);
  assert.match(html, /The row numbers start again inside this part, so the screen counts its rows straight through, 1 to 318\./);
  assert.match(html, /Stitch counts not filled on “Hood · Right side straight: rows 1–33 \(42 sts\)”: Its rows add up to 1,386 stitches but the task says 1,389/);
  assert.match(html, /One task keeps its rows without stitch counts/);
  assert.match(html, /Create 3 parts on the craft screen/);
  assert.doesNotMatch(html, /Claude|Anthropic|OpenAI|ChatGPT/);
  assert.equal(stitchFacts({ ...p.parts[0], stitches: { rows_filled: 0, cast_ons_filled: 0, total_stitches: 0, skipped: [] } }), "Stitch counts: nothing to fill · 0 stitches in all");
});
await test("Screens: Reset preview lists the old parts and what moves, and Reset waits for a confirm; the menu has Reset craft screen…", async () => {
  const p = planCraftSetup(snapshotOf(oneRowScarf()), { reset: true });
  const carry = reset.resetCarry([{ kind: "sitting", id: "s", old_part_id: "o", new_part: null, date: "2026-11-01", old_from_row: 0, old_to_row: 4 }], [{ id: "o", name: "Body", row_word: "row", total_rows: 519, row_count: 0 }]);
  const html = renderToStaticMarkup(createElement(CraftSetupScreen, { projectId: "p", plan: p, fingerprint: "f", reset: { old_parts: [{ id: "o", name: "Body", row_word: "row", total_rows: 519, row_count: 0 }], carry, carry_lines: reset.resetCarryLines(carry), blockers: [] } }));
  assert.match(html, /<h1>Reset craft screen<\/h1>/);
  assert.match(html, /Preview · nothing changes until Reset/);
  assert.match(html, /<li><span>Body<\/span><small>empty \(its rows were deleted\)<\/small><\/li>/);
  assert.match(html, /Can’t be matched to a row \(1 sitting\)/);
  assert.match(html, /Your ticks, stitch counts and sittings stay on the rows\./);
  assert.match(html, />Reset to 1 part…<\/button>/);
  assert.doesNotMatch(html, /name="craft-kind"/, "Reset keeps the craft kind");
  assert.doesNotMatch(html, /Resetting…/, "the confirm sheet is closed until asked");
  const menu = renderToStaticMarkup(createElement(CraftScreenMenu, { projectId: "p1", projectName: "Scarf", canRemove: false, partCount: 1, blockers: [] }));
  assert.match(menu, /<a class="craft-menu-item" href="\/craft\/setup\/p1\?reset=1">Reset craft screen…<\/a>/);
  assert.equal(hiddenPartsText(1), "One part has no rows left (they were deleted from the checklist), so it is hidden. Use Reset craft screen in the ⋯ menu to set the screen up again from the checklists.");
  let call; await sendReset("p9", { fingerprint: "f", names: ["A"] }, async (url, init) => { call = [url, init.method, JSON.parse(init.body)]; return new Response("{}"); });
  assert.deepEqual(call, ["/api/craft/p9/reset", "POST", { fingerprint: "f", names: ["A"] }]);
  assert.deepEqual(await sendReset("p", {}, async () => new Response(JSON.stringify({ error: "x", reason: "changed" }), { status: 409 })), { ok: false, changed: true, message: "x" });
});
await test("A (pick 3): an empty part (rows deleted, sittings kept) is hidden on the screen with a plain line; the others show", () => {
  const view = buildCraftView({ project: { id: "p", name: "Scarf" }, craft_project: { craft: "knit", gear: null, active_part_id: "old" },
    parts: [{ id: "old", name: "Old", total_rows: 519, row_word: "row", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: 30 },
      { id: "new", name: "Scarf", total_rows: 2, row_word: "row", sort_order: 1, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: 30 }],
    items: [1, 2].map((n) => ({ id: `r${n}`, craft_part_id: "new", craft_row: n, text: `Row ${n}`, is_done: false, completed_at: null })),
    segments: [], sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-20T00:00:00Z" });
  assert.deepEqual([view.parts.map((x) => x.name), view.hidden_parts, view.active_part.name], [["Scarf"], 1, "Scarf"]);
  const html = renderToStaticMarkup(createElement(CraftScreen, { view: { ...view, projects: [] } }));
  assert.match(html, /One part has no rows left/);
});

// ── 075's text ─────────────────────────────────────────────────────────
await test("075: one migration with its rollback; the lock order is written down; the heal never waits; no hosted-project steps", () => {
  const up = readFileSync(new URL("../supabase/migrations/075_craft_reset.sql", import.meta.url), "utf8");
  const down = readFileSync(new URL("../supabase/rollbacks/075_craft_reset.down.sql", import.meta.url), "utf8");
  assert.match(up, /^-- Craft S4/);
  assert.match(up, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(up, /FOR NO KEY UPDATE NOWAIT;[\s\S]*FOR UPDATE NOWAIT;/, "the heal takes the craft project, then the parts, never waiting");
  assert.match(up, /AFTER DELETE ON task_checklist_items\s+REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT/);
  assert.match(up, /'craft-setup-v2\|'/);
  for (const fn of ["craft_plan_core", "craft_apply_units", "craft_reset_preview", "craft_reset_project", "delete_task_checked", "checklist_insert_items"]) {
    assert.match(up, new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\(`), fn);
    assert.match(up, new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\([^)]*\\) FROM PUBLIC, anon;`), fn);
    assert.match(down, new RegExp(`DROP FUNCTION ${fn}\\(`), fn);
  }
  // The rollback puts back 072's fingerprint and 073's plan and project bodies exactly.
  const body = (src, head) => { const i = src.indexOf(head), j = src.indexOf("AS $$", i); return src.slice(i, src.indexOf("\n$$;", j) + 4); };
  const s72 = readFileSync(new URL("../supabase/migrations/072_craft_setup.sql", import.meta.url), "utf8");
  const s73 = readFileSync(new URL("../supabase/migrations/073_craft_rpcs.sql", import.meta.url), "utf8");
  assert.ok(down.includes(body(s72, "CREATE FUNCTION craft_setup_fingerprint(").replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")));
  assert.ok(down.includes(body(s73, "CREATE OR REPLACE FUNCTION craft_setup_plan(")));
  assert.ok(down.includes(body(s73, "CREATE OR REPLACE FUNCTION craft_setup_project(")));
  assert.doesNotMatch(up + down, /supabase db push|--linked/);
});

console.log(`\nCraft S4: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
