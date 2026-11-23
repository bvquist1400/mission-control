// Craft estimates E1 (Baseline b3d45d2e, plan baseline-plans/craft-estimates/PLAN.md): the honest forecast.
// Pure, no database:
//   1. pace.ts: the days the 14-day average divides by (the Aug 2027 fix), sittings with rows, 3 on 3 days,
//      Behind so far, a finish more than a month late.
//   2. src/lib/craft/estimate.ts: every rule in the plan's table and its "Other cases".
//
//   npm run test:craft-estimate
//
// PACE_MODULE=<path> runs part 1 against another copy of pace.ts (the fail-before run used the base commit's).

import assert from "node:assert/strict";

const pace = await import(process.env.PACE_MODULE ?? "../src/lib/pace.ts");
const { computeForecast } = pace;
const onlyPace = Boolean(process.env.PACE_MODULE);
const estimateModule = onlyPace ? null : await import("../src/lib/craft/estimate.ts");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const etest = (name, fn) => (onlyPace ? undefined : test(name, fn));

// ── Builders ────────────────────────────────────────────────────────────────

let seq = 0;
function session(extra) {
  seq += 1;
  return {
    id: `s${String(seq).padStart(3, "0")}`, task_id: null, session_date: "2026-11-22", minutes: 10, exclude_from_stats: false,
    item_ids: [], in_progress_item_ids: [], extra_units: null, extra_work_type: null, ...extra,
  };
}

/**
 * A craft project: parts (each a task whose estimate sets the plan speed), one checklist row per craft row.
 * `stitches(row)` gives each row's units (null = no stitch counts). `done` maps "part:row" → completed_at.
 */
