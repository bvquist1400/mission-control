#!/usr/bin/env node
// Redesign S4: Today, board first. Offline (no database, network or browser).
// Run: npm run test:today-board
//
// What it pins:
//   1. The pure rules (src/lib/today/today-board.ts): each task's one home
//      (Waiting once, Overdue a short queue oldest first, the rest on the
//      board); "Move to…" (the days and undated states offered, a multi-day
//      task only moving its end, the update each choice sends, a day's due =
//      the END of that ET day); the columns (tense, weights with the panel
//      closed / open, which days fold to "n done", the header counts); the
//      week number and labels; the strip's next meeting and countdown.
//   2. Rendered pieces (react-dom/server, TSX transpiled here): the open card's
//      outline + "Open in panel" tag, Done + Move to… on board cards, lane bars
//      and Overdue cards, done lines.
//   3. Wiring: Today renders the strip + board only (Now, the meetings card and
//      the Blocked / Waiting strip are gone), day moves go through the date
//      cascade and Backlog / Park through useTaskMutation (no new PATCH path),
//      the fold rules in today-board.css key off the task panel's ?task, the
//      layer order, 44 px touch targets, the 12 px type floor, reduced motion.
//   4. Faded late copies (Brent 11/6, "yes i like your faded late idea in the
//      week view"): an Overdue task also shows, faded, on its original due day
//      of the shown week; the real card stays in Overdue; copies only open the
//      task (no Done, no Move to…, no drag), never count in a day's header, and
//      stay off the one-day list.
//   5. Done below open (Brent 11/6, "the completed tasks should not appear on
//      top of the pending tasks"): the whole WeekBoard rendered with fixture
//      tasks; in a day column and a weekend day the open cards come first and
//      the done lines last (just above "+ add"), so the panel's ↑ / ↓ (which
//      follow data-task-open in page order) walk open before done too.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(process.env.TODAY_BOARD_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readIf = (rel) => (exists(rel) ? read(rel) : "");

registerHooks({
  load(url, context, nextLoad) {
    // Section 9 renders the whole WeekBoard, which imports its stylesheets: Node can't, so they load as nothing.
    if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n     ")}`);
  }
}

async function load(rel) {
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } catch (error) {
    console.log(`(${rel} did not load: ${String(error?.message ?? error).split("\n")[0]})`);
    return null;
  }
}

const lib = await load("src/lib/today/today-board.ts");
const range = await load("src/lib/task-range.ts");
const rangeView = await load("src/lib/task-range-view.ts");
const cards = await load("src/components/today/cards/BoardTaskCard.tsx");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
function need(mod, name) {
  assert.ok(mod, `${name} exists and loads`);
  return mod;
}

// Thursday 5 Nov 2026, 3 PM ET (EST, UTC-5). The week runs Mon 2 – Sun 8 Nov.
const NOW = new Date("2026-11-05T20:00:00.000Z");
const TODAY = "2026-11-05";
const WEEK = "2026-11-02";
const endOf = (date) => need(lib, "today-board").dueAtForBoardDay(date);
const task = (id, extra = {}) => ({ id, title: id, status: "Planned", due_at: endOf(TODAY), start_at: null, tags: [], project: null, priority_score: 50, ...extra });

// ── 1. Dates ──────────────────────────────────────────────────────────────

await test("a day picked on the board is due at the END of that ET day (EST, EDT and both DST change days)", () => {
  const { dueAtForBoardDay } = need(lib, "today-board");
  assert.equal(dueAtForBoardDay("2026-11-05"), "2026-11-06T04:59:59.999Z");
  assert.equal(dueAtForBoardDay("2026-07-01"), "2026-07-02T03:59:59.999Z");
  assert.equal(dueAtForBoardDay("2026-11-01"), "2026-11-02T04:59:59.999Z", "fall back: the day ends in EST");
  assert.equal(dueAtForBoardDay("2026-03-08"), "2026-03-09T03:59:59.999Z", "spring forward: the day ends in EDT");
});

await test("regression: a task moved to today at 8 PM ET is not overdue (the old `<day>T23:59:59.999Z` was 6:59 PM ET)", () => {
  const { dueAtForBoardDay } = need(lib, "today-board");
  const eightPm = new Date("2026-11-06T01:00:00.000Z");
  assert.equal(range.isPastDue(dueAtForBoardDay("2026-11-05"), eightPm), false);
  assert.equal(range.isPastDue("2026-11-05T23:59:59.999Z", eightPm), true, "the old value was already past");
  const board = readIf("src/components/today/sections/WeekBoard.tsx");
  assert.doesNotMatch(board, /T23:59:59\.999Z/, "the board no longer builds a UTC end of day");
  assert.match(board, /const nextDueAt = dueAtForBoardDay\(dateOnly\);/);
});

await test("week number and labels", () => {
  const { isoWeekNumber, weekRangeLabel, shortDayLabel, stripDateLabel } = need(lib, "today-board");
  assert.equal(isoWeekNumber("2026-11-02"), 45);
  assert.equal(isoWeekNumber("2026-12-28"), 53, "2026 has 53 ISO weeks");
  assert.equal(isoWeekNumber("2027-01-04"), 1);
  assert.equal(isoWeekNumber("2027-01-01"), 53, "1 Jan 2027 (Fri) is in week 53 of 2026");
  assert.equal(weekRangeLabel("2026-11-02"), "2 – 8 Nov");
  assert.equal(weekRangeLabel("2026-10-26"), "26 Oct – 1 Nov");
  assert.equal(weekRangeLabel("2026-12-28"), "28 Dec 2026 – 3 Jan 2027");
  assert.equal(shortDayLabel("2026-11-05"), "Thu 5");
  assert.equal(stripDateLabel("2026-11-05"), "Thu 5 Nov");
});

