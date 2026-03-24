import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReviewSnapshotSummary,
  buildReviewSnapshotTitle,
  upsertReviewSnapshot,
} from "@/lib/briefing/review-snapshots";
import {
  normalizeCommitmentRows,
  type IntelligenceCommitment,
  type IntelligenceImplementation,
  type IntelligenceRiskTask,
} from "@/lib/briefing/intelligence";
import { computeImplementationHealthScores, persistImplementationHealthSnapshots } from "@/lib/health-scores";
import { normalizeDateOnly } from "@/lib/date-only";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { buildCanonicalMetadata, buildFreshness } from "./metadata";
import type { WorkIntelligenceMetadata } from "./types";
import { asRecord, buildReviewPeriodWindow, countDaysSince, getRagSeverity, getSingleRelation, getTodayDateOnlyInTimezone, getWeekStartDate, latestIso, listBusinessDates, summarizeRagTrend, type StoredReviewSnapshotRow } from "./review-support";
import type { ImplementationHealthScore, RagStatus, TaskWithImplementation } from "@/types/database";
import type { WorkEodReviewRead } from "./eod-review";

interface ProjectStatusUpdateRow {
  id: string;
  project_id: string;
  captured_for_date: string;
  summary: string;
  rag: RagStatus | null;
  changes_today: string[];
  blockers: string[];
  next_step: string | null;
  needs_decision: string | null;
  project:
    | { id: string; name: string; stage?: string; rag?: RagStatus }
    | Array<{ id: string; name: string; stage?: string; rag?: RagStatus }>
    | null;
  implementation:
    | { id: string; name: string; phase?: string; rag?: RagStatus; portfolio_rank?: number }
    | Array<{ id: string; name: string; phase?: string; rag?: RagStatus; portfolio_rank?: number }>
    | null;
}

interface CommitmentFreshnessRow {
  id: string;
  title: string;
  direction: string;
  status: string;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  stakeholder:
    | { id: string; name: string }
    | Array<{ id: string; name: string }>
    | null;
  task:
    | { id: string; title: string; status: string; implementation_id: string | null }
    | Array<{ id: string; title: string; status: string; implementation_id: string | null }>
    | null;
}

export interface WeeklyProjectRollup {
  project_id: string;
  project_name: string;
  project_stage: string | null;
  implementation_name: string | null;
  updates_count: number;
  first_update_date: string;
  latest_update_date: string;
  first_rag: RagStatus | null;
  latest_rag: RagStatus | null;
  trend: "improving" | "stable" | "worsening" | "new" | "unknown";
  latest_summary: string;
  latest_next_step: string | null;
  latest_needs_decision: string | null;
  notable_changes: string[];
  notable_blockers: string[];
}

export interface WorkWeeklyReviewPattern {
  label: "clean_progress" | "traction_with_drag" | "drag_outpaced_closure" | "thin_evidence";
  summary: string;
}

export interface WorkWeeklyReviewAggregateItem {
  key: string;
  title: string;
  context: string | null;
  summary: string;
  occurrences: number;
  daysSeen: string[];
  relatedTaskIds: string[];
}

export interface WorkWeeklyReviewRisk {
  key: string;
  label: string;
  summary: string;
  occurrences: number;
  daysSeen: string[];
  relatedTaskIds: string[];
}

export interface WorkWeeklyReviewRawSignals {
  expectedDailyReviewDates: string[];
  storedDailyReviewDates: string[];
  missingDailyReviewDates: string[];
  supplementalFallbackUsed: boolean;
  shippedTaskIds: string[];
  stalledTaskIds: string[];
  pendingDecisionTaskIds: string[];
  coldCommitmentIds: string[];
}

export interface WorkWeeklyReviewRead extends WorkIntelligenceMetadata<WorkWeeklyReviewRawSignals> {
  reviewType: "weekly";
  period: {
    startDate: string;
    endDate: string;
    anchorDate: string;
    timezone: string;
  };
  dailyReviewCount: number;
  weekPattern: WorkWeeklyReviewPattern;
  whatMoved: WorkWeeklyReviewAggregateItem[];
  whatKeptSlipping: WorkWeeklyReviewAggregateItem[];
  recurringRisks: WorkWeeklyReviewRisk[];
  projectRollups: WeeklyProjectRollup[];
  nextWeekCalls: string[];
  narrativeHints: string[];
}

export interface WeeklyReviewRoutePayload {
  week: {
    start_date: string;
    end_date: string;
  };
  shipped: TaskWithImplementation[];
  stalled: TaskWithImplementation[];
  cold_commitments: IntelligenceCommitment[];
  pending_decisions: TaskWithImplementation[];
  project_rollups: WeeklyProjectRollup[];
  projects_needing_attention: WeeklyProjectRollup[];
  project_decisions: WeeklyProjectRollup[];
  health_scores: ImplementationHealthScore[];
  next_week_suggestions: string[];
}

