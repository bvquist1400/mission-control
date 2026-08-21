#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/lib/task-external-source.ts")).href;
const {
  buildTaskExternalSourceBackfillPlan,
  externalSourceConflictPayload,
  formatExternalSourceLookup,
  isTaskExternalSourceUniqueViolation,
  normalizeExternalSourceId,
} = await import(moduleUrl);

assert.equal(normalizeExternalSourceId(" 40474495 "), "40474495");
assert.equal(normalizeExternalSourceId(40474495), "40474495");
assert.equal(normalizeExternalSourceId("SN-123"), "SN-123");
assert.equal(normalizeExternalSourceId(Number.NaN), null);

assert.equal(
  isTaskExternalSourceUniqueViolation({
    code: "23505",
    message: 'duplicate key value violates unique constraint "uq_tasks_user_external_source_id"',
  }),
  true
);
assert.deepEqual(
  externalSourceConflictPayload({
    external_source_system: "taskadvisor",
    external_source_id: "40474495",
    task: { id: "task-existing", title: "Existing task" },
  }),
  {
    error: "External source identity is already assigned to another task",
    code: "external_source_conflict",
    external_source_system: "taskadvisor",
    external_source_id: "40474495",
    conflicting_task: { id: "task-existing", title: "Existing task" },
  }
);

assert.deepEqual(
  formatExternalSourceLookup(
    ["40474495", "missing", "40474495"],
    [{
      external_source_id: "40474495",
      id: "task-1",
      title: "Matched task",
      status: "In Progress",
      waiting_on: null,
      section_id: "section-1",
      tags: ["csv-40474495"],
    }]
  ),
  {
    matched: [{
      external_source_id: "40474495",
      task_id: "task-1",
      title: "Matched task",
      status: "In Progress",
      waiting_on: null,
      section_id: "section-1",
      tags: ["csv-40474495"],
    }],
    unmatched: ["missing"],
  }
);

const sourceTasks = [
  {
    id: "task-url",
    user_id: "user-1",
    title: "From URL",
    source_url: "https://orion.epic.com/project/12392/task/40474495",
    tags: [],
    external_source_system: null,
    external_source_id: null,
  },
  {
    id: "task-tag",
    user_id: "user-1",
    title: "From tag",
    source_url: null,
    tags: ["csv-40474507"],
    external_source_system: null,
    external_source_id: null,
  },
];

const firstPlan = buildTaskExternalSourceBackfillPlan(sourceTasks);
assert.equal(firstPlan.updates.length, 2);
assert.equal(firstPlan.conflicts.length, 0);

const priorityPlan = buildTaskExternalSourceBackfillPlan([{
  ...sourceTasks[0],
  tags: ["csv-99999999"],
}]);
assert.equal(priorityPlan.updates[0].external_source_id, "40474495", "source_url must win over csv tag");
assert.equal(priorityPlan.updates[0].evidence, "source_url");

const tasksAfterFirstRun = sourceTasks.map((task) => {
  const update = firstPlan.updates.find((candidate) => candidate.task_id === task.id);
  return update ? {
    ...task,
    external_source_system: update.external_source_system,
    external_source_id: update.external_source_id,
  } : task;
});
const secondPlan = buildTaskExternalSourceBackfillPlan(tasksAfterFirstRun);
assert.equal(secondPlan.updates.length, 0, "second backfill run must be idempotent");

const conflictPlan = buildTaskExternalSourceBackfillPlan([
  sourceTasks[0],
  { ...sourceTasks[0], id: "task-duplicate", title: "From URL." },
]);
assert.equal(conflictPlan.conflicts.length, 1);
assert.equal(conflictPlan.conflicts[0].tasks.length, 2);

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/054_add_task_external_source_identity.sql"),
  "utf8"
);
assert.match(
  migration,
  /CREATE UNIQUE INDEX uq_tasks_user_external_source_id[\s\S]*WHERE external_source_id IS NOT NULL/,
  "migration must enforce partial uniqueness for external source identities"
);

const taskRoute = fs.readFileSync(path.join(process.cwd(), "src/app/api/tasks/route.ts"), "utf8");
assert.match(
  taskRoute,
  /isTaskExternalSourceUniqueViolation\(error\)[\s\S]*externalSourceConflictPayload/,
  "create_task must translate a database uniqueness race into a structured conflict"
);

const mcpUpstreamRoute = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/mcp-upstream/[...path]/route.ts"),
  "utf8"
);
assert.ok(
  mcpUpstreamRoute.includes("import * as taskExternalLookupRoute from '@/app/api/tasks/lookup-external/route';")
);
assert.ok(
  mcpUpstreamRoute.includes("invokeStatic(taskExternalLookupRoute.POST, requestWithContext)")
);
assert.match(
  mcpUpstreamRoute,
  /normalizedMethod === 'POST'[\s\S]*pathSegments\[1\] === 'lookup-external'[\s\S]*return \['mcp\.read'\]/,
  "batch lookup must require read scope even though its request body uses POST"
);

console.log("task external source tests passed");
