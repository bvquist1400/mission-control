import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskStatus } from "@/types/database";
import type {
  IntelligenceArtifactEvidenceItem,
  IntelligenceArtifactStatus,
} from "./phase2-types";
import {
  formatIntelligenceArtifactStatusLabel,
  formatIntelligenceArtifactTypeLabel,
  formatIntelligenceSuggestedActionLabel,
  parseTaskIdFromSubjectKey,
} from "./presentation";
import type { IntelligenceV1ContractType } from "./types";

type InboxQueueStatus = Extract<IntelligenceArtifactStatus, "open" | "accepted" | "applied" | "dismissed">;

interface InboxArtifactRow {
  id: string;
  artifact_kind: "single_contract" | "task_staleness_clarity_group";
  subject_key: string;
  primary_contract_type: IntelligenceV1ContractType;
  status: InboxQueueStatus;
  summary: string;
  reason: string;
  severity: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  available_actions: string[];
  artifact_evidence: IntelligenceArtifactEvidenceItem[];
  created_at: string;
  updated_at: string;
  last_evaluated_at: string;
}

interface InboxTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
}

interface InboxTransitionRow {
  id: string;
  artifact_id: string;
  from_status: IntelligenceArtifactStatus | null;
  to_status: IntelligenceArtifactStatus;
  triggered_by: "system" | "user";
  note: string | null;
  created_at: string;
}

export interface IntelligenceArtifactInboxTransition {
  id: string;
  from_status: IntelligenceArtifactStatus | null;
  to_status: IntelligenceArtifactStatus;
  triggered_by: "system" | "user";
  note: string | null;
  created_at: string;
}

export interface IntelligenceArtifactInboxItem {
  artifact_id: string;
  artifact_kind: InboxArtifactRow["artifact_kind"];
  artifact_type: string;
  primary_contract_type: IntelligenceV1ContractType;
  status: InboxQueueStatus;
  status_label: string;
  summary: string;
  reason: string;
  severity: InboxArtifactRow["severity"];
  confidence: InboxArtifactRow["confidence"];
  suggested_action: string;
  available_actions: string[];
  artifact_evidence: IntelligenceArtifactEvidenceItem[];
  subject_key: string;
  task_id: string | null;
  task_title: string;
  task_status: TaskStatus | null;
  task_href: string | null;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string;
  latest_transition: IntelligenceArtifactInboxTransition | null;
}

export interface IntelligenceArtifactInboxPayload {
  open: IntelligenceArtifactInboxItem[];
  accepted: IntelligenceArtifactInboxItem[];
  applied: IntelligenceArtifactInboxItem[];
  dismissed: IntelligenceArtifactInboxItem[];
  counts: {
    open: number;
    accepted: number;
    applied: number;
    dismissed: number;
  };
}

interface ReadIntelligenceArtifactInboxOptions {
  openLimit?: number;
  acceptedLimit?: number;
  recentLimit?: number;
}

const SEVERITY_ORDER: Record<IntelligenceArtifactInboxItem["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

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

function emptyInboxPayload(): IntelligenceArtifactInboxPayload {
  return {
    open: [],
    accepted: [],
    applied: [],
    dismissed: [],
    counts: {
      open: 0,
      accepted: 0,
      applied: 0,
      dismissed: 0,
    },
  };
}

function normalizeAvailableActions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeArtifactEvidence(value: unknown): IntelligenceArtifactEvidenceItem[] {
  return Array.isArray(value)
    ? (value as IntelligenceArtifactEvidenceItem[])
    : [];
}

function buildInboxItem(
  artifact: InboxArtifactRow,
  taskById: Map<string, InboxTaskRow>,
  latestTransitionByArtifactId: Map<string, IntelligenceArtifactInboxTransition>
): IntelligenceArtifactInboxItem {
  const taskId = parseTaskIdFromSubjectKey(artifact.subject_key);
  const task = taskId ? taskById.get(taskId) : null;

  return {
    artifact_id: artifact.id,
    artifact_kind: artifact.artifact_kind,
    artifact_type: formatIntelligenceArtifactTypeLabel(artifact.artifact_kind, artifact.primary_contract_type),
    primary_contract_type: artifact.primary_contract_type,
    status: artifact.status,
    status_label: formatIntelligenceArtifactStatusLabel(artifact.status),
    summary: artifact.summary,
    reason: artifact.reason,
    severity: artifact.severity,
    confidence: artifact.confidence,
    suggested_action: formatIntelligenceSuggestedActionLabel(artifact.artifact_kind, artifact.primary_contract_type),
    available_actions: normalizeAvailableActions(artifact.available_actions),
    artifact_evidence: normalizeArtifactEvidence(artifact.artifact_evidence),
    subject_key: artifact.subject_key,
    task_id: taskId,
    task_title: task?.title ?? (taskId ? "Task unavailable" : artifact.subject_key),
    task_status: task?.status ?? null,
    task_href: taskId ? `/backlog?expand=${taskId}` : null,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    last_evaluated_at: artifact.last_evaluated_at,
    latest_transition: latestTransitionByArtifactId.get(artifact.id) ?? null,
  };
}

function sortQueueItems(status: InboxQueueStatus, items: IntelligenceArtifactInboxItem[]): IntelligenceArtifactInboxItem[] {
  return [...items].sort((left, right) => {
    if (status === "open") {
      const severityDelta = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (severityDelta !== 0) {
        return severityDelta;
      }
    }

    const leftTimestamp = left.latest_transition?.created_at ?? left.updated_at;
    const rightTimestamp = right.latest_transition?.created_at ?? right.updated_at;
    return rightTimestamp.localeCompare(leftTimestamp);
  });
}

export function buildIntelligenceArtifactInboxPayload(
  artifactsByStatus: Record<InboxQueueStatus, InboxArtifactRow[]>,
  taskById: Map<string, InboxTaskRow>,
  latestTransitionByArtifactId: Map<string, IntelligenceArtifactInboxTransition>
): IntelligenceArtifactInboxPayload {
  const open = sortQueueItems(
    "open",
    artifactsByStatus.open.map((artifact) => buildInboxItem(artifact, taskById, latestTransitionByArtifactId))
  );
  const accepted = sortQueueItems(
    "accepted",
    artifactsByStatus.accepted.map((artifact) => buildInboxItem(artifact, taskById, latestTransitionByArtifactId))
  );
  const applied = sortQueueItems(
    "applied",
    artifactsByStatus.applied.map((artifact) => buildInboxItem(artifact, taskById, latestTransitionByArtifactId))
  );
  const dismissed = sortQueueItems(
    "dismissed",
    artifactsByStatus.dismissed.map((artifact) => buildInboxItem(artifact, taskById, latestTransitionByArtifactId))
  );

  return {
    open,
    accepted,
    applied,
    dismissed,
    counts: {
      open: open.length,
      accepted: accepted.length,
      applied: applied.length,
      dismissed: dismissed.length,
    },
  };
}

async function fetchArtifactsByStatus(
  supabase: SupabaseClient,
  userId: string,
  status: InboxQueueStatus,
  limit: number
): Promise<InboxArtifactRow[]> {
  const { data, error } = await supabase
    .from("intelligence_artifacts")
    .select(
      "id, artifact_kind, subject_key, primary_contract_type, status, summary, reason, severity, confidence, available_actions, artifact_evidence, created_at, updated_at, last_evaluated_at"
    )
    .eq("user_id", userId)
    .eq("status", status)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data || []) as InboxArtifactRow[];
}

