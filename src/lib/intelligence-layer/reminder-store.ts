import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersistedIntelligenceArtifact } from "./phase2-types";
import type {
  IntelligenceReminderExecutionKind,
  IntelligenceReminderStore,
  PersistedIntelligenceReminderExecution,
  PersistedReminderTaskComment,
} from "./phase3-types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeArtifactRow(row: Record<string, unknown>): PersistedIntelligenceArtifact {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactKind: String(row.artifact_kind) as PersistedIntelligenceArtifact["artifactKind"],
    groupingKey: typeof row.grouping_key === "string" ? row.grouping_key : null,
    subjectKey: String(row.subject_key),
    primaryContractType: String(row.primary_contract_type) as PersistedIntelligenceArtifact["primaryContractType"],
    status: String(row.status) as PersistedIntelligenceArtifact["status"],
    summary: String(row.summary),
    reason: String(row.reason),
    severity: String(row.severity) as PersistedIntelligenceArtifact["severity"],
    confidence: String(row.confidence) as PersistedIntelligenceArtifact["confidence"],
    availableActions: Array.isArray(row.available_actions)
      ? (row.available_actions as PersistedIntelligenceArtifact["availableActions"])
      : [],
    artifactEvidence: Array.isArray(row.artifact_evidence)
      ? (row.artifact_evidence as PersistedIntelligenceArtifact["artifactEvidence"])
      : [],
    reviewPayload: asRecord(row.review_payload),
    contentHash: String(row.content_hash),
    lastEvaluatedAt: String(row.last_evaluated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeReminderExecutionRow(row: Record<string, unknown>): PersistedIntelligenceReminderExecution {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactId: String(row.artifact_id),
    executionKind: String(row.execution_kind) as PersistedIntelligenceReminderExecution["executionKind"],
    status: String(row.status) as PersistedIntelligenceReminderExecution["status"],
    taskId: String(row.task_id),
    taskCommentId: typeof row.task_comment_id === "string" ? row.task_comment_id : null,
    payload: asRecord(row.payload),
    startedAt: String(row.started_at),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeTaskCommentRow(row: Record<string, unknown>): PersistedReminderTaskComment {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    taskId: String(row.task_id),
    content: String(row.content),
    source: "system",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && String(error.code) === "23505";
}

export class SupabaseIntelligenceReminderStore implements IntelligenceReminderStore {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async listAcceptedReminderArtifacts(userId: string, limit = 25): Promise<PersistedIntelligenceArtifact[]> {
    const { data, error } = await this.supabase
      .from("intelligence_artifacts")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "accepted")
      .eq("artifact_kind", "single_contract")
      .eq("primary_contract_type", "follow_up_risk")
      .order("updated_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    return ((data || []) as Array<Record<string, unknown>>).map((row) => normalizeArtifactRow(row));
  }

  async getReminderExecution(
    userId: string,
    artifactId: string,
    executionKind: IntelligenceReminderExecutionKind
  ): Promise<PersistedIntelligenceReminderExecution | null> {
    const { data, error } = await this.supabase
      .from("intelligence_artifact_reminder_executions")
      .select("*")
      .eq("user_id", userId)
      .eq("artifact_id", artifactId)
      .eq("execution_kind", executionKind)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? normalizeReminderExecutionRow(data as Record<string, unknown>) : null;
  }

  async claimReminderExecution(input: {
    userId: string;
    artifactId: string;
    executionKind: IntelligenceReminderExecutionKind;
    taskId: string;
    payload: Record<string, unknown>;
    nowIso: string;
  }): Promise<PersistedIntelligenceReminderExecution> {
    const { data, error } = await this.supabase
      .from("intelligence_artifact_reminder_executions")
      .insert({
        user_id: input.userId,
        artifact_id: input.artifactId,
        execution_kind: input.executionKind,
        status: "started",
        task_id: input.taskId,
        payload: input.payload,
        started_at: input.nowIso,
      })
      .select("*")
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.getReminderExecution(input.userId, input.artifactId, input.executionKind);
        if (existing) {
          return existing;
        }
      }

      throw error;
    }

    return normalizeReminderExecutionRow(data as Record<string, unknown>);
  }

  async completeReminderExecution(
    userId: string,
    executionId: string,
    updates: {
      taskCommentId: string;
      payload: Record<string, unknown>;
      nowIso: string;
    }
  ): Promise<PersistedIntelligenceReminderExecution> {
    const { data, error } = await this.supabase
      .from("intelligence_artifact_reminder_executions")
      .update({
        status: "completed",
        task_comment_id: updates.taskCommentId,
        payload: updates.payload,
        completed_at: updates.nowIso,
      })
      .eq("user_id", userId)
      .eq("id", executionId)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeReminderExecutionRow(data as Record<string, unknown>);
  }

  async createSystemTaskComment(input: {
    userId: string;
    taskId: string;
    content: string;
  }): Promise<PersistedReminderTaskComment> {
    const { data, error } = await this.supabase
      .from("task_comments")
      .insert({
        user_id: input.userId,
        task_id: input.taskId,
        content: input.content,
        source: "system",
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeTaskCommentRow(data as Record<string, unknown>);
  }
}
