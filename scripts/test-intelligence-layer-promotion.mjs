#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const promotionModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);

const {
  promoteIntelligenceContracts,
  transitionIntelligenceArtifactStatus,
} = promotionModule;

const NOW_ISO = "2026-03-26T15:00:00.000Z";
const USER_ID = "user-1";

class MemoryIntelligencePromotionStore {
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

function makeEvidence(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    code: `${prefix}_${index + 1}`,
    kind: "task",
    summary: `${prefix} evidence ${index + 1}`,
    relatedId: `${prefix}-${index + 1}`,
    recordedAt: NOW_ISO,
  }));
}

function makeProvenance(taskId) {
  return {
    taskId,
    relatedCommentIds: [`comment-${taskId}`],
    relatedNoteIds: [`note-${taskId}`],
    relatedDecisionIds: [`decision-${taskId}`],
    relatedCommitmentIds: [`commitment-${taskId}`],
    relatedDependencyIds: [`dependency-${taskId}`],
  };
}

function makeStaleTaskContract(taskId, overrides = {}) {
  return {
    contractType: "stale_task",
    canonicalSubjectKey: `task:${taskId}`,
    promotionFamilyKey: `stale_task|task:${taskId}`,
    detectedAt: NOW_ISO,
    summary: `${taskId} looks stale.`,
    reason: `The task has been quiet for 9 days.`,
    severity: "medium",
    confidence: "high",
    subject: {
      taskId,
      taskStatus: "In Progress",
    },
    metrics: {
      daysSinceActivity: 9,
      dueAt: null,
      overdue: false,
    },
    evidence: [
      { code: "active_task_status", kind: "task", summary: "The task is still active but quiet.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "due_recorded", kind: "task", summary: "The task has a recorded due date.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "latest_comment", kind: "comment", summary: "Latest comment is old.", relatedId: `comment-${taskId}`, recordedAt: NOW_ISO },
      { code: "linked_note", kind: "note", summary: "Linked note still reflects stale work.", relatedId: `note-${taskId}`, recordedAt: NOW_ISO },
    ],
    provenance: makeProvenance(taskId),
    ...overrides,
  };
}

