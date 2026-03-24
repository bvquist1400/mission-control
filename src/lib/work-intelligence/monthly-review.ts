import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReviewSnapshotSummary,
  buildReviewSnapshotTitle,
  upsertReviewSnapshot,
} from "@/lib/briefing/review-snapshots";
import { normalizeDateOnly } from "@/lib/date-only";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { buildCanonicalMetadata, buildFreshness } from "./metadata";
import { asRecord, buildReviewPeriodWindow, getMonthStartDate, getRagSeverity, getSingleRelation, getTodayDateOnlyInTimezone, latestIso, listWeekStartDates, summarizeRagTrend, type StoredReviewSnapshotRow } from "./review-support";
import type { WorkIntelligenceMetadata } from "./types";
import type { RagStatus } from "@/types/database";
import type { WeeklyProjectRollup, WeeklyReviewRoutePayload, WorkWeeklyReviewPattern, WorkWeeklyReviewRead } from "./weekly-review";

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
    | { id: string; name: string; stage: string; rag: RagStatus }
    | Array<{ id: string; name: string; stage: string; rag: RagStatus }>
    | null;
}

export interface MonthlyProjectRollup {
  project_id: string;
  project_name: string;
  project_stage: string | null;
  updates_count: number;
  first_update_date: string;
  latest_update_date: string;
  first_rag: RagStatus | null;
  latest_rag: RagStatus | null;
  trend: "improving" | "stable" | "worsening" | "unknown";
  blocker_days: number;
  decision_days: number;
  latest_summary: string;
  latest_next_step: string | null;
  latest_needs_decision: string | null;
  notable_changes: string[];
  notable_blockers: string[];
}

export interface WorkMonthlyReviewPattern {
  label: "steady_climb" | "mixed_month" | "pressure_month" | "thin_evidence";
  summary: string;
}

export interface WorkMonthlyDirectionChange {
  key: string;
  label: string;
  summary: string;
  relatedProjectIds: string[];
}

export interface WorkMonthlyPressurePoint {
  key: string;
  label: string;
  summary: string;
  occurrences: number;
  weeksSeen: string[];
  relatedTaskIds: string[];
}

export interface WorkMonthlyReviewRawSignals {
  expectedWeekStartDates: string[];
  storedWeekStartDates: string[];
  missingWeekStartDates: string[];
  supplementalFallbackUsed: boolean;
  weeklySnapshotIds: string[];
}

export interface WorkMonthlyReviewRead extends WorkIntelligenceMetadata<WorkMonthlyReviewRawSignals> {
  reviewType: "monthly";
  period: {
    startDate: string;
    endDate: string;
    anchorDate: string;
    timezone: string;
  };
  weeklyReviewCount: number;
  monthPattern: WorkMonthlyReviewPattern;
  directionChanges: WorkMonthlyDirectionChange[];
  recurringPressurePoints: WorkMonthlyPressurePoint[];
  projectRollups: MonthlyProjectRollup[];
  nextMonthCalls: string[];
  narrativeHints: string[];
}

export interface MonthlyReviewRoutePayload {
  month: {
    start_date: string;
    end_date: string;
  };
  totals: {
    weekly_snapshot_count: number;
    project_status_update_count: number;
    projects_with_updates: number;
    shipped_count: number;
    stalled_count: number;
    pending_decision_count: number;
  };
  weekly_snapshots: Array<{
    id: string;
    review_type: string;
    period_start: string;
    period_end: string;
    title: string;
    summary: string;
    source: string;
    payload: Record<string, unknown>;
  }>;
  project_rollups: MonthlyProjectRollup[];
}

export interface PersistedMonthlyReviewPayload extends MonthlyReviewRoutePayload {
  review: WorkMonthlyReviewRead;
}

export interface WorkMonthlyReviewResult {
  review: WorkMonthlyReviewRead;
  routePayload: MonthlyReviewRoutePayload;
  snapshotPersisted: boolean;
  reviewSnapshotId: string | null;
}

export interface WorkMonthlyReviewReadInput {
  supabase: SupabaseClient;
  userId: string;
  date?: string | null;
  timezone?: string;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
  persist?: boolean;
  now?: Date;
}

