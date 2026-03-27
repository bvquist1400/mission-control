import type {
  CommitmentDirection,
  CommitmentStatus,
  NoteDecisionStatus,
  NoteStatus,
  NoteType,
  RecentlyResolvedTaskDependencySummary,
  TaskStatusTransition,
  TaskDependencySummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";

export const INTELLIGENCE_V1_CONTRACT_TYPES = [
  "follow_up_risk",
  "blocked_waiting_stale",
  "stale_task",
  "ambiguous_task",
  "recently_unblocked",
] as const;

export type IntelligenceV1ContractType = typeof INTELLIGENCE_V1_CONTRACT_TYPES[number];
export type IntelligenceContractSeverity = "low" | "medium" | "high";
export type IntelligenceContractConfidence = "high" | "medium" | "low";
export type IntelligenceEvidenceKind = "task" | "comment" | "note" | "decision" | "dependency" | "commitment";

export interface IntelligenceContextNoteDecision {
  id: string;
  title: string;
  summary: string;
  decisionStatus: NoteDecisionStatus;
  decidedAt: string | null;
  updatedAt: string;
}

export interface IntelligenceContextNote {
  id: string;
  title: string;
  noteType: NoteType;
  status: NoteStatus;
  updatedAt: string;
  lastReviewedAt: string | null;
  excerpt: string | null;
  relationReasons: string[];
  decisions: IntelligenceContextNoteDecision[];
}

export interface IntelligenceTaskCommentContext {
  id: string;
  content: string;
  excerpt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceTaskCommitmentContext {
  id: string;
  title: string;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  dueAt: string | null;
  updatedAt: string;
  stakeholder: { id: string; name: string } | null;
}

export interface IntelligenceTaskRecord extends TaskWithImplementation {
  dependencies: TaskDependencySummary[];
  dependency_blocked: boolean;
}

export interface IntelligenceTaskStatusTransitionContext extends Pick<
  TaskStatusTransition,
  "id" | "task_id" | "from_status" | "to_status" | "transitioned_at" | "created_at"
> {}

export interface IntelligenceResolvedDependencyContext extends RecentlyResolvedTaskDependencySummary {}

export interface IntelligenceTaskContext {
  task: IntelligenceTaskRecord;
  latestActivityAt: string;
  daysSinceActivity: number;
  comments: IntelligenceTaskCommentContext[];
  notes: IntelligenceContextNote[];
  openCommitments: IntelligenceTaskCommitmentContext[];
  recentTransitions: IntelligenceTaskStatusTransitionContext[];
  recentlyResolvedDeps: IntelligenceResolvedDependencyContext[];
}

export interface IntelligenceContractEvidenceItem {
  code: string;
  kind: IntelligenceEvidenceKind;
  summary: string;
  relatedId: string | null;
  recordedAt: string | null;
}

export interface IntelligenceContractProvenance {
  taskId: string;
  relatedCommentIds: string[];
  relatedNoteIds: string[];
  relatedDecisionIds: string[];
  relatedCommitmentIds: string[];
  relatedDependencyIds: string[];
}

interface IntelligenceContractBase<
  TType extends IntelligenceV1ContractType,
  TSubject extends Record<string, unknown>,
  TMetrics extends Record<string, unknown>,
> {
  contractType: TType;
  canonicalSubjectKey: string;
  promotionFamilyKey: string;
  detectedAt: string;
  summary: string;
  reason: string;
  severity: IntelligenceContractSeverity;
  confidence: IntelligenceContractConfidence;
  subject: TSubject;
  metrics: TMetrics;
  evidence: IntelligenceContractEvidenceItem[];
  provenance: IntelligenceContractProvenance;
}

export interface FollowUpRiskContract extends IntelligenceContractBase<
  "follow_up_risk",
  {
    taskId: string;
    taskStatus: TaskStatus;
    waitingOn: string;
    threadKey: string;
  },
  {
    followUpAt: string | null;
    daysSinceActivity: number;
    hoursOverdue: number | null;
  }
> {}

export interface BlockedWaitingStaleContract extends IntelligenceContractBase<
  "blocked_waiting_stale",
  {
    taskId: string;
    taskStatus: TaskStatus;
  },
  {
    daysSinceActivity: number;
    waitingOn: string | null;
    unresolvedDependencyCount: number;
  }
> {}

export interface StaleTaskContract extends IntelligenceContractBase<
  "stale_task",
  {
    taskId: string;
    taskStatus: TaskStatus;
  },
  {
    daysSinceActivity: number;
    dueAt: string | null;
    overdue: boolean;
  }
> {}

export interface AmbiguousTaskContract extends IntelligenceContractBase<
  "ambiguous_task",
  {
    taskId: string;
    taskStatus: TaskStatus;
  },
  {
    needsReview: boolean;
    contextSignalsPresent: string[];
    dueAt: string | null;
    dueSoon: boolean;
    overdue: boolean;
  }
> {}

export interface RecentlyUnblockedContract extends IntelligenceContractBase<
  "recently_unblocked",
  {
    taskId: string;
    taskTitle: string;
    currentStatus: TaskStatus;
  },
  {
    unblockedAt: string;
    hoursBlocked: number | null;
    recommendedActionWindow: "within 24 hours";
  }
> {}

export type IntelligenceV1Contract =
  | FollowUpRiskContract
  | BlockedWaitingStaleContract
  | StaleTaskContract
  | AmbiguousTaskContract
  | RecentlyUnblockedContract;

export interface IntelligencePhaseOneRunResult {
  detectedAt: string;
  taskContexts: IntelligenceTaskContext[];
  contracts: IntelligenceV1Contract[];
}

export interface ReadIntelligenceTaskContextsOptions {
  now?: Date;
  taskIds?: string[];
}

export interface DetectIntelligenceContractsOptions {
  now?: Date;
}
