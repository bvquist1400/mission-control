// Tests for multi-day tasks, slice S2 (Baseline task 6f87add5): the card fill UI.
//
// - The card view (src/lib/task-range-view.ts) built on S1's rules: the violet
//   "Mon–Fri · Day 4 of 5" chip, never late inside the range, the dashed "time
//   gone" mark (amber when behind pace by 20 points or more), the green fill
//   (weighted by units when rows carry them), "3/5 steps", the screen-reader
//   sentence (the fill is never the only signal), Done lit when every step is
//   ticked (nothing closes on its own).
// - The week board's placement (src/lib/today/multi-day-board.ts): ranges in the
//   lane over the days they cover, weekend-only ranges in the Weekend column,
//   one-day tasks by due date as before, each task once.
// - The Today queries (src/lib/today/queries.ts): checklist rows embedded in the
//   same request, ranges overlapping the week included, a range that hasn't
//   started kept out of Top priorities.
// - The cards rendered to HTML (react-dom/server, TSX transpiled here): a task
//   without a start date renders byte-for-byte as before (snapshot), a ranged
//   task gets the chip, fill, mark, steps pill and label.
//
// Offline: no database, no network, no browser.
//
//   npm run test:multiday-cards            (UPDATE_SNAPSHOT=1 rewrites the plain-card snapshot)

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = path.join(ROOT, "scripts/fixtures/multiday-plain-cards.snapshot.html");

// TSX → JS for the card components (TypeScript's own transpiler; types are dropped).
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const src = (file) => pathToFileURL(path.join(ROOT, "src", file)).href;
const view = await import(src("lib/task-range-view.ts"));
const board = await import(src("lib/today/multi-day-board.ts"));
const queries = await import(src("lib/today/queries.ts"));
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { NowTaskCard } = await import(src("components/today/cards/NowTaskCard.tsx"));
const { WeeklyTaskCard } = await import(src("components/today/cards/BoardTaskCard.tsx"));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

// ET instants. Week of Mon 10/26/2026 (EDT until 11/1).
const at = (date, time = "12:00") => new Date(`${date}T${time}:00-04:00`);
const startOf = (date) => `${date}T04:00:00.000Z`; // local midnight ET (the task window saves the start at the start of the day)
const endOf = (date) => `${date}T23:59:59.999-04:00`;
const rows = (done, total, units) =>
  Array.from({ length: total }, (_, index) => ({ is_done: index < done, unit_count: units ? units[index] ?? null : null }));
const workTask = (overrides = {}) => ({
  id: "t-work",
  start_at: startOf("2026-10-26"),
  due_at: endOf("2026-10-30"),
  status: "In Progress",
  tags: [],
  project: null,
  ...overrides,
});

// ── The card view ─────────────────────────────────────────────────────────

await test("no start date: no range view, so the card stays exactly as it was", () => {
  const task = workTask({ start_at: null });
  assert.equal(view.buildRangeCardView(task, rows(1, 5), at("2026-10-29")), null);
  assert.equal(view.buildRangeCardView({ ...task, start_at: undefined }, [], at("2026-10-29")), null);
});

await test("start on the due date, or after it (a due-only write): a one-day task, no range view", () => {
  assert.equal(view.buildRangeCardView(workTask({ start_at: startOf("2026-10-30") }), rows(1, 2), at("2026-10-29")), null);
  assert.equal(view.buildRangeCardView(workTask({ start_at: startOf("2026-11-02") }), rows(1, 2), at("2026-10-29")), null);
  assert.equal(view.buildRangeCardView(workTask({ due_at: null }), rows(1, 2), at("2026-10-29")), null);
  assert.equal(view.buildRangeCardView(workTask({ status: "Done" }), rows(5, 5), at("2026-10-29")), null);
});

await test("Thu inside Mon–Fri: violet Day 4 of 5, not late, 60% gone, 1/5 done = behind pace (amber)", () => {
  const card = view.buildRangeCardView(workTask(), rows(1, 5), at("2026-10-29"));
  assert.equal(card.kind, "in_range");
  assert.equal(card.chipText, "Mon–Fri · Day 4 of 5");
  assert.equal(card.tone, "range");
  assert.equal(card.fillPercent, 20);
  assert.equal(card.elapsedPercent, 60);
  assert.equal(card.behindPace, true);
  assert.deepEqual(card.day, { day: 4, of: 5 });
  assert.equal(card.steps.text, "1/5 steps");
  assert.equal(view.stepsPillText(card), "1/5 steps · behind pace");
  assert.equal(view.stepsPillText(card, true), "1/5 · behind pace");
  assert.match(card.srText, /Mon–Fri · Day 4 of 5/);
  assert.match(card.srText, /1 of 5 steps done, 20%/);
  assert.match(card.srText, /Behind pace: about 60% of the time is gone/);
  assert.equal(card.note, "Day 4 of 5: about 60% of the time is gone and 20% of the steps are done. Not late until after Fri.");
});

