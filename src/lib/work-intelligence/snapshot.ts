import { calculateCapacity } from "../capacity";
import { calculateStalenessBoost } from "../planner/scoring";
import { calculateSprintProgressMetrics } from "../today/sprint-progress";
import type { WorkIntelligenceFreshnessSourceInput } from "./metadata";
import type {
  WorkIntelligenceCommentActivity,
  WorkIntelligenceCommentRow,
  WorkIntelligenceEvent,
  WorkIntelligenceSnapshot,
  WorkIntelligenceSprintRecord,
  WorkIntelligenceTask,
  WorkIntelligenceWindow,
  WorkSprintSummary,
} from "./types";

interface BuildWorkIntelligenceSnapshotInput {
  now: Date;
  window: WorkIntelligenceWindow;
  tasks: WorkIntelligenceTask[];
  events: WorkIntelligenceEvent[];
  taskComments: WorkIntelligenceCommentRow[];
  currentSprint: WorkIntelligenceSprintRecord | null;
}

const DUE_SOON_HORIZON_MS = 48 * 60 * 60 * 1000;
const FOLLOW_UP_RISK_THRESHOLD_MS = 72 * 60 * 60 * 1000;

function safeIso(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function truncate(value: string, max = 140): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function getMeetingMinutes(events: WorkIntelligenceEvent[]): number {
  return events.reduce((sum, event) => {
    if (event.is_all_day) {
      return sum;
    }

    const startMs = new Date(event.start_at).getTime();
    const endMs = new Date(event.end_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return sum;
    }

    return sum + Math.round((endMs - startMs) / 60000);
  }, 0);
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getHourInTimezone(iso: string, timezone: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  if (!hourPart) {
    return null;
  }

  const parsed = Number(hourPart);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSprintHealthAssessment(
  sprintName: string,
  completionPct: number,
  blockedTasks: number,
  metrics: ReturnType<typeof calculateSprintProgressMetrics>
): string {
  if (completionPct === 0) {
    return `${sprintName} has not logged a completed task yet, so it needs an early win today.`;
  }

  if (metrics.onTrack && blockedTasks === 0) {
    return `${sprintName} is on track and the work mix is still healthy.`;
  }

  if (metrics.onTrack) {
    return `${sprintName} is still on track, but ${blockedTasks} blocked item${blockedTasks === 1 ? "" : "s"} need watching.`;
  }

  if (metrics.tasksBehindPace <= 1) {
    return `${sprintName} is only a little behind pace, but it needs focused execution to stay recoverable.`;
  }

  return `${sprintName} is off pace and needs active triage, not just more parallel work.`;
}

export function compareByDueThenPriority(left: WorkIntelligenceTask, right: WorkIntelligenceTask): number {
  const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
  const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) {
    return leftDue - rightDue;
  }

  return right.priority_score - left.priority_score;
}

export function compareByPriorityThenUpdate(left: WorkIntelligenceTask, right: WorkIntelligenceTask): number {
  if (left.priority_score !== right.priority_score) {
    return right.priority_score - left.priority_score;
  }

  return right.updated_at.localeCompare(left.updated_at);
}

export function compareByUpdatedDesc<T extends { updated_at: string }>(left: T, right: T): number {
  return right.updated_at.localeCompare(left.updated_at);
}

export function getLatestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;

  for (const value of values) {
    const normalized = safeIso(value);
    if (!normalized) {
      continue;
    }

    if (!latest || normalized > latest) {
      latest = normalized;
    }
  }

  return latest;
}

export function buildTaskContextLabel(task: WorkIntelligenceTask): string | null {
  const parts = [
    task.implementation?.name ?? null,
    task.project?.name ?? null,
    task.sprint?.name ?? null,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return parts.length > 0 ? parts.join(" / ") : null;
}

export function buildCommentActivityMap(
  rows: WorkIntelligenceCommentRow[],
  sinceIso: string
): Map<string, WorkIntelligenceCommentActivity> {
  const activity = new Map<string, WorkIntelligenceCommentActivity>();

  for (const row of rows) {
    const createdAt = safeIso(row.created_at);
    const updatedAt = safeIso(row.updated_at);
    const latestAt = updatedAt ?? createdAt;
    if (!latestAt || latestAt < sinceIso) {
      continue;
    }

    const existing = activity.get(row.task_id);
    const snippet = truncate(row.content, 120);
    if (!existing) {
      activity.set(row.task_id, {
        count: 1,
        latestAt,
        latestSnippet: snippet,
      });
      continue;
    }

    existing.count += 1;
    if (latestAt > existing.latestAt) {
      existing.latestAt = latestAt;
      existing.latestSnippet = snippet;
    }
  }

  return activity;
}

export function getTaskLatestMovementAt(
  task: WorkIntelligenceTask,
  commentActivity: Map<string, WorkIntelligenceCommentActivity>
): string | null {
  return getLatestTimestamp([task.updated_at, commentActivity.get(task.id)?.latestAt ?? null]);
}

export function taskHasMovementSignalInWindow(
  task: WorkIntelligenceTask,
  commentActivity: Map<string, WorkIntelligenceCommentActivity>,
  sinceIso: string
): boolean {
  const latestMovementAt = getTaskLatestMovementAt(task, commentActivity);
  return Boolean(latestMovementAt && latestMovementAt >= sinceIso);
}

export function buildSprintSummary(
  currentSprint: WorkIntelligenceSprintRecord | null,
  allTasks: WorkIntelligenceTask[],
  requestedDate: string
): WorkSprintSummary | null {
  if (!currentSprint) {
    return null;
  }

  const sprintTasks = allTasks.filter((task) => task.sprint_id === currentSprint.id);
  const totalTasks = sprintTasks.length;
  const completedTasks = sprintTasks.filter((task) => task.status === "Done").length;
  const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const blockedTasks = sprintTasks.filter((task) => task.status === "Blocked/Waiting").length;
  const inProgressTasks = sprintTasks.filter((task) => task.status === "In Progress").length;
  const plannedTasks = sprintTasks.filter((task) => task.status === "Planned").length;
  const metrics = calculateSprintProgressMetrics({
    sprintStartDate: currentSprint.start_date,
    sprintEndDate: currentSprint.end_date,
    todayDate: requestedDate,
    totalTasks,
    completedTasks,
  });

  return {
    id: currentSprint.id,
    name: currentSprint.name,
    theme: currentSprint.theme,
    start_date: currentSprint.start_date,
    end_date: currentSprint.end_date,
    completed_tasks: completedTasks,
    total_tasks: totalTasks,
    completion_pct: completionPct,
    blocked_tasks: blockedTasks,
    in_progress_tasks: inProgressTasks,
    planned_tasks: plannedTasks,
    on_track: metrics.onTrack,
    tasks_behind_pace: metrics.tasksBehindPace,
    health_assessment: buildSprintHealthAssessment(currentSprint.name, completionPct, blockedTasks, metrics),
  };
}

export function isTaskStatusUncertain(task: WorkIntelligenceTask, nowMs: number): boolean {
  return calculateStalenessBoost(task.updated_at, nowMs) > 0;
}

export function isTaskFollowUpRisk(task: WorkIntelligenceTask, nowMs: number): boolean {
  if (task.status !== "Blocked/Waiting") {
    return false;
  }

  if (!task.waiting_on || task.waiting_on.trim().length === 0) {
    return false;
  }

  const followUpMs = parseTimeMs(task.follow_up_at);
  if (followUpMs !== null) {
    return followUpMs <= nowMs;
  }

  const updatedMs = parseTimeMs(task.updated_at);
  return updatedMs !== null && nowMs - updatedMs >= FOLLOW_UP_RISK_THRESHOLD_MS;
}

export function buildSnapshotFreshnessSources(
  snapshot: Pick<WorkIntelligenceSnapshot, "tasks" | "commentActivity" | "remainingEvents">
): WorkIntelligenceFreshnessSourceInput[] {
  return [
    {
      source: "tasks",
      latestAt: getLatestTimestamp(snapshot.tasks.map((task) => task.updated_at)),
      staleAfterHours: 72,
      required: true,
    },
    {
      source: "task_comments",
      latestAt: getLatestTimestamp([...snapshot.commentActivity.values()].map((item) => item.latestAt)),
      staleAfterHours: 24,
      allowMissing: true,
    },
    {
      source: "calendar",
      latestAt: getLatestTimestamp(snapshot.remainingEvents.map((event) => event.end_at)),
      staleAfterHours: 24,
      allowMissing: true,
    },
  ];
}

export function buildWorkIntelligenceSnapshot(input: BuildWorkIntelligenceSnapshotInput): WorkIntelligenceSnapshot {
  const generatedAt = input.now.toISOString();
  const nowMs = input.now.getTime();
  const commentActivity = buildCommentActivityMap(input.taskComments, input.window.since);

  const openTasks = input.tasks.filter((task) => task.status !== "Done" && task.status !== "Parked");
  const plannedTasks = openTasks.filter((task) => task.status === "Planned");
  const remainingEvents = input.events.filter((event) => event.temporal_status !== "past");
  const dueSoonTasks = openTasks
    .filter((task) => {
      if (!task.due_at) {
        return false;
      }

      const dueMs = new Date(task.due_at).getTime();
      return Number.isFinite(dueMs) && dueMs <= nowMs + DUE_SOON_HORIZON_MS;
    })
    .sort(compareByDueThenPriority);
  const dueSoonTaskIds = new Set(dueSoonTasks.map((task) => task.id));
  const overdueTasks = dueSoonTasks.filter((task) => {
    const dueMs = task.due_at ? new Date(task.due_at).getTime() : Number.NaN;
    return Number.isFinite(dueMs) && dueMs < nowMs;
  });
  const blockedTasks = openTasks
    .filter((task) => task.status === "Blocked/Waiting" && !dueSoonTaskIds.has(task.id))
    .sort(compareByPriorityThenUpdate);
  const inProgressTasks = openTasks
    .filter((task) => task.status === "In Progress" && !dueSoonTaskIds.has(task.id))
    .sort(compareByPriorityThenUpdate);
  const completedTodayTasks = input.tasks
    .filter((task) => {
      if (task.status !== "Done") {
        return false;
      }

      const updatedAt = safeIso(task.updated_at);
      return Boolean(updatedAt && updatedAt >= input.window.dayStartIso && updatedAt < input.window.dayEndExclusiveIso);
    })
    .sort(compareByUpdatedDesc);
  const rolledOverTasks = openTasks
    .filter((task) => {
      if (!task.due_at) {
        return false;
      }

      const dueMs = new Date(task.due_at).getTime();
      const dayEndMs = new Date(input.window.dayEndExclusiveIso).getTime();
      return Number.isFinite(dueMs) && Number.isFinite(dayEndMs) && dueMs < dayEndMs;
    })
    .sort(compareByDueThenPriority);
  const followUpRiskTasks = openTasks
    .filter((task) => isTaskFollowUpRisk(task, nowMs))
    .sort(compareByPriorityThenUpdate);
  const followUpRiskTaskIds = new Set(followUpRiskTasks.map((task) => task.id));
  const statusUncertainTasks = openTasks
    .filter((task) => followUpRiskTaskIds.has(task.id) || isTaskStatusUncertain(task, nowMs))
    .sort(compareByPriorityThenUpdate);
  const quietInProgressTasks = inProgressTasks
    .filter((task) => !taskHasMovementSignalInWindow(task, commentActivity, input.window.since))
    .sort(compareByPriorityThenUpdate);

  const sprintSummary = buildSprintSummary(input.currentSprint, input.tasks, input.window.requestedDate);
  const topTaskIdsForCapacity = new Set(
    openTasks
      .filter((task) => task.status === "Planned" || task.status === "In Progress")
      .slice(0, 3)
      .map((task) => task.id)
  );
  const remainingMeetingMinutes = getMeetingMinutes(remainingEvents);
  const afternoonEvents = remainingEvents.filter((event) => {
    const hour = getHourInTimezone(event.start_at, input.window.timezone);
    return hour !== null && hour >= 12;
  });
  const meetingHeavyAfternoon = afternoonEvents.length >= 3 || getMeetingMinutes(afternoonEvents) >= 90;
  const capacity = calculateCapacity(input.tasks, topTaskIdsForCapacity, remainingMeetingMinutes);
  const coreCounts = {
    overdue: overdueTasks.length,
    dueSoon: dueSoonTasks.length,
    blocked: openTasks.filter((task) => task.status === "Blocked/Waiting").length,
    inProgress: openTasks.filter((task) => task.status === "In Progress").length,
    doneToday: completedTodayTasks.length,
    followUpRisks: followUpRiskTasks.length,
    statusUncertain: statusUncertainTasks.length,
    quietInProgress: quietInProgressTasks.length,
    waitingOnOthers: openTasks.filter(
      (task) => task.status === "Blocked/Waiting" && Boolean(task.waiting_on && task.waiting_on.trim().length > 0)
    ).length,
  };

  return {
    generatedAt,
    now: input.now,
    window: input.window,
    tasks: input.tasks,
    openTasks,
    plannedTasks,
    overdueTasks,
    dueSoonTasks,
    blockedTasks,
    inProgressTasks,
    completedTodayTasks,
    rolledOverTasks,
    followUpRiskTasks,
    statusUncertainTasks,
    quietInProgressTasks,
    remainingEvents,
    remainingMeetingMinutes,
    meetingHeavyAfternoon,
    commentActivity,
    currentSprint: input.currentSprint,
    sprintSummary,
    topTaskIdsForCapacity,
    capacity,
    coreCounts,
  };
}
