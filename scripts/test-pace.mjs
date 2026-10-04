// Pure tests for pace tracking (slice 1): the forecast module
// (src/lib/pace.ts) and the work-session input helpers
// (src/lib/work-sessions/parse.ts). No database.
//
//   npm run test:pace

import assert from "node:assert/strict";

const pace = await import("../src/lib/pace.ts");
const parse = await import("../src/lib/work-sessions/parse.ts");
const backfill = await import("../src/lib/work-sessions/backfill.ts");
const {
  computeForecast,
  computePlanSpeeds,
  buildUnitEntries,
  allocateSessions,
  computeMeasuredSpeeds,
  parsePaceSettings,
  formatForecastLine,
  SAMPLE_SPEED_LABEL,
} = pace;

let passed = 0;
const failures = [];
// Every test runs even if an earlier one fails, so one run shows everything that's broken.
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.message ?? error).split("\n").slice(0, 4).join("\n    ")}`);
  }
}
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ""} expected ≈${expected}, got ${actual}`);

// ── Builders ────────────────────────────────────────────────────────────────

function task(id, extra = {}) {
  return {
    id,
    status: "Planned",
    estimated_minutes: 0,
    unit_count: null,
    work_type: null,
    is_sample: false,
    section_id: null,
    ...extra,
  };
}
function item(id, taskId, units, workType, extra = {}) {
  return { id, task_id: taskId, is_done: false, unit_count: units, work_type: workType, ...extra };
}
let sessionSeq = 0;
function session(extra) {
  sessionSeq += 1;
  return {
    id: `s${String(sessionSeq).padStart(3, "0")}`,
    task_id: null,
    session_date: "2026-10-04",
    minutes: 10,
    exclude_from_stats: false,
    item_ids: [],
    extra_units: null,
    extra_work_type: null,
    ...extra,
  };
}
function input(extra) {
  return {
    project: { unit_label: "stitches", target_date: "2026-12-05", pace_settings: null },
    sections: [],
    tasks: [],
    items: [],
    sessions: [],
    today: "2026-10-04",
    otherProjectRates: [],
    ...extra,
  };
}

const BLANKET_SIZE = {
  size: { label: "width", current: 195, step: 12, offset: 3, min: 27, unit: "stitches", work_types: ["chain", "sc", "plain-dc", "waffle", "colorwork-dc"] },
};

/**
 * The Christmas Tree Blanket as tagged by the backfill (structure only):
 * swatch steps 2–4 at width 27 (sample), body steps 9–19 at 195, border rounds
 * as task-level sc, unit-less steps 5–8 and 22–23. Sessions as on Oct 4.
 */