await test("on pace (3/5 on Thu) and the 20-point edge (2/5 on Thu = exactly 20 behind counts)", () => {
  const onPace = view.buildRangeCardView(workTask(), rows(3, 5), at("2026-10-29"));
  assert.equal(onPace.behindPace, false);
  assert.equal(view.stepsPillText(onPace), "3/5 steps");
  assert.equal(onPace.note, "Day 4 of 5 · 60% done · on pace.");
  const edge = view.buildRangeCardView(workTask(), rows(2, 5), at("2026-10-29"));
  assert.equal(edge.behindPace, true);
  const justInside = view.buildRangeCardView(workTask(), rows(5, 9), at("2026-10-29")); // 55.6% done, 4.4 behind
  assert.equal(justInside.behindPace, false);
});

await test("due day of a range: accent 'Due today · Day 5 of 5' with the mark at 80%", () => {
  const card = view.buildRangeCardView(workTask(), rows(4, 5), at("2026-10-30"));
  assert.equal(card.kind, "due_today");
  assert.equal(card.tone, "today");
  assert.equal(card.chipText, "Due today · Day 5 of 5");
  assert.equal(card.elapsedPercent, 80);
});

await test("after the due date: red 'Overdue · Mon–Fri ended Fri', no mark, no behind-pace hint", () => {
  const card = view.buildRangeCardView(workTask(), rows(2, 5), at("2026-10-31"));
  assert.equal(card.kind, "late");
  assert.equal(card.tone, "late");
  assert.equal(card.chipText, "Overdue · Mon–Fri ended Fri");
  assert.equal(card.elapsedPercent, null);
  assert.equal(card.behindPace, false);
  assert.equal(card.fillPercent, 40);
  assert.match(card.srText, /^Overdue · Mon–Fri ended Fri\./);
});

await test("before the start: quiet 'Starts Mon 10/26', no mark", () => {
  const card = view.buildRangeCardView(workTask(), rows(0, 3), at("2026-10-25"));
  assert.equal(card.kind, "before_start");
  assert.equal(card.tone, "quiet");
  assert.equal(card.chipText, "Starts Mon 10/26");
  assert.equal(card.elapsedPercent, null);
  assert.equal(card.fillPercent, 0);
});

await test("Day 1: nothing gone yet, so no mark (and never behind on day 1)", () => {
  const card = view.buildRangeCardView(workTask(), rows(0, 5), at("2026-10-26", "09:00"));
  assert.equal(card.chipText, "Mon–Fri · Day 1 of 5");
  assert.equal(card.elapsedPercent, null);
  assert.equal(card.behindPace, false);
});

await test("last step ticked: full fill, Done lit, task still open (nothing auto-completes)", () => {
  const task = workTask();
  const card = view.buildRangeCardView(task, rows(5, 5), at("2026-10-29"));
  assert.equal(card.allStepsDone, true);
  assert.equal(card.fillPercent, 100);
  assert.equal(view.stepsPillText(card), "5/5 steps · all done");
  assert.equal(card.note, null);
  assert.match(card.srText, /All steps done\. The Done button is ready\./);
  assert.equal(task.status, "In Progress");
});

await test("weighted if available: rows with units weigh their units (100 + 300 units, first done = 25%)", () => {
  const card = view.buildRangeCardView(workTask(), rows(1, 2, [100, 300]), at("2026-10-29"));
  assert.equal(card.fillPercent, 25);
  assert.equal(card.steps.text, "1/2 steps");
  assert.equal(card.steps.basis, "units");
  assert.match(card.srText, /weighted by size/);
  assert.match(card.note, /of the work is done/);
});

await test("a range with no checklist: chip and mark, no fill, no steps pill", () => {
  const card = view.buildRangeCardView(workTask(), [], at("2026-10-29"));
  assert.equal(card.fillPercent, null);
  assert.equal(card.steps, null);
  assert.equal(view.stepsPillText(card), null);
  assert.equal(card.elapsedPercent, 60);
  assert.equal(card.behindPace, false);
});

await test("weekends only for personal: Tue→Sun personal on Sat is Day 5 of 6; the same work dates are 4 days", () => {
  const personal = workTask({ start_at: startOf("2026-10-27"), due_at: endOf("2026-11-01"), tags: ["personal"] });
  assert.equal(view.buildRangeCardView(personal, rows(1, 6), at("2026-10-31")).chipText, "Tue–Sun · Day 5 of 6");
  const viaProject = { ...personal, tags: [], project: { tags: ["personal"] } };
  assert.equal(view.buildRangeCardView(viaProject, rows(1, 6), at("2026-10-31")).chipText, "Tue–Sun · Day 5 of 6");
  const work = { ...personal, tags: [] };
  assert.equal(view.buildRangeCardView(work, rows(1, 6), at("2026-10-29")).chipText, "Tue–Sun · Day 3 of 4");
});

// ── Board placement ───────────────────────────────────────────────────────

