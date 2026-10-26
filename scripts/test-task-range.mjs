// Tests for multi-day tasks, slice S1 (Baseline task 6f87add5): the pure rules in
// src/lib/task-range.ts (late only after the due date, "Day X of Y" with Mon–Fri
// for work and every day for personal, weighted progress, behind pace, the card
// state), the briefs' overdue rule (a task inside its range is never overdue),
// start_at on POST/PATCH /api/tasks (set, clear, start after due refused, the
// FamCal key unchanged, the cascade leaving start_at alone), MCP create_task /
// update_task, and the task window's start-date input.
//
// Offline: no database and no network. Route handlers run with an injected auth
// context and an in-memory fake Supabase client (the same shape as
// test:task-date-cascade's); migration 063 itself is pinned by test:task-range-db.
//
//   npm run test:task-range

import assert from "node:assert/strict";

const LEGACY_KEY = "test-legacy-key-rrrrrrrrrrrrrrrr";
const API_USER_ID = "00000000-0000-4000-8000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;
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
const range = await import("../src/lib/task-range.ts");
const dates = await import("../src/components/utils/dates.ts");
const { buildWorkIntelligenceSnapshot } = await import("../src/lib/work-intelligence/snapshot.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const mcpRoute = await import("../src/app/api/mcp/route.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 8).join("\n    ")}`);
  }
}

// ET instants. October 2026 is EDT (UTC-4) until Sun Nov 1, then EST (UTC-5).
const etAt = (date, time = "17:00") => {
  const offset = date >= "2026-11-01" ? "-05:00" : "-04:00";
  return new Date(`${date}T${time}:00${offset}`).toISOString();
};
// Mon 10/26/2026 … Fri 10/30, Sat 10/31, Sun 11/1.
const at = (date, time = "10:00") => new Date(etAt(date, time));
const work = (start, due, extra = {}) => ({ start_at: start ? etAt(start, "00:00") : null, due_at: due ? etAt(due, "23:59") : null, status: "In Progress", tags: ["work"], project: null, ...extra });
const personal = (start, due, extra = {}) => work(start, due, { tags: ["personal"], ...extra });
const rows = (doneFlags, units = []) => doneFlags.map((is_done, index) => ({ is_done, unit_count: units[index] ?? null }));

// ── 1. Late = after the due date only ─────────────────────────────────────
await test("isPastDue / isTaskLate: late only once the due instant has passed; Done, Missed and Parked are never late", () => {
  const task = work("2026-10-26", "2026-10-30");
  assert.equal(range.isPastDue(task.due_at, at("2026-10-28")), false, "inside the range");
  assert.equal(range.isPastDue(task.due_at, at("2026-10-30", "23:00")), false, "due day, before the end of it");
  assert.equal(range.isPastDue(task.due_at, at("2026-10-31", "09:00")), true, "the day after");
  assert.equal(range.isPastDue(null, at("2026-10-31")), false);
  assert.equal(range.isPastDue("not a date", at("2026-10-31")), false);
  assert.equal(range.isTaskLate(task, at("2026-10-31")), true);
  for (const status of ["Done", "Missed", "Parked"]) assert.equal(range.isTaskLate({ ...task, status }, at("2026-10-31")), false, status);
  // A start date in the future with a due date in the past is still late (only the due date counts).
  assert.equal(range.isTaskLate(work("2026-10-20", "2026-10-23"), at("2026-10-26")), true);
});

// ── 2. Day counting: Mon–Fri for work, every day for personal ─────────────
await test("countRangeDays: weekdays skip Sat/Sun, all_days counts every day, across months and a DST change", () => {
  assert.equal(range.countRangeDays("2026-10-26", "2026-10-30", "weekdays"), 5);
  assert.equal(range.countRangeDays("2026-10-26", "2026-11-06", "weekdays"), 10);
  assert.equal(range.countRangeDays("2026-10-31", "2026-11-01", "weekdays"), 0);
  assert.equal(range.countRangeDays("2026-10-27", "2026-11-01", "all_days"), 6);
  assert.equal(range.countRangeDays("2026-10-30", "2026-10-26", "weekdays"), 0, "backwards");
  // Long range stays exact (52 weeks = 260 weekdays).
  assert.equal(range.countRangeDays("2026-01-05", "2027-01-03", "weekdays"), 260);
  assert.equal(range.countRangeDays("2026-01-05", "2027-01-03", "all_days"), 364);
});

await test("rangeCalendarFor: personal tag on the task or its project counts every day; work counts Mon–Fri", () => {
  assert.equal(range.rangeCalendarFor({ tags: ["personal"] }), "all_days");
  assert.equal(range.rangeCalendarFor({ tags: [], project: { tags: ["personal", "crochet"] } }), "all_days");
  assert.equal(range.rangeCalendarFor({ tags: ["work"], project: { tags: ["oncore"] } }), "weekdays");
  assert.equal(range.rangeCalendarFor({ tags: null, project: null }), "weekdays");
});

await test("Example (work): Mon 10/26 → Fri 10/30 is 5 days; Wed is Day 3 of 5; the weekend isn't counted", () => {
  const r = range.rangeOf(work("2026-10-26", "2026-10-30"));
  assert.deepEqual(r, { startDate: "2026-10-26", dueDate: "2026-10-30", isRange: true, calendar: "weekdays", totalDays: 5 });
  assert.deepEqual(range.dayOfRange(r, "2026-10-28"), { day: 3, of: 5, daysGone: 2 });
  assert.deepEqual(range.dayOfRange(r, "2026-10-26"), { day: 1, of: 5, daysGone: 0 });
  assert.deepEqual(range.dayOfRange(r, "2026-10-30"), { day: 5, of: 5, daysGone: 4 });
  assert.equal(range.dayOfRange(r, "2026-10-25"), null, "before the start");
  assert.equal(range.dayOfRange(r, "2026-10-31"), null, "after the due date");
  // Two-week work task: on the Saturday in the middle it reads Friday's number and all 5 days are gone.
  const twoWeeks = range.rangeOf(work("2026-10-26", "2026-11-06"));
  assert.equal(twoWeeks.totalDays, 10);
  assert.deepEqual(range.dayOfRange(twoWeeks, "2026-10-31"), { day: 5, of: 10, daysGone: 5 });
  assert.deepEqual(range.dayOfRange(twoWeeks, "2026-11-02"), { day: 6, of: 10, daysGone: 5 });
});

await test("Example (personal): the blanket Tue 10/27 → Sun 11/1 is 6 days; Sat is Day 5 of 6", () => {
  const r = range.rangeOf(personal("2026-10-27", "2026-11-01"));
  assert.deepEqual(r, { startDate: "2026-10-27", dueDate: "2026-11-01", isRange: true, calendar: "all_days", totalDays: 6 });
  assert.deepEqual(range.dayOfRange(r, "2026-10-31"), { day: 5, of: 6, daysGone: 4 });
  // The same dates on a work task: Tue–Fri only (4 days); Sat reads Day 4 of 4.
  const asWork = range.rangeOf(work("2026-10-27", "2026-11-01"));
  assert.equal(asWork.totalDays, 4);
  assert.deepEqual(range.dayOfRange(asWork, "2026-10-31"), { day: 4, of: 4, daysGone: 4 });
});

await test("rangeOf: no due → null; no start / same-day start → one-day task; start after due (left by a due-only write) → one-day on the due date; a Sat→Sun work range counts its days", () => {
  assert.equal(range.rangeOf(work("2026-10-26", null)), null);
  assert.deepEqual(range.rangeOf(work(null, "2026-10-30")), { startDate: null, dueDate: "2026-10-30", isRange: false, calendar: "weekdays", totalDays: 1 });
  assert.equal(range.rangeOf(work("2026-10-30", "2026-10-30")).isRange, false);
  assert.equal(range.rangeOf(work("2026-10-30", "2026-10-30")).startDate, "2026-10-30");
  const inverted = range.rangeOf(work("2026-11-03", "2026-10-30"));
  assert.equal(inverted.isRange, false);
  assert.equal(inverted.startDate, null);
  assert.equal(inverted.totalDays, 1);
  const weekendWork = range.rangeOf(work("2026-10-31", "2026-11-01"));
  assert.equal(weekendWork.calendar, "all_days");
  assert.equal(weekendWork.totalDays, 2);
  // ET dates, not UTC: 11 PM ET on Thu is Fri in UTC but Thu here.
  assert.equal(range.etDate("2026-10-30T03:30:00.000Z"), "2026-10-29");
});

// ── 3. Progress ───────────────────────────────────────────────────────────
await test("checklistProgress: equal rows without units; weighted by units when rows carry them; a unit-less row weighs the average; none → null", () => {
  assert.deepEqual(range.checklistProgress(rows([true, true, false, false, false])), { doneRows: 2, totalRows: 5, fraction: 0.4, basis: "rows" });
  // Blanket rows: 400 stitches done of 400 + 100 → 80%, though only 1 of 2 rows.
  assert.deepEqual(range.checklistProgress(rows([true, false], [400, 100])), { doneRows: 1, totalRows: 2, fraction: 0.8, basis: "units" });
  // "Weave in ends" has no units: it weighs the average (250) → 400 / 750.
  const mixed = range.checklistProgress(rows([true, false, false], [400, 100, null]));
  assert.equal(mixed.basis, "units");
  assert.ok(Math.abs(mixed.fraction - 400 / 750) < 1e-9);
  // Zero units count as "no units".
  assert.equal(range.checklistProgress(rows([true, false], [0, 0])).basis, "rows");
  assert.deepEqual(range.checklistProgress([]), { doneRows: 0, totalRows: 0, fraction: null, basis: "none" });
});

await test("isBehindPace: a 20-point gap is behind; 19 points isn't (Brent: 20 points)", () => {
  assert.equal(range.BEHIND_PACE_GAP, 0.2);
  assert.equal(range.isBehindPace(0.6, 0.2), true, "day 4 of 5 (60% gone), 1 of 5 steps");
  assert.equal(range.isBehindPace(0.4, 0.2), true, "exactly 20 points");
  assert.equal(range.isBehindPace(0.39, 0.2), false);
  assert.equal(range.isBehindPace(0.2, 0.4), false, "ahead");
});

// ── 4. The card state ─────────────────────────────────────────────────────
await test("taskRangeState: before_start, in_range (Day 4 of 5, behind pace), due_today, late, closed, upcoming, none", () => {
  const task = work("2026-10-26", "2026-10-30");
  const before = range.taskRangeState(task, rows([false, false]), at("2026-10-23"));
  assert.equal(before.kind, "before_start");
  assert.equal(before.elapsed, 0);
  assert.equal(before.behindPace, false);

  const thu = range.taskRangeState(task, rows([true, false, false, false, false]), at("2026-10-29"));
  assert.equal(thu.kind, "in_range");
  assert.deepEqual(thu.day, { day: 4, of: 5, daysGone: 3 });
  assert.ok(Math.abs(thu.elapsed - 0.6) < 1e-9);
  assert.equal(thu.progressFraction, 0.2);
  assert.equal(thu.behindPace, true);
  assert.equal(range.rangeChipText(thu), "Mon–Fri · Day 4 of 5");

  const onPace = range.taskRangeState(task, rows([true, true, true, false, false]), at("2026-10-29"));
  assert.equal(onPace.behindPace, false);

  const fri = range.taskRangeState(task, rows([true, true, true, true, true]), at("2026-10-30"));
  assert.equal(fri.kind, "due_today");
  assert.equal(fri.allStepsDone, true, "last step ticked: light up Done");
  assert.equal(range.rangeChipText(fri), "Due today · Day 5 of 5");

  const sat = range.taskRangeState(task, rows([true, false]), at("2026-10-31"));
  assert.equal(sat.kind, "late");
  assert.equal(sat.elapsed, 1);
  assert.equal(sat.behindPace, false, "late is its own state, never also 'behind pace'");
  assert.equal(range.rangeChipText(sat), "Overdue · Mon–Fri ended Fri");

  const done = range.taskRangeState({ ...task, status: "Done" }, rows([true, false]), at("2026-10-31"));
  assert.equal(done.kind, "closed");
  assert.equal(done.progressFraction, 1);

  assert.equal(range.taskRangeState(work(null, "2026-10-30"), [], at("2026-10-28")).kind, "upcoming");
  assert.equal(range.taskRangeState(work(null, "2026-10-30"), [], at("2026-10-30")).kind, "due_today");
  assert.equal(range.taskRangeState(work(null, null), [], at("2026-10-30")).kind, "none");
  assert.equal(range.rangeChipText(range.taskRangeState(work(null, "2026-10-30"), [], at("2026-10-28"))), null, "one-day tasks keep today's chips");
  assert.equal(range.rangeChipText(before), "Starts Mon 10/26");
});

await test("taskRangeState: no checklist means no behind-pace hint; a long range uses dates in the chip", () => {
  const state = range.taskRangeState(work("2026-10-26", "2026-11-06"), [], at("2026-11-05"));
  assert.equal(state.kind, "in_range");
  assert.equal(state.progressFraction, null);
  assert.equal(state.behindPace, false);
  assert.equal(range.rangeChipText(state), "10/26–11/6 · Day 9 of 10");
});

await test("startIsAfterDue and the 063 error mapping", () => {
  assert.equal(range.startIsAfterDue(etAt("2026-10-31", "00:00"), etAt("2026-10-30", "23:59")), true);
  assert.equal(range.startIsAfterDue(etAt("2026-10-30", "00:00"), etAt("2026-10-30", "23:59")), false, "same day");
  assert.equal(range.startIsAfterDue(null, etAt("2026-10-30")), false);
  assert.equal(range.startIsAfterDue(etAt("2026-10-30"), null), false);
  assert.equal(range.isStartAfterDueViolation({ code: "23514", message: "start_at must be on or before due_at" }), true);
  assert.equal(range.isStartAfterDueViolation({ code: "23514", message: "some other check" }), false);
  assert.equal(range.isStartAfterDueViolation(null), false);
});

// ── 5. Briefs: a task inside its range is never overdue ───────────────────
await test("Briefs snapshot: an in-range task (started, due later) is due soon but not overdue; a ranged task past its due date is overdue", () => {
  const now = at("2026-10-29", "08:00");
  const base = { user_id: "user-1", description: null, implementation_id: null, project_id: null, sprint_id: null, task_type: "Task", priority_score: 60, estimated_minutes: 60, actual_minutes: null, recurrence: null, estimate_source: "manual", needs_review: false, blocker: false, waiting_on: null, follow_up_at: null, stakeholder_mentions: [], tags: [], source_type: "manual", source_url: null, inbox_item_id: null, pinned_excerpt: null, pinned: false, created_at: "2026-10-20T14:00:00.000Z", updated_at: "2026-10-28T14:00:00.000Z", implementation: null, project: null, sprint: null };
  const tasks = [
    { ...base, id: "in-range", title: "Copy the Q3 calendar shell", status: "In Progress", start_at: etAt("2026-10-26", "00:00"), due_at: etAt("2026-10-30", "23:59") },
    { ...base, id: "ended", title: "Ended range", status: "In Progress", start_at: etAt("2026-10-19", "00:00"), due_at: etAt("2026-10-23", "23:59") },
  ];
  const snapshot = buildWorkIntelligenceSnapshot({
    now,
    window: { requestedDate: "2026-10-29", since: "2026-10-29T12:00:00.000Z", dayStartIso: "2026-10-29T04:00:00.000Z", dayEndExclusiveIso: "2026-10-30T04:00:00.000Z", timezone: "America/New_York" },
    tasks,
    events: [],
    taskComments: [],
    currentSprint: null,
  });
  assert.deepEqual(snapshot.overdueTasks.map((task) => task.id), ["ended"]);
  assert.equal(snapshot.coreCounts.overdue, 1);
  assert.ok(snapshot.dueSoonTasks.some((task) => task.id === "in-range"), "still listed as due soon");
});

// ── 6. Fake Supabase (in-memory; the test:task-date-cascade shape) ─────────
const tid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = { work: tid(1), waiter: tid(2), personal: tid(3) };

function task(taskId, title, extra = {}) {
  return {
    id: taskId, user_id: API_USER_ID, title, status: "Planned", tags: ["work"], start_at: null, due_at: null, follow_up_at: null,
    project_id: null, implementation_id: null, sprint_id: null, section_id: null, base_priority: 50, priority_score: 50,
    stakeholder_mentions: [], is_recurring_template: false, recurring_template_id: null, due_change_id: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra,
  };
}

function seed() {
  return {
    projects: [],
    stakeholders: [],
    commitments: [],
    tasks: [
      task(T.work, "Copy the Q3 calendar shell", { start_at: etAt("2026-10-26", "00:00"), due_at: etAt("2026-10-30", "23:59") }),
      task(T.waiter, "Release calendar to test", { start_at: etAt("2026-11-02", "00:00"), due_at: etAt("2026-11-04", "23:59") }),
      task(T.personal, "Blanket border", { tags: ["personal"], start_at: etAt("2026-10-27", "00:00"), due_at: etAt("2026-11-01", "23:59") }),
    ],
    task_dependencies: [
      { id: "d1", user_id: API_USER_ID, task_id: T.waiter, depends_on_task_id: T.work, depends_on_commitment_id: null, is_resolved: false, resolved_at: null, created_at: "2026-10-01T00:00:00Z" },
    ],
    task_comments: [],
    task_status_transitions: [],
    task_date_cascades: [],
    task_date_cascade_moves: [],
  };
}

function makeDb({ updateError = null, beforeTaskUpdate = null } = {}) {
  const state = seed();
  const rpcCalls = [];
  const updates = [];
  const famcalEligible = (r) => (r.tags || []).includes("personal") && !r.sprint_id && !r.project_id && !r.implementation_id && !r.section_id;
  const value = (table, r, column) => {
    if (table === "task_dependencies" && String(column).startsWith("waiting.")) {
      const waiting = state.tasks.find((t) => t.id === r.task_id);
      return waiting ? value("tasks", waiting, column.slice("waiting.".length)) : undefined;
    }
    return table === "tasks" && column === "famcal_eligible" ? famcalEligible(r) : r[column];
  };

  async function run(table, ops) {
    const op = (name) => ops.find(([n]) => n === name);
    const mode = op("single") ? "single" : op("maybeSingle") ? "maybeSingle" : "many";
    const finish = (found, error = null) => {
      if (error) return { data: null, error };
      if (mode === "many") return { data: found, error: null };
      if (found.length === 0) return mode === "single" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
      if (found.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: found[0], error: null };
    };
    const rowsOf = () => (state[table] ||= []);
    const matches = (r) => ops.every(([name, args]) => {
      if (name === "eq") return value(table, r, args[0]) === args[1];
      if (name === "neq") return value(table, r, args[0]) !== args[1];
      if (name === "in") return args[1].includes(value(table, r, args[0]));
      if (name === "is") return value(table, r, args[0]) === args[1];
      if (name === "gt") return String(value(table, r, args[0])) > String(args[1]);
      if (name === "contains") return args[1].every((tag) => (value(table, r, args[0]) || []).includes(tag));
      return true;
    });
    const withRelations = (r) => (table === "tasks" ? { ...r, project: null, implementation: null, sprint: null, section: null } : { ...r });
    const insert = op("insert")?.[1][0];
    if (insert) {
      const inserted = (Array.isArray(insert) ? insert : [insert]).map((r, index) => ({ id: r.id ?? tid(900 + rowsOf().length + index), created_at: "2026-10-26T12:00:00Z", ...r }));
      rowsOf().push(...inserted);
      return finish(inserted.map(withRelations));
    }
    if (op("delete")) {
      const doomed = rowsOf().filter(matches);
      state[table] = rowsOf().filter((r) => !doomed.includes(r));
      return finish(doomed);
    }
    const update = op("update")?.[1][0];
    if (update) {
      if (table === "tasks") {
        // A paused schedule: another session's write lands between this
        // request's read and its UPDATE (fix round 1, F1).
        if (beforeTaskUpdate) await beforeTaskUpdate(update);
        updates.push({ ...update });
      }
      if (table === "tasks" && updateError) return finish([], updateError);
      const hit = rowsOf().filter(matches);
      for (const r of hit) Object.assign(r, update);
      return finish(hit.map(withRelations));
    }
    let found = rowsOf().filter(matches);
    for (const [name, args] of ops) {
      if (name !== "order") continue;
      const [column, options = {}] = args;
      const dir = options.ascending === false ? -1 : 1;
      found = [...found].sort((a, b) => dir * (String(a[column] ?? "") < String(b[column] ?? "") ? -1 : String(a[column] ?? "") > String(b[column] ?? "") ? 1 : 0));
    }
    const limit = op("limit")?.[1][0];
    if (typeof limit === "number") found = found.slice(0, limit);
    return finish(found.map(withRelations));
  }

  // A model of apply_task_date_cascade: compare-and-set per move on the planned
  // old due date; it writes due_at ONLY (like 061/062).
  function applyCascade(args) {
    const root = state.tasks.find((r) => r.id === args.p_root_task_id);
    if (!root || Date.parse(root.due_at) !== Date.parse(args.p_root_new_due_at)) {
      return { status: "superseded", cascade_id: null, moved: [], skipped: [], project_flags: [] };
    }
    const moved = [];
    for (const move of args.p_moves) {
      const target = state.tasks.find((r) => r.id === move.task_id);
      if (!target || Date.parse(target.due_at) !== Date.parse(move.old_due_at)) continue;
      target.due_at = move.new_due_at;
      moved.push({ task_id: target.id, old_due_at: move.old_due_at, new_due_at: move.new_due_at, project_id: null });
    }
    const cascadeId = moved.length ? `cascade-${state.task_date_cascades.length + 1}` : null;
    if (cascadeId) state.task_date_cascades.push({ id: cascadeId });
    return { status: moved.length ? "moved" : "nothing_moved", cascade_id: cascadeId, moved, skipped: [], project_flags: [] };
  }

  const client = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "apply_task_date_cascade") return { data: applyCascade(args), error: null };
      return { data: null, error: { code: "PGRST202", message: "no such function" } };
    },
    from(table) {
      const ops = [];
      const proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            const result = run(table, ops);
            return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          }
          return (...args) => {
            ops.push([prop, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  return { client, state, rpcCalls, updates };
}

function routeRequest(db, authSource, method, urlPath, body) {
  const request = new NextRequest(`http://localhost${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase: db.client, user: { id: API_USER_ID }, userId: API_USER_ID, authSource });
}
const params = (value) => ({ params: Promise.resolve({ id: value }) });
async function patch(db, taskId, body, authSource = "legacy_api_key") {
  const response = await taskRoute.PATCH(routeRequest(db, authSource, "PATCH", `/api/tasks/${taskId}`, body), params(taskId));
  return { status: response.status, body: await response.json() };
}
async function post(db, body) {
  const response = await tasksRoute.POST(routeRequest(db, "legacy_api_key", "POST", "/api/tasks", body));
  return { status: response.status, body: await response.json() };
}
const rowOf = (db, taskId) => db.state.tasks.find((r) => r.id === taskId);