function craft({
  today = "2026-11-22", target = "2026-12-18", unit = "stitches", parts = [{ id: "p1", name: "Scarf", rows: 385, stitches: () => 30, planSec: 9.95 }],
  done = {}, sessions = [], finishingMinutes = 83, activePart = null, sections = [],
} = {}) {
  const tasks = [], items = [], rows = [], estimateParts = [];
  parts.forEach((part, index) => {
    let units = 0;
    for (let row = 1; row <= part.rows; row += 1) {
      const stitches = part.stitches(row);
      const key = `${part.id}:${row}`;
      const completed = done[key] ?? null;
      items.push({ id: key, task_id: `t-${part.id}`, is_done: Boolean(completed), unit_count: stitches, work_type: part.type ?? "knit" });
      rows.push({ item_id: key, part_id: part.id, row, is_done: Boolean(completed), completed_at: completed === true ? null : completed });
      units += stitches ?? 0;
    }
    tasks.push({
      id: `t-${part.id}`, status: "In Progress", estimated_minutes: part.planSec ? Math.round((units * part.planSec) / 60) : 0,
      unit_count: null, work_type: part.type ?? "knit", is_sample: false, section_id: null,
    });
    estimateParts.push({ id: part.id, name: part.name, sort_order: index, row_word: part.word ?? "row", total_rows: part.rows });
  });
  if (finishingMinutes > 0) tasks.push({ id: "t-finish", status: "Planned", estimated_minutes: finishingMinutes, unit_count: null, work_type: null, is_sample: false, section_id: null });
  return {
    pace: { project: { unit_label: unit, target_date: target, pace_settings: null }, sections, tasks, items, sessions, today, otherProjectRates: [] },
    parts: estimateParts, rows, active_part_id: activePart ?? estimateParts[0]?.id ?? null,
  };
}
/** "Done" rows a..b of a part on a day: completed_at at 8 PM ET that day. */
function ticks(partId, from, to, day) {
  const out = {};
  for (let row = from; row <= to; row += 1) out[`${partId}:${row}`] = `${day}T${"01:00:00.000Z"}`.replace(day, nextDay(day));
  return out;
}
function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const rowIds = (partId, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${partId}:${from + i}`);
const est = (input) => estimateModule.buildCraftEstimate(input);
/** Sophie Hood's shape: 3 stitches to start, one more every 4 rows (438 at row 50), then the Hood and Scarf 2. */
const hoodStitches = (row) => 3 + Math.floor((row - 1) / 4);
function hood(extra = {}) {
  return craft({
    target: "2026-12-22", finishingMinutes: 0,
    parts: [
      { id: "s1", name: "Scarf 1", rows: 318, stitches: (r) => Math.min(hoodStitches(r), 60), planSec: 6.78 },
      { id: "hd", name: "Hood", rows: 135, stitches: () => 60, planSec: 6.78 },
      { id: "s2", name: "Scarf 2", rows: 317, stitches: (r) => Math.min(hoodStitches(r), 60), planSec: 6.78 },
    ],
    ...extra,
  });
}
/** The Hood on Sun 11/22: rows 1–50 in two counted sittings (112 min, 15.3 s a stitch) and one learning sitting (26 min). */
function hoodToday(today = "2026-11-22") {
  return hood({
    today,
    done: ticks("s1", 1, 50, "2026-11-22"),
    sessions: [
      session({ id: "h1", session_date: "2026-11-22", minutes: 26, exclude_from_stats: true }),
      session({ id: "h2", session_date: "2026-11-22", minutes: 60, item_ids: rowIds("s1", 1, 27) }),
      session({ id: "h3", session_date: "2026-11-22", minutes: 52, item_ids: rowIds("s1", 28, 50) }),
    ],
  });
}

// ── 1. pace.ts ──────────────────────────────────────────────────────────────

test("E1 days: a project started yesterday divides by 2 days, not 14 (the Aug 2027 bug)", () => {
  const input = craft({ sessions: [session({ session_date: "2026-11-21", minutes: 90 }), session({ session_date: "2026-11-22", minutes: 15 })] }).pace;
  const forecast = computeForecast(input);
  assert.equal(forecast.cadence_days, 2);
  assert.equal(forecast.cadence_from, "2026-11-21");
  assert.equal(forecast.cadence_minutes_per_day, 52.5, "105 ÷ 2 (was 105 ÷ 14 = 7.5, which projected Aug 2027)");
});

test("E1 days: the blanket's steady numbers don't move (sittings across the whole 14 days still ÷ 14)", () => {
  const sessions = [];
  for (let day = 1; day <= 30; day += 2) sessions.push(session({ session_date: `2026-10-${String(day).padStart(2, "0")}`, minutes: 40, item_ids: [`p1:${day}`] }));
  const input = craft({ today: "2026-10-30", target: "2026-12-31", sessions, done: Object.fromEntries(sessions.map((s, i) => [`p1:${(i * 2) + 1}`, true])) }).pace;
  const forecast = computeForecast(input);
  assert.equal(forecast.cadence_days, 14);
  assert.equal(forecast.cadence_from, "2026-10-17");
  // Oct 17–30: sittings on 17, 19, …, 29 = 7 × 40 = 280 min ÷ 14 = 20.
  assert.equal(forecast.cadence_minutes_per_day, 20);
});

test("E1 days: a 14-day gap starts the count again at the first sitting after it", () => {
  const sessions = [session({ session_date: "2026-10-01", minutes: 60 }), session({ session_date: "2026-10-20", minutes: 30 }), session({ session_date: "2026-10-21", minutes: 30 })];
  const forecast = computeForecast(craft({ today: "2026-10-22", sessions }).pace);
  assert.deepEqual([forecast.cadence_from, forecast.cadence_days, forecast.cadence_minutes_per_day], ["2026-10-20", 3, 20], "60 ÷ 3, not ÷ 14");
  // 13 empty days is not a gap: the run started before the window, so all 14 days count.
  const near = [session({ session_date: "2026-10-01", minutes: 60 }), session({ session_date: "2026-10-15", minutes: 70 })];
  const steady = computeForecast(craft({ today: "2026-10-20", sessions: near }).pace);
  assert.deepEqual([steady.cadence_from, steady.cadence_days, steady.cadence_minutes_per_day], ["2026-10-07", 14, 5]);
  const idle = computeForecast(craft({ today: "2026-11-20", sessions: near }).pace);
  assert.deepEqual([idle.cadence_from, idle.cadence_days, idle.cadence_minutes_per_day], [null, 0, 0], "nothing in 14 days");
});

test("E1 finish: 3 counted sittings WITH rows on 3 days before a finish date or On track / Behind", () => {
  const base = { target: "2027-01-31", done: ticks("p1", 1, 60, "2026-11-20") };
  const s = (date, rows) => session({ session_date: date, minutes: 60, item_ids: rows });
  // 3 sittings with rows on 1 day: no date.
  let f = computeForecast(craft({ ...base, sessions: [s("2026-11-22", rowIds("p1", 1, 10)), s("2026-11-22", rowIds("p1", 11, 20)), s("2026-11-22", rowIds("p1", 21, 30))] }).pace);
  assert.deepEqual([f.sittings_with_rows, f.days_with_rows, f.finish_ready, f.projected_finish, f.health], [3, 1, false, null, "insufficient_data"]);
  // Minutes but no rows don't count toward the 3, even on other days.
  f = computeForecast(craft({ ...base, sessions: [s("2026-11-20", rowIds("p1", 1, 10)), s("2026-11-21", []), s("2026-11-22", [])] }).pace);
  assert.deepEqual([f.sittings_with_rows, f.finish_ready, f.projected_finish], [1, false, null]);
  // A learning (excluded) sitting with rows doesn't count either.
  f = computeForecast(craft({ ...base, sessions: [s("2026-11-20", rowIds("p1", 1, 10)), s("2026-11-21", rowIds("p1", 11, 20)), { ...s("2026-11-22", rowIds("p1", 21, 30)), exclude_from_stats: true }] }).pace);
  assert.equal(f.finish_ready, false);
  // Three on three days: a date and a health call.
  f = computeForecast(craft({ ...base, sessions: [s("2026-11-20", rowIds("p1", 1, 20)), s("2026-11-21", rowIds("p1", 21, 40)), s("2026-11-22", rowIds("p1", 41, 60))] }).pace);
  assert.deepEqual([f.sittings_with_rows, f.days_with_rows, f.finish_ready], [3, 3, true]);
  assert.ok(f.projected_finish, "a date once ready");
  assert.ok(["on_track", "behind"].includes(f.health));
});

test("E1 Behind so far: 1 counted sitting with rows and needed > your longest day; never On track early", () => {
  // Needed ≈ 74 min a day; one sitting with rows of 60 min → longest day 60 < 74 → behind so far.
  const one = computeForecast(craft({ done: ticks("p1", 1, 12, "2026-11-22"), sessions: [session({ minutes: 60, item_ids: rowIds("p1", 1, 12) })] }).pace);
  assert.equal(one.behind_so_far, true);
  assert.equal(one.health, "insufficient_data", "still no health call");
  // The longest day is all sittings that day, learning included: 60 + 30 = 90 ≥ needed → no warning, and not On track either.
  const longer = computeForecast(craft({ done: ticks("p1", 1, 12, "2026-11-22"), sessions: [session({ minutes: 60, item_ids: rowIds("p1", 1, 12) }), session({ minutes: 30, exclude_from_stats: true })] }).pace);
  assert.equal(longer.longest_day_minutes, 90);
  assert.equal(longer.behind_so_far, false);
  assert.equal(longer.health, "insufficient_data");
  // No sitting with rows yet: no early warning (minutes alone say nothing about speed).
  const noRows = computeForecast(craft({ sessions: [session({ minutes: 5 })] }).pace);
  assert.equal(noRows.behind_so_far, false);
  // A day of the needed minutes (whole minutes, rounded up) is not behind.
  const needed = Math.ceil(one.needed_minutes_per_day);
  // (A learning sitting tops the day up so the speed, and so the minutes needed, stay the same.)
  const exact = computeForecast(craft({ done: ticks("p1", 1, 12, "2026-11-22"), sessions: [session({ minutes: 60, item_ids: rowIds("p1", 1, 12) }), session({ minutes: needed - 60, exclude_from_stats: true })] }).pace);
  assert.equal(exact.longest_day_minutes, needed);
  assert.equal(exact.behind_so_far, false);
});

test("E1 far late: a finish more than 30 days after the due date is flagged (shown as words)", () => {
  const sessions = ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 5, item_ids: [`p1:${i + 1}`] }));
  const f = computeForecast(craft({ done: { "p1:1": true, "p1:2": true, "p1:3": true }, sessions }).pace);
  assert.equal(f.finish_ready, true);
  assert.ok(f.projected_finish > "2027-01-17", f.projected_finish);
  assert.equal(f.finish_far_late, true);
  assert.equal(f.health, "behind");
});

// ── 2. estimate.ts ──────────────────────────────────────────────────────────

etest("scarf on 11/22 (equal rows): 15 rows a day = 74 ÷ 4.97, Too early to tell, 2 sittings have no rows, no date", () => {
  const e = est(craft({ sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90 }), session({ id: "b", session_date: "2026-11-22", minutes: 15 })] }));
  assert.equal(e.mode, "equal");
  assert.equal(e.forecast.needed_minutes_per_day, 74);
  assert.equal(e.rows_needed_per_day, 15);
  assert.deepEqual(e.today_target, { rows: 15, part_id: "p1", row: 15 });
  assert.deepEqual(e.chip, { kind: "early", label: "Too early to tell" });
  assert.equal(e.front.head, "0 of 15 rows");
  assert.equal(e.front.line, "15 rows a day to finish by Fri, Dec 18");
  assert.equal(e.front.no_rows_line, "2 sittings have no rows.");
  assert.deepEqual(e.sittings_without_rows.map((s) => [s.date, s.minutes]), [["2026-11-21", 90], ["2026-11-22", 15]]);
  assert.deepEqual(e.sheet.tiles[0], { label: "Needed", value: "15", unit: "rows a day", sub: "to finish by Fri, Dec 18" });
  assert.deepEqual(e.sheet.tiles[1], { label: "You", value: "0", unit: "rows ticked", sub: "105 min in 2 days" });
  const finish = e.sheet.facts.find((fact) => fact.key === "finish");
  assert.equal(finish.strong, "No date yet");
  assert.match(finish.small, /Needs 3 counted sittings with rows, on 3 different days\. You have none yet\./);
  const time = e.sheet.facts.find((fact) => fact.key === "time");
  assert.equal(time.strong, "74 min a day needed");
  assert.match(time.small, /At plan speed, about 5 min a row\. You: 53 a day over 2 days\./);
  assert.equal(e.sheet.facts.find((fact) => fact.key === "left").strong, "385 rows");
  assert.match(e.sheet.facts.find((fact) => fact.key === "left").small, /11,550 stitches\. Plus about 83 min of finishing\. Due Fri, Dec 18\./);
  assert.match(e.sheet.fix, /^2 sittings have time but no rows: Sat 11\/21, 90 min; Sun 11\/22, 15 min\. Their time counts, but they can't give a speed until they have rows\.$/);
  assert.equal(e.sheet.chart, null, "no rows yet: no chart");
  assert.equal(e.finish.date, null);
  assert.deepEqual(e.parts.map((p) => p.text), ["385 rows left · due Fri, Dec 18"], "one part: its due date, no finish-by");
});

etest("unequal rows (the Hood): walk the next rows by their own minutes; today's target from this morning; Behind so far", () => {
  const e = est(hoodToday());
  assert.equal(e.mode, "unequal");
  assert.equal(e.rows_done_today, 50);
  assert.ok(e.today_target.rows > 50, `the morning walk from row 1 at today's speed (first day): ${e.today_target.rows}`);
  assert.equal(e.today_target.part_id, "s1");
  assert.equal(e.front.head, `50 of ${e.today_target.rows} rows`);
  assert.equal(e.rows_to_go_today, e.today_target.rows - 50);
  assert.match(e.front.line, new RegExp(`^${e.today_target.rows - 50} rows to go, about \\d+ min at your speed$`));
  assert.deepEqual(e.chip, { kind: "behind_so_far", label: "Behind so far" });
  assert.equal(e.forecast.longest_day_minutes, 138, "60 + 52 + the 26-minute learning sitting");
  // The walk from row 51: rows get longer, so the count drops (more rows today than the average over the days left).
  const average = e.rows_left / 31;
  assert.ok(e.rows_needed_per_day > Math.round(average), `${e.rows_needed_per_day} vs ${average}`);
  const fromHere = e.sheet.facts.find((fact) => fact.key === "from_here");
  assert.equal(fromHere.strong, `${e.rows_needed_per_day} rows a day`);
  assert.match(fromHere.small, new RegExp(`^Rows 51 to ${50 + e.rows_needed_per_day} next\\. Rows get longer, so the count drops: about ${Math.round(average)} a day on average\\.$`));
  assert.equal(e.sheet.tiles[0].label, "Needed today");
  assert.equal(e.sheet.tiles[0].sub, `to row ${e.today_target.row} of 318`);
  assert.deepEqual(e.sheet.tiles[1], { label: "You", value: "50", unit: "rows today", sub: "138 min in 3 sittings" });
  assert.match(e.sheet.warn.strong, /^Needs \d+ min a day at your speed\. Your longest day is 138\.$/);
  assert.match(e.sheet.warn.rest, /^ At plan speed it would need \d+\.$/);
  const finish = e.sheet.facts.find((fact) => fact.key === "finish");
  assert.match(finish.small, /You have 2 on 1 day\./);
  const speed = e.sheet.facts.find((fact) => fact.key === "speed");
  assert.match(speed.strong, /^\d+\.\d s a stitch$/);
  assert.match(speed.small, /^Plan 6\.\d\d\. From 2 sittings; 1 left out as learning\.$/);
  assert.match(e.sheet.facts.find((fact) => fact.key === "left").strong, /^720 rows in 3 parts$/);
  // Parts: rows left and a finish-by each (three parts), the last on or before the due date.
  assert.deepEqual(e.parts.map((p) => p.rows_left), [268, 135, 317]);
  assert.ok(e.parts.every((p) => p.finish_by), "two or more parts: a finish-by date each");
  assert.ok(e.parts[0].finish_by < e.parts[1].finish_by && e.parts[1].finish_by <= e.parts[2].finish_by);
  assert.ok(e.parts[2].finish_by <= "2026-12-22");
  assert.match(e.parts[0].text, /^268 rows left · finish by about (Nov|Dec) \d+$/);
});

