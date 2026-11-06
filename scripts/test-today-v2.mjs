#!/usr/bin/env node
// Today v2 (Brent 11/6; mockup grocery-design-mockups/baseline-redesign/today-v2):
// earlier done tasks hidden on the week, a day header opens that day as a list
// at /?day=YYYY-MM-DD, the phone opens straight into today's list, plus the
// Tasks saved-view highlight fix and the S4 review follow-ups F1, F2, F4, F6.
// Offline (no database, network or browser). Run: npm run test:today-v2
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(process.env.TODAY_V2_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readIf = (rel) => (exists(rel) ? read(rel) : "");

registerHooks({
  load(url, context, nextLoad) {
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
  if (!exists(rel)) {
    console.log(`(${rel} does not exist)`);
    return null;
  }
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } catch (error) {
    console.log(`(${rel} did not load: ${String(error?.message ?? error).split("\n")[0]})`);
    return null;
  }
}
function need(mod, name) {
  assert.ok(mod, `${name} exists and loads`);
  return mod;
}

const board = await load("src/lib/today/today-board.ts");
const day = await load("src/lib/today/today-day.ts");
const list = await load("src/lib/tasks-list.ts");
const panel = await load("src/lib/task-panel.ts");
const templates = await load("src/lib/project-templates.ts");
const DayListMod = await load("src/components/today/sections/DayList.tsx");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

// Thursday 5 Nov 2026, 3 PM ET (EST). The week runs Mon 2 – Sun 8 Nov (mockup's sample week).
const NOW = new Date("2026-11-05T20:00:00.000Z");
const TODAY = "2026-11-05";
const WEEK = "2026-11-02";
const endOf = (date) => need(board, "today-board").dueAtForBoardDay(date);
const startOf = (date) => new Date(Date.parse(endOf(date)) + 1 - 86_400_000).toISOString();
const task = (id, extra = {}) => ({ id, title: id, status: "Planned", due_at: endOf(TODAY), start_at: null, tags: [], project: null, priority_score: 50, ...extra });

// ── 1. Hide earlier done ─────────────────────────────────────────────────

await test("hide-done: earlier days' done tasks hide by default; today's and the days ahead never do; Show done brings them back", () => {
  const { hidesDone, earlierDoneCount, dayColumns } = need(board, "today-board");
  assert.equal(typeof hidesDone, "function", "hidesDone exists");
  assert.equal(hidesDone("past", false), true);
  assert.equal(hidesDone("past", true), false, "Show done on");
  assert.equal(hidesDone("today", false), false, "today's own done tasks stay");
  assert.equal(hidesDone("future", false), false);
  const columns = dayColumns(WEEK, TODAY, [0, 0, 0, 4, 5], [2, 2, 1, 1, 0], { doneHidden: true });
  assert.equal(earlierDoneCount(columns, [2, 2, 1, 1, 0]), 5, "Show done · 5 (Mon–Wed; Thu's own done is not counted)");
});

await test("hide-done: earlier columns narrow while their done is hidden (mockup frame 1), full width again with Show done", () => {
  const { dayColumns, gridTracks } = need(board, "today-board");
  const hidden = dayColumns(WEEK, TODAY, [0, 0, 0, 4, 5], [2, 2, 1, 1, 0], { doneHidden: true });
  const shown = dayColumns(WEEK, TODAY, [0, 0, 0, 4, 5], [2, 2, 1, 1, 0], { doneHidden: false });
  assert.deepEqual(hidden.map((c) => c.weight), [0.75, 0.75, 0.75, 1.55, 1.25]);
  assert.deepEqual(shown.map((c) => c.weight), [1, 1, 1, 1.55, 1.25]);
  assert.deepEqual(hidden.map((c) => c.weightOpen), shown.map((c) => c.weightOpen), "the panel-open widths are unchanged");
  assert.equal(gridTracks(hidden.map((c) => c.weight)), "minmax(0,0.75fr) minmax(0,0.75fr) minmax(0,0.75fr) minmax(0,1.55fr) minmax(0,1.25fr)");
  const other = dayColumns("2026-10-26", TODAY, [0, 0, 0, 0, 0], [1, 1, 1, 1, 1], { doneHidden: true });
  assert.ok(other.every((c) => c.weight === 1), "a week without today stays even");
});

await test("hide-done: always starts hidden (no remembering), the header toggle, the folded '✓ n done · show' line, the CSS", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /const \[showDone, setShowDone\] = useState\(false\);/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie/, "Brent: 'Always start hidden' — nothing remembers it");
  assert.match(src, /data-done=\{showDone \? "shown" : "hidden"\}/);
  assert.match(src, /className="tb-showdone" aria-pressed=\{showDone\}/);
  assert.match(src, /Show done <span className="tb-showdone-n">\{hiddenDoneCount\}<\/span>/);
  assert.match(src, /\{ doneHidden: !showDone \}/);
  assert.match(src, /className="tb-fold-show"[\s\S]{0,80}onClick=\{\(\) => goToDay\(column\.date, null\)\}/, "'show' opens that day");
  const css = read("src/components/today/today-board.css");
  assert.match(css, /\.tb\[data-done="hidden"\] \.tb-day\[data-tense="past"\] \.tb-full \{\s*display: none;/);
  assert.match(css, /\.tb\[data-done="hidden"\] \.tb-day\[data-tense="past"\] \.tb-fold \{\s*display: flex;/);
  assert.doesNotMatch(css, /data-done="hidden"\][^{]*data-tense="today"/, "today's column is never folded");
});

// ── 2. ?day ──────────────────────────────────────────────────────────────

await test("?day: a real YYYY-MM-DD opens that day; anything else (bad shape, impossible day, two values) is the week", () => {
  const { parseDayParam } = need(day, "today-day");
  assert.equal(parseDayParam("2026-11-06"), "2026-11-06");
  assert.equal(parseDayParam(" 2026-11-06 "), "2026-11-06");
  assert.equal(parseDayParam(["2026-11-06"]), "2026-11-06");
  for (const bad of [null, undefined, "", "today", "2026-11-6", "2026-02-30", "2026-13-01", "2026-00-10", "1999-12-31", "2100-01-01", "2026-11-06T00:00", "06/11/2026", ["2026-11-06", "2026-11-07"], []]) {
    assert.equal(parseDayParam(bad), null, `${JSON.stringify(bad)} → the week`);
  }
  assert.equal(parseDayParam("2028-02-29"), "2028-02-29", "a leap day is real");
});

await test("?day: the address keeps the page's other params; the day's week (Mon–Sun) and how far it is from this week", () => {
  const { hrefWithDay, mondayOf, weekOffsetOf, DAY_PARAM } = need(day, "today-day");
  assert.equal(DAY_PARAM, "day");
  assert.equal(hrefWithDay("/", "?mode=personal", "2026-11-06"), "/?mode=personal&day=2026-11-06");
  assert.equal(hrefWithDay("/", "?mode=all&day=2026-11-06&task=abc", "2026-11-07"), "/?mode=all&day=2026-11-07&task=abc");
  assert.equal(hrefWithDay("/", "?day=2026-11-06&task=abc", null), "/?task=abc");
  assert.equal(hrefWithDay("/", "", null), "/");
  assert.equal(mondayOf("2026-11-06"), "2026-11-02");
  assert.equal(mondayOf("2026-11-08"), "2026-11-02", "Sunday is the end of the week");
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(weekOffsetOf("2026-11-10", WEEK), 1);
  assert.equal(weekOffsetOf("2026-10-30", WEEK), -1);
  assert.equal(weekOffsetOf("2026-11-08", WEEK), 0);
});

// ── 3. The day list ──────────────────────────────────────────────────────

const fri = "2026-11-06";
const boardTasks = [
  task("famcal", { due_at: endOf(fri), priority_score: 70 }),
  task("movers", { due_at: "2026-11-06T16:00:00.000Z", status: "In Progress" }), // 11 AM ET
  task("playtest", { due_at: "2026-11-06T17:00:00.000Z" }), // 12 PM ET
  task("blanket", { due_at: endOf("2026-11-08"), start_at: startOf("2026-11-02"), tags: ["personal"] }), // Mon → Sun, personal
  task("boxes", { due_at: endOf(fri), start_at: startOf("2026-11-04"), tags: ["personal"] }), // Wed → Fri
  task("thursday", { due_at: endOf(TODAY) }),
];
const overdueTasks = [task("old", { due_at: endOf("2026-11-03") })];
const doneTasks = [task("storage", { status: "Done", due_at: endOf(fri) }), task("monday-done", { status: "Done", due_at: endOf("2026-11-02") })];

await test("day list: grouped Due <day> / Running through <day> (multi-day) / Done, each sorted; counts", () => {
  const { groupDayList, dayCounts } = need(day, "today-day");
  const groups = groupDayList({ board: boardTasks, overdue: overdueTasks, done: doneTasks, day: fri });
  assert.deepEqual(groups.due.map((t) => t.id), ["movers", "playtest", "famcal"], "by due time, an end-of-day due last");
  assert.deepEqual(groups.running.map((t) => t.id), ["boxes", "blanket"], "a range covering Fri, ending Fri included");
  assert.deepEqual(groups.done.map((t) => t.id), ["storage"]);
  assert.deepEqual(dayCounts(groups), { due: 3, running: 2, done: 1 });
});

await test("day list: an earlier day shows its done AND what is still open from it (drawn late); Waiting never enters", () => {
  const { groupDayList } = need(day, "today-day");
  const tue = groupDayList({ board: boardTasks, overdue: overdueTasks, done: doneTasks, day: "2026-11-03" });
  assert.deepEqual(tue.due.map((t) => t.id), ["old"], "the overdue task is on its own day's list");
  assert.deepEqual(tue.running.map((t) => t.id), ["blanket"]);
  const mon = groupDayList({ board: boardTasks, overdue: overdueTasks, done: doneTasks, day: "2026-11-02" });
  assert.deepEqual(mon.done.map((t) => t.id), ["monday-done"]);
  const split = need(board, "today-board").splitTodayBoard({
    tasks: [...boardTasks, task("blocked", { status: "Blocked/Waiting", due_at: endOf(fri) })],
    waiting: [],
    todayDate: TODAY,
    now: NOW,
  });
  const withWaiting = groupDayList({ board: split.board, overdue: split.overdue, done: [], day: fri });
  assert.ok(!withWaiting.due.some((t) => t.id === "blocked"), "a Blocked task stays in Waiting only");
});

await test("day list: the seven tabs ('2 done' earlier, '4 open' today and after, TODAY), Day n of n for the day shown", () => {
  const { dayTabs, rangeDayOn } = need(day, "today-day");
  const tabs = dayTabs(WEEK, TODAY, (d) => ({ "2026-11-05": 4, "2026-11-06": 5, "2026-11-07": 2 })[d] ?? 0, (d) => ({ "2026-11-02": 2, "2026-11-03": 2, "2026-11-04": 1 })[d] ?? 0);
  assert.deepEqual(tabs.map((t) => `${t.name} ${t.day} ${t.tense} ${t.label}`), [
    "Mon 2 past 2 done",
    "Tue 3 past 2 done",
    "Wed 4 past 1 done",
    "Thu 5 today 4 open",
    "Fri 6 future 5 open",
    "Sat 7 future 2 open",
    "Sun 8 future 0 open",
  ]);
  const quiet = dayTabs(WEEK, TODAY, (d) => (d === "2026-11-03" ? 1 : 0), () => 0);
  assert.equal(quiet[0].label, "0 done");
  assert.equal(quiet[1].label, "1 open", "an earlier day with nothing done but something still open says so");
  const blanket = boardTasks.find((t) => t.id === "blanket");
  assert.deepEqual({ ...rangeDayOn(blanket, fri), daysGone: undefined }, { day: 5, of: 7, daysGone: undefined }, "personal: every day counts");
  assert.equal(rangeDayOn(blanket, "2026-11-09"), null);
});

await test("day list: due words — '11 AM', 'all day', 'late · 9 AM', 'to Sun →', 'ends Fri' / 'ends today', 'done'", () => {
  const { dayRowDue } = need(day, "today-day");
  const get = (id) => [...boardTasks, ...overdueTasks].find((t) => t.id === id);
  assert.deepEqual(dayRowDue(get("movers"), "due", fri, TODAY, NOW), { text: "11 AM", late: false });
  assert.deepEqual(dayRowDue(get("famcal"), "due", fri, TODAY, NOW), { text: "all day", late: false });
  assert.deepEqual(dayRowDue(task("x", { due_at: "2026-11-05T14:00:00.000Z" }), "due", TODAY, TODAY, NOW), { text: "late · 9 AM", late: true });
  assert.deepEqual(dayRowDue(get("old"), "due", "2026-11-03", TODAY, NOW), { text: "late", late: true });
  assert.deepEqual(dayRowDue(get("blanket"), "running", fri, TODAY, NOW), { text: "to Sun →", late: false });
  assert.deepEqual(dayRowDue(get("boxes"), "running", fri, TODAY, NOW), { text: "ends Fri", late: false });
  assert.deepEqual(dayRowDue(get("thursday"), "running", TODAY, TODAY, NOW), { text: "ends today", late: false });
  const lateRange = task("late-range", { due_at: endOf("2026-11-04"), start_at: startOf("2026-11-02") });
  assert.deepEqual(dayRowDue(lateRange, "running", "2026-11-04", TODAY, NOW), { text: "late", late: true }, "ended that day");
  assert.deepEqual(dayRowDue(lateRange, "running", "2026-11-03", TODAY, NOW), { text: "late · Wed", late: true });
  assert.deepEqual(dayRowDue(doneTasks[0], "done", fri, TODAY, NOW), { text: "done", late: false });
});

await test("day list: steps n/m; the status drop-down (Planned · In Progress · Blocked, then Backlog / Park; none for a multi-day task)", () => {
  const { rowSteps, statusOptions, statusChange } = need(day, "today-day");
  assert.deepEqual(rowSteps([{ is_done: true }, { is_done: false }, { is_done: false }]), { done: 1, total: 3 });
  assert.equal(rowSteps([]), null);
  const plain = boardTasks[0];
  assert.deepEqual(statusOptions(plain).map((o) => o.value), ["Planned", "In Progress", "Blocked/Waiting", "Backlog", "Parked"]);
  assert.deepEqual(statusOptions(boardTasks[3]).map((o) => o.value), ["Planned", "In Progress", "Blocked/Waiting"], "a range keeps its end");
  assert.deepEqual(statusChange(plain, "Planned"), { kind: "none" });
  assert.deepEqual(statusChange(plain, "In Progress"), { kind: "status", updates: { status: "In Progress" }, undo: { status: "Planned" } });
  assert.deepEqual(statusChange(plain, "Blocked/Waiting"), { kind: "status", updates: { status: "Blocked/Waiting" }, undo: { status: "Planned" } });
  assert.equal(statusChange(plain, "Backlog").kind, "move");
  assert.equal(statusChange(plain, "Backlog").choice.kind, "backlog");
  assert.equal(statusChange(plain, "Parked").choice.kind, "park");
  assert.deepEqual(statusChange(plain, "Done"), { kind: "none" }, "Done is the Done box, not the drop-down");
  // Backlog / Park are exactly Move to…'s writes.
  const { moveUpdates } = need(board, "today-board");
  assert.deepEqual(moveUpdates(statusChange(plain, "Backlog").choice), { kind: "status", updates: { status: "Backlog", due_at: null } });
  assert.deepEqual(moveUpdates(statusChange(plain, "Parked").choice), { kind: "status", updates: { status: "Parked" } });
});

// ── 4. Keys ──────────────────────────────────────────────────────────────

await test("keys: ←/→ day before/after, Esc back to the week only once the panel is closed, ↑/↓ rows (the panel's own while open)", () => {
  const { dayKeyAction, nextRowIndex, stepDay } = need(day, "today-day");
  const free = { typing: false, dialogOpen: false, panelOpen: false };
  assert.equal(dayKeyAction({ key: "ArrowLeft" }, free), "prev");
  assert.equal(dayKeyAction({ key: "ArrowRight" }, free), "next");
  assert.equal(dayKeyAction({ key: "Escape" }, free), "week");
  assert.equal(dayKeyAction({ key: "ArrowUp" }, free), "up");
  assert.equal(dayKeyAction({ key: "ArrowDown" }, free), "down");
  assert.equal(dayKeyAction({ key: "Enter" }, free), null, "Enter is the focused row's Open button");
  const panel = { ...free, panelOpen: true };
  assert.equal(dayKeyAction({ key: "Escape" }, panel), null, "the first Esc closes the panel");
  assert.equal(dayKeyAction({ key: "ArrowDown" }, panel), null, "the panel walks the rows");
  assert.equal(dayKeyAction({ key: "ArrowRight" }, panel), "next");
  for (const state of [{ ...free, typing: true }, { ...free, dialogOpen: true }]) {
    for (const key of ["ArrowLeft", "ArrowRight", "Escape", "ArrowUp"]) assert.equal(dayKeyAction({ key }, state), null, `${key} in a field / under a dialog`);
  }
  assert.equal(dayKeyAction({ key: "ArrowLeft", metaKey: true }, free), null);
  assert.equal(dayKeyAction({ key: "ArrowLeft", defaultPrevented: true }, free), null);
  assert.equal(nextRowIndex(3, -1, "down"), 0);
  assert.equal(nextRowIndex(3, -1, "up"), 2);
  assert.equal(nextRowIndex(3, 2, "down"), null, "no wrap");
  assert.equal(nextRowIndex(0, -1, "down"), null);
  assert.equal(stepDay("2026-11-08", "next"), "2026-11-09", "Sun → next Mon");
  assert.equal(stepDay("2026-11-02", "prev"), "2026-11-01");
});

await test("keys: wired on the day list only, listed in the ? dialog, no-ops in a field; a phone swipe changes the day", () => {
  const { swipeDay, TODAY_DAY_KEYS } = need(day, "today-day");
  assert.equal(swipeDay(-120, 10), "next");
  assert.equal(swipeDay(120, 10), "prev");
  assert.equal(swipeDay(-40, 0), null, "too short");
  assert.equal(swipeDay(-90, 80), null, "a scroll, not a swipe");
  const dialog = read("src/components/layout/ShortcutsDialog.tsx");
  assert.match(dialog, /TODAY_DAY_KEYS\.map/);
  assert.ok(TODAY_DAY_KEYS.some((row) => row.keys[0] === "←") && TODAY_DAY_KEYS.some((row) => row.keys[0] === "Esc"));
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /if \(!viewDay\) return;\s*const day = viewDay;/);
  assert.match(src, /dayKeyAction\(event, \{ typing: isTypingTarget\(event\.target\), dialogOpen: keyDown\.openFor\(event\), panelOpen: Boolean\(openTaskId\) \}\)/);
});

// ── 5. Phone ─────────────────────────────────────────────────────────────

await test("phone: Today opens straight into today's list (no ?day), '← Week' shows the week; iPad and desktop open the week", () => {
  const { isPhoneUserAgent, viewedDay } = need(day, "today-day");
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const androidTablet = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const ipad = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  assert.equal(isPhoneUserAgent(iphone), true);
  assert.equal(isPhoneUserAgent(android), true);
  assert.equal(isPhoneUserAgent(androidTablet), false);
  assert.equal(isPhoneUserAgent(ipad), false);
  assert.equal(isPhoneUserAgent(mac), false);
  assert.equal(isPhoneUserAgent(null), false);
  assert.equal(viewedDay({ dayParam: null, phone: true, phoneWeek: false, todayDate: TODAY }), TODAY);
  assert.equal(viewedDay({ dayParam: null, phone: true, phoneWeek: true, todayDate: TODAY }), null, "after ← Week");
  assert.equal(viewedDay({ dayParam: null, phone: false, phoneWeek: false, todayDate: TODAY }), null, "desktop: the week");
  assert.equal(viewedDay({ dayParam: fri, phone: false, phoneWeek: false, todayDate: TODAY }), fri);
  assert.equal(viewedDay({ dayParam: fri, phone: true, phoneWeek: true, todayDate: TODAY }), fri);
  const page = read("src/app/page.tsx");
  assert.match(page, /isPhoneUserAgent\(\(await headers\(\)\)\.get\("user-agent"\)\)/, "the server draws the list on a phone (no flash of the week)");
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /useSyncExternalStore\(\s*subscribePhone,\s*\(\) => window\.matchMedia\(PHONE_QUERY\)\.matches,\s*\(\) => phoneHint\s*\)/, "the client re-checks the width");
  assert.match(src, /const PHONE_QUERY = "\(max-width: 767px\)";/);
});

