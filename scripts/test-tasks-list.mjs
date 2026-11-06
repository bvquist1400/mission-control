#!/usr/bin/env node
// Redesign S5: Tasks as card rows, one filter row, saved views, the panel, bulk edit.
// Offline (no database, network or browser). Run: npm run test:tasks-list
//
// What it pins:
//   1. The pure rules (src/lib/tasks-list.ts): the filters read from and
//      written to the URL (a link reproduces the view; ?task and ?scope kept;
//      the old ?sprint=<id> / unassigned links still work), which tasks match,
//      the status groups, the fold, and the drawn order the task panel's ↑ / ↓
//      follow; saved views (built-in + the user's own in localStorage: junk,
//      a blocked storage, replace by name, the limit, the active view); the
//      selection (toggle, shift-click runs, a filter change never leaves a
//      hidden task selected); each bulk change's PATCH and its Undo (dates at
//      the END of the ET day with no cascade, a multi-day start respected,
//      "You" clearing the agent name, a project's section and app put back);
//      the due words on a card.
//   2. A rendered card (react-dom/server, TSX transpiled here): the card
//      outline, project square + name, owner chip, due words, status, the
//      gist, data-task-open, the open card's tag, Done + Move to…
//   3. Wiring: the Tasks page renders cards (no table), filters live in the
//      URL (replaceState), the scope switch shows on /backlog, cards sit in
//      one data-task-list in drawn order, bulk edit goes through PATCH
//      /api/tasks/[id] with Undo and a confirm box for Delete, Move to… /
//      Done reuse S4's paths, the CSS (narrow fold, 44 px touch, 16 px fields,
//      reduced motion, layer order, the 12 px floor), no vendor names.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(process.env.TASKS_LIST_TEST_ROOT || process.cwd());
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
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } catch (error) {
    console.log(`(${rel} did not load: ${String(error?.message ?? error).split("\n")[0]})`);
    return null;
  }
}

const lib = await load("src/lib/tasks-list.ts");
const scopeSwitch = await load("src/lib/scope-switch.ts");
const rowMod = await load("src/components/backlog/TaskCardRow.tsx");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
function need(mod, name) {
  assert.ok(mod, `${name} exists and loads`);
  assert.ok(name.split(".").reduce((value, key) => value?.[key], { mod }) !== undefined || mod, name);
  return mod;
}
const L = () => need(lib, "src/lib/tasks-list.ts");

// Thursday 5 Nov 2026, 3 PM ET (EST, UTC-5). The week runs Mon 2 – Sun 8 Nov.
const NOW = new Date("2026-11-05T20:00:00Z");
const eod = (date) => {
  // end of an ET (EST) day
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0) - 1).toISOString();
};
const ID = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 0;
const task = (over = {}) => ({
  id: ID(++seq),
  title: `Task ${seq}`,
  description: null,
  status: "Planned",
  due_at: null,
  start_at: null,
  implementation_id: null,
  project_id: null,
  sprint_id: null,
  section_id: null,
  owner: "agent",
  owner_label: null,
  status_line: null,
  needs_review: false,
  priority_score: 50,
  updated_at: "2026-11-01T00:00:00Z",
  tags: [],
  project: null,
  implementation: null,
  sprint: null,
  ...over,
});

// ── 1. Filters and the URL ────────────────────────────────────────────────
await test("filters: defaults, every param read, junk ignored", () => {
  const { parseTaskListFilters, DEFAULT_TASK_LIST_FILTERS } = L();
  assert.deepEqual(parseTaskListFilters(""), DEFAULT_TASK_LIST_FILTERS);
  assert.deepEqual(parseTaskListFilters(null), DEFAULT_TASK_LIST_FILTERS);
  const f = parseTaskListFilters("status=in-progress&app=a1&project=none&sprint=unassigned&owner=agent:PM&due=week&review=needs_review&q=%20%20ship%20%20it%20&sort=priority");
  assert.deepEqual(f, { status: "In Progress", app: "a1", project: "none", sprint: "none", owner: "agent:PM", due: "week", review: "needs_review", q: "ship it", sort: "priority" });
  const junk = parseTaskListFilters("status=bogus&due=yesterday&sort=random&review=intelligence&owner=someone&app=&project=all");
  assert.deepEqual(junk, DEFAULT_TASK_LIST_FILTERS);
  assert.equal(parseTaskListFilters("status=Blocked%2FWaiting").status, "Blocked/Waiting", "the status name itself is read");
  assert.equal(parseTaskListFilters("status=blocked").status, "Blocked/Waiting", "an older word");
  assert.equal(parseTaskListFilters("status=all").status, "all");
  assert.equal(parseTaskListFilters("owner=me").owner, "me");
  assert.equal(parseTaskListFilters("owner=Brent").owner, "me");
  assert.equal(parseTaskListFilters("owner=nobody").owner, "none");
  assert.equal(parseTaskListFilters(`app=${"x".repeat(101)}`).app, null, "an absurd id is ignored");
  assert.equal(parseTaskListFilters(`q=${"a".repeat(500)}`).q.length, 200);
});