etest("today's target holds all day: the same row after more rows are ticked (and after a new sitting today), and resets next morning", () => {
  const sessions = [
    session({ id: "d1", session_date: "2026-11-20", minutes: 70, item_ids: rowIds("p1", 1, 14) }),
    session({ id: "d2", session_date: "2026-11-21", minutes: 70, item_ids: rowIds("p1", 15, 28) }),
  ];
  const yesterday = { ...ticks("p1", 1, 14, "2026-11-20"), ...ticks("p1", 15, 28, "2026-11-21") };
  const morning = est(craft({ done: yesterday, sessions }));
  const later = est(craft({ done: { ...yesterday, ...ticks("p1", 29, 36, "2026-11-22") }, sessions: [...sessions, session({ id: "d3", minutes: 40, item_ids: rowIds("p1", 29, 36) })] }));
  assert.deepEqual(later.today_target, morning.today_target, "speed from before today's sittings, work left from this morning");
  assert.equal(later.rows_done_today, 8);
  assert.equal(later.front.head, `8 of ${morning.today_target.rows} rows`);
  // Rows ticked with no timer today count as today's rows and don't move the target either.
  const noTimer = est(craft({ done: { ...yesterday, ...ticks("p1", 29, 31, "2026-11-22") }, sessions }));
  assert.deepEqual(noTimer.today_target, morning.today_target);
  assert.equal(noTimer.rows_done_today, 3);
  // Next morning the pile is what is left: the target starts from row 37.
  const tomorrow = est(craft({ today: "2026-11-23", done: { ...yesterday, ...ticks("p1", 29, 36, "2026-11-22") }, sessions: [...sessions, session({ id: "d3", minutes: 40, item_ids: rowIds("p1", 29, 36) })] }));
  assert.ok(tomorrow.today_target.row > 36);
  assert.equal(tomorrow.rows_done_today, 0);
});

