import type {
  IntelligenceContractConfidence,
  IntelligenceContractEvidenceItem,
  IntelligenceContractSeverity,
  IntelligenceV1Contract,
  IntelligenceV1ContractType,
} from "./types";

export const INTELLIGENCE_ARTIFACT_STATUSES = [
  "open",
  "accepted",
  "applied",
  "dismissed",
  "expired",
] as const;

export const INTELLIGENCE_ARTIFACT_ACTIONS = [
  "accept",
  "dismiss",
  "apply",
  "expire",
] as const;

export const INTELLIGENCE_ARTIFACT_KINDS = [
  "single_contract",
  "task_staleness_clarity_group",
] as const;

export const INTELLIGENCE_PROMOTION_EVENT_TYPES = [
  "created",
  "updated",
  "noop",
  "grouped_created",
  "grouped_updated",
  "grouped_noop",
] as const;

export type IntelligenceArtifactStatus = typeof INTELLIGENCE_ARTIFACT_STATUSES[number];
export type IntelligenceArtifactAction = typeof INTELLIGENCE_ARTIFACT_ACTIONS[number];
export type IntelligenceArtifactKind = typeof INTELLIGENCE_ARTIFACT_KINDS[number];
export type IntelligencePromotionEventType = typeof INTELLIGENCE_PROMOTION_EVENT_TYPES[number];

export interface PersistedIntelligenceContractSnapshot {
  id: string;
  userId: string;
  contractType: IntelligenceV1ContractType;
  canonicalSubjectKey: string;
  promotionFamilyKey: string;
  detectedAt: string;
  summary: string;
  reason: string;
  severity: IntelligenceContractSeverity;
  confidence: IntelligenceContractConfidence;
  subjectPayload: Record<string, unknown>;
  metricsPayload: Record<string, unknown>;
  evidencePayload: IntelligenceContractEvidenceItem[];
  provenancePayload: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface IntelligenceArtifactEvidenceItem {
  code: string;
  kind: IntelligenceContractEvidenceItem["kind"];
  summary: string;
  relatedId: string | null;
  sourceContractType: IntelligenceV1ContractType;
}

export interface PersistedIntelligenceArtifact {
  id: string;
  userId: string;
  artifactKind: IntelligenceArtifactKind;
  groupingKey: string | null;
  subjectKey: string;
  primaryContractType: IntelligenceV1ContractType;
  status: IntelligenceArtifactStatus;
  summary: string;
  reason: string;
  severity: IntelligenceContractSeverity;
  confidence: IntelligenceContractConfidence;
  availableActions: IntelligenceArtifactAction[];
  artifactEvidence: IntelligenceArtifactEvidenceItem[];
  reviewPayload: Record<string, unknown>;
  contentHash: string;
  lastEvaluatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedIntelligenceArtifactFamilyCoverage {
  id: string;
  userId: string;
  artifactId: string;
  promotionFamilyKey: string;
  contractType: IntelligenceV1ContractType;
  canonicalSubjectKey: string;
  subjectKey: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface PersistedIntelligenceArtifactContractLink {
  id: string;
  userId: string;
  artifactId: string;
  contractSnapshotId: string;
  promotionFamilyKey: string;
  contractType: IntelligenceV1ContractType;
  linkRole: "primary" | "grouped" | "update";
  createdAt: string;
}

export interface PersistedIntelligenceArtifactStatusTransition {
  id: string;
  userId: string;
  artifactId: string;
  fromStatus: IntelligenceArtifactStatus | null;
  toStatus: IntelligenceArtifactStatus;
  triggeredBy: "system" | "user";
  note: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PersistedIntelligencePromotionEvent {
  id: string;
  userId: string;
  contractSnapshotId: string | null;
  artifactId: string | null;
  promotionFamilyKey: string;
  eventType: IntelligencePromotionEventType;
  suppressionReason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface IntelligenceArtifactBundle {
  artifact: PersistedIntelligenceArtifact;
  coverages: PersistedIntelligenceArtifactFamilyCoverage[];
}

export interface IntelligenceArtifactCandidate {
  artifactKind: IntelligenceArtifactKind;
  groupingKey: string | null;
  subjectKey: string;
  primaryContractType: IntelligenceV1ContractType;
  coveredFamilies: Array<{
    promotionFamilyKey: string;
    contractType: IntelligenceV1ContractType;
    canonicalSubjectKey: string;
    isPrimary: boolean;
  }>;
  contracts: IntelligenceV1Contract[];
  summary: string;
  reason: string;
  severity: IntelligenceContractSeverity;
  confidence: IntelligenceContractConfidence;
  artifactEvidence: IntelligenceArtifactEvidenceItem[];
  reviewPayload: Record<string, unknown>;
  contentHash: string;
}

export interface PromoteIntelligenceContractsOptions {
  now?: Date;
  enableTaskStalenessClarityGrouping?: boolean;
  dismissalCooldownDays?: number;
}

export interface TransitionIntelligenceArtifactStatusOptions {
  triggeredBy?: "system" | "user";
  note?: string | null;
  payload?: Record<string, unknown>;
}

export interface PromoteIntelligenceContractsResult {
  contractSnapshots: PersistedIntelligenceContractSnapshot[];
  artifacts: PersistedIntelligenceArtifact[];
  promotionEvents: PersistedIntelligencePromotionEvent[];
}

export interface IntelligencePromotionStore {
  createContractSnapshot(input: Omit<PersistedIntelligenceContractSnapshot, "id" | "createdAt">): Promise<PersistedIntelligenceContractSnapshot>;
  listActiveArtifactsByFamily(userId: string, promotionFamilyKey: string): Promise<IntelligenceArtifactBundle[]>;
  getLatestUserDismissalTransitionByFamily(
    userId: string,
    promotionFamilyKey: string
  ): Promise<PersistedIntelligenceArtifactStatusTransition | null>;
  listActiveArtifactsBySubject(userId: string, subjectKey: string): Promise<IntelligenceArtifactBundle[]>;
  createArtifact(input: Omit<PersistedIntelligenceArtifact, "id" | "createdAt" | "updatedAt">): Promise<PersistedIntelligenceArtifact>;
  updateArtifact(
    userId: string,
    artifactId: string,
    updates: Partial<Omit<PersistedIntelligenceArtifact, "id" | "userId" | "createdAt" | "updatedAt">>
  ): Promise<PersistedIntelligenceArtifact>;
  getArtifactById(userId: string, artifactId: string): Promise<PersistedIntelligenceArtifact | null>;
  upsertArtifactCoverages(
    userId: string,
    artifactId: string,
    coverages: Array<Omit<PersistedIntelligenceArtifactFamilyCoverage, "id" | "userId" | "artifactId" | "createdAt">>
  ): Promise<PersistedIntelligenceArtifactFamilyCoverage[]>;
  insertArtifactContractLinks(
    userId: string,
    artifactId: string,
    links: Array<Omit<PersistedIntelligenceArtifactContractLink, "id" | "userId" | "artifactId" | "createdAt">>
  ): Promise<PersistedIntelligenceArtifactContractLink[]>;
  insertStatusTransition(
    input: Omit<PersistedIntelligenceArtifactStatusTransition, "id" | "createdAt">
  ): Promise<PersistedIntelligenceArtifactStatusTransition>;
  insertPromotionEvent(
    input: Omit<PersistedIntelligencePromotionEvent, "id" | "createdAt">
  ): Promise<PersistedIntelligencePromotionEvent>;
}