await test("filters: URL round trip (a link reproduces the view), defaults left out, fixed order", () => {
  const { parseTaskListFilters, filtersQuery } = L();
  const cases = [
    "",
    "status=waiting",
    "status=all&owner=me",
    "app=a1&project=p1&sprint=s1&owner=agent%3APM&due=late&review=ready&q=badge+audit&sort=title",
    "status=done&due=none",
    "project=none&sprint=none",
  ];
  for (const query of cases) {
    const once = parseTaskListFilters(query);
    const written = filtersQuery(once);
    assert.equal(written, query, `round trip of "${query}"`);
    assert.deepEqual(parseTaskListFilters(written), once);
  }
  assert.equal(filtersQuery(parseTaskListFilters("sort=due&status=open")), "", "defaults are not written");
  assert.equal(filtersQuery(parseTaskListFilters("due=week&owner=me")), "owner=me&due=week", "one order");
});

await test("filters: taskListHref keeps ?task and ?scope, drops the old ?expand, rewrites filter params", () => {
  const { taskListHref, parseTaskListFilters } = L();
  const f = parseTaskListFilters("owner=me&due=week");
  assert.equal(taskListHref("/backlog", `?scope=work&task=${ID(1)}&status=done&expand=${ID(2)}`, f), `/backlog?scope=work&task=${ID(1)}&owner=me&due=week`);
  assert.equal(taskListHref("/backlog", "", parseTaskListFilters("")), "/backlog");
  assert.equal(taskListHref("/backlog", "?q=old&sort=title", parseTaskListFilters("q=new")), "/backlog?q=new");
});

await test("filters: the legacy /sprints/[id] redirect lands on the Sprint filter", () => {
  const { parseTaskListFilters } = L();
  assert.equal(parseTaskListFilters(`sprint=${ID(9)}`).sprint, ID(9));
  assert.equal(parseTaskListFilters("sprint=x%26expand%3D1").sprint, "x&expand=1", "an odd id is kept (matches nothing) rather than showing everything");
});

await test("filters: what needs loading, the filter count", () => {
  const { filtersNeedDone, statusForLoader, activeFilterCount, parseTaskListFilters } = L();
  assert.equal(filtersNeedDone({ status: "open" }), false);
  assert.equal(filtersNeedDone({ status: "all" }), true);
  assert.equal(filtersNeedDone({ status: "Done" }), true);
  assert.equal(statusForLoader({ status: "Missed" }), "Missed");
  assert.equal(statusForLoader({ status: "open" }), "All");
  assert.equal(activeFilterCount(parseTaskListFilters("q=x&sort=title")), 0);
  assert.equal(activeFilterCount(parseTaskListFilters("status=done&app=a&project=p&sprint=s&owner=me&due=late&review=ready")), 7);
});

// ── Matching ──────────────────────────────────────────────────────────────
await test("match: status (open hides Done and Missed; all hides Missed), app/project/sprint incl. none", () => {
  const { matchesTaskListFilters, parseTaskListFilters, listClock } = L();
  const clock = listClock(NOW);
  const m = (t, q) => matchesTaskListFilters(t, parseTaskListFilters(q), clock);
  assert.equal(m(task({ status: "Parked" }), ""), true, "open keeps Parked (the old default list did)");
  assert.equal(m(task({ status: "Done" }), ""), false);
  assert.equal(m(task({ status: "Missed" }), ""), false);
  assert.equal(m(task({ status: "Done" }), "status=all"), true);
  assert.equal(m(task({ status: "Missed" }), "status=all"), false);
  assert.equal(m(task({ status: "Missed" }), "status=missed"), true);
  assert.equal(m(task({ status: "Planned" }), "status=waiting"), false);
  assert.equal(m(task({ implementation_id: "a1" }), "app=a1"), true);
  assert.equal(m(task({ implementation_id: "a1" }), "app=none"), false);
  assert.equal(m(task({ implementation_id: null }), "app=none"), true);
  assert.equal(m(task({ project_id: "p1" }), "project=p2"), false);
  assert.equal(m(task({ sprint_id: null }), "sprint=none"), true);
  assert.equal(m(task({ sprint_id: "s1" }), "sprint=s1"), true);
});

await test("match: owner (me, a named agent, one agent by name in any case, an agent with no name)", () => {
  const { matchesTaskListFilters, parseTaskListFilters, listClock } = L();
  const clock = listClock(NOW);
  const m = (t, q) => matchesTaskListFilters(t, parseTaskListFilters(q), clock);
  assert.equal(m(task({ owner: "brent" }), "owner=me"), true);
  assert.equal(m(task({ owner: "agent" }), "owner=me"), false);
  assert.equal(m(task({ owner: "agent", owner_label: "PM" }), "owner=agent"), true);
  assert.equal(m(task({ owner: "agent", owner_label: "pm" }), "owner=agent:PM"), true);
  assert.equal(m(task({ owner: "agent", owner_label: "Codex" }), "owner=agent:PM"), false);
  assert.equal(m(task({ owner: "brent", owner_label: "PM" }), "owner=agent:PM"), false);
  assert.equal(m(task({ owner: "agent", owner_label: null }), "owner=agent"), false, "no name, no chip: not an agent at work");
  assert.equal(m(task({ owner: "agent", owner_label: "  " }), "owner=none"), true);
  assert.equal(m(task({ owner: "agent", owner_label: "PM" }), "owner=none"), false);
  assert.equal(m(task({ owner: "brent" }), "owner=none"), false);
});