// ── 7. POST / PATCH /api/tasks ─────────────────────────────────────────────
await test("POST /api/tasks saves start_at with the due date and returns it", async () => {
  const db = makeDb();
  const result = await post(db, { title: "Stitch the border", start_at: etAt("2026-10-27", "00:00"), due_at: etAt("2026-11-01", "23:59") });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.start_at, etAt("2026-10-27", "00:00"));
  assert.equal(db.state.tasks.at(-1).start_at, etAt("2026-10-27", "00:00"));
});

await test("POST /api/tasks without start_at stores null (unchanged for every existing caller)", async () => {
  const db = makeDb();
  const result = await post(db, { title: "One-day task", due_at: etAt("2026-10-30") });
  assert.equal(result.status, 201);
  assert.equal(db.state.tasks.at(-1).start_at, null);
});

await test("POST /api/tasks refuses a start after the due date (400, plain words, nothing saved) and a malformed start", async () => {
  const db = makeDb();
  const before = db.state.tasks.length;
  const late = await post(db, { title: "Backwards", start_at: etAt("2026-10-31", "00:00"), due_at: etAt("2026-10-30", "23:59") });
  assert.equal(late.status, 400);
  assert.equal(late.body.error, "The start date can't be after the due date.");
  const bad = await post(db, { title: "Bad", start_at: "next tuesday-ish" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /start_at/);
  assert.equal(db.state.tasks.length, before);
});

await test("PATCH sets start_at, and null clears it", async () => {
  const db = makeDb();
  const set = await patch(db, T.work, { start_at: etAt("2026-10-27", "00:00") });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.start_at, etAt("2026-10-27", "00:00"));
  assert.equal(rowOf(db, T.work).start_at, etAt("2026-10-27", "00:00"));
  assert.equal(set.body.cascade, undefined, "a start-only change never runs the cascade");
  const cleared = await patch(db, T.work, { start_at: null });
  assert.equal(cleared.status, 200);
  assert.equal(rowOf(db, T.work).start_at, null);
  const blank = await patch(db, T.personal, { start_at: "" });
  assert.equal(blank.status, 200);
  assert.equal(rowOf(db, T.personal).start_at, null, "an empty string clears too (like due_at)");
});

