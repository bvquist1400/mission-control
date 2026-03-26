#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const moduleRef = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);
const {
  executeAcceptedReminderArtifactsForUser,
} = moduleRef;

const NOW_ISO = "2026-03-26T15:00:00.000Z";
const USER_ID = "user-1";

class MemoryPromotionStore {
  constructor(artifacts = []) {
    this.artifacts = artifacts.map((artifact) => ({ ...artifact }));
    this.statusTransitions = [];
    this.idCounter = 1;
  }

  nextId(prefix) {
    const id = `${prefix}-${this.idCounter}`;
    this.idCounter += 1;
    return id;
  }

  async getArtifactById(userId, artifactId) {
    const artifact = this.artifacts.find((item) => item.userId === userId && item.id === artifactId);
    return artifact ? { ...artifact } : null;
  }

  async updateArtifact(userId, artifactId, updates) {
    const artifact = this.artifacts.find((item) => item.userId === userId && item.id === artifactId);
    if (!artifact) {
      throw new Error("Artifact not found");
    }

    Object.assign(artifact, updates, { updatedAt: NOW_ISO });
    return { ...artifact };
  }

  async insertStatusTransition(input) {
    const row = {
      id: this.nextId("transition"),
      createdAt: NOW_ISO,
      ...input,
    };
    this.statusTransitions.push(row);
    return { ...row };
  }
}

class MemoryReminderStore {
  constructor(artifacts = []) {
    this.artifacts = artifacts.map((artifact) => ({ ...artifact }));
    this.executions = [];
    this.comments = [];
    this.idCounter = 1;
  }

  nextId(prefix) {
    const id = `${prefix}-${this.idCounter}`;
    this.idCounter += 1;
    return id;
  }

  async listAcceptedReminderArtifacts(userId, limit = 25) {
    return this.artifacts
      .filter(
        (artifact) =>
          artifact.userId === userId &&
          artifact.status === "accepted" &&
          artifact.artifactKind === "single_contract" &&
          artifact.primaryContractType === "follow_up_risk"
      )
      .slice(0, limit)
      .map((artifact) => ({ ...artifact }));
  }

  async getReminderExecution(userId, artifactId, executionKind) {
    const execution = this.executions.find(
      (item) =>
        item.userId === userId &&
        item.artifactId === artifactId &&
        item.executionKind === executionKind
    );
    return execution ? { ...execution } : null;
  }