await test("due words: 'due today 5 PM', 'due today' for an end-of-day due, 'late · was due 9 AM', a bare time on other days", () => {
  const { cardDueText, dueTimeText } = need(lib, "today-board");
  assert.equal(dueTimeText("2026-11-05T22:00:00.000Z"), "5 PM");
  assert.equal(dueTimeText("2026-11-05T15:30:00.000Z"), "10:30 AM");
  assert.equal(dueTimeText(endOf(TODAY)), null, "end of the ET day: the column says the day");
  assert.equal(dueTimeText("2026-11-05T23:59:59.999Z"), null, "the board's old 6:59 PM ET end of day reads as end of day too");
  assert.deepEqual(cardDueText("2026-11-05T22:00:00.000Z", TODAY, NOW), { text: "due today 5 PM", late: false });
  assert.deepEqual(cardDueText(endOf(TODAY), TODAY, NOW), { text: "due today", late: false });
  assert.deepEqual(cardDueText("2026-11-05T14:00:00.000Z", TODAY, NOW), { text: "late · was due 9 AM", late: true });
  assert.deepEqual(cardDueText("2026-11-06T22:00:00.000Z", TODAY, NOW), { text: "5 PM", late: false });
  assert.deepEqual(cardDueText(endOf("2026-11-06"), TODAY, NOW), { text: null, late: false });
  assert.deepEqual(cardDueText(null, TODAY, NOW), { text: null, late: false });
});

// ── 2. One home per task: Waiting once, Overdue a short queue ─────────────

await test("Waiting appears once: a Blocked/Waiting task is only in Waiting (never on a day, in the lane or in Overdue)", () => {
  const { splitTodayBoard } = need(lib, "today-board");
  const blockedOnBoard = task("blocked-late", { status: "Blocked/Waiting", due_at: endOf("2026-11-03") });
  const blockedToday = task("blocked-today", { status: "Blocked/Waiting" });
  const blockedRange = task("blocked-range", { status: "Blocked/Waiting", start_at: "2026-11-02T05:00:00.000Z", due_at: endOf("2026-11-06") });
  const fromWaitingRead = task("waiting-only", { status: "Blocked/Waiting", due_at: null });
  const split = splitTodayBoard({
    tasks: [blockedOnBoard, blockedToday, blockedRange, task("plain")],
    waiting: [fromWaitingRead, blockedToday],
    todayDate: TODAY,
    now: NOW,
  });
  assert.deepEqual(split.waiting.map((t) => t.id), ["waiting-only", "blocked-today", "blocked-late", "blocked-range"], "the Waiting read's order, then board rows it didn't carry, each once");
  assert.deepEqual(split.board.map((t) => t.id), ["plain"]);
  assert.deepEqual(split.overdue.map((t) => t.id), []);
  const ids = [...split.waiting, ...split.board, ...split.overdue].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "no task twice");
});

await test("Overdue = open and due on an earlier ET day, oldest first; a task due earlier today stays in today's column", () => {
  const { splitTodayBoard } = need(lib, "today-board");
  const split = splitTodayBoard({
    tasks: [
      task("tue", { due_at: endOf("2026-11-03"), priority_score: 90 }),
      task("oct", { due_at: endOf("2026-10-20") }),
      task("tue-b", { due_at: endOf("2026-11-03"), priority_score: 40 }),
      task("earlier-today", { due_at: "2026-11-05T14:00:00.000Z" }),
      task("tomorrow", { due_at: endOf("2026-11-06") }),
      task("done-old", { status: "Done", due_at: endOf("2026-11-02") }),
      task("parked-old", { status: "Parked", due_at: endOf("2026-11-02") }),
      task("tue", { due_at: endOf("2026-11-03") }),
    ],
    waiting: [],
    todayDate: TODAY,
    now: NOW,
  });
  assert.deepEqual(split.overdue.map((t) => t.id), ["oct", "tue", "tue-b"], "oldest due first, then higher priority; a duplicate row counted once");
  assert.deepEqual(split.board.map((t) => t.id), ["earlier-today", "tomorrow"], "closed tasks never on the board");
});

await test("the Overdue queue is short: 5, then 'Show n more'", () => {
  const { railQueue, OVERDUE_RAIL_LIMIT, overdueLabel } = need(lib, "today-board");
  assert.equal(OVERDUE_RAIL_LIMIT, 5);
  const items = Array.from({ length: 8 }, (_, index) => index);
  assert.deepEqual(railQueue(items, false), { shown: [0, 1, 2, 3, 4], hidden: 3 });
  assert.deepEqual(railQueue(items, true), { shown: items, hidden: 0 });
  assert.deepEqual(railQueue([1, 2], false), { shown: [1, 2], hidden: 0 });
  assert.equal(overdueLabel(endOf("2026-11-03"), TODAY), "was due Tue");
  assert.equal(overdueLabel(endOf("2026-10-20"), TODAY), "was due Oct 20");
});

// ── 3. Move to… ──────────────────────────────────────────────────────────

await test("Move to… offers today, tomorrow, the rest of the week, next Monday, then Backlog and Park; the current day is disabled", () => {
  const { moveToChoices } = need(lib, "today-board");
  const choices = moveToChoices(task("t", { due_at: endOf("2026-11-06") }), TODAY, WEEK);
  assert.deepEqual(
    choices.map((c) => [c.key, c.label, c.hint ?? null, Boolean(c.disabled)]),
    [
      ["day:2026-11-05", "Today · Thu 5", null, false],
      ["day:2026-11-06", "Tomorrow · Fri 6", null, true],
      ["day:2026-11-07", "Sat 7", null, false],
      ["day:2026-11-08", "Sun 8", null, false],
      ["day:2026-11-09", "Mon 9", "next week", false],
      ["backlog", "Backlog", "no date", false],
      ["park", "Park", "someday", false],
    ]
  );
  assert.equal(choices[1].reason, "already due then");
});

await test("Move to… from an Overdue card and while another week is shown", () => {
  const { moveToChoices } = need(lib, "today-board");
  const overdue = moveToChoices(task("t", { due_at: endOf("2026-11-03") }), TODAY, WEEK);
  assert.ok(!overdue.some((c) => c.date && c.date < TODAY), "never a day that has already passed");
  assert.ok(overdue.every((c) => !c.disabled), "an overdue task can go to any day offered");
  const nextWeek = moveToChoices(task("t", { due_at: endOf("2026-11-10") }), TODAY, "2026-11-09").map((c) => c.date).filter(Boolean);
  assert.deepEqual(nextWeek, ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]);
  const parked = moveToChoices(task("t", { status: "Parked" }), TODAY, WEEK);
  assert.equal(parked.find((c) => c.kind === "park").disabled, true);
});