etest("on track: 3 sittings with rows on 3 days, finish before the due date, target reached reads 'N needed, done.'", () => {
  const sessions = [], done = {};
  let row = 1;
  for (let d = 0; d < 10; d += 1) {
    const day = nextDays("2026-11-23", d);
    sessions.push(session({ id: `ot${d}`, session_date: day, minutes: 82, item_ids: rowIds("p1", row, row + 16) }));
    Object.assign(done, ticks("p1", row, row + 16, day));
    row += 17;
  }
  const e = est(craft({ today: "2026-12-02", done, sessions }));
  assert.deepEqual(e.chip, { kind: "ok", label: "On track" });
  assert.equal(e.finish.ready, true);
  assert.ok(e.finish.date && e.finish.date <= "2026-12-18", e.finish.date);
  assert.equal(e.rows_done_today, 17);
  assert.ok(e.rows_done_today >= e.today_target.rows);
  assert.match(e.front.line, new RegExp(`^${e.today_target.rows} needed, done\\. Finish about Dec \\d+$`));
  assert.equal(e.front.head, "17 rows");
  assert.equal(e.front.bar, 1);
  assert.deepEqual(e.sheet.tiles[1], { label: "You", value: "17", unit: "rows a day", sub: "82 min, last 10 days" });
  assert.match(e.sheet.tiles[0].sub, /^\d+ min, by Fri, Dec 18$/);
  assert.equal(e.sheet.chart.days.length, 10, "bars of rows per day after 3 days");
  assert.deepEqual(e.sheet.chart.days.map((d) => d.rows), Array(10).fill(17));
  assert.match(e.sheet.facts.find((f) => f.key === "finish").small, /^\d+ days? early\.$|^On the due date\.$/);
  assert.match(e.sheet.facts.find((f) => f.key === "speed").small, /From 8 sittings\./, "speed is the last 8 counted sittings");
});

etest("behind (ready): finish after the due date; more than 30 days late reads as words, never a far date", () => {
  const sessions = ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 10, item_ids: [`p1:${i + 1}`] }));
  const e = est(craft({ done: { "p1:1": true, "p1:2": true, "p1:3": true }, sessions }));
  assert.deepEqual(e.chip, { kind: "behind", label: "Behind" });
  assert.equal(e.finish.far_late, true);
  assert.equal(e.finish.date, null, "the far date is never handed to the screen");
  assert.equal(e.forecast.projected_finish, null);
  const finish = e.sheet.facts.find((f) => f.key === "finish");
  assert.equal(finish.strong, "More than a month late");
  assert.match(finish.small, /^More than a month after Fri, Dec 18/);
  assert.doesNotMatch(JSON.stringify(e), /2027/, "no far date anywhere in what the screen gets");
  assert.match(e.sheet.warn.strong, /^Needs \d+ min a day\. You're doing \d+\.$/);
  // A little late (within 30 days): a date and "N days late".
  // 13 rows in 66 min a day (about plan speed) against 74 needed: a couple of days late.
  const s2 = ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 66, item_ids: rowIds("p1", i * 13 + 1, i * 13 + 13) }));
  const near = est(craft({ done: ticks("p1", 1, 39, "2026-11-20"), sessions: s2 }));
  assert.equal(near.chip.kind, "behind");
  assert.equal(near.finish.far_late, false);
  assert.match(near.sheet.facts.find((f) => f.key === "finish").small, /^\d+ days? late\.$/);
});

