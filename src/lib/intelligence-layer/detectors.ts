import type { SupabaseClient } from "@supabase/supabase-js";
import { isDueWithinHours } from "@/lib/planner/scoring";
import { readIntelligenceTaskContexts } from "./context";
import type {
  AmbiguousTaskContract,
  BlockedWaitingStaleContract,
  DetectIntelligenceContractsOptions,
  FollowUpRiskContract,
  IntelligenceContractConfidence,
  IntelligenceContractEvidenceItem,
  IntelligenceContractProvenance,
  IntelligenceContractSeverity,
  IntelligencePhaseOneRunResult,
  IntelligenceTaskCommentContext,
  IntelligenceTaskContext,
  IntelligenceV1Contract,
  ReadIntelligenceTaskContextsOptions,
  StaleTaskContract,
} from "./types";

const FOLLOW_UP_RISK_AFTER_HOURS = 72;
const BLOCKED_WAITING_STALE_AFTER_DAYS = 5;
const STALE_TASK_AFTER_DAYS = 7;
const HIGH_STALE_TASK_AFTER_DAYS = 14;
const HIGH_BLOCKED_WAITING_AFTER_DAYS = 10;
const CLARIFYING_COMMENT_LOOKBACK_DAYS = 14;

function parseIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursSince(now: Date, iso: string | null | undefined): number | null {
  const parsed = parseIso(iso);
  if (parsed === null) {
    return null;
  }

  return Math.max(0, Math.floor((now.getTime() - parsed) / (60 * 60 * 1000)));
}

function isOverdue(dueAt: string | null | undefined, now: Date): boolean {
  const parsed = parseIso(dueAt);
  return parsed !== null && parsed < now.getTime();
}

function normalizeIdentityToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncate(value: string, maxLength = 160): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function makeProvenance(context: IntelligenceTaskContext): IntelligenceContractProvenance {
  const relatedDecisionIds = context.notes.flatMap((note) => note.decisions.map((decision) => decision.id));

  return {
    taskId: context.task.id,
    relatedCommentIds: context.comments.map((comment) => comment.id),
    relatedNoteIds: context.notes.map((note) => note.id),
    relatedDecisionIds,
    relatedCommitmentIds: context.openCommitments.map((commitment) => commitment.id),
    relatedDependencyIds: context.task.dependencies.map((dependency) => dependency.id),
  };
}

function highestSeverity(
  ...values: IntelligenceContractSeverity[]
): IntelligenceContractSeverity {
  if (values.includes("high")) {
    return "high";
  }

  if (values.includes("medium")) {
    return "medium";
  }

  return "low";
}

function latestCommentEvidence(comment: IntelligenceTaskCommentContext | undefined): IntelligenceContractEvidenceItem | null {
  if (!comment || !comment.excerpt) {
    return null;
  }

  return {
    code: "latest_comment",
    kind: "comment",
    summary: `Latest comment: ${truncate(comment.excerpt, 140)}`,
    relatedId: comment.id,
    recordedAt: comment.updatedAt,
  };
}

function noteEvidence(context: IntelligenceTaskContext, code = "linked_note"): IntelligenceContractEvidenceItem | null {
  const note = context.notes[0];
  if (!note) {
    return null;
  }

  const summary = note.excerpt
    ? `${note.title}: ${truncate(note.excerpt, 140)}`
    : `${note.title} is linked as supporting note context.`;

  return {
    code,
    kind: "note",
    summary,
    relatedId: note.id,
    recordedAt: note.updatedAt,
  };
}

function commitmentEvidence(context: IntelligenceTaskContext): IntelligenceContractEvidenceItem | null {
  const commitment = context.openCommitments[0];
  if (!commitment) {
    return null;
  }

  const stakeholderText = commitment.stakeholder?.name ? ` with ${commitment.stakeholder.name}` : "";
  const dueText = commitment.dueAt ? ` Due ${commitment.dueAt}.` : "";

  return {
    code: "open_commitment",
    kind: "commitment",
    summary: `Open commitment${stakeholderText}: ${commitment.title}.${dueText}`.trim(),
    relatedId: commitment.id,
    recordedAt: commitment.updatedAt,
  };
}

function dependencyEvidence(context: IntelligenceTaskContext): IntelligenceContractEvidenceItem | null {
  const dependency = context.task.dependencies.find((item) => item.unresolved);
  if (!dependency) {
    return null;
  }

  return {
    code: "unresolved_dependency",
    kind: "dependency",
    summary: `Still blocked by ${dependency.type} dependency "${dependency.title}".`,
    relatedId: dependency.id,
    recordedAt: dependency.created_at,
  };
}

