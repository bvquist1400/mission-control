// Fake craft inputs shared by the craft tests: the S1A scarf and blanket shapes (no gaps).
export const part = (id, total_rows, extra = {}) => ({ id, name: id, total_rows, row_word: "row", sort_order: 0, quarters: false, quarter: 0, quarter_row: null, ridges: false, stitch_count: null, ...extra });
export const rows = (id, total, done) => Array.from({ length: total }, (_, i) => ({ id: `${id}-${i + 1}`, craft_part_id: id, craft_row: i + 1, text: `Row ${i + 1}`, is_done: i < done, completed_at: i < done ? "2026-11-07T18:00:00Z" : null }));
export const input = (parts = [], items = []) => ({ project: { id: "project", name: "Sample" }, craft_project: { craft: "knit", gear: "5 mm needles", active_part_id: null }, parts, items, segments: [], sessions: [], session_items: [], sitting_details: [], timer: null, server_now: "2026-11-08T18:00:00Z" });
export function scarfInput() {
  const scarf = input([part("Body", 519, { quarters: true, ridges: true, stitch_count: 30 })], rows("Body", 519, 118));
  scarf.segments = Array.from({ length: 6 }, (_, i) => ({ id: `chunk-${i}`, part_id: "Body", task_id: `task-${i}`, name: `Rows ${i * 100 + 1}–${Math.min(519, (i + 1) * 100)}`, from_row: i * 100 + 1, to_row: Math.min(519, (i + 1) * 100), sort_order: i, close_check: false }));
  return scarf;
}
export const bands = [["Foundation", 1, 1], ["Waffle 1", 2, 18], ["Tree 1", 19, 37], ["Waffle 2", 38, 52], ["Tree 2", 53, 71], ["Waffle 3", 72, 86], ["Tree 3", 87, 105], ["Waffle 4", 106, 120], ["Tree 4", 121, 139], ["Waffle 5", 140, 156], ["Final sc row", 157, 157]];
export function blanketInput() {
  const blanket = input([part("Blanket", 157, { stitch_count: 195 }), part("Border", 2, { sort_order: 1, row_word: "round" })], [...rows("Blanket", 157, 58), ...rows("Border", 2, 0).map((row) => ({ ...row, text: `Round ${row.craft_row}` }))]);
  blanket.craft_project.craft = "crochet";
  blanket.segments = bands.map(([name, from_row, to_row], i) => ({ id: `band-${i}`, part_id: "Blanket", task_id: `task-${i}`, name, from_row, to_row, sort_order: i, close_check: true }));
  return blanket;
}
/** The S1A screens pinned by the before/after render test (names are stable keys). */
export function pinnedInputs() {
  const scarf = scarfInput(), blanket = blanketInput();
  const chartBlanket = structuredClone(blanket);
  chartBlanket.items.forEach((row) => { if (row.craft_part_id === "Blanket") row.text = `Chart row ${row.craft_row}: ivory waffle as set; olive 3 sts per tree (trunk).`; });
  const border = structuredClone(blanket); border.craft_project.active_part_id = "Border";
  const quarter = structuredClone(scarf); Object.assign(quarter.parts[0], { quarter: 2, quarter_row: 119 });
  const finished = structuredClone(scarf); finished.items.forEach((row) => { row.is_done = true; }); finished.craft_project.active_part_id = "Body";
  const allDone = structuredClone(scarf); allDone.items.forEach((row) => { row.is_done = true; });
  return { scarf, blanket, chartBlanket, border, quarter, finished, allDone, empty: input() };
}