await test("PATCH refuses a start after the current due date, and a due date moved before the current start (400, nothing saved)", async () => {
  const db = makeDb();
  const startLate = await patch(db, T.work, { start_at: etAt("2026-10-31", "00:00") });
  assert.equal(startLate.status, 400);
  assert.equal(startLate.body.error, "The start date can't be after the due date.");
  const dueEarly = await patch(db, T.work, { due_at: etAt("2026-10-23", "23:59") });
  assert.equal(dueEarly.status, 400);
  assert.equal(dueEarly.body.error, "The start date can't be after the due date.");
  assert.equal(db.updates.length, 0, "no UPDATE was sent");
  assert.equal(rowOf(db, T.work).start_at, etAt("2026-10-26", "00:00"));
  assert.equal(rowOf(db, T.work).due_at, etAt("2026-10-30", "23:59"));
  const bad = await patch(db, T.work, { start_at: 42 });
  assert.equal(bad.status, 400);
});

await test("PATCH moving both dates at once is checked against each other (earlier start + earlier due is fine)", async () => {
  const db = makeDb();
  const result = await patch(db, T.work, { start_at: etAt("2026-10-19", "00:00"), due_at: etAt("2026-10-23", "23:59"), cascade: false });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(rowOf(db, T.work).start_at, etAt("2026-10-19", "00:00"));
  assert.equal(rowOf(db, T.work).due_at, etAt("2026-10-23", "23:59"));
});

