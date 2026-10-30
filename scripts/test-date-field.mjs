#!/usr/bin/env node
// Tests for the shared date field (Baseline task afe37a69, plan "Now unblocked +
// calendar date picker" slice S1): one date box on the phone's own calendar with
// Today / Tomorrow / Next week chips, Clear, and a "Lands on Fri, Oct 30" line.
//
// - The value rules (src/components/utils/date-field.ts): chips pick the same day
//   as the typing shortcuts (t, t+1, t+7), typed shortcuts still resolve, empty /
//   Clear means "no date", min/max limits, the read-back words, and the task
//   editor's Start/Due rules (start <= due blocks Save only when a date changes).
// - The component (src/components/ui/DateField.tsx) rendered with react-dom/server
//   after a TypeScript transpile of the TSX, and its handlers run with a small hook
//   harness: a chip hands back its day, Clear hands back "", the picker's value is
//   passed through.
// - The task editor (TaskMetaEditor) through the same harness: a chip, a calendar
//   pick and a typed shortcut save exactly the same due_at / start_at as before.
// - The wiring: the new-task and Quick capture Due boxes no longer flip text→date
//   on focus, and every swapped screen uses the shared field.
//
// Offline: no database, no network, no browser.
//
//   npm run test:date-field

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
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
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

async function load(file) {
  try {
    return await import(pathToFileURL(path.join(ROOT, file)).href);
  } catch (error) {
    return { __missing: String(error.message).split("\n")[0] };
  }
}
function need(mod, ...names) {
  if (mod.__missing) assert.fail(`module missing: ${mod.__missing}`);
  for (const name of names) assert.equal(typeof mod[name], "function", `${name} is not exported`);
}

const field = await load("src/components/utils/date-field.ts");
const dates = await load("src/components/utils/dates.ts");
const taskRange = await load("src/lib/task-range.ts");

// Fri Oct 30 2026, mid-morning local time (the day Brent asked for this).
const FRI = new Date(2026, 9, 30, 9, 15, 0, 0);
const localEnd = (y, m, d) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
const localStart = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();

// ── Chips ──────────────────────────────────────────────────────────────────
await test("chips: Today / Tomorrow / Next week are the days 't', 't+1' and 't+7' (= 'w+1') give", () => {
  need(field, "chipDate");
  assert.equal(field.chipDate("today", FRI), "2026-10-30");
  assert.equal(field.chipDate("tomorrow", FRI), "2026-10-31");
  assert.equal(field.chipDate("next_week", FRI), "2026-11-06");
  for (const [chip, shortcut] of [["today", "t"], ["tomorrow", "t+1"], ["next_week", "t+7"], ["next_week", "w+1"], ["today", "today"], ["tomorrow", "tmr"]]) {
    assert.equal(field.chipDate(chip, FRI), dates.resolveDueDateInput(shortcut, FRI).dateOnly, `${chip} = ${shortcut}`);
  }
  assert.deepEqual(field.DATE_CHIPS.map((chip) => chip.label), ["Today", "Tomorrow", "Next week"]);
});

await test("chips: month and year ends, a leap day and the Nov 1 clock change land on the right day", () => {
  need(field, "chipDate");
  assert.equal(field.chipDate("tomorrow", new Date(2026, 11, 31, 23, 30)), "2027-01-01");
  assert.equal(field.chipDate("next_week", new Date(2026, 11, 28, 8, 0)), "2027-01-04");
  assert.equal(field.chipDate("tomorrow", new Date(2028, 1, 28, 12, 0)), "2028-02-29");
  // Sat Oct 31 2026 late evening; the clocks go back on Sun Nov 1.
  assert.equal(field.chipDate("tomorrow", new Date(2026, 9, 31, 23, 45)), "2026-11-01");
  assert.equal(field.chipDate("next_week", new Date(2026, 9, 31, 23, 45)), "2026-11-07");
});