  async claimReminderExecution(input) {
    const existing = this.executions.find(
      (item) =>
        item.userId === input.userId &&
        item.artifactId === input.artifactId &&
        item.executionKind === input.executionKind
    );

    if (existing) {
      return { ...existing };
    }

    const row = {
      id: this.nextId("execution"),
      userId: input.userId,
      artifactId: input.artifactId,
      executionKind: input.executionKind,
      status: "started",
      taskId: input.taskId,
      taskCommentId: null,
      payload: input.payload,
      startedAt: input.nowIso,
      completedAt: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.executions.push(row);
    return { ...row };
  }

  async completeReminderExecution(userId, executionId, updates) {
    const execution = this.executions.find((item) => item.userId === userId && item.id === executionId);
    if (!execution) {
      throw new Error("Execution not found");
    }

    Object.assign(execution, {
      status: "completed",
      taskCommentId: updates.taskCommentId,
      payload: updates.payload,
      completedAt: updates.nowIso,
      updatedAt: updates.nowIso,
    });
    return { ...execution };
  }

  async createSystemTaskComment(input) {
    const row = {
      id: this.nextId("comment"),
      userId: input.userId,
      taskId: input.taskId,
      content: input.content,
      source: "system",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    this.comments.push(row);
    return { ...row };
  }
}

function makeArtifact(overrides = {}) {
  return {
    id: "artifact-1",
    userId: USER_ID,
    artifactKind: "single_contract",
    groupingKey: null,
    subjectKey: "task:task-1",
    primaryContractType: "follow_up_risk",
    status: "accepted",
    summary: "Follow up with Vendor signoff.",
    reason: "The task is still waiting on Vendor signoff and has gone quiet.",
    severity: "high",
    confidence: "medium",
    availableActions: ["apply", "expire"],
    artifactEvidence: [],
    reviewPayload: {
      coveredFamilies: ["follow_up_risk|waiting_on:task-1:vendor-signoff"],
    },
    contentHash: "hash-1",
    lastEvaluatedAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

{
  const artifact = makeArtifact();
  const promotionStore = new MemoryPromotionStore([artifact]);
  const reminderStore = new MemoryReminderStore([artifact]);

  const result = await executeAcceptedReminderArtifactsForUser(
    reminderStore,
    promotionStore,
    USER_ID,
    { now: new Date(NOW_ISO) }
  );

  assert.equal(result.inspectedArtifacts.length, 1);
  assert.equal(result.comments.length, 1);
  assert.equal(result.executions.length, 1);
  assert.deepEqual(result.appliedArtifactIds, ["artifact-1"]);
  assert.equal(result.errors.length, 0);
  assert.match(result.comments[0].content, /\[Mission Control reminder\]/);
  assert.match(result.comments[0].content, /Follow up with Vendor signoff\./);
  assert.equal(promotionStore.artifacts[0].status, "applied");
  assert.equal(reminderStore.executions[0].status, "completed");
  assert.equal(reminderStore.executions[0].taskCommentId, result.comments[0].id);
  assert.equal(promotionStore.statusTransitions.at(-1).toStatus, "applied");
  assert.equal(promotionStore.statusTransitions.at(-1).triggeredBy, "system");
  assert.equal(promotionStore.statusTransitions.at(-1).payload.outputKind, "task_comment");
}

{
  const artifact = makeArtifact({ id: "artifact-2", subjectKey: "task:task-2" });
  const promotionStore = new MemoryPromotionStore([artifact]);
  const reminderStore = new MemoryReminderStore([artifact]);
  const existingComment = await reminderStore.createSystemTaskComment({
    userId: USER_ID,
    taskId: "task-2",
    content: "Existing reminder comment",
  });
  const claimed = await reminderStore.claimReminderExecution({
    userId: USER_ID,
    artifactId: "artifact-2",
    executionKind: "task_comment_reminder",
    taskId: "task-2",
    payload: { outputKind: "task_comment" },
    nowIso: NOW_ISO,
  });
  await reminderStore.completeReminderExecution(USER_ID, claimed.id, {
    taskCommentId: existingComment.id,
    payload: { outputKind: "task_comment", taskCommentId: existingComment.id },
    nowIso: NOW_ISO,
  });

  const result = await executeAcceptedReminderArtifactsForUser(
    reminderStore,
    promotionStore,
    USER_ID,
    { now: new Date(NOW_ISO) }
  );

  assert.equal(result.comments.length, 0);
  assert.deepEqual(result.appliedArtifactIds, ["artifact-2"]);
  assert.equal(promotionStore.artifacts[0].status, "applied");
  assert.equal(reminderStore.comments.length, 1);
}

{
  const followUp = makeArtifact({ id: "artifact-3", subjectKey: "task:task-3" });
  const stale = makeArtifact({
    id: "artifact-4",
    primaryContractType: "stale_task",
    subjectKey: "task:task-4",
    summary: "Task 4 looks stale.",
  });
  const promotionStore = new MemoryPromotionStore([followUp, stale]);
  const reminderStore = new MemoryReminderStore([followUp, stale]);

  const result = await executeAcceptedReminderArtifactsForUser(
    reminderStore,
    promotionStore,
    USER_ID,
    { now: new Date(NOW_ISO) }
  );

  assert.deepEqual(result.appliedArtifactIds, ["artifact-3"]);
  assert.equal(promotionStore.artifacts.find((artifact) => artifact.id === "artifact-4").status, "accepted");
  assert.equal(reminderStore.comments.length, 1);
}

console.log("Intelligence layer reminder tests passed.");
