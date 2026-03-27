import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntelligenceV1ContractType } from "@/lib/intelligence-layer";
import type { BriefingOpenReviewItem } from "@/lib/briefing/contracts";
import {
  formatIntelligenceArtifactTypeLabel,
  formatIntelligenceSuggestedActionLabel,
  parseTaskIdFromSubjectKey,
} from "@/lib/intelligence-layer/presentation";

interface OpenReviewArtifactRow {
  id: string;
  artifact_kind: "single_contract" | "task_staleness_clarity_group";
  subject_key: string;
  primary_contract_type: IntelligenceV1ContractType;
  severity: "low" | "medium" | "high";
  review_payload: Record<string, unknown> | null;
  updated_at: string;
}

interface OpenReviewTaskRow {
  id: string;
  title: string;
}

const SEVERITY_ORDER: Record<OpenReviewArtifactRow["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === "42P01" || candidate.code === "PGRST205") {
    return true;
  }

  const message = `${candidate.message ?? ""} ${candidate.details ?? ""} ${candidate.hint ?? ""}`.toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

export function formatOpenReviewArtifactType(
  artifactKind: OpenReviewArtifactRow["artifact_kind"],
  primaryContractType: IntelligenceV1ContractType
): string {
  return formatIntelligenceArtifactTypeLabel(artifactKind, primaryContractType);
}

export function formatOpenReviewSuggestedAction(
  artifactKind: OpenReviewArtifactRow["artifact_kind"],
  primaryContractType: IntelligenceV1ContractType
): string {
  return formatIntelligenceSuggestedActionLabel(artifactKind, primaryContractType);
}

export function buildBriefingOpenReviewItems(
  artifactRows: OpenReviewArtifactRow[],
  taskById: Map<string, OpenReviewTaskRow>
): BriefingOpenReviewItem[] {
  return [...artifactRows]
    .sort((left, right) => {
      const severityDelta = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (severityDelta !== 0) {
        return severityDelta;
      }

      return left.updated_at.localeCompare(right.updated_at);
    })
    .flatMap((artifact) => {
      const taskId = parseTaskIdFromSubjectKey(artifact.subject_key);
      if (!taskId) {
        return [];
      }

      const task = taskById.get(taskId);
      if (!task) {
        return [];
      }

      return [{
        artifact_id: artifact.id,
        artifact_type: formatOpenReviewArtifactType(artifact.artifact_kind, artifact.primary_contract_type),
        family: artifact.primary_contract_type,
        task_id: task.id,
        task_title: task.title,
        suggested_action: formatOpenReviewSuggestedAction(artifact.artifact_kind, artifact.primary_contract_type),
        current_status: (() => {
          const subject = asRecord(asRecord(artifact.review_payload).subject);
          return typeof subject.currentStatus === "string" ? subject.currentStatus : null;
        })(),
        unblocked_at: (() => {
          const metrics = asRecord(asRecord(artifact.review_payload).metrics);
          return typeof metrics.unblockedAt === "string" ? metrics.unblockedAt : null;
        })(),
        recommended_action_window: (() => {
          const metrics = asRecord(asRecord(artifact.review_payload).metrics);
          return typeof metrics.recommendedActionWindow === "string" ? metrics.recommendedActionWindow : null;
        })(),
      }];
    });
}

export async function readBriefingOpenReviewItems(
  supabase: SupabaseClient,
  userId: string,
  options: {
    families?: IntelligenceV1ContractType[];
  } = {}
): Promise<BriefingOpenReviewItem[]> {
  let query = supabase
    .from("intelligence_artifacts")
    .select("id, artifact_kind, subject_key, primary_contract_type, severity, review_payload, updated_at")
    .eq("user_id", userId)
    .eq("status", "open")
    .order("updated_at", { ascending: true });

  if (options.families && options.families.length > 0) {
    query = query.in("primary_contract_type", options.families);
  }

  const { data: artifactData, error: artifactError } = await query;

  if (artifactError) {
    if (!isMissingRelationError(artifactError)) {
      console.error("[briefing] open review item fetch failed:", artifactError);
    }
    return [];
  }

  const artifactRows = (artifactData || []) as OpenReviewArtifactRow[];
  const taskIds = [...new Set(artifactRows.map((artifact) => parseTaskIdFromSubjectKey(artifact.subject_key)).filter(Boolean))];
  if (taskIds.length === 0) {
    return [];
  }

  const { data: taskData, error: taskError } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("user_id", userId)
    .in("id", taskIds);

  if (taskError) {
    console.error("[briefing] open review task fetch failed:", taskError);
    return [];
  }

  const taskById = new Map<string, OpenReviewTaskRow>(
    ((taskData || []) as OpenReviewTaskRow[]).map((task) => [task.id, task])
  );

  return buildBriefingOpenReviewItems(artifactRows, taskById);
}