await test("chips: a day outside the field's min / max is refused (the chip is disabled)", () => {
  need(field, "withinLimits");
  assert.equal(field.withinLimits("2026-10-30"), true);
  assert.equal(field.withinLimits("2026-10-30", "2026-10-30", "2026-11-06"), true);
  assert.equal(field.withinLimits("2026-10-29", "2026-10-30"), false);
  assert.equal(field.withinLimits("2026-11-07", undefined, "2026-11-06"), false);
  assert.equal(field.withinLimits(""), false);
});

// ── Values: typed, picked, empty ───────────────────────────────────────────
await test("typed shortcuts keep working in the task editor (t+7, 10/26, 10/26/2026, 2026-11-04, today)", () => {
  need(field, "resolveDateFieldValue");
  const typed = (value) => field.resolveDateFieldValue(value, { allowTyping: true, baseDate: FRI });
  assert.deepEqual(typed("t+7"), { dateOnly: "2026-11-06", error: null });
  assert.deepEqual(typed("w+1"), { dateOnly: "2026-11-06", error: null });
  assert.deepEqual(typed("m+1"), { dateOnly: "2026-11-30", error: null });
  assert.deepEqual(typed("10/26/2026"), { dateOnly: "2026-10-26", error: null });
  assert.deepEqual(typed("10/26/26"), { dateOnly: "2026-10-26", error: null });
  assert.deepEqual(typed("2026-11-04"), { dateOnly: "2026-11-04", error: null });
  assert.deepEqual(typed("today"), { dateOnly: "2026-10-30", error: null });
  assert.deepEqual(typed("  "), { dateOnly: null, error: null }, "blank = no date");
  assert.match(typed("next tuesday").error, /Use YYYY-MM-DD/);
  assert.equal(typed("2026-02-30").dateOnly, null, "an impossible day is not a date");
});

await test("picker fields: the value is a YYYY-MM-DD day or '' (Clear / the picker's Reset), never a typed word", () => {
  need(field, "resolveDateFieldValue", "pickerValue");
  assert.deepEqual(field.resolveDateFieldValue("2026-11-04"), { dateOnly: "2026-11-04", error: null });
  assert.deepEqual(field.resolveDateFieldValue(""), { dateOnly: null, error: null });
  assert.deepEqual(field.resolveDateFieldValue("t+7"), { dateOnly: null, error: null }, "no shortcuts outside the editor");
  assert.equal(field.pickerValue("2026-11-04"), "2026-11-04");
  assert.equal(field.pickerValue(""), "");
  // In the editor the calendar opens on the day the typed text stands for.
  assert.equal(field.pickerValue("t+7", { allowTyping: true, baseDate: FRI }), "2026-11-06");
  assert.equal(field.pickerValue("10/26", { allowTyping: true, baseDate: FRI }), "", "10/26 without a year is not a date today, as before");
  assert.equal(field.pickerValue("nonsense", { allowTyping: true, baseDate: FRI }), "");
});

await test("read-back: 'Fri, Oct 30' this year, the year added otherwise, nothing for no day", () => {
  need(field, "landsOnLabel");
  assert.equal(field.landsOnLabel("2026-10-30", FRI), "Fri, Oct 30");
  assert.equal(field.landsOnLabel("2026-11-04", FRI), "Wed, Nov 4");
  assert.equal(field.landsOnLabel("2027-01-04", FRI), "Mon, Jan 4, 2027");
  assert.equal(field.landsOnLabel("2026-11-01", FRI), "Sun, Nov 1", "the clock-change day");
  assert.equal(field.landsOnLabel("", FRI), null);
  assert.equal(field.landsOnLabel(null, FRI), null);
  assert.equal(field.landsOnLabel("2026-02-30", FRI), null);
});