const WEEK = "2026-10-26";
await test("board: ranges go in the lane over their days, each once; one-day tasks by due date as before", () => {
  const tasks = [
    workTask({ id: "mon-fri" }),
    workTask({ id: "wed-thu", start_at: startOf("2026-10-28"), due_at: endOf("2026-10-29") }),
    workTask({ id: "from-last-week", start_at: startOf("2026-10-21"), due_at: endOf("2026-10-27") }),
    workTask({ id: "into-next-week", start_at: startOf("2026-10-29"), due_at: endOf("2026-11-04") }),
    workTask({ id: "tue-sun", start_at: startOf("2026-10-27"), due_at: endOf("2026-11-01"), tags: ["personal"] }),
    workTask({ id: "weekend", start_at: startOf("2026-10-31"), due_at: endOf("2026-11-01"), tags: ["personal"] }),
    workTask({ id: "one-day", start_at: null, due_at: endOf("2026-10-28") }),
    workTask({ id: "same-day-start", start_at: startOf("2026-10-29"), due_at: endOf("2026-10-29") }),
    workTask({ id: "next-week-only", start_at: startOf("2026-11-03"), due_at: endOf("2026-11-05") }),
    workTask({ id: "mon-fri" }),
  ];
  const placed = board.placeWeekTasks(tasks, WEEK, (task) => task.id === "one-day" || task.id === "same-day-start");
  const lane = Object.fromEntries(placed.lane.map((item) => [item.task.id, item]));
  assert.deepEqual(placed.lane.map((item) => item.task.id), ["from-last-week", "mon-fri", "tue-sun", "wed-thu", "into-next-week"]);
  assert.deepEqual([lane["mon-fri"].startCol, lane["mon-fri"].endCol], [0, 4]);
  assert.deepEqual([lane["wed-thu"].startCol, lane["wed-thu"].endCol], [2, 3]);
  assert.deepEqual([lane["from-last-week"].startCol, lane["from-last-week"].endCol, lane["from-last-week"].startsBeforeWeek], [0, 1, true]);
  assert.deepEqual([lane["into-next-week"].startCol, lane["into-next-week"].endCol, lane["into-next-week"].endsAfterFriday], [3, 4, true]);
  assert.deepEqual([lane["tue-sun"].startCol, lane["tue-sun"].endCol], [1, 4]);
  assert.equal(board.laneContinuesText(lane["tue-sun"], WEEK), "continues to Sun →");
  assert.equal(board.laneContinuesText(lane["into-next-week"], WEEK), "continues to 11/4 →");
  assert.equal(board.laneContinuesText(lane["mon-fri"], WEEK), null);
  assert.equal(board.laneStartedText(lane["from-last-week"]), "← from 10/21");
  assert.deepEqual(placed.weekendRanges.map((task) => task.id), ["weekend"]);
  assert.deepEqual(placed.single.map((task) => task.id), ["one-day", "same-day-start"]);
  assert.deepEqual(board.laneCountsByColumn(placed.lane), [2, 3, 3, 4, 3]);
});

