// Tests for the dependency picker's task list (Baseline task 2cf52bf2, "Break
// fixes 1/4", Brent 10/30), offline:
//
// - The task page, the planner and the search window open the task window
//   with only the opened task, so "+ Add dependency" said "No matching tasks
//   available". The picker now loads every open task through GET /api/tasks
//   (paged, Done/Parked/Missed left out by the route's defaults) once per
//   window and offers them with the ones the page passed in.
// - The filters stay: not itself, not already linked, not Done/Parked/Missed,
//   the search; "Loading tasks…" while the list loads.
//
//   npm run test:dependency-picker

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const picker = await import("../src/lib/dependency-picker.ts");

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

const task = (id, title, overrides = {}) => ({ id, title, status: "Planned", priority_score: 50, implementation: null, ...overrides });

// Brent's case: "Complete 015" (EPIC Research Build) should wait on a task with no project.
const COMPLETE_015 = task("t-015", "Complete 015", { project_id: "p-epic", priority_score: 60 });
const SECURITY_CLASS = task("t-sec", "Update the provider research security class", { project_id: null, priority_score: 40 });
const OTHER = task("t-oth", "Draft the readiness summary", { priority_score: 70 });
const LINKED = task("t-lnk", "Already linked", { priority_score: 80 });

/** A fake fetch that serves `rows` from /api/tasks in pages, recording each URL. */
function fakeFetch(rows) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const params = new URL(url, "http://local").searchParams;
    const limit = Number(params.get("limit"));
    const offset = Number(params.get("offset"));
    return { ok: true, json: async () => rows.slice(offset, offset + limit) };
  };
  return { fn, calls };
}

await test("The editor opened with only one task (task page, planner, search) offers the other open tasks once they load", async () => {
  const passedIn = [COMPLETE_015];
  const linkedIds = new Set();
  // Before the load: nothing to offer, and the hint says it is loading, not "No matching tasks".
  const before = picker.dependencyTaskCandidates({ taskId: COMPLETE_015.id, passed: passedIn, loaded: null, linkedIds, search: "" });
  assert.deepEqual(before, []);
  assert.equal(picker.pickerHint("task", { loading: true, failed: false, count: before.length }), "Loading tasks…");

  const { fn, calls } = fakeFetch([COMPLETE_015, SECURITY_CLASS, OTHER]);
  const loaded = await picker.fetchOpenTasksForPicker(fn);
  assert.equal(calls.length, 1, "one request when the first page is short");
  const params = new URL(calls[0].url, "http://local").searchParams;
  assert.equal(new URL(calls[0].url, "http://local").pathname, "/api/tasks");
  assert.equal(params.get("include_done"), null, "Done left out (route default)");
  assert.equal(params.get("include_parked"), null, "Parked left out (route default)");
  assert.equal(params.get("include_missed"), null, "Missed left out (route default)");
  assert.equal(params.get("limit"), "500");
  assert.equal(params.get("offset"), "0");
  assert.equal(calls[0].init.cache, "no-store");

  const after = picker.dependencyTaskCandidates({ taskId: COMPLETE_015.id, passed: passedIn, loaded, linkedIds, search: "" });
  assert.deepEqual(after.map((t) => t.id), ["t-oth", "t-sec"], "the others, highest priority first; never itself");
  assert.equal(picker.pickerHint("task", { loading: false, failed: false, count: after.length }), null);

  const searched = picker.dependencyTaskCandidates({ taskId: COMPLETE_015.id, passed: passedIn, loaded, linkedIds, search: "  security CLASS " });
  assert.deepEqual(searched.map((t) => t.id), ["t-sec"], "Brent's task is found by its title");
});

