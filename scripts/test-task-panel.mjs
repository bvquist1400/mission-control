#!/usr/bin/env node
// Redesign S3: the task panel (one task view everywhere). Offline by default.
// Run: npm run test:task-panel
//
// What it pins:
//   1. The width rules (src/lib/task-panel.ts): per-screen cookies
//      baseline_panel_today / _tasks / _other, junk clamped to the default,
//      360 px to 70% of the window, [ and ] by 40 px, the drag maths.
//   2. The URL: ?task=<id> opens it (and the Tasks page's old ?expand=<id>),
//      closing drops it and keeps the page's own params, ↑ / ↓ order,
//      shortcuts off while a field or a dialog has focus.
//   3. Wiring: the root layout reads the cookies on the server, the shell
//      reflows beside the panel, the old pop-up editor is gone, and every
//      entry point (Today's Now / board / waiting, Tasks rows, project and app
//      grids, Portfolio, the record page's Edit, search) opens the panel; the
//      panel keeps everything the old editor could do; the ? dialog lists the keys.
// With TASK_PANEL_TEST_BASE_URL (a running local server on fixture data) and
// TASK_PANEL_TEST_COOKIE (its sign-in cookie) it also fetches pages and checks
// the server-rendered panel width (no jump) and the reflow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.env.TASK_PANEL_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readIf = (rel) => (exists(rel) ? read(rel) : "");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").join("\n     ")}`);
  }
}

let lib = null;
try {
  lib = await import(pathToFileURL(path.join(root, "src/lib/task-panel.ts")).href);
} catch (error) {
  console.log(`(src/lib/task-panel.ts did not load: ${String(error?.message ?? error).split("\n")[0]})`);
}
function need() {
  assert.ok(lib, "src/lib/task-panel.ts exists and loads");
  return lib;
}

const ID = "d0000000-0000-4000-8000-000000000001";
const ID2 = "d0000000-0000-4000-8000-000000000002";
const params = (search) => new URLSearchParams(search);

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

// ── 1. width rules ───────────────────────────────────────────────────────
await test("one cookie per screen: baseline_panel_today, baseline_panel_tasks, baseline_panel_other", () => {
  const { PANEL_COOKIES, panelScreenForPath } = need();
  assert.deepEqual(PANEL_COOKIES, { today: "baseline_panel_today", tasks: "baseline_panel_tasks", other: "baseline_panel_other" });
  assert.equal(panelScreenForPath("/"), "today");
  assert.equal(panelScreenForPath("/?mode=personal"), "today");
  assert.equal(panelScreenForPath("/backlog"), "tasks");
  assert.equal(panelScreenForPath("/portfolio"), "other");
  assert.equal(panelScreenForPath(`/projects/${ID}`), "other");
  assert.equal(panelScreenForPath(`/r/task/${ID}`), "other");
  assert.equal(panelScreenForPath(null), "today");
});

await test("defaults follow d2-schemes.html: Today 500 px, Tasks 660 px", () => {
  const { PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_NUDGE_STEP, PANEL_MAX_FRACTION } = need();
  assert.equal(PANEL_DEFAULT_WIDTH.today, 500);
  assert.equal(PANEL_DEFAULT_WIDTH.tasks, 660);
  assert.equal(PANEL_MIN_WIDTH, 360);
  assert.equal(PANEL_NUDGE_STEP, 40);
  assert.equal(PANEL_MAX_FRACTION, 0.7);
});

await test("a stored width is read as whole pixels; junk, empty, negative or unit-suffixed values fall back to the screen default", () => {
  const { parsePanelWidth } = need();
  assert.equal(parsePanelWidth("620", "today"), 620);
  assert.equal(parsePanelWidth(" 620 ", "today"), 620);
  for (const junk of [undefined, null, "", "abc", "500px", "-400", "4e2", "620.5", "NaN", "Infinity", "0x200", "1;2", "%20"]) {
    assert.equal(parsePanelWidth(junk, "today"), 500, `today ${JSON.stringify(junk)}`);
    assert.equal(parsePanelWidth(junk, "tasks"), 660, `tasks ${JSON.stringify(junk)}`);
  }
});