await test("Move to… on a multi-day task moves only its end: days before its start are disabled, no undated states", () => {
  const { moveToChoices, pickedDateChoice } = need(lib, "today-board");
  const ranged = task("r", { start_at: "2026-11-07T05:00:00.000Z", due_at: endOf("2026-11-09") });
  const choices = moveToChoices(ranged, TODAY, WEEK);
  assert.deepEqual(choices.filter((c) => c.disabled).map((c) => [c.date, c.reason]), [
    ["2026-11-05", "before its start (Sat 7)"],
    ["2026-11-06", "before its start (Sat 7)"],
    ["2026-11-09", "already due then"],
  ]);
  assert.ok(!choices.some((c) => c.kind !== "day"), "Backlog / Park would leave a start without an end");
  assert.equal(pickedDateChoice(ranged, "2026-11-04").disabled, true);
  assert.equal(pickedDateChoice(ranged, "2026-11-20").disabled, undefined);
  assert.equal(pickedDateChoice(task("t"), TODAY).reason, "already due then");
});

await test("each choice's update: a day = the end of that ET day (date cascade), Backlog = no date, Park = Parked", () => {
  const { moveToChoices, moveUpdates, moveToastText } = need(lib, "today-board");
  const choices = moveToChoices(task("t", { due_at: endOf("2026-11-06") }), TODAY, WEEK);
  assert.deepEqual(moveUpdates(choices[0]), { kind: "date", updates: { due_at: "2026-11-06T04:59:59.999Z" } });
  assert.deepEqual(moveUpdates(choices.find((c) => c.kind === "backlog")), { kind: "status", updates: { status: "Backlog", due_at: null } });
  assert.deepEqual(moveUpdates(choices.find((c) => c.kind === "park")), { kind: "status", updates: { status: "Parked" } });
  assert.throws(() => moveUpdates({ key: "x", kind: "day", label: "x" }));
  assert.equal(moveToastText(choices.find((c) => c.kind === "backlog"), "Renew passport"), "Moved “Renew passport” to the Backlog (no date)");
  assert.equal(moveToastText(choices.find((c) => c.kind === "park"), "Renew passport"), "Parked “Renew passport”");
});

// ── 4. Columns: widths, the fold, counts ─────────────────────────────────