// ── The task editor's Start / Due rules ─────────────────────────────────────
await test("editor dates: start saves at the start of its day, due at the end, the same instants as before", () => {
  need(field, "resolveTaskDateDrafts");
  const drafts = field.resolveTaskDateDrafts({ startDraft: field.chipDate("today", FRI), dueDraft: "t+7", savedStartAt: null, savedDueAt: null, baseDate: FRI });
  assert.equal(drafts.start.iso, localStart(2026, 10, 30));
  assert.equal(drafts.due.iso, localEnd(2026, 11, 6));
  assert.equal(drafts.due.iso, dates.localDateInputToEndOfDayIso(field.chipDate("next_week", FRI)), "chip and shortcut save the same instant");
  assert.equal(drafts.start.iso, dates.resolveStartDateInput("t", FRI).iso);
  assert.equal(drafts.hasStartDateChange, true);
  assert.equal(drafts.hasDueDateChange, true);
  assert.equal(drafts.rangeError, null);
});

await test("editor dates: start <= due — a due picked before the start blocks Save; same day is fine", () => {
  need(field, "resolveTaskDateDrafts");
  const saved = { savedStartAt: localStart(2026, 11, 2), savedDueAt: localEnd(2026, 11, 6), baseDate: FRI };
  const early = field.resolveTaskDateDrafts({ ...saved, startDraft: "2026-11-02", dueDraft: field.chipDate("today", FRI) });
  assert.equal(early.rangeError, taskRange.START_AFTER_DUE_ERROR);
  const startLate = field.resolveTaskDateDrafts({ ...saved, startDraft: "2026-11-09", dueDraft: "2026-11-06" });
  assert.equal(startLate.rangeError, taskRange.START_AFTER_DUE_ERROR);
  const sameDay = field.resolveTaskDateDrafts({ ...saved, startDraft: "2026-11-06", dueDraft: "2026-11-06" });
  assert.equal(sameDay.rangeError, null);
  const cleared = field.resolveTaskDateDrafts({ ...saved, startDraft: "", dueDraft: field.chipDate("today", FRI) });
  assert.equal(cleared.rangeError, null, "no start, no range to check");
});

await test("editor dates: a start already saved after the due shows the repair hint and doesn't block other edits", () => {
  need(field, "resolveTaskDateDrafts");
  const drafts = field.resolveTaskDateDrafts({
    startDraft: "2026-10-29", dueDraft: "2026-10-28", savedStartAt: localStart(2026, 10, 29), savedDueAt: localEnd(2026, 10, 28), baseDate: FRI,
  });
  assert.equal(drafts.hasStartDateChange, false);
  assert.equal(drafts.hasDueDateChange, false);
  assert.equal(drafts.rangeError, null);
  assert.equal(drafts.savedRangeHint, taskRange.SAVED_START_AFTER_DUE_HINT);
});

await test("editor dates: Clear (or an emptied box) clears the date; a typo keeps the saved day and blocks nothing else", () => {
  need(field, "resolveTaskDateDrafts");
  const saved = { savedStartAt: null, savedDueAt: localEnd(2026, 11, 6), baseDate: FRI };
  const clear = field.resolveTaskDateDrafts({ ...saved, startDraft: "", dueDraft: "" });
  assert.equal(clear.hasDueDateChange, true);
  assert.equal(clear.due.iso, null, "saved as no due date");
  const typo = field.resolveTaskDateDrafts({ ...saved, startDraft: "", dueDraft: "11/6/2O26" });
  assert.match(typo.due.error, /Use YYYY-MM-DD/);
  assert.equal(typo.hasDueDateChange, false);
  assert.equal(typo.nextDueDate, "2026-11-06");
  const unchanged = field.resolveTaskDateDrafts({ ...saved, startDraft: "", dueDraft: "2026-11-06" });
  assert.equal(unchanged.hasDueDateChange, false, "picking the saved day again changes nothing");
});

// ── The component, rendered ────────────────────────────────────────────────
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const ui = await load("src/components/ui/DateField.tsx");
const render = (props) => renderToStaticMarkup(h(ui.DateField, { label: "Due date", onChange: () => {}, ...props }));
const today = field.chipDate?.("today") ?? "";