await test("match: due (late, today, this week incl. late, no date, has a date) on ET days", () => {
  const { matchesTaskListFilters, parseTaskListFilters, listClock } = L();
  const clock = listClock(NOW);
  assert.equal(clock.today, "2026-11-05");
  assert.equal(clock.weekEnd, "2026-11-08");
  const m = (t, q) => matchesTaskListFilters(t, parseTaskListFilters(q), clock);
  const late = task({ due_at: eod("2026-11-03") });
  const earlierToday = task({ due_at: "2026-11-05T14:00:00Z" }); // 9 AM ET today, passed
  const tonight = task({ due_at: eod("2026-11-05") });
  const sunday = task({ due_at: eod("2026-11-08") });
  const nextMon = task({ due_at: eod("2026-11-09") });
  const none = task();
  assert.deepEqual([late, earlierToday, tonight, sunday, nextMon, none].map((t) => m(t, "due=late")), [true, true, false, false, false, false]);
  assert.deepEqual([late, earlierToday, tonight, sunday, nextMon, none].map((t) => m(t, "due=today")), [false, true, true, false, false, false]);
  assert.deepEqual([late, earlierToday, tonight, sunday, nextMon, none].map((t) => m(t, "due=week")), [true, true, true, true, false, false]);
  assert.deepEqual([late, none].map((t) => m(t, "due=none")), [false, true]);
  assert.deepEqual([late, none].map((t) => m(t, "due=dated")), [true, false]);
  assert.equal(m(task({ due_at: eod("2026-11-03"), status: "Parked" }), "due=late"), false, "Parked is never late");
  // 7 PM ET (old <day>T23:59:59.999Z) of today, read at 8 PM ET: late today.
  const at8pm = listClock(new Date("2026-11-06T01:00:00Z"));
  assert.equal(matchesTaskListFilters(task({ due_at: "2026-11-05T23:59:59.999Z" }), parseTaskListFilters("due=late"), at8pm), true);
});

await test("match: review and search (title, description, where it stands; any case)", () => {
  const { matchesTaskListFilters, parseTaskListFilters, listClock } = L();
  const clock = listClock(NOW);
  const m = (t, q) => matchesTaskListFilters(t, parseTaskListFilters(q), clock);
  assert.equal(m(task({ needs_review: true }), "review=needs_review"), true);
  assert.equal(m(task({ needs_review: true }), "review=ready"), false);
  assert.equal(m(task({ title: "Submit M&M build" }), "q=m%26m"), true);
  assert.equal(m(task({ description: "Upload from Xcode" }), "q=xcode"), true);
  assert.equal(m(task({ status_line: "Waiting on Apple review" }), "q=apple"), true);
  assert.equal(m(task({ title: "Other" }), "q=apple"), false);
});

// ── Groups, order, the fold ───────────────────────────────────────────────
await test("groups: status order, each sorted by due (late first, undated last), empty groups left out", () => {
  const { groupTaskList } = L();
  const a = task({ status: "Backlog", title: "B undated" });
  const b = task({ status: "Planned", due_at: eod("2026-11-06"), title: "P fri" });
  const c = task({ status: "Planned", due_at: eod("2026-11-03"), title: "P late" });
  const d = task({ status: "In Progress", due_at: eod("2026-11-10") });
  const e = task({ status: "Blocked/Waiting" });
  const f = task({ status: "Planned", title: "P undated hi", priority_score: 90 });
  const g = task({ status: "Planned", title: "P undated lo", priority_score: 10 });
  const groups = groupTaskList([a, b, c, d, e, f, g], "due");
  assert.deepEqual(groups.map((group) => group.label), ["In progress", "Waiting", "Planned", "Backlog"]);
  assert.deepEqual(groups[2].tasks.map((t) => t.title), ["P late", "P fri", "P undated hi", "P undated lo"]);
});

await test("groups: other sorts (priority, title, recently changed)", () => {
  const { groupTaskList } = L();
  const x = task({ title: "beta", priority_score: 10, updated_at: "2026-11-04T00:00:00Z", due_at: eod("2026-11-06") });
  const y = task({ title: "Alpha", priority_score: 80, updated_at: "2026-11-01T00:00:00Z" });
  const z = task({ title: "gamma", priority_score: 80, updated_at: "2026-11-05T00:00:00Z", due_at: eod("2026-11-05") });
  assert.deepEqual(groupTaskList([x, y, z], "priority")[0].tasks.map((t) => t.title), ["gamma", "Alpha", "beta"]);
  assert.deepEqual(groupTaskList([x, y, z], "title")[0].tasks.map((t) => t.title), ["Alpha", "beta", "gamma"]);
  assert.deepEqual(groupTaskList([x, y, z], "updated")[0].tasks.map((t) => t.title), ["gamma", "beta", "Alpha"]);
});

