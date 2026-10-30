import { badgeClasses } from "@/components/ui/Badge";
import { isNowUnblocked, NOW_UNBLOCKED_LABEL, nowUnblockedTitle } from "@/lib/task-unblocks";
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

export type TaskVisualStateKey = "parked" | "missed" | "dependency_blocked" | "blocked" | "stale";

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
  missed: {
    key: "missed",
    label: "Missed",
    badgeClass: "bg-rose-500/15 text-rose-400",
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

  if (input.status === "Missed") {
    return STATE_STYLES.missed;
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
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-semibold ${state.badgeClass} ${className}`}
    >
      {state.label}
    </span>
  );
}

/**
 * The green "Now unblocked" pill (migration 067), beside the state badge on the
 * Now card, week board, task lists and the task page. Renders nothing unless the
 * database has the task marked (`unblocked_at`) and it is still open.
 */
export function NowUnblockedPill({
  task,
  className = "",
}: {
  task: { status: TaskStatus; unblocked_at?: string | null };
  className?: string;
}) {
  if (!isNowUnblocked(task)) return null;
  return (
    <span
      className={badgeClasses({ tone: "success", size: "sm", className })}
      title={nowUnblockedTitle(task.unblocked_at)}
      data-now-unblocked=""
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M11 1a4 4 0 0 0-4 4v2H3.5A1.5 1.5 0 0 0 2 8.5v5A1.5 1.5 0 0 0 3.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 10.5 7H8.5V5a2.5 2.5 0 0 1 5 0v1h1.5V5a4 4 0 0 0-4-4z"
        />
      </svg>
      {NOW_UNBLOCKED_LABEL}
    </span>
  );
}
