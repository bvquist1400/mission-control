#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const notesModule = await import(pathToFileURL(path.join(cwd, "src/lib/notes.ts")).href);

const {
  NotesServiceError,
  archiveNote,
  buildCalendarNoteEntityId,
  createDecisionFromNote,
  createMeetingNote,
  createNote,
  createTaskFromNote,
  getNoteById,
  linkNoteToEntity,
  linkTaskToNote,
  listNotesForEntity,
  updateDecisionStatus,
  updateNote,
} = notesModule;

const TABLES_WITH_UPDATED_AT = new Set([
  "notes",
  "note_decisions",
  "tasks",
  "implementations",
  "projects",
  "stakeholders",
  "commitments",
  "sprints",
  "calendar_events",
]);

class MemoryQueryBuilder {
  constructor(store, tableName) {
    this.store = store;
    this.tableName = tableName;
    this.mode = "select";
    this.filters = [];
    this.orders = [];
    this.rangeStart = null;
    this.rangeEnd = null;
    this.limitValue = null;
    this.payload = null;
    this.returnRows = false;
    this.expectSingle = false;
    this.allowMissing = false;
  }

  select() {
    this.returnRows = true;
    return this;
  }

  insert(payload) {
    this.mode = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(field, value) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  neq(field, value) {
    this.filters.push((row) => row[field] !== value);
    return this;
  }

  in(field, values) {
    const valueSet = new Set(values);
    this.filters.push((row) => valueSet.has(row[field]));
    return this;
  }

  order(field, options = {}) {
    this.orders.push({ field, ascending: options.ascending !== false });
    return this;
  }

  range(start, end) {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  single() {
    this.expectSingle = true;
    this.allowMissing = false;
    return this.execute();
  }

  maybeSingle() {
    this.expectSingle = true;
    this.allowMissing = true;
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    switch (this.mode) {
      case "insert":
        return this.executeInsert();
      case "update":
        return this.executeUpdate();
      case "delete":
        return this.executeDelete();
      default:
        return this.executeSelect();
    }
  }

  executeSelect() {
    const rows = this.applyShape([...this.store.tables[this.tableName]]);
    return this.wrapResult(rows);
  }

  executeInsert() {
    const inserted = this.payload.map((row) => this.store.insertRow(this.tableName, row));
    return this.wrapResult(inserted);
  }

  executeUpdate() {
    const rows = this.store.tables[this.tableName];
    const updated = [];

    for (const row of rows) {
      if (!this.matches(row)) {
        continue;
      }

      Object.assign(row, this.payload);
      this.store.touchUpdatedAt(this.tableName, row);
      updated.push({ ...row });
    }

    return this.wrapResult(updated);
  }

  executeDelete() {
    const rows = this.store.tables[this.tableName];
    const kept = [];
    const removed = [];

    for (const row of rows) {
      if (this.matches(row)) {
        removed.push({ ...row });
      } else {
        kept.push(row);
      }
    }

    this.store.tables[this.tableName] = kept;
    return this.wrapResult(removed);
  }

  matches(row) {
    return this.filters.every((filter) => filter(row));
  }

  applyShape(rows) {
    let shaped = rows.filter((row) => this.matches(row)).map((row) => ({ ...row }));

    for (const order of this.orders) {
      shaped.sort((left, right) => {
        const leftValue = left[order.field];
        const rightValue = right[order.field];
        if (leftValue === rightValue) {
          return 0;
        }
        if (leftValue === undefined || leftValue === null) {
          return order.ascending ? -1 : 1;
        }
        if (rightValue === undefined || rightValue === null) {
          return order.ascending ? 1 : -1;
        }
        const compare = String(leftValue).localeCompare(String(rightValue));
        return order.ascending ? compare : -compare;
      });
    }

    if (this.rangeStart !== null && this.rangeEnd !== null) {
      shaped = shaped.slice(this.rangeStart, this.rangeEnd + 1);
    } else if (this.limitValue !== null) {
      shaped = shaped.slice(0, this.limitValue);
    }

    return shaped;
  }

  wrapResult(rows) {
    if (this.expectSingle) {
      if (rows.length === 0) {
        if (this.allowMissing) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: { code: "PGRST116", message: "Row not found" } });
      }

      if (rows.length > 1) {
        return Promise.resolve({ data: null, error: { code: "PGRST117", message: "Multiple rows returned" } });
      }

      return Promise.resolve({ data: rows[0], error: null });
    }

    return Promise.resolve({ data: rows, error: null });
  }
}

