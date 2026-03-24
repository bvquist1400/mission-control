import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDayWindows,
  decorateCalendarEvent,
  normalizeRequestedRange,
  parseEventPeople,
  type ApiCalendarEvent,
} from "@/lib/calendar";
import { buildColdCommitments, normalizeCommitmentRows, type IntelligenceCommitment } from "@/lib/briefing/intelligence";
import { normalizeDateOnly } from "@/lib/date-only";
import { buildReviewSnapshotSummary, buildReviewSnapshotTitle, upsertReviewSnapshot } from "@/lib/briefing/review-snapshots";
import { identifyPrepTasks, type TaskInput } from "@/lib/briefing/prep-tasks";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { buildCanonicalMetadata, buildFreshness } from "./metadata";
import { workExecutionStateRead } from "./execution-state";
import { workPriorityStackRead } from "./priority-stack";
import {
  readStatusUpdateRecommendations,
  type WorkStatusUpdateRecommendation,
} from "./status-update-recommendations";
import {
  buildSnapshotFreshnessSources,
  buildTaskContextLabel,
  buildWorkIntelligenceSnapshot,
  compareByPriorityThenUpdate,
  getLatestTimestamp,
} from "./snapshot";
import { getTodayDateOnlyInTimezone, latestIso, uniqueStrings } from "./review-support";
import type {
  WorkIntelligenceCommentActivity,
  WorkIntelligenceCommentRow,
  WorkIntelligenceMetadata,
  WorkIntelligenceSprintRecord,
  WorkIntelligenceTask,
} from "./types";
import type { CommitmentDirection, TaskStatus } from "@/types/database";
import { addDateOnlyDays } from "@/lib/date-only";

const ET_TIMEZONE = DEFAULT_WORKDAY_CONFIG.timezone;
const TASK_SELECT =
  "*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date, theme)";

interface CalendarEventRow {
  source: "local" | "ical" | "graph";
  external_event_id: string;
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[] | null;
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
}

interface CalendarEventContextRow {
  source: "local" | "ical" | "graph";
  external_event_id: string;
  meeting_context: string | null;
}

interface OpenCommitmentRow {
  id: string;
  title: string;
  direction: CommitmentDirection;
  status: "Open";
  due_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  stakeholder: { id: string; name: string } | null;
  task: { id: string; title: string; status: TaskStatus } | null;
}

interface PrepCandidate {
  taskId: string;
  title: string;
  context: string | null;
  reason: string;
  updatedAt: string;
  dueAt: string | null;
}

export interface WorkEodReviewTaskItem {
  taskId: string;
  title: string;
  context: string | null;
  reason: string;
  updatedAt: string;
  dueAt: string | null;
}

export interface WorkEodReviewFollowupItem {
  id: string;
  kind: "task" | "commitment";
  title: string;
  context: string | null;
  owner: string | null;
  reason: string;
  updatedAt: string | null;
  dueAt: string | null;
}

export interface WorkEodReviewRisk {
  label: string;
  severity: "high" | "medium" | "low";
  summary: string;
  relatedTaskIds: string[];
}

export interface WorkEodReviewDayOutcome {
  label: "strong_close" | "mixed_close" | "blocked_close" | "soft_close";
  summary: string;
}

export interface WorkEodReviewRawSignals {
  completedTaskIds: string[];
  rolledForwardTaskIds: string[];
  blockerTaskIds: string[];
  followUpRiskTaskIds: string[];
  coldCommitmentIds: string[];
  tomorrowFirstTaskIds: string[];
  statusUpdateRecommendationKeys: string[];
  momentum: string;
  loadStatus: string;
}

export interface WorkEodReviewRead extends WorkIntelligenceMetadata<WorkEodReviewRawSignals> {
  reviewType: "eod";
  requestedDate: string;
  dayOutcome: WorkEodReviewDayOutcome;
  completedToday: WorkEodReviewTaskItem[];
  rolledForward: WorkEodReviewTaskItem[];
  openBlockers: WorkEodReviewTaskItem[];
  coldFollowups: WorkEodReviewFollowupItem[];
  tomorrowFirstThings: WorkEodReviewTaskItem[];
  statusUpdateRecommendations: WorkStatusUpdateRecommendation[];
  operatingRisks: WorkEodReviewRisk[];
  narrativeHints: string[];
}

