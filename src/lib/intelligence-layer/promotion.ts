import { createHash } from "node:crypto";
import type { IntelligenceV1Contract, IntelligenceV1ContractType } from "./types";
import {
  INTELLIGENCE_ARTIFACT_STATUSES,
  type IntelligenceArtifactAction,
  type IntelligenceArtifactBundle,
  type IntelligenceArtifactCandidate,
  type IntelligenceArtifactEvidenceItem,
  type IntelligenceArtifactStatus,
  type IntelligencePromotionStore,
  type PersistedIntelligenceArtifact,
  type PersistedIntelligenceContractSnapshot,
  type PersistedIntelligencePromotionEvent,
  type PromoteIntelligenceContractsOptions,
  type PromoteIntelligenceContractsResult,
  type TransitionIntelligenceArtifactStatusOptions,
} from "./phase2-types";

const GROUPABLE_TASK_PAIR = new Set<IntelligenceV1ContractType>(["stale_task", "ambiguous_task"]);
const OPEN_ACTIONS: IntelligenceArtifactAction[] = ["accept", "dismiss"];
const ACCEPTED_ACTIONS: IntelligenceArtifactAction[] = ["apply", "expire"];
const RESOLVED_ACTIONS: IntelligenceArtifactAction[] = [];

const ALLOWED_STATUS_TRANSITIONS: Record<IntelligenceArtifactStatus, IntelligenceArtifactStatus[]> = {
  open: ["accepted", "dismissed", "expired"],
  accepted: ["applied", "expired"],
  applied: [],
  dismissed: [],
  expired: [],
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = stableValue((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function contractSubjectKey(contract: IntelligenceV1Contract): string {
  if ("taskId" in contract.subject) {
    return `task:${contract.subject.taskId}`;
  }

  return contract.canonicalSubjectKey;
}

function evidencePriority(contractType: IntelligenceV1ContractType, code: string): number {
  const byType: Record<IntelligenceV1ContractType, string[]> = {
    follow_up_risk: ["follow_up_due", "waiting_on_target", "follow_up_inactive", "open_commitment", "latest_comment", "linked_note"],
    blocked_waiting_stale: ["blocked_stale_age", "blocked_state", "unresolved_dependency", "due_overdue", "due_recorded", "linked_note"],
    stale_task: ["active_task_status", "due_overdue", "due_recorded", "latest_comment", "linked_note"],
    ambiguous_task: ["needs_review_flag", "missing_clarifying_context", "due_overdue", "due_recorded", "linked_note_context"],
  };

  const index = byType[contractType].indexOf(code);
  return index >= 0 ? index : byType[contractType].length + 1;
}

function curateArtifactEvidence(contract: IntelligenceV1Contract, maxItems = 3): IntelligenceArtifactEvidenceItem[] {
  return [...contract.evidence]
    .sort((left, right) => evidencePriority(contract.contractType, left.code) - evidencePriority(contract.contractType, right.code))
    .slice(0, maxItems)
    .map((item) => ({
      code: item.code,
      kind: item.kind,
      summary: item.summary,
      relatedId: item.relatedId,
      sourceContractType: contract.contractType,
    }));
}

function highestSeverity(contracts: IntelligenceV1Contract[]): IntelligenceArtifactCandidate["severity"] {
  if (contracts.some((contract) => contract.severity === "high")) {
    return "high";
  }

  if (contracts.some((contract) => contract.severity === "medium")) {
    return "medium";
  }

  return "low";
}

function highestConfidence(contracts: IntelligenceV1Contract[]): IntelligenceArtifactCandidate["confidence"] {
  if (contracts.some((contract) => contract.confidence === "high")) {
    return "high";
  }

  if (contracts.some((contract) => contract.confidence === "medium")) {
    return "medium";
  }

  return "low";
}

function buildSingleContractCandidate(contract: IntelligenceV1Contract): IntelligenceArtifactCandidate {
  const artifactEvidence = curateArtifactEvidence(contract, 3);
  const coveredFamilies = [{
    promotionFamilyKey: contract.promotionFamilyKey,
    contractType: contract.contractType,
    canonicalSubjectKey: contract.canonicalSubjectKey,
    isPrimary: true,
  }];
  const reviewPayload = {
    contractType: contract.contractType,
    subject: contract.subject,
    metrics: contract.metrics,
    coveredFamilies: coveredFamilies.map((coverage) => coverage.promotionFamilyKey),
  };

  return {
    artifactKind: "single_contract",
    groupingKey: null,
    subjectKey: contractSubjectKey(contract),
    primaryContractType: contract.contractType,
    coveredFamilies,
    contracts: [contract],
    summary: contract.summary,
    reason: contract.reason,
    severity: contract.severity,
    confidence: contract.confidence,
    artifactEvidence,
    reviewPayload,
    contentHash: hashValue({
      artifactKind: "single_contract",
      primaryContractType: contract.contractType,
      subjectKey: contractSubjectKey(contract),
      summary: contract.summary,
      reason: contract.reason,
      severity: contract.severity,
      confidence: contract.confidence,
      coveredFamilies: coveredFamilies.map((coverage) => coverage.promotionFamilyKey).sort(),
      availableActions: OPEN_ACTIONS,
      artifactEvidence,
      reviewPayload,
    }),
  };
}

function buildGroupedTaskCandidate(contracts: IntelligenceV1Contract[]): IntelligenceArtifactCandidate {
  const staleContract = contracts.find((contract) => contract.contractType === "stale_task");
  const ambiguousContract = contracts.find((contract) => contract.contractType === "ambiguous_task");
  if (!staleContract || !ambiguousContract) {
    throw new Error("Grouped task candidate requires stale_task and ambiguous_task contracts");
  }

  const taskId = staleContract.subject.taskId;
  const title = staleContract.summary.replace(/\s+looks stale\.$/, "").trim();
  const subjectKey = `task:${taskId}`;
  const coveredFamilies = [staleContract, ambiguousContract]
    .sort((left, right) => left.contractType.localeCompare(right.contractType))
    .map((contract) => ({
      promotionFamilyKey: contract.promotionFamilyKey,
      contractType: contract.contractType,
      canonicalSubjectKey: contract.canonicalSubjectKey,
      isPrimary: contract.contractType === "stale_task",
    }));
  const artifactEvidence = [
    ...curateArtifactEvidence(staleContract, 2),
    ...curateArtifactEvidence(ambiguousContract, 2),
  ];
  const reviewPayload = {
    groupingRule: "task_staleness_clarity_group",
    subjectKey,
    coveredFamilies: coveredFamilies.map((coverage) => coverage.promotionFamilyKey),
    contracts: contracts.map((contract) => ({
      contractType: contract.contractType,
      summary: contract.summary,
      reason: contract.reason,
      metrics: contract.metrics,
    })),
  };

  return {
    artifactKind: "task_staleness_clarity_group",
    groupingKey: `task_staleness_clarity_group|${subjectKey}`,
    subjectKey,
    primaryContractType: "stale_task",
    coveredFamilies,
    contracts,
    summary: `${title} is both stale and underspecified.`,
    reason: `The task has gone quiet and the current task, comment, and note context still does not make the work legible enough to trust without review.`,
    severity: highestSeverity(contracts),
    confidence: highestConfidence(contracts),
    artifactEvidence,
    reviewPayload,
    contentHash: hashValue({
      artifactKind: "task_staleness_clarity_group",
      primaryContractType: "stale_task",
      subjectKey,
      summary: `${title} is both stale and underspecified.`,
      reason: `The task has gone quiet and the current task, comment, and note context still does not make the work legible enough to trust without review.`,
      severity: highestSeverity(contracts),
      confidence: highestConfidence(contracts),
      coveredFamilies: coveredFamilies.map((coverage) => coverage.promotionFamilyKey).sort(),
      availableActions: OPEN_ACTIONS,
      artifactEvidence,
      reviewPayload,
    }),
  };
}

function buildPromotionCandidates(
  contracts: IntelligenceV1Contract[],
  options: Pick<PromoteIntelligenceContractsOptions, "enableTaskStalenessClarityGrouping">
): IntelligenceArtifactCandidate[] {
  const usedFamilyKeys = new Set<string>();
  const candidates: IntelligenceArtifactCandidate[] = [];
  const byTaskId = new Map<string, IntelligenceV1Contract[]>();

  if (options.enableTaskStalenessClarityGrouping) {
    for (const contract of contracts) {
      if (!GROUPABLE_TASK_PAIR.has(contract.contractType) || !("taskId" in contract.subject)) {
        continue;
      }

      const existing = byTaskId.get(contract.subject.taskId) ?? [];
      existing.push(contract);
      byTaskId.set(contract.subject.taskId, existing);
    }

    for (const taskContracts of byTaskId.values()) {
      const stale = taskContracts.find((contract) => contract.contractType === "stale_task");
      const ambiguous = taskContracts.find((contract) => contract.contractType === "ambiguous_task");
      if (!stale || !ambiguous) {
        continue;
      }

      candidates.push(buildGroupedTaskCandidate([stale, ambiguous]));
      usedFamilyKeys.add(stale.promotionFamilyKey);
      usedFamilyKeys.add(ambiguous.promotionFamilyKey);
    }
  }

  for (const contract of contracts) {
    if (usedFamilyKeys.has(contract.promotionFamilyKey)) {
      continue;
    }

    candidates.push(buildSingleContractCandidate(contract));
  }

  return candidates;
}

function actionsForStatus(status: IntelligenceArtifactStatus): IntelligenceArtifactAction[] {
  switch (status) {
    case "open":
      return [...OPEN_ACTIONS];
    case "accepted":
      return [...ACCEPTED_ACTIONS];
    default:
      return [...RESOLVED_ACTIONS];
  }
}

function assertOpenArtifactActions(actions: IntelligenceArtifactAction[]): void {
  if (!actions.includes("accept") || !actions.includes("dismiss")) {
    throw new Error("Open intelligence artifacts must expose both accept and dismiss actions");
  }
}

function normalizeArtifactForStatus(
  candidate: IntelligenceArtifactCandidate,
  status: IntelligenceArtifactStatus,
  nowIso: string
): Omit<PersistedIntelligenceArtifact, "id" | "userId" | "createdAt" | "updatedAt"> {
  const availableActions = actionsForStatus(status);
  if (status === "open") {
    assertOpenArtifactActions(availableActions);
  }

  return {
    artifactKind: candidate.artifactKind,
    groupingKey: candidate.groupingKey,
    subjectKey: candidate.subjectKey,
    primaryContractType: candidate.primaryContractType,
    status,
    summary: candidate.summary,
    reason: candidate.reason,
    severity: candidate.severity,
    confidence: candidate.confidence,
    availableActions,
    artifactEvidence: candidate.artifactEvidence,
    reviewPayload: candidate.reviewPayload,
    contentHash: candidate.contentHash,
    lastEvaluatedAt: nowIso,
  };
}

function chooseExistingArtifact(
  candidate: IntelligenceArtifactCandidate,
  bundles: IntelligenceArtifactBundle[]
): IntelligenceArtifactBundle | null {
  if (bundles.length === 0) {
    return null;
  }

  return [...bundles].sort((left, right) => {
    const leftOverlap = left.coverages.filter((coverage) =>
      candidate.coveredFamilies.some((family) => family.promotionFamilyKey === coverage.promotionFamilyKey)
    ).length;
    const rightOverlap = right.coverages.filter((coverage) =>
      candidate.coveredFamilies.some((family) => family.promotionFamilyKey === coverage.promotionFamilyKey)
    ).length;

    if (rightOverlap !== leftOverlap) {
      return rightOverlap - leftOverlap;
    }

    return left.artifact.createdAt.localeCompare(right.artifact.createdAt);
  })[0] ?? null;
}

async function findExistingArtifact(
  store: IntelligencePromotionStore,
  userId: string,
  candidate: IntelligenceArtifactCandidate
): Promise<IntelligenceArtifactBundle | null> {
  const bundlesById = new Map<string, IntelligenceArtifactBundle>();

  for (const family of candidate.coveredFamilies) {
    const matches = await store.listActiveArtifactsByFamily(userId, family.promotionFamilyKey);
    for (const bundle of matches) {
      bundlesById.set(bundle.artifact.id, bundle);
    }
  }

  if (candidate.artifactKind === "task_staleness_clarity_group" && bundlesById.size === 0) {
    const sameSubject = await store.listActiveArtifactsBySubject(userId, candidate.subjectKey);
    for (const bundle of sameSubject) {
      if (GROUPABLE_TASK_PAIR.has(bundle.artifact.primaryContractType)) {
        bundlesById.set(bundle.artifact.id, bundle);
      }
    }
  }

  return chooseExistingArtifact(candidate, [...bundlesById.values()]);
}

function toSnapshotProvenance(contract: IntelligenceV1Contract): Record<string, unknown> {
  return {
    taskId: contract.provenance.taskId,
    relatedCommentIds: contract.provenance.relatedCommentIds,
    relatedNoteIds: contract.provenance.relatedNoteIds,
    relatedDecisionIds: contract.provenance.relatedDecisionIds,
    relatedCommitmentIds: contract.provenance.relatedCommitmentIds,
    relatedDependencyIds: contract.provenance.relatedDependencyIds,
  };
}

function buildContractSnapshotHash(contract: IntelligenceV1Contract): string {
  return hashValue({
    contractType: contract.contractType,
    canonicalSubjectKey: contract.canonicalSubjectKey,
    promotionFamilyKey: contract.promotionFamilyKey,
    summary: contract.summary,
    reason: contract.reason,
    severity: contract.severity,
    confidence: contract.confidence,
    subject: contract.subject,
    metrics: contract.metrics,
    evidence: contract.evidence,
    provenance: contract.provenance,
  });
}

function eventTypeForCandidate(kind: IntelligenceArtifactCandidate["artifactKind"], phase: "created" | "updated" | "noop") {
  if (kind === "task_staleness_clarity_group") {
    return `grouped_${phase}` as const;
  }

  return phase;
}

export async function promoteIntelligenceContracts(
  store: IntelligencePromotionStore,
  userId: string,
  contracts: IntelligenceV1Contract[],
  options: PromoteIntelligenceContractsOptions = {}
): Promise<PromoteIntelligenceContractsResult> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const contractSnapshots: PersistedIntelligenceContractSnapshot[] = [];
  const snapshotByFamilyKey = new Map<string, PersistedIntelligenceContractSnapshot>();

  for (const contract of contracts) {
    const snapshot = await store.createContractSnapshot({
      userId,
      contractType: contract.contractType,
      canonicalSubjectKey: contract.canonicalSubjectKey,
      promotionFamilyKey: contract.promotionFamilyKey,
      detectedAt: contract.detectedAt,
      summary: contract.summary,
      reason: contract.reason,
      severity: contract.severity,
      confidence: contract.confidence,
      subjectPayload: contract.subject,
      metricsPayload: contract.metrics,
      evidencePayload: contract.evidence,
      provenancePayload: toSnapshotProvenance(contract),
      contentHash: buildContractSnapshotHash(contract),
    });

    contractSnapshots.push(snapshot);
    snapshotByFamilyKey.set(contract.promotionFamilyKey, snapshot);
  }

  const promotionEvents: PersistedIntelligencePromotionEvent[] = [];
  const touchedArtifacts = new Map<string, PersistedIntelligenceArtifact>();
  const candidates = buildPromotionCandidates(contracts, {
    enableTaskStalenessClarityGrouping: options.enableTaskStalenessClarityGrouping === true,
  });

  for (const candidate of candidates) {
    const existing = await findExistingArtifact(store, userId, candidate);
    const linkedSnapshots = candidate.coveredFamilies
      .map((family) => snapshotByFamilyKey.get(family.promotionFamilyKey))
      .filter((snapshot): snapshot is PersistedIntelligenceContractSnapshot => snapshot !== undefined);

    if (!existing) {
      const artifact = await store.createArtifact({
        userId,
        ...normalizeArtifactForStatus(candidate, "open", nowIso),
      });

      await store.upsertArtifactCoverages(
        userId,
        artifact.id,
        candidate.coveredFamilies.map((family) => ({
          promotionFamilyKey: family.promotionFamilyKey,
          contractType: family.contractType,
          canonicalSubjectKey: family.canonicalSubjectKey,
          subjectKey: candidate.subjectKey,
          isPrimary: family.isPrimary,
        }))
      );

      await store.insertArtifactContractLinks(
        userId,
        artifact.id,
        linkedSnapshots.map((snapshot) => ({
          contractSnapshotId: snapshot.id,
          promotionFamilyKey: snapshot.promotionFamilyKey,
          contractType: snapshot.contractType,
          linkRole: snapshot.contractType === candidate.primaryContractType ? "primary" : "grouped",
        }))
      );

      await store.insertStatusTransition({
        userId,
        artifactId: artifact.id,
        fromStatus: null,
        toStatus: "open",
        triggeredBy: "system",
        note: null,
        payload: {
          artifactKind: candidate.artifactKind,
          coveredFamilies: candidate.coveredFamilies.map((family) => family.promotionFamilyKey),
        },
      });

      for (const snapshot of linkedSnapshots) {
        promotionEvents.push(
          await store.insertPromotionEvent({
            userId,
            contractSnapshotId: snapshot.id,
            artifactId: artifact.id,
            promotionFamilyKey: snapshot.promotionFamilyKey,
            eventType: eventTypeForCandidate(candidate.artifactKind, "created"),
            suppressionReason: null,
            details: {
              artifactKind: candidate.artifactKind,
              coveredFamilies: candidate.coveredFamilies.map((family) => family.promotionFamilyKey),
            },
          })
        );
      }

      touchedArtifacts.set(artifact.id, artifact);
      continue;
    }

    const preserveExistingGroupedArtifact =
      existing.artifact.artifactKind === "task_staleness_clarity_group" &&
      candidate.artifactKind === "single_contract";

    if (preserveExistingGroupedArtifact) {
      await store.upsertArtifactCoverages(
        userId,
        existing.artifact.id,
        candidate.coveredFamilies.map((family) => ({
          promotionFamilyKey: family.promotionFamilyKey,
          contractType: family.contractType,
          canonicalSubjectKey: family.canonicalSubjectKey,
          subjectKey: existing.artifact.subjectKey,
          isPrimary: false,
        }))
      );

      await store.insertArtifactContractLinks(
        userId,
        existing.artifact.id,
        linkedSnapshots.map((snapshot) => ({
          contractSnapshotId: snapshot.id,
          promotionFamilyKey: snapshot.promotionFamilyKey,
          contractType: snapshot.contractType,
          linkRole: "update",
        }))
      );

      for (const snapshot of linkedSnapshots) {
        promotionEvents.push(
          await store.insertPromotionEvent({
            userId,
            contractSnapshotId: snapshot.id,
            artifactId: existing.artifact.id,
            promotionFamilyKey: snapshot.promotionFamilyKey,
            eventType: "grouped_noop",
            suppressionReason: "promotion family is already covered by an open grouped artifact; v1 preserves the grouped review object instead of splitting it",
            details: {
              artifactKind: existing.artifact.artifactKind,
              preservedGrouping: true,
            },
          })
        );
      }

      touchedArtifacts.set(existing.artifact.id, existing.artifact);
      continue;
    }

    const nextArtifactData = normalizeArtifactForStatus(candidate, existing.artifact.status, nowIso);
    const materialChange = existing.artifact.contentHash !== nextArtifactData.contentHash;
    const artifact = materialChange
      ? await store.updateArtifact(userId, existing.artifact.id, nextArtifactData)
      : existing.artifact;

    await store.upsertArtifactCoverages(
      userId,
      artifact.id,
      candidate.coveredFamilies.map((family) => ({
        promotionFamilyKey: family.promotionFamilyKey,
        contractType: family.contractType,
        canonicalSubjectKey: family.canonicalSubjectKey,
        subjectKey: candidate.subjectKey,
        isPrimary: family.isPrimary,
      }))
    );

    await store.insertArtifactContractLinks(
      userId,
      artifact.id,
      linkedSnapshots.map((snapshot) => ({
        contractSnapshotId: snapshot.id,
        promotionFamilyKey: snapshot.promotionFamilyKey,
        contractType: snapshot.contractType,
        linkRole: snapshot.contractType === candidate.primaryContractType ? "primary" : "update",
      }))
    );

    for (const snapshot of linkedSnapshots) {
      promotionEvents.push(
        await store.insertPromotionEvent({
          userId,
            contractSnapshotId: snapshot.id,
            artifactId: artifact.id,
            promotionFamilyKey: snapshot.promotionFamilyKey,
            eventType: eventTypeForCandidate(candidate.artifactKind, materialChange ? "updated" : "noop"),
            suppressionReason: materialChange
              ? null
              : "promotion family is already represented by an active artifact and the regenerated review-facing content did not materially change",
            details: {
              artifactKind: candidate.artifactKind,
              coveredFamilies: candidate.coveredFamilies.map((family) => family.promotionFamilyKey),
              materialChange,
          },
        })
      );
    }

    touchedArtifacts.set(artifact.id, artifact);
  }

  return {
    contractSnapshots,
    artifacts: [...touchedArtifacts.values()],
    promotionEvents,
  };
}

export async function transitionIntelligenceArtifactStatus(
  store: IntelligencePromotionStore,
  userId: string,
  artifactId: string,
  toStatus: IntelligenceArtifactStatus,
  options: TransitionIntelligenceArtifactStatusOptions = {}
): Promise<PersistedIntelligenceArtifact> {
  if (!INTELLIGENCE_ARTIFACT_STATUSES.includes(toStatus)) {
    throw new Error(`Unknown intelligence artifact status: ${toStatus}`);
  }

  const artifact = await store.getArtifactById(userId, artifactId);
  if (!artifact) {
    throw new Error("Intelligence artifact not found");
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[artifact.status];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Invalid intelligence artifact status transition: ${artifact.status} -> ${toStatus}`);
  }

  const updated = await store.updateArtifact(userId, artifactId, {
    status: toStatus,
    availableActions: actionsForStatus(toStatus),
    lastEvaluatedAt: artifact.lastEvaluatedAt,
  });

  await store.insertStatusTransition({
    userId,
    artifactId,
    fromStatus: artifact.status,
    toStatus,
    triggeredBy: options.triggeredBy ?? "user",
    note: options.note ?? null,
    payload: options.payload ?? {},
  });

  return updated;
}