await test("PATCH maps 063's guard (23514, a race with another due-date edit) to the same 400", async () => {
  const db = makeDb({ updateError: { code: "23514", message: "start_at must be on or before due_at" } });
  const result = await patch(db, T.work, { start_at: etAt("2026-10-27", "00:00") });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "The start date can't be after the due date.");
});

// Fix round 1, F1 (Codex api-race): the date a PATCH doesn't write is
// compare-and-set in its UPDATE, so two clients writing the two dates of one
// task can't both pass their checks and leave the start after the due.
function pausedOnce(predicate, otherWrite) {
  let fired = false;
  return async (update) => {
    if (fired || !predicate(update)) return;
    fired = true;
    await otherWrite();
  };
}

await test("F1: a due-only move paused while another session sets the start → 409, nothing saved, never start after due (Codex's schedule)", async () => {
  let other;
  const db = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "due_at" in update, async () => {
      other = await patch(db, T.work, { start_at: etAt("2026-10-29", "00:00") });
    }),
  });
  const moved = await patch(db, T.work, { due_at: etAt("2026-10-28", "23:59"), cascade: false });
  assert.equal(other.status, 200, "the start write (checked against Friday's due) saves");
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.equal(moved.body.error, range.TASK_DATES_CHANGED_ERROR);
  const row = rowOf(db, T.work);
  assert.equal(row.start_at, etAt("2026-10-29", "00:00"));
  assert.equal(row.due_at, etAt("2026-10-30", "23:59"), "the due move was not written");
  assert.equal(range.startIsAfterDue(row.start_at, row.due_at), false);
});