await test("a stored width is clamped: under 360 becomes 360, a huge one is capped (CSS then caps it at 70vw)", () => {
  const { parsePanelWidth, PANEL_ABSOLUTE_MAX_WIDTH } = need();
  assert.equal(parsePanelWidth("0", "today"), 360);
  assert.equal(parsePanelWidth("99", "tasks"), 360);
  assert.equal(parsePanelWidth("99999", "today"), PANEL_ABSOLUTE_MAX_WIDTH);
  assert.equal(parsePanelWidth("2400", "other"), 2400);
});

await test("readPanelWidths reads all three cookies through the layout's getter", () => {
  const { readPanelWidths } = need();
  const jar = { baseline_panel_today: "540", baseline_panel_tasks: "junk", baseline_panel_other: "10" };
  assert.deepEqual(readPanelWidths((name) => jar[name]), { today: 540, tasks: 660, other: 360 });
  assert.deepEqual(readPanelWidths(() => undefined), { today: 500, tasks: 660, other: 560 });
});

await test("on screen the width stays between 360 px and 70% of the window", () => {
  const { clampPanelWidth, panelMaxWidth } = need();
  assert.equal(panelMaxWidth(1440), 1008);
  assert.equal(clampPanelWidth(1200, 1440), 1008);
  assert.equal(clampPanelWidth(200, 1440), 360);
  assert.equal(clampPanelWidth(612.4, 1440), 612);
  // A window too narrow for 70% to reach 360 still gets the minimum.
  assert.equal(panelMaxWidth(400), 360);
  assert.equal(clampPanelWidth(500, 400), 360);
  assert.equal(clampPanelWidth(Number.NaN, 1440), 360);
});

await test("[ narrows and ] widens by 40 px, inside the limits", () => {
  const { nudgePanelWidth } = need();
  assert.equal(nudgePanelWidth(500, "]", 1440), 540);
  assert.equal(nudgePanelWidth(500, "[", 1440), 460);
  assert.equal(nudgePanelWidth(380, "[", 1440), 360);
  assert.equal(nudgePanelWidth(1000, "]", 1440), 1008);
});

await test("dragging: the panel's left edge follows the pointer", () => {
  const { widthFromPointer } = need();
  assert.equal(widthFromPointer(940, 1440), 500);
  assert.equal(widthFromPointer(100, 1440), 1008);
  assert.equal(widthFromPointer(1300, 1440), 360);
});