export interface PersistedWeeklyReviewPayload extends WeeklyReviewRoutePayload {
  review: WorkWeeklyReviewRead;
}

export interface WorkWeeklyReviewResult {
  review: WorkWeeklyReviewRead;
  routePayload: WeeklyReviewRoutePayload;
  snapshotPersisted: boolean;
  reviewSnapshotId: string | null;
}

export interface WorkWeeklyReviewReadInput {
  supabase: SupabaseClient;
  userId: string;
  date?: string | null;
  timezone?: string;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
  persist?: boolean;
  now?: Date;
}

interface NormalizedStoredEodReview {
  snapshotId: string;
  requestedDate: string;
  review: WorkEodReviewRead;
  generatedAt: string;
}

interface BuildWorkWeeklyReviewInput {
  startDate: string;
  anchorDate: string;
  timezone: string;
  generatedAt?: string;
  storedDailyReviews: NormalizedStoredEodReview[];
  shipped: TaskWithImplementation[];
  stalled: TaskWithImplementation[];
  pendingDecisions: TaskWithImplementation[];
  coldCommitments: IntelligenceCommitment[];
  projectRollups: WeeklyProjectRollup[];
  projectsNeedingAttention: WeeklyProjectRollup[];
  projectDecisions: WeeklyProjectRollup[];
  healthScores: ImplementationHealthScore[];
  tasksLatestAt: string | null;
  commitmentsLatestAt: string | null;
  projectUpdatesLatestAt: string | null;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
}

function isOverdue(referenceIso: string, dueAt: string | null): boolean {
  if (!dueAt) {
    return false;
  }

  const dueTimestamp = new Date(dueAt).getTime();
  const referenceTimestamp = new Date(referenceIso).getTime();
  if (!Number.isFinite(dueTimestamp) || !Number.isFinite(referenceTimestamp)) {
    return false;
  }

  return dueTimestamp < referenceTimestamp;
}

function isStalledTask(task: TaskWithImplementation, referenceNow: Date, referenceIso: string): boolean {
  if (countDaysSince(referenceNow, task.updated_at) < 7) {
    return false;
  }

  if (task.status === "Blocked/Waiting" || task.status === "In Progress") {
    return true;
  }

  return task.status === "Planned" && isOverdue(referenceIso, task.due_at);
}

function compareAttentionProjects(left: WeeklyProjectRollup, right: WeeklyProjectRollup): number {
  const ragDiff = getRagSeverity(right.latest_rag) - getRagSeverity(left.latest_rag);
  if (ragDiff !== 0) {
    return ragDiff;
  }

  const decisionDiff = Number(Boolean(right.latest_needs_decision)) - Number(Boolean(left.latest_needs_decision));
  if (decisionDiff !== 0) {
    return decisionDiff;
  }

  const blockerDiff = right.notable_blockers.length - left.notable_blockers.length;
  if (blockerDiff !== 0) {
    return blockerDiff;
  }

  return right.latest_update_date.localeCompare(left.latest_update_date) || left.project_name.localeCompare(right.project_name);
}

export function buildProjectRollups(projectUpdates: ProjectStatusUpdateRow[]): WeeklyProjectRollup[] {
  const updatesByProject = new Map<string, ProjectStatusUpdateRow[]>();

  for (const update of projectUpdates) {
    const current = updatesByProject.get(update.project_id) ?? [];
    current.push(update);
    updatesByProject.set(update.project_id, current);
  }

  return [...updatesByProject.entries()]
    .map(([projectId, updates]) => {
      const first = updates[0];
      const latest = updates[updates.length - 1];
      const firstProject = getSingleRelation(first.project);
      const latestProject = getSingleRelation(latest.project);
      const latestImplementation = getSingleRelation(latest.implementation);
      const firstRag = first.rag ?? firstProject?.rag ?? null;
      const latestRag = latest.rag ?? latestProject?.rag ?? null;
      const changes = updates.flatMap((update) => update.changes_today || []);
      const blockers = updates.flatMap((update) => update.blockers || []);

      return {
        project_id: projectId,
        project_name: latestProject?.name ?? firstProject?.name ?? "Unknown project",
        project_stage: latestProject?.stage ?? null,
        implementation_name: latestImplementation?.name ?? null,
        updates_count: updates.length,
        first_update_date: first.captured_for_date,
        latest_update_date: latest.captured_for_date,
        first_rag: firstRag,
        latest_rag: latestRag,
        trend: summarizeRagTrend(firstRag, latestRag, updates.length),
        latest_summary: latest.summary,
        latest_next_step: latest.next_step,
        latest_needs_decision: latest.needs_decision,
        notable_changes: [...new Set(changes)].slice(0, 5),
        notable_blockers: [...new Set(blockers)].slice(0, 5),
      } satisfies WeeklyProjectRollup;
    })
    .sort(compareAttentionProjects);
}