function blanket({ today = "2026-10-04", sessions: withSessions = true } = {}) {
  const tasks = [];
  const items = [];
  const sections = [
    { id: "sec-swatch", planned_start: "2026-10-03" },
    { id: "sec-yarn", planned_start: "2026-10-10" },
    { id: "sec-body", planned_start: "2026-10-19" },
    { id: "sec-finish", planned_start: "2026-11-30" },
  ];
  const add = (t, rows) => {
    tasks.push(t);
    rows.forEach(([text, units, type, done], index) =>
      items.push({ id: `${t.id}-r${index}`, task_id: t.id, text, is_done: Boolean(done), unit_count: units, work_type: type })
    );
  };
  add(task("step1", { status: "Done", estimated_minutes: 30, section_id: "sec-swatch" }), [["Chain 15 and work 2 rows of dc", null, null, true]]);
  add(task("step2", { status: "Done", estimated_minutes: 60, is_sample: true, section_id: "sec-swatch" }), [
    ["Chain 28", 28, "chain", true],
    ["Row 1: sc across (27 stitches)", 27, "sc", true],
    ["Row 2: waffle setup row, dc across", 27, "plain-dc", true],
    ["Row 3: waffle Row A", 27, "waffle", true],
    ["Row 4: waffle Row B", 27, "waffle", true],
    ["Row 5: waffle Row A", 27, "waffle", true],
    ["Row 6: waffle Row B", 27, "waffle", true],
    ["Count the last row: 27 stitches", null, null, true],
  ]);
  const step3Rows = [["Row 7 (band row 1): dc across in cream", 27, "plain-dc", true]];
  for (let row = 8; row <= 19; row += 1) step3Rows.push([`Row ${row} (band row ${row - 6}): 3-wide row`, 27, "colorwork-dc", row <= 15]);
  step3Rows.push(["Count the last row: 27 stitches", null, null, false]);
  add(task("step3", { estimated_minutes: 150, is_sample: true, section_id: "sec-swatch" }), step3Rows);
  add(task("step4", { estimated_minutes: 30, is_sample: true, section_id: "sec-swatch" }), [
    ["Row 20: waffle setup row, dc across", 27, "plain-dc"],
    ["Row 21: waffle Row A", 27, "waffle"],
    ["Row 22: waffle Row B", 27, "waffle"],
    ["Count the last row: 27 stitches", null, null],
    ["Fasten off", null, null],
  ]);
  for (const [id, section] of [["step5", "sec-swatch"], ["step6", "sec-swatch"], ["step7", "sec-yarn"], ["step8", "sec-yarn"]]) {
    add(task(id, { estimated_minutes: 30, section_id: section }), [["a check", null, null]]);
  }
  add(task("step9", { status: "Backlog", estimated_minutes: 60, section_id: "sec-body" }), [
    ["Chain 196", 196, "chain"],
    ["Row 1: sc in the 2nd chain from the hook and across", 195, "sc"],
    ["Count: 195 stitches", null, null],
  ]);
  let rowNo = 2;
  for (let band = 0; band < 9; band += 1) {
    const waffle = band % 2 === 0;
    const rows = [];
    if (waffle) {
      rows.push([`Row ${rowNo++}: waffle setup row, dc across`, 195, "plain-dc"]);
      for (let r = 0; r < 12; r += 1) rows.push([`Row ${rowNo++}: waffle Row ${r % 2 ? "B" : "A"}`, 195, "waffle"]);
    } else {
      rows.push([`Row ${rowNo++} (band row 1): dc across in cream`, 195, "plain-dc"]);
      for (let r = 0; r < 18; r += 1) rows.push([`Row ${rowNo++} (band row ${r + 2}): 5-wide row`, 195, "colorwork-dc"]);
    }
    rows.push(["Count the last row: 195 stitches", null, null]);
    add(task(`band${band}`, { status: "Backlog", estimated_minutes: waffle ? 260 : 475, section_id: "sec-body" }), rows);
  }
  add(task("step19", { status: "Backlog", estimated_minutes: 20, section_id: "sec-body" }), [["Row 143: sc across", 195, "sc"]]);
  tasks.push(task("border1", { status: "Backlog", estimated_minutes: 90, unit_count: 970, work_type: "sc", section_id: "sec-finish" }));
  tasks.push(task("border2", { status: "Backlog", estimated_minutes: 75, unit_count: 980, work_type: "sc", section_id: "sec-finish" }));
  add(task("step22", { status: "Backlog", estimated_minutes: 90, section_id: "sec-finish" }), [["Green ends", null, null]]);
  add(task("step23", { status: "Backlog", estimated_minutes: 30, section_id: "sec-finish" }), [["Wash", null, null]]);

  const step2Units = items.filter((i) => i.task_id === "step2" && i.unit_count).map((i) => i.id);
  const step3Item = (row) => items.find((i) => i.task_id === "step3" && i.text.startsWith(`Row ${row} `)).id;
  const sessions = withSessions
    ? [
        session({ id: "oct3", session_date: "2026-10-03", minutes: 300, exclude_from_stats: true, item_ids: [...step2Units, step3Item(7), step3Item(8), step3Item(9)] }),
        session({ id: "row10", task_id: "step3", session_date: "2026-10-04", minutes: 13, exclude_from_stats: true, item_ids: [step3Item(10)], ended_at: "2026-10-04T17:33:00.000Z" }),
        session({ id: "rows11-15", task_id: "step3", session_date: "2026-10-04", minutes: 61, item_ids: [11, 12, 13, 14, 15].map(step3Item), ended_at: "2026-10-04T18:39:00.000Z" }),
      ]
    : [];
  return input({
    project: { unit_label: "stitches", target_date: "2026-12-05", pace_settings: BLANKET_SIZE },
    sections,
    tasks,
    items,
    sessions,
    today,
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

test("pace_settings: the blanket shape parses; bad shapes are rejected with a reason", () => {
  const ok = parsePaceSettings(BLANKET_SIZE);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.size.current, 195);
  assert.deepEqual(parsePaceSettings(null), { ok: true, value: null });
  assert.equal(parsePaceSettings({ sise: {} }).ok, false, "unknown key");
  assert.equal(parsePaceSettings({ size: { ...BLANKET_SIZE.size, current: 196 } }).ok, false, "196 is not 3 + 12k");
  assert.equal(parsePaceSettings({ size: { ...BLANKET_SIZE.size, min: 0 } }).ok, false);
  assert.equal(parsePaceSettings({ size: { ...BLANKET_SIZE.size, work_types: ["Bad Type"] } }).ok, false);
  assert.equal(parsePaceSettings([]).ok, false);
});

test("work_type and unit_count normalisers mirror the SQL checks", () => {
  assert.deepEqual(pace.normalizeWorkType(" Colorwork-DC "), { ok: true, value: "colorwork-dc" });
  assert.deepEqual(pace.normalizeWorkType(""), { ok: true, value: null });
  assert.equal(pace.normalizeWorkType("-x").ok, false);
  assert.equal(pace.normalizeWorkType("a".repeat(41)).ok, false);
  assert.equal(pace.normalizeUnitCount(-1).ok, false);
  assert.deepEqual(pace.normalizeUnitCount(13.5), { ok: true, value: 13.5 });
});

// ── Units and plan speeds ──────────────────────────────────────────────────

test("units: row type overrides task type; a task with no unit rows uses its own units; rows without units add nothing", () => {
  const tasks = [
    task("t1", { work_type: "sc" }),
    task("t2", { unit_count: 970, work_type: "sc", status: "Done" }),
    task("t3", { status: "Done" }),
  ];
  const items = [item("a", "t1", 10, null), item("b", "t1", 5, "waffle"), item("c", "t1", null, "waffle"), item("d", "t3", 7, "sc")];
  const entries = buildUnitEntries(tasks, items);
  assert.deepEqual(entries.map((e) => [e.key, e.work_type, e.units, e.done]), [
    ["a", "sc", 10, false],
    ["b", "waffle", 5, false],
    ["task:t2", "sc", 970, true],
    ["d", "sc", 7, true],
  ], "rows of a Done task count as done");
});

test("plan speeds: unit-weighted mean of task rates; sample tasks and tasks without estimates are ignored", () => {
  const forecast = computeForecast(blanket({ sessions: false }));
  const plan = Object.fromEntries(forecast.plan_speeds.map((p) => [p.work_type, p.seconds_per_unit]));
  near(plan.waffle, 6.15, 0.01, "waffle");
  near(plan["colorwork-dc"], 7.69, 0.01, "colorwork-dc");
  near(plan["plain-dc"], 6.84, 0.01, "plain-dc ≈ 6.8");
  near(plan.sc, 5.51, 0.01, "sc ≈ 5.5");
  const tasks = [task("x", { is_sample: true, estimated_minutes: 60 }), task("y", { estimated_minutes: 0 })];
  const items = [item("i", "x", 10, "sc"), item("j", "y", 10, "waffle")];
  assert.equal(computePlanSpeeds(tasks, buildUnitEntries(tasks, items)).size, 0);
});

// ── Measured speeds ─────────────────────────────────────────────────────────

test("measured speed is a ratio of sums, not a mean of per-session speeds", () => {
  const tasks = [task("t", { work_type: "sc" })];
  const items = [item("a", "t", 10, null), item("b", "t", 90, null)];
  const sessions = [session({ task_id: "t", minutes: 10, item_ids: ["a"] }), session({ task_id: "t", minutes: 30, item_ids: ["b"] })];
  const forecast = computeForecast(input({ tasks, items, sessions }));
  const sc = forecast.measured_speeds.find((s) => s.work_type === "sc");
  // Σmin×60 ÷ Σunits = 40×60/100 = 24 (the mean of 60 and 20 would be 40).
  assert.equal(sc.seconds_per_unit, 24);
  assert.equal(sc.n_sessions, 2);
  assert.equal(sc.scope, "main");
});

test("a mixed session splits its minutes by units × plan speed (equal per unit when a type has no plan)", () => {
  const tasks = [task("plan", { estimated_minutes: 100 }), task("work")];
  const items = [
    item("p1", "plan", 100, "waffle"), // plan: 100 min / 300 units = 20 s/unit for both types
    item("p2", "plan", 200, "sc"),
    item("w1", "work", 10, "waffle"),
    item("w2", "work", 30, "sc"),
  ];
  const entries = buildUnitEntries(tasks, items);
  const plan = computePlanSpeeds(tasks, entries);
  // Re-weight: make waffle twice as slow in the plan by giving it its own task.
  const tasks2 = [task("pw", { estimated_minutes: 40 }), task("ps", { estimated_minutes: 20 }), task("work")];
  const items2 = [item("p1", "pw", 60, "waffle"), item("p2", "ps", 60, "sc"), item("w1", "work", 10, "waffle"), item("w2", "work", 10, "sc")];
  const entries2 = buildUnitEntries(tasks2, items2);
  const plan2 = computePlanSpeeds(tasks2, entries2); // waffle 40 s, sc 20 s
  const allocs = allocateSessions([session({ id: "mix", minutes: 30, item_ids: ["w1", "w2"] })], tasks2, entries2, plan2);
  const byType = Object.fromEntries(allocs.map((a) => [a.work_type, a.minutes]));
  near(byType.waffle, 20, 1e-9, "10 waffle × 40 s : 10 sc × 20 s = 2 : 1");
  near(byType.sc, 10, 1e-9);
  // A type with no plan speed → equal weight per unit.
  const allocs2 = allocateSessions(
    [session({ id: "mix2", minutes: 40, item_ids: ["w1", "w2"], extra_units: 20, extra_work_type: "chain" })],
    tasks, entries, plan
  );
  const split = Object.fromEntries(allocs2.map((a) => [a.work_type, a.minutes]));
  assert.deepEqual(split, { waffle: 40 * 10 / 60, sc: 40 * 30 / 60, chain: 40 * 20 / 60 });
});

test("measured speed uses only the most recent 8 counted sessions per (type, scope)", () => {
  const tasks = [task("t", { work_type: "sc" })];
  const items = [];
  const sessions = [];
  for (let day = 1; day <= 10; day += 1) {
    const id = `i${day}`;
    items.push(item(id, "t", 10, null));
    // The two oldest are slow (60 s/unit); the newest 8 are 6 s/unit.
    sessions.push(session({ task_id: "t", session_date: `2026-10-${String(day).padStart(2, "0")}`, minutes: day <= 2 ? 10 : 1, item_ids: [id] }));
  }
  const speeds = computeMeasuredSpeeds(allocateSessions(sessions, tasks, buildUnitEntries(tasks, items), new Map()));
  assert.equal(speeds[0].n_sessions, 8);
  assert.equal(speeds[0].seconds_per_unit, 6);
});

test("excluded sessions count toward cadence but never toward speed", () => {
  const tasks = [task("t", { work_type: "sc", estimated_minutes: 10 })];
  const items = [item("a", "t", 100, null), item("b", "t", 100, null), item("c", "t", 100, null)];
  const sessions = [
    session({ task_id: "t", minutes: 140, item_ids: ["a"], exclude_from_stats: true }),
    session({ task_id: "t", minutes: 28, item_ids: ["b"] }),
  ];
  const forecast = computeForecast(input({ tasks, items, sessions }));
  assert.equal(forecast.measured_speeds[0].seconds_per_unit, 16.8, "only the counted 28 min / 100");
  assert.equal(forecast.cadence_minutes_per_day, 12, "(140 + 28) ÷ 14");
  assert.equal(forecast.counted_sessions, 1);
  assert.equal(forecast.excluded_sessions, 1);
});

test("rows ticked with no session count as progress but never as speed", () => {
  const tasks = [task("t", { work_type: "sc", estimated_minutes: 50 })];
  const items = [item("a", "t", 100, null, { is_done: true }), item("b", "t", 100, null)];
  const forecast = computeForecast(input({ tasks, items }));
  assert.equal(forecast.measured_speeds.length, 0, "no speed without a session");
  assert.equal(forecast.work_left[0].units_left, 100, "the ticked row is progress");
  assert.equal(forecast.work_left[0].source, "plan");
});

test("cadence window is the last 14 days including today", () => {
  const sessions = [
    session({ session_date: "2026-09-20", minutes: 1000 }), // 14 days before today: outside
    session({ session_date: "2026-09-20", minutes: 1000 }),
    session({ session_date: "2026-09-21", minutes: 70 }), // 13 days before: the first day in the window
    session({ session_date: "2026-10-04", minutes: 70 }),
    session({ session_date: "2026-10-05", minutes: 999 }), // future: outside
  ];
  const forecast = computeForecast(input({ sessions }));
  assert.equal(forecast.cadence_minutes_per_day, 10);
  assert.equal(forecast.sessions_in_cadence_window, 2);
});

// ── Speed resolution tiers ──────────────────────────────────────────────────

function tierFixture({ main = false, sample = false, other = false, ratio = false, plan = true } = {}) {
  const tasks = [
    task("body", { estimated_minutes: plan ? 20 : 0 }),
    task("swatch", { is_sample: true }),
    task("ratioTask", { estimated_minutes: 10 }),
  ];
  const items = [
    item("body1", "body", 100, "waffle"),
    item("body2", "body", 100, "waffle"),
    item("sw1", "swatch", 10, "waffle"),
    item("r1", "ratioTask", 50, "sc"),
    item("r2", "ratioTask", 50, "sc"),
  ];
  const sessions = [];
  if (main) sessions.push(session({ task_id: "body", minutes: 30, item_ids: ["body1"] }));
  if (sample) sessions.push(session({ task_id: "swatch", minutes: 5, item_ids: ["sw1"] }));
  if (ratio) sessions.push(session({ task_id: "ratioTask", minutes: 15, item_ids: ["r1"] })); // plan 6 s × 50 = 5 min → 3×
  return input({
    tasks,
    items,
    sessions,
    otherProjectRates: other ? [{ work_type: "waffle", seconds_per_unit: 9, n_sessions: 4 }] : [],
  });
}
const waffleRow = (forecast) => forecast.work_left.find((row) => row.work_type === "waffle");

test("speed tier 1: measured (main scope)", () => {
  const row = waffleRow(computeForecast(tierFixture({ main: true, sample: true, other: true, ratio: true })));
  assert.equal(row.source, "measured");
  assert.equal(row.seconds_per_unit, 18);
  assert.equal(row.n_sessions, 1);
  assert.equal(row.label, null);
});

test("speed tier 2: measured_sample, labelled as from the swatch/sample", () => {
  const forecast = computeForecast(tierFixture({ sample: true, other: true, ratio: true }));
  const row = waffleRow(forecast);
  assert.equal(row.source, "measured_sample");
  assert.equal(row.seconds_per_unit, 30);
  assert.equal(row.label, SAMPLE_SPEED_LABEL);
  assert.match(row.label, /swatch\/sample — rows are narrower/);
  const measured = forecast.measured_speeds.find((s) => s.work_type === "waffle");
  assert.equal(measured.scope, "sample");
  assert.equal(measured.label, SAMPLE_SPEED_LABEL, "every returned sample speed carries the label");
});

test("speed tier 3: other_projects (same unit, main scope)", () => {
  const row = waffleRow(computeForecast(tierFixture({ other: true, ratio: true })));
  assert.equal(row.source, "other_projects");
  assert.equal(row.seconds_per_unit, 9);
  assert.equal(row.n_sessions, 4);
});

test("speed tier 4: plan_x_ratio (plan speed × measured plan ratio)", () => {
  const forecast = computeForecast(tierFixture({ ratio: true }));
  assert.equal(forecast.plan_ratio.ratio, 3);
  assert.equal(forecast.plan_ratio.basis, "main");
  assert.equal(forecast.plan_ratio.sample_based, false);
  const row = waffleRow(forecast);
  assert.equal(row.source, "plan_x_ratio");
  assert.equal(row.seconds_per_unit, 18, "plan 6 s × 3");
});

test("speed tier 5: plan; tier 6: none (units left but no way to price them)", () => {
  assert.equal(waffleRow(computeForecast(tierFixture())).source, "plan");
  const forecast = computeForecast(tierFixture({ plan: false }));
  const row = waffleRow(forecast);
  assert.equal(row.source, "none");
  assert.equal(row.seconds_per_unit, null);
  assert.equal(row.minutes_left, null);
  assert.deepEqual(forecast.unpriced_types, ["waffle"]);
});

// ── Work left, available days, health ───────────────────────────────────────

test("unit-less open tasks add estimate × (1 − ticked share); closed tasks add nothing", () => {
  const tasks = [task("a", { estimated_minutes: 40 }), task("b", { estimated_minutes: 100, status: "Done" }), task("c", { estimated_minutes: 30 })];
  const items = [item("a1", "a", null, null, { is_done: true }), item("a2", "a", null, null), item("a3", "a", null, null), item("a4", "a", null, null)];
  const forecast = computeForecast(input({ tasks, items }));
  assert.equal(forecast.unitless_minutes_left, 60, "40 × 3/4 + 30");
  assert.equal(forecast.work_left_minutes, 60);
});

test("available days start at the earliest planned start of a section that still has unit work, never before today", () => {
  const tasks = [task("later", { section_id: "s2", estimated_minutes: 10 }), task("done", { section_id: "s1", status: "Done" })];
  const items = [item("x", "later", 10, "sc"), item("y", "done", 10, "sc")];
  const sections = [{ id: "s1", planned_start: "2026-10-01" }, { id: "s2", planned_start: "2026-10-20" }];
  let forecast = computeForecast(input({ tasks, items, sections, project: { unit_label: "x", target_date: "2026-10-29", pace_settings: null } }));
  assert.equal(forecast.available_from, "2026-10-20", "s1 has no unit work left, so s2's start counts");
  assert.equal(forecast.available_days, 10);
  sections[1].planned_start = "2026-09-01";
  forecast = computeForecast(input({ tasks, items, sections, project: { unit_label: "x", target_date: "2026-10-29", pace_settings: null } }));
  assert.equal(forecast.available_from, "2026-10-04", "never before today");
  assert.equal(forecast.available_days, 26);
  forecast = computeForecast(input({ tasks, items, project: { unit_label: "x", target_date: null, pace_settings: null } }));
  assert.equal(forecast.available_days, null);
  assert.equal(forecast.needed_minutes_per_day, null);
});

test("health: insufficient_data under 3 counted sessions; then on_track / behind by projected finish", () => {
  const tasks = [task("t", { work_type: "sc" })];
  const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, "t", 60, null, { is_done: i < 3 }));
  const mk = (n, minutes) => Array.from({ length: n }, (_, i) => session({ task_id: "t", minutes, item_ids: [`i${i}`], session_date: "2026-10-04" }));
  const base = { tasks, items, project: { unit_label: "x", target_date: "2026-10-10", pace_settings: null } };
  // 2 counted + many excluded → still insufficient.
  const excluded = mk(5, 60).map((s) => ({ ...s, exclude_from_stats: true, item_ids: [] }));
  assert.equal(computeForecast(input({ ...base, sessions: [...mk(2, 60), ...excluded] })).health, "insufficient_data");
  // 3 counted at 60 s/unit: 7 rows × 60 units × 60 s = 420 min left; cadence 180/14 ≈ 12.9 → 33 days → behind.
  const behind = computeForecast(input({ ...base, sessions: mk(3, 60) }));
  assert.equal(behind.health, "behind");
  assert.equal(behind.projected_finish, "2026-11-06");
  assert.equal(behind.slack_days, -27);
  // Same but a far target → on track.
  const onTrack = computeForecast(input({ ...base, project: { ...base.project, target_date: "2026-12-31" }, sessions: mk(3, 60) }));
  assert.equal(onTrack.health, "on_track");
  assert.ok(onTrack.slack_days > 0);
});