await test("fold: a long group shows the first 40 until expanded; ↑ / ↓ order = the drawn cards, group by group", () => {
  const { groupTaskList, taskListOrder, GROUP_LIMIT } = L();
  assert.equal(GROUP_LIMIT, 40);
  const backlog = Array.from({ length: 45 }, (_, i) => task({ status: "Backlog", title: `bk ${String(i).padStart(2, "0")}` }));
  const progress = [task({ status: "In Progress", title: "ip" })];
  const folded = groupTaskList([...backlog, ...progress], "title");
  assert.equal(folded[1].shown.length, 40);
  assert.equal(folded[1].hidden, 5);
  const order = taskListOrder(folded);
  assert.equal(order.length, 41);
  assert.equal(order[0], progress[0].id, "In progress comes first");
  assert.equal(order[1], backlog[0].id);
  assert.ok(!order.includes(backlog[44].id), "a folded card is not in the walk");
  const open = groupTaskList([...backlog, ...progress], "title", new Set(["Backlog"]));
  assert.equal(open[1].hidden, 0);
  assert.equal(taskListOrder(open).length, 46);
});

// ── Saved views ───────────────────────────────────────────────────────────
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
}

await test("views: built in (This week, Mine now, Waiting, Agents, No date) and their queries", () => {
  const { BUILT_IN_VIEWS, parseTaskListFilters } = L();
  assert.deepEqual(BUILT_IN_VIEWS.map((v) => v.name), ["This week", "Mine now", "Waiting", "Agents", "No date"]);
  const q = Object.fromEntries(BUILT_IN_VIEWS.map((v) => [v.name, parseTaskListFilters(v.query)]));
  assert.equal(q["This week"].due, "week");
  assert.equal(q["Mine now"].owner, "me");
  assert.equal(q["Waiting"].status, "Blocked/Waiting");
  assert.equal(q["Agents"].owner, "agent");
  assert.equal(q["No date"].due, "none");
});

await test("views: storage read tolerates junk, a blocked storage and bad rows; write + read round trip", () => {
  const { readSavedViews, writeSavedViews, SAVED_VIEWS_KEY } = L();
  assert.equal(SAVED_VIEWS_KEY, "baseline_task_views");
  assert.deepEqual(readSavedViews(null), []);
  assert.deepEqual(readSavedViews(memoryStorage()), []);
  assert.deepEqual(readSavedViews(memoryStorage({ [SAVED_VIEWS_KEY]: "{not json" })), []);
  assert.deepEqual(readSavedViews(memoryStorage({ [SAVED_VIEWS_KEY]: JSON.stringify([1, 2]) })), []);
  assert.deepEqual(readSavedViews({ getItem: () => { throw new Error("SecurityError"); } }), []);
  const mixed = { v: 1, views: [{ id: "a", name: "  Mine  late ", query: "due=late&owner=me&sort=title&zzz=1" }, { id: "a", name: "dup", query: "" }, { id: 3, name: "x", query: "" }, null, { id: "b", name: "", query: "due=none" }] };
  const read = readSavedViews(memoryStorage({ [SAVED_VIEWS_KEY]: JSON.stringify(mixed) }));
  assert.deepEqual(read, [{ id: "a", name: "Mine late", query: "owner=me&due=late" }], "cleaned: canonical query, name trimmed, bad rows dropped");
  const storage = memoryStorage();
  assert.equal(writeSavedViews(storage, read), true);
  assert.deepEqual(readSavedViews(storage), read);
  assert.equal(writeSavedViews({ setItem: () => { throw new Error("QuotaExceeded"); } }, read), false);
  assert.equal(writeSavedViews(null, read), false);
});

await test("views: add (name rules, replace by name, nothing to save, built-in names, limit), remove", () => {
  const { addSavedView, removeSavedView, parseTaskListFilters, SAVED_VIEWS_LIMIT } = L();
  let n = 0;
  const makeId = () => `v${++n}`;
  const filters = parseTaskListFilters("owner=me&due=late&sort=title");
  const first = addSavedView([], "  Late  mine ", filters, makeId);
  assert.equal(first.ok, true);
  assert.deepEqual(first.view, { id: "v1", name: "Late mine", query: "owner=me&due=late" }, "sort is not part of a view");
  const replaced = addSavedView(first.views, "late MINE", parseTaskListFilters("owner=me"), makeId);
  assert.equal(replaced.ok && replaced.replaced, true);
  assert.equal(replaced.views.length, 1);
  assert.equal(replaced.views[0].query, "owner=me");
  assert.equal(addSavedView([], "   ", filters, makeId).ok, false);
  assert.equal(addSavedView([], "x".repeat(33), filters, makeId).ok, false);
  assert.match(addSavedView([], "Plain", parseTaskListFilters("sort=title"), makeId).error, /Set a filter first/);
  assert.match(addSavedView([], "waiting", filters, makeId).error, /built-in/);
  const full = Array.from({ length: SAVED_VIEWS_LIMIT }, (_, i) => ({ id: `f${i}`, name: `View ${i}`, query: "owner=me" }));
  assert.match(addSavedView(full, "One more", filters, makeId).error, /remove one/);
  assert.equal(addSavedView(full, "View 3", filters, makeId).ok, true, "replacing works at the limit");
  assert.deepEqual(removeSavedView(first.views, "v1"), []);
});