export async function readIntelligenceArtifactInbox(
  supabase: SupabaseClient,
  userId: string,
  options: ReadIntelligenceArtifactInboxOptions = {}
): Promise<IntelligenceArtifactInboxPayload> {
  const openLimit = options.openLimit ?? 100;
  const acceptedLimit = options.acceptedLimit ?? 100;
  const recentLimit = options.recentLimit ?? 12;

  let artifactsByStatus: Record<InboxQueueStatus, InboxArtifactRow[]>;
  try {
    const [open, accepted, applied, dismissed] = await Promise.all([
      fetchArtifactsByStatus(supabase, userId, "open", openLimit),
      fetchArtifactsByStatus(supabase, userId, "accepted", acceptedLimit),
      fetchArtifactsByStatus(supabase, userId, "applied", recentLimit),
      fetchArtifactsByStatus(supabase, userId, "dismissed", recentLimit),
    ]);

    artifactsByStatus = { open, accepted, applied, dismissed };
  } catch (error) {
    if (!isMissingRelationError(error)) {
      console.error("[intelligence-inbox] artifact fetch failed:", error);
    }
    return emptyInboxPayload();
  }

  const allArtifacts = [
    ...artifactsByStatus.open,
    ...artifactsByStatus.accepted,
    ...artifactsByStatus.applied,
    ...artifactsByStatus.dismissed,
  ];

  if (allArtifacts.length === 0) {
    return emptyInboxPayload();
  }

  const taskIds = [
    ...new Set(
      allArtifacts
        .map((artifact) => parseTaskIdFromSubjectKey(artifact.subject_key))
        .filter((value): value is string => Boolean(value))
    ),
  ];

  const artifactIds = [...new Set(allArtifacts.map((artifact) => artifact.id))];

  const [taskResult, transitionResult] = await Promise.all([
    taskIds.length === 0
      ? Promise.resolve({ data: [] as InboxTaskRow[], error: null })
      : supabase
          .from("tasks")
          .select("id, title, status")
          .eq("user_id", userId)
          .in("id", taskIds),
    supabase
      .from("intelligence_artifact_status_transitions")
      .select("id, artifact_id, from_status, to_status, triggered_by, note, created_at")
      .eq("user_id", userId)
      .in("artifact_id", artifactIds)
      .order("created_at", { ascending: false }),
  ]);

  if (taskResult.error) {
    console.error("[intelligence-inbox] task fetch failed:", taskResult.error);
  }

  if (transitionResult.error) {
    console.error("[intelligence-inbox] status transition fetch failed:", transitionResult.error);
  }

  const taskById = new Map<string, InboxTaskRow>(
    (((taskResult.error ? [] : taskResult.data) || []) as InboxTaskRow[]).map((task) => [task.id, task])
  );

  const latestTransitionByArtifactId = new Map<string, IntelligenceArtifactInboxTransition>();
  for (const row of (((transitionResult.error ? [] : transitionResult.data) || []) as InboxTransitionRow[])) {
    if (latestTransitionByArtifactId.has(row.artifact_id)) {
      continue;
    }

    latestTransitionByArtifactId.set(row.artifact_id, {
      id: row.id,
      from_status: row.from_status,
      to_status: row.to_status,
      triggered_by: row.triggered_by,
      note: row.note,
      created_at: row.created_at,
    });
  }

  return buildIntelligenceArtifactInboxPayload(artifactsByStatus, taskById, latestTransitionByArtifactId);
}