// ── Size fit ────────────────────────────────────────────────────────────────

test("size fit: widest width per cadence, minutes(w) = fixed + scaled × w ÷ current", () => {
  const tasks = [task("body", { estimated_minutes: 100 }), task("unitless", { estimated_minutes: 50 })];
  const items = [item("b1", "body", 100, "sc")];
  const project = {
    unit_label: "stitches",
    target_date: "2026-10-13", // 10 days
    pace_settings: { size: { label: "width", current: 100, step: 10, offset: 0, min: 20, unit: "stitches", work_types: ["sc"] } },
  };
  const forecast = computeForecast(input({ tasks, items, project }));
  // scaled 100 min (plan 60 s × 100), fixed 50. At 60/day: budget 600 → all widths fit → 100.
  assert.equal(forecast.size_fit.scaled_minutes_left, 100);
  assert.equal(forecast.size_fit.fixed_minutes_left, 50);
  assert.deepEqual(forecast.size_fit.fits.map((f) => [f.minutes_per_day, f.source, f.widest]), [[60, "fixed", 100], [90, "fixed", 100], [120, "fixed", 100]]);
  assert.equal(forecast.size_fit.widths[0].size, 20);
  assert.equal(forecast.size_fit.widths.at(-1).minutes_left, 150);
});

test("size fit: none fits → null; a done main-scope row of a scaled type → locked", () => {
  const project = {
    unit_label: "stitches",
    target_date: "2026-10-04", // 1 day
    pace_settings: { size: { label: "width", current: 100, step: 10, offset: 0, min: 20, unit: "stitches", work_types: ["sc"] } },
  };
  const tasks = [task("body", { estimated_minutes: 480 }), task("unitless", { estimated_minutes: 200 })];
  const items = [item("b1", "body", 100, "sc"), item("b2", "body", 100, "sc")];
  const forecast = computeForecast(input({ tasks, items, project }));
  // fixed 200 alone exceeds 1 day × 120.
  assert.ok(forecast.size_fit.fits.every((fit) => fit.widest === null));
  assert.match(formatForecastLine(forecast), /not even a 20-stitch width fits/);
  items[0].is_done = true;
  const locked = computeForecast(input({ tasks, items, project }));
  assert.equal(locked.size_fit, null);
  assert.equal(locked.size_fit_reason, "locked");
  // A done SAMPLE row doesn't lock it.
  const sampleDone = computeForecast(input({
    tasks: [...tasks, task("sw", { is_sample: true })],
    items: [item("b1", "body", 100, "sc"), item("s1", "sw", 10, "sc", { is_done: true })],
    project,
  }));
  assert.notEqual(sampleDone.size_fit, null);
});

test("size fit includes the measured cadence when there is one", () => {
  const forecast = computeForecast(blanket());
  assert.deepEqual(forecast.size_fit.fits.map((f) => f.source), ["measured", "fixed", "fixed", "fixed"]);
});

// ── The blanket (acceptance shape) ─────────────────────────────────────────

test("blanket on Oct 4: 27.1 s/stitch from the swatch, Oct 3 and row 10 excluded, cadence 26.7, ratio ≈ 3.5×", () => {
  const forecast = computeForecast(blanket());
  const colorwork = forecast.work_left.find((row) => row.work_type === "colorwork-dc");
  assert.equal(colorwork.source, "measured_sample");
  near(colorwork.seconds_per_unit, 27.1, 0.05);
  assert.equal(colorwork.n_sessions, 1);
  assert.equal(forecast.counted_sessions, 1);
  assert.equal(forecast.excluded_sessions, 2);
  near(forecast.cadence_minutes_per_day, 26.7, 0.05, "374 ÷ 14");
  near(forecast.plan_ratio.ratio, 3.52, 0.01);
  assert.equal(forecast.plan_ratio.basis, "sample");
  for (const type of ["waffle", "plain-dc", "sc", "chain"]) {
    assert.equal(forecast.work_left.find((row) => row.work_type === type).source, "plan_x_ratio", type);
  }
  assert.equal(forecast.health, "insufficient_data");
  assert.notEqual(forecast.size_fit, null, "body not started");
  assert.equal(forecast.available_days, 63);
  near(forecast.needed_minutes_per_day, 198, 1);
  assert.equal(forecast.size_fit.fits.find((f) => f.minutes_per_day === 60).widest, 51);
  const line = formatForecastLine(forecast, "colorwork-dc");
  assert.match(line, /^Colorwork dc 27\.1 s\/stitch \(swatch, 1 session\) · needs 19[78] min\/day to finish by Dec 5 · at 60 min\/day a 51-stitch width fits/);
});

// ── Session input helpers ───────────────────────────────────────────────────

test("rows shorthand: ranges, lists, 'row N', en dashes; bad input is an error", () => {
  assert.deepEqual(parse.parseRowsSpec("11-15").value, [11, 12, 13, 14, 15]);
  assert.deepEqual(parse.parseRowsSpec("rows 11–15").value, [11, 12, 13, 14, 15]);
  assert.deepEqual(parse.parseRowsSpec("11, 12").value, [11, 12]);
  assert.deepEqual(parse.parseRowsSpec("row 10").value, [10]);
  assert.deepEqual(parse.parseRowsSpec("16 to 17 and 19").value, [16, 17, 19]);
  assert.equal(parse.parseRowsSpec("15-11").ok, false);
  assert.equal(parse.parseRowsSpec("the green ones").ok, false);
});

test("row matching: 'Row N' prefix only, never guesses (missing and ambiguous are reported)", () => {
  const items = [
    { id: "a", task_id: "t1", text: "Row 10 (band row 4): 5-wide row" },
    { id: "b", task_id: "t1", text: "Row 100: waffle Row B" },
    { id: "c", task_id: "t2", text: "Row 3: waffle Row A" },
    { id: "d", task_id: "t3", text: "row 3: waffle Row A (pair 1)" },
    { id: "e", task_id: "t3", text: "Count the last row: 27 stitches" },
  ];
  assert.equal(parse.itemRowNumber("Row 10 (band row 4)"), 10);
  assert.equal(parse.itemRowNumber("waffle Row A"), null);
  const match = parse.matchRows([10, 3, 7], items);
  assert.deepEqual(match.item_ids, ["a"], "Row 10 is not Row 100");
  assert.deepEqual(match.missing, [7]);
  assert.deepEqual(match.ambiguous.map((entry) => [entry.row, entry.items.map((i) => i.id)]), [[3, ["c", "d"]]]);
});

