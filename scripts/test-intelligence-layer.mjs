#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const intelligenceModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);

const {
  detectIntelligenceContracts,
  readIntelligenceTaskContexts,
  runIntelligencePhaseOne,
} = intelligenceModule;

class MemoryQueryBuilder {
  constructor(store, tableName) {
    this.store = store;
    this.tableName = tableName;
    this.filters = [];
    this.orders = [];
    this.limitValue = null;
  }

  select() {
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
    const allowed = new Set(values);
    this.filters.push((row) => allowed.has(row[field]));
    return this;
  }

  order(field, options = {}) {
    this.orders.push({ field, ascending: options.ascending !== false, nullsFirst: options.nullsFirst });
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    let rows = [...(this.store.tables[this.tableName] || [])]
      .filter((row) => this.filters.every((filter) => filter(row)))
      .map((row) => ({ ...row }));

    for (const order of this.orders) {
      rows.sort((left, right) => {
        const leftValue = left[order.field];
        const rightValue = right[order.field];
        const leftMissing = leftValue === null || leftValue === undefined;
        const rightMissing = rightValue === null || rightValue === undefined;

        if (leftMissing && rightMissing) {
          return 0;
        }

        if (leftMissing) {
          return order.nullsFirst === false ? 1 : -1;
        }

        if (rightMissing) {
          return order.nullsFirst === false ? -1 : 1;
        }

        if (leftValue === rightValue) {
          return 0;
        }

        const compare = String(leftValue).localeCompare(String(rightValue));
        return order.ascending ? compare : -compare;
      });
    }

    if (this.limitValue !== null) {
      rows = rows.slice(0, this.limitValue);
    }

    return { data: rows, error: null };
  }
}

class MemorySupabase {
  constructor(seed) {
    this.tables = {
      tasks: [],
      implementations: [],
      projects: [],
      sprints: [],
      task_comments: [],
      commitments: [],
      stakeholders: [],
      notes: [],
      note_links: [],
      note_tasks: [],
      note_decisions: [],
      task_dependencies: [],
      ...seed,
    };
  }

  from(tableName) {
    if (!(tableName in this.tables)) {
      throw new Error(`Unknown table: ${tableName}`);
    }

    return new MemoryQueryBuilder(this, tableName);
  }
}

const USER_ID = "user-1";
const NOW_ISO = "2026-03-26T15:00:00.000Z";

function isoDaysAgo(days) {
  return new Date(Date.parse(NOW_ISO) - (days * 24 * 60 * 60 * 1000)).toISOString();
}

function makeTask(id, overrides = {}) {
  return {
    id,
    user_id: USER_ID,
    title: id,
    description: null,
    implementation_id: "impl-1",
    project_id: "proj-1",
    sprint_id: "sprint-1",
    status: "Planned",
    task_type: "Task",
    priority_score: 60,
    estimated_minutes: 60,
    actual_minutes: null,
    recurrence: null,
    estimate_source: "manual",
    due_at: null,
    needs_review: false,
    blocker: false,
    waiting_on: null,
    follow_up_at: null,
    stakeholder_mentions: [],
    tags: [],
    source_type: "manual",
    source_url: null,
    inbox_item_id: null,
    pinned_excerpt: null,
    pinned: false,
    created_at: isoDaysAgo(20),
    updated_at: isoDaysAgo(2),
    ...overrides,
  };
}

function makeNote(id, overrides = {}) {
  return {
    id,
    user_id: USER_ID,
    title: id,
    body_markdown: "",
    note_type: "working_note",
    status: "active",
    pinned: false,
    last_reviewed_at: null,
    created_at: isoDaysAgo(10),
    updated_at: isoDaysAgo(2),
    ...overrides,
  };
}

function makeDecision(id, noteId, summary, overrides = {}) {
  return {
    id,
    user_id: USER_ID,
    note_id: noteId,
    title: id,
    summary,
    decision_status: "active",
    decided_at: isoDaysAgo(2),
    decided_by_stakeholder_id: null,
    created_at: isoDaysAgo(3),
    updated_at: isoDaysAgo(2),
    ...overrides,
  };
}