await test("F1: the other order (start-only paused while another session moves the due) → 409, nothing saved", async () => {
  let other;
  const db = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "start_at" in update, async () => {
      other = await patch(db, T.work, { due_at: etAt("2026-10-28", "23:59"), cascade: false });
    }),
  });
  const started = await patch(db, T.work, { start_at: etAt("2026-10-29", "00:00") });
  assert.equal(other.status, 200, "the due move (checked against Monday's start) saves");
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(started.body.error, range.TASK_DATES_CHANGED_ERROR);
  const row = rowOf(db, T.work);
  assert.equal(row.start_at, etAt("2026-10-26", "00:00"), "the start was not written");
  assert.equal(range.startIsAfterDue(row.start_at, row.due_at), false);
});

await test("F1: a no-start task — a start set meanwhile still stops the due-only move (null-aware); an unrelated edit meanwhile doesn't", async () => {
  let other;
  const db = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "due_at" in update, async () => {
      other = await patch(db, T.waiter, { start_at: etAt("2026-11-03", "00:00") });
    }),
  });
  rowOf(db, T.waiter).start_at = null;
  const moved = await patch(db, T.waiter, { due_at: etAt("2026-11-02", "23:59"), cascade: false });
  assert.equal(other.status, 200);
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.equal(range.etDate(rowOf(db, T.waiter).due_at), "2026-11-04");

  const db2 = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "due_at" in update, async () => {
      other = await patch(db2, T.work, { title: "Renamed meanwhile" });
    }),
  });
  const moved2 = await patch(db2, T.work, { due_at: etAt("2026-10-29", "23:59"), cascade: false });
  assert.equal(other.status, 200);
  assert.equal(moved2.status, 200, JSON.stringify(moved2.body));
  assert.equal(range.etDate(rowOf(db2, T.work).due_at), "2026-10-29");
});

