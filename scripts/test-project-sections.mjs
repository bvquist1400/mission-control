#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const projectSectionsModule = await import(pathToFileURL(path.join(cwd, "src/lib/project-sections.ts")).href);

const {
  ProjectSectionServiceError,
  buildProjectSectionsBackfillPlan,
  groupTasksByProjectSections,
  normalizeProjectSectionIdentity,
  normalizeProjectSectionSortOrder,
  parseBracketedProjectSectionTaskTitle,
  resolveTaskProjectSectionState,
} = projectSectionsModule;

assert.equal(normalizeProjectSectionIdentity("  Backlog  "), "backlog");
assert.equal(normalizeProjectSectionSortOrder(undefined), null);
assert.equal(normalizeProjectSectionSortOrder(2.8), 3);
assert.throws(
  () => normalizeProjectSectionSortOrder(null),
  (error) => error instanceof ProjectSectionServiceError && error.code === "invalid_sort_order"
);

assert.deepEqual(
  resolveTaskProjectSectionState({
    current_project_id: "project-a",
    current_section_id: "section-a",
    has_project_input: true,
    project_id_input: "project-b",
    has_section_input: false,
    section_id_input: null,
  }),
  {
    project_id: "project-b",
    section_id: null,
  }
);

assert.deepEqual(
  resolveTaskProjectSectionState({
    current_project_id: "project-a",
    current_section_id: "section-a",
    has_project_input: true,
    project_id_input: "project-b",
    has_section_input: true,
    section_id_input: "section-b",
  }),
  {
    project_id: "project-b",
    section_id: "section-b",
  }
);

assert.deepEqual(
  parseBracketedProjectSectionTaskTitle("[Build] - Ship feature"),
  {
    section_name: "Build",
    task_title: "Ship feature",
  }
);

const grouped = groupTasksByProjectSections(
  [
    {
      id: "task-1",
      title: "Discovery thread",
      project_id: "project-a",
      project_name: "Alpha",
      section_id: "section-discovery",
      section_name: "Discovery",
    },
    {
      id: "task-2",
      title: "Unsectioned alpha",
      project_id: "project-a",
      project_name: "Alpha",
      section_id: null,
      section_name: null,
    },
    {
      id: "task-3",
      title: "Plain beta task",
      project_id: "project-b",
      project_name: "Beta",
      section_id: null,
      section_name: null,
    },
    {
      id: "task-4",
      title: "Inbox task",
      project_id: null,
      project_name: null,
      section_id: null,
      section_name: null,
    },
  ],
  [
    {
      id: "section-discovery",
      user_id: "user-1",
      project_id: "project-a",
      name: "Discovery",
      sort_order: 0,
      created_at: "2026-03-25T10:00:00.000Z",
      updated_at: "2026-03-25T10:00:00.000Z",
    },
    {
      id: "section-build",
      user_id: "user-1",
      project_id: "project-a",
      name: "Build",
      sort_order: 1,
      created_at: "2026-03-25T11:00:00.000Z",
      updated_at: "2026-03-25T11:00:00.000Z",
    },
  ]
);

assert.equal(grouped.grouped_projects.length, 2);
assert.equal(grouped.grouped_projects[0].project_name, "Alpha");
assert.equal(grouped.grouped_projects[0].has_sections, true);
assert.deepEqual(
  grouped.grouped_projects[0].groups.map((group) => group.section_name),
  ["Discovery", null]
);
assert.equal(grouped.grouped_projects[1].project_name, "Beta");
assert.equal(grouped.grouped_projects[1].has_sections, false);
assert.equal(grouped.unassigned_tasks.length, 1);

const backfillPlan = buildProjectSectionsBackfillPlan({
  tasks: [
    {
      id: "task-10",
      user_id: "user-1",
      project_id: "project-a",
      title: "[Discovery] - Capture gaps",
    },
    {
      id: "task-11",
      user_id: "user-1",
      project_id: "project-a",
      title: "[Build] - Ship v1",
    },
    {
      id: "task-12",
      user_id: "user-1",
      project_id: "project-a",
      title: "[build] - Harden edge cases",
    },
    {
      id: "task-13",
      user_id: "user-1",
      project_id: null,
      title: "[Ops] - No project yet",
    },
    {
      id: "task-14",
      user_id: "user-1",
      project_id: "project-b",
      title: "[Ops] -    ",
    },
  ],
  existing_sections: [
    {
      id: "existing-discovery",
      user_id: "user-1",
      project_id: "project-a",
      name: "Discovery",
      sort_order: 4,
      created_at: "2026-03-20T09:00:00.000Z",
      updated_at: "2026-03-20T09:00:00.000Z",
    },
  ],
});

assert.equal(backfillPlan.preview_rows.length, 3);
assert.equal(backfillPlan.sections_to_create.length, 1);
assert.deepEqual(backfillPlan.sections_to_create[0], {
  user_id: "user-1",
  project_id: "project-a",
  name: "Build",
  sort_order: 5,
  identity: "build",
});
assert.equal(backfillPlan.skipped_no_project.length, 1);
assert.equal(backfillPlan.skipped_empty_title.length, 1);

console.log("project sections tests passed");
