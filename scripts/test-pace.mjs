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
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
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

console.log(`\n${passed} passed`);