await test("F1: a PATCH carrying both dates writes the pair it checked (no compare-and-set); the serial control is still the plain 400", async () => {
  let other;
  const db = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "due_at" in update && "start_at" in update, async () => {
      other = await patch(db, T.work, { start_at: etAt("2026-10-29", "00:00") });
    }),
  });
  const both = await patch(db, T.work, { start_at: etAt("2026-10-27", "00:00"), due_at: etAt("2026-10-28", "23:59"), cascade: false });
  assert.equal(other.status, 200);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.equal(rowOf(db, T.work).start_at, etAt("2026-10-27", "00:00"));
  assert.equal(rowOf(db, T.work).due_at, etAt("2026-10-28", "23:59"));

  const serial = makeDb();
  assert.equal((await patch(serial, T.work, { start_at: etAt("2026-10-29", "00:00") })).status, 200);
  const late = await patch(serial, T.work, { due_at: etAt("2026-10-28", "23:59"), cascade: false });
  assert.equal(late.status, 400);
  assert.equal(late.body.error, "The start date can't be after the due date.");
});

await test("F1: the FamCal key keeps its contract — its due move isn't keyed on the start it can't see", async () => {
  const db = makeDb({
    beforeTaskUpdate: pausedOnce((update) => "due_at" in update, async () => {
      rowOf(db, T.personal).start_at = etAt("2026-10-29", "00:00");
    }),
  });
  const moved = await patch(db, T.personal, { due_at: etAt("2026-10-30", "23:59") }, "famcal_api_key");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(range.etDate(rowOf(db, T.personal).due_at), "2026-10-30");
});

