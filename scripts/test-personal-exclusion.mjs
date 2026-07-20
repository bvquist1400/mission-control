import assert from "node:assert/strict";
const { excludePersonalTasks, hasPersonalTag, isPersonalTaskOrProject } = await import(
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

console.log("personal exclusion checks passed");
