import { buildCanonicalMetadata, buildFreshness } from "./metadata";
import {
  buildSnapshotFreshnessSources,
  buildTaskContextLabel,
} from "./snapshot";
import type {
  WorkIntelligenceMetadata,
  WorkIntelligenceSnapshot,
  WorkIntelligenceTask,
  WorkIntelligenceWindow,
} from "./types";

export interface WorkExecutionStateItem {
  taskId: string;
  title: string;
  status: WorkIntelligenceTask["status"];
  context: string | null;
  reason: string;
  updatedAt: string;
}

export interface WorkExecutionRisk {
  label: string;
  summary: string;
  relatedTaskIds: string[];
}

export interface WorkExecutionMomentum {
  score: number;
  label: "strong" | "steady" | "fragile" | "stalled";
  assessment: string;
}

export interface WorkExecutionLoadAssessment {
  status: "manageable" | "tight" | "overloaded";
  isOverloaded: boolean;
  capacityRag: WorkIntelligenceSnapshot["capacity"]["rag"];
  availableMinutes: number;
  requiredMinutes: number;
  meetingHeavyAfternoon: boolean;
  assessment: string;
}

export interface WorkExecutionStateRawSignals {
  counts: WorkIntelligenceSnapshot["coreCounts"];
  remainingMeetings: number;
  followUpRiskTaskIds: string[];
  statusUncertainTaskIds: string[];
  quietInProgressTaskIds: string[];
  rolledOverTaskIds: string[];
}

export interface WorkExecutionStateRead extends WorkIntelligenceMetadata<WorkExecutionStateRawSignals> {
  window: WorkIntelligenceWindow;
  summary: string;
  topRisk: WorkExecutionRisk | null;
  momentum: WorkExecutionMomentum;
  whatMoved: WorkExecutionStateItem[];
  whatIsStuck: WorkExecutionStateItem[];
  whatLooksStale: WorkExecutionStateItem[];
  loadAssessment: WorkExecutionLoadAssessment;
}

export interface WorkExecutionStateOptions {
  includeRawSignals?: boolean;
}

function clampScore(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildMomentumScore(snapshot: WorkIntelligenceSnapshot): number {
  const score =
    45 +
    (snapshot.coreCounts.doneToday * 14) +
    (Math.min(snapshot.coreCounts.inProgress, 3) * 5) -
    (snapshot.coreCounts.overdue * 12) -
    (snapshot.coreCounts.blocked * 9) -
    (snapshot.coreCounts.followUpRisks * 7) -
    (snapshot.coreCounts.quietInProgress * 5) -
    (snapshot.meetingHeavyAfternoon ? 8 : 0);

  return clampScore(score);
}

function buildMomentum(snapshot: WorkIntelligenceSnapshot): WorkExecutionMomentum {
  const score = buildMomentumScore(snapshot);

  if (score >= 70) {
    return {
      score,
      label: "strong",
      assessment: "The day shows real traction. Protect the winning thread instead of reopening the stack.",
    };
  }

  if (score >= 50) {
    return {
      score,
      label: "steady",
      assessment: "There is enough forward motion to keep going, but the next interruption could flatten it.",
    };
  }

  if (score >= 35) {
    return {
      score,
      label: "fragile",
      assessment: "Work is moving unevenly. A tighter priority cut matters more than opening more work.",
    };
  }

  return {
    score,
    label: "stalled",
    assessment: "The operating picture is closer to churn than traction. Unblock or finish something before adding scope.",
  };
}

function buildLoadAssessment(snapshot: WorkIntelligenceSnapshot): WorkExecutionLoadAssessment {
  const isOverloaded =
    snapshot.capacity.rag !== "Green" ||
    snapshot.coreCounts.overdue >= 3 ||
    (snapshot.coreCounts.dueSoon + snapshot.coreCounts.inProgress >= 6) ||
    (snapshot.meetingHeavyAfternoon && snapshot.coreCounts.dueSoon >= 2);
  const status: WorkExecutionLoadAssessment["status"] = isOverloaded
    ? "overloaded"
    : snapshot.capacity.rag === "Yellow" || snapshot.meetingHeavyAfternoon || snapshot.coreCounts.dueSoon + snapshot.coreCounts.inProgress >= 4
      ? "tight"
      : "manageable";

  const assessment =
    status === "overloaded"
      ? "The remaining work is heavier than the day can hold without dropping something."
      : status === "tight"
        ? "The day still fits, but only if the stack stays narrow."
        : "The load looks manageable if the current priorities stay stable.";

  return {
    status,
    isOverloaded,
    capacityRag: snapshot.capacity.rag,
    availableMinutes: snapshot.capacity.available_minutes,
    requiredMinutes: snapshot.capacity.required_minutes,
    meetingHeavyAfternoon: snapshot.meetingHeavyAfternoon,
    assessment,
  };
}

function toExecutionItem(task: WorkIntelligenceTask, reason: string): WorkExecutionStateItem {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    context: buildTaskContextLabel(task),
    reason,
    updatedAt: task.updated_at,
  };
}