function makeCommitment(id, taskId, stakeholderId, overrides = {}) {
  return {
    id,
    user_id: USER_ID,
    stakeholder_id: stakeholderId,
    task_id: taskId,
    title: id,
    direction: "theirs",
    status: "Open",
    due_at: null,
    done_at: null,
    notes: null,
    created_at: isoDaysAgo(7),
    updated_at: isoDaysAgo(1),
    ...overrides,
  };
}

const supabase = new MemorySupabase({
  implementations: [
    {
      id: "impl-1",
      user_id: USER_ID,
      name: "Alpha Platform",
      phase: "Build",
      rag: "Yellow",
      portfolio_rank: 1,
    },
  ],
  projects: [
    {
      id: "proj-1",
      user_id: USER_ID,
      implementation_id: "impl-1",
      name: "Quarterly Launch",
      description: null,
      stage: "In Progress",
      rag: "Yellow",
      target_date: null,
      servicenow_spm_id: null,
      status_summary: "",
      portfolio_rank: 1,
      created_at: isoDaysAgo(30),
      updated_at: isoDaysAgo(1),
    },
  ],
  sprints: [
    {
      id: "sprint-1",
      user_id: USER_ID,
      name: "Sprint 1",
      start_date: "2026-03-23",
      end_date: "2026-03-27",
      theme: "Stabilize launch",
      focus_implementation_id: "impl-1",
      created_at: isoDaysAgo(7),
      updated_at: isoDaysAgo(1),
    },
  ],
  stakeholders: [
    {
      id: "stake-1",
      user_id: USER_ID,
      name: "Vendor Team",
      email: null,
      role: null,
      organization: null,
      notes: null,
      context: {},
      created_at: isoDaysAgo(30),
      updated_at: isoDaysAgo(1),
    },
  ],
  tasks: [
    makeTask("task-followup", {
      title: "Vendor signoff on launch plan",
      status: "Blocked/Waiting",
      waiting_on: "Vendor signoff",
      follow_up_at: isoDaysAgo(2),
      updated_at: isoDaysAgo(6),
      due_at: "2026-03-25T14:00:00.000Z",
    }),
    makeTask("task-stale", {
      title: "Draft migration checklist",
      status: "In Progress",
      updated_at: isoDaysAgo(9),
      due_at: "2026-03-29T14:00:00.000Z",
    }),
    makeTask("task-multi", {
      title: "Launch prep",
      status: "In Progress",
      needs_review: true,
      updated_at: isoDaysAgo(10),
      due_at: "2026-03-27T14:00:00.000Z",
    }),
    makeTask("task-clear", {
      title: "Finalize training scope",
      status: "Planned",
      needs_review: true,
      updated_at: isoDaysAgo(4),
    }),
  ],
  task_comments: [
    {
      id: "comment-followup-1",
      user_id: USER_ID,
      task_id: "task-followup",
      content: "Vendor asked for one more redline pass.",
      source: "manual",
      created_at: isoDaysAgo(6),
      updated_at: isoDaysAgo(6),
    },
  ],
  commitments: [
    makeCommitment("commitment-followup", "task-followup", "stake-1", {
      title: "Vendor owes signoff",
      due_at: "2026-03-25T12:00:00.000Z",
    }),
  ],
  task_dependencies: [
    {
      id: "dep-followup",
      user_id: USER_ID,
      task_id: "task-followup",
      depends_on_task_id: null,
      depends_on_commitment_id: "commitment-followup",
      created_at: isoDaysAgo(6),
    },
  ],
  notes: [
    makeNote("note-followup-direct", {
      title: "Vendor thread notes",
      body_markdown: "Need the vendor signature before the launch packet can ship.",
      updated_at: isoDaysAgo(5),
    }),
    makeNote("note-project-context", {
      title: "Launch context",
      body_markdown: "Project-level context for the launch runbook and owner map.",
      updated_at: isoDaysAgo(3),
    }),
    makeNote("note-clear-context", {
      title: "Training scope clarification",
      body_markdown:
        "The training work is only for the pilot cohort. Success means one dry run deck, one facilitator script, and a final attendee list.",
      updated_at: isoDaysAgo(1),
    }),
  ],
  note_tasks: [
    {
      id: "note-task-followup",
      user_id: USER_ID,
      note_id: "note-followup-direct",
      task_id: "task-followup",
      relationship_type: "linked",
      created_at: isoDaysAgo(5),
    },
  ],
  note_links: [
    {
      id: "note-link-project-followup",
      user_id: USER_ID,
      note_id: "note-project-context",
      entity_type: "project",
      entity_id: "proj-1",
      link_role: "reference",
      created_at: isoDaysAgo(3),
    },
    {
      id: "note-link-clear-task",
      user_id: USER_ID,
      note_id: "note-clear-context",
      entity_type: "task",
      entity_id: "task-clear",
      link_role: "related_task",
      created_at: isoDaysAgo(1),
    },
  ],
  note_decisions: [
    makeDecision(
      "decision-clear-1",
      "note-clear-context",
      "The training scope only covers the pilot cohort and should not expand to the full rollout in this pass.",
      { updated_at: isoDaysAgo(1) }
    ),
  ],
});