function buildLegacyNextWeekSuggestions(
  referenceNow: Date,
  shipped: TaskWithImplementation[],
  stalled: TaskWithImplementation[],
  pendingDecisions: TaskWithImplementation[],
  coldCommitments: IntelligenceCommitment[],
  projectsNeedingAttention: WeeklyProjectRollup[],
  projectDecisions: WeeklyProjectRollup[]
): string[] {
  const suggestions: string[] = [];

  const pushSuggestion = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized || suggestions.includes(normalized)) {
      return;
    }

    suggestions.push(normalized);
  };

  const topAttentionProject = projectsNeedingAttention[0];
  if (topAttentionProject) {
    if (topAttentionProject.latest_needs_decision) {
      pushSuggestion(`${topAttentionProject.project_name} needs a decision next week: ${topAttentionProject.latest_needs_decision}`);
    } else if (topAttentionProject.latest_next_step) {
      pushSuggestion(`${topAttentionProject.project_name}: ${topAttentionProject.latest_next_step}`);
    } else if (topAttentionProject.notable_blockers[0]) {
      pushSuggestion(`${topAttentionProject.project_name} needs attention: ${topAttentionProject.notable_blockers[0]}`);
    }
  }

  if (projectDecisions.length > 0) {
    pushSuggestion(
      `${projectDecisions[0].project_name} has a pending decision that should be resolved before more work starts.`
    );
  }

  const blockedStalled = stalled
    .filter((task) => task.blocker || task.status === "Blocked/Waiting")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];

  if (blockedStalled) {
    const staleDays = countDaysSince(referenceNow, blockedStalled.updated_at);
    const implementationName = blockedStalled.implementation?.name || "An implementation";
    pushSuggestion(
      `${implementationName} has a blocked task stalled ${staleDays} days (${blockedStalled.title}) - escalate, reassign, or narrow scope.`
    );
  }

  if (pendingDecisions.length > 0) {
    pushSuggestion(`${pendingDecisions.length} task${pendingDecisions.length === 1 ? "" : "s"} need your review before they can move.`);
  }

  if (coldCommitments.length > 0) {
    const oldest = [...coldCommitments].sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    const stakeholderName = oldest?.stakeholder?.name || "A stakeholder";
    pushSuggestion(
      `${stakeholderName} has ${coldCommitments.length} cold incoming commitment${coldCommitments.length === 1 ? "" : "s"} awaiting follow-up.`
    );
  }

  if (suggestions.length < 3 && stalled.length > 0) {
    const oldestStalled = [...stalled].sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
    if (oldestStalled) {
      const staleDays = countDaysSince(referenceNow, oldestStalled.updated_at);
      pushSuggestion(
        `${oldestStalled.title} has not moved in ${staleDays} days - break it down or explicitly park it next week.`
      );
    }
  }

  if (suggestions.length < 3 && shipped.length > 0) {
    pushSuggestion(
      `Carry momentum from ${shipped[0].title} by scheduling the next concrete follow-through while context is still fresh.`
    );
  }

  return suggestions.slice(0, 3);
}

function normalizeStoredEodReview(snapshot: StoredReviewSnapshotRow<Record<string, unknown>>): NormalizedStoredEodReview | null {
  const payload = asRecord(snapshot.payload);
  const reviewRecord = asRecord(payload?.review) ?? payload;
  if (!reviewRecord) {
    return null;
  }

  const requestedDate = typeof reviewRecord.requestedDate === "string" ? reviewRecord.requestedDate : null;
  const generatedAt =
    typeof reviewRecord.generatedAt === "string"
      ? reviewRecord.generatedAt
      : typeof snapshot.updated_at === "string"
        ? snapshot.updated_at
        : snapshot.created_at;

  if (!requestedDate || (reviewRecord.reviewType && reviewRecord.reviewType !== "eod")) {
    return null;
  }

  return {
    snapshotId: snapshot.id,
    requestedDate,
    generatedAt,
    review: reviewRecord as unknown as WorkEodReviewRead,
  };
}

