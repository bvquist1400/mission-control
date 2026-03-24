import { buildCanonicalMetadata, buildFreshness } from "./metadata";
import {
  buildSnapshotFreshnessSources,
  buildTaskContextLabel,
  compareByPriorityThenUpdate,
} from "./snapshot";
import type {
  WorkIntelligenceMetadata,
  WorkIntelligenceSnapshot,
  WorkIntelligenceTask,
  WorkIntelligenceWindow,
} from "./types";

interface PriorityScoreComponent {
  label: string;
  delta: number;
  reason: string;
}

interface RankedPriorityTask {
  task: WorkIntelligenceTask;
  score: number;
  whyNow: string[];
  riskIfIgnored: string;
  recommendedAction: "finish" | "advance" | "follow_up" | "protect";
  statusUncertain: boolean;
  scoreBreakdown: PriorityScoreComponent[];
}

export interface WorkPriorityStackItem {
  taskId: string;
  title: string;
  rank: number;
  recommendedAction: RankedPriorityTask["recommendedAction"];
  whyNow: string[];
  riskIfIgnored: string;
  context: string | null;
  statusFreshness: {
    updatedAt: string;
    stale: boolean;
  };
}

export interface WorkPriorityDeferredItem {
  taskId: string;
  title: string;
  reason: string;
  context: string | null;
}

export interface WorkPriorityStackRawSignals {
  noSingleDominantPriority: boolean;
  topScoreGap: number | null;
  topItems: Array<{
    taskId: string;
    score: number;
    scoreBreakdown: PriorityScoreComponent[];
  }>;
  deferForNowTaskIds: string[];
}

export interface WorkPriorityStackRead extends WorkIntelligenceMetadata<WorkPriorityStackRawSignals> {
  window: WorkIntelligenceWindow;
  topItems: WorkPriorityStackItem[];
  deferForNow: WorkPriorityDeferredItem[];
  primaryTradeoff: string | null;
}

export interface WorkPriorityStackOptions {
  limit?: number;
  includeRawSignals?: boolean;
  includeDeferredButImportant?: boolean;
}

function describeStatusRisk(task: WorkIntelligenceTask, statusUncertain: boolean): string {
  if (task.status === "Blocked/Waiting") {
    return task.waiting_on ? `The wait state on ${task.waiting_on} will keep aging.` : "The blocked state will keep sitting.";
  }

  if (task.due_at) {
    return "Delivery drift gets harder to recover the longer this sits.";
  }

  if (statusUncertain) {
    return "The status already looks stale, so delay increases ambiguity and restart cost.";
  }

  return "Restart cost and context loss go up if this slips again.";
}

function buildDuePressureComponent(task: WorkIntelligenceTask, nowMs: number): PriorityScoreComponent | null {
  const dueMs = task.due_at ? new Date(task.due_at).getTime() : Number.NaN;
  if (!Number.isFinite(dueMs)) {
    return null;
  }

  if (dueMs < nowMs) {
    return { label: "overdue pressure", delta: 35, reason: "Already overdue." };
  }

  if (dueMs <= nowMs + (24 * 60 * 60 * 1000)) {
    return { label: "due within 24h", delta: 28, reason: "Due within 24 hours." };
  }

  if (dueMs <= nowMs + (48 * 60 * 60 * 1000)) {
    return { label: "due within 48h", delta: 18, reason: "Due within 48 hours." };
  }

  return null;
}

function buildExecutionMomentumComponent(
  task: WorkIntelligenceTask,
  quietInProgressTaskIds: Set<string>
): PriorityScoreComponent | null {
  if (task.status !== "In Progress") {
    return null;
  }

  if (quietInProgressTaskIds.has(task.id)) {
    return {
      label: "active thread with thin movement",
      delta: 10,
      reason: "Already in progress, but recent movement is thin.",
    };
  }

  return { label: "active momentum", delta: 18, reason: "Already in motion." };
}

function buildExplicitBlockerComponent(task: WorkIntelligenceTask): PriorityScoreComponent | null {
  if (!task.blocker) {
    return null;
  }

  return { label: "explicit blocker", delta: 8, reason: "Marked as a blocker." };
}

function buildWaitStateComponent(
  task: WorkIntelligenceTask,
  followUpRiskTaskIds: Set<string>
): PriorityScoreComponent | null {
  if (task.status !== "Blocked/Waiting") {
    return null;
  }

  if (followUpRiskTaskIds.has(task.id)) {
    return task.follow_up_at
      ? { label: "follow-up due", delta: 16, reason: "Follow-up date has passed." }
      : { label: "follow-up risk", delta: 12, reason: "Waiting thread has aged past the follow-up threshold." };
  }

  if (task.waiting_on) {
    return {
      label: "external wait",
      delta: -18,
      reason: `Currently waiting on ${task.waiting_on}.`,
    };
  }

  return { label: "blocked", delta: -12, reason: "Blocked until there is a clear next move." };
}