const contexts = await readIntelligenceTaskContexts(supabase, USER_ID, { now: new Date(NOW_ISO) });
assert.equal(contexts.length, 4);

const followupContext = contexts.find((context) => context.task.id === "task-followup");
assert.ok(followupContext);
assert.deepEqual(
  followupContext.notes.map((note) => note.id),
  ["note-followup-direct", "note-project-context"]
);
assert.deepEqual(followupContext.notes[0].relationReasons, ["note_task:linked"]);
assert.deepEqual(followupContext.notes[1].relationReasons, ["project:reference"]);

const clearContext = contexts.find((context) => context.task.id === "task-clear");
assert.ok(clearContext);
assert.equal(clearContext.notes[0].id, "note-clear-context");
assert.deepEqual(clearContext.notes[0].decisions.map((decision) => decision.id), ["decision-clear-1"]);

const contracts = detectIntelligenceContracts(contexts, { now: new Date(NOW_ISO) });
const contractKeys = new Set(contracts.map((contract) => contract.promotionFamilyKey));

assert.equal(contractKeys.has("follow_up_risk|waiting_on:task-followup:vendor-signoff"), true);
assert.equal(contractKeys.has("blocked_waiting_stale|task:task-followup"), true);
assert.equal(contractKeys.has("stale_task|task:task-stale"), true);
assert.equal(contractKeys.has("stale_task|task:task-multi"), true);
assert.equal(contractKeys.has("ambiguous_task|task:task-multi"), true);
assert.equal(contractKeys.has("ambiguous_task|task:task-clear"), false);

const followUpContract = contracts.find((contract) => contract.promotionFamilyKey === "follow_up_risk|waiting_on:task-followup:vendor-signoff");
assert.ok(followUpContract);
assert.equal(followUpContract.contractType, "follow_up_risk");
assert.equal(followUpContract.subject.waitingOn, "Vendor signoff");
assert.equal(followUpContract.provenance.relatedNoteIds.includes("note-followup-direct"), true);

const multiContracts = contracts.filter((contract) => contract.subject.taskId === "task-multi");
assert.deepEqual(
  multiContracts.map((contract) => contract.contractType).sort(),
  ["ambiguous_task", "stale_task"]
);
assert.notEqual(multiContracts[0].promotionFamilyKey, multiContracts[1].promotionFamilyKey);

const runResult = await runIntelligencePhaseOne(supabase, USER_ID, { now: new Date(NOW_ISO) });
assert.equal(runResult.detectedAt, NOW_ISO);
assert.equal(runResult.taskContexts.length, contexts.length);
assert.equal(runResult.contracts.length, contracts.length);

console.log("Intelligence layer phase 1 tests passed.");
