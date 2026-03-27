import type { IntelligenceArtifactKind, IntelligenceArtifactStatus } from "./phase2-types";
import type { IntelligenceV1ContractType } from "./types";

export function parseTaskIdFromSubjectKey(subjectKey: string): string | null {
  return subjectKey.startsWith("task:") ? subjectKey.slice("task:".length) || null : null;
}

export function formatIntelligenceArtifactTypeLabel(
  artifactKind: IntelligenceArtifactKind,
  primaryContractType: IntelligenceV1ContractType
): string {
  if (artifactKind === "task_staleness_clarity_group") {
    return "Stale + ambiguous task";
  }

  switch (primaryContractType) {
    case "follow_up_risk":
      return "Follow-up risk";
    case "blocked_waiting_stale":
      return "Blocked wait";
    case "stale_task":
      return "Stale task";
    case "ambiguous_task":
      return "Ambiguous task";
    case "recently_unblocked":
      return "Recently unblocked";
  }
}

export function formatIntelligenceSuggestedActionLabel(
  artifactKind: IntelligenceArtifactKind,
  primaryContractType: IntelligenceV1ContractType
): string {
  if (artifactKind === "task_staleness_clarity_group") {
    return "Review and clarify before resuming";
  }

  switch (primaryContractType) {
    case "follow_up_risk":
      return "Review and send the follow-up";
    case "blocked_waiting_stale":
      return "Review the blocked state";
    case "stale_task":
      return "Review and refresh the task";
    case "ambiguous_task":
      return "Clarify the task";
    case "recently_unblocked":
      return "Restart the task within 24 hours";
  }
}

export function formatIntelligenceArtifactStatusLabel(status: IntelligenceArtifactStatus): string {
  switch (status) {
    case "open":
      return "Needs decision";
    case "accepted":
      return "Accepted";
    case "applied":
      return "Applied";
    case "dismissed":
      return "Dismissed";
    case "expired":
      return "Expired";
  }
}