class MemorySupabase {
  constructor(seed = {}) {
    this.tables = {
      notes: [],
      note_links: [],
      note_tasks: [],
      note_decisions: [],
      tasks: [],
      implementations: [],
      projects: [],
      stakeholders: [],
      commitments: [],
      sprints: [],
      calendar_events: [],
      ...seed,
    };
    this.idCounters = new Map();
    this.timeCursor = 0;
  }

  from(tableName) {
    if (!(tableName in this.tables)) {
      throw new Error(`Unknown table: ${tableName}`);
    }

    return new MemoryQueryBuilder(this, tableName);
  }

  nextId(tableName) {
    const next = (this.idCounters.get(tableName) || 0) + 1;
    this.idCounters.set(tableName, next);
    return `${tableName}-${next}`;
  }

  nextTimestamp() {
    const timestamp = new Date(Date.UTC(2026, 2, 25, 13, 0, this.timeCursor)).toISOString();
    this.timeCursor += 1;
    return timestamp;
  }

  touchUpdatedAt(tableName, row) {
    if (TABLES_WITH_UPDATED_AT.has(tableName)) {
      row.updated_at = this.nextTimestamp();
    }
  }

  insertRow(tableName, payload) {
    const row = { ...payload };
    if (!row.id) {
      row.id = this.nextId(tableName);
    }
    if (!row.created_at) {
      row.created_at = this.nextTimestamp();
    }
    if (TABLES_WITH_UPDATED_AT.has(tableName) && !row.updated_at) {
      row.updated_at = row.created_at;
    }
    if (tableName === "notes") {
      row.body_markdown ??= "";
      row.status ??= "active";
      row.pinned ??= false;
      row.last_reviewed_at ??= null;
    }
    if (tableName === "note_links") {
      const duplicate = this.tables.note_links.find((candidate) =>
        candidate.note_id === row.note_id
        && candidate.entity_type === row.entity_type
        && candidate.entity_id === row.entity_id
        && candidate.link_role === row.link_role
      );
      if (duplicate) {
        throw new Error("Duplicate note link inserted into memory store");
      }
    }
    if (tableName === "note_tasks") {
      const duplicate = this.tables.note_tasks.find((candidate) =>
        candidate.note_id === row.note_id
        && candidate.task_id === row.task_id
        && candidate.relationship_type === row.relationship_type
      );
      if (duplicate) {
        throw new Error("Duplicate note task inserted into memory store");
      }
    }
    this.tables[tableName].push(row);
    return { ...row };
  }
}

function createFixtureSupabase() {
  const supabase = new MemorySupabase();
  const seedRows = [
    ["implementations", { id: "impl-1", user_id: "user-1", name: "Alpha Platform", phase: "Build", rag: "Yellow" }],
    ["implementations", { id: "impl-2", user_id: "user-2", name: "Other App", phase: "Build", rag: "Green" }],
    ["projects", { id: "proj-1", user_id: "user-1", implementation_id: "impl-1", name: "Cutover", stage: "In Progress", rag: "Yellow" }],
    ["projects", { id: "proj-2", user_id: "user-2", implementation_id: "impl-2", name: "Other Project", stage: "Planned", rag: "Green" }],
    ["stakeholders", { id: "stake-1", user_id: "user-1", name: "Casey" }],
    ["stakeholders", { id: "stake-2", user_id: "user-2", name: "Dana" }],
    ["commitments", { id: "commit-1", user_id: "user-1", stakeholder_id: "stake-1", title: "Send decision", direction: "ours", status: "Open" }],
    ["sprints", { id: "sprint-1", user_id: "user-1", name: "Sprint 14", start_date: "2026-03-23", end_date: "2026-03-27", theme: "Cutover", focus_implementation_id: "impl-1" }],
    ["tasks", {
      id: "task-1",
      user_id: "user-1",
      title: "Review migration runbook",
      description: null,
      implementation_id: "impl-1",
      project_id: "proj-1",
      sprint_id: "sprint-1",
      status: "Planned",
      task_type: "Task",
      priority_score: 70,
      estimated_minutes: 45,
      estimate_source: "manual",
      due_at: null,
      needs_review: false,
      blocker: false,
      waiting_on: null,
      stakeholder_mentions: [],
      tags: [],
      source_type: "Manual",
      source_url: null,
      pinned_excerpt: null,
    }],
    ["tasks", {
      id: "task-2",
      user_id: "user-2",
      title: "Other user task",
      description: null,
      implementation_id: "impl-2",
      project_id: "proj-2",
      sprint_id: null,
      status: "Backlog",
      task_type: "Task",
      priority_score: 50,
      estimated_minutes: 30,
      estimate_source: "manual",
      due_at: null,
      needs_review: false,
      blocker: false,
      waiting_on: null,
      stakeholder_mentions: [],
      tags: [],
      source_type: "Manual",
      source_url: null,
      pinned_excerpt: null,
    }],
    ["calendar_events", {
      id: "cal-1",
      user_id: "user-1",
      source: "graph",
      external_event_id: "graph-event-1",
      start_at: "2026-03-25T15:00:00.000Z",
      end_at: "2026-03-25T15:30:00.000Z",
      title: "Cutover Steering",
    }],
    ["calendar_events", {
      id: "cal-2",
      user_id: "user-2",
      source: "graph",
      external_event_id: "graph-event-2",
      start_at: "2026-03-25T16:00:00.000Z",
      end_at: "2026-03-25T16:30:00.000Z",
      title: "Other Meeting",
    }],
  ];

  for (const [tableName, row] of seedRows) {
    supabase.insertRow(tableName, row);
  }

  return supabase;
}