export interface PersistedEodReviewPayload {
  review: WorkEodReviewRead;
}

export interface WorkEodReviewResult {
  review: WorkEodReviewRead;
  snapshotPersisted: boolean;
  reviewSnapshotId: string | null;
}

export interface WorkEodReviewReadInput {
  supabase: SupabaseClient;
  userId: string;
  date?: string | null;
  timezone?: string;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
  persist?: boolean;
  now?: Date;
}

interface BuildWorkEodReviewInput {
  requestedDate: string;
  timezone: string;
  snapshot: ReturnType<typeof buildWorkIntelligenceSnapshot>;
  openCommitments: IntelligenceCommitment[];
  openCommitmentRows: OpenCommitmentRow[];
  tomorrowEventLatestAt: string | null;
  prepCandidates: PrepCandidate[];
  statusUpdateRecommendations: WorkStatusUpdateRecommendation[];
  statusArtifactsLatestAt: string | null;
  includeRawSignals?: boolean;
  includeNarrativeHints?: boolean;
}

function buildContextKey(source: CalendarEventRow["source"], externalEventId: string): string {
  return `${source}::${externalEventId}`;
}

function buildTaskInputs(tasks: WorkIntelligenceTask[]): TaskInput[] {
  return tasks.map((task) => ({
    ...task,
    implementation: task.implementation
      ? {
          name: task.implementation.name,
          phase: task.implementation.phase ?? null,
          rag: task.implementation.rag ?? null,
        }
      : null,
  }));
}

function resolveReferenceNow(requestedDate: string, timezone: string, baseNow: Date): { now: Date; dayStartIso: string; dayEndExclusiveIso: string } {
  const range = normalizeRequestedRange(requestedDate, requestedDate);
  const windows = buildDayWindows(range, {
    ...DEFAULT_WORKDAY_CONFIG,
    timezone,
  });
  const dayEndExclusiveMs = Date.parse(windows.utcRangeEndExclusive);
  const clampedNowMs = Number.isFinite(dayEndExclusiveMs)
    ? Math.min(baseNow.getTime(), dayEndExclusiveMs - 1000)
    : baseNow.getTime();

  return {
    now: new Date(clampedNowMs),
    dayStartIso: windows.utcRangeStart,
    dayEndExclusiveIso: windows.utcRangeEndExclusive,
  };
}

async function fetchCalendarEvents(
  supabase: SupabaseClient,
  userId: string,
  dateOnly: string,
  timezone: string
): Promise<ApiCalendarEvent[]> {
  const range = normalizeRequestedRange(dateOnly, dateOnly);
  const windows = buildDayWindows(range, {
    ...DEFAULT_WORKDAY_CONFIG,
    timezone,
  });

  const { data: rows, error } = await supabase
    .from("calendar_events")
    .select("source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day")
    .eq("user_id", userId)
    .gte("end_at", windows.utcRangeStart)
    .lt("start_at", windows.utcRangeEndExclusive)
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  const calendarRows = (rows || []) as CalendarEventRow[];
  const eventIds = [...new Set(calendarRows.map((row) => row.external_event_id).filter(Boolean))];
  const contextByEvent = new Map<string, string>();

  if (eventIds.length > 0) {
    const { data: contextRows, error: contextError } = await supabase
      .from("calendar_event_context")
      .select("source, external_event_id, meeting_context")
      .eq("user_id", userId)
      .in("external_event_id", eventIds);

    if (contextError) {
      throw contextError;
    }

    for (const row of (contextRows || []) as CalendarEventContextRow[]) {
      const meetingContext = row.meeting_context?.trim();
      if (!meetingContext) {
        continue;
      }

      contextByEvent.set(buildContextKey(row.source, row.external_event_id), meetingContext);
    }
  }

  return calendarRows.map((row) =>
    decorateCalendarEvent({
      start_at: row.start_at,
      end_at: row.end_at,
      title: row.title,
      with_display: parseEventPeople(row.with_display),
      body_scrubbed_preview: row.body_scrubbed_preview,
      is_all_day: row.is_all_day,
      external_event_id: row.external_event_id,
      meeting_context: contextByEvent.get(buildContextKey(row.source, row.external_event_id)) ?? null,
    })
  );
}