function buildTopRisk(snapshot: WorkIntelligenceSnapshot, loadAssessment: WorkExecutionLoadAssessment): WorkExecutionRisk | null {
  if (snapshot.overdueTasks[0]) {
    return {
      label: "Overdue delivery pressure",
      summary: `${snapshot.overdueTasks.length} overdue task${snapshot.overdueTasks.length === 1 ? "" : "s"} led by ${snapshot.overdueTasks[0].title}.`,
      relatedTaskIds: snapshot.overdueTasks.slice(0, 3).map((task) => task.id),
    };
  }

  if (snapshot.sprintSummary && !snapshot.sprintSummary.on_track) {
    return {
      label: "Sprint pace slipping",
      summary: `${snapshot.sprintSummary.name} is slipping by ${snapshot.sprintSummary.tasks_behind_pace} task${snapshot.sprintSummary.tasks_behind_pace === 1 ? "" : "s"}.`,
      relatedTaskIds: snapshot.openTasks
        .filter((task) => task.sprint_id === snapshot.sprintSummary?.id)
        .slice(0, 3)
        .map((task) => task.id),
    };
  }

  if (snapshot.followUpRiskTasks[0]) {
    return {
      label: "Stale follow-up risk",
      summary: `${snapshot.followUpRiskTasks.length} follow-up${snapshot.followUpRiskTasks.length === 1 ? "" : "s"} have gone stale, led by ${snapshot.followUpRiskTasks[0].title}.`,
      relatedTaskIds: snapshot.followUpRiskTasks.slice(0, 3).map((task) => task.id),
    };
  }

  if (loadAssessment.isOverloaded) {
    return {
      label: "Overloaded day",
      summary: "The remaining work is heavier than the time left in the day.",
      relatedTaskIds: snapshot.dueSoonTasks.slice(0, 3).map((task) => task.id),
    };
  }

  if (snapshot.coreCounts.statusUncertain >= 3) {
    return {
      label: "Status uncertainty",
      summary: `${snapshot.coreCounts.statusUncertain} active task statuses look stale or uncertain, so the execution picture may be lagging reality.`,
      relatedTaskIds: snapshot.statusUncertainTasks.slice(0, 3).map((task) => task.id),
    };
  }

  if (snapshot.blockedTasks[0]) {
    return {
      label: "External wait state",
      summary: `${snapshot.blockedTasks.length} task${snapshot.blockedTasks.length === 1 ? "" : "s"} are waiting on someone else, led by ${snapshot.blockedTasks[0].title}.`,
      relatedTaskIds: snapshot.blockedTasks.slice(0, 3).map((task) => task.id),
    };
  }

  if (snapshot.meetingHeavyAfternoon) {
    return {
      label: "Calendar crowding",
      summary: "The afternoon calendar is heavy enough to crowd out focused work.",
      relatedTaskIds: [],
    };
  }

  return null;
}

function buildWhatMoved(snapshot: WorkIntelligenceSnapshot): WorkExecutionStateItem[] {
  const moved: WorkExecutionStateItem[] = snapshot.completedTodayTasks.map((task) =>
    toExecutionItem(task, "Marked done today.")
  );

  for (const task of snapshot.inProgressTasks) {
    const commentActivity = snapshot.commentActivity.get(task.id);
    const updatedAt = new Date(task.updated_at).toISOString();
    if (updatedAt >= snapshot.window.since) {
      moved.push(toExecutionItem(task, "Updated during the current brief window."));
      continue;
    }

    if (commentActivity) {
      moved.push(toExecutionItem(task, `${commentActivity.count} new comment${commentActivity.count === 1 ? "" : "s"} in the current window.`));
    }
  }

  return moved.slice(0, 5);
}

function buildWhatIsStuck(snapshot: WorkIntelligenceSnapshot): WorkExecutionStateItem[] {
  const items: WorkExecutionStateItem[] = [];
  const seen = new Set<string>();

  for (const task of snapshot.followUpRiskTasks) {
    items.push(toExecutionItem(task, "Waiting on a follow-up that is already overdue."));
    seen.add(task.id);
  }

  for (const task of snapshot.blockedTasks) {
    if (seen.has(task.id)) {
      continue;
    }

    items.push(toExecutionItem(task, task.waiting_on ? `Waiting on ${task.waiting_on}.` : "Blocked without a clean next move."));
    seen.add(task.id);
  }

  for (const task of snapshot.overdueTasks) {
    if (seen.has(task.id)) {
      continue;
    }

    items.push(toExecutionItem(task, "Overdue and still unresolved."));
    seen.add(task.id);
  }

  return items.slice(0, 5);
}

function buildStaleReason(
  task: WorkIntelligenceTask,
  followUpRiskTaskIds: Set<string>,
  quietInProgressTaskIds: Set<string>
): string {
  if (followUpRiskTaskIds.has(task.id)) {
    return "Blocked follow-up is overdue, so both the dependency and the task status need refresh.";
  }

  if (quietInProgressTaskIds.has(task.id)) {
    return "Marked In Progress, but there has been no fresh movement signal in the current window and the status is aging.";
  }

  return "Task status has not been refreshed in 5+ days.";
}