async function expectNotesError(promise, status, code) {
  try {
    await promise;
    assert.fail(`Expected NotesServiceError ${code}`);
  } catch (error) {
    assert.equal(error instanceof NotesServiceError, true);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }
}

const supabase = createFixtureSupabase();

const created = await createNote(supabase, "user-1", {
  title: "Launch note",
  body_markdown: "Initial body",
  note_type: "working_note",
});
assert.equal(created.title, "Launch note");
assert.equal(created.status, "active");
assert.equal(created.links.length, 0);
assert.equal(created.task_links.length, 0);
assert.equal(created.decisions.length, 0);

const updated = await updateNote(supabase, "user-1", created.id, {
  body_markdown: "Updated body",
  pinned: true,
  last_reviewed_at: "2026-03-25T14:00:00.000Z",
});
assert.equal(updated.body_markdown, "Updated body");
assert.equal(updated.pinned, true);
assert.equal(updated.last_reviewed_at, "2026-03-25T14:00:00.000Z");
assert.notEqual(updated.updated_at, created.updated_at, "updateNote should advance updated_at");

const pinnedOnly = await updateNote(supabase, "user-1", created.id, {
  title: undefined,
  body_markdown: undefined,
  note_type: undefined,
  status: undefined,
  pinned: false,
  last_reviewed_at: undefined,
});
assert.equal(pinnedOnly.title, "Launch note");
assert.equal(pinnedOnly.pinned, false);
assert.equal(pinnedOnly.body_markdown, "Updated body");

const archived = await archiveNote(supabase, "user-1", created.id);
assert.equal(archived.status, "archived");
assert.notEqual(archived.updated_at, updated.updated_at, "archiveNote should advance updated_at");

const linkedNote = await createNote(supabase, "user-1", {
  title: "Context note",
  note_type: "working_note",
});

const implementationLink = await linkNoteToEntity(supabase, "user-1", linkedNote.id, {
  entity_type: "implementation",
  entity_id: "impl-1",
  link_role: "primary_context",
});
assert.equal(implementationLink.entity_type, "implementation");
assert.equal(implementationLink.entity_id, "impl-1");

const projectLink = await linkNoteToEntity(supabase, "user-1", linkedNote.id, {
  entity_type: "project",
  entity_id: "proj-1",
  link_role: "reference",
});
assert.equal(projectLink.entity_type, "project");

const taskEntityLink = await linkNoteToEntity(supabase, "user-1", linkedNote.id, {
  entity_type: "task",
  entity_id: "task-1",
  link_role: "related_task",
});
assert.equal(taskEntityLink.entity_type, "task");

const calendarEntityId = buildCalendarNoteEntityId({
  source: "graph",
  externalEventId: "graph-event-1",
  startAt: "2026-03-25T15:00:00.000Z",
});
const calendarLink = await linkNoteToEntity(supabase, "user-1", linkedNote.id, {
  entity_type: "calendar_event",
  entity_id: calendarEntityId,
  link_role: "meeting_for",
});
assert.equal(calendarLink.entity_id, calendarEntityId);

const notesForEvent = await listNotesForEntity(supabase, "user-1", "calendar_event", calendarEntityId);
assert.equal(notesForEvent.some((note) => note.id === linkedNote.id), true);

await expectNotesError(
  linkNoteToEntity(supabase, "user-1", linkedNote.id, {
    entity_type: "calendar_event",
    entity_id: calendarEntityId,
    link_role: "meeting_for",
  }),
  409,
  "duplicate_note_link"
);