interface NormalizedStoredWeeklyReview {
  snapshotId: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  review: WorkWeeklyReviewRead;
  legacyPayload: WeeklyReviewRoutePayload | null;
  rawSnapshot: {
    id: string;
    review_type: string;
    period_start: string;
    period_end: string;
    title: string;
    summary: string;
    source: string;
    payload: Record<string, unknown>;
  };
}

interface BuildWorkMonthlyReviewInput {
  monthStart: string;
  anchorDate: string;
  timezone: string;
  generatedAt?: string;
  weeklyReviews: NormalizedStoredWeeklyReview[];
  projectRollups: MonthlyProjectRollup[];
  projectUpdatesLatestAt: string | null;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
}

function summarizeTrend(first: RagStatus | null, latest: RagStatus | null): "improving" | "stable" | "worsening" | "unknown" {
  const firstSeverity = getRagSeverity(first);
  const latestSeverity = getRagSeverity(latest);

  if (firstSeverity < 0 || latestSeverity < 0) {
    return "unknown";
  }

  if (latestSeverity < firstSeverity) {
    return "improving";
  }

  if (latestSeverity > firstSeverity) {
    return "worsening";
  }

  return "stable";
}

export function buildMonthlyProjectRollups(projectUpdates: ProjectStatusUpdateRow[]): MonthlyProjectRollup[] {
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
      const firstRag = first.rag ?? firstProject?.rag ?? null;
      const latestRag = latest.rag ?? latestProject?.rag ?? null;
      const changes = updates.flatMap((update) => update.changes_today || []).slice(0, 8);
      const blockers = updates.flatMap((update) => update.blockers || []).slice(0, 8);

      return {
        project_id: projectId,
        project_name: latestProject?.name ?? firstProject?.name ?? "Unknown project",
        project_stage: latestProject?.stage ?? null,
        updates_count: updates.length,
        first_update_date: first.captured_for_date,
        latest_update_date: latest.captured_for_date,
        first_rag: firstRag,
        latest_rag: latestRag,
        trend: summarizeTrend(firstRag, latestRag),
        blocker_days: updates.filter((update) => (update.blockers || []).length > 0).length,
        decision_days: updates.filter((update) => Boolean(update.needs_decision)).length,
        latest_summary: latest.summary,
        latest_next_step: latest.next_step,
        latest_needs_decision: latest.needs_decision,
        notable_changes: [...new Set(changes)].slice(0, 5),
        notable_blockers: [...new Set(blockers)].slice(0, 5),
      } satisfies MonthlyProjectRollup;
    })
    .sort((left, right) => right.updates_count - left.updates_count || left.project_name.localeCompare(right.project_name));
}

function coerceWeeklyLegacyPayload(payload: Record<string, unknown>): WeeklyReviewRoutePayload | null {
  const week = asRecord(payload.week);
  if (!week || typeof week.start_date !== "string" || typeof week.end_date !== "string") {
    return null;
  }

  return payload as unknown as WeeklyReviewRoutePayload;
}

function buildLegacyDerivedWeekPattern(payload: WeeklyReviewRoutePayload): WorkWeeklyReviewPattern {
  if (payload.shipped.length === 0 && payload.stalled.length > 0) {
    return {
      label: "drag_outpaced_closure",
      summary: "The stored weekly payload points to more drag than clean forward motion.",
    };
  }

  if (payload.shipped.length > payload.stalled.length) {
    return {
      label: payload.stalled.length > 0 ? "traction_with_drag" : "clean_progress",
      summary:
        payload.stalled.length > 0
          ? "The stored weekly payload still shows real traction, but loose edges kept hanging around."
          : "The stored weekly payload reads like a week that mostly moved cleanly.",
    };
  }

  return {
    label: "thin_evidence",
    summary: "The stored weekly payload is usable, but it does not carry the newer canonical review fields.",
  };
}