function dueEvidence(dueAt: string | null, now: Date): IntelligenceContractEvidenceItem | null {
  if (!dueAt) {
    return null;
  }

  return {
    code: isOverdue(dueAt, now) ? "due_overdue" : "due_recorded",
    kind: "task",
    summary: isOverdue(dueAt, now) ? `The task due date ${dueAt} has already passed.` : `The task has a recorded due date of ${dueAt}.`,
    relatedId: null,
    recordedAt: dueAt,
  };
}

function buildFollowUpRiskContract(
  context: IntelligenceTaskContext,
  now: Date
): FollowUpRiskContract | null {
  const waitingOn = context.task.waiting_on?.trim();
  if (context.task.status !== "Blocked/Waiting" || !waitingOn) {
    return null;
  }

  const hoursInactive = hoursSince(now, context.latestActivityAt) ?? 0;
  const followUpAt = context.task.follow_up_at;
  const hoursOverdue = followUpAt ? hoursSince(now, followUpAt) : null;
  const followUpDue = hoursOverdue !== null && hoursOverdue >= 0;

  if (!followUpDue && hoursInactive < FOLLOW_UP_RISK_AFTER_HOURS) {
    return null;
  }

  const normalizedTarget = normalizeIdentityToken(waitingOn);
  if (!normalizedTarget) {
    return null;
  }

  const canonicalSubjectKey = `waiting_on:${context.task.id}:${normalizedTarget}`;
  const severity = highestSeverity(
    followUpDue && (hoursOverdue ?? 0) >= 24 ? "high" : "medium",
    context.daysSinceActivity >= 7 ? "high" : "low"
  );
  const confidence: IntelligenceContractConfidence = followUpDue ? "high" : "medium";

  const evidence: IntelligenceContractEvidenceItem[] = [
    {
      code: "waiting_on_target",
      kind: "task",
      summary: `The task is explicitly waiting on ${waitingOn}.`,
      relatedId: context.task.id,
      recordedAt: context.task.updated_at,
    },
    followUpDue
      ? {
          code: "follow_up_due",
          kind: "task",
          summary: `The recorded follow-up date ${followUpAt} has passed.`,
          relatedId: context.task.id,
          recordedAt: followUpAt,
        }
      : {
          code: "follow_up_inactive",
          kind: "task",
          summary: `There has been no logged movement on the waiting thread for ${context.daysSinceActivity} days.`,
          relatedId: context.task.id,
          recordedAt: context.latestActivityAt,
        },
    latestCommentEvidence(context.comments[0]),
    commitmentEvidence(context),
    noteEvidence(context),
  ].filter((item): item is IntelligenceContractEvidenceItem => item !== null);

  return {
    contractType: "follow_up_risk",
    canonicalSubjectKey,
    promotionFamilyKey: `follow_up_risk|${canonicalSubjectKey}`,
    detectedAt: now.toISOString(),
    summary: followUpDue
      ? `${context.task.title} needs a follow-up on ${waitingOn}.`
      : `${context.task.title} is aging in a follow-up wait state with ${waitingOn}.`,
    reason: followUpDue
      ? `The follow-up date has passed and the task is still waiting on ${waitingOn}.`
      : `The task is still waiting on ${waitingOn} and has shown no fresh movement for ${context.daysSinceActivity} days.`,
    severity,
    confidence,
    subject: {
      taskId: context.task.id,
      taskStatus: context.task.status,
      waitingOn,
      threadKey: canonicalSubjectKey,
    },
    metrics: {
      followUpAt,
      daysSinceActivity: context.daysSinceActivity,
      hoursOverdue,
    },
    evidence,
    provenance: makeProvenance(context),
  };
}

