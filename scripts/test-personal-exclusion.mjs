import assert from "node:assert/strict";
const {
  excludePersonalTasks,
  filterTasksByScope,
  hasPersonalTag,
  isPersonalTaskOrProject,
  matchesTaskScope,
  normalizeTaskScope,
  setPersonalTag,
} = await import(
  new URL("../src/lib/personal-exclusion.ts", import.meta.url).href
);

const taskTaggedPersonal = { id: "task-tagged", tags: ["personal"], project: { tags: [] } };
const projectTaggedPersonal = { id: "project-tagged", tags: [], project: { tags: ["personal"] } };
const workTask = { id: "work", tags: ["Personal"], project: { tags: [] } };

assert.equal(hasPersonalTag({ tags: ["personal"] }), true);
assert.equal(hasPersonalTag({ tags: ["Personal"] }), false, "the exclusion is an exact lowercase tag match");
assert.equal(isPersonalTaskOrProject(taskTaggedPersonal), true);
assert.equal(isPersonalTaskOrProject(projectTaggedPersonal), true);
assert.deepEqual(excludePersonalTasks([taskTaggedPersonal, projectTaggedPersonal, workTask]).map((task) => task.id), ["work"]);
assert.deepEqual(filterTasksByScope([taskTaggedPersonal, projectTaggedPersonal, workTask], "personal").map((task) => task.id), [
  "task-tagged",
  "project-tagged",
]);
assert.deepEqual(filterTasksByScope([taskTaggedPersonal, projectTaggedPersonal, workTask], "all").map((task) => task.id), [
  "task-tagged",
  "project-tagged",
  "work",
]);
assert.equal(matchesTaskScope(workTask, "work"), true);
assert.equal(normalizeTaskScope("personal", "work"), "personal");
assert.equal(normalizeTaskScope("unexpected", "work"), "work");
assert.deepEqual(setPersonalTag(["one", "personal", "two"], false), ["one", "two"]);
assert.deepEqual(setPersonalTag(["one"], true), ["one", "personal"]);

console.log("personal exclusion checks passed");
