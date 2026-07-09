import type { TaskStatus } from "@/types/database";

/**
 * Shared visual-state treatment for task rows and cards.
 *
 * Every list surface should render the same badge + dimming for the same
 * state so triage stays scannable: Parked dims, Blocked/Waiting and
 * dependency-blocked get an amber badge, untouched-for-two-weeks active
 * tasks get a neutral "Stale" badge.
 */

export const STALE_TASK_THRESHOLD_DAYS = 14;

export type TaskVisualStateKey = "parked" | "dependency_blocked" | "blocked" | "stale";

export interface TaskVisualState {
  key: TaskVisualStateKey;
  label: string;
  badgeClass: string;
  rowClass: string;
}

const STATE_STYLES: Record<TaskVisualStateKey, TaskVisualState> = {
  parked: {
    key: "parked",
    label: "Parked",
    badgeClass: "bg-panel-muted text-muted-foreground",
    rowClass: "opacity-60",
  },
  dependency_blocked: {
    key: "dependency_blocked",
    label: "Blocked by dependency",
    badgeClass: "bg-amber-500/15 text-amber-400",
    rowClass: "",
  },
  blocked: {
    key: "blocked",
    label: "Waiting",
    badgeClass: "bg-amber-500/15 text-amber-400",
    rowClass: "",
  },
  stale: {
    key: "stale",
    label: "Stale",
    badgeClass: "bg-slate-500/15 text-slate-400",
    rowClass: "",
  },
};

const STALE_ELIGIBLE_STATUSES: TaskStatus[] = ["Backlog", "Planned", "In Progress"];

export interface TaskVisualStateInput {
  status: TaskStatus;
  dependencyBlocked?: boolean;
  updatedAt?: string | null;
  now?: Date;
}

export function getTaskVisualState(input: TaskVisualStateInput): TaskVisualState | null {
  if (input.status === "Parked") {
    return STATE_STYLES.parked;
  }

  if (input.dependencyBlocked) {
    return STATE_STYLES.dependency_blocked;
  }

  if (input.status === "Blocked/Waiting") {
    return STATE_STYLES.blocked;
  }

  if (input.updatedAt && STALE_ELIGIBLE_STATUSES.includes(input.status)) {
    const updatedMs = new Date(input.updatedAt).getTime();
    const nowMs = (input.now ?? new Date()).getTime();
    if (
      Number.isFinite(updatedMs) &&
      nowMs - updatedMs > STALE_TASK_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
    ) {
      return STATE_STYLES.stale;
    }
  }

  return null;
}

export function TaskStateBadge({ state, className = "" }: { state: TaskVisualState; className?: string }) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${state.badgeClass} ${className}`}
    >
      {state.label}
    </span>
  );
}