await test("F1: expectedOtherDate keys a due move on the start, a start move on the due, both/neither/no task on nothing", () => {
  const current = { start_at: "2026-10-26T04:00:00+00:00", due_at: null };
  assert.deepEqual(range.expectedOtherDate(current, { due_at: "x" }), [["start_at", "2026-10-26T04:00:00+00:00"]]);
  assert.deepEqual(range.expectedOtherDate(current, { start_at: "x" }), [["due_at", null]]);
  assert.deepEqual(range.expectedOtherDate(current, { start_at: "x", due_at: "y" }), []);
  assert.deepEqual(range.expectedOtherDate(current, { title: "t" }), []);
  assert.deepEqual(range.expectedOtherDate(null, { due_at: "x" }), []);
  assert.equal(range.sameInstant("2026-10-26T04:00:00+00:00", "2026-10-26T04:00:00.000Z"), true);
  assert.equal(range.sameInstant(null, null), true);
  assert.equal(range.sameInstant(null, "2026-10-26T04:00:00Z"), false);
});

await test("Cascade: moving a ranged task's due date later moves its waiting task's due date only; both start dates stay (the range lengthens)", async () => {
  const db = makeDb();
  const result = await patch(db, T.work, { due_at: etAt("2026-11-03", "23:59") });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.cascade.status, "moved");
  const apply = db.rpcCalls.find((call) => call.name === "apply_task_date_cascade");
  for (const move of apply.args.p_moves) {
    assert.equal("start_at" in move, false, "the cascade never carries a start date");
    assert.equal("new_start_at" in move, false);
  }
  assert.equal(rowOf(db, T.work).start_at, etAt("2026-10-26", "00:00"), "edited task keeps its start");
  assert.equal(rowOf(db, T.waiter).start_at, etAt("2026-11-02", "00:00"), "waiting task keeps its start");
  assert.equal(range.etDate(rowOf(db, T.waiter).due_at), "2026-11-06", "waiting task moved 2 working days");
  assert.equal(range.rangeOf(rowOf(db, T.waiter)).totalDays, 5, "its range just got longer (Mon–Fri)");
  assert.equal(db.updates.some((update) => "start_at" in update), false, "no UPDATE wrote a start date");
});