await test("render: the phone's own date picker with the day shown, the chips and 'Lands on …'", () => {
  need(ui, "DateField");
  const html = render({ value: "2026-11-04" });
  assert.match(html, /<input type="date" aria-label="Due date"[^>]* value="2026-11-04"/);
  assert.match(html, /Wed, Nov 4/);
  for (const label of ["Today", "Tomorrow", "Next week", "Clear"]) assert.match(html, new RegExp(`>${label}</button>`), label);
  assert.match(html, /Lands on <b[^>]*>Wed, Nov 4<\/b>\./);
  assert.doesNotMatch(html, /type="text"/, "no text box outside the editor");
});

await test("render: empty shows the placeholder, no Clear and no read-back; required fields never offer Clear", () => {
  need(ui, "DateField");
  const empty = render({ value: "", placeholder: "No due date" });
  assert.match(empty, /No due date/);
  assert.doesNotMatch(empty, />Clear</);
  assert.doesNotMatch(empty, /Lands on/);
  assert.match(empty, /value=""/);
  const required = render({ value: "2026-11-04", clearable: false });
  assert.doesNotMatch(required, />Clear</);
});

await test("render: chips off / read-back off / hint; chips outside min or max are disabled; disabled disables everything", () => {
  need(ui, "DateField");
  const bare = render({ value: "2026-11-04", chips: false, clearable: false, readBack: false });
  assert.doesNotMatch(bare, /<button/);
  assert.doesNotMatch(bare, /Lands on/);
  const withHint = render({ value: "2026-11-04", hint: "2 tasks will follow." });
  assert.match(withHint, /Lands on <b[^>]*>Wed, Nov 4<\/b>\. 2 tasks will follow\./);
  const limited = render({ value: today, min: field.chipDate("tomorrow") });
  const chipTag = (html, name) => html.match(new RegExp(`<button[^>]*aria-label="Due date: ${name}"[^>]*>`))?.[0] ?? "";
  assert.match(chipTag(limited, "Today"), /disabled=""/, "today is before the min");
  assert.doesNotMatch(chipTag(limited, "Tomorrow"), /disabled=""/);
  const off = render({ value: "2026-11-04", disabled: true });
  assert.equal((off.match(/disabled=""/g) ?? []).length, 5, "the picker and all four chips");
});

await test("render: the editor's typing mode is a text box (shortcuts) plus a calendar button on the native picker", () => {
  need(ui, "DateField");
  const html = render({ value: "t+7", allowTyping: true, placeholder: "YYYY-MM-DD or t+7", readBack: false, hint: "Lands on soon." });
  const textTag = html.match(/<input type="text"[^>]*>/)?.[0] ?? "";
  assert.match(textTag, /value="t\+7"/);
  assert.match(textTag, /placeholder="YYYY-MM-DD or t\+7"/);
  assert.match(html, /<input type="date" aria-label="Due date: pick on the calendar"/);
  assert.match(html, new RegExp(`aria-label="Due date: pick on the calendar"[^>]* value="${field.chipDate?.("next_week") ?? "x"}"`), "the calendar opens on the typed day");
  assert.match(html, /Lands on soon\./);
});

