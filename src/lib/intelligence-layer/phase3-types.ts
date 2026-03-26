import type { PersistedIntelligenceArtifact } from "./phase2-types";

export const INTELLIGENCE_REMINDER_EXECUTION_KINDS = [
  "task_comment_reminder",
] as const;

export const INTELLIGENCE_REMINDER_EXECUTION_STATUSES = [
  "started",
  "completed",
] as const;

export type IntelligenceReminderExecutionKind = typeof INTELLIGENCE_REMINDER_EXECUTION_KINDS[number];
export type IntelligenceReminderExecutionStatus = typeof INTELLIGENCE_REMINDER_EXECUTION_STATUSES[number];

export interface PersistedIntelligenceReminderExecution {
  id: string;
  userId: string;
  artifactId: string;
  executionKind: IntelligenceReminderExecutionKind;
  status: IntelligenceReminderExecutionStatus;
  taskId: string;
  taskCommentId: string | null;
  payload: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedReminderTaskComment {
  id: string;
  userId: string;
  taskId: string;
  content: string;
  source: "system";
  createdAt: string;
  updatedAt: string;
}

export interface ExecuteAcceptedReminderArtifactsOptions {
  now?: Date;
  limit?: number;
}

export interface ExecuteAcceptedReminderArtifactsResult {
  inspectedArtifacts: PersistedIntelligenceArtifact[];
  executions: PersistedIntelligenceReminderExecution[];
  comments: PersistedReminderTaskComment[];
  appliedArtifactIds: string[];
  skipped: Array<{
    artifactId: string;
    reason: string;
  }>;
  errors: Array<{
    artifactId: string;
    message: string;
  }>;
}

export interface IntelligenceReminderStore {
  listAcceptedReminderArtifacts(userId: string, limit?: number): Promise<PersistedIntelligenceArtifact[]>;
  getReminderExecution(
    userId: string,
    artifactId: string,
    executionKind: IntelligenceReminderExecutionKind
  ): Promise<PersistedIntelligenceReminderExecution | null>;
  claimReminderExecution(input: {
    userId: string;
    artifactId: string;
    executionKind: IntelligenceReminderExecutionKind;
    taskId: string;
    payload: Record<string, unknown>;
    nowIso: string;
  }): Promise<PersistedIntelligenceReminderExecution>;
  completeReminderExecution(
    userId: string,
    executionId: string,
    updates: {
      taskCommentId: string;
      payload: Record<string, unknown>;
      nowIso: string;
    }
  ): Promise<PersistedIntelligenceReminderExecution>;
  createSystemTaskComment(input: {
    userId: string;
    taskId: string;
    content: string;
  }): Promise<PersistedReminderTaskComment>;
}