test("times: ET clock times convert to UTC across DST; minutes and start–end must agree within 1 minute", () => {
  assert.equal(parse.parseClockTime("13:38"), 818);
  assert.equal(parse.parseClockTime("1:38 PM"), 818);
  assert.equal(parse.parseClockTime("12:05 am"), 5);
  assert.equal(parse.parseClockTime("13"), null, "a bare hour needs am/pm");
  assert.equal(parse.etLocalToUtcIso("2026-10-04", 818), "2026-10-04T17:38:00.000Z", "EDT");
  assert.equal(parse.etLocalToUtcIso("2026-12-05", 818), "2026-12-05T18:38:00.000Z", "EST");
  const timing = parse.resolveSessionTiming({ date: "2026-10-04", start: "13:38", end: "2:39 PM" });
  assert.deepEqual(timing.value, { session_date: "2026-10-04", started_at: "2026-10-04T17:38:00.000Z", ended_at: "2026-10-04T18:39:00.000Z", minutes: 61 });
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", start: "13:38", end: "14:39", minutes: 62 }).ok, true, "within 1");
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", start: "13:38", end: "14:39", minutes: 50 }).ok, false);
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", start: "14:00", end: "13:00" }).ok, false);
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04" }).ok, false, "minutes or start+end");
  const defaulted = parse.resolveSessionTiming({ minutes: 20 }, new Date("2026-10-05T02:30:00Z"));
  assert.equal(defaulted.value.session_date, "2026-10-04", "10:30 PM ET is still Oct 4");
  const iso = parse.resolveSessionTiming({ start: "2026-10-05T01:00:00Z", minutes: 30 });
  assert.equal(iso.value.session_date, "2026-10-04", "an ISO start sets the ET date");
});

// ── Backfill (dry-run plan) ─────────────────────────────────────────────────

test("backfill: TIMELOG comments parse (aliases, clean=no → excluded with the right reason)", () => {
  const row10 = backfill.parseTimelogComment("TIMELOG | 2026-10-04 | row 10 | type=tree-dc-colorwork | stitches=27 | start=13:20 | end=13:33 | minutes=13 | clean=no | note=upper bound; includes reading instructions for the row");
  assert.deepEqual([row10.date, row10.rows, row10.start, row10.end, row10.minutes, row10.exclude, row10.excludeReason, row10.workType, row10.stitches],
    ["2026-10-04", [10], 800, 813, 13, true, "reading-instructions", "colorwork-dc", 27]);
  const rows = backfill.parseTimelogComment("TIMELOG | 2026-10-04 | rows 11-15 | type=tree-dc-colorwork | stitches=135 | start=13:38 | end=14:39 | minutes=61 | clean=unknown | note=wall-clock");
  assert.deepEqual([rows.rows, rows.exclude, rows.flags], [[11, 12, 13, 14, 15], false, ["clean=unknown (counted)"]]);
  assert.equal(backfill.parseTimelogComment("TIMELOG | 2026-10-04 | row 9 | minutes=5 | clean=no | note=dropped a stitch").excludeReason, "unclean");
  assert.equal(backfill.parseTimelogComment("Brent: nice"), null);
});

test("backfill: 'Session ·' comments parse (year from the comment, shared PM, optional learning and minutes)", () => {
  const parsed = backfill.parseSessionComment("Session · Oct 5 · 7:40–8:42 PM · 62 min · rows 11–12 · learning · note: first body rows · slow", "2026-10-06T01:00:00Z");
  assert.deepEqual([parsed.date, parsed.start, parsed.end, parsed.minutes, parsed.rows, parsed.exclude, parsed.excludeReason, parsed.note],
    ["2026-10-05", 19 * 60 + 40, 20 * 60 + 42, 62, [11, 12], true, "learning", "first body rows · slow"]);
  const noon = backfill.parseSessionComment("Session · Oct 6 · 11:30–12:15 PM · row 13", "2026-10-06T18:00:00Z");
  assert.deepEqual([noon.start, noon.end, noon.minutes, noon.exclude], [11 * 60 + 30, 12 * 60 + 15, null, false]);
  assert.ok("error" in backfill.parseSessionComment("Session · sometime · 20 min", "2026-10-06T18:00:00Z"));
});