await test("Existing filters stay: not itself, not already linked, not Done/Parked/Missed (even if the page passed them in); search covers the application name", () => {
  const loaded = [
    COMPLETE_015,
    SECURITY_CLASS,
    LINKED,
    task("t-done", "Done one", { status: "Done" }),
    task("t-park", "Parked one", { status: "Parked" }),
    task("t-miss", "Missed one", { status: "Missed" }),
    task("t-app", "Retest", { implementation: { name: "OnCore" }, priority_score: 10 }),
  ];
  const result = picker.dependencyTaskCandidates({
    taskId: COMPLETE_015.id,
    passed: [task("t-done2", "Done on the page", { status: "Done" })],
    loaded,
    linkedIds: new Set([LINKED.id]),
    search: "",
  });
  assert.deepEqual(result.map((t) => t.id), ["t-sec", "t-app"]);
  const byApp = picker.dependencyTaskCandidates({ taskId: COMPLETE_015.id, passed: [], loaded, linkedIds: new Set(), search: "oncore" });
  assert.deepEqual(byApp.map((t) => t.id), ["t-app"]);
});

await test("A task both passed in and loaded shows once, with the page's copy (it carries edits made on the page)", () => {
  const pageCopy = { ...SECURITY_CLASS, title: "Update the provider research security class (edited)" };
  const result = picker.dependencyTaskCandidates({ taskId: "x", passed: [pageCopy], loaded: [SECURITY_CLASS, OTHER], linkedIds: new Set(), search: "" });
  assert.deepEqual(result.map((t) => t.title), ["Draft the readiness summary", "Update the provider research security class (edited)"]);
  // A task Done on the page isn't brought back by a stale loaded copy.
  const done = picker.dependencyTaskCandidates({ taskId: "x", passed: [{ ...OTHER, status: "Done" }], loaded: [OTHER], linkedIds: new Set(), search: "" });
  assert.deepEqual(done, []);
});

await test("More than one page: the loader keeps paging until a short page", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => task(`t-${i}`, `Task ${i}`));
  const { fn, calls } = fakeFetch(rows);
  const loaded = await picker.fetchOpenTasksForPicker(fn);
  assert.equal(loaded.length, 1001);
  assert.deepEqual(calls.map((c) => new URL(c.url, "http://local").searchParams.get("offset")), ["0", "500", "1000"]);
});

await test("A failed load throws (the picker keeps the page's tasks and says some may be missing)", async () => {
  await assert.rejects(picker.fetchOpenTasksForPicker(async () => ({ ok: false, json: async () => ({}) })));
  await assert.rejects(picker.fetchOpenTasksForPicker(async () => ({ ok: true, json: async () => ({ error: "x" }) })));
  assert.match(picker.pickerHint("task", { loading: false, failed: true, count: 0 }), /Couldn’t load your open tasks/);
  assert.match(picker.pickerHint("task", { loading: false, failed: true, count: 2 }), /some may be missing/);
  assert.equal(picker.pickerHint("task", { loading: false, failed: false, count: 0 }), "No matching tasks available.");
  assert.equal(picker.pickerHint("commitment", { loading: true, failed: false, count: 0 }), "No matching commitments available.", "commitments are unchanged");
});

await test("Wiring: TaskDependencies loads the open tasks once per window, on '+ Add dependency', and uses the shared candidate rules and hint", () => {
  const source = readFileSync(new URL("../src/components/tasks/TaskDependencies.tsx", import.meta.url), "utf8");
  assert.match(source, /from "@\/lib\/dependency-picker"/);
  assert.match(source, /fetchOpenTasksForPicker\(/);
  assert.match(source, /dependencyTaskCandidates\(/);
  assert.match(source, /pickerHint\(/);
  assert.doesNotMatch(source, /No matching \{dependencyType\}s available/, "the old fixed line is gone");
  // Loaded on the Add click (not on every keystroke or render), at most once per window unless a load failed.
  const addAt = source.lastIndexOf("+ Add dependency");
  const addHandler = source.slice(addAt - 600, addAt);
  assert.match(addHandler, /loadOpenTasks\(\)/, "the Add button starts the load");
  assert.match(source, /if \(loadedTasks \|\| loadingRef\.current\) return;/, "no second load while one is running or after one succeeded");
  // Not tied to the search box.
  const searchInput = source.slice(source.indexOf("onChange={(event) => setSearchQuery"), source.indexOf("onChange={(event) => setSearchQuery") + 120);
  assert.doesNotMatch(searchInput, /loadOpenTasks/);
});

await test("No user-facing picker copy names the assistant", () => {
  for (const file of ["src/lib/dependency-picker.ts", "src/components/tasks/TaskDependencies.tsx"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /claude|anthropic/i, file);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