async function fetchTasks(supabase: SupabaseClient, userId: string): Promise<WorkIntelligenceTask[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("user_id", userId)
    .order("priority_score", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []) as WorkIntelligenceTask[];
}

async function fetchOpenCommitments(supabase: SupabaseClient, userId: string): Promise<OpenCommitmentRow[]> {
  const { data, error } = await supabase
    .from("commitments")
    .select("id, title, direction, status, due_at, notes, created_at, updated_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status)")
    .eq("user_id", userId)
    .eq("status", "Open")
    .order("due_at", { ascending: true, nullsFirst: false });

  if (error) {
    throw error;
  }

  return ((data || []) as Array<Record<string, unknown>>)
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      direction: row.direction as CommitmentDirection,
      status: "Open" as const,
      due_at: typeof row.due_at === "string" ? row.due_at : null,
      notes: typeof row.notes === "string" ? row.notes : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      stakeholder: Array.isArray(row.stakeholder)
        ? ((row.stakeholder[0] as { id?: string; name?: string } | undefined) ?? null)
        : ((row.stakeholder as { id?: string; name?: string } | null) ?? null),
      task: Array.isArray(row.task)
        ? ((row.task[0] as { id?: string; title?: string; status?: TaskStatus } | undefined) ?? null)
        : ((row.task as { id?: string; title?: string; status?: TaskStatus } | null) ?? null),
    }))
    .map((row) => ({
      ...row,
      stakeholder: row.stakeholder?.id && row.stakeholder?.name ? { id: row.stakeholder.id, name: row.stakeholder.name } : null,
      task: row.task?.id && row.task?.title && row.task?.status ? { id: row.task.id, title: row.task.title, status: row.task.status } : null,
    }));
}

async function fetchTaskCommentsForDay(
  supabase: SupabaseClient,
  userId: string,
  dayStartIso: string,
  dayEndExclusiveIso: string
): Promise<WorkIntelligenceCommentRow[]> {
  const { data, error } = await supabase
    .from("task_comments")
    .select("id, task_id, content, created_at, updated_at")
    .eq("user_id", userId)
    .gte("created_at", dayStartIso)
    .lt("created_at", dayEndExclusiveIso)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []) as WorkIntelligenceCommentRow[];
}