etest("partial rows: not counted until done ('+ part of row 23'); its minutes count", () => {
  const e = est(hood({ done: ticks("s1", 1, 22, "2026-11-22"), sessions: [session({ minutes: 45, item_ids: rowIds("s1", 1, 22), in_progress_item_ids: ["s1:23"] })] }));
  assert.equal(e.rows_done_today, 22);
  assert.equal(e.partial_row, 23);
  assert.equal(e.sheet.tiles[1].unit, "rows today + part of row 23");
  assert.equal(e.sheet.tiles[1].sub, "45 min in 1 sitting");
  assert.equal(e.forecast.cadence_minutes_per_day, 45);
});

etest("rip-backs: ripped rows go back on the pile; the sitting left out stays out of speed but its time counts", () => {
  // Rows 1–30 knitted Nov 21 (70 min), rows 21–30 ripped back: unticked, links gone, the sitting left out.
  const sessions = [session({ id: "r1", session_date: "2026-11-21", minutes: 70, exclude_from_stats: true, item_ids: [] }), session({ id: "r2", session_date: "2026-11-22", minutes: 50, item_ids: rowIds("p1", 1, 10) })];
  const e = est(craft({ done: ticks("p1", 1, 20, "2026-11-21"), sessions }));
  assert.equal(e.rows_left, 365, "rows 21–385 are back on the pile");
  assert.equal(e.forecast.cadence_minutes_per_day, 60, "(70 + 50) ÷ 2");
  assert.equal(e.forecast.sittings_with_rows, 1, "the left-out sitting is not a counted sitting");
  assert.equal(e.sittings_without_rows.length, 0, "a left-out sitting isn't flagged as missing rows");
});

etest("speed from other projects says so (the scarf priced by another project's measured knit)", () => {
  const input = craft({ sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90 })] });
  input.pace.otherProjectRates = [{ work_type: "knit", seconds_per_unit: 9.2, n_sessions: 8 }];
  const speed = est(input).sheet.facts.find((f) => f.key === "speed");
  assert.equal(speed.strong, "4.6 min a row");
  assert.equal(speed.small, "Plan 5.0. From 8 sittings on your other projects; none with rows here yet.");
});

etest("no stitch counts: equal rows, rows only (rows left ÷ days left), no minutes, no date", () => {
  const input = craft({ parts: [{ id: "p1", name: "Mitten", rows: 54, stitches: () => null, word: "round" }], finishingMinutes: 0, done: ticks("p1", 1, 9, "2026-11-22"),
    sessions: ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 30, item_ids: rowIds("p1", i * 3 + 1, i * 3 + 3) })) });
  const e = est(input);
  assert.equal(e.mode, "rows");
  assert.equal(e.row_word, "round");
  assert.equal(e.rows_left, 45);
  assert.equal(e.rows_needed_per_day, 2, "45 rounds ÷ 27 days, rounded up");
  assert.equal(e.today_target.rows, 2, "this morning: 48 rounds ÷ 27 days → 2");
  assert.equal(e.rows_per_day, 3, "a round counts on its sitting's day: 3 a day over 3 days");
  assert.equal(e.finish.date, null);
  assert.equal(e.sheet.facts.find((f) => f.key === "finish").strong, "No date");
  assert.equal(e.sheet.facts.some((f) => f.key === "speed" || f.key === "time"), false, "no minutes");
  assert.deepEqual(e.chip, { kind: "ok", label: "On track" }, "ready, and 3 rounds a day ≥ 2 a day");
  const slow = est(craft({ parts: [{ id: "p1", name: "Mitten", rows: 54, stitches: () => null, word: "round" }], finishingMinutes: 0, done: { "p1:1": true, "p1:2": true, "p1:3": true },
    sessions: ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 30, item_ids: [`p1:${i + 1}`] })) }));
  assert.deepEqual(slow.chip, { kind: "behind", label: "Behind" }, "1 round a day < 2 needed");
});

etest("no speed at all (a stitch type with no plan and nothing measured): rows ÷ days, no date", () => {
  const input = craft({ parts: [{ id: "p1", name: "Scarf", rows: 100, stitches: () => 30, planSec: 0 }], finishingMinutes: 0 });
  const e = est(input);
  assert.equal(e.mode, "rows");
  assert.equal(e.rows_needed_per_day, 4, "100 ÷ 27 → 4");
  assert.equal(e.finish.date, null);
  assert.deepEqual(e.chip, { kind: "early", label: "Too early to tell" });
});

etest("no due date: what you're doing and a finish date only", () => {
  const sessions = ["2026-11-20", "2026-11-21", "2026-11-22"].map((date, i) => session({ session_date: date, minutes: 60, item_ids: rowIds("p1", i * 12 + 1, i * 12 + 12) }));
  const done = { ...ticks("p1", 1, 12, "2026-11-20"), ...ticks("p1", 13, 24, "2026-11-21"), ...ticks("p1", 25, 36, "2026-11-22") };
  const e = est(craft({ target: null, done, sessions }));
  assert.deepEqual(e.chip, { kind: "none", label: "No due date" });
  assert.equal(e.today_target, null);
  assert.equal(e.rows_needed_per_day, null);
  assert.ok(e.finish.date);
  assert.match(e.front.line, /^Finish about (Dec|Jan) \d+$/);
  assert.equal(e.front.head, "12 rows");
  assert.equal(e.front.bar, null);
  assert.deepEqual(e.sheet.tiles[0], { label: "Needed", value: "—", unit: "", sub: "no due date" });
  assert.match(e.sheet.facts.find((f) => f.key === "finish").small, /^At 60 min a day\.$/);
  assert.equal(e.sheet.warn, null);
  assert.deepEqual(e.parts.map((p) => p.text), ["349 rows left"]);
});

etest("due today / past: '12 rows left, due today' and '12 rows left, 2 days past'", () => {
  const done = ticks("p1", 1, 373, "2026-11-01");
  const dueToday = est(craft({ today: "2026-12-18", done }));
  assert.equal(dueToday.front.line, "12 rows left, due today");
  assert.equal(dueToday.today_target.rows, 12, "everything left is today's target");
  const past = est(craft({ today: "2026-12-20", done }));
  assert.equal(past.front.line, "12 rows left, 2 days past");
  assert.deepEqual(past.chip, { kind: "behind", label: "Behind" });
  assert.equal(past.today_target, null);
  assert.equal(past.sheet.warn.strong, "The due date, Fri, Dec 18, has passed.");
  assert.deepEqual(past.sheet.tiles[0], { label: "Needed", value: "12", unit: "rows left", sub: "due Fri, Dec 18" });
  const oneDay = est(craft({ today: "2026-12-19", done }));
  assert.equal(oneDay.front.line, "12 rows left, 1 day past");
});