// ── 6. Rendered day list ─────────────────────────────────────────────────

const noop = () => {};
const rowData = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  tags: [],
  estimatedMinutes: null,
  dueAt: endOf(fri),
  dueState: null,
  status: "Planned",
  blocker: false,
  pinned: false,
  syncedToday: false,
  implementationName: null,
  squareInput: null,
  dependencyBlocked: false,
  updatedAt: null,
  unblockedAt: null,
  range: null,
  priorityScore: 50,
  projectName: "FamCal",
  waitingOn: null,
  followUpAt: null,
  isPersonal: false,
  needsReview: false,
  owner: "brent",
  ownerLabel: null,
  statusLine: "Numbers pre-filled by the agent; check and tick.",
  ...extra,
});
const statusOpts = [
  { value: "Planned", label: "Planned" },
  { value: "In Progress", label: "In Progress" },
  { value: "Blocked/Waiting", label: "Blocked" },
  { value: "Backlog", label: "Backlog", hint: "no date" },
  { value: "Parked", label: "Park", hint: "someday" },
];
const model = (id, group, extra = {}, rowExtra = {}) => ({
  group,
  data: rowData(id, extra),
  due: { text: group === "done" ? "done" : "all day", late: false },
  rangeDay: null,
  steps: { done: 1, total: 3 },
  statusOptions: statusOpts,
  move: group === "done" ? undefined : { choices: [], input: task(id), onPick: noop },
  ...rowExtra,
});