await test("views: the active view (exact filters, sort ignored); picking it again clears to the plain list", () => {
  const { activeViewId, filtersForView, parseTaskListFilters, BUILT_IN_VIEWS, filtersQuery } = L();
  const mine = [{ id: "u1", name: "Late mine", query: "due=late&owner=me" }];
  const all = [...BUILT_IN_VIEWS, ...mine];
  assert.equal(activeViewId(parseTaskListFilters("owner=me"), all), "mine-now");
  assert.equal(activeViewId(parseTaskListFilters("owner=me&sort=title"), all), "mine-now");
  assert.equal(activeViewId(parseTaskListFilters("owner=me&due=late"), all), "u1");
  assert.equal(activeViewId(parseTaskListFilters("owner=me&q=x"), all), null);
  assert.equal(activeViewId(parseTaskListFilters(""), all), null);
  const current = parseTaskListFilters("app=a1&sort=title");
  const picked = filtersForView(BUILT_IN_VIEWS[1], current);
  assert.equal(filtersQuery(picked), "owner=me&sort=title", "a view replaces the filters and keeps the sort");
  assert.equal(filtersQuery(filtersForView(BUILT_IN_VIEWS[1], picked)), "sort=title", "the active view again = cleared");
});

// ── Selection ─────────────────────────────────────────────────────────────
await test("selection: toggle, shift-click runs both ways, prune keeps the same set when nothing changed", () => {
  const { toggleSelection, selectRange, pruneSelection } = L();
  const order = ["a", "b", "c", "d", "e"];
  let s = toggleSelection(new Set(), "b");
  assert.deepEqual([...s], ["b"]);
  s = selectRange(order, s, "b", "d");
  assert.deepEqual([...s].sort(), ["b", "c", "d"]);
  s = selectRange(order, s, "d", "c");
  assert.deepEqual([...s].sort(), ["b"], "shift-click on a selected card clears the run");
  s = selectRange(order, s, "e", "a");
  assert.deepEqual([...s].sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...selectRange(order, new Set(), null, "c")], ["c"], "no anchor: just that card");
  assert.deepEqual([...selectRange(order, new Set(), "gone", "c")], ["c"]);
  assert.deepEqual([...toggleSelection(new Set(["a"]), "a")], []);
  const keep = new Set(["a", "b"]);
  assert.equal(pruneSelection(keep, ["a", "b", "z"]), keep, "same set back: no re-render");
  assert.deepEqual([...pruneSelection(keep, new Set(["b"]))], ["b"], "a filter change drops a hidden task");
});

// ── Bulk edit ─────────────────────────────────────────────────────────────
await test("bulk: status — PATCH + Undo per task, already-set tasks skipped, the toast", () => {
  const { bulkEditPlan } = L();
  const a = task({ status: "Backlog", title: "A" });
  const b = task({ status: "Planned", title: "B" });
  const plan = bulkEditPlan([a, b], [a.id, b.id, "unknown"], { kind: "status", status: "Planned" });
  assert.deepEqual(plan.steps, [{ taskId: a.id, title: "A", updates: { status: "Planned" }, undo: { status: "Backlog" } }]);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ["already planned"]);
  assert.deepEqual(plan.requestOptions, {});
  assert.equal(plan.message, "Set 1 task to Planned");
});

await test("bulk: owner — You clears the agent name; an agent by name; Undo restores owner + name", () => {
  const { bulkEditPlan } = L();
  const a = task({ owner: "agent", owner_label: "PM" });
  const b = task({ owner: "brent" });
  const toMe = bulkEditPlan([a, b], [a.id, b.id], { kind: "owner", owner: "brent" });
  assert.deepEqual(toMe.steps.map((s) => [s.updates, s.undo]), [[{ owner: "brent", owner_label: null }, { owner: "agent", owner_label: "PM" }]]);
  assert.equal(toMe.skipped.length, 1);
  assert.equal(toMe.message, "Gave 1 task to you");
  const toCodex = bulkEditPlan([a, b], [a.id, b.id], { kind: "owner", owner: "agent", label: "Codex" });
  assert.deepEqual(toCodex.steps.map((s) => s.updates), [{ owner: "agent", owner_label: "Codex" }, { owner: "agent", owner_label: "Codex" }]);
  assert.equal(toCodex.message, "Gave 2 tasks to Agent: Codex");
  const anyAgent = bulkEditPlan([b], [b.id], { kind: "owner", owner: "agent" });
  assert.deepEqual(anyAgent.steps[0].updates, { owner: "agent" }, "no name picked: an agent keeps whatever name it had");
});