etest("sittings with minutes but no rows: time counts, speed stays the plan's, and they don't count toward the 3", () => {
  const sessions = ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"].map((date) => session({ session_date: date, minutes: 40 }));
  const e = est(craft({ sessions }));
  assert.equal(e.forecast.cadence_minutes_per_day, 40, "160 ÷ 4 days");
  assert.equal(e.forecast.sittings_with_rows, 0);
  assert.equal(e.finish.ready, false, "today's code would have said Behind on plan speed alone after a third sitting");
  assert.notEqual(e.chip.kind, "behind");
  assert.equal(e.sittings_without_rows.length, 4);
  assert.equal(e.front.no_rows_line, "4 sittings have no rows.");
  assert.ok(e.sheet.facts.find((f) => f.key === "time"), "plan speed: the Time row, not a measured Speed row");
});

etest("3 sittings with rows on 3 days before a finish date (the scarf after rows are added)", () => {
  const two = est(craft({ done: { ...ticks("p1", 1, 15, "2026-11-21"), ...ticks("p1", 16, 30, "2026-11-22") },
    sessions: [session({ session_date: "2026-11-21", minutes: 75, item_ids: rowIds("p1", 1, 15) }), session({ session_date: "2026-11-22", minutes: 75, item_ids: rowIds("p1", 16, 30) })] }));
  assert.equal(two.finish.ready, false);
  assert.match(two.sheet.facts.find((f) => f.key === "finish").small, /You have 2 on 2 days\./);
  assert.equal(two.chip.kind, "early", "75 a day ≥ 74 needed: no early warning, and never On track early");
  const three = est(craft({ today: "2026-11-23", done: { ...ticks("p1", 1, 15, "2026-11-21"), ...ticks("p1", 16, 30, "2026-11-22"), ...ticks("p1", 31, 45, "2026-11-23") },
    sessions: [session({ session_date: "2026-11-21", minutes: 75, item_ids: rowIds("p1", 1, 15) }), session({ session_date: "2026-11-22", minutes: 75, item_ids: rowIds("p1", 16, 30) }),
      session({ session_date: "2026-11-23", minutes: 75, item_ids: rowIds("p1", 31, 45) })] }));
  assert.equal(three.finish.ready, true);
  assert.ok(three.finish.date);
  assert.equal(three.chip.kind, "ok");
});

etest("the walk crosses into the next part when the screen's part runs out; the screen's part goes first", () => {
  const e = est(hood({ activePart: "hd", done: ticks("s1", 1, 318, "2026-11-01") }));
  assert.equal(e.parts[0].text, "All rows ticked");
  // Hood first (the screen's part), then Scarf 2.
  assert.equal(e.today_target.part_id, "hd");
  const short = est(hood({ activePart: "s1", done: ticks("s1", 1, 316, "2026-11-01") }));
  assert.ok(short.today_target.rows > 2);
  assert.equal(short.today_target.part_id, "hd", "rows 317–318, then into the Hood");
  assert.match(short.sheet.tiles[0].sub, /^to Hood row \d+$/);
});

etest("all rows ticked", () => {
  const e = est(craft({ parts: [{ id: "p1", name: "Scarf", rows: 10, stitches: () => 30, planSec: 10 }], finishingMinutes: 0, done: ticks("p1", 1, 10, "2026-11-20") }));
  assert.equal(e.rows_left, 0);
  assert.equal(e.front.line, "Every row is ticked.");
  assert.equal(e.chip.kind, "done");
});

etest("product words: no assistant names, rows never inches", () => {
  const text = JSON.stringify([est(hoodToday()), est(craft({}))]);
  assert.doesNotMatch(text, /Claude|Anthropic|inch/i);
});

// ── 3. E2: the Today box, Pace (inside + sheet), parts, the route ───────────