function buildSprintPressureComponent(
  snapshot: WorkIntelligenceSnapshot,
  task: WorkIntelligenceTask
): PriorityScoreComponent | null {
  if (!snapshot.sprintSummary || snapshot.sprintSummary.on_track || task.sprint_id !== snapshot.sprintSummary.id) {
    return null;
  }

  return {
    label: "sprint slip pressure",
    delta: 10,
    reason: `${snapshot.sprintSummary.name} is off pace.`,
  };
}

function buildStatusUncertaintyComponent(
  task: WorkIntelligenceTask,
  statusUncertainTaskIds: Set<string>
): PriorityScoreComponent | null {
  if (!statusUncertainTaskIds.has(task.id)) {
    return null;
  }

  return {
    label: "status uncertainty",
    delta: -6,
    reason: task.status === "In Progress" ? "Current status may be lagging reality." : "Status may be stale.",
  };
}

function buildPriorityCandidate(
  snapshot: WorkIntelligenceSnapshot,
  task: WorkIntelligenceTask,
  statusUncertainTaskIds: Set<string>,
  followUpRiskTaskIds: Set<string>,
  quietInProgressTaskIds: Set<string>
): RankedPriorityTask {
  const scoreBreakdown: PriorityScoreComponent[] = [
    { label: "base priority", delta: task.priority_score, reason: "Baseline task priority score." },
  ];
  const components = [
    buildDuePressureComponent(task, snapshot.now.getTime()),
    buildExecutionMomentumComponent(task, quietInProgressTaskIds),
    buildExplicitBlockerComponent(task),
    buildWaitStateComponent(task, followUpRiskTaskIds),
    buildSprintPressureComponent(snapshot, task),
    buildStatusUncertaintyComponent(task, statusUncertainTaskIds),
  ].filter((component): component is PriorityScoreComponent => component !== null);
  const whyNow = components.map((component) => component.reason);
  const statusUncertain = statusUncertainTaskIds.has(task.id);

  scoreBreakdown.push(...components);
  const score = scoreBreakdown.reduce((sum, component) => sum + component.delta, 0);
  const recommendedAction =
    task.status === "Blocked/Waiting" ? "follow_up" : task.status === "In Progress" ? "finish" : task.due_at ? "protect" : "advance";

  return {
    task,
    score,
    whyNow,
    riskIfIgnored: describeStatusRisk(task, statusUncertain),
    recommendedAction,
    statusUncertain,
    scoreBreakdown,
  };
}

function buildDeferredItem(task: WorkIntelligenceTask, reason: string): WorkPriorityDeferredItem {
  return {
    taskId: task.id,
    title: task.title,
    reason,
    context: buildTaskContextLabel(task),
  };
}

function getTopScoreGap(ranked: RankedPriorityTask[]): number | null {
  if (!ranked[0] || !ranked[1]) {
    return null;
  }

  return ranked[0].score - ranked[1].score;
}

function hasNoSingleDominantPriority(ranked: RankedPriorityTask[]): boolean {
  const gap = getTopScoreGap(ranked);
  return gap !== null && gap <= 6;
}

function buildPrimaryTradeoff(
  topItems: WorkPriorityStackItem[],
  snapshot: WorkIntelligenceSnapshot,
  noSingleDominantPriority: boolean
): string | null {
  const [first, second] = topItems;

  if (!first && snapshot.openTasks.length > 0) {
    return "No single dominant priority. Protect the active thread and avoid opening new fronts until the state is cleaner.";
  }

  if (!first) {
    return null;
  }

  if (noSingleDominantPriority && second) {
    return `No single dominant priority. ${first.title} and ${second.title} are effectively tied, so pick the cleaner next move and avoid splitting attention.`;
  }

  if (snapshot.capacity.rag !== "Green" && second) {
    return `Finish ${first.title} before opening ${second.title}; the current load does not support both cleanly.`;
  }

  if (first.recommendedAction === "follow_up" && second) {
    return `Clear the wait state on ${first.title} before pulling more delivery work forward.`;
  }

  if (!second) {
    return null;
  }

  return `Protect ${first.title} first, then decide whether ${second.title} still deserves active attention.`;
}