const taskCreation = await createTaskFromNote(supabase, "user-1", linkedNote.id, {
  title: "Follow up vendor decision",
  implementation_id: "impl-1",
  project_id: "proj-1",
  sprint_id: "sprint-1",
  relationship_type: "created_from",
  estimated_minutes: 25,
});
assert.equal(taskCreation.task.title, "Follow up vendor decision");
assert.equal(taskCreation.task_link.relationship_type, "created_from");
assert.equal(taskCreation.task_link.task?.title, "Follow up vendor decision");

const linkedTask = await linkTaskToNote(supabase, "user-1", linkedNote.id, {
  task_id: "task-1",
  relationship_type: "linked",
});
assert.equal(linkedTask.task_id, "task-1");
assert.equal(linkedTask.relationship_type, "linked");
assert.equal(linkedTask.task?.title, "Review migration runbook");

const decision = await createDecisionFromNote(supabase, "user-1", linkedNote.id, {
  title: "Use staged rollout",
  summary: "Reduce cutover risk by splitting deployment windows.",
  decided_by_stakeholder_id: "stake-1",
});
assert.equal(decision.decision_status, "active");
assert.equal(decision.decided_by_stakeholder_id, "stake-1");

const updatedDecision = await updateDecisionStatus(supabase, "user-1", decision.id, {
  decision_status: "superseded",
  decided_at: "2026-03-25T17:00:00.000Z",
  decided_by_stakeholder_id: "stake-1",
});
assert.equal(updatedDecision.decision_status, "superseded");
assert.equal(updatedDecision.decided_at, "2026-03-25T17:00:00.000Z");
assert.notEqual(updatedDecision.updated_at, decision.updated_at, "decision updates should advance updated_at");

await expectNotesError(
  linkNoteToEntity(supabase, "user-1", linkedNote.id, {
    entity_type: "implementation",
    entity_id: "missing-implementation",
    link_role: "reference",
  }),
  400,
  "invalid_entity"
);

await expectNotesError(
  linkNoteToEntity(supabase, "user-1", linkedNote.id, {
    entity_type: "calendar_event",
    entity_id: "graph::bad-format",
    link_role: "meeting_for",
  }),
  400,
  "invalid_calendar_entity_id"
);

await expectNotesError(getNoteById(supabase, "user-2", linkedNote.id), 404, "note_not_found");
await expectNotesError(
  linkTaskToNote(supabase, "user-1", linkedNote.id, {
    task_id: "task-2",
    relationship_type: "linked",
  }),
  400,
  "invalid_task"
);

const meetingNote = await createMeetingNote(supabase, "user-1", {
  calendar_event: {
    source: "graph",
    external_event_id: "graph-event-1",
    start_at: "2026-03-25T15:00:00.000Z",
  },
  implementation_id: "impl-1",
  project_id: "proj-1",
});
assert.equal(meetingNote.note_type, "meeting_note");
assert.equal(meetingNote.links.some((link) => link.entity_type === "calendar_event" && link.link_role === "primary_context"), true);
assert.equal(meetingNote.links.some((link) => link.entity_type === "implementation" && link.link_role === "meeting_for"), true);
assert.equal(meetingNote.links.some((link) => link.entity_type === "project" && link.link_role === "meeting_for"), true);

const allProjectNotes = await listNotesForEntity(supabase, "user-1", "project", "proj-1");
const meetingProjectNotes = await listNotesForEntity(supabase, "user-1", "project", "proj-1", "meeting_for");
assert.equal(allProjectNotes.some((note) => note.id === linkedNote.id), true);
assert.equal(allProjectNotes.some((note) => note.id === meetingNote.id), true);
assert.equal(meetingProjectNotes.some((note) => note.id === meetingNote.id), true);
assert.equal(meetingProjectNotes.some((note) => note.id === linkedNote.id), false);

const migrationSql = fs.readFileSync(path.join(cwd, "supabase/migrations/032_add_notes.sql"), "utf8");
assert.equal(/DROP TRIGGER IF EXISTS trg_notes_updated ON notes;/i.test(migrationSql), true);
assert.equal(/DROP TRIGGER IF EXISTS trg_note_decisions_updated ON note_decisions;/i.test(migrationSql), true);
assert.equal(/CREATE TRIGGER trg_notes_updated/i.test(migrationSql), true);
assert.equal(/CREATE TRIGGER trg_note_decisions_updated/i.test(migrationSql), true);
assert.equal(/EXECUTE FUNCTION set_updated_at\(\)/i.test(migrationSql), true);

console.log("Notes tests passed");