function makeAmbiguousTaskContract(taskId, overrides = {}) {
  return {
    contractType: "ambiguous_task",
    canonicalSubjectKey: `task:${taskId}`,
    promotionFamilyKey: `ambiguous_task|task:${taskId}`,
    detectedAt: NOW_ISO,
    summary: `${taskId} still needs clarification before it is safe to trust.`,
    reason: "The task is flagged for review and still lacks enough clarifying context.",
    severity: "medium",
    confidence: "high",
    subject: {
      taskId,
      taskStatus: "Planned",
    },
    metrics: {
      needsReview: true,
      contextSignalsPresent: [],
      dueAt: null,
      dueSoon: false,
      overdue: false,
    },
    evidence: [
      { code: "needs_review_flag", kind: "task", summary: "The task is flagged for review.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "missing_clarifying_context", kind: "task", summary: "No strong clarifying context exists.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "due_recorded", kind: "task", summary: "The task still has a due date on the board.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "linked_note_context", kind: "note", summary: "Thin linked note context exists but does not resolve the ambiguity.", relatedId: `note-${taskId}`, recordedAt: NOW_ISO },
    ],
    provenance: makeProvenance(taskId),
    ...overrides,
  };
}

function makeFollowUpRiskContract(taskId, waitingOn, overrides = {}) {
  return {
    contractType: "follow_up_risk",
    canonicalSubjectKey: `waiting_on:${taskId}:${waitingOn.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    promotionFamilyKey: `follow_up_risk|waiting_on:${taskId}:${waitingOn.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    detectedAt: NOW_ISO,
    summary: `${taskId} needs a follow-up on ${waitingOn}.`,
    reason: `The follow-up date has passed and the task is still waiting on ${waitingOn}.`,
    severity: "medium",
    confidence: "high",
    subject: {
      taskId,
      taskStatus: "Blocked/Waiting",
      waitingOn,
      threadKey: `waiting_on:${taskId}:${waitingOn.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    },
    metrics: {
      followUpAt: NOW_ISO,
      daysSinceActivity: 6,
      hoursOverdue: 12,
    },
    evidence: [
      { code: "waiting_on_target", kind: "task", summary: `The task is explicitly waiting on ${waitingOn}.`, relatedId: taskId, recordedAt: NOW_ISO },
      { code: "follow_up_due", kind: "task", summary: "The follow-up date has passed.", relatedId: taskId, recordedAt: NOW_ISO },
      { code: "open_commitment", kind: "commitment", summary: "There is still an open commitment on the thread.", relatedId: `commitment-${taskId}`, recordedAt: NOW_ISO },
      { code: "latest_comment", kind: "comment", summary: "Recent comment still says no reply.", relatedId: `comment-${taskId}`, recordedAt: NOW_ISO },
    ],
    provenance: makeProvenance(taskId),
    ...overrides,
  };
}

{
  const store = new MemoryIntelligencePromotionStore();
  const stale = makeStaleTaskContract("task-dedupe");

  const first = await promoteIntelligenceContracts(store, USER_ID, [stale], { now: new Date(NOW_ISO) });
  assert.equal(first.artifacts.length, 1);
  assert.equal(store.artifacts.length, 1);
  assert.deepEqual(store.artifacts[0].availableActions, ["accept", "dismiss"]);
  assert.deepEqual(
    store.artifacts[0].artifactEvidence,
    [
      {
        code: "active_task_status",
        kind: "task",
        summary: "The task is still active but quiet.",
        relatedId: "task-dedupe",
        sourceContractType: "stale_task",
      },
      {
        code: "due_recorded",
        kind: "task",
        summary: "The task has a recorded due date.",
        relatedId: "task-dedupe",
        sourceContractType: "stale_task",
      },
      {
        code: "latest_comment",
        kind: "comment",
        summary: "Latest comment is old.",
        relatedId: "comment-task-dedupe",
        sourceContractType: "stale_task",
      },
    ]
  );

  const second = await promoteIntelligenceContracts(store, USER_ID, [stale], { now: new Date(NOW_ISO) });
  assert.equal(store.artifacts.length, 1);
  assert.equal(second.artifacts[0].id, first.artifacts[0].id);
  assert.equal(store.promotionEvents.at(-1).eventType, "noop");
  assert.match(store.promotionEvents.at(-1).suppressionReason, /did not materially change/);
}

{
  const store = new MemoryIntelligencePromotionStore();
  const contracts = [
    makeStaleTaskContract("task-cross"),
    makeAmbiguousTaskContract("task-cross"),
  ];

  await promoteIntelligenceContracts(store, USER_ID, contracts, {
    now: new Date(NOW_ISO),
    enableTaskStalenessClarityGrouping: false,
  });

  assert.equal(store.artifacts.length, 2);
  assert.notEqual(store.artifacts[0].id, store.artifacts[1].id);
}

{
  const store = new MemoryIntelligencePromotionStore();
  const first = makeFollowUpRiskContract("task-followup", "Vendor signoff");
  const initial = await promoteIntelligenceContracts(store, USER_ID, [first], { now: new Date(NOW_ISO) });

  const stronger = makeFollowUpRiskContract("task-followup", "Vendor signoff", {
    summary: "task-followup now needs an urgent follow-up on Vendor signoff.",
    reason: "The waiting thread is now 3 days past follow-up and the due date has slipped.",
    severity: "high",
    metrics: {
      followUpAt: NOW_ISO,
      daysSinceActivity: 8,
      hoursOverdue: 72,
    },
    evidence: makeEvidence("followup_stronger", 4),
  });

  const updated = await promoteIntelligenceContracts(store, USER_ID, [stronger], { now: new Date(NOW_ISO) });
  assert.equal(store.artifacts.length, 1);
  assert.equal(updated.artifacts[0].id, initial.artifacts[0].id);
  assert.equal(store.artifacts[0].summary, "task-followup now needs an urgent follow-up on Vendor signoff.");
  assert.equal(store.promotionEvents.at(-1).eventType, "updated");
}

{
  const store = new MemoryIntelligencePromotionStore();
  const grouped = await promoteIntelligenceContracts(
    store,
    USER_ID,
    [makeStaleTaskContract("task-group"), makeAmbiguousTaskContract("task-group")],
    {
      now: new Date(NOW_ISO),
      enableTaskStalenessClarityGrouping: true,
    }
  );

  assert.equal(store.artifacts.length, 1);
  assert.equal(grouped.artifacts[0].artifactKind, "task_staleness_clarity_group");
  assert.deepEqual(
    store.coverages
      .filter((coverage) => coverage.artifactId === grouped.artifacts[0].id)
      .map((coverage) => coverage.promotionFamilyKey)
      .sort(),
    ["ambiguous_task|task:task-group", "stale_task|task:task-group"]
  );
  assert.deepEqual(
    store.contractLinks
      .filter((link) => link.artifactId === grouped.artifacts[0].id)
      .map((link) => link.contractType)
      .sort(),
    ["ambiguous_task", "stale_task"]
  );

  await promoteIntelligenceContracts(store, USER_ID, [makeAmbiguousTaskContract("task-group")], {
    now: new Date(NOW_ISO),
    enableTaskStalenessClarityGrouping: true,
  });

  assert.equal(store.artifacts.length, 1);
  assert.equal(store.promotionEvents.at(-1).eventType, "grouped_noop");
  assert.match(store.promotionEvents.at(-1).suppressionReason, /grouped artifact/);
}

{
  const store = new MemoryIntelligencePromotionStore();
  const result = await promoteIntelligenceContracts(store, USER_ID, [makeStaleTaskContract("task-status")], {
    now: new Date(NOW_ISO),
  });
  const artifactId = result.artifacts[0].id;

  const accepted = await transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "accepted");
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.availableActions, ["apply", "expire"]);

  await assert.rejects(
    () => transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "dismissed"),
    /Invalid intelligence artifact status transition/
  );

  const applied = await transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "applied");
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.availableActions, []);

  await assert.rejects(
    () => transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "open"),
    /Invalid intelligence artifact status transition/
  );
}

{
  const store = new MemoryIntelligencePromotionStore();
  const first = await promoteIntelligenceContracts(store, USER_ID, [makeFollowUpRiskContract("task-applied", "Vendor")], {
    now: new Date(NOW_ISO),
  });
  const artifactId = first.artifacts[0].id;

  await transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "accepted");
  await transitionIntelligenceArtifactStatus(store, USER_ID, artifactId, "applied");

  const second = await promoteIntelligenceContracts(store, USER_ID, [makeFollowUpRiskContract("task-applied", "Vendor")], {
    now: new Date(NOW_ISO),
  });

  assert.equal(store.artifacts.length, 2);
  assert.notEqual(second.artifacts[0].id, artifactId);
}

console.log("Intelligence layer promotion tests passed.");
