#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const intelligenceModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);

const {
  describeScheduledIntelligenceCronWindow,
  executeIntelligencePipeline,
} = intelligenceModule;

const USER_ID = "user-1";
const NOW_ISO = "2026-03-26T15:00:00.000Z";

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

  gte(field, value) {
    this.filters.push((row) => String(row[field] ?? "") >= String(value));
    return this;
  }

  not(field, operator, value) {
    if (operator === "is") {
      this.filters.push((row) => row[field] !== value);
    }
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
      task_status_transitions: [],
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

class MemoryPromotionStore {
  constructor() {
    this.contractSnapshots = [];
    this.artifacts = [];
    this.coverages = [];
    this.contractLinks = [];
    this.statusTransitions = [];
    this.promotionEvents = [];
    this.idCounter = 1;
    this.timeCounter = 0;
  }

  nextId(prefix) {
    const id = `${prefix}-${this.idCounter}`;
    this.idCounter += 1;
    return id;
  }

  nextTime() {
    const iso = new Date(Date.parse(NOW_ISO) + (this.timeCounter * 1000)).toISOString();
    this.timeCounter += 1;
    return iso;
  }

  buildBundles(artifacts) {
    return artifacts.map((artifact) => ({
      artifact,
      coverages: this.coverages
        .filter((coverage) => coverage.artifactId === artifact.id)
        .sort((left, right) => {
          if (left.isPrimary !== right.isPrimary) {
            return left.isPrimary ? -1 : 1;
          }

          return left.promotionFamilyKey.localeCompare(right.promotionFamilyKey);
        }),
    }));
  }

  async createContractSnapshot(input) {
    const row = {
      id: this.nextId("contract"),
      createdAt: this.nextTime(),
      ...input,
    };
    this.contractSnapshots.push(row);
    return { ...row };
  }

  async listActiveArtifactsByFamily(userId, promotionFamilyKey) {
    const artifactIds = this.coverages
      .filter((coverage) => coverage.userId === userId && coverage.promotionFamilyKey === promotionFamilyKey)
      .map((coverage) => coverage.artifactId);
    const active = this.artifacts.filter(
      (artifact) =>
        artifact.userId === userId &&
        artifactIds.includes(artifact.id) &&
        (artifact.status === "open" || artifact.status === "accepted")
    );
    return this.buildBundles(active);
  }

  async getLatestUserDismissalTransitionByFamily(userId, promotionFamilyKey) {
    const artifactIds = this.coverages
      .filter((coverage) => coverage.userId === userId && coverage.promotionFamilyKey === promotionFamilyKey)
      .map((coverage) => coverage.artifactId);

    const latest = this.statusTransitions
      .filter(
        (transition) =>
          transition.userId === userId &&
          artifactIds.includes(transition.artifactId) &&
          transition.toStatus === "dismissed" &&
          transition.triggeredBy === "user"
      )
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];

    return latest ? { ...latest } : null;
  }

  async listActiveArtifactsBySubject(userId, subjectKey) {
    const active = this.artifacts.filter(
      (artifact) =>
        artifact.userId === userId &&
        artifact.subjectKey === subjectKey &&
        (artifact.status === "open" || artifact.status === "accepted")
    );
    return this.buildBundles(active);
  }

  async createArtifact(input) {
    const row = {
      id: this.nextId("artifact"),
      createdAt: this.nextTime(),
      updatedAt: this.nextTime(),
      ...input,
    };
    this.artifacts.push(row);
    return { ...row };
  }

  async updateArtifact(userId, artifactId, updates) {
    const artifact = this.artifacts.find((item) => item.id === artifactId && item.userId === userId);
    if (!artifact) {
      throw new Error("Artifact not found");
    }

    Object.assign(artifact, updates, { updatedAt: this.nextTime() });
    return { ...artifact };
  }

  async getArtifactById(userId, artifactId) {
    const artifact = this.artifacts.find((item) => item.id === artifactId && item.userId === userId);
    return artifact ? { ...artifact } : null;
  }

  async upsertArtifactCoverages(userId, artifactId, coverages) {
    const rows = [];

    for (const coverage of coverages) {
      const existing = this.coverages.find(
        (item) => item.userId === userId && item.artifactId === artifactId && item.promotionFamilyKey === coverage.promotionFamilyKey
      );

      if (existing) {
        Object.assign(existing, coverage);
        rows.push({ ...existing });
        continue;
      }

      const row = {
        id: this.nextId("coverage"),
        userId,
        artifactId,
        createdAt: this.nextTime(),
        ...coverage,
      };
      this.coverages.push(row);
      rows.push({ ...row });
    }

    return rows;
  }

  async insertArtifactContractLinks(userId, artifactId, links) {
    const rows = [];

    for (const link of links) {
      const existing = this.contractLinks.find(
        (item) => item.userId === userId && item.artifactId === artifactId && item.contractSnapshotId === link.contractSnapshotId
      );

      if (existing) {
        rows.push({ ...existing });
        continue;
      }

      const row = {
        id: this.nextId("link"),
        userId,
        artifactId,
        createdAt: this.nextTime(),
        ...link,
      };
      this.contractLinks.push(row);
      rows.push({ ...row });
    }

    return rows;
  }

  async insertStatusTransition(input) {
    const row = {
      id: this.nextId("transition"),
      createdAt: this.nextTime(),
      ...input,
    };
    this.statusTransitions.push(row);
    return { ...row };
  }

  async insertPromotionEvent(input) {
    const row = {
      id: this.nextId("event"),
      createdAt: this.nextTime(),
      ...input,
    };
    this.promotionEvents.push(row);
    return { ...row };
  }
}

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
    makeTask("task-unblocked", {
      title: "Resume import dry run",
      status: "In Progress",
      updated_at: isoDaysAgo(1),
      due_at: "2026-03-27T14:00:00.000Z",
    }),
    makeTask("task-resolved-blocker", {
      title: "Deliver blocker handoff",
      status: "Done",
      updated_at: isoDaysAgo(1),
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
      resolved_at: null,
      is_resolved: false,
      created_at: isoDaysAgo(6),
    },
    {
      id: "dep-unblocked",
      user_id: USER_ID,
      task_id: "task-unblocked",
      depends_on_task_id: "task-resolved-blocker",
      depends_on_commitment_id: null,
      resolved_at: isoDaysAgo(1),
      is_resolved: true,
      created_at: isoDaysAgo(8),
    },
  ],
  task_status_transitions: [
    {
      id: "transition-unblocked-entry",
      user_id: USER_ID,
      task_id: "task-unblocked",
      from_status: "Planned",
      to_status: "Blocked/Waiting",
      transitioned_at: isoDaysAgo(8),
      created_at: isoDaysAgo(8),
    },
    {
      id: "transition-unblocked-exit",
      user_id: USER_ID,
      task_id: "task-unblocked",
      from_status: "Blocked/Waiting",
      to_status: "In Progress",
      transitioned_at: isoDaysAgo(1),
      created_at: isoDaysAgo(1),
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

const store = new MemoryPromotionStore();

const springMorningWindow = describeScheduledIntelligenceCronWindow(new Date("2026-03-26T09:00:00.000Z"));
assert.equal(springMorningWindow.shouldRun, true);
assert.equal(springMorningWindow.localDate, "2026-03-26");
assert.equal(springMorningWindow.localTime, "05:00");
assert.equal(springMorningWindow.slotLabel, "05:00");

const springSkippedWindow = describeScheduledIntelligenceCronWindow(new Date("2026-03-26T10:00:00.000Z"));
assert.equal(springSkippedWindow.shouldRun, false);
assert.equal(springSkippedWindow.localTime, "06:00");

const winterMorningWindow = describeScheduledIntelligenceCronWindow(new Date("2026-01-15T10:00:00.000Z"));
assert.equal(winterMorningWindow.shouldRun, true);
assert.equal(winterMorningWindow.localTime, "05:00");
assert.equal(winterMorningWindow.slotLabel, "05:00");

const winterLateWindow = describeScheduledIntelligenceCronWindow(new Date("2026-01-15T16:00:00.000Z"));
assert.equal(winterLateWindow.shouldRun, true);
assert.equal(winterLateWindow.localTime, "11:00");
assert.equal(winterLateWindow.slotLabel, "11:00");

const firstRun = await executeIntelligencePipeline(supabase, store, USER_ID, { now: new Date(NOW_ISO) });
assert.equal(firstRun.taskContextCount, 5);
assert.equal(firstRun.contractCount, 6);
assert.deepEqual(firstRun.contractCounts, {
  follow_up_risk: 1,
  blocked_waiting_stale: 1,
  stale_task: 2,
  ambiguous_task: 1,
  recently_unblocked: 1,
});
assert.equal(firstRun.contractSnapshotCount, 6);
assert.equal(firstRun.touchedArtifactCount, 6);
assert.equal(firstRun.promotionEventCount, 6);
assert.deepEqual(firstRun.promotionEventCounts, {
  created: 6,
  updated: 0,
  noop: 0,
  grouped_created: 0,
  grouped_updated: 0,
  grouped_noop: 0,
});

const secondRun = await executeIntelligencePipeline(supabase, store, USER_ID, { now: new Date(NOW_ISO) });
assert.equal(secondRun.taskContextCount, 5);
assert.equal(secondRun.contractCount, 6);
assert.equal(secondRun.contractSnapshotCount, 6);
assert.equal(secondRun.touchedArtifactCount, 6);
assert.equal(secondRun.promotionEventCount, 6);
assert.deepEqual(secondRun.promotionEventCounts, {
  created: 0,
  updated: 0,
  noop: 6,
  grouped_created: 0,
  grouped_updated: 0,
  grouped_noop: 0,
});
assert.equal(store.artifacts.length, 6);

console.log("Intelligence layer scheduled runner tests passed.");