async function fetchCurrentSprint(
  supabase: SupabaseClient,
  userId: string,
  requestedDate: string
): Promise<WorkIntelligenceSprintRecord | null> {
  const { data, error } = await supabase
    .from("sprints")
    .select("id, name, theme, start_date, end_date")
    .eq("user_id", userId)
    .lte("start_date", requestedDate)
    .gte("end_date", requestedDate)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

function toReviewTaskItem(
  task: WorkIntelligenceTask,
  reason: string,
  commentActivity: Map<string, WorkIntelligenceCommentActivity>
): WorkEodReviewTaskItem {
  const latestCommentAt = commentActivity.get(task.id)?.latestAt ?? null;
  const updatedAt = latestIso([task.updated_at, latestCommentAt]) ?? task.updated_at;

  return {
    taskId: task.id,
    title: task.title,
    context: buildTaskContextLabel(task),
    reason,
    updatedAt,
    dueAt: task.due_at ?? null,
  };
}

function buildPrepCandidates(
  tasks: WorkIntelligenceTask[],
  tomorrowEvents: ApiCalendarEvent[],
  tomorrowDate: string,
  commentActivity: Map<string, WorkIntelligenceCommentActivity>
): PrepCandidate[] {
  const prepItems = identifyPrepTasks(buildTaskInputs(tasks), tomorrowEvents, tomorrowDate);
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return prepItems
    .map((prep) => {
      const task = taskById.get(prep.task.id);
      if (!task) {
        return null;
      }

      const item = toReviewTaskItem(task, prep.reason, commentActivity);
      return {
        taskId: item.taskId,
        title: item.title,
        context: item.context,
        reason: prep.reason,
        updatedAt: item.updatedAt,
        dueAt: item.dueAt,
      } satisfies PrepCandidate;
    })
    .filter((item): item is PrepCandidate => item !== null);
}

function buildTomorrowFirstThings(
  prepCandidates: PrepCandidate[],
  snapshot: ReturnType<typeof buildWorkIntelligenceSnapshot>
): WorkEodReviewTaskItem[] {
  const items: WorkEodReviewTaskItem[] = [];
  const seen = new Set<string>();

  for (const candidate of prepCandidates) {
    if (seen.has(candidate.taskId)) {
      continue;
    }

    seen.add(candidate.taskId);
    items.push({
      taskId: candidate.taskId,
      title: candidate.title,
      context: candidate.context,
      reason: candidate.reason,
      updatedAt: candidate.updatedAt,
      dueAt: candidate.dueAt,
    });
  }

  for (const task of snapshot.rolledOverTasks) {
    if (seen.has(task.id)) {
      continue;
    }

    seen.add(task.id);
    items.push(toReviewTaskItem(task, "Still open heading into tomorrow, so it needs a deliberate restart instead of another warm-up lap.", snapshot.commentActivity));
  }

  return items.slice(0, 5);
}

function buildDayOutcome(
  completedToday: WorkEodReviewTaskItem[],
  rolledForward: WorkEodReviewTaskItem[],
  openBlockers: WorkEodReviewTaskItem[],
  coldFollowups: WorkEodReviewFollowupItem[]
): WorkEodReviewDayOutcome {
  if (completedToday.length >= 2 && rolledForward.length <= 1 && openBlockers.length === 0) {
    return {
      label: "strong_close",
      summary: "The day closed with real output and not much loose debris left behind.",
    };
  }

  if (completedToday.length > 0 && (rolledForward.length > 0 || openBlockers.length > 0)) {
    return {
      label: "mixed_close",
      summary: "The day produced real output, but it did not close cleanly.",
    };
  }

  if (completedToday.length === 0 && (openBlockers.length > 0 || coldFollowups.length > 0)) {
    return {
      label: "blocked_close",
      summary: "The day ended with more drag than closure, and tomorrow inherits that debt.",
    };
  }

  return {
    label: "soft_close",
    summary: "The day closed softly. There is some movement, but tomorrow still needs a sharp opening move.",
  };
}

function buildOperatingRisks(
  snapshot: ReturnType<typeof buildWorkIntelligenceSnapshot>,
  openCommitments: IntelligenceCommitment[],
  executionState: ReturnType<typeof workExecutionStateRead>,
  rolledForward: WorkEodReviewTaskItem[]
): WorkEodReviewRisk[] {
  const risks: WorkEodReviewRisk[] = [];
  const seen = new Set<string>();

  const pushRisk = (risk: WorkEodReviewRisk | null) => {
    if (!risk || seen.has(risk.label)) {
      return;
    }

    seen.add(risk.label);
    risks.push(risk);
  };

  if (executionState.topRisk) {
    pushRisk({
      label: executionState.topRisk.label,
      severity: executionState.loadAssessment.isOverloaded ? "high" : "medium",
      summary: executionState.topRisk.summary,
      relatedTaskIds: executionState.topRisk.relatedTaskIds,
    });
  }

  if (rolledForward.length >= 3) {
    pushRisk({
      label: "Rollover pressure",
      severity: rolledForward.length >= 5 ? "high" : "medium",
      summary: `${rolledForward.length} items are still rolling, so tomorrow is at risk of starting in recovery mode instead of execution mode.`,
      relatedTaskIds: rolledForward.slice(0, 4).map((item) => item.taskId),
    });
  }

  if (snapshot.followUpRiskTasks.length > 0) {
    pushRisk({
      label: "Cold follow-up risk",
      severity: snapshot.followUpRiskTasks.length >= 2 ? "high" : "medium",
      summary: `${snapshot.followUpRiskTasks.length} waiting thread${snapshot.followUpRiskTasks.length === 1 ? "" : "s"} already need a follow-up refresh.`,
      relatedTaskIds: snapshot.followUpRiskTasks.slice(0, 4).map((task) => task.id),
    });
  }

  const coldIncoming = buildColdCommitments(openCommitments, snapshot.now);
  if (coldIncoming.length > 0) {
    pushRisk({
      label: "Incoming commitments cooling off",
      severity: coldIncoming.length >= 2 ? "medium" : "low",
      summary: `${coldIncoming.length} inbound commitment${coldIncoming.length === 1 ? "" : "s"} have gone cold enough to turn into trust debt if they sit another day.`,
      relatedTaskIds: [],
    });
  }

  if (snapshot.coreCounts.statusUncertain >= 3) {
    pushRisk({
      label: "Status lag",
      severity: "medium",
      summary: `${snapshot.coreCounts.statusUncertain} active task statuses look stale or uncertain, so the close-of-day read is not fully clean.`,
      relatedTaskIds: snapshot.statusUncertainTasks.slice(0, 4).map((task) => task.id),
    });
  }

  return risks.slice(0, 4);
}

function buildNarrativeHints(
  dayOutcome: WorkEodReviewDayOutcome,
  completedToday: WorkEodReviewTaskItem[],
  rolledForward: WorkEodReviewTaskItem[],
  openBlockers: WorkEodReviewTaskItem[],
  tomorrowFirstThings: WorkEodReviewTaskItem[],
  statusUpdateRecommendations: WorkStatusUpdateRecommendation[],
  includeNarrativeHints = true
): string[] {
  if (!includeNarrativeHints) {
    return [];
  }

  const hints = [
    dayOutcome.summary,
    rolledForward[0]
      ? `${rolledForward.length} item${rolledForward.length === 1 ? "" : "s"} are still rolling, led by ${rolledForward[0].title}, so tomorrow cannot open wide.`
      : completedToday[0]
        ? `Carry the momentum from ${completedToday[0].title} before the context cools off overnight.`
        : null,
    openBlockers[0]
      ? `${openBlockers[0].title} is still sitting in a wait state, so send one clearing follow-up before opening more work.`
      : null,
    tomorrowFirstThings[0]
      ? `Tomorrow should start with ${tomorrowFirstThings[0].title}, not another round of inbox archaeology.`
      : null,
    statusUpdateRecommendations[0]
      ? `${statusUpdateRecommendations[0].entityName} moved enough that the recorded status probably now lags the work.`
      : null,
  ];

  return uniqueStrings(hints).slice(0, 4);
}

export function buildWorkEodReview(input: BuildWorkEodReviewInput): WorkEodReviewRead {
  const completedToday = input.snapshot.completedTodayTasks.map((task) =>
    toReviewTaskItem(task, "Closed today.", input.snapshot.commentActivity)
  );
  const rolledForward = input.snapshot.rolledOverTasks.map((task) =>
    toReviewTaskItem(task, "Still open at close of day and likely to reopen tomorrow.", input.snapshot.commentActivity)
  );
  const openBlockers = input.snapshot.openTasks
    .filter((task) => task.status === "Blocked/Waiting")
    .sort(compareByPriorityThenUpdate)
    .map((task) =>
      toReviewTaskItem(
        task,
        task.waiting_on ? `Still waiting on ${task.waiting_on}.` : "Blocked without a clean exit move.",
        input.snapshot.commentActivity
      )
    );
  const coldCommitments = buildColdCommitments(input.openCommitments, input.snapshot.now);
  const coldFollowups: WorkEodReviewFollowupItem[] = [
    ...input.snapshot.followUpRiskTasks.map((task) => ({
      id: task.id,
      kind: "task" as const,
      title: task.title,
      context: buildTaskContextLabel(task),
      owner: task.waiting_on ?? null,
      reason: task.follow_up_at
        ? "Follow-up date has already passed."
        : "Waiting thread has aged enough that it now needs an explicit nudge.",
      updatedAt: task.updated_at,
      dueAt: task.follow_up_at ?? task.due_at ?? null,
    })),
    ...coldCommitments.map((commitment) => ({
      id: `${commitment.stakeholder_name}:${commitment.title}`,
      kind: "commitment" as const,
      title: commitment.title,
      context: null,
      owner: commitment.stakeholder_name,
      reason: `${commitment.days_open} day${commitment.days_open === 1 ? "" : "s"} open with no fresh close loop.`,
      updatedAt: null,
      dueAt: commitment.due_at,
    })),
  ];
  const tomorrowFirstThings = buildTomorrowFirstThings(input.prepCandidates, input.snapshot);
  const executionState = workExecutionStateRead(input.snapshot);
  const operatingRisks = buildOperatingRisks(input.snapshot, input.openCommitments, executionState, rolledForward);
  const dayOutcome = buildDayOutcome(completedToday, rolledForward, openBlockers, coldFollowups);
  const freshnessSources = [
    ...buildSnapshotFreshnessSources(input.snapshot),
    {
      source: "commitments",
      latestAt: latestIso(input.openCommitmentRows.map((row) => row.updated_at ?? row.created_at)),
      staleAfterHours: 96,
      allowMissing: true,
    },
    {
      source: "tomorrow_calendar",
      latestAt: input.tomorrowEventLatestAt,
      staleAfterHours: 48,
      allowMissing: true,
    },
    {
      source: "status_artifacts",
      latestAt: input.statusArtifactsLatestAt,
      staleAfterHours: 120,
      allowMissing: true,
    },
  ];
  const freshness = buildFreshness(input.snapshot.generatedAt, freshnessSources);
  const confidence =
    freshness.overall === "stale"
      ? "low"
      : input.snapshot.coreCounts.statusUncertain >= 3
        ? "low"
        : input.snapshot.coreCounts.statusUncertain > 0 ||
            coldFollowups.length > 0 ||
            openBlockers.length > 0 ||
            rolledForward.length > 0
          ? "medium"
          : "high";
  const metadata = buildCanonicalMetadata<WorkEodReviewRawSignals>({
    generatedAt: input.snapshot.generatedAt,
    freshnessSources,
    caveats: [
      input.snapshot.coreCounts.statusUncertain > 0
        ? `${input.snapshot.coreCounts.statusUncertain} active status${input.snapshot.coreCounts.statusUncertain === 1 ? "" : "es"} look stale or uncertain, so the day-close read is less clean than it looks.`
        : null,
      coldFollowups.length > 0
        ? `${coldFollowups.length} follow-up thread${coldFollowups.length === 1 ? "" : "s"} have already started cooling off.`
        : null,
      input.statusUpdateRecommendations.length > 0
        ? `${input.statusUpdateRecommendations.length} project or implementation status artifact${input.statusUpdateRecommendations.length === 1 ? "" : "s"} likely now lag today's movement.`
        : null,
      rolledForward.length >= 4
        ? `${rolledForward.length} items are still rolling, which means tomorrow is at risk of starting as cleanup instead of forward motion.`
        : null,
    ],
    supportingSignals: [
      {
        kind: "completed_today",
        summary: `${completedToday.length} task${completedToday.length === 1 ? "" : "s"} closed today.`,
        relatedTaskIds: completedToday.slice(0, 4).map((item) => item.taskId),
      },
      {
        kind: "rollover",
        summary: `${rolledForward.length} item${rolledForward.length === 1 ? "" : "s"} still rolling into tomorrow.`,
        relatedTaskIds: rolledForward.slice(0, 4).map((item) => item.taskId),
      },
      {
        kind: "blockers",
        summary: `${openBlockers.length} blocked or waiting item${openBlockers.length === 1 ? "" : "s"} remain open at close.`,
        relatedTaskIds: openBlockers.slice(0, 4).map((item) => item.taskId),
      },
      {
        kind: "tomorrow_prep",
        summary: `${tomorrowFirstThings.length} clear first-thing candidate${tomorrowFirstThings.length === 1 ? "" : "s"} for tomorrow.`,
        relatedTaskIds: tomorrowFirstThings.slice(0, 4).map((item) => item.taskId),
      },
      {
        kind: "status_hygiene",
        summary: `${input.statusUpdateRecommendations.length} status update reminder${input.statusUpdateRecommendations.length === 1 ? "" : "s"} surfaced from project or implementation movement.`,
        relatedTaskIds: input.statusUpdateRecommendations.slice(0, 4).flatMap((item) => item.relatedTaskIds),
      },
    ],
    confidence,
    includeRawSignals: input.includeRawSignals,
    rawSignals: {
      completedTaskIds: completedToday.map((item) => item.taskId),
      rolledForwardTaskIds: rolledForward.map((item) => item.taskId),
      blockerTaskIds: openBlockers.map((item) => item.taskId),
      followUpRiskTaskIds: input.snapshot.followUpRiskTasks.map((task) => task.id),
      coldCommitmentIds: coldCommitments.map((item) => `${item.stakeholder_name}:${item.title}`),
      tomorrowFirstTaskIds: tomorrowFirstThings.map((item) => item.taskId),
      statusUpdateRecommendationKeys: input.statusUpdateRecommendations.map((item) => item.key),
      momentum: executionState.momentum.label,
      loadStatus: executionState.loadAssessment.status,
    },
  });

  return {
    reviewType: "eod",
    requestedDate: input.requestedDate,
    dayOutcome,
    completedToday,
    rolledForward,
    openBlockers,
    coldFollowups,
    tomorrowFirstThings,
    statusUpdateRecommendations: input.statusUpdateRecommendations,
    operatingRisks,
    narrativeHints: buildNarrativeHints(
      dayOutcome,
      completedToday,
      rolledForward,
      openBlockers,
      tomorrowFirstThings,
      input.statusUpdateRecommendations,
      input.includeNarrativeHints
    ),
    ...metadata,
  };
}

export async function workEodReviewRead(input: WorkEodReviewReadInput): Promise<WorkEodReviewResult> {
  const timezone = input.timezone?.trim() || ET_TIMEZONE;
  const baseNow = input.now ?? new Date();
  const requestedDate = normalizeDateOnly(input.date ?? getTodayDateOnlyInTimezone(baseNow, timezone));
  if (!requestedDate) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const tomorrowDate = addDateOnlyDays(requestedDate, 1) ?? requestedDate;
  const { now, dayStartIso, dayEndExclusiveIso } = resolveReferenceNow(requestedDate, timezone, baseNow);

  const [todayEvents, tomorrowEvents, tasks, openCommitmentRows, taskComments, currentSprint] = await Promise.all([
    fetchCalendarEvents(input.supabase, input.userId, requestedDate, timezone),
    fetchCalendarEvents(input.supabase, input.userId, tomorrowDate, timezone),
    fetchTasks(input.supabase, input.userId),
    fetchOpenCommitments(input.supabase, input.userId),
    fetchTaskCommentsForDay(input.supabase, input.userId, dayStartIso, dayEndExclusiveIso),
    fetchCurrentSprint(input.supabase, input.userId, requestedDate),
  ]);

  const snapshot = buildWorkIntelligenceSnapshot({
    now,
    window: {
      requestedDate,
      since: dayStartIso,
      dayStartIso,
      dayEndExclusiveIso,
      timezone,
    },
    tasks,
    events: todayEvents,
    taskComments,
    currentSprint,
  });
  const priorityStack = workPriorityStackRead(snapshot, { limit: 2 });
  const prepCandidates = buildPrepCandidates(tasks, tomorrowEvents, tomorrowDate, snapshot.commentActivity);
  if (prepCandidates.length === 0 && priorityStack.topItems[0]) {
    const task = tasks.find((candidate) => candidate.id === priorityStack.topItems[0].taskId);
    if (task) {
      prepCandidates.push({
        taskId: task.id,
        title: task.title,
        context: buildTaskContextLabel(task),
        reason: "Still the strongest reopening move if tomorrow starts cold.",
        updatedAt: task.updated_at,
        dueAt: task.due_at ?? null,
      });
    }
  }

  const openCommitments = normalizeCommitmentRows(openCommitmentRows as unknown[]);
  const statusUpdateRecommendations = await readStatusUpdateRecommendations({
    supabase: input.supabase,
    userId: input.userId,
    requestedDate,
    snapshot,
  });
  const review = buildWorkEodReview({
    requestedDate,
    timezone,
    snapshot,
    openCommitments,
    openCommitmentRows,
    tomorrowEventLatestAt: getLatestTimestamp(tomorrowEvents.map((event) => event.end_at)),
    prepCandidates,
    statusUpdateRecommendations: statusUpdateRecommendations.recommendations,
    statusArtifactsLatestAt: statusUpdateRecommendations.latestStatusArtifactAt,
    includeRawSignals: input.includeRawSignals,
    includeNarrativeHints: input.includeNarrativeHints,
  });

  let reviewSnapshotId: string | null = null;
  if (input.persist) {
    const payload: PersistedEodReviewPayload = { review };
    const snapshotRow = await upsertReviewSnapshot(input.supabase, {
      userId: input.userId,
      reviewType: "eod",
      anchorDate: requestedDate,
      periodStart: requestedDate,
      periodEnd: requestedDate,
      title: buildReviewSnapshotTitle("eod", requestedDate, requestedDate),
      summary: buildReviewSnapshotSummary("eod", payload as unknown as Record<string, unknown>),
      source: "system",
      payload: payload as unknown as Record<string, unknown>,
    });

    reviewSnapshotId = snapshotRow.id;
  }

  return {
    review,
    snapshotPersisted: Boolean(input.persist),
    reviewSnapshotId,
  };
}