function buildBlockedWaitingStaleContract(
  context: IntelligenceTaskContext,
  now: Date
): BlockedWaitingStaleContract | null {
  const hasBlockedState =
    context.task.status === "Blocked/Waiting" || context.task.blocker || context.task.dependency_blocked;
  if (!hasBlockedState || context.daysSinceActivity < BLOCKED_WAITING_STALE_AFTER_DAYS) {
    return null;
  }

  const unresolvedDependencyCount = context.task.dependencies.filter((dependency) => dependency.unresolved).length;
  const overdue = isOverdue(context.task.due_at, now);
  const severity = highestSeverity(
    context.daysSinceActivity >= HIGH_BLOCKED_WAITING_AFTER_DAYS ? "high" : "medium",
    overdue ? "high" : "low",
    unresolvedDependencyCount > 1 ? "high" : "low"
  );

  const blockingSummary =
    context.task.status === "Blocked/Waiting"
      ? context.task.waiting_on
        ? `Still waiting on ${context.task.waiting_on}.`
        : "Still marked Blocked/Waiting."
      : context.task.dependency_blocked
        ? "Unresolved dependency still blocks the task."
        : "The task is still flagged as a blocker.";

  const evidence: IntelligenceContractEvidenceItem[] = [
    {
      code: "blocked_state",
      kind: "task",
      summary: blockingSummary,
      relatedId: context.task.id,
      recordedAt: context.task.updated_at,
    },
    {
      code: "blocked_stale_age",
      kind: "task",
      summary: `No movement has been logged for ${context.daysSinceActivity} days while the task remains blocked.`,
      relatedId: context.task.id,
      recordedAt: context.latestActivityAt,
    },
    dependencyEvidence(context),
    dueEvidence(context.task.due_at, now),
    noteEvidence(context),
  ].filter((item): item is IntelligenceContractEvidenceItem => item !== null);

  return {
    contractType: "blocked_waiting_stale",
    canonicalSubjectKey: `task:${context.task.id}`,
    promotionFamilyKey: `blocked_waiting_stale|task:${context.task.id}`,
    detectedAt: now.toISOString(),
    summary: `${context.task.title} has been sitting in a blocked state.`,
    reason: `${blockingSummary.replace(/\.$/, "")} It has not moved for ${context.daysSinceActivity} days.`,
    severity,
    confidence: "high",
    subject: {
      taskId: context.task.id,
      taskStatus: context.task.status,
    },
    metrics: {
      daysSinceActivity: context.daysSinceActivity,
      waitingOn: context.task.waiting_on,
      unresolvedDependencyCount,
    },
    evidence,
    provenance: makeProvenance(context),
  };
}

function buildStaleTaskContract(context: IntelligenceTaskContext, now: Date): StaleTaskContract | null {
  if (!["Planned", "In Progress"].includes(context.task.status) || context.daysSinceActivity < STALE_TASK_AFTER_DAYS) {
    return null;
  }

  const overdue = isOverdue(context.task.due_at, now);
  const severity = highestSeverity(
    overdue ? "high" : "medium",
    context.daysSinceActivity >= HIGH_STALE_TASK_AFTER_DAYS ? "high" : "low",
    context.task.status === "In Progress" && context.daysSinceActivity >= 10 ? "high" : "low"
  );

  const evidence: IntelligenceContractEvidenceItem[] = [
    {
      code: "active_task_status",
      kind: "task",
      summary: `The task is still ${context.task.status} but has no logged movement for ${context.daysSinceActivity} days.`,
      relatedId: context.task.id,
      recordedAt: context.latestActivityAt,
    },
    dueEvidence(context.task.due_at, now),
    latestCommentEvidence(context.comments[0]),
    noteEvidence(context),
  ].filter((item): item is IntelligenceContractEvidenceItem => item !== null);

  return {
    contractType: "stale_task",
    canonicalSubjectKey: `task:${context.task.id}`,
    promotionFamilyKey: `stale_task|task:${context.task.id}`,
    detectedAt: now.toISOString(),
    summary: `${context.task.title} looks stale.`,
    reason: overdue
      ? `The task is still ${context.task.status} and has been quiet for ${context.daysSinceActivity} days even though its due date has passed.`
      : `The task is still ${context.task.status} and has been quiet for ${context.daysSinceActivity} days.`,
    severity,
    confidence: "high",
    subject: {
      taskId: context.task.id,
      taskStatus: context.task.status,
    },
    metrics: {
      daysSinceActivity: context.daysSinceActivity,
      dueAt: context.task.due_at,
      overdue,
    },
    evidence,
    provenance: makeProvenance(context),
  };
}

function hasLongEnoughText(value: string | null | undefined, minLength: number): boolean {
  return Boolean(value && value.trim().length >= minLength);
}

