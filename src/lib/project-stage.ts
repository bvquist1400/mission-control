import type { ImplPhase, ProjectStage } from "@/types/database";

export const PROJECT_STAGE_VALUES = [
  "Proposed",
  "Planned",
  "Ready",
  "In Progress",
  "Blocked",
  "Review",
  "Done",
  "On Hold",
  "Cancelled",
] as const satisfies readonly ProjectStage[];

export const DEFAULT_PROJECT_STAGE: ProjectStage = "Planned";

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  Proposed: "Proposed",
  Planned: "Planned",
  Ready: "Ready",
  "In Progress": "In Progress",
  Blocked: "Blocked",
  Review: "Review",
  Done: "Done",
  "On Hold": "On Hold",
  Cancelled: "Cancelled",
};

const LEGACY_PHASE_TO_PROJECT_STAGE: Record<ImplPhase, ProjectStage> = {
  Intake: "Proposed",
  Discovery: "Planned",
  Design: "Ready",
  Build: "In Progress",
  Test: "Review",
  Training: "Review",
  GoLive: "Done",
  Hypercare: "Done",
  "Steady State": "On Hold",
  Sundown: "Cancelled",
};

export function isProjectStage(value: string): value is ProjectStage {
  return (PROJECT_STAGE_VALUES as readonly string[]).includes(value);
}

export function normalizeProjectStage(value: unknown): ProjectStage | null {
  if (typeof value !== "string") {
    return null;
  }

  if (isProjectStage(value)) {
    return value;
  }

  if (Object.prototype.hasOwnProperty.call(LEGACY_PHASE_TO_PROJECT_STAGE, value)) {
    return LEGACY_PHASE_TO_PROJECT_STAGE[value as ImplPhase];
  }

  return null;
}