if (!onlyPace) {
  const { readFileSync } = await import("node:fs");
  const { registerHooks } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const ts = (await import("typescript")).default;
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const fileName = fileURLToPath(url);
      const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      return { format: "module", source: result.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  } });
  const ui = await import("../src/components/craft/CraftPace.tsx");
  const sheets = await import("../src/components/craft/CraftSheets.tsx");
  const { NextRequest } = await import("next/server");
  const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
  const { GET: paceGet } = await import("../src/app/api/craft/pace/route.ts");
  const render = (component, props) => renderToStaticMarkup(createElement(component, props));
  const scarf = () => est(craft({ sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90 }), session({ id: "b", session_date: "2026-11-22", minutes: 15 })] }));

  test("E2 Today box: head, chip, bar, one line, and 'N sittings have no rows' only when true; the whole box opens Pace", () => {
    const html = render(ui.CraftTodayBox, { estimate: scarf(), onOpen: () => {} });
    assert.match(html, /^<div class="cp-strip"><button type="button" class="cp-open" aria-label="Today: 0 of 15 rows\. Too early to tell\. 15 rows a day to finish by Fri, Dec 18\. Open Pace">/);
    assert.match(html, /<em>Today<\/em><strong>0 of 15 rows<\/strong><\/span><span class="cp-chip">Too early to tell<\/span>/);
    assert.match(html, /<span class="cp-meter" aria-hidden="true"><i style="width:0%"><\/i><\/span><span class="cp-cap">15 rows a day to finish by Fri, Dec 18<\/span>/);
    assert.match(html, /<button type="button" class="cp-link">2 sittings have no rows\.<\/button>/);
    const hoodHtml = render(ui.CraftTodayBox, { estimate: est(hoodToday()), onOpen: () => {} });
    assert.match(hoodHtml, /<span class="cp-chip behind">Behind so far<\/span>/);
    assert.match(hoodHtml, /class="cp-meter short"/, "the bar is amber while behind");
    assert.doesNotMatch(hoodHtml, /cp-link/, "no sittings without rows → no line");
  });

  test("E2 Pace: This project (tiles, warning, facts) and All projects (a placeholder until E4); tabs are toggle buttons", () => {
    const hood = est(hoodToday());
    const html = render(ui.CraftPaceBody, { estimate: hood, tab: "this", onTab: () => {} });
    assert.match(html, /<div class="cp-tabs" role="group" aria-label="Pace for"><button[^>]*aria-pressed="true"[^>]*>This project<\/button><button[^>]*aria-pressed="false"[^>]*>All projects<\/button><\/div>/);
    assert.match(html, /<span class="craft-eyebrow">Needed today<\/span><p class="cp-num"><strong>\d+<\/strong> rows<\/p><p class="cp-sub">to row \d+ of 318<\/p>/);
    assert.match(html, /<span class="craft-eyebrow">You<\/span><p class="cp-num"><strong>50<\/strong> rows today<\/p><p class="cp-sub">138 min in 3 sittings<\/p>/);
    assert.match(html, /<p class="cp-warn"><strong>Needs \d+ min a day at your speed\. Your longest day is 138\.<\/strong> At plan speed it would need \d+\.<\/p>/);
    assert.match(html, /<dt>From here<\/dt>.*<dt>Finish<\/dt>.*<dt>Speed<\/dt>.*<dt>Left<\/dt>/);
    const all = render(ui.CraftPaceBody, { estimate: hood, tab: "all", onTab: () => {} });
    assert.match(all, /class="cp-all"/);
    assert.doesNotMatch(all, /cp-tiles/);
    const section = render(ui.CraftPaceSection, { estimate: null });
    assert.match(section, /<section class="cp-section" aria-label="Pace"><div class="cp-hd"><h2>Pace<\/h2><\/div><p class="cp-sub">Working out the pace…<\/p><\/section>/);
    const scarfHtml = render(ui.CraftPaceBody, { estimate: scarf(), tab: "this", onTab: () => {} });
    assert.match(scarfHtml, /<div class="cp-fix"><p>2 sittings have time but no rows: Sat 11\/21, 90 min; Sun 11\/22, 15 min\./);
    assert.doesNotMatch(scarfHtml, /Add rows/, "E3 adds the Add rows button");
  });

  test("E2 chart: bars of rows per day after 3 days, with the needed-now dashed line", () => {
    const sessions = [], done = {};
    for (let d = 0; d < 4; d += 1) {
      const day = nextDays("2026-11-19", d);
      sessions.push(session({ session_date: day, minutes: 80, item_ids: rowIds("p1", d * 16 + 1, d * 16 + 16) }));
      Object.assign(done, ticks("p1", d * 16 + 1, d * 16 + 16, day));
    }
    const e = est(craft({ done, sessions }));
    const html = render(ui.CraftPaceBody, { estimate: e, tab: "this", onTab: () => {} });
    assert.equal((html.match(/<rect /g) ?? []).length, 4);
    assert.match(html, /class="cp-need"/);
    assert.match(html, /aria-label="Rows each day from 11\/19 to 11\/22: 16, 16, 16, 16\. \d+ needed a day now\."/);
    const two = est(craft({ done: ticks("p1", 1, 10, "2026-11-22"), sessions: [session({ session_date: "2026-11-21", minutes: 10 }), session({ minutes: 40, item_ids: rowIds("p1", 1, 10) })] }));
    assert.equal(two.sheet.chart, null, "under 3 days: no chart");
  });

  test("E2 Parts list: rows left and, with two or more parts, a finish-by date each", () => {
    const hood = est(hoodToday());
    const view = { parts: hood.parts.map((p, i) => ({ id: p.part_id, name: ["Scarf 1", "Hood", "Scarf 2"][i], row_label: "Row 1", finished: false })), active_part: { id: "s1" } };
    const html = render(sheets.PartsList, { view, busy: null, onPick: () => {}, onChangeTotal: () => {}, estimate: hood });
    assert.match(html, /<strong>Scarf 1<\/strong><span>Row 1 · on the screen<\/span><span class="cp-partline">268 rows left · finish by about \w+ \d+<\/span>/);
    assert.match(html, /<strong>Scarf 2<\/strong><span>Row 1<\/span><span class="cp-partline">317 rows left · finish by (about )?Dec \d+<\/span>/);
    const plain = render(sheets.PartsList, { view, busy: null, onPick: () => {}, onChangeTotal: () => {} });
    assert.doesNotMatch(plain, /cp-partline/, "no estimate → the list as before");
  });

  test("E2 wiring: the screen reads the estimate after a saved row or sitting (a key), never on a timer; the Today box replaces the bottom Today line; Pace leads the inside screen", () => {
    const screen = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
    const pace = readFileSync(new URL("../src/components/craft/CraftPace.tsx", import.meta.url), "utf8");
    assert.match(screen, /const estimate = useCraftPace\(projectId, paceKey\);/);
    assert.match(screen, /paceKey = \[view\.today\.date, part\?\.id \?\? "", \.\.\.view\.parts\.map\(\(entry\) => `\$\{entry\.id\}:\$\{entry\.done_rows\}`\)/);
    assert.match(screen, /\{estimate && <CraftTodayBox estimate=\{estimate\} onOpen=\{\(\) => setSheet\("pace"\)\} \/>\}/);
    assert.match(screen, /\{!estimate && <section className="craft-today"/);
    assert.match(screen, /<aside className="craft-inside" aria-label="Project details">\s*<CraftPaceSection estimate=\{estimate\} \/>/);
    assert.doesNotMatch(pace, /setInterval|setTimeout/, "no polling");
    assert.match(pace, /fetch\(`\/api\/craft\/pace\?project_id=\$\{encodeURIComponent\(projectId\)\}`, \{ cache: "no-store" \}\)/);
    const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8").split("Craft estimates E2")[1];
    assert.ok(css);
    for (const size of css.matchAll(/font(?:-size)?:[^;]*?(\d+)px/g)) assert.ok(Number(size[1]) >= 12, `type floor: ${size[0]}`);
    assert.doesNotMatch(css, /!important|#[0-9a-f]{3,6}\b/i, "tokens only");
    assert.doesNotMatch(pace + screen, /Claude|Anthropic|inch/i);
  });

  // A small in-memory database: every query must filter by user.
  function fakeDb(tables) {
    const queries = [];
    return {
      queries,
      rpc: () => Promise.resolve({ data: null, error: null }),
      from(table) {
        const filters = [];
        let range = null;
        const q = {
          select() { return q; },
          eq(col, val) { filters.push((row) => row[col] === val); queries.push([table, "eq", col]); return q; },
          neq(col, val) { filters.push((row) => row[col] !== val); return q; },
          in(col, vals) { filters.push((row) => vals.includes(row[col])); return q; },
          is(col, val) { filters.push((row) => row[col] === val); return q; },
          order() { return q; },
          range(from, to) { range = [from, to]; return q; },
          rows() { const all = (tables[table] ?? []).filter((row) => filters.every((f) => f(row))); return range ? all.slice(range[0], range[1] + 1) : all; },
          maybeSingle() { return Promise.resolve({ data: q.rows()[0] ?? null, error: null }); },
          single() { const r = q.rows(); return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { code: "PGRST116" } }); },
          then(resolve, reject) { return Promise.resolve({ data: q.rows(), error: null }).then(resolve, reject); },
        };
        return q;
      },
    };
  }
  const UID = "00000000-0000-4000-8000-000000000001";
  const PID = "00000000-0000-4000-8000-0000000000aa";
  function scarfTables() {
    const c = craft({ sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90 }), session({ id: "b", session_date: "2026-11-22", minutes: 15 })] });
    const own = (row) => ({ ...row, user_id: UID });
    return {
      craft_projects: [own({ project_id: PID, active_part_id: "p1" })],
      projects: [own({ id: PID, name: "Mom's One Row Scarf", unit_label: "stitches", target_date: "2026-12-18", pace_settings: null })],
      project_sections: [],
      tasks: c.pace.tasks.map((t) => own({ ...t, project_id: PID, title: t.id, is_recurring_template: false, source_checklist_item_id: null })),
      task_checklist_items: c.pace.items.map((i, n) => own({ ...i, text: `Row ${n + 1}`, sort_order: n, completed_at: null, craft_part_id: i.task_id === "t-p1" ? "p1" : null, craft_row: i.task_id === "t-p1" ? n + 1 : null })),
      work_sessions: c.pace.sessions.map((x) => own({ ...x, project_id: PID, started_at: null, ended_at: null, created_at: `${x.session_date}T20:00:00Z`, note: null, exclude_reason: null, source: "manual" })),
      work_session_items: [],
      craft_parts: [own({ id: "p1", project_id: PID, name: "Scarf", sort_order: 0, row_word: "row", total_rows: 385 })],
    };
  }
  const paceReq = (db, query = `?project_id=${PID}`) => {
    const r = new NextRequest(`http://localhost/api/craft/pace${query}`);
    writeInternalAuthContext(r, { supabase: db, userId: UID, user: { id: UID }, authSource: "session" });
    return r;
  };

  await (async () => {
    const realDate = Date;
    // The service works out today in ET from the clock: pin it to Sun 11/22 8:24 PM ET.
    globalThis.Date = class extends realDate { constructor(...args) { super(...(args.length ? args : ["2026-11-23T01:24:00Z"])); } static now() { return new realDate("2026-11-23T01:24:00Z").getTime(); } };
    try {
      const db = fakeDb(scarfTables());
      const res = await paceGet(paceReq(db));
      const body = await res.json();
      test("E2 route: GET /api/craft/pace?project_id= returns the project's estimate (no-store), every read filtered by user", () => {
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(body.today, "2026-11-22");
        assert.equal(body.projects.length, 1);
        const entry = body.projects[0];
        assert.equal(entry.project_id, PID);
        assert.equal(entry.estimate.front.head, "0 of 15 rows");
        assert.equal(entry.estimate.chip.label, "Too early to tell");
        const tablesRead = new Set(db.queries.map(([table]) => table));
        for (const table of tablesRead) assert.ok(db.queries.some(([t, op, col]) => t === table && op === "eq" && col === "user_id"), `${table} filtered by user`);
      });
    } finally {
      globalThis.Date = realDate;
    }
    const bad = await paceGet(paceReq(fakeDb({}), "?project_id=nope"));
    const two = await paceGet(paceReq(fakeDb({}), `?project_id=${PID}&project_id=${PID}`));
    const extra = await paceGet(paceReq(fakeDb({}), "?scope=all"));
    test("E2 route: a bad or repeated project_id or an unknown parameter is a 400 before any read", () => {
      assert.deepEqual([bad.status, two.status, extra.status], [400, 400, 400]);
    });
    // One project failing leaves the others (and the screen) working.
    const broken = scarfTables();
    broken.craft_projects.push({ project_id: "00000000-0000-4000-8000-0000000000bb", active_part_id: null, user_id: UID });
    const quiet = console.error; console.error = () => {};
    let all;
    try { all = await (await paceGet(paceReq(fakeDb(broken), ""))).json(); } finally { console.error = quiet; }
    test("E2 route: without project_id every craft project; one that can't be read is 'unavailable', the rest still come back", () => {
      assert.equal(all.projects.length, 2);
      assert.ok(all.projects.find((p) => p.project_id === PID).estimate);
      assert.deepEqual(all.projects.find((p) => p.project_id !== PID), { project_id: "00000000-0000-4000-8000-0000000000bb", name: null, estimate: null, error: "unavailable" });
    });
  })();

}

function nextDays(day, n) {
  let out = day;
  for (let i = 0; i < n; i += 1) out = nextDay(out);
  return out;
}

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
if (failures.length) process.exit(1);