function collectAmbiguitySignals(context: IntelligenceTaskContext, now: Date): string[] {
  const signals: string[] = [];

  if (hasLongEnoughText(context.task.description, 40)) {
    signals.push("task_description");
  }

  if (hasLongEnoughText(context.task.pinned_excerpt, 40)) {
    signals.push("pinned_excerpt");
  }

  if (hasLongEnoughText(context.task.waiting_on, 8)) {
    signals.push("waiting_on");
  }

  const clarifyingComment = context.comments.find((comment) => {
    const age = hoursSince(now, comment.updatedAt);
    return age !== null && age <= CLARIFYING_COMMENT_LOOKBACK_DAYS * 24 && hasLongEnoughText(comment.content, 24);
  });

  if (clarifyingComment) {
    signals.push("recent_comment");
  }

  if (context.notes.some((note) => hasLongEnoughText(note.excerpt, 80))) {
    signals.push("linked_note");
  }

  if (context.notes.some((note) => note.decisions.some((decision) => decision.decisionStatus === "active" && hasLongEnoughText(decision.summary, 30)))) {
    signals.push("active_note_decision");
  }

  return signals;
}

function buildAmbiguousTaskContract(context: IntelligenceTaskContext, now: Date): AmbiguousTaskContract | null {
  if (!context.task.needs_review) {
    return null;
  }

  const contextSignalsPresent = collectAmbiguitySignals(context, now);
  if (contextSignalsPresent.length > 0) {
    return null;
  }

  const overdue = isOverdue(context.task.due_at, now);
  const dueSoon = Boolean(context.task.due_at && isDueWithinHours(context.task.due_at, now.getTime(), 48));
  const severity = highestSeverity(
    overdue ? "high" : "medium",
    context.task.status === "In Progress" ? "high" : "low",
    dueSoon ? "high" : "low"
  );

  const evidence: IntelligenceContractEvidenceItem[] = [
    {
      code: "needs_review_flag",
      kind: "task",
      summary: "The task is explicitly flagged as needing review.",
      relatedId: context.task.id,
      recordedAt: context.task.updated_at,
    },
    {
      code: "missing_clarifying_context",
      kind: "task",
      summary: "There is no strong task description, pinned excerpt, clarifying comment, or linked note context resolving what success looks like.",
      relatedId: context.task.id,
      recordedAt: context.task.updated_at,
    },
    dueEvidence(context.task.due_at, now),
    noteEvidence(context, "linked_note_context"),
  ].filter((item): item is IntelligenceContractEvidenceItem => item !== null);

  return {
    contractType: "ambiguous_task",
    canonicalSubjectKey: `task:${context.task.id}`,
    promotionFamilyKey: `ambiguous_task|task:${context.task.id}`,
    detectedAt: now.toISOString(),
    summary: `${context.task.title} still needs clarification before it is safe to trust.`,
    reason: "The task is flagged for review and the current task, comment, and note context still does not add a durable explanation of what the task really means.",
    severity,
    confidence: "high",
    subject: {
      taskId: context.task.id,
      taskStatus: context.task.status,
    },
    metrics: {
      needsReview: true,
      contextSignalsPresent,
      dueAt: context.task.due_at,
      dueSoon,
      overdue,
    },
    evidence,
    provenance: makeProvenance(context),
  };
}

export function detectIntelligenceContracts(
  taskContexts: IntelligenceTaskContext[],
  options: DetectIntelligenceContractsOptions = {}
): IntelligenceV1Contract[] {
  const now = options.now ?? new Date();
  const contracts: IntelligenceV1Contract[] = [];

  for (const context of taskContexts) {
    const taskContracts = [
      buildFollowUpRiskContract(context, now),
      buildBlockedWaitingStaleContract(context, now),
      buildStaleTaskContract(context, now),
      buildAmbiguousTaskContract(context, now),
    ].filter((contract): contract is IntelligenceV1Contract => contract !== null);

    contracts.push(...taskContracts);
  }

  return contracts;
}

export async function runIntelligencePhaseOne(
  supabase: SupabaseClient,
  userId: string,
  options: ReadIntelligenceTaskContextsOptions & DetectIntelligenceContractsOptions = {}
): Promise<IntelligencePhaseOneRunResult> {
  const now = options.now ?? new Date();
  const taskContexts = await readIntelligenceTaskContexts(supabase, userId, {
    now,
    taskIds: options.taskIds,
  });

  return {
    detectedAt: now.toISOString(),
    taskContexts,
    contracts: detectIntelligenceContracts(taskContexts, { now }),
  };
}
