import type { ProjectStage } from "@/types/database";

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

  return null;
}
