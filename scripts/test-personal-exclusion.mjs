import assert from "node:assert/strict";
const {
  HOBBY_TAG,
  excludePersonalCommitments,
  excludePersonalProjectUpdates,
  excludePersonalTasks,
  hasHobbyTag,
  isHobbyTaskOrProject,
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

// The hobby tag: same exact lowercase rule, read from the task or its project.
assert.equal(HOBBY_TAG, "hobby");
assert.equal(hasHobbyTag({ tags: ["personal", "hobby"] }), true);
assert.equal(hasHobbyTag({ tags: ["Hobby"] }), false, "exact lowercase match");
assert.equal(isHobbyTaskOrProject({ tags: ["personal"], project: { tags: ["personal", "hobby"] } }), true, "from the project");
assert.equal(isHobbyTaskOrProject({ tags: ["hobby"], project: { tags: [] } }), true, "from the task");
assert.equal(isHobbyTaskOrProject({ tags: ["personal"], project: { tags: ["personal"] } }), false, "personal alone is not hobby");
assert.equal(isHobbyTaskOrProject({ tags: [], project: null }), false);
assert.equal(isPersonalTaskOrProject({ tags: ["hobby"], project: null }), false, "hobby does not imply personal");

// Commitments and project updates follow their task / project.
assert.deepEqual(
  excludePersonalCommitments([
    { id: "none", task: null },
    { id: "tagged", task: { tags: ["personal"] } },
    { id: "via-project", task: { tags: [], project: [{ tags: ["personal"] }] } },
    { id: "work", task: { tags: [], project: { tags: [] } } },
  ]).map((row) => row.id),
  ["none", "work"]
);
assert.deepEqual(
  excludePersonalProjectUpdates([{ id: "p", project: { tags: ["personal"] } }, { id: "w", project: { tags: [] } }]).map((row) => row.id),
  ["w"]
);

console.log("personal exclusion checks passed");