function aggregateWeeklyItems(
  reviews: NormalizedStoredEodReview[],
  pickItems: (review: WorkEodReviewRead) => Array<{ taskId?: string; title?: string; context?: string | null }>,
  summaryBuilder: (title: string, occurrences: number, daysSeen: string[]) => string
): WorkWeeklyReviewAggregateItem[] {
  const aggregate = new Map<string, WorkWeeklyReviewAggregateItem>();

  for (const review of reviews) {
    for (const item of pickItems(review.review)) {
      const title = item.title?.trim();
      if (!title) {
        continue;
      }

      const key = item.taskId ? `task:${item.taskId}` : `title:${title.toLowerCase()}`;
      const existing = aggregate.get(key);
      if (!existing) {
        aggregate.set(key, {
          key,
          title,
          context: item.context ?? null,
          summary: "",
          occurrences: 1,
          daysSeen: [review.requestedDate],
          relatedTaskIds: item.taskId ? [item.taskId] : [],
        });
        continue;
      }

      existing.occurrences += 1;
      if (!existing.daysSeen.includes(review.requestedDate)) {
        existing.daysSeen.push(review.requestedDate);
      }
      if (item.taskId && !existing.relatedTaskIds.includes(item.taskId)) {
        existing.relatedTaskIds.push(item.taskId);
      }
      if (!existing.context && item.context) {
        existing.context = item.context;
      }
    }
  }

  return [...aggregate.values()]
    .map((item) => ({
      ...item,
      daysSeen: [...item.daysSeen].sort(),
      summary: summaryBuilder(item.title, item.occurrences, [...item.daysSeen].sort()),
    }))
    .sort((left, right) => right.occurrences - left.occurrences || right.daysSeen[right.daysSeen.length - 1].localeCompare(left.daysSeen[left.daysSeen.length - 1]) || left.title.localeCompare(right.title))
    .slice(0, 5);
}