function normalizeStoredWeeklyReview(snapshot: StoredReviewSnapshotRow<Record<string, unknown>>): NormalizedStoredWeeklyReview | null {
  const payload = asRecord(snapshot.payload);
  if (!payload) {
    return null;
  }

  const embeddedReview = asRecord(payload.review);
  const legacyPayload = coerceWeeklyLegacyPayload(payload);
  let review: WorkWeeklyReviewRead | null = null;

  if (embeddedReview && (!embeddedReview.reviewType || embeddedReview.reviewType === "weekly")) {
    review = embeddedReview as unknown as WorkWeeklyReviewRead;
  } else if (legacyPayload) {
    const generatedAt = typeof snapshot.updated_at === "string" ? snapshot.updated_at : snapshot.created_at;
    const freshnessSources = [
      {
        source: "weekly_snapshot",
        latestAt: generatedAt,
        staleAfterHours: 336,
        required: true,
      },
    ];
    review = {
      reviewType: "weekly",
      period: {
        startDate: legacyPayload.week.start_date,
        endDate: legacyPayload.week.end_date,
        anchorDate: legacyPayload.week.end_date,
        timezone: DEFAULT_WORKDAY_CONFIG.timezone,
      },
      dailyReviewCount: 0,
      weekPattern: buildLegacyDerivedWeekPattern(legacyPayload),
      whatMoved: legacyPayload.shipped.slice(0, 5).map((task) => ({
        key: `task:${task.id}`,
        title: task.title,
        context: task.implementation?.name ?? task.project?.name ?? null,
        summary: "Recovered from the stored weekly payload because no canonical weekly artifact was embedded yet.",
        occurrences: 1,
        daysSeen: [task.updated_at.slice(0, 10)],
        relatedTaskIds: [task.id],
      })),
      whatKeptSlipping: [...legacyPayload.stalled, ...legacyPayload.pending_decisions].slice(0, 5).map((task) => ({
        key: `task:${task.id}`,
        title: task.title,
        context: task.implementation?.name ?? task.project?.name ?? null,
        summary: "Still unresolved in the stored weekly payload.",
        occurrences: 1,
        daysSeen: [task.updated_at.slice(0, 10)],
        relatedTaskIds: [task.id],
      })),
      recurringRisks: [
        ...legacyPayload.cold_commitments.slice(0, 2).map((commitment) => ({
          key: `commitment:${commitment.id}`,
          label: commitment.title,
          summary: "Cold incoming commitment carried into the weekly review payload.",
          occurrences: 1,
          daysSeen: [],
          relatedTaskIds: commitment.task?.id ? [commitment.task.id] : [],
        })),
        ...legacyPayload.projects_needing_attention.slice(0, 3).map((project) => ({
          key: `project:${project.project_id}`,
          label: project.project_name,
          summary: project.latest_needs_decision
            ? `${project.project_name} still needed a decision in the stored weekly payload.`
            : `${project.project_name} stayed in the attention pile in the stored weekly payload.`,
          occurrences: 1,
          daysSeen: [project.latest_update_date],
          relatedTaskIds: [],
        })),
      ].slice(0, 5),
      projectRollups: legacyPayload.project_rollups,
      nextWeekCalls: legacyPayload.next_week_suggestions.slice(0, 3),
      narrativeHints: legacyPayload.next_week_suggestions.slice(0, 3),
      ...buildCanonicalMetadata({
        generatedAt,
        freshnessSources,
        caveats: ["Legacy weekly snapshot did not include canonical review fields, so monthly aggregation normalized it from the stored route payload."],
        supportingSignals: [
          {
            kind: "legacy_weekly_snapshot",
            summary: `${legacyPayload.shipped.length} shipped, ${legacyPayload.stalled.length} stalled, ${legacyPayload.pending_decisions.length} pending decisions in the stored weekly payload.`,
          },
        ],
        confidence: "medium",
      }),
    };
  }

  if (!review) {
    return null;
  }

  return {
    snapshotId: snapshot.id,
    periodStart: snapshot.period_start,
    periodEnd: snapshot.period_end,
    generatedAt:
      typeof review.generatedAt === "string"
        ? review.generatedAt
        : typeof snapshot.updated_at === "string"
          ? snapshot.updated_at
          : snapshot.created_at,
    review,
    legacyPayload,
    rawSnapshot: {
      id: snapshot.id,
      review_type: snapshot.review_type,
      period_start: snapshot.period_start,
      period_end: snapshot.period_end,
      title: snapshot.title,
      summary: snapshot.summary,
      source: snapshot.source,
      payload,
    },
  };
}