// ── Handlers, through a small hook harness (no browser) ─────────────────────
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
  useEffect() {
    activeHooks.cursor++;
  },
  useId: () => "f1",
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};
const harnessJsx = (type, props) => ({ type, props: props ?? {} });
function loadWithHarness(relative, stubs = {}) {
  const cache = new Map();
  const loadFile = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const loaded = { exports: {} };
    cache.set(file, loaded);
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
            return loadFile(candidate);
          } catch {}
        }
      }
      return requireCjs(spec);
    };
    new Function("require", "module", "exports", code)(localRequire, loaded, loaded.exports);
    return loaded.exports;
  };
  return loadFile(path.join(ROOT, relative));
}
function mount(Component, props) {
  const hooks = { slots: [], cursor: 0 };
  return () => {
    hooks.cursor = 0;
    activeHooks = hooks;
    return Component(props);
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

function harnessed(relative, stubs) {
  try {
    return loadWithHarness(relative, stubs);
  } catch (error) {
    return { __missing: String(error.message).split("\n")[0] };
  }
}

const harnessUi = harnessed("src/components/ui/DateField.tsx");
function fieldHandlers(props) {
  need(harnessUi, "DateField");
  const calls = [];
  const tree = mount(harnessUi.DateField, { label: "Due date", onChange: (value) => calls.push(value), ...props })();
  const button = (text) => findNodes(tree, (node) => node.type === "button" && nodeText(node) === text)[0];
  const picker = findNodes(tree, (node) => node.type === "input" && node.props.type === "date")[0];
  const text = findNodes(tree, (node) => node.type === "input" && node.props.type === "text")[0];
  return { calls, button, picker, text };
}

await test("handlers: each chip hands back its day, Clear hands back '', the picker's day is passed through", () => {
  const f = fieldHandlers({ value: "2026-11-04" });
  f.button("Today").props.onClick();
  f.button("Tomorrow").props.onClick();
  f.button("Next week").props.onClick();
  f.button("Clear").props.onClick();
  f.picker.props.onChange({ target: { value: "2026-12-25" } });
  f.picker.props.onChange({ target: { value: "" } });
  assert.deepEqual(f.calls, [field.chipDate("today"), field.chipDate("tomorrow"), field.chipDate("next_week"), "", "2026-12-25", ""]);
});

await test("handlers: in typing mode the text box passes what was typed; the calendar sets a plain day; blur/keys stay on the text box", () => {
  const blur = () => "blur";
  const keys = () => "keys";
  const f = fieldHandlers({ value: "", allowTyping: true, onBlur: blur, onKeyDown: keys });
  f.text.props.onChange({ target: { value: "t+7" } });
  f.picker.props.onChange({ target: { value: "2026-11-04" } });
  assert.deepEqual(f.calls, ["t+7", "2026-11-04"]);
  assert.equal(f.text.props.onBlur, blur);
  assert.equal(f.text.props.onKeyDown, keys);
  assert.equal(f.picker.props.onBlur, undefined, "leaving the calendar doesn't run the editor's blur");
});

// ── The task editor saves the same values whichever way the date was set ────
const editorModule = harnessed("src/components/tasks/TaskMetaEditor.tsx", {
  "@/hooks/useSprints": { useSprints: () => ({ sprints: [], loading: false }) },
  "@/components/ui/Button": { Button: "Button" },
  "@/components/ui/Field": { Input: "Input", Select: "Select", Textarea: "Textarea" },
  "@/components/tasks/TaskTagChips": { TaskTagChips: "TaskTagChips" },
  "@/components/ui/DateField": { DateField: "DateField" },
});
const editorTask = (start_at, due_at) => ({
  id: "task-1", title: "Original title", description: null, task_type: "Task", status: "Planned", tags: [], recurrence: null,
  recurring_template_id: null, implementation_id: null, project_id: null, section_id: null, sprint_id: null, waiting_on: null,
  start_at, due_at, updated_at: "2026-10-26T12:00:00Z",
});
function mountEditor(task) {
  need(editorModule, "TaskMetaEditor");
  const updates = [];
  const render = mount(editorModule.TaskMetaEditor, {
    task, isSaving: false, onUpdate: async (_id, payload) => { updates.push(payload); return "saved"; }, onReplaceTask: () => {}, blocks: null,
  });
  const dateField = (label) => findNodes(render(), (node) => node.type === "DateField" && node.props.label === label)[0];
  const save = () => findNodes(render(), (node) => node.type === "Button" && nodeText(node).includes("Save edits"))[0];
  return { updates, start: () => dateField("Start"), due: () => dateField("Due"), save };
}

await test("editor: Start and Due are the shared field with typing on (shortcuts kept beside the calendar button)", () => {
  const editor = mountEditor(editorTask(null, null));
  assert.ok(editor.start(), "Start is a DateField");
  assert.ok(editor.due(), "Due is a DateField");
  assert.equal(editor.start().props.allowTyping, true);
  assert.equal(editor.due().props.allowTyping, true);
  assert.equal(editor.due().props.placeholder, "YYYY-MM-DD or t+7");
});

await test("editor: a Today chip, a calendar pick of today and typing 't' save the same due_at (end of the local day)", () => {
  const expected = dates.localDateInputToEndOfDayIso(field.chipDate("today"));
  for (const value of [field.chipDate("today"), "t", "today"]) {
    const editor = mountEditor(editorTask(null, null));
    editor.due().props.onChange(value);
    editor.save().props.onClick();
    assert.deepEqual(editor.updates, [{ due_at: expected }], `value ${value}`);
  }
});

await test("editor: Next week = t+7 for Due; a start chip saves the start of that day; Clear sends null", () => {
  const nextWeek = mountEditor(editorTask(null, null));
  nextWeek.due().props.onChange(field.chipDate("next_week"));
  nextWeek.save().props.onClick();
  assert.deepEqual(nextWeek.updates, [{ due_at: dates.resolveDueDateInput("t+7").iso }]);

  const start = mountEditor(editorTask(null, localEnd(2027, 1, 29)));
  start.start().props.onChange(field.chipDate("tomorrow"));
  start.save().props.onClick();
  assert.deepEqual(start.updates, [{ start_at: dates.resolveStartDateInput("t+1").iso }]);

  const clear = mountEditor(editorTask(null, localEnd(2026, 11, 6)));
  clear.due().props.onChange("");
  clear.save().props.onClick();
  assert.deepEqual(clear.updates, [{ due_at: null }]);
});

await test("editor: a Due chip before the saved start disables Save and marks the field; nothing is sent", () => {
  const editor = mountEditor(editorTask(localStart(2027, 1, 25), localEnd(2027, 1, 29)));
  editor.due().props.onChange(field.chipDate("today"));
  assert.equal(editor.save().props.disabled, true);
  assert.equal(editor.due().props.invalid, false, "the due box itself parses");
  assert.equal(editor.start().props.invalid, true, "the start is the one flagged, as before");
  editor.save().props.onClick();
  assert.deepEqual(editor.updates, []);
});

// ── Wiring ─────────────────────────────────────────────────────────────────
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

await test("wiring: new task and Quick capture Due use the shared field, no text→date flip on focus", () => {
  const form = read("src/components/tasks/TaskCreateForm.tsx");
  assert.doesNotMatch(form, /currentTarget\.type = "date"/, "the focus flip that brings up the keyboard on an iPhone");
  assert.doesNotMatch(form, /type=\{(draft|qcDraft)\.dueDate \? "date" : "text"\}/);
  assert.equal((form.match(/<DateField\b/g) ?? []).length, 2);
  // The save rule is unchanged: end of the local day, or no date.
  assert.match(form, /due_at: draft\.dueDate \? localDateInputToEndOfDayIso\(draft\.dueDate\) : null/);
  assert.match(form, /due_at: qcDraft\.dueDate \? localDateInputToEndOfDayIso\(qcDraft\.dueDate\) : null/);
});

await test("wiring: the swapped date boxes use the shared field; the ones left alone are still native", () => {
  const swapped = {
    "src/components/tasks/TaskMetaEditor.tsx": 3,
    "src/app/applications/page.tsx": 1,
    "src/app/stakeholders/[id]/page.tsx": 1,
    "src/app/weekly-review/page.tsx": 1,
    "src/components/notes/CreateTaskFromNoteDialog.tsx": 1,
    "src/components/notes/CreateDecisionFromNoteDialog.tsx": 1,
    "src/components/sprints/SprintsList.tsx": 2,
    "src/components/sprints/SprintDetail.tsx": 2,
    "src/components/projects/ProjectsList.tsx": 1,
    "src/components/projects/ProjectTemplateCatalogModal.tsx": 1,
    "src/components/today/PlannerCard.tsx": 1,
  };
  for (const [file, count] of Object.entries(swapped)) {
    const source = read(file);
    assert.equal((source.match(/<DateField\b/g) ?? []).length, count, `${file}: DateField count`);
    assert.doesNotMatch(source, /type="date"/, `${file}: no bare date input left`);
  }
  // Brief "Pick a date…" (PickRow) is untouched by this slice.
  assert.match(read("src/components/briefs/cards.tsx"), /type="date"/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