await test("columns: past days count done/all, today and later 'n open'; past days fold; weights narrow past days when the panel opens", () => {
  const { dayColumns, gridTracks, foldedDayText } = need(lib, "today-board");
  const columns = dayColumns(WEEK, TODAY, [0, 0, 0, 4, 3], [2, 2, 1, 0, 0]);
  assert.deepEqual(columns.map((c) => [c.name, c.day, c.tense, c.count, c.folds]), [
    ["Mon", 2, "past", "2/2", true],
    ["Tue", 3, "past", "2/2", true],
    ["Wed", 4, "past", "1/1", true],
    ["Thu", 5, "today", "4 open", false],
    ["Fri", 6, "future", "3 open", false],
  ]);
  assert.equal(gridTracks(columns.map((c) => c.weight)), "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.55fr) minmax(0,1.25fr)");
  assert.equal(gridTracks(columns.map((c) => c.weightOpen)), "minmax(0,0.6fr) minmax(0,0.6fr) minmax(0,0.6fr) minmax(0,1.65fr) minmax(0,1.3fr)");
  const shareOpen = columns.slice(3).reduce((sum, c) => sum + c.weightOpen, 0) / columns.reduce((sum, c) => sum + c.weightOpen, 0);
  assert.ok(shareOpen > 0.6, "with the panel open, today and the rest of the week keep most of the width");
  const nextWeek = dayColumns("2026-11-09", TODAY, [1, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
  assert.ok(nextWeek.every((c) => c.tense === "future" && c.weight === 1 && c.weightOpen === 1 && !c.folds), "a week without today is even and never folds");
  assert.equal(nextWeek[1].count, null);
  assert.equal(foldedDayText(2), "2 done");
  assert.equal(foldedDayText(0), "nothing done");
});

// ── 5. The strip ─────────────────────────────────────────────────────────

await test("strip: the meeting under way or next, how many are left, the countdown and length", () => {
  const { nextMeetingOf, meetingCountdown, meetingLength } = need(lib, "today-board");
  const at = (h, m) => new Date(Date.UTC(2026, 10, 5, h + 5, m)).toISOString();
  const events = [
    { title: "Standup", start: at(10, 30), end: at(11, 0) },
    { title: "Earlier", start: at(9, 0), end: at(9, 30) },
    { title: "Review", start: at(14, 0), end: at(15, 30) },
    { title: "1:1", start: at(16, 0), end: at(16, 30) },
  ];
  const tenTen = Date.parse(at(9, 50));
  assert.equal(nextMeetingOf(events, tenTen).next.title, "Standup");
  assert.equal(nextMeetingOf(events, tenTen).moreLater, 2);
  assert.equal(meetingCountdown(events[0], tenTen), "in 40 min");
  assert.equal(meetingLength(events[0]), "30 min");
  assert.equal(meetingLength(events[2]), "1h 30m");
  assert.equal(meetingCountdown(events[0], Date.parse(at(10, 40))), "now · 20 min left");
  assert.equal(meetingCountdown(events[2], Date.parse(at(11, 55))), "in 2h 5m");
  assert.deepEqual(nextMeetingOf(events, Date.parse(at(17, 0))), { next: null, moreLater: 0 });
});

// ── 6. Rendered pieces ───────────────────────────────────────────────────

const noop = () => {};
const cardData = (extra = {}) => ({
  id: "c0000000-0000-4000-8000-000000000001",
  title: "Submit M&M 1.0.2 build",
  tags: [],
  estimatedMinutes: 30,
  dueAt: "2026-11-05T22:00:00.000Z",
  dueState: "Due Today",
  status: "In Progress",
  blocker: false,
  pinned: false,
  dependencyBlocked: false,
  updatedAt: null,
  unblockedAt: null,
  priorityScore: 60,
  projectName: null,
  waitingOn: null,
  followUpAt: null,
  needsReview: false,
  isPersonal: false,
  range: null,
  owner: "brent",
  ownerLabel: null,
  statusLine: "Build 41 passed review.",
  ...extra,
});

await test("rendered: the card open in the panel is outlined with an 'Open in panel' tag; every card has Done + Move to…", () => {
  const { WeeklyTaskCard } = need(cards, "BoardTaskCard");
  const move = { choices: [], input: task("t"), onPick: noop };
  const open = renderToStaticMarkup(h(WeeklyTaskCard, { task: cardData(), completing: false, moving: false, open: true, tense: "today", dueText: "due today 5 PM", onOpen: noop, onDone: noop, move }));
  assert.match(open, /data-open=""/);
  assert.match(open, /<span class="tb-openmark">Open in panel<\/span>/);
  assert.match(open, /data-tense="today"/);
  assert.match(open, /<span class="tb-own" data-owner="brent">You<\/span>/);
  assert.match(open, /<p class="tb-st">Build 41 passed review\.<\/p>/);
  assert.match(open, /aria-label="Mark task complete">✓ Done/);
  assert.match(open, /aria-haspopup="dialog" aria-expanded="false" aria-label="Move “Submit M&amp;M 1\.0\.2 build” to another day"/);
  const closed = renderToStaticMarkup(h(WeeklyTaskCard, { task: cardData({ owner: "agent", ownerLabel: "PM" }), completing: false, moving: false, onOpen: noop, onDone: noop, move }));
  assert.doesNotMatch(closed, /data-open|Open in panel/);
  assert.match(closed, /data-owner="agent">Agent: PM</);
  const overdue = renderToStaticMarkup(h(WeeklyTaskCard, { task: cardData({ dueState: "Overdue" }), tense: "overdue", dueText: "was due Tue", completing: false, moving: false, onOpen: noop, onDone: noop, move }));
  assert.match(overdue, /data-late=""/);
  assert.match(overdue, /<span class="tb-due" data-late="">was due Tue<\/span>/);
  assert.match(overdue, /Move to…/);
});

await test("rendered: lane bars have Done + Move…; done lines are struck through and still open the task", () => {
  const { LaneBar, DoneRow } = need(cards, "BoardTaskCard");
  const t = { id: "r", title: "Blanket rows 41–60", status: "In Progress", due_at: "2026-11-09T04:59:59.999Z", start_at: "2026-11-02T05:00:00.000Z", tags: ["personal"], project: null };
  const view = rangeView.buildRangeCardView(t, [{ is_done: true, unit_count: null }, { is_done: false, unit_count: null }], NOW);
  const bar = renderToStaticMarkup(h(LaneBar, {
    task: cardData({ id: "r", title: t.title, range: view }), view, open: true, late: false, startCol: 0, endCol: 4,
    startedText: null, continuesText: "to Sun →", completing: false, moving: false, onOpen: noop, onDone: noop,
    move: { choices: [], input: t, onPick: noop }, stepsOpen: false,
  }));
  assert.match(bar, /class="tb-bar" data-task-open="r"/);
  assert.match(bar, /data-open=""/);
  assert.match(bar, /class="tb-chip">Day 4 of 7</);
  assert.match(bar, /<span class="tb-cont">to Sun →<\/span>/);
  assert.match(bar, /aria-label="Mark “Blanket rows 41–60” complete">✓ Done/);
  assert.match(bar, /Move…<\/button>/);
  const doneRow = renderToStaticMarkup(h(DoneRow, { task: cardData({ status: "Done", title: "Data retention review" }), onOpen: noop }));
  assert.match(doneRow, /<button type="button" class="tb-dn" data-task-open="c0000000-0000-4000-8000-000000000001" aria-label="Data retention review \(done\)">/);
  assert.match(doneRow, /<span class="tb-t2">Data retention review<\/span>/);
});

// ── 7. Wiring ────────────────────────────────────────────────────────────

await test("Today is the strip + the board: Now, the meetings card and the Blocked / Waiting strip are gone", () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /<WeekBoardSection/);
  assert.doesNotMatch(page, /NowPanelSection|MeetingsSection|WaitingStripSection|PageHeader/);
  for (const gone of [
    "src/components/today/sections/NowPanel.tsx",
    "src/components/today/sections/NowPanelSection.tsx",
    "src/components/today/sections/MeetingsSection.tsx",
    "src/components/today/sections/WaitingStrip.tsx",
    "src/components/today/sections/WaitingStripSection.tsx",
    "src/components/today/cards/NowTaskCard.tsx",
  ]) {
    assert.ok(!exists(gone), `${gone} deleted`);
  }
  const section = read("src/components/today/sections/WeekBoardSection.tsx");
  assert.match(section, /queryTodayCalendar\(supabase, userId, TIME_ZONE\)/, "the strip's meetings come with the board");
  assert.match(section, /queryWeekDoneTasks\(supabase, userId, week\.start, week\.end, mode\)/);
  const board = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(board, /<TodayStrip/);
  assert.match(board, /splitTodayBoard\(\{ tasks, waiting, todayDate, now \}\)/);
  assert.match(board, /placeWeekTasks\(split\.board,/, "the lane and the days only get board tasks (Waiting and Overdue live in the rail)");
});

await test("the weekly board read and its /api/tasks view are unchanged (done tasks come from a Today-only read)", () => {
  const queries = read("src/lib/today/queries.ts");
  const weekly = queries.match(/export async function queryWeeklyBoardTasks[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(weekly, /\.neq\('status', 'Done'\)/);
  const done = queries.match(/export async function queryWeekDoneTasks[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(done, /\.eq\('user_id', userId\)/, "filtered by user");
  assert.match(done, /\.eq\('status', 'Done'\)/);
  assert.match(done, /filterTasksByScope\(/, "Work / Personal / All applies");
  assert.doesNotMatch(read("src/app/api/tasks/route.ts"), /queryWeekDoneTasks/);
});

await test("moves reuse the existing paths: a day through the date cascade, Backlog / Park through useTaskMutation; no new PATCH", () => {
  const board = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(board, /dateCascade\.changeDueDate\(\{[\s\S]*updates: \{ due_at: nextDueAt \}[\s\S]*week: \{ weekStart: selectedWeekStart, showNextWeek/);
  assert.match(board, /await updateTaskWithUndo\(task\.id, plan\.updates, undo, \{/);
  assert.match(board, /choice\.kind === "day" && choice\.date\) void handleMoveToDay\(raw\.id, choice\.date\)/);
  const hook = read("src/hooks/useTaskMutation.ts");
  assert.match(hook, /const updateTaskWithUndo = useCallback\([\s\S]*await patchTask\(taskId, updates\)[\s\S]*await patchTask\(taskId, undoUpdates\)/);
  for (const file of ["src/components/today/sections/WeekBoard.tsx", "src/components/today/cards/BoardTaskCard.tsx", "src/components/today/MoveToMenu.tsx", "src/components/today/sections/TodayStrip.tsx"]) {
    assert.doesNotMatch(read(file), /method:\s*["']PATCH["']|\.from\(['"]tasks['"]\)/, `${file} has no direct write`);
  }
});

await test("every card offers Move to…: day cards, Overdue cards and lane bars all get move={moveFor(…)}", () => {
  const board = read("src/components/today/sections/WeekBoard.tsx");
  const renderCard = board.match(/const renderCard = [\s\S]*?\n  \);\n/)?.[0] ?? "";
  assert.match(renderCard, /move=\{moveFor\(data\.id\)\}/);
  assert.match(board, /renderCard\(data, "overdue", "overdue"/);
  assert.match(board, /renderCard\(data, `col-\$\{column\.date\}`/);
  assert.match(board, /<LaneBar[\s\S]*?move=\{moveFor\(data\.id\)\}/);
});

await test("the board narrows with the task panel: ?task drives data-panel; the fold rules, side tabs and open-card outline are in the CSS", () => {
  const board = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(board, /const openTaskId = taskIdFromParams\(params, "\/"\);/);
  assert.match(board, /data-panel=\{panelOpen \? "open" : "closed"\}/);
  assert.match(board, /open=\{openTaskId === data\.id\}/);
  assert.match(board, /data-rail-tab="overdue"[\s\S]*<b>\{overdueCount\}<\/b>[\s\S]*data-rail-tab="waiting"[\s\S]*<b>\{waitingCount\}<\/b>/);
  const css = read("src/components/today/today-board.css");
  const desktop = css.split("@media (min-width: 1024px)").slice(1).join("\n");
  assert.match(desktop, /\.tb\[data-panel="open"\] \.tb-board \{\s*grid-template-columns: 44px var\(--tb-days-open\);/);
  assert.match(desktop, /\.tb\[data-panel="open"\] \.tb-day\[data-tense="past"\] \.tb-full \{\s*display: none;/);
  assert.match(desktop, /\.tb\[data-panel="open"\] \.tb-day\[data-tense="past"\] \.tb-fold \{\s*display: flex;/);
  assert.match(desktop, /\.tb\[data-panel="open"\] \.tb-tabs \{/);
  assert.match(desktop, /\.tb\[data-panel="open"\] \.tb-rail \{\s*display: none;/);
  assert.match(css, /\.tb-card\[data-open\] \{\s*border: 2px solid var\(--brand\);/);
  assert.match(css, /\.tb-card\[data-open\]::after \{/, "the notch pointing at the panel");
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.tb-day\[data-tense="past"\] \.tb-full \{\s*display: none;/, "a phone always folds past days");
});

await test("layer order: the rail fly-out (20) sits under the desktop panel (25); the Move to… menu shares Modal's 50; both own their Esc", () => {
  const css = read("src/components/today/today-board.css");
  assert.match(css, /\.tb-rail\[data-flyout\] \{[^}]*z-index: 20;/);
  // S5: the menu's rules moved to their own file (Tasks shows it too); both pages import it.
  const menuCss = read("src/components/today/move-to-menu.css");
  assert.match(menuCss, /\.tb-move \{[^}]*z-index: 50;/);
  assert.doesNotMatch(css, /\.tb-move\b/, "no copy left in today-board.css");
  assert.match(read("src/components/today/sections/WeekBoard.tsx"), /import "@\/components\/today\/move-to-menu\.css";/);
  assert.match(read("src/components/tasks/panel/task-panel.css"), /\.tp-panel \{[^}]*z-index: 25;/);
  assert.match(read("src/components/ui/Modal.tsx"), /z-50/);
  const menu = read("src/components/today/MoveToMenu.tsx");
  assert.match(menu, /role="dialog"\s+aria-modal="false"/, "the panel's anyDialogOpen() sees it, so Esc closes only the menu");
  assert.match(menu, /window\.addEventListener\("keydown", onKey, true\)/);
  const board = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(board, /role=\{activeFlyout \? "dialog" : undefined\}/);
  assert.match(board, /aria-modal=\{activeFlyout \? "false" : undefined\}/);
});

await test("phone and a11y: 44 px touch targets, the 12 px type floor, reduced motion, light-dark tokens only, no vendor names", () => {
  const css = read("src/components/today/today-board.css") + "\n" + read("src/components/today/move-to-menu.css");
  const coarse = css.split("@media (pointer: coarse)").slice(1).map((block) => block.slice(0, block.indexOf("}\n}") + 3)).join("\n");
  for (const selector of [".tb-pager button", ".tb-wrow", ".tb-linkbtn", ".tb-addrow", ".tb-dn", ".tb-wk-it", ".tb-move-item"]) {
    assert.ok(coarse.includes(selector), `${selector} grows on a touch screen`);
  }
  assert.match(coarse, /min-height: 44px/);
  for (const match of css.matchAll(/font:\s*\d+\s+(\d+)px/g)) {
    assert.ok(Number(match[1]) >= 12, `font size ${match[1]}px is under the 12px floor`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /prefers-color-scheme|#[0-9a-fA-F]{3,6}\b/, "colours come from the light-dark() tokens");
  for (const file of ["src/components/today/sections/WeekBoard.tsx", "src/components/today/cards/BoardTaskCard.tsx", "src/components/today/MoveToMenu.tsx", "src/components/today/sections/TodayStrip.tsx", "src/lib/today/today-board.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /text-\[1[01]px\]/, `${file}: text-xs is the floor`);
    assert.doesNotMatch(source, /\bClaude\b|Anthropic/, `${file} names no AI product`);
  }
});

// ── 8. Faded late copies (week grid only) ────────────────────────────────

// Thu 5 Nov: Mon 2 and Tue 3 are earlier days of this week; Fri 30 Oct is last week.
const lateFixture = () => [
  task("mon-a", { title: "Send the OnCore export", due_at: endOf("2026-11-02"), priority_score: 70 }),
  task("mon-b", { title: "Book the venue", due_at: "2026-11-02T15:00:00.000Z" }),
  task("tue", { due_at: endOf("2026-11-03") }),
  task("last-fri", { due_at: endOf("2026-10-30") }),
  task("range-wed", { due_at: endOf("2026-11-04"), start_at: "2026-10-28T04:00:00.000Z" }),
  task("earlier-today", { due_at: "2026-11-05T14:00:00.000Z" }),
  task("done-mon", { status: "Done", due_at: endOf("2026-11-02") }),
  task("missed-mon", { status: "Missed", due_at: endOf("2026-11-02") }),
  task("parked-tue", { status: "Parked", due_at: endOf("2026-11-03") }),
  task("waiting-mon", { status: "Blocked/Waiting", due_at: endOf("2026-11-02") }),
];
const lateSplit = () => need(lib, "today-board").splitTodayBoard({ tasks: lateFixture(), waiting: [], todayDate: TODAY, now: NOW });
const idsOn = (byDay, date) => (byDay.get(date) ?? []).map((t) => t.id);

await test("late copies: an Overdue task shows on its original due day of the shown week, oldest first; the real one stays in Overdue", () => {
  const { lateCopiesByDay } = need(lib, "today-board");
  assert.equal(typeof lateCopiesByDay, "function", "lateCopiesByDay exists");
  const split = lateSplit();
  const byDay = lateCopiesByDay(split.overdue, WEEK);
  assert.deepEqual([...byDay.keys()], ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"], "every day of the week, weekend too");
  assert.deepEqual(idsOn(byDay, "2026-11-02"), ["mon-b", "mon-a"], "Monday's two, in the Overdue queue's order (oldest due first)");
  assert.deepEqual(idsOn(byDay, "2026-11-03"), ["tue"]);
  assert.deepEqual(idsOn(byDay, "2026-11-04"), ["range-wed"], "a multi-day task's copy sits on its due (end) day only");
  assert.deepEqual(idsOn(byDay, "2026-10-28"), [], "never on its start day");
  assert.deepEqual(idsOn(byDay, "2026-11-05"), [], "a task due earlier today is on today's column already, not a copy");
  assert.ok(split.board.some((t) => t.id === "earlier-today"));
  const real = split.overdue.map((t) => t.id);
  for (const id of ["mon-a", "mon-b", "tue", "range-wed", "last-fri"]) assert.ok(real.includes(id), `${id} is still in the Overdue queue`);
  assert.ok(!split.board.some((t) => real.includes(t.id)), "an overdue task is still never on the board itself");
});

await test("late copies: none for a task overdue from a previous week; that week shows it when it is the week shown", () => {
  const { lateCopiesByDay } = need(lib, "today-board");
  const split = lateSplit();
  const thisWeek = lateCopiesByDay(split.overdue, WEEK);
  const all = [...thisWeek.values()].flat().map((t) => t.id);
  assert.ok(!all.includes("last-fri"), "Fri 30 Oct is not a day of this week");
  const lastWeek = lateCopiesByDay(split.overdue, "2026-10-26");
  assert.deepEqual(idsOn(lastWeek, "2026-10-30"), ["last-fri"], "paging back to last week puts it on its Friday");
  assert.deepEqual([...lastWeek.values()].flat().map((t) => t.id), ["last-fri"]);
});

await test("late copies: Done, Missed, Parked and Waiting tasks never get one (even if handed in directly)", () => {
  const { lateCopiesByDay } = need(lib, "today-board");
  const viaSplit = [...lateCopiesByDay(lateSplit().overdue, WEEK).values()].flat().map((t) => t.id);
  const direct = [...lateCopiesByDay(lateFixture(), WEEK).values()].flat().map((t) => t.id);
  for (const ids of [viaSplit, direct]) {
    for (const id of ["done-mon", "missed-mon", "parked-tue", "waiting-mon"]) assert.ok(!ids.includes(id), `${id} gets no copy`);
  }
  assert.deepEqual([...lateCopiesByDay([], WEEK).values()].flat(), []);
});

await test("late copies: a day shows 3, then '+ n more late'; the accessible name says late and that it lives in Overdue", () => {
  const { LATE_COPY_LIMIT, railQueue, lateCopyLabel } = need(lib, "today-board");
  assert.equal(LATE_COPY_LIMIT, 3);
  assert.deepEqual(railQueue([1, 2, 3, 4, 5], false, LATE_COPY_LIMIT), { shown: [1, 2, 3], hidden: 2 });
  assert.equal(lateCopyLabel("Send the OnCore export", endOf("2026-11-02"), TODAY), "Send the OnCore export: late, was due Mon. The task is in Overdue.");
  assert.equal(lateCopyLabel("  Old one ", endOf("2026-10-20"), TODAY), "Old one: late, was due Oct 20. The task is in Overdue.");
  assert.equal(lateCopyLabel("No date", null, TODAY), "No date: late. The task is in Overdue.");
});

await test("rendered: a late copy is a faded line that only opens the task (no Done, no Move to…, no box, not draggable)", () => {
  const { LateCopy } = need(cards, "BoardTaskCard");
  assert.equal(typeof LateCopy, "function", "LateCopy exists");
  let opened = 0;
  const props = { task: cardData({ dueState: "Overdue", title: "Send the OnCore export" }), label: "Send the OnCore export: late, was due Mon. The task is in Overdue.", onOpen: () => (opened += 1) };
  const html = renderToStaticMarkup(h(LateCopy, props));
  assert.match(html, /^<button type="button" class="tb-lc" data-task-open="c0000000-0000-4000-8000-000000000001"/, "one button carrying data-task-open (the panel's ↑ / ↓ see it)");
  assert.match(html, /aria-label="Send the OnCore export: late, was due Mon\. The task is in Overdue\."/);
  assert.match(html, /<span class="tb-lc-tag" aria-hidden="true">Late<\/span>/);
  assert.match(html, /<span class="tb-lc-t">Send the OnCore export<\/span>/);
  assert.doesNotMatch(html, /draggable|Done|Move|checkbox|<input|data-late=/, "no drag, no Done, no Move to…, no box, not a late card");
  assert.equal((html.match(/<button/g) ?? []).length, 1, "nothing to click inside it");
  const element = LateCopy(props);
  element.props.onClick();
  assert.equal(opened, 1, "a click opens the task");
});

await test("wiring: copies render on past days and the weekend (outside the folded part), open the panel, and change no count", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /const lateByDate = lateCopiesByDay\(split\.overdue, selectedWeekStart\);/);
  assert.match(src, /railQueue\(lateByDate\.get\(date\) \?\? \[\], false, LATE_COPY_LIMIT\)/);
  assert.match(src, /<LateCopy[\s\S]{0,200}onOpen=\{\(\) => handleOpenTask\(task\.id\)\}/, "click opens the same panel (?task) as the real card");
  assert.match(src, /const handleOpenTask = \(taskId: string\) => \{\s*const raw = rawById\.get\(taskId\);\s*if \(raw\) openTask\(raw\);/);
  assert.match(src, /className="tb-lc-more"\s+onClick=\{\(\) => goToDay\(date, null\)\}/, "'+ n more late' opens that day as a list");
  // In the column, after .tb-full (so a folded past day still shows them).
  assert.match(src, /<div className="tb-full"[\s\S]*?\n {18}<\/div>\n {18}\{\/\* Outside \.tb-full[^\n]*\n {18}\{renderLateCopies\(column\.date\)\}\n {16}<\/div>/);
  assert.match(src, /\{renderLateCopies\(date\)\}/, "the weekend strip too");
  assert.equal((src.match(/const renderLateCopies = /g) ?? []).length, 1, "defined once");
  assert.equal((src.match(/\{renderLateCopies\(/g) ?? []).length, 2, "used in the columns and the weekend, nowhere else");
  // Counts: the header and the day tabs read the board only.
  assert.match(src, /weekDates\.slice\(0, 5\)\.map\(\(date\) => singlesByDate\.get\(date\)\?\.length \?\? 0\)/);
  assert.match(src, /const dayRowsFor = \(day: string\) => groupDayList\(\{ board: split\.board, overdue: split\.overdue, done, day \}\);/);
  const columnsCall = src.slice(src.indexOf("const columns = dayColumns("), src.indexOf("const hiddenDoneCount"));
  assert.doesNotMatch(columnsCall, /late/i, "dayColumns gets no late copies");
  assert.match(src, /renderCard\(data, "overdue", "overdue", \{ text: overdueLabel\(data\.dueAt, todayDate\), late: true \}\)/, "the real card is still in the Overdue rail");
  // Week grid only: the one-day list and the phone's today list never draw copies.
  const dayList = read("src/components/today/sections/DayList.tsx");
  assert.doesNotMatch(dayList, /LateCopy|lateCopies|tb-lc/);
  const dayView = src.slice(src.indexOf("const dayView = viewDay"), src.indexOf("return (\n    <div\n      className=\"tb\""));
  assert.doesNotMatch(dayView, /LateCopy|renderLateCopies/);
});

await test("CSS: copies are muted (no opacity on the text), dashed, never folded away, 44 px on touch, tokens only", () => {
  const css = read("src/components/today/today-board.css");
  const rule = (selector) => {
    const match = css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`));
    return match ? match[1] : "";
  };
  const lc = rule(".tb-lc");
  assert.ok(lc, ".tb-lc has a rule");
  assert.match(lc, /border: 1px dashed/);
  assert.match(lc, /color: var\(--ink-2\)/, "muted ink, still readable");
  assert.doesNotMatch(lc, /opacity/, "the text keeps its contrast");
  assert.match(rule(".tb-lc-tag"), /color: var\(--tb-late\)/, "the existing late colour");
  assert.match(rule(".tb-lc-t"), /-webkit-line-clamp: 2;/, "two lines at most: a narrow past day doesn't grow");
  assert.doesNotMatch(css, /\.tb-(late|lc)[^{]*\{\s*display: none/, "no fold rule hides them");
  const coarse = css.split("@media (pointer: coarse)").slice(1).map((block) => block.slice(0, block.indexOf("}\n}") + 3)).join("\n");
  assert.ok(coarse.includes(".tb-lc") && coarse.includes(".tb-lc-more"), "copies and '+ n more late' grow on a touch screen");
});

// ── 9. Done below open (week grid + weekend) ─────────────────────────────

// The whole WeekBoard, rendered on the server with fixture tasks and a fixed
// clock (Thu 5 Nov 2026, 3 PM ET). Next's router contexts are given directly
// (no mocks of the board's own code).
async function renderBoard({ weekBoardTasks, doneTasks, waitingTasks = [] }) {
  const WeekBoardMod = await load("src/components/today/sections/WeekBoard.tsx");
  const { WeekBoard } = need(WeekBoardMod, "WeekBoard");
  const { TaskPanelProvider } = need(await load("src/components/tasks/panel/TaskPanelProvider.tsx"), "TaskPanelProvider");
  const { DateCascadeProvider } = need(await load("src/components/tasks/DateCascadeProvider.tsx"), "DateCascadeProvider");
  const { ToastProvider } = need(await load("src/components/ui/Toast.tsx"), "Toast");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { SearchParamsContext, PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  const router = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop };
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [NOW.getTime()] : args));
    }
    static now() {
      return NOW.getTime();
    }
  }
  globalThis.Date = FixedDate;
  try {
    return renderToStaticMarkup(
      h(AppRouterContext.Provider, { value: router },
        h(PathnameContext.Provider, { value: "/" },
          h(SearchParamsContext.Provider, { value: new URLSearchParams("") },
            h(ToastProvider, null,
              h(DateCascadeProvider, null,
                h(TaskPanelProvider, { widths: { today: 500, tasks: 660, other: 560 } },
                  h(WeekBoard, {
                    weekBoardTasks, waitingTasks, doneTasks, needsReviewCount: 0, syncedTaskIds: [], updatedAt: NOW.toISOString(),
                    hasError: false, mode: "work", meetings: [], meetingsFailed: false,
                  })
                )
              )
            )
          )
        )
      )
    );
  } finally {
    globalThis.Date = RealDate;
  }
}

const rawTask = (id, title, dueDate, extra = {}) => ({
  id, user_id: "u", title, description: null, implementation_id: null, project_id: null, section_id: null, sprint_id: null,
  status: "Planned", task_type: "Task", priority_score: 50, base_priority: 50, estimated_minutes: 30, actual_minutes: null,
  recurrence: null, recurring_template_id: null, is_recurring_template: false, latest_instance_id: null, last_generated_at: null,
  estimate_source: "default", start_at: null, due_at: endOf(dueDate), needs_review: false, blocker: false, waiting_on: null,
  blocked_reason: null, follow_up_at: null, stakeholder_mentions: [], tags: [], source_type: "Manual", source_url: null,
  external_source_system: null, external_source_id: null, inbox_item_id: null, pinned_excerpt: null, pinned: false,
  owner: "brent", owner_label: null, status_line: null, unit_count: null, work_type: null, is_sample: false,
  due_change_id: null, parent_task_id: null, source_checklist_item_id: null, unblocked_at: null,
  created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z",
  implementation: null, project: null, sprint: null, checklist_rows: [], step_tasks: [],
  ...extra,
});
const id = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FRI = "2026-11-06";
const SUN = "2026-11-08";
const boardFixture = {
  weekBoardTasks: [
    rawTask(id(1), "Open today A", TODAY),
    rawTask(id(2), "Open today B", TODAY),
    rawTask(id(3), "Open Friday", FRI),
    rawTask(id(4), "Open Sunday", SUN),
    rawTask(id(5), "Late from Monday", "2026-11-02"),
  ],
  doneTasks: [
    rawTask(id(11), "Done today", TODAY, { status: "Done" }),
    rawTask(id(12), "Done Friday", FRI, { status: "Done" }),
    rawTask(id(13), "Done Sunday", SUN, { status: "Done" }),
    rawTask(id(14), "Done Monday", "2026-11-02", { status: "Done" }),
  ],
};
/** One day column's markup (Mon–Fri) or one weekend day's, cut from the whole board. */
function dayChunk(html, marker) {
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `${marker} is on the board`);
  const nextDay = [html.indexOf('<div class="tb-day"', start + 1), html.indexOf('<section class="tb-wknd"', start + 1), html.indexOf("<div data-drop-day", start + 1)]
    .filter((index) => index > start);
  return html.slice(start, nextDay.length ? Math.min(...nextDay) : undefined);
}
/** The data-task-open ids in page order (the order the panel's ↑ / ↓ walk). */
const openOrder = (chunk) => [...chunk.matchAll(/data-task-open="([^"]+)"/g)].map((match) => match[1]);

await test("done below open: today's column draws its open cards first, then the done lines, then '+ add'", async () => {
  const html = await renderBoard(boardFixture);
  const today = dayChunk(html, `aria-label="Open Thursday 5 Nov as a list`);
  assert.deepEqual(openOrder(today), [id(1), id(2), id(11)], "open A, open B, then the done line (↑ / ↓ walk the same order)");
  const lastCard = today.lastIndexOf('class="tb-card');
  const done = today.indexOf('class="tb-dn"');
  const add = today.indexOf('class="tb-addrow"');
  assert.ok(lastCard >= 0 && done > lastCard, "the done line sits under the last open card");
  assert.ok(add > done, "'+ add to Thu' stays last, under the done line");
});

await test("done below open: a later day (Friday) the same, and an earlier day keeps its fold line and late copies", async () => {
  const html = await renderBoard(boardFixture);
  const fri = dayChunk(html, `aria-label="Open Friday 6 Nov as a list`);
  assert.deepEqual(openOrder(fri), [id(3), id(12)]);
  const mon = dayChunk(html, `aria-label="Open Monday 2 Nov as a list`);
  assert.match(mon, /class="tb-fold"[\s\S]*1 done/, "an earlier day still folds to its '1 done' line (hidden done, unchanged)");
  assert.ok(mon.indexOf('class="tb-full"') < mon.indexOf('class="tb-late"'), "late copies still sit after .tb-full, as before");
  assert.deepEqual(openOrder(mon), [id(14), id(5)], "Monday: its (hidden) done line, then the faded late copy, as before");
});

await test("done below open: a weekend day lists open tasks first, the done chips last, then '+ add'", async () => {
  const html = await renderBoard(boardFixture);
  const sun = dayChunk(html, `aria-label="Open Sunday 8 Nov as a list"`);
  assert.deepEqual(openOrder(sun), [id(4), id(13)], "open Sunday, then done Sunday");
  assert.ok(sun.indexOf('aria-label="Done Sunday (done)"') < sun.indexOf('class="tb-wk-add"'), "'+ add' stays last");
});

await test("done below open: the source keeps the order (open cards, then done lines, then 'Nothing due.' / '+ add')", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  const full = src.slice(src.indexOf('<div className="tb-full"'), src.indexOf("{/* Outside .tb-full"));
  const cardsAt = full.indexOf("singles.map((data) => renderCard(");
  const doneAt = full.indexOf("doneRows.map((data) => (");
  assert.ok(cardsAt >= 0 && doneAt > cardsAt, "the day's open cards come before its done lines");
  assert.ok(full.indexOf('className="tb-addrow"') > doneAt, "'+ add' after the done lines");
  const weekend = src.slice(src.indexOf("const renderWeekendDay = "), src.indexOf("const overdueCount = "));
  const order = ["items.continuing.map(", "[...items.ranges, ...items.singles].map(", "{renderLateCopies(date)}", "doneShown.map(", 'className="tb-fold-show"', 'className="tb-wk-add"'].map((needle) => weekend.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), "every weekend piece is there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "weekend: continuing, ranges + singles, late copies, done, '… · show', '+ add'");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