await test("the cookie the browser writes: path /, a year, SameSite=Lax, a clamped whole number", () => {
  const { panelCookie, panelCssWidth } = need();
  assert.equal(panelCookie("today", 520), "baseline_panel_today=520; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(panelCookie("tasks", 10), "baseline_panel_tasks=360; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(panelCookie("other", 700.6), "baseline_panel_other=701; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.equal(panelCssWidth(520), "min(520px, 70vw)");
});

// ── 2. the URL and the keys ──────────────────────────────────────────────
await test("?task=<id> opens the panel; anything that isn't a task id is ignored", () => {
  const { taskIdFromParams } = need();
  assert.equal(taskIdFromParams(params(`task=${ID}`), "/"), ID);
  assert.equal(taskIdFromParams(params(`mode=personal&task=${ID}`), "/"), ID);
  assert.equal(taskIdFromParams(params("task=not-a-task"), "/"), null);
  assert.equal(taskIdFromParams(params(`task=${ID}%22%3E%3Cscript%3E`), "/"), null);
  assert.equal(taskIdFromParams(params(""), "/"), null);
  assert.equal(taskIdFromParams(null, "/"), null);
});

await test("the Tasks page's old ?expand=<id> link (search, the inbox) opens the panel there, and only there", () => {
  const { taskIdFromParams } = need();
  assert.equal(taskIdFromParams(params(`expand=${ID}`), "/backlog"), ID);
  assert.equal(taskIdFromParams(params(`expand=${ID}&task=${ID2}`), "/backlog"), ID2);
  assert.equal(taskIdFromParams(params(`expand=${ID}`), "/"), null);
  assert.equal(taskIdFromParams(params(`expand=${ID}`), "/portfolio"), null);
});

await test("opening and closing change only ?task (the page's own params and hash stay; expand goes)", () => {
  const { hrefWithTask } = need();
  assert.equal(hrefWithTask("/", "", ID), `/?task=${ID}`);
  assert.equal(hrefWithTask("/", "?mode=personal", ID), `/?mode=personal&task=${ID}`);
  assert.equal(hrefWithTask("/", `?mode=personal&task=${ID}`, ID2), `/?mode=personal&task=${ID2}`);
  assert.equal(hrefWithTask("/", `?mode=personal&task=${ID}`, null), "/?mode=personal");
  assert.equal(hrefWithTask("/backlog", `?sprint=x&expand=${ID}`, ID), `/backlog?sprint=x&task=${ID}`);
  assert.equal(hrefWithTask("/backlog", `?expand=${ID}`, null), "/backlog");
  assert.equal(hrefWithTask("/portfolio", "?scope=all", null, "#later"), "/portfolio?scope=all#later");
});

await test("↑ / ↓ move through the list in the order shown, each task once, no wrap", () => {
  const { neighbourTaskId, uniqueIds } = need();
  const order = uniqueIds(["a", "b", "b", "c", "", "a"]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(neighbourTaskId(order, "b", "down"), "c");
  assert.equal(neighbourTaskId(order, "b", "up"), "a");
  assert.equal(neighbourTaskId(order, "c", "down"), null);
  assert.equal(neighbourTaskId(order, "a", "up"), null);
  assert.equal(neighbourTaskId(order, "zz", "down"), null);
  assert.equal(neighbourTaskId(order, null, "down"), null);
});

await test("keys: Esc closes, ↑ ↓ move, [ ] resize; nothing while typing in a field, with a modifier, or under a dialog", () => {
  const { panelKeyAction } = need();
  const body = { tagName: "BODY", getAttribute: () => null };
  const field = (tagName, type = null) => ({ tagName, getAttribute: (name) => (name === "type" ? type : null) });
  assert.equal(panelKeyAction({ key: "Escape", target: body }), "close");
  assert.equal(panelKeyAction({ key: "ArrowUp", target: body }), "up");
  assert.equal(panelKeyAction({ key: "ArrowDown", target: body }), "down");
  assert.equal(panelKeyAction({ key: "[", target: body }), "narrower");
  assert.equal(panelKeyAction({ key: "]", target: body }), "wider");
  assert.equal(panelKeyAction({ key: "x", target: body }), null);
  for (const target of [field("INPUT"), field("INPUT", "date"), field("TEXTAREA"), field("SELECT"), { tagName: "DIV", isContentEditable: true, getAttribute: () => null }]) {
    for (const key of ["Escape", "ArrowUp", "ArrowDown", "[", "]"]) {
      assert.equal(panelKeyAction({ key, target }), null, `${key} in ${target.tagName}`);
    }
  }
  // A tick box isn't a field you type in.
  assert.equal(panelKeyAction({ key: "ArrowDown", target: field("INPUT", "checkbox") }), "down");
  assert.equal(panelKeyAction({ key: "[", metaKey: true, target: body }), null);
  assert.equal(panelKeyAction({ key: "ArrowDown", altKey: true, target: body }), null);
  assert.equal(panelKeyAction({ key: "Escape", target: body }, { dialogOpen: true }), null);
});

// ── 3. wiring ────────────────────────────────────────────────────────────
await test("the root layout reads the panel cookies on the server and hands them to the shell", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /readPanelWidths\(\(name\) => cookieStore\.get\(name\)\?\.value\)/);
  assert.match(layout, /<AppShell[\s\S]*?panelWidths=\{panelWidths\}>/);
  const shell = read("src/components/layout/AppShell.tsx");
  assert.match(shell, /<TaskPanelProvider widths=\{panelWidths\}>/);
  assert.equal((shell.match(/tp-reflow/g) ?? []).length >= 2, true, "both layouts (normal and full-bleed) reflow");
});

await test("the panel renders at the stored width on the server and narrows the page from the first paint", () => {
  const panel = readIf("src/components/tasks/panel/TaskPanel.tsx");
  assert.match(panel, /style=\{\{ width: css \}\}/);
  assert.match(panel, /const css = panelCssWidth\(width\)/);
  assert.match(panel, /\.tp-reflow\{padding-right:\$\{css\}\}/);
  assert.match(panel, /document\.cookie = panelCookie\(screen, next\)/);
  assert.match(panel, /onDoubleClick=\{resetWidth\}/);
  assert.match(panel, /PANEL_DEFAULT_WIDTH\[screen\]/);
  // Slide-in only when opened by a click, never on a link or reload.
  assert.match(panel, /data-enter=\{animate \? "" : undefined\}/);
  const css = readIf("src/components/tasks/panel/task-panel.css");
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(max-width: 1023px\)[\s\S]*width: 100% !important/, "phone: a full-screen sheet");
});