export function workPriorityStackRead(
  snapshot: WorkIntelligenceSnapshot,
  options: WorkPriorityStackOptions = {}
): WorkPriorityStackRead {
  const limit = Math.max(1, options.limit ?? 5);
  const statusUncertainTaskIds = new Set(snapshot.statusUncertainTasks.map((task) => task.id));
  const followUpRiskTaskIds = new Set(snapshot.followUpRiskTasks.map((task) => task.id));
  const quietInProgressTaskIds = new Set(snapshot.quietInProgressTasks.map((task) => task.id));
  const ranked = snapshot.openTasks
    .map((task) =>
      buildPriorityCandidate(snapshot, task, statusUncertainTaskIds, followUpRiskTaskIds, quietInProgressTaskIds)
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return compareByPriorityThenUpdate(left.task, right.task);
    });
  const noSingleDominantPriority = hasNoSingleDominantPriority(ranked);
  const topScoreGap = getTopScoreGap(ranked);

  const topItems = ranked.slice(0, limit).map((item, index) => ({
    taskId: item.task.id,
    title: item.task.title,
    rank: index + 1,
    recommendedAction: item.recommendedAction,
    whyNow: item.whyNow.length > 0 ? item.whyNow : ["High-leverage work in the current stack."],
    riskIfIgnored: item.riskIfIgnored,
    context: buildTaskContextLabel(item.task),
    statusFreshness: {
      updatedAt: item.task.updated_at,
      stale: item.statusUncertain,
    },
  }));

  const topTaskIds = new Set(topItems.map((item) => item.taskId));
  const deferReasons = new Map<string, string>();

  if (options.includeDeferredButImportant !== false) {
    for (const task of snapshot.blockedTasks) {
      if (!topTaskIds.has(task.id) && task.waiting_on && (!task.follow_up_at || new Date(task.follow_up_at).getTime() > snapshot.now.getTime())) {
        deferReasons.set(task.id, `Important, but it is still waiting on ${task.waiting_on} and does not need another touch yet.`);
      }
    }

    if (snapshot.capacity.rag !== "Green") {
      const overflowCandidates = snapshot.openTasks
        .filter((task) => !topTaskIds.has(task.id) && task.status === "Planned")
        .sort(compareByPriorityThenUpdate)
        .slice(0, limit);

      for (const task of overflowCandidates) {
        deferReasons.set(task.id, "Potentially important, but the current day is already overloaded.");
      }
    }
  }

  const deferForNow = snapshot.openTasks
    .filter((task) => deferReasons.has(task.id))
    .slice(0, limit)
    .map((task) => buildDeferredItem(task, deferReasons.get(task.id) ?? "Lower leverage right now."));

  const freshnessSources = buildSnapshotFreshnessSources(snapshot);
  const freshness = buildFreshness(snapshot.generatedAt, freshnessSources);
  const confidence =
    freshness.overall === "stale"
      ? "low"
      : snapshot.coreCounts.statusUncertain >= 4
        ? "low"
        : freshness.overall === "mixed" || snapshot.coreCounts.statusUncertain > 0 || snapshot.capacity.rag !== "Green"
          ? "medium"
          : "high";
  const metadata = buildCanonicalMetadata<WorkPriorityStackRawSignals>({
    generatedAt: snapshot.generatedAt,
    freshnessSources,
    caveats: [
      snapshot.coreCounts.statusUncertain >= 3
        ? `${snapshot.coreCounts.statusUncertain} active task statuses look stale or uncertain, so the rank order is less certain below the top few items.`
        : null,
      snapshot.capacity.rag !== "Green"
        ? `The day is already ${snapshot.capacity.rag === "Red" ? "over" : "near"} capacity, so lower-ranked work is easier to defer.`
        : null,
    ],
    supportingSignals: [
      {
        kind: "due_soon",
        summary: `${snapshot.coreCounts.dueSoon} task${snapshot.coreCounts.dueSoon === 1 ? "" : "s"} due within 48 hours.`,
        relatedTaskIds: snapshot.dueSoonTasks.slice(0, 3).map((task) => task.id),
      },
      {
        kind: "in_progress",
        summary: `${snapshot.coreCounts.inProgress} active thread${snapshot.coreCounts.inProgress === 1 ? "" : "s"} already in motion.`,
        relatedTaskIds: snapshot.inProgressTasks.slice(0, 3).map((task) => task.id),
      },
      {
        kind: "capacity",
        summary: `Capacity is ${snapshot.capacity.rag} at ${snapshot.capacity.required_minutes}/${snapshot.capacity.available_minutes} minutes.`,
      },
    ],
    confidence,
    includeRawSignals: options.includeRawSignals,
    rawSignals: {
      noSingleDominantPriority,
      topScoreGap,
      topItems: ranked.slice(0, limit).map((item) => ({
        taskId: item.task.id,
        score: item.score,
        scoreBreakdown: item.scoreBreakdown,
      })),
      deferForNowTaskIds: deferForNow.map((item) => item.taskId),
    },
  });

  return {
    window: snapshot.window,
    topItems,
    deferForNow,
    primaryTradeoff: buildPrimaryTradeoff(topItems, snapshot, noSingleDominantPriority),
    ...metadata,
  };
}