await test("bulk: due — END of the ET day, no cascade (quiet), a multi-day start respected, No date", () => {
  const { bulkEditPlan } = L();
  const a = task({ due_at: eod("2026-11-03"), title: "A" });
  const b = task({ due_at: eod("2026-11-09"), start_at: "2026-11-07T05:00:00Z", title: "B range" });
  const c = task({ due_at: eod("2026-11-06"), title: "C already" });
  const plan = bulkEditPlan([a, b, c], [a.id, b.id, c.id], { kind: "due", date: "2026-11-06" });
  assert.deepEqual(plan.requestOptions, { cascade: false, cascade_quiet: true }, "bulk dates never move linked tasks");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].updates.due_at, "2026-11-07T04:59:59.999Z", "11:59:59.999 PM ET (EST), not 7 PM");
  assert.equal(plan.steps[0].undo.due_at, a.due_at);
  assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ["already due then", "starts after that day"]);
  assert.equal(plan.message, "Moved 1 task to Fri 6 Nov");
  const summer = bulkEditPlan([a], [a.id], { kind: "due", date: "2026-07-01" });
  assert.equal(summer.steps[0].updates.due_at, "2026-07-02T03:59:59.999Z", "EDT end of day");
  const clear = bulkEditPlan([a, b, task()], [a.id, b.id, ID(seq)], { kind: "due", date: null });
  assert.deepEqual(clear.steps.map((s) => s.updates), [{ due_at: null }]);
  assert.deepEqual(clear.skipped.map((s) => s.reason).sort(), ["has a start date (clear it in the panel)", "has no date"]);
  assert.equal(clear.message, "Cleared the date on 1 task");
});

await test("bulk: project — Undo puts back the project, its section and the app; sprint", () => {
  const { bulkEditPlan } = L();
  const a = task({ project_id: "p1", section_id: "s1", implementation_id: "app1" });
  const plan = bulkEditPlan([a], [a.id], { kind: "project", projectId: "p2", projectName: "Release 1.0.2" });
  assert.deepEqual(plan.steps[0].updates, { project_id: "p2" });
  assert.deepEqual(plan.steps[0].undo, { project_id: "p1", section_id: "s1", implementation_id: "app1" });
  assert.equal(plan.message, "Moved 1 task to Release 1.0.2");
  assert.equal(bulkEditPlan([a], [a.id], { kind: "project", projectId: "p1" }).steps.length, 0);
  assert.equal(bulkEditPlan([a], [a.id], { kind: "project", projectId: null }).message, "Took 1 task out of their project");
  const sprint = bulkEditPlan([a], [a.id], { kind: "sprint", sprintId: "sp1", sprintName: "Sprint 9" });
  assert.deepEqual([sprint.steps[0].updates, sprint.steps[0].undo, sprint.message], [{ sprint_id: "sp1" }, { sprint_id: null }, "Put 1 task in Sprint 9"]);
});

// ── Words on a card ───────────────────────────────────────────────────────
await test("card words: due (no date, today, a time, tomorrow, a day, late by days, late today, a span), owner", () => {
  const { taskCardDue, ownerText, listClock } = L();
  const clock = listClock(NOW);
  const d = (over) => taskCardDue(task(over), clock);
  assert.deepEqual(d({}), { text: "no date", late: false });
  assert.deepEqual(d({ due_at: eod("2026-11-05") }), { text: "Today", late: false });
  assert.deepEqual(d({ due_at: "2026-11-05T22:00:00Z" }), { text: "Today 5 PM", late: false });
  assert.deepEqual(d({ due_at: "2026-11-05T14:00:00Z" }), { text: "late · 9 AM", late: true });
  assert.deepEqual(d({ due_at: eod("2026-11-06") }), { text: "Tomorrow", late: false });
  assert.deepEqual(d({ due_at: eod("2026-11-12") }), { text: "Thu 12 Nov", late: false });
  assert.deepEqual(d({ due_at: eod("2027-01-12") }), { text: "Tue 12 Jan 2027", late: false });
  assert.deepEqual(d({ due_at: eod("2026-11-04") }), { text: "1 day late", late: true });
  assert.deepEqual(d({ due_at: eod("2026-11-03") }), { text: "2 days late", late: true });
  assert.deepEqual(d({ due_at: eod("2026-11-03"), status: "Done" }), { text: "Tue 3 Nov", late: false });
  assert.deepEqual(d({ due_at: eod("2026-11-08"), start_at: "2026-11-02T05:00:00Z" }), { text: "2 – 8 Nov", late: false });
  assert.deepEqual(d({ due_at: eod("2026-11-03"), start_at: "2026-10-30T04:00:00Z" }), { text: "2 days late", late: true });
  assert.deepEqual(d({ due_at: eod("2026-11-02"), start_at: "2026-10-28T04:00:00Z", status: "Done" }), { text: "28 Oct – 2 Nov", late: false });
  assert.equal(ownerText({ owner: "brent" }), "You");
  assert.equal(ownerText({ owner: "agent", owner_label: "PM" }), "Agent: PM");
  assert.equal(ownerText({ owner: "agent", owner_label: null }), null);
});