await test("FamCal key: start_at is not in its allowlist (400) and isn't in its task view; its due-date moves keep their contract", async () => {
  const db = makeDb();
  const refused = await patch(db, T.personal, { start_at: etAt("2026-10-28", "00:00") }, "famcal_api_key");
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not start_at/);
  // A due date before the start is not refused for FamCal (it can't see or fix the start); the rules read it as a one-day task.
  const moved = await patch(db, T.personal, { due_at: etAt("2026-10-26", "23:59") }, "famcal_api_key");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal("start_at" in moved.body, false, "FamCal's projection leaves start_at out");
  assert.equal(range.rangeOf(rowOf(db, T.personal)).isRange, false);
});

// ── 8. MCP create_task / update_task ──────────────────────────────────────
async function mcpRpc(body) {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mission-control-key": LEGACY_KEY,
      "mcp-session-id": "stateless",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const response = await mcpRoute.POST(request);
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "" : text;
  return JSON.parse(payload);
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
await mcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "range-test", version: "1" } } });

await test("MCP create_task and update_task take start_at (update_task: null clears); the words name no vendor", async () => {
  const result = await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const create = result.result.tools.find((t) => t.name === "create_task");
  const update = result.result.tools.find((t) => t.name === "update_task");
  assert.ok("start_at" in create.inputSchema.properties);
  assert.ok("start_at" in update.inputSchema.properties);
  assert.match(update.inputSchema.properties.start_at.description, /Null clears it/);
  assert.match(create.inputSchema.properties.start_at.description, /can't be after the due date/);
  assert.doesNotMatch(JSON.stringify([create, update]), /claude|anthropic/i);
});

await test("MCP update_task forwards start_at (and null) to PATCH; create_task forwards it to POST", async () => {
  mcpCalls.length = 0;
  mcpResponder = () => json({ id: T.work, start_at: null });
  await mcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_task", arguments: { task_id: T.work, start_at: null } } });
  assert.equal(mcpCalls[0].method, "PATCH");
  assert.deepEqual(mcpCalls[0].body, { start_at: null });
  mcpCalls.length = 0;
  mcpResponder = () => json({ id: "new" }, 201);
  await mcpRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_task", arguments: { title: "Ranged", start_at: etAt("2026-10-26", "00:00"), due_at: etAt("2026-10-30", "23:59") } } });
  assert.equal(mcpCalls[0].method, "POST");
  assert.equal(mcpCalls[0].body.start_at, etAt("2026-10-26", "00:00"));
});

await test("MCP update_task: a 400 for a start after the due date comes back as an error with the plain words", async () => {
  mcpCalls.length = 0;
  mcpResponder = () => json({ error: "The start date can't be after the due date." }, 400);
  const result = await mcpRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_task", arguments: { task_id: T.work, start_at: etAt("2026-11-09", "00:00") } } });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /can't be after the due date/);
});

// ── 9. Task window input ──────────────────────────────────────────────────
await test("Task window: a typed start date saves at the start of that (local) day; the due date stays at the end of its day", () => {
  const base = new Date(2026, 9, 26, 9, 0, 0);
  const start = dates.resolveStartDateInput("2026-10-30", base);
  assert.equal(start.error, null);
  assert.equal(start.dateOnly, "2026-10-30");
  assert.equal(start.iso, new Date(2026, 9, 30, 0, 0, 0, 0).toISOString());
  const due = dates.resolveDueDateInput("2026-10-30", base);
  assert.equal(due.iso, new Date(2026, 9, 30, 23, 59, 59, 999).toISOString());
  assert.equal(range.startIsAfterDue(start.iso, due.iso), false, "same-day start and due is allowed");
  assert.equal(dates.resolveStartDateInput("t+2", base).dateOnly, "2026-10-28");
  assert.equal(dates.resolveStartDateInput("", base).iso, null, "blank clears");
  assert.ok(dates.resolveStartDateInput("soon", base).error);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
