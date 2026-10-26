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
import { registerHooks } from "node:module";
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
  assert.ok(calls.some((call) => call[0] === "or" && call[1] === 'start_at.is.null,start_at.lte."2026-10-27T03:59:59.999Z"'));
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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