// ── 2. A rendered card ────────────────────────────────────────────────────
await test("rendered card: outline row with square + project, owner chip, due words, status, gist, data-task-open", () => {
  assert.ok(rowMod?.TaskCardRow, "TaskCardRow renders");
  const { listClock } = L();
  const clock = listClock(NOW);
  const noop = () => {};
  const t = task({
    title: "Submit M&M 1.0.2 build",
    status: "In Progress",
    owner: "brent",
    due_at: eod("2026-11-05"),
    status_line: "Build 41 passed review; upload it from Xcode.",
    project_id: "p1",
    project: { id: "p1", name: "Release 1.0.2", tags: [] },
    section_name: "Ship",
  });
  const html = renderToStaticMarkup(h(rowMod.TaskCardRow, { task: t, clock, weekStart: "2026-11-02", open: false, selected: false, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop }));
  assert.match(html, /^<li class="tl-card" data-task-open="[0-9a-f-]{36}" data-status="progress"/);
  assert.match(html, /data-project-square="p1"/, "the project's colour square");
  assert.match(html, /Release 1\.0\.2/);
  assert.match(html, /<span>Ship<\/span>/);
  assert.match(html, /<span class="tl-own" data-owner="brent">You<\/span>/);
  assert.match(html, /<span class="tl-due">Today<\/span>/);
  assert.match(html, /<span class="tl-status">In progress<\/span>/);
  assert.match(html, /<p class="tl-gist">Build 41 passed review; upload it from Xcode\.<\/p>/);
  assert.match(html, /aria-label="Select “Submit M&amp;M 1\.0\.2 build”"/);
  assert.match(html, />✓ Done<\/button>/);
  assert.match(html, /Move to…/);
  assert.doesNotMatch(html, /Open in panel/);
  const open = renderToStaticMarkup(h(rowMod.TaskCardRow, { task: { ...t, owner: "agent", owner_label: "PM", due_at: eod("2026-11-03") }, clock, weekStart: "2026-11-02", open: true, selected: true, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop }));
  assert.match(open, /data-open="true" data-selected="true"/);
  assert.match(open, /data-late="true"/);
  assert.match(open, /Open in panel/);
  assert.match(open, /<span class="tl-own" data-owner="agent">Agent: PM<\/span>/);
  assert.match(open, /<span class="tl-due" data-late="true">2 days late<\/span>/);
  const done = renderToStaticMarkup(h(rowMod.TaskCardRow, { task: { ...t, status: "Done" }, clock, weekStart: "2026-11-02", open: false, selected: false, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop }));
  assert.match(done, />Reopen<\/button>/);
  assert.doesNotMatch(done, /Move to…/);
  const waiting = renderToStaticMarkup(h(rowMod.TaskCardRow, { task: { ...t, status: "Blocked/Waiting", waiting_on: "Apple" }, clock, weekStart: "2026-11-02", open: false, selected: false, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop }));
  assert.match(waiting, /<p class="tl-wait">Waiting on Apple<\/p>/);
  const loose = renderToStaticMarkup(h(rowMod.TaskCardRow, { task: task({ title: "Loose" }), clock, weekStart: "2026-11-02", open: false, selected: false, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop }));
  assert.match(loose, /No project/);
  assert.match(loose, /<span class="tl-due">no date<\/span>/);
});

// ── 3. Wiring ─────────────────────────────────────────────────────────────
await test("wiring: Tasks renders card rows (no table, no TaskGrid), header counts, filters from the URL", () => {
  const list = read("src/components/backlog/BacklogList.tsx");
  const page = read("src/app/backlog/page.tsx");
  assert.doesNotMatch(list, /TaskGrid|<table/);
  assert.match(list, /<TaskCardList\b/);
  assert.match(list, /<TaskListFilterBar\b/);
  assert.match(list, /parseTaskListFilters\(searchParams\)/);
  assert.match(list, /window\.history\.replaceState\(null, "", `\$\{href\}\$\{window\.location\.hash\}`\)/, "a filter change rewrites the URL in place");
  assert.match(list, /taskListHref\(window\.location\.pathname, window\.location\.search, next\)/);
  assert.match(list, /<b>\{matchingTasks\.length\}<\/b> match · \{openCount\} open in all/);
  assert.match(list, /filterTasksByScope\(tasks, scope\)/);
  assert.match(list, /normalizeTaskScope\(searchParams\.get\("scope"\), "all"\)/);
  assert.match(list, /\+ New task/);
  assert.match(list, /Artifact Inbox/, "the inbox stays one link away (S7 owns it)");
  assert.doesNotMatch(page, /Primary task hub|PageHeader/);
});

await test("wiring: the top bar's Work / Personal / All shows on Tasks (?scope, default all)", () => {
  assert.ok(scopeSwitch?.scopeSwitchFor);
  const view = scopeSwitch.scopeSwitchFor("/backlog", `owner=me&task=${ID(1)}`);
  assert.equal(view.current, "all");
  assert.deepEqual(view.options.map((o) => o.href), [`/backlog?owner=me&task=${ID(1)}&scope=work`, `/backlog?owner=me&task=${ID(1)}&scope=personal`, `/backlog?owner=me&task=${ID(1)}`]);
  assert.equal(scopeSwitch.scopeSwitchFor("/backlog", "scope=work").current, "work");
});

