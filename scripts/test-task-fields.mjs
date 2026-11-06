#!/usr/bin/env node
// Redesign S5 fix round 1 (Brent 11/6 "Fix bug + fields"): Estimate, Priority, Blocker and Type
// in the task panel's "All fields" for every task (inside or outside a project / application),
// saved through the panel's ordinary PATCH /api/tasks/[id]; sort by estimate on Tasks.
// Offline (no database, network or browser). Run: npm run test:task-fields
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(process.env.TASK_FIELDS_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

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

const fields = await load("src/lib/task-fields.ts");
const list = await load("src/lib/tasks-list.ts");
const editorMod = await load("src/components/tasks/TaskMetaEditor.tsx");
const rowMod = await load("src/components/backlog/TaskCardRow.tsx");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const F = () => {
  assert.ok(fields, "src/lib/task-fields.ts exists and loads");
  return fields;
};

await test("estimate: minutes or hours as typed, whole minutes 1 to 480", () => {
  const { parseEstimateDraft } = F();
  const ok = (text, value) => assert.deepEqual(parseEstimateDraft(text), { ok: true, value }, text);
  ok("45", 45);
  ok(" 45 min ", 45);
  ok("45m", 45);
  ok("1h", 60);
  ok("1.5h", 90);
  ok("1h 30m", 90);
  ok("2 hours", 120);
  ok("1:30", 90);
  ok("480", 480);
  ok("1", 1);
  for (const bad of ["", "  ", "0", "481", "9h", "abc", "-5", "1.5", "1:75"]) {
    assert.equal(parseEstimateDraft(bad).ok, false, `"${bad}" refused`);
  }
  assert.match(parseEstimateDraft("481").error, /1 to 480 minutes/);
});

await test("priority: the base, a whole number 0 to 100; the hint explains the score", () => {
  const { parsePriorityDraft, priorityHint, basePriorityOf } = F();
  assert.deepEqual(parsePriorityDraft("0"), { ok: true, value: 0 });
  assert.deepEqual(parsePriorityDraft(" 100 "), { ok: true, value: 100 });
  for (const bad of ["", "101", "-1", "50.5", "high"]) assert.equal(parsePriorityDraft(bad).ok, false, bad);
  assert.equal(basePriorityOf({ base_priority: 50, priority_score: 72 }), 50);
  assert.equal(basePriorityOf({ priority_score: 40 }), 40, "an older row without a base falls back to the score");
  assert.equal(priorityHint({ base_priority: 50, priority_score: 72 }), "Score 72 = 50 + 22 from the due date and people.");
  assert.equal(priorityHint({ base_priority: 50, priority_score: 50 }), "Score 50. Due dates and people add to it on their own.");
});

await test("estimate words", () => {
  const { estimateText } = F();
  assert.equal(estimateText(30), "30 min");
  assert.equal(estimateText(60), "1 h");
  assert.equal(estimateText(90), "1 h 30 min");
  assert.equal(estimateText(null), "none");
});

await test("the save: only what changed, estimate as manual, priority as the base (server adds boosts), blocker on/off", () => {
  const { fieldUpdates, fieldDraftsOf } = F();
  const task = { estimated_minutes: 30, base_priority: 50, priority_score: 72, blocker: false };
  const drafts = fieldDraftsOf(task);
  assert.deepEqual(drafts, { estimate: "30", priority: "50", blocker: false }, "the boxes start from the saved values (the base, not the boosted score)");
  assert.deepEqual(fieldUpdates(task, drafts), { updates: {}, changed: false, errors: {} }, "untouched: nothing sent");
  assert.deepEqual(fieldUpdates(task, { ...drafts, estimate: "1h" }).updates, { estimated_minutes: 60, estimate_source: "manual" });
  assert.deepEqual(fieldUpdates(task, { ...drafts, estimate: "30m" }).updates, {}, "same minutes typed differently: nothing");
  assert.deepEqual(fieldUpdates(task, { ...drafts, priority: "80" }).updates, { priority_score: 80 });
  assert.deepEqual(fieldUpdates(task, { ...drafts, blocker: true }).updates, { blocker: true });
  assert.deepEqual(fieldUpdates({ ...task, blocker: true }, { ...drafts, blocker: false }).updates, { blocker: false });
  const all = fieldUpdates(task, { estimate: "2h", priority: "10", blocker: true });
  assert.deepEqual(all.updates, { estimated_minutes: 120, estimate_source: "manual", priority_score: 10, blocker: true });
  const bad = fieldUpdates(task, { ...drafts, estimate: "999", priority: "x" });
  assert.equal(bad.changed, false);
  assert.match(bad.errors.estimate, /480/);
  assert.match(bad.errors.priority, /0 to 100/);
  // A task with no estimate loaded (older rows in tests) leaves the box empty and sends nothing.
  assert.deepEqual(fieldUpdates({}, fieldDraftsOf({})), { updates: {}, changed: false, errors: {} });
});

await test("the panel's All fields shows Type, Estimate, Priority and Blocker for a task in no project or app", () => {
  assert.ok(editorMod?.TaskMetaEditor, "TaskMetaEditor renders");
  const task = {
    id: "t-1", title: "Loose task", description: null, task_type: "Admin", status: "Planned", tags: [], recurrence: null,
    recurring_template_id: null, implementation_id: null, project_id: null, section_id: null, sprint_id: null, waiting_on: null,
    start_at: null, due_at: null, updated_at: "2026-11-06T12:00:00Z", project: null, implementation: null,
    estimated_minutes: 90, estimate_source: "default", base_priority: 40, priority_score: 55, blocker: true,
  };
  const html = renderToStaticMarkup(h(editorMod.TaskMetaEditor, { task, isSaving: false, onUpdate: async () => true, onReplaceTask: () => {}, blocks: null }));
  assert.match(html, /Task Type/);
  assert.match(html, /<option value="Admin" selected="">Admin<\/option>/);
  assert.match(html, />Estimate</);
  assert.match(html, /value="90"/);
  assert.match(html, /Now 1 h 30 min \(default\)\./);
  assert.match(html, />Priority</);
  assert.match(html, /value="40"/);
  assert.match(html, /Score 55 = 40 \+ 15 from the due date and people\./);
  assert.match(html, />Blocker</);
  assert.match(html, /<input type="checkbox" class="[^"]*" checked=""\/><span><span class="font-medium">Blocker</);
});

await test("wiring: the editor saves them with the other fields through onUpdate (the panel's PATCH); the payload type knows priority_score", () => {
  const editor = read("src/components/tasks/TaskMetaEditor.tsx");
  assert.match(editor, /const fieldPlan = fieldUpdates\(task, fieldDrafts\);/);
  assert.match(editor, /const updates: TaskUpdatePayload = \{ \.\.\.fieldPlan\.updates \};/);
  assert.match(editor, /fieldPlan\.changed\s*\|\| normalizedTitle !== task\.title/);
  assert.match(editor, /&& !fieldPlan\.errors\.estimate\s*&& !fieldPlan\.errors\.priority;/);
  assert.match(editor, /setFieldDrafts\(fieldDraftsOf\(task\)\);/, "the boxes follow a saved change");
  assert.match(read("src/components/tasks/panel/TaskPanelBody.tsx"), /<TaskMetaEditor[\s\S]*onUpdate=\{handleMetaUpdate\}/);
  assert.match(read("src/types/database.ts"), /priority_score\?: number;/);
  const route = read("src/app/api/tasks/[id]/route.ts");
  for (const field of ["'estimated_minutes'", "'blocker'", "'priority_score'", "'task_type'"]) assert.ok(route.includes(field), `PATCH allows ${field}`);
});

await test("Tasks: sort by estimate (shortest first, none last), in the URL, minutes on the cards", () => {
  assert.ok(list, "tasks-list loads");
  const { parseTaskListFilters, filtersQuery, groupTaskList, SORT_LABELS } = list;
  assert.equal(parseTaskListFilters("sort=estimate").sort, "estimate");
  assert.equal(filtersQuery(parseTaskListFilters("sort=estimate")), "sort=estimate");
  assert.equal(SORT_LABELS.estimate, "Estimate (shortest first)");
  const t = (id, estimated_minutes, due_at = null) => ({ id, title: id, status: "Planned", due_at, estimated_minutes, priority_score: 50 });
  const order = groupTaskList([t("long", 240), t("none", null), t("short", 15), t("mid-late", 60, "2026-11-01T04:59:59.999Z"), t("mid", 60)], "estimate")[0].tasks.map((x) => x.id);
  assert.deepEqual(order, ["short", "mid-late", "mid", "long", "none"]);
  assert.ok(rowMod?.TaskCardRow);
  const clock = list.listClock(new Date("2026-11-06T15:00:00Z"));
  const noop = () => {};
  const props = { clock, weekStart: "2026-11-02", open: false, selected: false, busy: false, onOpen: noop, onSelect: noop, onDone: noop, onReopen: noop, onMove: noop };
  const task = { ...t("x", 90), title: "Quick fix", project: null, implementation: null, owner: "brent" };
  assert.match(renderToStaticMarkup(h(rowMod.TaskCardRow, { ...props, task, showEstimate: true })), /<span class="tl-est">1 h 30 min<\/span>/);
  assert.doesNotMatch(renderToStaticMarkup(h(rowMod.TaskCardRow, { ...props, task })), /tl-est/);
  assert.match(read("src/components/backlog/TaskCardList.tsx"), /showEstimate=\{filters\.sort === "estimate"\}/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
