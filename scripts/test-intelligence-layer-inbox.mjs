#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const inboxModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/inbox.ts")).href);

const { buildIntelligenceArtifactInboxPayload } = inboxModule;

const taskById = new Map([
  ["task-1", { id: "task-1", title: "Vendor follow-up", status: "Blocked/Waiting" }],
  ["task-2", { id: "task-2", title: "Clarify rollout steps", status: "In Progress" }],
]);

const latestTransitionByArtifactId = new Map([
  ["artifact-accepted", {
    id: "transition-accepted",
    from_status: "open",
    to_status: "accepted",
    triggered_by: "user",
    note: "Accepted from the artifact inbox.",
    created_at: "2026-03-26T14:00:00.000Z",
  }],
  ["artifact-applied", {
    id: "transition-applied",
    from_status: "accepted",
    to_status: "applied",
    triggered_by: "system",
    note: "Applied accepted reminder as a system task comment.",
    created_at: "2026-03-26T15:00:00.000Z",
  }],
]);

const payload = buildIntelligenceArtifactInboxPayload(
  {
    open: [
      {
        id: "artifact-low",
        artifact_kind: "single_contract",
        subject_key: "task:task-2",
        primary_contract_type: "ambiguous_task",
        status: "open",
        summary: "Clarify rollout steps before execution.",
        reason: "The task still lacks durable clarifying context.",
        severity: "low",
        confidence: "high",
        available_actions: ["accept", "dismiss"],
        artifact_evidence: [],
        created_at: "2026-03-26T12:00:00.000Z",
        updated_at: "2026-03-26T12:30:00.000Z",
        last_evaluated_at: "2026-03-26T12:30:00.000Z",
      },
      {
        id: "artifact-high",
        artifact_kind: "single_contract",
        subject_key: "task:task-1",
        primary_contract_type: "follow_up_risk",
        status: "open",
        summary: "Vendor follow-up is going stale.",
        reason: "The task is waiting on an external answer and follow-up has gone quiet.",
        severity: "high",
        confidence: "medium",
        available_actions: ["accept", "dismiss"],
        artifact_evidence: [{ code: "waiting_on_target", kind: "task", summary: "Waiting on vendor feedback.", relatedId: "task-1", sourceContractType: "follow_up_risk" }],
        created_at: "2026-03-26T09:00:00.000Z",
        updated_at: "2026-03-26T10:00:00.000Z",
        last_evaluated_at: "2026-03-26T10:00:00.000Z",
      },
    ],
    accepted: [
      {
        id: "artifact-accepted",
        artifact_kind: "single_contract",
        subject_key: "task:task-1",
        primary_contract_type: "follow_up_risk",
        status: "accepted",
        summary: "Vendor follow-up is committed.",
        reason: "Brent accepted the follow-up prompt.",
        severity: "medium",
        confidence: "high",
        available_actions: ["apply", "expire"],
        artifact_evidence: [],
        created_at: "2026-03-26T11:00:00.000Z",
        updated_at: "2026-03-26T14:00:00.000Z",
        last_evaluated_at: "2026-03-26T14:00:00.000Z",
      },
    ],
    applied: [
      {
        id: "artifact-applied",
        artifact_kind: "task_staleness_clarity_group",
        subject_key: "task:task-2",
        primary_contract_type: "stale_task",
        status: "applied",
        summary: "Clarify rollout steps is both stale and underspecified.",
        reason: "The task has gone quiet and still lacks legible context.",
        severity: "high",
        confidence: "high",
        available_actions: [],
        artifact_evidence: [],
        created_at: "2026-03-25T10:00:00.000Z",
        updated_at: "2026-03-26T15:00:00.000Z",
        last_evaluated_at: "2026-03-26T15:00:00.000Z",
      },
    ],
    dismissed: [],
  },
  taskById,
  latestTransitionByArtifactId
);

assert.equal(payload.counts.open, 2);
assert.equal(payload.counts.accepted, 1);
assert.equal(payload.counts.applied, 1);
assert.equal(payload.counts.dismissed, 0);

assert.equal(payload.open[0].artifact_id, "artifact-high");
assert.equal(payload.open[0].artifact_type, "Follow-up risk");
assert.equal(payload.open[0].suggested_action, "Review and send the follow-up");
assert.equal(payload.open[0].task_title, "Vendor follow-up");

assert.equal(payload.accepted[0].status_label, "Accepted");
assert.equal(payload.accepted[0].latest_transition?.to_status, "accepted");
assert.equal(payload.accepted[0].latest_transition?.note, "Accepted from the artifact inbox.");

assert.equal(payload.applied[0].artifact_type, "Stale + ambiguous task");
assert.equal(payload.applied[0].task_href, "/backlog?expand=task-2");

console.log("intelligence artifact inbox tests passed");