await test("rendered: rows in one data-task-list, grouped, each with Done box (not a selection box), status, owner, due, steps, Move to…, Open", () => {
  const { DayList } = need(DayListMod, "DayList");
  const tabs = need(day, "today-day").dayTabs(WEEK, TODAY, () => 1, () => 0);
  const html = renderToStaticMarkup(
    h(DayList, {
      day: fri,
      todayDate: TODAY,
      rows: {
        due: [model("a", "due"), model("b", "due", { owner: "agent", ownerLabel: "PM", status: "In Progress" })],
        running: [model("r", "running", { title: "Blanket rows 41–60" }, { rangeDay: { day: 5, of: 7, daysGone: 4 }, due: { text: "to Sun →", late: false } })],
        done: [model("d", "done", { status: "Done", title: "Book storage unit tour" })],
      },
      tabs,
      openTaskId: "b",
      completingIds: new Set(),
      movingIds: new Set(),
      loading: false,
      motion: "in",
      motionKey: 1,
      railTabs: null,
      rail: null,
      onWeek: noop,
      onDay: noop,
      onOpen: noop,
      onDone: noop,
      onStatus: noop,
      onAdd: noop,
    })
  );
  assert.match(html, /data-task-list="day"/);
  assert.match(html, /<h3 class="td-gh">Due Fri <span>2<\/span><\/h3>/);
  assert.match(html, /<h3 class="td-gh">Running through Fri <span>1<\/span><\/h3>/);
  assert.match(html, /<h3 class="td-gh">Done <span>1<\/span><\/h3>/);
  assert.equal((html.match(/data-day-row=""/g) ?? []).length, 4);
  assert.match(html, /<button type="button" class="td-done" aria-label="Mark “Task a” done">/, "the box marks done");
  assert.doesNotMatch(html, /type="checkbox"/, "not a selection box");
  assert.match(html, /<span class="td-done" data-checked="" role="img" aria-label="Done">✓<\/span>/, "a done row's box is ticked");
  assert.match(html, /<select [^>]*id="td-status-a"[^>]*>/);
  assert.match(html, /<option value="Backlog">Backlog · no date<\/option>/);
  assert.match(html, /data-owner="agent">Agent: PM</);
  assert.match(html, /<span class="td-chip">Day 5 of 7<\/span>/);
  assert.match(html, /aria-label="1 of 3 steps done"/);
  assert.match(html, /Move to…/);
  assert.match(html, /aria-label="Open “Task a” in the panel"/);
  assert.match(html, /class="td-row" data-task-open="b" data-day-row="" data-group="due" data-open=""/, "the open row is marked");
  assert.match(html, /<span class="td-openmark">Open in panel<\/span>/);
  assert.match(html, /<h2 id="today-day-h" class="td-name"><span class="td-long">Friday<\/span>/);
  assert.match(html, /<b>2<\/b> due[\s\S]*<b>1<\/b> running[\s\S]*<b>1<\/b> done/);
  assert.match(html, /aria-current="date"[^>]*><span class="td-tab-name">Fri/);
  assert.match(html, /data-motion="in"/);
  assert.match(html, /← <\/span> Week|←<\/span> Week/);
  assert.match(html, /\+ add to Fri/);
});