function aggregateWeeklyRisks(reviews: NormalizedStoredEodReview[]): WorkWeeklyReviewRisk[] {
  const aggregate = new Map<string, WorkWeeklyReviewRisk>();

  for (const review of reviews) {
    for (const risk of review.review.operatingRisks ?? []) {
      const key = `risk:${risk.label.toLowerCase()}`;
      const existing = aggregate.get(key);
      if (!existing) {
        aggregate.set(key, {
          key,
          label: risk.label,
          summary: "",
          occurrences: 1,
          daysSeen: [review.requestedDate],
          relatedTaskIds: [...(risk.relatedTaskIds ?? [])],
        });
        continue;
      }

      existing.occurrences += 1;
      if (!existing.daysSeen.includes(review.requestedDate)) {
        existing.daysSeen.push(review.requestedDate);
      }
      for (const taskId of risk.relatedTaskIds ?? []) {
        if (!existing.relatedTaskIds.includes(taskId)) {
          existing.relatedTaskIds.push(taskId);
        }
      }
    }

    for (const blocker of review.review.openBlockers ?? []) {
      const key = `blocker:${blocker.taskId}`;
      const existing = aggregate.get(key);
      if (!existing) {
        aggregate.set(key, {
          key,
          label: blocker.title,
          summary: "",
          occurrences: 1,
          daysSeen: [review.requestedDate],
          relatedTaskIds: [blocker.taskId],
        });
        continue;
      }

      existing.occurrences += 1;
      if (!existing.daysSeen.includes(review.requestedDate)) {
        existing.daysSeen.push(review.requestedDate);
      }
    }
  }

  return [...aggregate.values()]
    .map((risk) => ({
      ...risk,
      daysSeen: [...risk.daysSeen].sort(),
      summary:
        risk.key.startsWith("blocker:")
          ? `${risk.label} kept showing up as a blocker on ${risk.occurrences} day${risk.occurrences === 1 ? "" : "s"}, which means the wait state kept surviving close of day.`
          : `${risk.label} showed up on ${risk.occurrences} stored close${risk.occurrences === 1 ? "" : "s"}, so it was not a one-off wobble.`,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function buildWeekPattern(
  coverageRatio: number,
  whatMoved: WorkWeeklyReviewAggregateItem[],
  whatKeptSlipping: WorkWeeklyReviewAggregateItem[],
  recurringRisks: WorkWeeklyReviewRisk[]
): WorkWeeklyReviewPattern {
  if (coverageRatio === 0) {
    return {
      label: "thin_evidence",
      summary: "There is not enough stored day-end coverage to tell a clean weekly story, so this read is leaning back on raw task and project signals.",
    };
  }

  if (whatMoved.length > 0 && whatKeptSlipping.length === 0 && recurringRisks.length <= 1) {
    return {
      label: "clean_progress",
      summary: "The week actually moved. Most of the drag stayed containable instead of swallowing the close.",
    };
  }

  if (whatMoved.length > 0 && whatMoved.length >= whatKeptSlipping.length) {
    return {
      label: "traction_with_drag",
      summary: "There was real forward motion, but the same loose edges kept sneaking back into the close-of-day picture.",
    };
  }

  return {
    label: "drag_outpaced_closure",
    summary: "Too much of the week went to reopening, waiting, and cleanup instead of clean forward motion.",
  };
}

function buildNextWeekCalls(
  whatMoved: WorkWeeklyReviewAggregateItem[],
  whatKeptSlipping: WorkWeeklyReviewAggregateItem[],
  recurringRisks: WorkWeeklyReviewRisk[],
  legacySuggestions: string[],
  projectDecisions: WeeklyProjectRollup[],
  includeNarrativeHints = true
): string[] {
  const calls: string[] = [];

  const push = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized || calls.includes(normalized)) {
      return;
    }

    calls.push(normalized);
  };

  if (whatKeptSlipping[0]) {
    push(`Stop reloading ${whatKeptSlipping[0].title} every day. Narrow it, escalate it, or explicitly park it on Monday.`);
  }

  if (recurringRisks[0]) {
    push(`Clear ${recurringRisks[0].label.toLowerCase()} early next week before it burns another close-of-day cycle.`);
  }

  if (projectDecisions[0]?.latest_needs_decision) {
    push(`${projectDecisions[0].project_name} needs a decision before more work piles onto it: ${projectDecisions[0].latest_needs_decision}`);
  }

  if (whatMoved[0]) {
    push(`Carry the thread from ${whatMoved[0].title} straight into its next concrete move while the context is still warm.`);
  }

  for (const suggestion of legacySuggestions) {
    if (calls.length >= 3) {
      break;
    }
    push(suggestion);
  }

  if (!includeNarrativeHints) {
    return legacySuggestions.slice(0, 3);
  }

  return calls.slice(0, 3);
}

function buildNarrativeHints(
  weekPattern: WorkWeeklyReviewPattern,
  whatMoved: WorkWeeklyReviewAggregateItem[],
  whatKeptSlipping: WorkWeeklyReviewAggregateItem[],
  recurringRisks: WorkWeeklyReviewRisk[],
  nextWeekCalls: string[],
  includeNarrativeHints = true
): string[] {
  if (!includeNarrativeHints) {
    return [];
  }

  const hints = [
    weekPattern.summary,
    whatMoved[0]
      ? `${whatMoved[0].title} was one of the clearest movement threads across the week, so it is worth protecting instead of restarting from scratch.`
      : null,
    whatKeptSlipping[0]
      ? `${whatKeptSlipping[0].title} kept surviving the daily cut, which is usually a sign that the shape of the work is wrong, not just the timing.`
      : null,
    recurringRisks[0]
      ? `${recurringRisks[0].label} was not a one-day wobble. It kept showing back up in the stored closes.`
      : null,
    nextWeekCalls[0] ?? null,
  ];

  return [...new Set(hints.filter((value): value is string => Boolean(value)))].slice(0, 4);
}

function buildSupplementalMovedItems(
  existing: WorkWeeklyReviewAggregateItem[],
  shipped: TaskWithImplementation[]
): WorkWeeklyReviewAggregateItem[] {
  const items = [...existing];
  const seen = new Set(items.map((item) => item.key));

  for (const task of shipped) {
    const key = `task:${task.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push({
      key,
      title: task.title,
      context: task.implementation?.name ?? task.project?.name ?? null,
      summary: "Closed in the weekly raw read, but there was no stored EOD artifact carrying the fuller close story.",
      occurrences: 1,
      daysSeen: [task.updated_at.slice(0, 10)],
      relatedTaskIds: [task.id],
    });

    if (items.length >= 5) {
      break;
    }
  }

  return items.slice(0, 5);
}

function buildSupplementalSlipItems(
  existing: WorkWeeklyReviewAggregateItem[],
  stalled: TaskWithImplementation[],
  pendingDecisions: TaskWithImplementation[]
): WorkWeeklyReviewAggregateItem[] {
  const items = [...existing];
  const seen = new Set(items.map((item) => item.key));

  for (const task of [...stalled, ...pendingDecisions]) {
    const key = `task:${task.id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push({
      key,
      title: task.title,
      context: task.implementation?.name ?? task.project?.name ?? null,
      summary: "Still looks unresolved in the weekly raw read, which usually means it kept surviving the daily cut.",
      occurrences: 1,
      daysSeen: [task.updated_at.slice(0, 10)],
      relatedTaskIds: [task.id],
    });

    if (items.length >= 5) {
      break;
    }
  }

  return items.slice(0, 5);
}

function buildSupplementalRisks(
  existing: WorkWeeklyReviewRisk[],
  coldCommitments: IntelligenceCommitment[],
  projectsNeedingAttention: WeeklyProjectRollup[]
): WorkWeeklyReviewRisk[] {
  const risks = [...existing];
  const seen = new Set(risks.map((risk) => risk.key));

  if (coldCommitments.length > 0 && !seen.has("commitments:cold")) {
    risks.push({
      key: "commitments:cold",
      label: "Cold incoming commitments",
      summary: `${coldCommitments.length} incoming commitment${coldCommitments.length === 1 ? "" : "s"} still need attention, which means follow-through softness is already building.`,
      occurrences: 1,
      daysSeen: [],
      relatedTaskIds: coldCommitments.flatMap((commitment) => (commitment.task?.id ? [commitment.task.id] : [])),
    });
  }

  for (const project of projectsNeedingAttention) {
    const key = `project:${project.project_id}`;
    if (seen.has(key)) {
      continue;
    }

    risks.push({
      key,
      label: project.project_name,
      summary: project.latest_needs_decision
        ? `${project.project_name} is still carrying an unresolved decision: ${project.latest_needs_decision}`
        : project.notable_blockers[0]
          ? `${project.project_name} kept carrying blocker pressure: ${project.notable_blockers[0]}`
          : `${project.project_name} stayed in the attention pile all week.`,
      occurrences: 1,
      daysSeen: [project.latest_update_date],
      relatedTaskIds: [],
    });

    if (risks.length >= 5) {
      break;
    }
  }

  return risks.slice(0, 5);
}

export function buildWorkWeeklyReview(input: BuildWorkWeeklyReviewInput): WorkWeeklyReviewRead {
  const period = buildReviewPeriodWindow(input.anchorDate, input.startDate, input.timezone);
  const generatedAt =
    input.generatedAt ??
    latestIso([
      ...input.storedDailyReviews.map((review) => review.generatedAt),
      input.projectUpdatesLatestAt,
      input.tasksLatestAt,
      input.commitmentsLatestAt,
    ]) ??
    new Date().toISOString();
  const expectedDailyReviewDates = listBusinessDates(input.startDate, input.anchorDate);
  const storedDailyReviewDates = [...new Set(input.storedDailyReviews.map((review) => review.requestedDate))].sort();
  const missingDailyReviewDates = expectedDailyReviewDates.filter((dateOnly) => !storedDailyReviewDates.includes(dateOnly));
  const coverageRatio = expectedDailyReviewDates.length > 0 ? storedDailyReviewDates.length / expectedDailyReviewDates.length : 1;
  const supplementalFallbackUsed = missingDailyReviewDates.length > 0 || storedDailyReviewDates.length === 0;

  const movedFromDaily = aggregateWeeklyItems(
    input.storedDailyReviews,
    (review) => review.completedToday ?? [],
    (title, occurrences) =>
      occurrences > 1
        ? `${title} showed up as real movement on ${occurrences} stored closes, which means it carried through more than one day cleanly.`
        : `${title} landed cleanly in one stored day-end close.`
  );
  const slippingFromDaily = aggregateWeeklyItems(
    input.storedDailyReviews,
    (review) => review.rolledForward ?? [],
    (title, occurrences) =>
      occurrences > 1
        ? `${title} rolled across ${occurrences} closes, so it kept surviving the daily cut instead of actually getting cleared.`
        : `${title} still rolled at close, which puts it on next week's watch list.`
  );
  const recurringRisksFromDaily = aggregateWeeklyRisks(input.storedDailyReviews);

  const whatMoved = buildSupplementalMovedItems(movedFromDaily, input.shipped);
  const whatKeptSlipping = buildSupplementalSlipItems(slippingFromDaily, input.stalled, input.pendingDecisions);
  const recurringRisks = buildSupplementalRisks(recurringRisksFromDaily, input.coldCommitments, input.projectsNeedingAttention);
  const weekPattern = buildWeekPattern(coverageRatio, whatMoved, whatKeptSlipping, recurringRisks);
  const legacySuggestions = buildLegacyNextWeekSuggestions(
    new Date(input.anchorDate + "T23:59:59.999Z"),
    input.shipped,
    input.stalled,
    input.pendingDecisions,
    input.coldCommitments,
    input.projectsNeedingAttention,
    input.projectDecisions
  );
  const nextWeekCalls = buildNextWeekCalls(
    whatMoved,
    whatKeptSlipping,
    recurringRisks,
    legacySuggestions,
    input.projectDecisions,
    input.includeNarrativeHints
  );
  const freshnessSources = [
    {
      source: "eod_reviews",
      latestAt: latestIso(input.storedDailyReviews.map((review) => review.generatedAt)),
      staleAfterHours: 168,
      required: true,
    },
    {
      source: "project_status_updates",
      latestAt: input.projectUpdatesLatestAt,
      staleAfterHours: 168,
      allowMissing: true,
    },
    {
      source: "tasks",
      latestAt: input.tasksLatestAt,
      staleAfterHours: 120,
      allowMissing: true,
    },
    {
      source: "commitments",
      latestAt: input.commitmentsLatestAt,
      staleAfterHours: 120,
      allowMissing: true,
    },
  ];
  const freshness = buildFreshness(generatedAt, freshnessSources);
  const confidence =
    freshness.overall === "stale" || coverageRatio < 0.6
      ? "low"
      : coverageRatio < 1 || recurringRisks.length > 0 || missingDailyReviewDates.length > 0
        ? "medium"
        : "high";
  const metadata = buildCanonicalMetadata<WorkWeeklyReviewRawSignals>({
    generatedAt,
    freshnessSources,
    caveats: [
      storedDailyReviewDates.length === 0
        ? "No stored EOD reviews existed for this window, so the weekly read had to lean mostly on raw operational signals."
        : missingDailyReviewDates.length > 0
          ? `${missingDailyReviewDates.length} business day${missingDailyReviewDates.length === 1 ? "" : "s"} had no stored EOD review, so parts of the week were supplemented from raw data.`
          : null,
      input.projectRollups.length === 0 ? "No project status updates were captured in this review window." : null,
    ],
    supportingSignals: [
      {
        kind: "daily_review_coverage",
        summary: `${storedDailyReviewDates.length}/${expectedDailyReviewDates.length || 0} expected stored EOD review${expectedDailyReviewDates.length === 1 ? "" : "s"} were available for the week.`,
      },
      {
        kind: "movement",
        summary: `${whatMoved.length} clear movement thread${whatMoved.length === 1 ? "" : "s"} stood out across the week.`,
        relatedTaskIds: whatMoved.flatMap((item) => item.relatedTaskIds).slice(0, 5),
      },
      {
        kind: "slip",
        summary: `${whatKeptSlipping.length} item${whatKeptSlipping.length === 1 ? "" : "s"} kept slipping or staying unresolved.`,
        relatedTaskIds: whatKeptSlipping.flatMap((item) => item.relatedTaskIds).slice(0, 5),
      },
      {
        kind: "project_pressure",
        summary: `${input.projectsNeedingAttention.length} project${input.projectsNeedingAttention.length === 1 ? "" : "s"} still need explicit attention.`,
      },
    ],
    confidence,
    includeRawSignals: input.includeRawSignals,
    rawSignals: {
      expectedDailyReviewDates,
      storedDailyReviewDates,
      missingDailyReviewDates,
      supplementalFallbackUsed,
      shippedTaskIds: input.shipped.map((task) => task.id),
      stalledTaskIds: input.stalled.map((task) => task.id),
      pendingDecisionTaskIds: input.pendingDecisions.map((task) => task.id),
      coldCommitmentIds: input.coldCommitments.map((commitment) => commitment.id),
    },
  });

  return {
    reviewType: "weekly",
    period,
    dailyReviewCount: input.storedDailyReviews.length,
    weekPattern,
    whatMoved,
    whatKeptSlipping,
    recurringRisks,
    projectRollups: input.projectRollups,
    nextWeekCalls,
    narrativeHints: buildNarrativeHints(
      weekPattern,
      whatMoved,
      whatKeptSlipping,
      recurringRisks,
      nextWeekCalls,
      input.includeNarrativeHints
    ),
    ...metadata,
  };
}

export async function workWeeklyReviewRead(input: WorkWeeklyReviewReadInput): Promise<WorkWeeklyReviewResult> {
  const timezone = input.timezone?.trim() || DEFAULT_WORKDAY_CONFIG.timezone;
  const baseNow = input.now ?? new Date();
  const anchorDate = normalizeDateOnly(input.date ?? getTodayDateOnlyInTimezone(baseNow, timezone));
  if (!anchorDate) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const startDate = getWeekStartDate(anchorDate);
  const referenceNow = new Date(`${anchorDate}T23:59:59.999Z`);
  const referenceIso = referenceNow.toISOString();

  const [taskResult, commitmentResult, implementationResult, projectStatusResult, eodSnapshotResult] = await Promise.all([
    input.supabase
      .from("tasks")
      .select("*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date)")
      .eq("user_id", input.userId)
      .order("updated_at", { ascending: false }),
    input.supabase
      .from("commitments")
      .select("id, title, direction, status, due_at, created_at, updated_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status, implementation_id)")
      .eq("user_id", input.userId)
      .eq("status", "Open"),
    input.supabase
      .from("implementations")
      .select("*")
      .eq("user_id", input.userId)
      .order("name", { ascending: true }),
    input.supabase
      .from("project_status_updates")
      .select(
        "id, project_id, captured_for_date, summary, rag, changes_today, blockers, next_step, needs_decision, project:projects(id, name, stage, rag), implementation:implementations(id, name, phase, rag, portfolio_rank)"
      )
      .eq("user_id", input.userId)
      .gte("captured_for_date", startDate)
      .lte("captured_for_date", anchorDate)
      .order("captured_for_date", { ascending: true })
      .order("updated_at", { ascending: true }),
    input.supabase
      .from("briefing_review_snapshots")
      .select("id, review_type, anchor_date, period_start, period_end, title, summary, source, payload, created_at, updated_at")
      .eq("user_id", input.userId)
      .eq("review_type", "eod")
      .gte("period_end", startDate)
      .lte("period_start", anchorDate)
      .order("period_end", { ascending: true }),
  ]);

  if (taskResult.error) {
    throw taskResult.error;
  }
  if (commitmentResult.error) {
    throw commitmentResult.error;
  }
  if (implementationResult.error) {
    throw implementationResult.error;
  }
  if (projectStatusResult.error) {
    throw projectStatusResult.error;
  }
  if (eodSnapshotResult.error) {
    throw eodSnapshotResult.error;
  }

  const allTasks = (taskResult.data || []) as TaskWithImplementation[];
  const commitmentRows = (commitmentResult.data || []) as CommitmentFreshnessRow[];
  const openCommitments = normalizeCommitmentRows(commitmentRows as unknown[]) as IntelligenceCommitment[];
  const implementations = (implementationResult.data || []) as IntelligenceImplementation[];
  const projectUpdates = (projectStatusResult.data || []) as ProjectStatusUpdateRow[];
  const storedDailyReviews = ((eodSnapshotResult.data || []) as StoredReviewSnapshotRow<Record<string, unknown>>[])
    .map(normalizeStoredEodReview)
    .filter((review): review is NormalizedStoredEodReview => review !== null);

  const shipped = allTasks
    .filter((task) => task.status === "Done" && task.updated_at >= `${startDate}T00:00:00.000Z` && task.updated_at <= referenceIso)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const stalled = allTasks
    .filter((task) => isStalledTask(task, referenceNow, referenceIso))
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  const pendingDecisions = allTasks
    .filter((task) => task.status !== "Done" && task.status !== "Parked" && task.needs_review)
    .sort((left, right) => {
      if (right.priority_score !== left.priority_score) {
        return right.priority_score - left.priority_score;
      }
      return left.updated_at.localeCompare(right.updated_at);
    });
  const coldCommitments = openCommitments
    .filter((commitment) => commitment.direction === "theirs")
    .filter((commitment) => countDaysSince(referenceNow, commitment.created_at) >= 5)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  const { scores: healthScores, snapshots } = computeImplementationHealthScores(
    implementations,
    allTasks as IntelligenceRiskTask[],
    openCommitments,
    referenceNow
  );
  await persistImplementationHealthSnapshots(input.supabase, input.userId, snapshots);

  const projectRollups = buildProjectRollups(projectUpdates);
  const projectsNeedingAttention = projectRollups.filter(
    (project) =>
      project.latest_rag === "Red" ||
      project.latest_rag === "Yellow" ||
      Boolean(project.latest_needs_decision) ||
      project.notable_blockers.length > 0
  );
  const projectDecisions = projectsNeedingAttention.filter((project) => Boolean(project.latest_needs_decision));

  const review = buildWorkWeeklyReview({
    startDate,
    anchorDate,
    timezone,
    generatedAt: baseNow.toISOString(),
    storedDailyReviews,
    shipped,
    stalled,
    pendingDecisions,
    coldCommitments,
    projectRollups,
    projectsNeedingAttention,
    projectDecisions,
    healthScores,
    tasksLatestAt: latestIso(allTasks.map((task) => task.updated_at)),
    commitmentsLatestAt: latestIso(commitmentRows.map((row) => row.updated_at ?? row.created_at)),
    projectUpdatesLatestAt: latestIso(projectUpdates.map((update) => `${update.captured_for_date}T23:59:59.999Z`)),
    includeRawSignals: input.includeRawSignals,
    includeNarrativeHints: input.includeNarrativeHints,
  });

  const routePayload: WeeklyReviewRoutePayload = {
    week: {
      start_date: startDate,
      end_date: anchorDate,
    },
    shipped,
    stalled,
    cold_commitments: coldCommitments,
    pending_decisions: pendingDecisions,
    project_rollups: projectRollups,
    projects_needing_attention: projectsNeedingAttention,
    project_decisions: projectDecisions,
    health_scores: healthScores,
    next_week_suggestions: review.nextWeekCalls,
  };

  let reviewSnapshotId: string | null = null;
  if (input.persist) {
    const payload: PersistedWeeklyReviewPayload = {
      ...routePayload,
      review,
    };
    const snapshot = await upsertReviewSnapshot(input.supabase, {
      userId: input.userId,
      reviewType: "weekly",
      anchorDate,
      periodStart: startDate,
      periodEnd: anchorDate,
      title: buildReviewSnapshotTitle("weekly", startDate, anchorDate),
      summary: buildReviewSnapshotSummary("weekly", payload as unknown as Record<string, unknown>),
      source: "system",
      payload: payload as unknown as Record<string, unknown>,
    });

    reviewSnapshotId = snapshot.id;
  }

  return {
    review,
    routePayload,
    snapshotPersisted: Boolean(input.persist),
    reviewSnapshotId,
  };
}