await test("wiring: cards sit in ONE data-task-list in drawn order (↑ / ↓), click opens the S3 panel, panel width = tasks", () => {
  const list = read("src/components/backlog/TaskCardList.tsx");
  const row = read("src/components/backlog/TaskCardRow.tsx");
  assert.match(list, /<div data-task-list="tasks"/);
  assert.equal((list.match(/data-task-list=/g) ?? []).length, 1);
  assert.match(list, /groupTaskList\(matchingTasks, filters\.sort, expanded\)/);
  assert.match(list, /group\.shown\.map\(\(task\) => \(\s*<TaskCardRow/);
  assert.match(list, /onOpen=\{\(\) => openTask\(task\)\}/);
  assert.match(list, /seedTasks\(matchingTasks\)/);
  assert.match(list, /useTaskPanelEvents\(/);
  assert.match(row, /data-task-open=\{task\.id\}/);
  assert.match(row, /if \(target\.closest\("button, a, input, select, label, \[role='dialog'\]"\)\) return;/, "the card's own controls don't open the panel");
  const panelLib = read("src/lib/task-panel.ts");
  assert.match(panelLib, /if \(path === "\/backlog" \|\| path\.startsWith\("\/backlog\/"\)\) return "tasks";/);
  assert.match(read("src/components/backlog/BacklogList.tsx"), /data-panel=\{openTaskId \? "open" : undefined\}/);
});

await test("wiring: bulk edit through PATCH /api/tasks/[id] (waves), Undo in the toast, Delete asks in a Modal (no window.confirm)", () => {
  const list = read("src/components/backlog/TaskCardList.tsx");
  assert.match(list, /bulkEditPlan\(tasks, selected, change\)/);
  assert.match(list, /patchTaskWithReply\(step\.taskId, body, plan\.requestOptions\)/);
  assert.match(list, /label: "Undo"/);
  assert.match(list, /runSteps\(applied, "undo"\)/);
  assert.match(list, /<Modal open=\{confirmDelete\}/);
  assert.doesNotMatch(list, /window\.confirm/);
  assert.match(list, /fetch\(`\/api\/tasks\/\$\{taskId\}`, \{ method: "DELETE" \}\)/);
  assert.match(list, /pruneSelection\(current, matchingIds\)/);
  assert.match(list, /selectRange\(order, current, anchorRef\.current, taskId\)/);
  assert.match(read("src/lib/tasks-client.ts"), /cascade_quiet\?: boolean;/);
});

await test("wiring: Done / Move to… on a card reuse S4 (MoveToMenu, moveToChoices, date cascade, updateTaskWithUndo)", () => {
  const list = read("src/components/backlog/TaskCardList.tsx");
  const row = read("src/components/backlog/TaskCardRow.tsx");
  assert.match(row, /import \{ MoveToMenu \} from "@\/components\/today\/MoveToMenu";/);
  // The menu's look is its own file (it used to live in today-board.css, which Tasks doesn't load: an unstyled menu).
  assert.match(read("src/components/backlog/BacklogList.tsx"), /import "@\/components\/today\/move-to-menu\.css";/);
  assert.match(read("src/components/today/move-to-menu.css"), /\.tb-move \{[^}]*position: fixed;[^}]*z-index: 50;/);
  assert.match(row, /moveToChoices\(task, clock\.today, weekStart\)/);
  assert.match(list, /dateCascade\.changeDueDate\(\{/);
  assert.match(list, /const nextDueAt = dueAtForBoardDay\(choice\.date\);/);
  assert.match(list, /updateTaskWithUndo\(task\.id, plan\.updates, undo,/);
  assert.match(list, /completeTask\(task, \{/);
});

await test("CSS: card outline, narrow fold (container), 44 px touch targets, reduced motion, layers, 12 px floor", () => {
  const css = read("src/components/backlog/tasks-list.css");
  const card = css.match(/\.tl-card \{[^}]*\}/)?.[0] ?? "";
  assert.match(card, /border: 1px solid var\(--rule\);/);
  assert.match(card, /background: var\(--sheet\);/);
  assert.match(css, /\.tl \{[^}]*container-type: inline-size;/);
  assert.match(css, /@container tl \(max-width: 899px\) \{\s*\.tl-fmenus \{\s*display: none;/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.tl-check \{\s*min-width: 44px;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.tl-card\[data-open\] \{\s*border: 2px solid var\(--brand\);/);
  assert.match(css, /\.tl-view\[data-active\] \{\s*border-color: var\(--hi\);/, "marigold = the active view (needs-you colour)");
  for (const [selector, z] of [[".tl-sheet", 20], [".tl-bulk", 10]]) {
    const rule = css.match(new RegExp(`\\${selector} \\{[^}]*\\}`))?.[0] ?? "";
    assert.match(rule, new RegExp(`z-index: ${z};`), `${selector} under the docked panel (25)`);
  }
  assert.equal((css.match(/z-index: 38;/g) ?? []).length, 2, "phone sheet + bulk bar under the More sheet (39) and tab bar (40)");
  const sizes = [...css.matchAll(/(?:font-size:|font: \d+ )(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10 && sizes.every((size) => size >= 12), `no type under 12 px: ${sizes.join(",")}`);
  // Fields are 16 px on a touch screen from globals.css (selects and inputs).
  assert.match(read("src/app/globals.css"), /@media \(pointer: coarse\) \{\s*input:not\(\[type="checkbox"\]\)[\s\S]*?select,\s*textarea \{\s*font-size: 16px;/);
});

await test("no vendor names in the Tasks page's product copy", () => {
  for (const file of ["src/components/backlog/BacklogList.tsx", "src/components/backlog/TaskListFilters.tsx", "src/components/backlog/TaskCardList.tsx", "src/components/backlog/TaskCardRow.tsx", "src/lib/tasks-list.ts", "src/components/backlog/tasks-list.css"]) {
    assert.doesNotMatch(readIf(file), /Claude|Anthropic/, file);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