await test("board: the phone day strip marks the range, the past and today", () => {
  const strip = board.dayStrip("2026-10-27", "2026-11-01", WEEK, "2026-10-29");
  assert.deepEqual(strip.map((cell) => cell.letter).join(""), "MTWTFSS");
  assert.deepEqual(strip.map((cell) => (cell.inRange ? 1 : 0)), [0, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(strip.map((cell) => (cell.today ? 1 : 0)), [0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(strip.map((cell) => (cell.past ? 1 : 0)), [1, 1, 1, 0, 0, 0, 0]);
});

await test("board: a range that overlaps two weeks never shows twice after a merge", () => {
  const range = workTask({ id: "r", start_at: startOf("2026-10-29"), due_at: endOf("2026-11-04") });
  const stale = { ...range, title: "old" };
  const fresh = { ...range, title: "new" };
  const merged = board.mergeTasksById([stale, { id: "later" }, { id: "later" }], [fresh, { id: "x" }]);
  assert.deepEqual(merged.map((task) => task.id), ["later", "r", "x"]);
  assert.equal(merged.find((task) => task.id === "r").title, "new");
  assert.equal(board.rangeOverlapsWeek(range, WEEK), true);
  assert.equal(board.rangeOverlapsWeek(range, "2026-11-02"), true);
  assert.equal(board.rangeOverlapsWeek(range, "2026-11-09"), false);
  assert.equal(board.rangeOverlapsWeek(workTask({ start_at: null }), WEEK), false);
});

// ── Today queries (fake Supabase client) ──────────────────────────────────

function fakeSupabase(result) {
  const calls = [];
  const builder = {
    select(columns) { calls.push(["select", columns]); return builder; },
    eq(...args) { calls.push(["eq", ...args]); return builder; },
    in(...args) { calls.push(["in", ...args]); return builder; },
    not(...args) { calls.push(["not", ...args]); return builder; },
    lte(...args) { calls.push(["lte", ...args]); return builder; },
    gte(...args) { calls.push(["gte", ...args]); return builder; },
    neq(...args) { calls.push(["neq", ...args]); return builder; },
    or(filter) { calls.push(["or", filter]); return builder; },
    order(...args) { calls.push(["order", ...args]); return builder; },
    limit(...args) { calls.push(["limit", ...args]); return builder; },
    then(resolve, reject) { return Promise.resolve({ data: result, error: null }).then(resolve, reject); },
  };
  return { calls, client: { from(table) { calls.push(["from", table]); return builder; } } };
}

await test("weekly board query: one request embeds checklist rows and includes ranges overlapping the week", async () => {
  const weekEnd = new Date("2026-11-02T04:59:59.999Z");
  const weekStart = new Date("2026-10-26T04:00:00.000Z");
  const { calls, client } = fakeSupabase([
    { id: "a", title: "A", checklist_rows: [{ is_done: true, unit_count: null }], project: null, implementation: null, sprint: null, section: null },
    { id: "b", title: "B", project: null, implementation: null, sprint: null, section: null },
  ]);
  const tasks = await queries.queryWeeklyBoardTasks(client, "user-1", weekEnd, 200, weekStart, "all");
  assert.equal(calls.filter((call) => call[0] === "from").length, 1, "one request, no per-task reads");
  const select = calls.find((call) => call[0] === "select")[1];
  assert.match(select, /checklist_rows:task_checklist_items\(is_done, unit_count\)/);
  assert.ok(calls.some((call) => call[0] === "or" && call[1] === 'due_at.lte."2026-11-02T04:59:59.999Z",start_at.lte."2026-11-02T04:59:59.999Z"'));
  assert.ok(!calls.some((call) => call[0] === "lte" && call[1] === "due_at"), "the due-only upper bound is replaced by the overlap filter");
  assert.ok(calls.some((call) => call[0] === "gte" && call[1] === "due_at" && call[2] === "2026-10-26T04:00:00.000Z"));
  assert.deepEqual(tasks.map((task) => task.checklist_rows), [[{ is_done: true, unit_count: null }], []]);
});

await test("top priorities query: embeds checklist rows; a range that starts after today (ET) stays out", async () => {
  const { calls, client } = fakeSupabase([]);
  await queries.queryTopThreeTasks(client, "user-1", "all", at("2026-10-26", "10:00"));
  assert.match(calls.find((call) => call[0] === "select")[1], /checklist_rows:task_checklist_items/);
  assert.ok(calls.some((call) => call[0] === "or" && call[1] === 'start_at.is.null,start_at.lte."2026-10-27T03:59:59.999Z",due_at.lte."2026-10-27T03:59:59.999Z"'));
  assert.equal(queries.endOfEtDay(new Date("2026-11-02T03:30:00Z"), "America/New_York").toISOString(), "2026-11-02T04:59:59.999Z");
});

// ── create_task_from_note takes a start date (optional, cheap) ────────────

function fakeNotesClient(insertReply) {
  const inserts = [];
  const client = {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        maybeSingle: async () =>
          table === "notes"
            ? { data: { id: "n1", user_id: "user-1", title: "Note", body_markdown: "", note_type: "working_note", status: "active", pinned: false, created_at: "2026-10-26T12:00:00Z", updated_at: "2026-10-26T12:00:00Z" }, error: null }
            : { data: null, error: null },
        insert(row) { inserts.push({ table, row }); return chain; },
        single: async () => insertReply,
      };
      return chain;
    },
  };
  return { client, inserts };
}

await test("create_task_from_note: start_at is saved; a start after the due date is the plain 400, before and after the insert", async () => {
  const notes = await import(src("lib/notes.ts"));
  const stop = { data: null, error: { code: "XX000", message: "stop after insert" } };
  const ok = fakeNotesClient(stop);
  await assert.rejects(
    notes.createTaskFromNote(ok.client, "user-1", "n1", { title: "Ranged", start_at: "2026-10-26T04:00:00.000Z", due_at: "2026-10-31T03:59:59.999Z" }),
    (error) => error.message === "stop after insert"
  );
  assert.equal(ok.inserts.length, 1);
  assert.equal(ok.inserts[0].row.start_at, "2026-10-26T04:00:00.000Z");
  const none = fakeNotesClient(stop);
  await assert.rejects(notes.createTaskFromNote(none.client, "user-1", "n1", { title: "Plain" }), (error) => error.message === "stop after insert");
  assert.equal(none.inserts[0].row.start_at, null);

  const after = fakeNotesClient(stop);
  await assert.rejects(
    notes.createTaskFromNote(after.client, "user-1", "n1", { title: "Bad", start_at: "2026-11-02T05:00:00.000Z", due_at: "2026-10-31T03:59:59.999Z" }),
    (error) => error.status === 400 && error.message === "The start date can't be after the due date."
  );
  assert.equal(after.inserts.length, 0, "refused before anything is written");

  const trigger = fakeNotesClient({ data: null, error: { code: "23514", message: "start_at must be on or before due_at" } });
  await assert.rejects(
    notes.createTaskFromNote(trigger.client, "user-1", "n1", { title: "Raced", start_at: "2026-10-26T04:00:00.000Z" }),
    (error) => error.status === 400 && error.message === "The start date can't be after the due date."
  );
});

// ── Rendered cards ────────────────────────────────────────────────────────

const NOW_MS = at("2026-10-29").getTime();
const baseTask = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Plain task",
  tags: [],
  status: "Planned",
  due_at: endOf("2026-10-30"),
  start_at: null,
  updated_at: at("2026-10-28").toISOString(),
  estimated_minutes: 30,
  blocker: false,
  pinned: false,
  implementation: { id: "i", name: "ORIEN" },
  project: null,
  checklist_rows: [{ is_done: true, unit_count: null }, { is_done: false, unit_count: null }],
};
const noop = () => {};
const boardData = (task, rangeView) => ({
  id: task.id,
  title: task.title,
  tags: task.tags,
  estimatedMinutes: 30,
  dueAt: task.due_at,
  dueState: "Due Soon",
  status: task.status,
  blocker: false,
  pinned: false,
  syncedToday: false,
  implementationName: "ORIEN",
  dependencyBlocked: false,
  updatedAt: task.updated_at,
  priorityScore: 50,
  projectName: null,
  waitingOn: null,
  followUpAt: null,
  needsReview: false,
  isPersonal: false,
  range: rangeView,
});
const boardProps = { completing: false, pinning: false, moving: false, dragging: false, onOpen: noop, onDone: noop, onTogglePinned: noop, onDragStart: noop, onDragEnd: noop };

function plainMarkup() {
  const now = renderToStaticMarkup(h(NowTaskCard, { task: baseTask, nowMs: NOW_MS, completing: false, onOpen: noop, onDone: noop, range: view.buildRangeCardView(baseTask, baseTask.checklist_rows, new Date(NOW_MS)) }));
  const overdue = renderToStaticMarkup(h(NowTaskCard, { task: { ...baseTask, due_at: endOf("2026-10-27") }, nowMs: NOW_MS, completing: false, onOpen: noop, onDone: noop }));
  const boardCard = renderToStaticMarkup(h(WeeklyTaskCard, { ...boardProps, task: boardData(baseTask, null) }));
  const personal = renderToStaticMarkup(h(WeeklyTaskCard, { ...boardProps, task: { ...boardData(baseTask, null), isPersonal: true, dueState: "Overdue" } }));
  return [now, overdue, boardCard, personal].join("\n") + "\n";
}

await test("rendered: a task without a start date (even with a checklist) renders exactly as before S2 (snapshot)", () => {
  const markup = plainMarkup();
  if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(SNAPSHOT, markup);
  assert.equal(markup, readFileSync(SNAPSHOT, "utf8"));
  assert.doesNotMatch(markup, /data-range|bg-progress-fill|steps|sr-only|range/);
});

await test("rendered: a ranged Now card has the violet chip, 20% fill, amber mark at 60%, steps pill and a label", () => {
  const task = { ...baseTask, title: "ORIEN Wave 3", start_at: startOf("2026-10-26"), checklist_rows: rows(1, 5) };
  const rangeView = view.buildRangeCardView(task, task.checklist_rows, new Date(NOW_MS));
  const html = renderToStaticMarkup(h(NowTaskCard, { task, nowMs: NOW_MS, completing: false, onOpen: noop, onDone: noop, range: rangeView, onToggleSteps: noop }));
  assert.match(html, /data-range-card="in_range"/);
  assert.match(html, /border-l-range/);
  assert.match(html, /data-range-chip="range"[^>]*>Mon–Fri · Day 4 of 5</);
  assert.match(html, /data-range-fill="20"[^>]*style="width:20%"/);
  assert.match(html, /data-range-elapsed="60"[^>]*class="[^"]*border-amber-400\/85[^"]*" style="left:60%"/);
  assert.match(html, /aria-hidden="true" data-range-fill/);
  assert.match(html, /<span class="sr-only">Multi-day task, Mon–Fri · Day 4 of 5\. 1 of 5 steps done, 20%\. Behind pace: about 60% of the time is gone\.<\/span>/);
  assert.match(html, /aria-expanded="false" aria-controls="now-steps-11111111-1111-4111-8111-111111111111" aria-label="1 of 5 steps done, 20%, behind pace\. Show steps"/);
  assert.match(html, />1\/5 steps · behind pace</);
  assert.doesNotMatch(html, /Overdue|Due soon/);
  assert.doesNotMatch(html, /border-success bg-success-soft-hover/, "Done isn't lit before every step is ticked");
});

await test("rendered: all steps ticked lights the Done button (still a button Brent presses)", () => {
  const task = { ...baseTask, start_at: startOf("2026-10-26"), checklist_rows: rows(5, 5) };
  const rangeView = view.buildRangeCardView(task, task.checklist_rows, new Date(NOW_MS));
  const nowHtml = renderToStaticMarkup(h(NowTaskCard, { task, nowMs: NOW_MS, completing: false, onOpen: noop, onDone: noop, range: rangeView, onToggleSteps: noop }));
  assert.match(nowHtml, /border-success bg-success-soft-hover[^"]*"[^>]*aria-label="Mark task complete \(all steps done\)"/);
  assert.match(nowHtml, /class="pointer-events-none absolute inset-y-0 left-0 transition-\[width\] duration-500 bg-progress-fill-full" style="width:100%"/);
  const boardHtml = renderToStaticMarkup(h(WeeklyTaskCard, { ...boardProps, task: boardData(task, rangeView), canDrag: false, onToggleSteps: noop }));
  assert.match(boardHtml, /aria-label="Mark task complete \(all steps done\)"/);
  assert.match(boardHtml, /draggable="false"/);
  assert.match(boardHtml, /Change a multi-day task&#x27;s dates in the task window\./);
});

await test("rendered: a late range is red on the board and keeps its fill; it can still be dragged from the Overdue queue", () => {
  const task = { ...baseTask, start_at: startOf("2026-10-26"), due_at: endOf("2026-10-28"), checklist_rows: rows(2, 5) };
  const rangeView = view.buildRangeCardView(task, task.checklist_rows, new Date(NOW_MS));
  const html = renderToStaticMarkup(h(WeeklyTaskCard, { ...boardProps, task: { ...boardData(task, rangeView), dueState: "Overdue" }, canDrag: true }));
  assert.match(html, /border-l-red-400/);
  assert.match(html, /data-range-chip="late"[^>]*>Overdue · Mon–Wed ended Wed</);
  assert.match(html, /data-range-fill="40"/);
  assert.doesNotMatch(html, /data-range-elapsed/);
  assert.match(html, /draggable="true"/);
});

// ── Fix round 1 ──────────────────────────────────────────────────────────

// F5: Top priorities. The query's or= filter, evaluated on synthetic rows the
// way PostgREST reads it (comma-separated operands, quoted values; is.null / lte).
function orFilterMatches(filter, row) {
  const operands = filter.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  return operands.some((operand) => {
    const [column, op, ...rest] = operand.split(".");
    const raw = rest.join(".");
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (op === "is" && value === "null") return row[column] == null;
    if (op === "lte") return row[column] != null && Date.parse(row[column]) <= Date.parse(value);
    throw new Error(`operand not modelled: ${operand}`);
  });
}

await test("F5 top priorities: an overdue task whose start was left after its due (Undo/FamCal) stays eligible; a genuine future range is still left out", async () => {
  const now = at("2026-10-28", "08:00"); // Wed 10/28
  const { calls, client } = fakeSupabase([]);
  await queries.queryTopThreeTasks(client, "user-1", "all", now);
  const filter = calls.find((call) => call[0] === "or")[1];
  const reversedOverdue = { start_at: startOf("2026-10-29"), due_at: endOf("2026-10-27") }; // Codex's case
  const reversedDueToday = { start_at: startOf("2026-10-29"), due_at: endOf("2026-10-28") };
  const plainOverdue = { start_at: null, due_at: endOf("2026-10-27") };
  const startedRange = { start_at: startOf("2026-10-26"), due_at: endOf("2026-10-30") };
  const startsToday = { start_at: startOf("2026-10-28"), due_at: endOf("2026-10-30") };
  const futureRange = { start_at: startOf("2026-10-29"), due_at: endOf("2026-10-31") };
  assert.equal(orFilterMatches(filter, reversedOverdue), true, "the reversed overdue task is kept");
  assert.equal(orFilterMatches(filter, reversedDueToday), true, "due today with a stale later start is kept");
  assert.equal(orFilterMatches(filter, plainOverdue), true);
  assert.equal(orFilterMatches(filter, startedRange), true);
  assert.equal(orFilterMatches(filter, startsToday), true);
  assert.equal(orFilterMatches(filter, futureRange), false, "a range starting tomorrow is still left out");
});

// F2 / F4: the components' own handlers, run with a small hook harness (the
// TSX transpiled to CommonJS, React's hooks replaced by slots; no browser).
const requireCjs = createRequire(import.meta.url);
let activeHooks = null;
const harnessReact = {
  useState(initial) {
    const hooks = activeHooks;
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useRef(initial) {
    const hooks = activeHooks;
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect(fn) {
    const hooks = activeHooks;
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = true;
      if (hooks.runEffects) hooks.effects.push(fn);
    }
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};
const harnessJsx = (type, props) => ({ type, props: props ?? {} });
function loadWithHarness(relative, stubs) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText;
    const localRequire = (spec) => {
      if (spec === "react") return harnessReact;
      if (spec === "react/jsx-runtime") return { jsx: harnessJsx, jsxs: harnessJsx, Fragment: "Fragment" };
      if (spec in stubs) return stubs[spec];
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        const stem = spec.startsWith("@/") ? path.join(ROOT, "src", spec.slice(2)) : path.resolve(path.dirname(file), spec);
        for (const candidate of [`${stem}.ts`, `${stem}.tsx`, path.join(stem, "index.ts")]) {
          try {
            readFileSync(candidate);
            return load(candidate);
          } catch {}
        }
      }
      return requireCjs(spec);
    };
    new Function("require", "module", "exports", code)(localRequire, module, module.exports);
    return module.exports;
  };
  return load(path.join(ROOT, relative));
}
function mountHarness(Component, props, { runEffects = false } = {}) {
  const hooks = { slots: [], cursor: 0, effects: [], runEffects };
  return {
    render() {
      hooks.cursor = 0;
      activeHooks = hooks;
      return Component(props);
    },
    runEffects() {
      for (const fn of hooks.effects.splice(0)) fn();
    },
  };
}
function findNodes(tree, predicate) {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (predicate(node)) out.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  return out;
}
function nodeText(node) {
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? nodeText(node.props?.children) : String(node);
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

const { InlineSteps } = loadWithHarness("src/components/tasks/InlineSteps.tsx", { "@/components/ui/Button": { Button: "Button" } });
async function mountSteps(initialDone = false) {
  const loaded = [{ id: "row-1", task_id: "task-1", text: "Only step", is_done: initialDone, unit_count: null }];
  const requests = [];
  let reported = loaded.map(({ is_done, unit_count }) => ({ is_done, unit_count }));
  let saved = 0;
  let done = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (!init.method) return { ok: true, json: async () => loaded };
    return new Promise((resolve) => requests.push({ body: JSON.parse(init.body), resolve }));
  };
  const props = {
    id: "steps", taskId: "task-1", view: { allStepsDone: false, note: null, behindPace: false },
    onRowsChange: (next) => { reported = next; }, onSaved: () => { saved += 1; }, onDone: () => { done += 1; },
  };
  const harness = mountHarness(InlineSteps, props, { runEffects: true });
  harness.render();
  harness.runEffects();
  await settle();
  const tree = () => harness.render();
  const checkbox = () => findNodes(tree(), (node) => node.type === "input" && node.props.type === "checkbox")[0];
  const alert = () => findNodes(tree(), (node) => node.props?.role === "alert").map(nodeText).join("");
  const ok = (rows) => ({ ok: true, status: 200, json: async () => rows });
  return { requests, checkbox, alert, ok, reported: () => reported, saved: () => saved, done: () => done };
}

await test("F2 steps: a row is disabled while its save is pending; a second click then sends nothing; that save failing puts back the confirmed value", async () => {
  const steps = await mountSteps();
  const first = steps.checkbox().props.onChange();
  assert.equal(steps.checkbox().props.checked, true, "optimistic tick");
  assert.equal(steps.checkbox().props.disabled, true, "disabled while saving");
  const second = steps.checkbox().props.onChange(); // a double-click (a real browser won't fire it on a disabled box)
  assert.equal(steps.requests.length, 1, "one save per row at a time");
  steps.requests[0].resolve({ ok: false, status: 500, json: async () => ({ error: "x" }) });
  await first;
  await second;
  assert.equal(steps.checkbox().props.checked, false, "back to the confirmed value (Codex: two failures left it ticked)");
  assert.equal(steps.reported()[0].is_done, false, "the fill moves back too");
  assert.equal(steps.checkbox().props.disabled, false);
  assert.match(steps.alert(), /Couldn't save that step/);
  assert.equal(steps.saved(), 0);
  assert.equal(steps.done(), 0, "nothing completes on its own");
});

await test("F2 steps: rapid toggles can't commit out of order — the next click waits for the first save, and the last click is what's stored", async () => {
  const steps = await mountSteps();
  const first = steps.checkbox().props.onChange();
  steps.checkbox().props.onChange(); // ignored while pending
  assert.deepEqual(steps.requests.map((request) => request.body.items[0].is_done), [true]);
  steps.requests[0].resolve(steps.ok([{ id: "row-1", task_id: "task-1", text: "Only step", is_done: true, unit_count: null }]));
  await first;
  assert.equal(steps.checkbox().props.checked, true);
  assert.equal(steps.checkbox().props.disabled, false);
  const third = steps.checkbox().props.onChange();
  assert.deepEqual(steps.requests.map((request) => request.body.items[0].is_done), [true, false]);
  steps.requests[1].resolve(steps.ok([{ id: "row-1", task_id: "task-1", text: "Only step", is_done: false, unit_count: null }]));
  await third;
  assert.equal(steps.checkbox().props.checked, false, "the last click is the stored value");
  assert.equal(steps.saved(), 2);
  assert.equal(steps.done(), 0);
});

await test("F2 steps: a saved row takes the value from the reply; a 207 that lists the row as failed is a failure", async () => {
  const steps = await mountSteps();
  const first = steps.checkbox().props.onChange();
  // The server answered with the row unticked (e.g. another tab unticked it in between).
  steps.requests[0].resolve(steps.ok([{ id: "row-1", task_id: "task-1", text: "Only step (renamed)", is_done: false, unit_count: null }]));
  await first;
  assert.equal(steps.checkbox().props.checked, false, "reconciled from the reply");
  assert.equal(steps.reported()[0].is_done, false);
  const second = steps.checkbox().props.onChange();
  steps.requests[1].resolve({ ok: true, status: 207, json: async () => ({ updated: [], failed: [{ id: "row-1", error: "update failed" }] }) });
  await second;
  assert.equal(steps.checkbox().props.checked, false, "a 207 failure puts the row back");
  assert.match(steps.alert(), /Couldn't save that step/);
});

const { TaskMetaEditor } = loadWithHarness("src/components/tasks/TaskMetaEditor.tsx", {
  "@/hooks/useSprints": { useSprints: () => ({ sprints: [], loading: false }) },
  "@/components/ui/Button": { Button: "Button" },
  "@/components/ui/Field": { Input: "Input", Select: "Select", Textarea: "Textarea" },
  "@/components/tasks/TaskTagChips": { TaskTagChips: "TaskTagChips" },
});
// Saved instants from local dates, the way the task window saves them (start of the
// local day, due at the end of it), so the test holds in any timezone.
const localStart = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
const localEnd = (y, m, d) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
function mountEditor(task) {
  const harness = mountHarness(TaskMetaEditor, { task, isSaving: false, onUpdate: async () => "saved", onReplaceTask: () => {}, blocks: null });
  const tree = () => harness.render();
  const input = (predicate) => findNodes(tree(), (node) => (node.type === "Input" || node.type === "input") && predicate(node.props))[0];
  return {
    title: () => input((p) => p.value === task.title || p.value === "Renamed"),
    start: () => input((p) => p.placeholder === "Optional, e.g. t or 10/26"),
    due: () => input((p) => p.placeholder === "YYYY-MM-DD or t+7"),
    save: () => findNodes(tree(), (node) => node.type === "Button" && nodeText(node).includes("Save edits"))[0],
    text: () => nodeText(tree()),
  };
}
const editorTask = (start_at, due_at) => ({
  id: "task-1", title: "Original title", description: null, task_type: "Task", status: "Planned", tags: [], recurrence: null,
  recurring_template_id: null, implementation_id: null, project_id: null, section_id: null, sprint_id: null, waiting_on: null,
  start_at, due_at, updated_at: "2026-10-26T12:00:00Z",
});

await test("F4 task window: with a start saved after the due (Undo/FamCal), a title-only edit can be saved; the hint says how to fix it", () => {
  const editor = mountEditor(editorTask(localStart(2026, 10, 29), localEnd(2026, 10, 28)));
  editor.title().props.onChange({ target: { value: "Renamed" } });
  assert.equal(editor.save().props.disabled, false, "Save edits is enabled (Codex: it stayed disabled)");
  assert.match(editor.text(), /The start date is after the due date, so this reads as a one-day task\. Change either date to fix it\./);
  assert.doesNotMatch(editor.text(), /The start date can't be after the due date\./);
  assert.notEqual(editor.start().props["aria-invalid"], "true");
});

await test("F4 task window: editing a date while the range would stay reversed is still blocked; fixing it saves; a valid range with a title edit saves", () => {
  const reversed = mountEditor(editorTask(localStart(2026, 10, 29), localEnd(2026, 10, 28)));
  reversed.start().props.onChange({ target: { value: "2026-10-30" } });
  assert.equal(reversed.save().props.disabled, true, "a start edit that stays after the due");
  assert.match(reversed.text(), /The start date can't be after the due date\./);
  assert.equal(reversed.start().props["aria-invalid"], "true");
  reversed.start().props.onChange({ target: { value: "2026-10-27" } });
  assert.equal(reversed.save().props.disabled, false, "a start edit that fixes it");

  const dueEdit = mountEditor(editorTask(localStart(2026, 10, 29), localEnd(2026, 10, 28)));
  dueEdit.due().props.onChange({ target: { value: "2026-10-27" } });
  assert.equal(dueEdit.save().props.disabled, true, "a due edit that keeps it reversed");

  const valid = mountEditor(editorTask(localStart(2026, 10, 26), localEnd(2026, 10, 30)));
  valid.due().props.onChange({ target: { value: "2026-10-23" } });
  assert.equal(valid.save().props.disabled, true, "a due edit before a valid start");
  const validTitle = mountEditor(editorTask(localStart(2026, 10, 26), localEnd(2026, 10, 30)));
  validTitle.title().props.onChange({ target: { value: "Renamed" } });
  assert.equal(validTitle.save().props.disabled, false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