function buildWhatLooksStale(snapshot: WorkIntelligenceSnapshot): WorkExecutionStateItem[] {
  const followUpRiskTaskIds = new Set(snapshot.followUpRiskTasks.map((task) => task.id));
  const quietInProgressTaskIds = new Set(snapshot.quietInProgressTasks.map((task) => task.id));

  return snapshot.statusUncertainTasks
    .slice(0, 5)
    .map((task) => toExecutionItem(task, buildStaleReason(task, followUpRiskTaskIds, quietInProgressTaskIds)));
}

function buildSummary(
  snapshot: WorkIntelligenceSnapshot,
  moved: WorkExecutionStateItem[],
  stuck: WorkExecutionStateItem[],
  stale: WorkExecutionStateItem[],
  loadAssessment: WorkExecutionLoadAssessment
): string {
  const movementText =
    moved.length > 0
      ? `${moved.length} thing${moved.length === 1 ? "" : "s"} moved in the current window`
      : "there is little explicit movement logged in the current window";
  const stuckText =
    stuck.length > 0
      ? `${stuck.length} item${stuck.length === 1 ? "" : "s"} look stuck`
      : "there are no obvious wait-state fires";
  const staleText =
    stale.length > 0
      ? `${stale.length} active status${stale.length === 1 ? "" : "es"} look stale or uncertain`
      : "status freshness looks serviceable";

  return `${movementText}, ${stuckText}, and ${staleText}. Load reads ${loadAssessment.status}.`;
}

export function workExecutionStateRead(
  snapshot: WorkIntelligenceSnapshot,
  options: WorkExecutionStateOptions = {}
): WorkExecutionStateRead {
  const whatMoved = buildWhatMoved(snapshot);
  const whatIsStuck = buildWhatIsStuck(snapshot);
  const whatLooksStale = buildWhatLooksStale(snapshot);
  const loadAssessment = buildLoadAssessment(snapshot);
  const topRisk = buildTopRisk(snapshot, loadAssessment);
  const momentum = buildMomentum(snapshot);
  const freshnessSources = buildSnapshotFreshnessSources(snapshot);
  const freshness = buildFreshness(snapshot.generatedAt, freshnessSources);
  const confidence =
    freshness.overall === "stale"
      ? "low"
      : snapshot.coreCounts.statusUncertain >= 3
        ? "low"
        : freshness.overall === "mixed" ||
            snapshot.coreCounts.statusUncertain > 0 ||
            snapshot.coreCounts.quietInProgress > 0 ||
            snapshot.currentSprint === null
          ? "medium"
          : "high";
  const metadata = buildCanonicalMetadata<WorkExecutionStateRawSignals>({
    generatedAt: snapshot.generatedAt,
    freshnessSources,
    caveats: [
      whatLooksStale.length > 0
        ? `${whatLooksStale.length} active task status${whatLooksStale.length === 1 ? "" : "es"} look stale or uncertain, so progress confidence is reduced.`
        : null,
      snapshot.coreCounts.quietInProgress > 0
        ? `${snapshot.coreCounts.quietInProgress} in-progress task${snapshot.coreCounts.quietInProgress === 1 ? "" : "s"} have no fresh movement signal in the current window.`
        : null,
      snapshot.currentSprint === null ? "No current sprint matched this date, so slip detection is task-level only." : null,
    ],
    supportingSignals: [
      {
        kind: "movement",
        summary: `${snapshot.coreCounts.doneToday} done today, ${snapshot.coreCounts.inProgress} still in progress.`,
        relatedTaskIds: snapshot.completedTodayTasks.slice(0, 3).map((task) => task.id),
      },
      {
        kind: "blockers",
        summary: `${snapshot.coreCounts.blocked} blocked or waiting item${snapshot.coreCounts.blocked === 1 ? "" : "s"}.`,
        relatedTaskIds: snapshot.blockedTasks.slice(0, 3).map((task) => task.id),
      },
      {
        kind: "load",
        summary: `Capacity is ${snapshot.capacity.rag} with ${snapshot.remainingEvents.length} remaining meeting${snapshot.remainingEvents.length === 1 ? "" : "s"}.`,
      },
    ],
    confidence,
    includeRawSignals: options.includeRawSignals,
    rawSignals: {
      counts: snapshot.coreCounts,
      remainingMeetings: snapshot.remainingEvents.length,
      followUpRiskTaskIds: snapshot.followUpRiskTasks.map((task) => task.id),
      statusUncertainTaskIds: snapshot.statusUncertainTasks.map((task) => task.id),
      quietInProgressTaskIds: snapshot.quietInProgressTasks.map((task) => task.id),
      rolledOverTaskIds: snapshot.rolledOverTasks.map((task) => task.id),
    },
  });

  return {
    window: snapshot.window,
    summary: buildSummary(snapshot, whatMoved, whatIsStuck, whatLooksStale, loadAssessment),
    topRisk,
    momentum,
    whatMoved,
    whatIsStuck,
    whatLooksStale,
    loadAssessment,
    ...metadata,
  };
}