await test("the old pop-up editor is gone: no TaskDetailModal, no TodayModalProvider, no inline row editor", () => {
  assert.equal(exists("src/components/tasks/TaskDetailModal.tsx"), false, "TaskDetailModal.tsx deleted");
  assert.equal(exists("src/components/today/TodayModalProvider.tsx"), false, "TodayModalProvider.tsx deleted");
  const offenders = walk(path.join(root, "src"), (name) => /\.(tsx?|mjs)$/.test(name))
    .filter((file) => /TaskDetailModal|TodayModalProvider|useTodayModal|TaskEditorLayer/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
  const grid = read("src/components/tasks/TaskGrid.tsx");
  assert.doesNotMatch(grid, /<TaskMetaEditor|expandedTaskId|Expand task details/);
});

const ENTRY_POINTS = [
  ["Today: Now panel", "src/components/today/sections/NowPanel.tsx", /useTaskPanel\(\)[\s\S]*onOpen=\{\(\) => openTask\(task\)\}/],
  ["Today: week board", "src/components/today/sections/WeekBoard.tsx", /useTaskPanel\(\)[\s\S]*openTask\(raw\)/],
  ["Today: Blocked / Waiting strip", "src/components/today/sections/WaitingStrip.tsx", /useTaskPanel\(\)[\s\S]*onClick=\{\(\) => openTask\(task\)\}/],
  ["Tasks, project and application grids (TaskGrid)", "src/components/tasks/TaskGrid.tsx", /useTaskPanel\(\)[\s\S]*onClick=\{\(\) => openTask\(task\)\}/],
  ["Portfolio: Assigned to you / Coming to you later", "src/components/portfolio/PortfolioTasks.tsx", /useTaskPanel\(\)[\s\S]*onOpen=\{\(\) => void open\(task\.id\)\}/],
  ["Record page: Edit", "src/components/portfolio/PortfolioTasks.tsx", /export function TaskEditButton[\s\S]*onClick=\{\(\) => openTask\(taskId\)\}/],
  ["Search (⌘K): a task", "src/components/layout/TopBar.tsx", /openTaskFromSearch = useCallback\(\(taskId: string\) => openTask\(taskId\)/],
];
for (const [label, file, pattern] of ENTRY_POINTS) {
  await test(`entry point opens the panel: ${label}`, () => {
    assert.match(read(file), pattern);
  });
}

await test("search and the record page link to ?task (the old ?expand link still works as an alias)", () => {
  assert.match(read("src/lib/search/browser.ts"), /`\/backlog\?task=\$\{encodeURIComponent\(rawId\)\}`/);
  assert.match(read("src/components/portfolio/TaskRecordPage.tsx"), /<TaskEditButton taskId=\{view\.id\} \/>/);
});

await test("cards and rows say which task they open, so ↑ / ↓ follow the page's own order", () => {
  for (const file of [
    "src/components/today/cards/NowTaskCard.tsx",
    "src/components/today/cards/BoardTaskCard.tsx",
    "src/components/today/sections/WeekBoard.tsx",
    "src/components/today/sections/WaitingStrip.tsx",
    "src/components/tasks/TaskGrid.tsx",
    "src/components/portfolio/PortfolioTasks.tsx",
  ]) {
    assert.match(read(file), /data-task-open=\{/, file);
  }
  assert.match(read("src/components/tasks/TaskGrid.tsx"), /taskList = "grid"/, "a grid is its own list unless the page marks one");
  for (const [file, list] of [
    ["src/components/today/sections/NowPanel.tsx", "now"],
    ["src/components/today/sections/WeekBoard.tsx", "board"],
    ["src/components/today/sections/WaitingStrip.tsx", "waiting"],
    ["src/components/projects/ProjectTaskSectionsPanel.tsx", "project"],
    ["src/components/portfolio/PortfolioTasks.tsx", "assigned"],
  ]) {
    assert.match(read(file), new RegExp(`data-task-list="${list}"`), file);
  }
});

await test("the panel keeps everything the old editor could do", () => {
  const body = readIf("src/components/tasks/panel/TaskPanelBody.tsx");
  for (const piece of [
    /<StatusSelector value=\{task\.status\}/,
    /aria-label="Due date"/,
    /<TaskOwnerSection key=\{task\.id\}/,
    /onHandBack=\{handleHandBack\}/,
    /<TaskStepsPanel steps=\{steps\}/,
    /<ChecklistSection/,
    /Break into tasks/,
    /<BreakIntoTasksDialog/,
    /<TaskComments[\s\S]*variant="gist"/,
    /<TaskDependencies/,
    /<TaskNotesPanel/,
    /<TaskMetaEditor/,
    /Delete task/,
    /status: "Parked"/,
    /Mark done/,
    /buildTaskPageView\(/,
  ]) {
    assert.match(body, piece, String(piece));
  }
  const frame = readIf("src/components/tasks/panel/TaskPanel.tsx");
  assert.match(frame, /href=\{`\/r\/task\/\$\{taskId\}`\}[\s\S]*Open full page/);
  assert.match(frame, /aria-label="Close the task \(Esc\)"/);
  assert.match(body, /data-project-square-slot[\s\S]*<ProjectSquare/, "S2's project colour square in the panel header");
});

await test("the ? dialog lists the panel's keys", () => {
  const dialog = read("src/components/layout/ShortcutsDialog.tsx");
  assert.match(dialog, /TASK_PANEL_KEYS/);
  for (const key of ['"↑"', '"↓"', '"Esc"', '"\\["', '"\\]"']) assert.match(dialog, new RegExp(`keys: \\[${key}\\]`), key);
});

await test("user-facing text in the panel never names the AI product", () => {
  for (const file of ["src/components/tasks/panel/TaskPanel.tsx", "src/components/tasks/panel/TaskPanelBody.tsx", "src/components/tasks/TaskComments.tsx"]) {
    assert.doesNotMatch(readIf(file), /Claude|Anthropic/, file);
  }
});

// ── 4. server render (optional) ──────────────────────────────────────────
const base = process.env.TASK_PANEL_TEST_BASE_URL;
const authCookie = process.env.TASK_PANEL_TEST_COOKIE;
if (base && authCookie) {
  const TASK = process.env.TASK_PANEL_TEST_TASK_ID || ID;
  async function page(route, cookies = "") {
    const response = await fetch(new URL(route, base), { headers: { cookie: `${authCookie}${cookies ? `; ${cookies}` : ""}` }, redirect: "manual" });
    assert.equal(response.status, 200, `${route} -> ${response.status}`);
    return response.text();
  }
  const panelWidth = (html) => html.match(/data-task-panel="[^"]+"[^>]*style="width:([^"]+)"/)?.[1] ?? null;
  for (const [route, cookie, expected] of [
    [`/?task=${TASK}`, "", "min(500px, 70vw)"],
    [`/?task=${TASK}`, "baseline_panel_today=620", "min(620px, 70vw)"],
    [`/?task=${TASK}`, "baseline_panel_today=junk", "min(500px, 70vw)"],
    [`/?task=${TASK}`, "baseline_panel_today=12", "min(360px, 70vw)"],
    [`/?mode=personal&task=${TASK}`, "baseline_panel_today=540", "min(540px, 70vw)"],
    [`/backlog?task=${TASK}`, "", "min(660px, 70vw)"],
    [`/backlog?task=${TASK}`, "baseline_panel_tasks=720; baseline_panel_today=400", "min(720px, 70vw)"],
    [`/backlog?expand=${TASK}`, "baseline_panel_tasks=700", "min(700px, 70vw)"],
    [`/portfolio?task=${TASK}`, "baseline_panel_other=480", "min(480px, 70vw)"],
  ]) {
    await test(`server render: ${route} with ${cookie || "no width cookie"} -> panel at ${expected}, page narrowed by the same`, async () => {
      const html = await page(route, cookie);
      assert.equal(panelWidth(html), expected);
      assert.ok(html.includes(`.tp-reflow{padding-right:${expected}}`), "reflow style in the first HTML");
      assert.ok(html.includes(`data-task-open="${TASK}"]{outline`), "the open card is marked");
    });
  }
  for (const route of ["/", "/backlog", "/?task=not-a-task", `/portfolio?expand=${TASK}`]) {
    await test(`server render: ${route} -> no panel and no reflow`, async () => {
      const html = await page(route, "baseline_panel_today=620");
      assert.equal(panelWidth(html), null);
      assert.ok(!html.includes(".tp-reflow{padding-right"), "no reflow");
    });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