function aggregateRecurringPressurePoints(weeklyReviews: NormalizedStoredWeeklyReview[]): WorkMonthlyPressurePoint[] {
  const aggregate = new Map<string, WorkMonthlyPressurePoint>();

  for (const weekly of weeklyReviews) {
    for (const risk of weekly.review.recurringRisks ?? []) {
      const key = `risk:${risk.label.toLowerCase()}`;
      const existing = aggregate.get(key);
      if (!existing) {
        aggregate.set(key, {
          key,
          label: risk.label,
          summary: "",
          occurrences: 1,
          weeksSeen: [weekly.periodEnd],
          relatedTaskIds: [...risk.relatedTaskIds],
        });
        continue;
      }

      existing.occurrences += 1;
      if (!existing.weeksSeen.includes(weekly.periodEnd)) {
        existing.weeksSeen.push(weekly.periodEnd);
      }
      for (const taskId of risk.relatedTaskIds) {
        if (!existing.relatedTaskIds.includes(taskId)) {
          existing.relatedTaskIds.push(taskId);
        }
      }
    }

    for (const item of weekly.review.whatKeptSlipping ?? []) {
      const key = `slip:${item.title.toLowerCase()}`;
      const existing = aggregate.get(key);
      if (!existing) {
        aggregate.set(key, {
          key,
          label: item.title,
          summary: "",
          occurrences: 1,
          weeksSeen: [weekly.periodEnd],
          relatedTaskIds: [...item.relatedTaskIds],
        });
        continue;
      }

      existing.occurrences += 1;
      if (!existing.weeksSeen.includes(weekly.periodEnd)) {
        existing.weeksSeen.push(weekly.periodEnd);
      }
      for (const taskId of item.relatedTaskIds) {
        if (!existing.relatedTaskIds.includes(taskId)) {
          existing.relatedTaskIds.push(taskId);
        }
      }
    }
  }

  return [...aggregate.values()]
    .map((item) => ({
      ...item,
      weeksSeen: [...item.weeksSeen].sort(),
      summary:
        item.key.startsWith("slip:")
          ? `${item.label} kept showing up across ${item.occurrences} weekly review${item.occurrences === 1 ? "" : "s"}, so the problem was not confined to one messy week.`
          : `${item.label} kept showing back up across ${item.occurrences} weekly review${item.occurrences === 1 ? "" : "s"}, which makes it a month-level pressure point, not a passing blip.`,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.label.localeCompare(right.label))
    .slice(0, 5);
}

function buildDirectionChanges(
  weeklyReviews: NormalizedStoredWeeklyReview[],
  projectRollups: MonthlyProjectRollup[]
): WorkMonthlyDirectionChange[] {
  const changes: WorkMonthlyDirectionChange[] = projectRollups
    .filter((project) => project.trend === "worsening" || project.trend === "improving" || project.decision_days > 0)
    .map((project) => ({
      key: `project:${project.project_id}`,
      label: project.project_name,
      summary:
        project.trend === "worsening"
          ? `${project.project_name} ended the month worse than it started.`
          : project.trend === "improving"
            ? `${project.project_name} changed direction in a better way across the month.`
            : `${project.project_name} kept needing decisions instead of getting clean execution runway.`,
      relatedProjectIds: [project.project_id],
    }));

  if (weeklyReviews.length >= 2) {
    const firstPattern = weeklyReviews[0].review.weekPattern.label;
    const lastPattern = weeklyReviews[weeklyReviews.length - 1].review.weekPattern.label;
    if (firstPattern !== lastPattern) {
      changes.unshift({
        key: "operating-pattern-shift",
        label: "Operating pattern shift",
        summary: `The weekly review tone moved from ${firstPattern.replaceAll("_", " ")} to ${lastPattern.replaceAll("_", " ")}, so the month did not hold one steady operating shape.`,
        relatedProjectIds: [],
      });
    }
  }

  return changes.slice(0, 5);
}

function buildMonthPattern(
  coverageRatio: number,
  recurringPressurePoints: WorkMonthlyPressurePoint[],
  directionChanges: WorkMonthlyDirectionChange[]
): WorkMonthlyReviewPattern {
  if (coverageRatio === 0) {
    return {
      label: "thin_evidence",
      summary: "There were no stored weekly reviews in this month window, so the read had to lean on project status history instead of the review chain.",
    };
  }

  if (recurringPressurePoints.length >= 3 || directionChanges.some((item) => item.summary.includes("worse"))) {
    return {
      label: "pressure_month",
      summary: "The month had real pressure accumulation. Too many problems repeated long enough to become the default operating soundtrack.",
    };
  }

  if (recurringPressurePoints.length > 0 || directionChanges.length > 0) {
    return {
      label: "mixed_month",
      summary: "The month moved, but not in one clean line. There was progress alongside recurring drag and directional wobble.",
    };
  }

  return {
    label: "steady_climb",
    summary: "The month reads like a steady climb rather than a series of resets.",
  };
}

function buildNextMonthCalls(
  recurringPressurePoints: WorkMonthlyPressurePoint[],
  directionChanges: WorkMonthlyDirectionChange[],
  projectRollups: MonthlyProjectRollup[],
  weeklyReviews: NormalizedStoredWeeklyReview[],
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

  if (recurringPressurePoints[0]) {
    push(`Do not let ${recurringPressurePoints[0].label} become the default soundtrack next month. Reset the shape of that work in week one.`);
  }

  if (directionChanges[0]) {
    push(`Treat ${directionChanges[0].label} as a deliberate month-opening decision, not something to let drift another week.`);
  }

  const strongestProject = projectRollups.find((project) => project.trend === "improving") ?? projectRollups[0];
  if (strongestProject?.latest_next_step) {
    push(`Protect the next move on ${strongestProject.project_name}: ${strongestProject.latest_next_step}`);
  }

  for (const weekly of weeklyReviews) {
    for (const suggestion of weekly.review.nextWeekCalls ?? []) {
      if (calls.length >= 3) {
        break;
      }
      push(suggestion);
    }
    if (calls.length >= 3) {
      break;
    }
  }

  if (!includeNarrativeHints) {
    return calls.slice(0, 3);
  }

  return calls.slice(0, 3);
}

function buildNarrativeHints(
  monthPattern: WorkMonthlyReviewPattern,
  recurringPressurePoints: WorkMonthlyPressurePoint[],
  directionChanges: WorkMonthlyDirectionChange[],
  nextMonthCalls: string[],
  includeNarrativeHints = true
): string[] {
  if (!includeNarrativeHints) {
    return [];
  }

  const hints = [
    monthPattern.summary,
    recurringPressurePoints[0]
      ? `${recurringPressurePoints[0].label} did not stay contained to one week. It kept coming back into the review ladder.`
      : null,
    directionChanges[0]?.summary ?? null,
    nextMonthCalls[0] ?? null,
  ];

  return [...new Set(hints.filter((value): value is string => Boolean(value)))].slice(0, 4);
}

function buildSupplementalPressurePoints(
  existing: WorkMonthlyPressurePoint[],
  projectRollups: MonthlyProjectRollup[]
): WorkMonthlyPressurePoint[] {
  const points = [...existing];
  const seen = new Set(points.map((point) => point.key));

  for (const project of projectRollups) {
    if (project.blocker_days === 0 && project.decision_days === 0) {
      continue;
    }

    const key = `project:${project.project_id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    points.push({
      key,
      label: project.project_name,
      summary: project.latest_needs_decision
        ? `${project.project_name} kept carrying unresolved decision pressure through the month.`
        : `${project.project_name} kept accumulating blocker days through the month.`,
      occurrences: Math.max(project.blocker_days, project.decision_days, 1),
      weeksSeen: [project.latest_update_date],
      relatedTaskIds: [],
    });

    if (points.length >= 5) {
      break;
    }
  }

  return points.slice(0, 5);
}

export function buildWorkMonthlyReview(input: BuildWorkMonthlyReviewInput): WorkMonthlyReviewRead {
  const period = buildReviewPeriodWindow(input.anchorDate, input.monthStart, input.timezone);
  const generatedAt =
    input.generatedAt ??
    latestIso([
      ...input.weeklyReviews.map((review) => review.generatedAt),
      input.projectUpdatesLatestAt,
    ]) ??
    new Date().toISOString();
  const expectedWeekStartDates = listWeekStartDates(input.monthStart, input.anchorDate);
  const storedWeekStartDates = [...new Set(input.weeklyReviews.map((review) => review.periodStart))].sort();
  const missingWeekStartDates = expectedWeekStartDates.filter((dateOnly) => !storedWeekStartDates.includes(dateOnly));
  const coverageRatio = expectedWeekStartDates.length > 0 ? storedWeekStartDates.length / expectedWeekStartDates.length : 1;
  const supplementalFallbackUsed = storedWeekStartDates.length === 0 || missingWeekStartDates.length > 0;
  const directionChanges = buildDirectionChanges(input.weeklyReviews, input.projectRollups);
  const recurringPressurePoints = buildSupplementalPressurePoints(
    aggregateRecurringPressurePoints(input.weeklyReviews),
    input.projectRollups
  );
  const monthPattern = buildMonthPattern(coverageRatio, recurringPressurePoints, directionChanges);
  const nextMonthCalls = buildNextMonthCalls(
    recurringPressurePoints,
    directionChanges,
    input.projectRollups,
    input.weeklyReviews,
    input.includeNarrativeHints
  );
  const freshnessSources = [
    {
      source: "weekly_reviews",
      latestAt: latestIso(input.weeklyReviews.map((review) => review.generatedAt)),
      staleAfterHours: 336,
      required: true,
    },
    {
      source: "project_status_updates",
      latestAt: input.projectUpdatesLatestAt,
      staleAfterHours: 336,
      allowMissing: true,
    },
  ];
  const freshness = buildFreshness(generatedAt, freshnessSources);
  const confidence =
    freshness.overall === "stale" || coverageRatio < 0.6
      ? "low"
      : coverageRatio < 1 || recurringPressurePoints.length > 0 || missingWeekStartDates.length > 0
        ? "medium"
        : "high";
  const metadata = buildCanonicalMetadata<WorkMonthlyReviewRawSignals>({
    generatedAt,
    freshnessSources,
    caveats: [
      storedWeekStartDates.length === 0
        ? "No stored weekly reviews existed for this month window, so the month read had to fall back to project status history."
        : missingWeekStartDates.length > 0
          ? `${missingWeekStartDates.length} expected week${missingWeekStartDates.length === 1 ? "" : "s"} had no stored weekly review, so the month read is only partially chained.`
          : null,
      input.projectRollups.length === 0 ? "No project status updates were captured in this month window." : null,
    ],
    supportingSignals: [
      {
        kind: "weekly_review_coverage",
        summary: `${storedWeekStartDates.length}/${expectedWeekStartDates.length || 0} expected stored weekly review${expectedWeekStartDates.length === 1 ? "" : "s"} were available for the month.`,
      },
      {
        kind: "pressure_points",
        summary: `${recurringPressurePoints.length} recurring pressure point${recurringPressurePoints.length === 1 ? "" : "s"} stood out across the month.`,
        relatedTaskIds: recurringPressurePoints.flatMap((point) => point.relatedTaskIds).slice(0, 5),
      },
      {
        kind: "direction_changes",
        summary: `${directionChanges.length} notable direction change${directionChanges.length === 1 ? "" : "s"} were identified.`,
      },
    ],
    confidence,
    includeRawSignals: input.includeRawSignals,
    rawSignals: {
      expectedWeekStartDates,
      storedWeekStartDates,
      missingWeekStartDates,
      supplementalFallbackUsed,
      weeklySnapshotIds: input.weeklyReviews.map((review) => review.snapshotId),
    },
  });

  return {
    reviewType: "monthly",
    period,
    weeklyReviewCount: input.weeklyReviews.length,
    monthPattern,
    directionChanges,
    recurringPressurePoints,
    projectRollups: input.projectRollups,
    nextMonthCalls,
    narrativeHints: buildNarrativeHints(
      monthPattern,
      recurringPressurePoints,
      directionChanges,
      nextMonthCalls,
      input.includeNarrativeHints
    ),
    ...metadata,
  };
}

export async function workMonthlyReviewRead(input: WorkMonthlyReviewReadInput): Promise<WorkMonthlyReviewResult> {
  const timezone = input.timezone?.trim() || DEFAULT_WORKDAY_CONFIG.timezone;
  const baseNow = input.now ?? new Date();
  const anchorDate = normalizeDateOnly(input.date ?? getTodayDateOnlyInTimezone(baseNow, timezone));
  if (!anchorDate) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const monthStart = getMonthStartDate(anchorDate);
  const [weeklySnapshotResult, projectUpdateResult] = await Promise.all([
    input.supabase
      .from("briefing_review_snapshots")
      .select("id, review_type, anchor_date, period_start, period_end, title, summary, source, payload, created_at, updated_at")
      .eq("user_id", input.userId)
      .eq("review_type", "weekly")
      .gte("period_end", monthStart)
      .lte("period_start", anchorDate)
      .order("period_end", { ascending: true }),
    input.supabase
      .from("project_status_updates")
      .select("id, project_id, captured_for_date, summary, rag, changes_today, blockers, next_step, needs_decision, project:projects(id, name, stage, rag)")
      .eq("user_id", input.userId)
      .gte("captured_for_date", monthStart)
      .lte("captured_for_date", anchorDate)
      .order("captured_for_date", { ascending: true })
      .order("updated_at", { ascending: true }),
  ]);

  if (weeklySnapshotResult.error) {
    throw weeklySnapshotResult.error;
  }
  if (projectUpdateResult.error) {
    throw projectUpdateResult.error;
  }

  const weeklyReviews = ((weeklySnapshotResult.data || []) as StoredReviewSnapshotRow<Record<string, unknown>>[])
    .map(normalizeStoredWeeklyReview)
    .filter((review): review is NormalizedStoredWeeklyReview => review !== null);
  const projectUpdates = (projectUpdateResult.data || []) as ProjectStatusUpdateRow[];
  const projectRollups = buildMonthlyProjectRollups(projectUpdates);
  const review = buildWorkMonthlyReview({
    monthStart,
    anchorDate,
    timezone,
    generatedAt: baseNow.toISOString(),
    weeklyReviews,
    projectRollups,
    projectUpdatesLatestAt: latestIso(projectUpdates.map((update) => `${update.captured_for_date}T23:59:59.999Z`)),
    includeRawSignals: input.includeRawSignals,
    includeNarrativeHints: input.includeNarrativeHints,
  });

  const totals = {
    weekly_snapshot_count: weeklyReviews.length,
    project_status_update_count: projectUpdates.length,
    projects_with_updates: projectRollups.length,
    shipped_count: weeklyReviews.reduce(
      (total, snapshot) => total + (snapshot.legacyPayload?.shipped.length ?? snapshot.review.whatMoved.length),
      0
    ),
    stalled_count: weeklyReviews.reduce(
      (total, snapshot) => total + (snapshot.legacyPayload?.stalled.length ?? snapshot.review.whatKeptSlipping.length),
      0
    ),
    pending_decision_count: weeklyReviews.reduce(
      (total, snapshot) => total + (snapshot.legacyPayload?.pending_decisions.length ?? 0),
      0
    ),
  };

  const routePayload: MonthlyReviewRoutePayload = {
    month: {
      start_date: monthStart,
      end_date: anchorDate,
    },
    totals,
    weekly_snapshots: weeklyReviews.map((snapshot) => snapshot.rawSnapshot),
    project_rollups: projectRollups,
  };

  let reviewSnapshotId: string | null = null;
  if (input.persist) {
    const payload: PersistedMonthlyReviewPayload = {
      ...routePayload,
      review,
    };
    const snapshot = await upsertReviewSnapshot(input.supabase, {
      userId: input.userId,
      reviewType: "monthly",
      anchorDate,
      periodStart: monthStart,
      periodEnd: anchorDate,
      title: buildReviewSnapshotTitle("monthly", monthStart, anchorDate),
      summary: buildReviewSnapshotSummary("monthly", payload as unknown as Record<string, unknown>),
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