// ── 7. Wiring: writes go through the existing paths ──────────────────────

await test("done below open: the day list (and the phone's today list) draws Due and Running before Done, rows and ↑ / ↓ alike", () => {
  const { DayList } = need(DayListMod, "DayList");
  const tabs = need(day, "today-day").dayTabs(WEEK, TODAY, () => 1, () => 1);
  const html = renderToStaticMarkup(
    h(DayList, {
      day: fri,
      todayDate: TODAY,
      // Handed in done first on purpose: the list's own order must still put it last.
      rows: { done: [model("d", "done", { status: "Done" })], running: [model("r", "running")], due: [model("a", "due")] },
      tabs,
      openTaskId: null,
      completingIds: new Set(),
      movingIds: new Set(),
      loading: false,
      motion: "in",
      motionKey: 1,
      railTabs: null,
      rail: null,
      onWeek: noop,
      onDay: noop,
      onOpen: noop,
      onDone: noop,
      onStatus: noop,
      onAdd: noop,
    })
  );
  const groups = [...html.matchAll(/class="td-group" data-group="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(groups, ["due", "running", "done"]);
  const rows = [...new Set([...html.matchAll(/data-task-open="([^"]+)"/g)].map((match) => match[1]))];
  assert.deepEqual(rows, ["a", "r", "d"], "open rows, then the done row");
  const { groupDayList } = need(day, "today-day");
  assert.deepEqual(Object.keys(groupDayList({ board: [], overdue: [], done: [], day: fri })), ["due", "running", "done"]);
});

await test("wiring: day headers are buttons into the day list (history entry from the week, replace between days); Back / ← Week / Esc return", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /className="tb-dh-btn"\s+onClick=\{\(\) => goToDay\(column\.date, null\)\}/);
  assert.match(src, /className="tb-wk-h"\s+onClick=\{\(\) => goToDay\(date, null\)\}/, "Sat and Sun too");
  assert.match(src, /pushedFromRef\.current = hrefWithDay\(here\.pathname, here\.search, null, here\.hash\);\s*window\.history\.pushState\(null, "", href\);/);
  assert.match(src, /window\.history\.replaceState\(null, "", href\);/);
  assert.match(src, /window\.history\.back\(\);/);
  assert.match(src, /const dayParam = parseDayParam\(params\.get\(DAY_PARAM\)\);/);
  assert.match(src, /const selectedWeekStart = viewDay \? mondayOf\(viewDay\)/, "a day in another week loads that week");
  assert.match(src, /<DayList[\s\S]*railTabs=\{railTabs\}[\s\S]*rail=\{rail\}/, "Overdue / Waiting live in one place");
});

await test("wiring: Done = completeTask, status = updateTaskWithUndo (Undo), Backlog / Park = Move to…'s path, days = the date cascade; no new PATCH", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /onDone=\{\(taskId\) => void handleQuickComplete\(taskId\)\}/);
  assert.match(src, /if \(change\.kind === "move"\) \{\s*await handleMoveUndated\(task, change\.choice\);/);
  assert.match(src, /await updateTaskWithUndo\(taskId, \{ status: change\.updates\.status as TaskStatus \}, \{ status: change\.undo\.status as TaskStatus \}, \{/);
  assert.match(src, /move: group === "done" \? undefined : moveFor\(task\.id\)/, "Move to… is S4's (date cascade, dueAtForBoardDay)");
  for (const file of ["src/components/today/sections/DayList.tsx", "src/lib/today/today-day.ts", "src/components/today/sections/WeekBoard.tsx"]) {
    assert.doesNotMatch(readIf(file), /method:\s*["']PATCH["']|\.from\(['"]tasks['"]\)|fetch\([^)]*\/api\/tasks\/\$\{/, `${file} has no direct write`);
  }
});

await test("wiring: day-list panel mode — steps and Move fold away, the open row is outlined with a notch; the rail is folded tabs (fly-out 20, phone sheet 38)", () => {
  const css = read("src/components/today/today-day.css");
  assert.match(css, /\.tb\[data-panel="open"\] \.td-c-steps,\s*\.tb\[data-panel="open"\] \.td-c-move \{\s*display: none;/);
  assert.match(css, /\.td-row\[data-open\] \{\s*border: 2px solid var\(--brand\);/);
  assert.match(css, /\.td-row\[data-open\]::after \{/);
  assert.match(css, /\.tb\[data-view="day"\] \.tb-rail \{\s*display: none;/);
  assert.match(css, /\.tb\[data-view="day"\] \.tb-rail\[data-flyout\] \{[^}]*z-index: 20;/);
  assert.match(css, /\.tb\[data-view="day"\] \.tb-rail\[data-flyout\] \{[^}]*position: fixed;\s*z-index: 38;/);
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /const activeFlyout = openTaskId \|\| viewDay \? flyout : null;/);
});

await test("look: light + dark tokens only, 12 px floor, 44 px touch targets, reduced motion, ~220 ms slide / 120 ms nudge, no vendor names", () => {
  const css = read("src/components/today/today-day.css");
  assert.doesNotMatch(css, /prefers-color-scheme|#[0-9a-fA-F]{3,6}\b|rgb\(/, "colours come from the light-dark() tokens");
  for (const match of css.matchAll(/font:\s*\d+\s+(\d+)px/g)) assert.ok(Number(match[1]) >= 12, `font size ${match[1]}px is under the 12px floor`);
  const coarse = css.split("@media (pointer: coarse)").slice(1).join("\n");
  for (const selector of [".td-done", ".td-pager button", ".td-tab", ".td-title", ".td-chev"]) assert.ok(coarse.includes(selector), `${selector} grows on a touch screen`);
  assert.match(coarse, /min-height: 44px/);
  assert.match(css, /animation: td-in 220ms ease-out both;/);
  assert.match(css, /animation: td-nudge-next 120ms ease-out both;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.td,\s*\.td \* \{\s*animation: none !important;/);
  const boardCss = read("src/components/today/today-board.css");
  assert.match(boardCss, /\.tb-week\[data-motion="back"\] \{\s*animation: tb-week-back 220ms ease-out both;/);
  assert.match(boardCss, /\.tb-dh-btn,\s*\.tb-wk-h,\s*\.tb-fold-show,\s*\.tb-showdone \{\s*min-height: 44px;/);
  for (const file of ["src/components/today/sections/DayList.tsx", "src/lib/today/today-day.ts", "src/components/today/today-day.css"]) {
    const source = readIf(file);
    assert.doesNotMatch(source, /\bClaude\b|Anthropic|OpenAI|ChatGPT/, `${file} names no AI product`);
    assert.doesNotMatch(source, /text-\[1[01]px\]/);
  }
});

// ── 8. Tasks: the saved view he tapped lights up ─────────────────────────

await test("saved views: a view whose filters equal a built-in one lights up when it is the one tapped (Brent 11/6, step 4)", () => {
  const { activeViewId, filtersForView, parseTaskListFilters, BUILT_IN_VIEWS, filtersQuery } = need(list, "tasks-list");
  const mine = { id: "u-mine-test", name: "Mine now test", query: "owner=me" };
  const all = [...BUILT_IN_VIEWS, mine];
  const filters = parseTaskListFilters("owner=me");
  assert.equal(activeViewId(filters, all, "u-mine-test"), "u-mine-test", "the tapped view is lit, not the first match");
  assert.equal(activeViewId(filters, all, "mine-now"), "mine-now");
  assert.equal(activeViewId(filters, all), "mine-now", "a link or reload: the first match");
  assert.equal(activeViewId(parseTaskListFilters("owner=me&due=week"), all, "u-mine-test"), null, "filters changed since: nothing lit");
  assert.equal(activeViewId(filters, [...BUILT_IN_VIEWS], "u-gone"), "mine-now", "a removed view falls back");
  // Tapping "Mine now test" while "Mine now" is lit lights it (it used to clear the filters).
  assert.equal(filtersQuery(filtersForView(mine, filters, "mine-now")), "owner=me");
  // Tapping the lit view again clears, as before.
  assert.equal(filtersQuery(filtersForView(mine, filters, "u-mine-test")), "");
});

await test("saved views: the bar keeps the tapped id (and the view just saved); pickedAfterTap", () => {
  const { pickedAfterTap, parseTaskListFilters, BUILT_IN_VIEWS } = need(list, "tasks-list");
  const mine = { id: "u-mine-test", name: "Mine now test", query: "owner=me" };
  assert.equal(pickedAfterTap(mine, parseTaskListFilters("owner=me"), "mine-now"), "u-mine-test");
  assert.equal(pickedAfterTap(mine, parseTaskListFilters("owner=me"), "u-mine-test"), null, "tapping the lit view clears");
  assert.equal(pickedAfterTap(BUILT_IN_VIEWS[0], parseTaskListFilters(""), null), "this-week");
  const bar = read("src/components/backlog/TaskListFilters.tsx");
  assert.match(bar, /const \[pickedId, setPickedId\] = useState<string \| null>\(null\);/);
  assert.match(bar, /const active = activeViewId\(filters, all, pickedId\);/);
  assert.match(bar, /setPickedId\(pickedAfterTap\(view, filters, active\)\);\s*onChange\(filtersForView\(view, filters, active\)\);/);
  assert.match(bar, /setPickedId\(result\.view\.id\);/, "a view just saved is the lit one");
});

// ── 9. S4 review follow-ups in this path ─────────────────────────────────

// ── Fix round 1 (Fable review 760de609) ──────────────────────────────────

await test("P2-1: Esc on a Modal over the day list (? help, + add, the >25 cascade confirm) closes only the Modal", () => {
  const { dayKeyAction, keyDownTracker } = need(day, "today-day");
  assert.equal(typeof keyDownTracker, "function", "keyDownTracker exists");
  const free = { typing: false, panelOpen: false };
  // The real order of one Esc: document capture (tracker.start) → the Modal's document listener
  // (closes the Modal) → the day list's window listener. The Modal is gone by the last step.
  let modalOpen = true;
  const tracker = keyDownTracker(() => modalOpen);
  const esc = { key: "Escape" };
  tracker.start(esc);
  modalOpen = false;
  assert.equal(dayKeyAction(esc, { ...free, dialogOpen: tracker.openFor(esc) }), null, "the Esc belonged to the Modal: stay on the day");
  const next = { key: "Escape" };
  tracker.start(next);
  assert.equal(dayKeyAction(next, { ...free, dialogOpen: tracker.openFor(next) }), "week", "with no Modal up, Esc still returns to the week");
  // A key the capture step never saw (or another event) asks the page as before.
  modalOpen = true;
  assert.equal(tracker.openFor({ key: "Escape" }), true);
  modalOpen = false;
  assert.equal(tracker.openFor(esc), false, "a snapshot is used once");
  // The Modal marks the Esc it handles, so any later listener can tell (dayKeyAction skips handled keys).
  const modal = read("src/components/ui/Modal.tsx");
  assert.match(modal, /if \(e\.key !== "Escape"\) return;[\s\S]{0,240}e\.preventDefault\(\);\s*onClose\(\);/, "Modal: preventDefault before onClose");
  assert.equal(dayKeyAction({ key: "Escape", defaultPrevented: true }, { ...free, dialogOpen: false }), null);
  // Wiring: one tracker for the page; start in a capture listener on document, read in the day list's listener.
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /const \[keyDown\] = useState\(\(\) => keyDownTracker\(anyOverlayOpen\)\);/);
  assert.match(src, /function onKeyStart\(event: KeyboardEvent\) \{\s*keyDown\.start\(event\);\s*\}/);
  assert.match(src, /document\.addEventListener\("keydown", onKeyStart, true\);\s*window\.addEventListener\("keydown", onKey\);/);
  assert.match(src, /document\.removeEventListener\("keydown", onKeyStart, true\);/);
});

await test("P3-2: week + panel → a day → close the panel → Esc goes to the week without reopening the task", () => {
  const { dayBackMode, hrefWithDay } = need(day, "today-day");
  assert.equal(typeof dayBackMode, "function", "dayBackMode exists");
  const week = hrefWithDay("/", "?mode=all", null);
  const weekWithPanel = hrefWithDay("/", "?mode=all&task=t1", null);
  // Week (no panel) → day → Esc: the entry under the day is that week, step back.
  assert.equal(dayBackMode(week, hrefWithDay("/", "?mode=all&day=2026-11-05", null)), "back");
  // Week with the panel → day → panel closed → Esc: Back would land on ?task (panel reopens), replace instead.
  assert.equal(dayBackMode(weekWithPanel, hrefWithDay("/", "?mode=all&day=2026-11-05", null)), "replace");
  // Week → day → panel opened on the day → ← Week while it is open: replace (as before).
  assert.equal(dayBackMode(week, hrefWithDay("/", "?mode=all&day=2026-11-05&task=t1", null)), "replace");
  // Week with the panel → day → ← Week with the same panel still open: the entry under is that page, step back.
  assert.equal(dayBackMode(weekWithPanel, hrefWithDay("/", "?mode=all&task=t1&day=2026-11-05", null)), "back");
  // A day reached from a link or a reload has nothing of ours underneath.
  assert.equal(dayBackMode(null, week), "replace");
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /const mode = offset === undefined \? dayBackMode\(pushedFromRef\.current, weekHref\) : "replace";/);
  assert.match(src, /if \(mode === "back"\) window\.history\.back\(\);\s*else window\.history\.replaceState\(null, "", weekHref\);/);
  assert.doesNotMatch(src, /pushedDayRef/);
});

await test("F2: ↑/↓ in the panel still walk the Overdue / Waiting list after the rail folds into side tabs", () => {
  const { listOrder } = need(panel, "task-panel");
  assert.deepEqual(listOrder([{ id: "a", shown: false }, { id: "b", shown: false }, { id: "c", shown: false }], "b"), ["a", "b", "c"], "folded: the hidden list counts");
  assert.deepEqual(listOrder([{ id: "a", shown: true }, { id: "x", shown: false }, { id: "b", shown: true }], "b"), ["a", "b"], "shown: hidden copies skipped as before");
  assert.deepEqual(listOrder([{ id: "a", shown: true }], "z"), ["a"]);
  assert.match(read("src/components/tasks/panel/TaskPanel.tsx"), /return listOrder\(items, taskId\);/);
});

await test("F1: one Esc on a Move to… menu opened from the rail fly-out closes only the menu", () => {
  const src = read("src/components/today/sections/WeekBoard.tsx");
  assert.match(src, /if \(event\.key !== "Escape"\) return;\s*\/\/ A Move to… menu[^\n]*\n\s*if \(document\.querySelector\("\.tb-move"\)\) return;/);
});

await test("F4: a narrow day header wraps instead of running into the next day's", () => {
  const css = read("src/components/today/today-board.css");
  assert.match(css, /\.tb-dh-btn \{\s*display: flex;\s*flex-wrap: wrap;/);
  assert.match(css, /\.tb-dh h3 \{\s*flex: 1;\s*min-width: 0;/);
});

await test("F6: a task from a project template is due at the END of its ET day (not 7 PM ET)", () => {
  const { resolveDueFromKickoff } = need(templates, "project-templates");
  assert.deepEqual(resolveDueFromKickoff("2026-11-02", 4), { due_date: "2026-11-06", due_at: "2026-11-07T04:59:59.999Z" });
  assert.deepEqual(resolveDueFromKickoff("2026-07-01", 0), { due_date: "2026-07-01", due_at: "2026-07-02T03:59:59.999Z" });
  assert.deepEqual(resolveDueFromKickoff("2026-11-02", null), { due_date: null, due_at: null });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