test("backfill plan: tags, Oct 3 session, comment sessions, completed_at, unmatched lines", () => {
  const items = (prefix, texts, doneUpTo = -1) => texts.map((text, index) => ({ id: `${prefix}-${index}`, text, is_done: index <= doneUpTo, sort_order: index }));
  const snapshot = {
    project: { id: backfill.BLANKET_PROJECT_ID, name: "Blanket", target_date: "2026-12-05" },
    sections: [
      { id: "sw", name: "1. Swatch", planned_start: "2026-10-03", planned_end: "2026-10-10" },
      { id: "body", name: "3. Blanket body", planned_start: "2026-10-19", planned_end: "2026-11-29" },
      { id: "fin", name: "4. Finishing", planned_start: "2026-11-30", planned_end: "2026-12-05" },
    ],
    tasks: [
      { id: "t1", title: "Step 1: Warm-up on a scrap chain", status: "Done", section_id: "sw", estimated_minutes: 30, checklist: items("t1", ["Chain 15 and work 2 rows of dc"], 0), comments: [] },
      { id: "t2", title: "Step 2: Swatch rows 1–6", status: "Done", section_id: "sw", estimated_minutes: 60,
        checklist: items("t2", ["Chain 28", "Row 1: sc across (27 stitches)", "Row 2: waffle setup row, dc across", "Row 3: waffle Row A", "Count the last row: 27 stitches"], 4), comments: [] },
      { id: "t3", title: "Step 3: Swatch rows 7–19, tree band", status: "Planned", section_id: "sw", estimated_minutes: 150,
        checklist: items("t3", ["Row 7 (band row 1): dc across in cream", "Row 8 (band row 2): 3-wide trunk row. Join green", "Row 9 (band row 3): 7-wide row", "Row 10 (band row 4): 5-wide row", "Row 11 (band row 5): 3-wide row", "Row 12 (band row 6): 1-wide tip row, shifted", "Row 13: something odd"], 4),
        comments: [
          { id: "c1", created_at: "2026-10-04T17:37:43Z", content: "TIMELOG | 2026-10-04 | row 10 | type=tree-dc-colorwork | stitches=27 | start=13:20 | end=13:33 | minutes=13 | clean=no | note=includes reading instructions" },
          { id: "c2", created_at: "2026-10-04T18:39:31Z", content: "TIMELOG | 2026-10-04 | rows 11-12 | type=tree-dc-colorwork | stitches=60 | start=13:38 | end=14:39 | minutes=61 | clean=unknown | note=x" },
          { id: "c3", created_at: "2026-10-06T01:00:00Z", content: "Session · Oct 5 · 7:40–8:42 PM · rows 13 · note: odd row" },
          { id: "c4", created_at: "2026-10-06T01:00:00Z", content: "Session · Oct 5 · 7:40–8:42 PM · rows 40" },
        ] },
      { id: "t9", title: "Step 9: Foundation chain and row 1", status: "Backlog", section_id: "body", estimated_minutes: 60,
        checklist: items("t9", ["Chain 196", "Row 1: sc in the 2nd chain from the hook and across", "Count again", "Place markers at stitch 8"]), comments: [] },
      { id: "t20", title: "Step 20: Border round 1", status: "Backlog", section_id: "fin", estimated_minutes: 90, checklist: items("t20", ["First corner: 3 sc"]), comments: [] },
      { id: "t22", title: "Step 22: Weave in the ends", status: "Backlog", section_id: "fin", estimated_minutes: 90, checklist: items("t22", ["Green ends"]), comments: [] },
    ],
    existing_source_refs: ["c1"],
  };
  const plan = backfill.buildBackfillPlan(snapshot);
  const tag = (id) => plan.item_tags.find((entry) => entry.item_id === id);
  assert.deepEqual([tag("t2-0").work_type, tag("t2-0").unit_count], ["chain", 28]);
  assert.deepEqual([tag("t2-1").work_type, tag("t2-1").unit_count], ["sc", 27]);
  assert.deepEqual([tag("t2-2").work_type, tag("t3-0").work_type, tag("t3-1").work_type, tag("t3-5").work_type], ["plain-dc", "plain-dc", "colorwork-dc", "colorwork-dc"]);
  assert.deepEqual([tag("t9-0").unit_count, tag("t9-1").work_type, tag("t9-1").unit_count], [196, "sc", 195]);
  assert.equal(tag("t1-0"), undefined, "the warm-up has no units");
  assert.equal(plan.task_updates.find((update) => update.task_id === "t3").is_sample, true);
  assert.equal(plan.task_updates.find((update) => update.task_id === "t9").is_sample, false);
  assert.deepEqual(plan.task_updates.find((update) => update.task_id === "t20"), { task_id: "t20", title: "Step 20: Border round 1", is_sample: false, unit_count: 970, work_type: "sc", width: null });
  assert.equal(plan.task_updates.some((update) => update.task_id === "t22"), false);
  assert.deepEqual(plan.unmatched.map((entry) => entry.text), ["Row 13: something odd", "Session · Oct 5 · 7:40–8:42 PM · rows 40"]);
  assert.ok(plan.rules_without_hits.includes("Border round 2 → task sc 980"), "rules that never hit are reported");

  const oct3 = plan.sessions.find((entry) => entry.source_ref === "brent-chat-2026-10-04-oct3");
  assert.deepEqual([oct3.task_id, oct3.minutes, oct3.exclude_from_stats, oct3.exclude_reason], [null, 300, true, "learning"]);
  assert.deepEqual(oct3.item_ids.sort(), ["t2-0", "t2-1", "t2-2", "t2-3", "t3-0", "t3-1", "t3-2"].sort(), "step 2 unit rows + step 3 rows 7–9");
  const c1 = plan.sessions.find((entry) => entry.source_ref === "c1");
  assert.deepEqual([c1.exclude_from_stats, c1.exclude_reason, c1.already_stored, c1.item_ids], [true, "reading-instructions", true, ["t3-3"]]);
  const c2 = plan.sessions.find((entry) => entry.source_ref === "c2");
  assert.deepEqual([c2.minutes, c2.exclude_from_stats, c2.started_at, c2.ended_at], [61, false, "2026-10-04T17:38:00.000Z", "2026-10-04T18:39:00.000Z"]);
  assert.ok(plan.warnings.some((warning) => /c2: stitches=60 but its rows are tagged 54/.test(warning)), "stitches= is cross-checked");
  const c3 = plan.sessions.find((entry) => entry.source_ref === "c3");
  assert.deepEqual([c3.session_date, c3.minutes, c3.exclude_from_stats], ["2026-10-05", 62, false]);
  assert.ok(plan.warnings.some((warning) => /c3: row "Row 13: something odd" is linked but not ticked/.test(warning)));
  // Done linked rows get completed_at: the session end, or 23:59 ET for Oct 3.
  const completed = Object.fromEntries(plan.completed_at_updates.map((entry) => [entry.item_id, entry.completed_at]));
  assert.equal(completed["t3-4"], "2026-10-04T18:39:00.000Z");
  assert.equal(completed["t2-0"], "2026-10-04T03:59:00.000Z", "Oct 3 23:59 EDT");
  assert.equal(completed["t3-5"], undefined, "not done → no completed_at");
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

test("unpriced units: no speed for an unfinished type → time, finish, needed, size fit and on-track health are unknown, never 'no work left'", () => {
  const project = {
    unit_label: "stitches",
    target_date: "2026-12-05",
    pace_settings: { size: { label: "width", current: 195, step: 12, offset: 3, min: 27, unit: "stitches", work_types: ["sc"] } },
  };
  const tasks = [task("border", { unit_count: 100, work_type: "sc" }), task("other", { estimated_minutes: 30 })];
  const items = ["o1", "o2", "o3", "o4"].map((id) => item(id, "other", 10, "waffle", { is_done: id !== "o4" }));
  const sessions = ["o1", "o2", "o3"].map((id) => session({ task_id: "other", minutes: 5, item_ids: [id] }));
  const forecast = computeForecast(input({ project, tasks, items, sessions }));
  assert.deepEqual(forecast.unpriced_units, [{ work_type: "sc", units_left: 100 }]);
  assert.deepEqual(forecast.unpriced_types, ["sc"]);
  assert.equal(forecast.work_left_minutes, null);
  assert.equal(forecast.work_left_hours, null);
  assert.equal(forecast.projected_finish, null);
  assert.equal(forecast.slack_days, null);
  assert.equal(forecast.needed_minutes_per_day, null);
  assert.equal(forecast.plan_cadence_minutes_per_day, null);
  assert.equal(forecast.size_fit, null);
  assert.equal(forecast.size_fit_reason, "unpriced_units");
  assert.equal(forecast.health, "unknown", "3 counted sessions, but the finish can't be known");
  assert.equal(forecast.priced_work_left_minutes, 5, "the priced part is still reported: 10 waffle left × 30 s measured");
  const line = formatForecastLine(forecast);
  assert.match(line, /100 sc stitches have no speed yet; log a session or set an estimate/);
  assert.doesNotMatch(line, /no work left|needs \d+ min\/day|on track|behind/);
  // Under 3 counted sessions it stays insufficient_data.
  assert.equal(computeForecast(input({ project, tasks, items, sessions: sessions.slice(0, 2) })).health, "insufficient_data");
});

test("Missed and Parked tasks don't count as work left (task-level or row units), and don't lock the size", () => {
  const tasks = [
    task("missed", { status: "Missed", unit_count: 500, work_type: "sc", estimated_minutes: 50 }),
    task("parked", { status: "Parked", estimated_minutes: 50 }),
    task("parkedNoUnits", { status: "Parked", estimated_minutes: 40 }),
    task("open", { estimated_minutes: 10 }),
  ];
  const items = [item("p1", "parked", 100, "sc"), item("x1", "open", 10, "sc")];
  const project = { unit_label: "stitches", target_date: "2026-10-13", pace_settings: { size: { label: "width", current: 100, step: 10, offset: 0, min: 20, unit: "stitches", work_types: ["sc"] } } };
  const forecast = computeForecast(input({ tasks, items, project }));
  assert.deepEqual(forecast.work_left.map((row) => [row.work_type, row.units_left]), [["sc", 10]]);
  assert.equal(forecast.unitless_minutes_left, 0, "a parked task without units adds nothing");
  assert.notEqual(forecast.size_fit, null, "parked/missed units are not 'done', so they don't lock the size");
});

test("Session-comment year: the year that puts the date on or before the comment", () => {
  const dec30 = backfill.parseSessionComment("Session · Dec 30 · 20 min · row 1", "2027-01-02T15:00:00Z");
  assert.equal(dec30.date, "2026-12-30");
  const same = backfill.parseSessionComment("Session · Oct 5 · 20 min · row 1", "2026-10-06T01:00:00Z");
  assert.equal(same.date, "2026-10-05", "Oct 5 8 PM ET comment on Oct 5");
  const sameDay = backfill.parseSessionComment("Session · Jan 2 · 20 min · row 1", "2027-01-02T15:00:00Z");
  assert.equal(sameDay.date, "2027-01-02");
});

test("timing: fractional minutes are rejected; date and an ISO start must agree; re-anchoring keeps the ET clock time", () => {
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", minutes: 0.6 }).ok, false);
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", minutes: 1440.4 }).ok, false);
  assert.equal(parse.resolveSessionTiming({ date: "2026-10-04", minutes: 61 }).ok, true);
  const mismatch = parse.resolveSessionTiming({ date: "2026-10-03", start: "2026-10-04T17:38:00Z", minutes: 30 });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /2026-10-04.*2026-10-03|date/);
  const endOnly = parse.resolveSessionTiming({ date: "2026-10-03", end: "2026-10-04T18:39:00Z", minutes: 30 });
  assert.equal(endOnly.ok, false, "with no start, the end must be on the date");
  const lateNight = parse.resolveSessionTiming({ date: "2026-10-04", start: "2026-10-05T03:30:00Z", end: "2026-10-05T04:30:00Z" });
  assert.equal(lateNight.ok, true, "11:30 PM–12:30 AM ET starts on the date");
  assert.equal(parse.reanchorInstant("2026-10-04T17:38:00.000Z", "2026-10-04", "2026-10-03"), "2026-10-03T17:38:00.000Z");
  assert.equal(parse.reanchorInstant("2026-11-02T18:38:00.000Z", "2026-11-02", "2026-10-30"), "2026-10-30T17:38:00.000Z", "1:38 PM ET across the DST change");
  assert.equal(parse.reanchorInstant("2026-10-05T04:30:00.000Z", "2026-10-04", "2026-10-03"), "2026-10-04T04:30:00.000Z", "an end past midnight moves with its day");
  // A date-only move keeps the start's clock time and the minutes (the end follows the start), even across the DST change.
  assert.deepEqual(
    parse.reanchorSession({ started_at: "2026-10-31T04:30:00.000Z", ended_at: "2026-10-31T07:30:00.000Z", minutes: 180 }, "2026-10-31", "2026-11-01"),
    { started_at: "2026-11-01T04:30:00.000Z", ended_at: "2026-11-01T07:30:00.000Z" }
  );
  assert.deepEqual(
    parse.reanchorSession({ started_at: null, ended_at: "2026-10-04T18:39:00.000Z", minutes: 61 }, "2026-10-04", "2026-10-03"),
    { started_at: null, ended_at: "2026-10-03T18:39:00.000Z" }
  );
});

// ── Slice 2: perimeter, gauge, lane projections ─────────────────────────────

const BORDER_ID = "00000000-0000-4000-8000-0000000000b1";
const BORDER2_ID = "00000000-0000-4000-8000-0000000000b2";
const SIZE_BASE = { label: "width", current: 195, step: 12, offset: 3, min: 27, unit: "stitches", work_types: ["waffle", "sc"] };

/**
 * A blanket-shaped project priced entirely by plan speed (6 s per unit), so the
 * arithmetic is exact: body 100 min (waffle, scales with width), row 157 20 min
 * (sc, scales with width), border 100 min (sc, scales with the perimeter).
 * Today Oct 4, target Dec 5 → 63 available days.
 */
function perimeterProject(sizeExtra = {}, projectExtra = {}) {
  return input({
    project: {
      unit_label: "stitches",
      target_date: "2026-12-05",
      pace_settings: { size: { ...SIZE_BASE, perimeter: { task_ids: [BORDER_ID], side: 300 }, ...sizeExtra } },
      ...projectExtra,
    },
    tasks: [
      task("body", { unit_count: 1000, work_type: "waffle", estimated_minutes: 100 }),
      task("row157", { unit_count: 200, work_type: "sc", estimated_minutes: 20 }),
      task(BORDER_ID, { unit_count: 1000, work_type: "sc", estimated_minutes: 100 }),
    ],
  });
}

test("perimeter: border units scale by (w+side)/(current+side) and stay out of the linear scaling; row 157 sc stays linear", () => {
  const forecast = computeForecast(perimeterProject());
  const fit = forecast.size_fit;
  assert.notEqual(fit, null);
  near(fit.scaled_minutes_left, 120, 0.1, "waffle 100 + row 157 sc 20 scale linearly (sc is in work_types but the border is not)");
  near(fit.perimeter_minutes_left, 100, 0.1, "the border task's minutes");
  near(fit.fixed_minutes_left, 0, 0.1);
  const at = (size) => fit.widths.find((entry) => entry.size === size);
  // 120 × 27/195 + 100 × (27+300)/(195+300) = 16.6 + 66.1
  near(at(27).minutes_left, 83, 0.6, "27 wide: border barely shrinks (the sides stay), plain linear scaling would say 30");
  near(at(195).minutes_left, 220, 0.6, "full width is the whole plan");
  near(at(99).minutes_left, 120 * 99 / 195 + 100 * 399 / 495, 0.6);
  near(at(27).needed_minutes_per_day, 83 / 63, 0.05, "needed per day at 27 wide");
  // Without the perimeter the same project scales everything linearly: 220 × 27/195 = 30.5.
  const linear = computeForecast(perimeterProject({ perimeter: undefined })).size_fit;
  near(linear.widths.find((entry) => entry.size === 27).minutes_left, 30, 0.6, "no perimeter → linear, as in slice 1");
  assert.equal(linear.perimeter_minutes_left, 0);
});

test("perimeter: every row of a perimeter task is excluded from the linear scaling, whatever its type", () => {
  const base = perimeterProject();
  const tasks = [
    ...base.tasks.filter((entry) => entry.id !== BORDER_ID),
    task(BORDER_ID, { estimated_minutes: 100 }),
    task(BORDER2_ID, { unit_count: 500, work_type: "sc", estimated_minutes: 50 }),
  ];
  const items = [item("b-r1", BORDER_ID, 600, "waffle"), item("b-r2", BORDER_ID, 400, "sc")];
  const project = {
    ...base.project,
    pace_settings: { size: { ...SIZE_BASE, perimeter: { task_ids: [BORDER_ID, BORDER2_ID], side: 300 } } },
  };
  const fit = computeForecast({ ...base, tasks, items, project }).size_fit;
  near(fit.perimeter_minutes_left, 150, 0.1, "rows of the border task and the second border task");
  near(fit.scaled_minutes_left, 120, 0.1);
});

test("perimeter and gauge settings: shapes are validated, with a reason", () => {
  const ok = parsePaceSettings({ size: { ...SIZE_BASE, perimeter: { task_ids: [BORDER_ID], side: 318 }, gauge: { units: 13, length: 4, length_unit: "in" } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.size.perimeter, { task_ids: [BORDER_ID], side: 318 });
  assert.deepEqual(ok.value.size.gauge, { units: 13, length: 4, length_unit: "in" });
  const plain = parsePaceSettings({ size: SIZE_BASE });
  assert.equal(plain.ok, true);
  assert.equal(plain.value.size.perimeter, undefined, "both are optional");
  assert.equal(plain.value.size.gauge, undefined);
  const bad = (size, pattern) => {
    const result = parsePaceSettings({ size: { ...SIZE_BASE, ...size } });
    assert.equal(result.ok, false, JSON.stringify(size));
    if (pattern) assert.match(result.error, pattern);
  };
  bad({ perimeter: { task_ids: ["not-a-uuid"], side: 300 } }, /task_ids.*uuid/i);
  bad({ perimeter: { task_ids: [], side: 300 } }, /task_ids/);
  bad({ perimeter: { task_ids: [BORDER_ID], side: 0 } }, /side.*positive/);
  bad({ perimeter: { task_ids: [BORDER_ID], side: -5 } }, /side/);
  bad({ perimeter: { task_ids: [BORDER_ID], side: "318" } }, /side/);
  bad({ perimeter: { task_ids: [BORDER_ID] } }, /side/);
  bad({ perimeter: { task_ids: [BORDER_ID], side: 300, extra: 1 } }, /unknown/);
  bad({ perimeter: [BORDER_ID] }, /perimeter/);
  bad({ gauge: { units: 0, length: 4, length_unit: "in" } }, /gauge\.units/);
  bad({ gauge: { units: 18, length: 0, length_unit: "in" } }, /gauge\.length/);
  bad({ gauge: { units: 18, length: 4, length_unit: "ft" } }, /length_unit/);
  bad({ gauge: { units: 18, length: 4 } }, /length_unit/);
  bad({ gauge: { units: 18, length: 4, length_unit: "in", extra: 1 } }, /unknown/);
});

test("gauge: each width returns its length (w ÷ units × length, 1 decimal) with the unit; no gauge, no length", () => {
  const withGauge = computeForecast(perimeterProject({ gauge: { units: 18, length: 4, length_unit: "in" } })).size_fit;
  const at = (size) => withGauge.widths.find((entry) => entry.size === size);
  assert.equal(at(195).length, 43.3, "195 ÷ 18 × 4");
  assert.equal(at(27).length, 6);
  assert.equal(at(27).length_unit, "in");
  assert.equal(at(39).length, 8.7);
  const metric = computeForecast(perimeterProject({ gauge: { units: 20, length: 10, length_unit: "cm" } })).size_fit;
  assert.equal(metric.widths.find((entry) => entry.size === 195).length, 97.5);
  assert.equal(metric.widths.find((entry) => entry.size === 195).length_unit, "cm");
  // The widest-fitting width of each cadence carries its length too, and so does the plan's full width.
  const fits90 = withGauge.fits.find((fit) => fit.source === "fixed" && fit.minutes_per_day === 90);
  assert.equal(fits90.widest_length, Math.round((fits90.widest / 18) * 4 * 10) / 10);
  assert.equal(withGauge.current_length, 43.3);
  assert.equal(withGauge.length_unit, "in");
  const none = computeForecast(perimeterProject()).size_fit;
  assert.equal("length" in none.widths[0], false, "no gauge → no length key");
  assert.equal("length_unit" in none.widths[0], false);
  assert.equal(none.current_length, null);
  assert.equal(none.length_unit, null);
  assert.equal(none.fits[0].widest_length, null);
});

/** Four lanes priced by plan speed (6 s per unit) with three counted sittings at 6 min a day. */
function lanes(extra = {}) {
  const sessions = [1, 2, 3].map((n) => session({ id: `ls${n}`, session_date: "2026-10-04", minutes: 28 }));
  return input({
    project: { unit_label: "stitches", target_date: "2026-12-05", pace_settings: null },
    sections: [
      { id: "sec-c", planned_start: "2026-11-30", planned_end: "2026-12-05" },
      { id: "sec-a", planned_start: "2026-10-04", planned_end: "2026-10-10" },
      { id: "sec-b", planned_start: "2026-10-19", planned_end: "2026-11-29" },
      { id: "sec-d", planned_start: "2026-12-06", planned_end: "2026-12-10" },
    ],
    tasks: [
      task("tA", { unit_count: 600, work_type: "sc", estimated_minutes: 60, section_id: "sec-a" }),
      task("tB", { unit_count: 300, work_type: "sc", estimated_minutes: 30, section_id: "sec-b" }),
      task("tC", { unit_count: 60, work_type: "sc", estimated_minutes: 6, section_id: "sec-c" }),
      task("tU", { estimated_minutes: 6, section_id: "sec-c" }),
      task("tD", { estimated_minutes: 20, section_id: "sec-d" }),
    ],
    sessions,
    ...extra,
  });
}
const laneOf = (forecast, id) => forecast.sections.find((entry) => entry.section_id === id);

test("sections: a running clock walks planned_start order, leaves gaps between sections, and ceil(work ÷ cadence) days each", () => {
  const forecast = computeForecast(lanes());
  assert.equal(forecast.cadence_minutes_per_day, 6, "84 min ÷ 14 days");
  assert.deepEqual(forecast.sections.map((entry) => entry.section_id), ["sec-a", "sec-b", "sec-c", "sec-d"], "planned_start order");
  const a = laneOf(forecast, "sec-a");
  assert.deepEqual(
    [a.planned_start, a.planned_end, a.units_left, a.work_left_minutes, a.projected_end, a.health, a.health_basis],
    ["2026-10-04", "2026-10-10", 600, 60, "2026-10-14", "behind", "time"],
    "starts today, 60 min ÷ 6 = 10 days → Oct 14, past Oct 10"
  );
  const b = laneOf(forecast, "sec-b");
  assert.deepEqual([b.projected_end, b.health, b.health_basis], ["2026-10-24", "on_track", "time"], "the clock is Oct 14 but B starts at its planned Oct 19: 5 more days");
  const c = laneOf(forecast, "sec-c");
  assert.equal(c.work_left_minutes, 12, "its unit work 6 min plus the unit-less task's estimate 6 min");
  assert.deepEqual([c.units_left, c.projected_end, c.health], [60, "2026-12-02", "on_track"], "starts Nov 30 (gap), 12 ÷ 6 = 2 days");
  const d = laneOf(forecast, "sec-d");
  assert.deepEqual([d.units_left, d.projected_end, d.health, d.health_basis], [0, null, null, "rows"], "no unit work left → row count, and it doesn't move the clock");
});

test("sections: cadence 0 → behind with no projected end; fewer than 3 counted sittings → row-count basis; unpriced units → unknown", () => {
  const old = [1, 2, 3].map((n) => session({ id: `old${n}`, session_date: "2026-08-01", minutes: 30 }));
  const idle = computeForecast(lanes({ sessions: old }));
  assert.equal(idle.cadence_minutes_per_day, 0);
  const idleA = laneOf(idle, "sec-a");
  assert.deepEqual([idleA.projected_end, idleA.health, idleA.health_basis], [null, "behind", "time"], "cadence 0 is behind");
  assert.equal(laneOf(idle, "sec-c").projected_end, null);
  assert.equal(laneOf(idle, "sec-d").health, null);

  const few = computeForecast(lanes({ sessions: [session({ id: "only", session_date: "2026-10-04", minutes: 60 })] }));
  const fewA = laneOf(few, "sec-a");
  assert.deepEqual([fewA.health, fewA.health_basis], [null, "rows"], "1 counted sitting: not enough for a time call");
  assert.equal(fewA.projected_end, "2026-10-18", "the projection is still returned (60 min ÷ 4.3 a day = 14 days)");
  const excluded = computeForecast(lanes({ sessions: [1, 2, 3].map((n) => session({ id: `x${n}`, session_date: "2026-10-04", minutes: 28, exclude_from_stats: true })) }));
  assert.equal(laneOf(excluded, "sec-a").health_basis, "rows", "excluded sittings are not counted");

  const base = lanes();
  const unpriced = computeForecast({
    ...base,
    tasks: [...base.tasks, task("tZ", { unit_count: 40, work_type: "mystery", section_id: "sec-b" })],
  });
  const z = laneOf(unpriced, "sec-b");
  assert.deepEqual([z.work_left_minutes, z.projected_end, z.health, z.health_basis], [null, null, "unknown", "rows"], "a lane with unpriced units keeps the row count");
  assert.equal(laneOf(unpriced, "sec-a").health, "unknown", "while any unfinished type has no speed, every lane with unit work is unknown (slice 1's rule)");
  assert.equal(laneOf(unpriced, "sec-a").health_basis, "rows");
});

test("sections: finished lanes, lanes without a planned end, and sections with no tasks", () => {
  const base = lanes();
  const forecast = computeForecast({
    ...base,
    sections: [...base.sections, { id: "sec-open", planned_start: "2026-10-01", planned_end: null }, { id: "sec-empty", planned_start: "2026-10-02", planned_end: "2026-10-03" }],
    tasks: [
      ...base.tasks.map((entry) => (entry.id === "tA" ? { ...entry, status: "Done" } : entry)),
      task("tOpen", { unit_count: 60, work_type: "sc", estimated_minutes: 6, section_id: "sec-open" }),
    ],
  });
  const a = laneOf(forecast, "sec-a");
  assert.deepEqual([a.units_left, a.work_left_minutes, a.projected_end, a.health, a.health_basis], [0, 0, null, null, "rows"], "a done lane has no unit work left");
  const open = laneOf(forecast, "sec-open");
  assert.deepEqual([open.health, open.health_basis], [null, "rows"], "no planned end → nothing to compare against");
  assert.deepEqual([laneOf(forecast, "sec-empty").units_left, laneOf(forecast, "sec-empty").health_basis], [0, "rows"]);
  assert.equal(laneOf(forecast, "sec-b").projected_end, "2026-10-24", "a finished lane doesn't hold the clock back");
});

test("no target: needed, available days and size fit are null, health reads no_target, lanes still project", () => {
  const forecast = computeForecast(lanes({ project: { unit_label: "stitches", target_date: null, pace_settings: null } }));
  assert.equal(forecast.target_date, null);
  assert.equal(forecast.available_days, null);
  assert.equal(forecast.available_from, null);
  assert.equal(forecast.needed_minutes_per_day, null);
  assert.equal(forecast.slack_days, null);
  assert.equal(forecast.health, "no_target");
  assert.ok(forecast.projected_finish, "a projected finish still comes from your pace");
  assert.equal(laneOf(forecast, "sec-b").health, "on_track", "lane health compares with each lane's own planned end");
  assert.equal(forecast.plan_cadence_minutes_per_day, null);
  const sized = computeForecast(perimeterProject({}, { target_date: null }));
  assert.equal(sized.size_fit, null);
  assert.equal(sized.size_fit_reason, "no_target");
});

test("forecast carries every work type with total, done and left (for the speed table) and the 14-day minutes", () => {
  const tasks = [task("t1", { work_type: "sc", estimated_minutes: 10 }), task("t2", { status: "Done", unit_count: 50, work_type: "waffle" })];
  const items = [item("a", "t1", 60, null, { is_done: true }), item("b", "t1", 40, null)];
  const sessions = [session({ task_id: "t1", minutes: 20, item_ids: ["a"] }), session({ session_date: "2026-09-01", minutes: 99 })];
  const forecast = computeForecast(input({ tasks, items, sessions }));
  const byType = Object.fromEntries(forecast.work_types.map((row) => [row.work_type, row]));
  assert.deepEqual([byType.sc.units_total, byType.sc.units_done, byType.sc.units_left], [100, 60, 40]);
  assert.deepEqual([byType.waffle.units_total, byType.waffle.units_done, byType.waffle.units_left], [50, 50, 0], "a finished type is still listed");
  assert.equal(byType.sc.source, "measured");
  assert.equal(byType.sc.seconds_per_unit, 20, "20 min × 60 ÷ 60 units");
  assert.equal(byType.sc.hours_left, 0.2);
  assert.equal(forecast.minutes_in_cadence_window, 20, "the old sitting is outside the 14 days");
});

// ── Slice 2: the words and numbers on the Portfolio pace line and the Pace section ──

const view = await import("../src/lib/pace-view.ts");

function stubForecast(overrides = {}) {
  return {
    today: "2026-10-04",
    unit_label: "stitches",
    target_date: "2026-12-05",
    counted_sessions: 3,
    excluded_sessions: 2,
    minutes_in_cadence_window: 436,
    plan_ratio: { ratio: 3.09, basis: "sample", sample_based: true, n_sessions: 3, label: "x" },
    measured_speeds: [{ work_type: "waffle", scope: "sample", seconds_per_unit: 20, n_sessions: 1, units: 1, minutes: 1, label: "x" }],
    cadence_minutes_per_day: 31.1,
    needed_minutes_per_day: 249.2,
    plan_cadence_minutes_per_day: 120,
    available_from: "2026-10-19",
    available_days: 48,
    work_left_minutes: 11950,
    work_left_hours: 199.2,
    unitless_minutes_left: 204,
    unpriced_units: [],
    projected_finish: "2027-10-24",
    slack_days: -323,
    health: "behind",
    size_fit_reason: null,
    size_fit: {
      label: "width", unit: "stitches", current: 195, needed_minutes_per_day_at_current: 229.4, scaled_minutes_left: 1, fixed_minutes_left: 1, perimeter_minutes_left: 0,
      fits: [
        { minutes_per_day: 31.1, source: "measured", widest: null, widest_length: null },
        { minutes_per_day: 60, source: "fixed", widest: 39, widest_length: null },
        { minutes_per_day: 90, source: "fixed", widest: 63, widest_length: null },
        { minutes_per_day: 120, source: "fixed", widest: 87, widest_length: null },
      ],
      widths: [{ size: 27, minutes_left: 2000, needed_minutes_per_day: 41.7 }],
      current_length: null,
      length_unit: null,
    },
    work_types: [],
    ...overrides,
  };
}

test("pace line: chip, plan ratio, needed at the current width from the first available day, widest width at 90 min a day", () => {
  const line = view.buildPaceLine(stubForecast());
  assert.deepEqual(line.chip, { kind: "behind", label: "Behind" });
  assert.equal(line.text, "Swatch speeds are 3.1× the plan · 195 wide needs 229 min a day from Oct 19 · at 90 min a day, 63 stitches wide fits");
  assert.equal(line.separator, false);
  const onTrack = view.buildPaceLine(stubForecast({ health: "on_track", plan_ratio: { ratio: 1.4, basis: "main", sample_based: false, n_sessions: 4, label: null } }));
  assert.deepEqual(onTrack.chip, { kind: "ok", label: "On track" });
  assert.match(onTrack.text, /^Body speeds are 1\.4× the plan · /, "main-based ratio says Body");
});

test("pace line: width locked → the width part reads \"you're at N min a day\" (no width fit)", () => {
  const line = view.buildPaceLine(stubForecast({ size_fit: null, size_fit_reason: "locked", plan_ratio: { ratio: 1.4, basis: "main", sample_based: false, n_sessions: 4, label: null } }));
  assert.equal(line.text, "Body speeds are 1.4× the plan · you're at 31 min a day");
});

test("pace line: no target → 'No target' chip and 'projected <Mon YYYY> at N min a day'", () => {
  const line = view.buildPaceLine(stubForecast({ target_date: null, health: "no_target", needed_minutes_per_day: null, available_from: null, available_days: null, size_fit: null, size_fit_reason: "no_target", projected_finish: "2026-12-29", cadence_minutes_per_day: 41 }));
  assert.deepEqual(line.chip, { kind: "none", label: "No target" });
  assert.equal(line.text, "projected Dec 2026 at 41 min a day");
  assert.equal(line.separator, true, "the page puts a dot between the chip and this sentence");
  const noCadence = view.buildPaceLine(stubForecast({ target_date: null, health: "no_target", projected_finish: null, cadence_minutes_per_day: 0, size_fit: null, size_fit_reason: "no_target" }));
  assert.equal(noCadence.text, "log a sitting to get a projection");
});

test("pace line: fewer than 3 counted sittings reads 'Measuring · n of 3 sittings'; unpriced units say so; none-fit and no-ratio cases", () => {
  assert.deepEqual(view.buildPaceLine(stubForecast({ health: "insufficient_data", counted_sessions: 1 })).chip, { kind: "measuring", label: "Measuring · 1 of 3 sittings" });
  const unknown = view.buildPaceLine(stubForecast({
    health: "unknown", plan_ratio: null, size_fit: null, size_fit_reason: "unpriced_units", needed_minutes_per_day: null, available_from: "2026-10-19",
    unpriced_units: [{ work_type: "mystery", units_left: 40 }],
  }));
  assert.deepEqual(unknown.chip, { kind: "none", label: "No speed yet" });
  assert.equal(unknown.text, "40 mystery stitches have no speed yet");
  const noFit = stubForecast();
  noFit.size_fit.fits = noFit.size_fit.fits.map((fit) => (fit.minutes_per_day === 90 ? { ...fit, widest: null } : fit));
  noFit.size_fit.widths = [{ size: 27, minutes_left: 1, needed_minutes_per_day: 1 }];
  assert.match(view.buildPaceLine(noFit).text, /at 90 min a day, not even 27 stitches wide fits$/);
  const noRatio = view.buildPaceLine(stubForecast({ plan_ratio: null }));
  assert.doesNotMatch(noRatio.text, /plan/, "no ratio, no plan part");
  assert.match(noRatio.text, /^195 wide needs 229 min a day from Oct 19 · /);
  const noSize = view.buildPaceLine(stubForecast({ size_fit: null, size_fit_reason: "not_configured" }));
  assert.equal(noSize.text, "Swatch speeds are 3.1× the plan · needs 249 min a day from Oct 19");
});

test("source labels are short, name their tone, and explain themselves (swatch uses slice 1's narrower-rows wording)", () => {
  const ratio = { ratio: 3.09 };
  const label = (source, n) => view.sourceLabel({ source, n_sessions: n }, ratio);
  assert.deepEqual([label("measured", 4).text, label("measured", 4).tone], ["Body · 4 sittings", "body"]);
  assert.equal(label("measured", 1).text, "Body · 1 sitting");
  assert.deepEqual([label("measured_sample", 2).text, label("measured_sample", 2).tone], ["Swatch · 2 sittings", "swatch"]);
  assert.equal(label("other_projects", 3).text, "Other projects · 3 sittings");
  assert.deepEqual([label("plan_x_ratio", 3).text, label("plan_x_ratio", 3).tone], ["Plan × 3.1", "plan"]);
  assert.deepEqual([label("plan", 0).text, label("plan", 0).tone], ["Plan", "plan"]);
  assert.deepEqual([label("none", 0).text, label("none", 0).tone], ["No speed yet", "none"]);
  assert.ok(label("measured_sample", 2).title.includes("rows are narrower"), "the swatch tooltip has the narrower-rows wording");
  for (const source of ["measured", "measured_sample", "other_projects", "plan_x_ratio", "plan", "none"]) {
    assert.ok(label(source, 1).title.length > 20, `${source} has an explanation`);
  }
});

test("tiles: four of them; Needed goes amber above your pace; no target swaps Needed for Speed vs plan", () => {
  const tiles = view.buildTiles(stubForecast());
  assert.deepEqual(tiles.map((tile) => tile.label), ["Work left", "Your pace", "Needed", "Projected finish"]);
  assert.deepEqual(tiles.map((tile) => tile.value), ["≈ 199 h", "31 min/day", "249 min/day", "Oct 2027"]);
  assert.equal(tiles[2].sub, "Oct 19 – Dec 5, at 195 wide");
  assert.deepEqual(tiles.map((tile) => tile.tone), ["", "", "warn", "warn"], "needed > pace, and the finish is after the target");
  const fine = view.buildTiles(stubForecast({ needed_minutes_per_day: 20, projected_finish: "2026-12-01" }));
  assert.deepEqual(fine.map((tile) => tile.tone), ["", "", "", ""]);
  assert.equal(fine[3].value, "Dec 1", "this year: month and day");
  const none = view.buildTiles(stubForecast({ target_date: null, health: "no_target", needed_minutes_per_day: null, available_from: null, size_fit: null, projected_finish: "2026-12-29" }));
  assert.deepEqual(none.map((tile) => tile.label), ["Work left", "Your pace", "Speed vs plan", "Projected finish"]);
  assert.equal(none[2].value, "3.1×");
  assert.equal(none[3].tone, "");
  const unpriced = view.buildTiles(stubForecast({ work_left_minutes: null, work_left_hours: null, needed_minutes_per_day: null, projected_finish: null, unpriced_units: [{ work_type: "x", units_left: 3 }] }));
  assert.equal(unpriced[0].value, "—");
  assert.equal(unpriced[3].value, "—");
});

test("speed table: one row per type with the short source, plus a 'no units' row for work priced by estimate", () => {
  const forecast = stubForecast({
    work_types: [
      { work_type: "waffle", units_total: 14592, units_done: 162, units_left: 14430, seconds_per_unit: 20, source: "measured_sample", n_sessions: 1, label: "x", hours_left: 80.2 },
      { work_type: "sc", units_total: 2477, units_done: 27, units_left: 2450, seconds_per_unit: 17.04, source: "plan_x_ratio", n_sessions: 3, label: "x", hours_left: 11.6 },
      { work_type: "mystery", units_total: 10, units_done: 0, units_left: 10, seconds_per_unit: null, source: "none", n_sessions: 0, label: "x", hours_left: null },
    ],
  });
  const rows = view.buildSpeedRows(forecast);
  assert.deepEqual(rows.map((row) => row.work_type), ["waffle", "sc", "mystery", null]);
  assert.deepEqual([rows[0].source.text, rows[0].speed, rows[0].hours_left], ["Swatch · 1 sitting", "20.0 s", "80.2"]);
  assert.deepEqual([rows[1].source.text, rows[1].speed], ["Plan × 3.1", "17.0 s"]);
  assert.deepEqual([rows[2].source.text, rows[2].speed, rows[2].hours_left], ["No speed yet", "—", "—"]);
  assert.deepEqual([rows[3].label, rows[3].hours_left, rows[3].source.text], ["no units", "3.4", "Plan"]);
  assert.equal(view.buildSpeedRows(stubForecast({ work_types: [], unitless_minutes_left: 0 })).length, 0);
});

test("width table: your 14-day pace, 60/90/120 and full width; 'None' when nothing fits; inches only with a gauge; hidden with no target or once locked", () => {
  const fit = view.buildFitView(stubForecast());
  assert.deepEqual(fit.rows.map((row) => [row.label, row.minutes_per_day, row.width, row.none]), [
    ["Your 14-day pace", 31.1, null, true],
    ["", 60, 39, false],
    ["", 90, 63, false],
    ["", 120, 87, false],
    ["Full width", 229.4, 195, false],
  ]);
  assert.equal(fit.hasGauge, false);
  assert.equal(fit.gaugeNote, "Add your gauge after measuring the swatch (step 5) to see inches");
  assert.equal(fit.rows[0].length, null);
  const withGauge = stubForecast();
  withGauge.size_fit.length_unit = "in";
  withGauge.size_fit.current_length = 60.2;
  withGauge.size_fit.fits = withGauge.size_fit.fits.map((entry) => ({ ...entry, widest_length: entry.widest ? Math.round((entry.widest / 3.25) * 10) / 10 : null }));
  const gauged = view.buildFitView(withGauge);
  assert.equal(gauged.hasGauge, true);
  assert.equal(gauged.gaugeNote, null);
  assert.deepEqual([gauged.rows[2].length, gauged.rows[4].length, gauged.rows[2].lengthUnit], [19.4, 60.2, "in"]);
  assert.equal(view.buildFitView(stubForecast({ size_fit: null, size_fit_reason: "no_target" })), null);
  assert.equal(view.buildFitView(stubForecast({ size_fit: null, size_fit_reason: "locked" })), null);
});

test("sittings list: newest first, task + rows, s/unit when one work type, excluded ones say why; a project-level sitting has no single task", () => {
  const tasks = [
    { id: "t3", title: "Step 3: Swatch rows 7–19", status: "Planned", section_id: null, work_type: null, unit_count: null },
    { id: "t4", title: "Step 4: Swatch rows 20–22", status: "Planned", section_id: null, work_type: null, unit_count: null },
  ];
  const rowsOf = (task_id, from, to, units, type) =>
    Array.from({ length: to - from + 1 }, (_, n) => ({ id: `${task_id}-${from + n}`, task_id, text: `Row ${from + n}: x`, is_done: true, unit_count: units, work_type: type }));
  const items = [...rowsOf("t3", 10, 15, 27, "colorwork-dc"), ...rowsOf("t4", 20, 22, 27, "waffle")];
  const base = { note: null, exclude_from_stats: false, exclude_reason: null, extra_units: null, extra_work_type: null, started_at: null, ended_at: null };
  const rows = view.buildSessionRows(
    [
      { ...base, id: "a", task_id: "t3", session_date: "2026-10-04", minutes: 13, exclude_from_stats: true, exclude_reason: "reading-instructions", item_ids: ["t3-10"], started_at: "2026-10-04T17:20:00Z", ended_at: "2026-10-04T17:33:00Z" },
      { ...base, id: "b", task_id: "t3", session_date: "2026-10-04", minutes: 61, item_ids: [11, 12, 13, 14, 15].map((n) => `t3-${n}`), note: "wall-clock", started_at: "2026-10-04T17:38:00Z", ended_at: "2026-10-04T18:39:00Z" },
      { ...base, id: "c", task_id: null, session_date: "2026-10-03", minutes: 300, exclude_from_stats: true, exclude_reason: "learning", item_ids: [] },
      { ...base, id: "d", task_id: "t4", session_date: "2026-10-04", minutes: 28, item_ids: ["t4-20", "t4-21", "t4-22"], started_at: "2026-10-04T20:58:00Z", ended_at: "2026-10-04T21:26:00Z" },
    ],
    tasks, items, "stitches"
  );
  assert.deepEqual(rows.map((row) => row.id), ["d", "b", "a", "c"], "newest first (by end time within a day)");
  const [d, b, a, c] = rows;
  assert.deepEqual([d.when, d.what, d.rows, d.minutes], ["Oct 4", "Step 4: Swatch rows 20–22", "rows 20–22", 28]);
  assert.equal(d.detail, "81 waffle · 20.7 s/stitch · 4:58–5:26 PM", "one type: minutes × 60 ÷ units");
  assert.equal(b.rows, "rows 11–15");
  assert.equal(b.detail, "135 colorwork-dc · 27.1 s/stitch · 1:38–2:39 PM");
  assert.equal(b.note, "wall-clock");
  assert.deepEqual([a.excluded, a.rows, a.detail], [true, "row 10", "Not counted: included reading the instructions · 1:20–1:33 PM"]);
  assert.deepEqual([c.what, c.rows, c.detail, c.excluded], ["Several tasks (no single task)", "", "Not counted: learning, not counted toward speed", true]);
  assert.equal(view.formatRowNumbers([11, 12, 13, 15, 17, 18]), "rows 11–13, 15, 17–18");
  assert.equal(view.formatRowNumbers([10]), "row 10");
});

test("the Log-a-sitting form defaults to the task holding the lowest undone row", () => {
  const tasks = [
    { id: "done", title: "Done", status: "Done", section_id: null, work_type: null, unit_count: null },
    { id: "t9", title: "Step 9", status: "Backlog", section_id: null, work_type: null, unit_count: null },
    { id: "t10", title: "Step 10", status: "Backlog", section_id: null, work_type: null, unit_count: null },
  ];
  const item = (id, task_id, text, is_done) => ({ id, task_id, text, is_done, unit_count: null, work_type: null });
  const items = [item("a", "done", "Row 1", false), item("b", "t10", "Row 2: x", false), item("c", "t9", "Row 1: x", true), item("d", "t9", "Row 7: x", false), item("e", "t9", "Count", false)];
  assert.equal(view.defaultSittingTask(tasks, items), "t10", "row 2 is the lowest undone row of an open task");
  assert.equal(view.defaultSittingTask(tasks, [item("c", "t9", "Row 1: x", true)]), null);
});

test("the Pace section's source line: sittings, counted, minutes in the last 14 days, and where the speeds come from", () => {
  const types = (...sources) => sources.map((source, index) => ({ work_type: `t${index}`, units_total: 10, units_done: 0, units_left: 10, seconds_per_unit: 5, source, n_sessions: 1, label: null, hours_left: 1 }));
  const line = (forecast, sessionTotal) => view.buildSourceLine(forecast, sessionTotal);
  assert.equal(line(stubForecast({ work_types: types("measured_sample", "plan_x_ratio") }), 5), "5 sittings logged (3 counted) · 436 min in the last 14 days · speeds from the swatch");
  assert.match(line(stubForecast({ work_types: types("measured", "measured_sample") }), 5), /speeds from your body rows and the swatch$/);
  assert.match(line(stubForecast({ work_types: types("other_projects") }), 5), /speeds from your other projects$/);
  assert.match(line(stubForecast({ work_types: types("plan_x_ratio", "plan") }), 5), /no speeds measured yet \(plan times\)$/);
  assert.equal(line(stubForecast({ counted_sessions: 0, excluded_sessions: 0, minutes_in_cadence_window: 0, work_types: types("plan") }), 0), "No sittings logged yet");
  assert.match(line(stubForecast({ counted_sessions: 1, excluded_sessions: 0, work_types: types("measured") }), 1), /^1 sitting logged \(1 counted\) · /);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
if (failures.length) process.exit(1);
