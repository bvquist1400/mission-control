"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import type { TaskCardData } from "@/components/tasks/TaskCard";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { CapacityMeter } from "@/components/today/CapacityMeter";
import { FocusStatusBar } from "@/components/today/FocusStatusBar";
import type {
  CommitmentSummary,
  TaskUpdatePayload,
  TaskWithImplementation,
  CapacityResult,
  SprintDetail,
  SprintWithImplementation,
} from "@/types/database";
import { calculateCapacity } from "@/lib/capacity";
import {
  calculateSprintProgressMetrics,
  parseSprintHolidaySet,
  toUtcDateMs,
} from "@/lib/today/sprint-progress";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

interface WaitingTask {
  id: string;
  title: string;
  waitingOn: string;
  followUpAt: string | null;
}

type WaitingTaskSource = Pick<TaskWithImplementation, "id" | "title" | "waiting_on" | "follow_up_at">;

interface MeetingEvent {
  title: string;
  start: string;
  end: string;
  location: string | null;
}

type TodaySectionKey = "meetings" | "weekBoard" | "waitingOn" | "needsReview" | "sync" | "sprint";
type TodaySectionErrors = Partial<Record<TodaySectionKey, string>>;
type TodaySectionUpdatedAt = Partial<Record<TodaySectionKey, string>>;
type WeekColumnKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "weekend";

interface WeekBoardTaskData extends TaskCardData {
  priorityScore: number;
  projectName: string | null;
  waitingOn: string | null;
  followUpAt: string | null;
  needsReview: boolean;
  dependencyBlocked: boolean;
}

interface WeekBoardColumn {
  key: WeekColumnKey;
  title: string;
  subtitle: string;
  tasks: WeekBoardTaskData[];
  isCurrentDay: boolean;
}

interface TodayData {
  weekBoard: WeekBoardTaskData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  openArtifactCount: number;
  capacity: CapacityResult;
  meetings: MeetingEvent[];
  latestSync: SyncTodaySummary | null;
  currentSprint: SprintProgressSummary | null;
  sectionErrors: TodaySectionErrors;
  sectionUpdatedAt: TodaySectionUpdatedAt;
  // Raw tasks kept for modal lookup
  weekBoardRaw: TaskWithImplementation[];
}

interface NeedsReviewCountResponse {
  count?: number;
}

interface CalendarTodayResponse {
  events?: MeetingEvent[];
  busyMinutes?: number;
}

interface SyncTodaySummary {
  task_ids: string[];
  promoted: number;
  demoted: number;
  skipped_pinned: number;
  synced_at: string;
}

interface LatestSyncResponse {
  sync?: SyncTodaySummary | null;
}

interface IntelligenceInboxResponse {
  counts?: {
    open?: number;
  };
}

interface SprintProgressSummary {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  completionPct: number;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  plannedTasks: number;
  blockedTasks: number;
  daysLeft: number;
  requiredTasksPerDay: number;
  expectedCompletedByNow: number;
  tasksBehindPace: number;
  forecastFinishDate: string | null;
  forecastWithinSprint: boolean | null;
  onTrack: boolean;
}

interface ApiErrorPayload {
  error?: string;
}

const SPRINT_HOLIDAY_SET = parseSprintHolidaySet(process.env.NEXT_PUBLIC_SPRINT_HOLIDAYS);

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function isAuthMessage(message: string): boolean {
  return message.toLowerCase().includes("authentication required");
}

function taskToCardData(
  task: TaskWithImplementation,
  dueState?: TaskCardData["dueState"],
  syncedToday: boolean = false
): TaskCardData {
  return {
    id: task.id,
    title: task.title,
    tags: task.tags ?? [],
    estimatedMinutes: task.estimated_minutes,
    dueAt: task.due_at,
    dueState,
    status: task.status,
    blocker: task.blocker,
    pinned: Boolean(task.pinned),
    syncedToday,
    implementationName: task.implementation?.name ?? null,
  };
}

function taskToWeekBoardData(
  task: TaskWithImplementation,
  dueState?: TaskCardData["dueState"],
  syncedToday: boolean = false
): WeekBoardTaskData {
  return {
    ...taskToCardData(task, dueState, syncedToday),
    priorityScore: task.priority_score,
    projectName: task.project?.name ?? null,
    waitingOn: task.waiting_on,
    followUpAt: task.follow_up_at,
    needsReview: task.needs_review,
    dependencyBlocked: Boolean(task.dependency_blocked),
  };
}

async function fetchJson<T>(url: string, fallbackError: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  const payload = (await response.json().catch(() => null)) as (ApiErrorPayload & Partial<T>) | null;

  if (!response.ok) {
    if (payload && typeof payload.error === "string" && payload.error.trim().length > 0) {
      throw new Error(payload.error);
    }
    throw new Error(fallbackError);
  }

  if (!payload) {
    throw new Error(fallbackError);
  }

  return payload as T;
}

function normalizeBusyMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  return `${year}-${month}-${day}`;
}

function resolveClientTimeZone(): string {
  if (typeof window === "undefined") {
    return DEFAULT_WORKDAY_CONFIG.timezone;
  }

  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof resolved === "string" && resolved.trim().length > 0
    ? resolved
    : DEFAULT_WORKDAY_CONFIG.timezone;
}

function getDueState(dueAt: string | null, now: Date, timeZone: string): TaskCardData["dueState"] {
  if (!dueAt) {
    return null;
  }

  const dueDate = new Date(dueAt);
  if (dueDate.getTime() < now.getTime()) {
    return "Overdue";
  }

  const dueDay = getDateInTimeZone(dueDate, timeZone);
  const todayDay = getDateInTimeZone(now, timeZone);
  if (dueDay === todayDay) {
    return "Due Today";
  }

  return "Due Soon";
}

function getEndOfWeekIso(now: Date): string {
  const endOfWeek = new Date(now);
  endOfWeek.setDate(endOfWeek.getDate() + (6 - endOfWeek.getDay()));
  endOfWeek.setHours(23, 59, 59, 999);
  return endOfWeek.toISOString();
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getStartOfWorkWeek(now: Date): Date {
  const start = new Date(now);
  const day = start.getDay();
  const daysFromMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + daysFromMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function formatColumnDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(date);
}

function compareTasksByDueThenPriority(a: WeekBoardTaskData, b: WeekBoardTaskData): number {
  const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;

  if (aDue !== bDue) {
    return aDue - bDue;
  }

  if (a.priorityScore !== b.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }

  return a.title.localeCompare(b.title);
}

function buildWeekBoardColumns(tasks: WeekBoardTaskData[], now: Date, timeZone: string): WeekBoardColumn[] {
  const todayDate = getDateInTimeZone(now, timeZone);
  const weekStart = getStartOfWorkWeek(now);
  const monday = getDateInTimeZone(weekStart, timeZone);
  const tuesday = getDateInTimeZone(addLocalDays(weekStart, 1), timeZone);
  const wednesday = getDateInTimeZone(addLocalDays(weekStart, 2), timeZone);
  const thursday = getDateInTimeZone(addLocalDays(weekStart, 3), timeZone);
  const friday = getDateInTimeZone(addLocalDays(weekStart, 4), timeZone);
  const saturday = getDateInTimeZone(addLocalDays(weekStart, 5), timeZone);
  const sunday = getDateInTimeZone(addLocalDays(weekStart, 6), timeZone);
  const grouped: Record<WeekColumnKey, WeekBoardTaskData[]> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    weekend: [],
  };

  for (const task of tasks) {
    if (!task.dueAt) {
      continue;
    }

    const dueDate = getDateInTimeZone(new Date(task.dueAt), timeZone);
    if (dueDate <= monday) {
      grouped.monday.push(task);
    } else if (dueDate === tuesday) {
      grouped.tuesday.push(task);
    } else if (dueDate === wednesday) {
      grouped.wednesday.push(task);
    } else if (dueDate === thursday) {
      grouped.thursday.push(task);
    } else if (dueDate === friday) {
      grouped.friday.push(task);
    } else if (dueDate === saturday || dueDate === sunday) {
      grouped.weekend.push(task);
    }
  }

  return [
    {
      key: "monday",
      title: "Monday",
      subtitle: formatColumnDate(weekStart, timeZone),
      tasks: grouped.monday.sort(compareTasksByDueThenPriority),
      isCurrentDay: monday === todayDate,
    },
    {
      key: "tuesday",
      title: "Tuesday",
      subtitle: formatColumnDate(addLocalDays(weekStart, 1), timeZone),
      tasks: grouped.tuesday.sort(compareTasksByDueThenPriority),
      isCurrentDay: tuesday === todayDate,
    },
    {
      key: "wednesday",
      title: "Wednesday",
      subtitle: formatColumnDate(addLocalDays(weekStart, 2), timeZone),
      tasks: grouped.wednesday.sort(compareTasksByDueThenPriority),
      isCurrentDay: wednesday === todayDate,
    },
    {
      key: "thursday",
      title: "Thursday",
      subtitle: formatColumnDate(addLocalDays(weekStart, 3), timeZone),
      tasks: grouped.thursday.sort(compareTasksByDueThenPriority),
      isCurrentDay: thursday === todayDate,
    },
    {
      key: "friday",
      title: "Friday",
      subtitle: formatColumnDate(addLocalDays(weekStart, 4), timeZone),
      tasks: grouped.friday.sort(compareTasksByDueThenPriority),
      isCurrentDay: friday === todayDate,
    },
    {
      key: "weekend",
      title: "Weekend",
      subtitle: `${formatColumnDate(addLocalDays(weekStart, 5), timeZone)} - ${formatColumnDate(addLocalDays(weekStart, 6), timeZone)}`,
      tasks: grouped.weekend.sort(compareTasksByDueThenPriority),
      isCurrentDay: saturday === todayDate || sunday === todayDate,
    },
  ];
}

function getTaskCountByStatus(detail: SprintDetail, status: "In Progress" | "Planned" | "Blocked/Waiting"): number {
  const group = detail.tasks_by_status?.[status];
  return Array.isArray(group) ? group.length : 0;
}

async function fetchCurrentSprintProgress(timeZone: string): Promise<SprintProgressSummary | null> {
  const sprints = await fetchJson<SprintWithImplementation[]>("/api/sprints", "Failed to fetch sprints");
  const todayDate = getDateInTimeZone(new Date(), timeZone);
  const currentSprint = sprints.find((sprint) => sprint.start_date <= todayDate && sprint.end_date >= todayDate);

  if (!currentSprint) {
    return null;
  }

  const detail = await fetchJson<SprintDetail>(`/api/sprints/${currentSprint.id}`, "Failed to fetch sprint detail");
  const totalTasks = Number(detail.total_tasks || 0);
  const completedTasks = Number(detail.completed_tasks || 0);
  const completionPct = Number(detail.completion_pct || 0);
  const inProgressTasks = getTaskCountByStatus(detail, "In Progress");
  const plannedTasks = getTaskCountByStatus(detail, "Planned");
  const blockedTasks = getTaskCountByStatus(detail, "Blocked/Waiting");
  const metrics = calculateSprintProgressMetrics({
    sprintStartDate: detail.start_date,
    sprintEndDate: detail.end_date,
    totalTasks,
    completedTasks,
    todayDate,
    holidaySet: SPRINT_HOLIDAY_SET,
  });

  return {
    id: detail.id,
    name: detail.name,
    startDate: detail.start_date,
    endDate: detail.end_date,
    completionPct,
    totalTasks,
    completedTasks,
    inProgressTasks,
    plannedTasks,
    blockedTasks,
    daysLeft: metrics.daysLeft,
    requiredTasksPerDay: metrics.requiredTasksPerDay,
    expectedCompletedByNow: metrics.expectedCompletedByNow,
    tasksBehindPace: metrics.tasksBehindPace,
    forecastFinishDate: metrics.forecastFinishDate,
    forecastWithinSprint: metrics.forecastWithinSprint,
    onTrack: metrics.onTrack,
  };
}

interface ExecutionSlices {
  weekBoard: WeekBoardTaskData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  capacity: CapacityResult;
  weekBoardRaw: TaskWithImplementation[];
}

function buildExecutionSlices(
  weekBoardTasks: TaskWithImplementation[],
  waitingTasks: WaitingTaskSource[],
  needsReviewCount: number,
  timeZone: string,
  meetingMinutes: number,
  syncedTaskIds: Set<string>
): ExecutionSlices {
  const now = new Date();
  const weekBoard = weekBoardTasks.map((task) => (
    taskToWeekBoardData(task, getDueState(task.due_at, now, timeZone), syncedTaskIds.has(task.id))
  ));
  const waitingOn: WaitingTask[] = waitingTasks.map((task) => ({
    id: task.id,
    title: task.title,
    waitingOn: task.waiting_on || "Unknown",
    followUpAt: task.follow_up_at,
  }));

  const capacity = calculateCapacity(weekBoardTasks, new Set<string>(), normalizeBusyMinutes(meetingMinutes));

  return {
    weekBoard,
    waitingOn,
    needsReviewCount,
    capacity,
    weekBoardRaw: weekBoardTasks,
  };
}

async function fetchExecutionSlices(
  timeZone: string,
  meetingMinutes: number,
  syncedTaskIds: Set<string>,
  weekEndIso: string,
  previous: ExecutionSlices | null = null,
  previousSectionUpdatedAt: TodaySectionUpdatedAt = {}
): Promise<{ slices: ExecutionSlices; sectionErrors: TodaySectionErrors; sectionUpdatedAt: TodaySectionUpdatedAt }> {
  const weekBoardUrl = `/api/tasks?${new URLSearchParams({
    view: "weekly_board",
    week_end: weekEndIso,
    limit: "200",
  }).toString()}`;
  const [weekBoardRes, waitingRes, needsReviewRes] = await Promise.allSettled([
    fetchJson<TaskWithImplementation[]>(weekBoardUrl, "Failed to fetch this week's tasks"),
    fetchJson<WaitingTaskSource[]>("/api/tasks?view=waiting_summary&limit=30", "Failed to fetch blocked tasks"),
    fetchJson<NeedsReviewCountResponse>("/api/tasks?view=needs_review_count", "Failed to fetch review count"),
  ]);

  const sectionErrors: TodaySectionErrors = {};
  const sectionUpdatedAt: TodaySectionUpdatedAt = {};
  const refreshedAt = new Date().toISOString();

  function resolveSettled<T>(
    result: PromiseSettledResult<T>,
    fallback: T,
    section: TodaySectionKey,
    label: string
  ): T {
    if (result.status === "fulfilled") {
      sectionUpdatedAt[section] = refreshedAt;
      return result.value;
    }

    const message = toErrorMessage(result.reason, label);
    if (isAuthMessage(message)) {
      throw new Error(message);
    }

    sectionErrors[section] = message;
    if (previousSectionUpdatedAt[section]) {
      sectionUpdatedAt[section] = previousSectionUpdatedAt[section];
    }
    return fallback;
  }

  const weekBoardTasks = resolveSettled(weekBoardRes, previous?.weekBoardRaw ?? [], "weekBoard", "Failed to fetch this week's tasks");
  const waitingTasksFallback: WaitingTaskSource[] = (previous?.waitingOn || []).map((item) => ({
    id: item.id,
    title: item.title,
    waiting_on: item.waitingOn,
    follow_up_at: item.followUpAt,
  }));
  const waitingTasks = resolveSettled(waitingRes, waitingTasksFallback, "waitingOn", "Failed to fetch blocked tasks");
  const reviewPayload = resolveSettled(
    needsReviewRes,
    { count: previous?.needsReviewCount ?? 0 },
    "needsReview",
    "Failed to fetch review count"
  );
  const needsReviewCount = typeof reviewPayload.count === "number" ? reviewPayload.count : previous?.needsReviewCount ?? 0;

  return {
    slices: buildExecutionSlices(
      weekBoardTasks,
      waitingTasks,
      needsReviewCount,
      timeZone,
      meetingMinutes,
      syncedTaskIds
    ),
    sectionErrors,
    sectionUpdatedAt,
  };
}

async function fetchTodayData(timeZone: string): Promise<TodayData> {
  const calendarTodayUrl = `/api/calendar/today?${new URLSearchParams({ tz: timeZone }).toString()}`;
  const [calendarRes, latestSyncRes, sprintRes, inboxRes] = await Promise.allSettled([
    fetchJson<CalendarTodayResponse>(calendarTodayUrl, "Failed to fetch today's meetings"),
    fetchJson<LatestSyncResponse>("/api/planner/sync-today/latest", "Failed to fetch sync summary"),
    fetchCurrentSprintProgress(timeZone),
    fetchJson<IntelligenceInboxResponse>("/api/intelligence/artifacts", "Failed to fetch artifact inbox"),
  ]);

  const sectionErrors: TodaySectionErrors = {};
  const sectionUpdatedAt: TodaySectionUpdatedAt = {};
  const refreshedAt = new Date().toISOString();

  let calendarPayload: CalendarTodayResponse = { events: [], busyMinutes: 0 };
  if (calendarRes.status === "fulfilled") {
    calendarPayload = calendarRes.value;
    sectionUpdatedAt.meetings = refreshedAt;
  } else {
    const message = toErrorMessage(calendarRes.reason, "Failed to fetch today's meetings");
    if (isAuthMessage(message)) {
      throw new Error(message);
    }
    sectionErrors.meetings = message;
  }

  let latestSync: SyncTodaySummary | null = null;
  if (latestSyncRes.status === "fulfilled") {
    latestSync = latestSyncRes.value?.sync ?? null;
    sectionUpdatedAt.sync = refreshedAt;
  } else {
    const message = toErrorMessage(latestSyncRes.reason, "Failed to fetch sync summary");
    if (isAuthMessage(message)) {
      throw new Error(message);
    }
    sectionErrors.sync = message;
  }

  let currentSprint: SprintProgressSummary | null = null;
  if (sprintRes.status === "fulfilled") {
    currentSprint = sprintRes.value ?? null;
    sectionUpdatedAt.sprint = refreshedAt;
  } else {
    const message = toErrorMessage(sprintRes.reason, "Failed to fetch sprint progress");
    if (isAuthMessage(message)) {
      throw new Error(message);
    }
    sectionErrors.sprint = message;
  }

  const openArtifactCount = inboxRes.status === "fulfilled"
    ? typeof inboxRes.value?.counts?.open === "number"
      ? inboxRes.value.counts.open
      : 0
    : 0;

  const syncedTaskIds = new Set(latestSync?.task_ids || []);
  const meetingMinutes = normalizeBusyMinutes(calendarPayload.busyMinutes);
  const execution = await fetchExecutionSlices(
    timeZone,
    meetingMinutes,
    syncedTaskIds,
    getEndOfWeekIso(new Date()),
    null,
    sectionUpdatedAt
  );

  const meetings = (calendarPayload.events ?? [])
    .filter((event) => typeof event.start === "string" && typeof event.end === "string")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return {
    ...execution.slices,
    meetings,
    openArtifactCount,
    latestSync,
    currentSprint,
    sectionErrors: {
      ...sectionErrors,
      ...execution.sectionErrors,
    },
    sectionUpdatedAt: {
      ...sectionUpdatedAt,
      ...execution.sectionUpdatedAt,
    },
  };
}

async function fetchCommitments(): Promise<CommitmentSummary[]> {
  return fetchJson<CommitmentSummary[]>("/api/commitments", "Failed to fetch commitments");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

function formatShortDate(value: string): string {
  const parsedMs = toUtcDateMs(value);
  if (parsedMs === null) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(parsedMs));
}

function formatTasksPerDay(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function formatMeetingTimeRange(start: string, end: string, timeZone: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Time unavailable";
  }

  return `${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(startDate)} - ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(endDate)}`;
}

type MeetingTemporalStatus = "Upcoming" | "In progress" | "Ended";

function getMeetingTemporalStatus(event: MeetingEvent, nowMs: number): MeetingTemporalStatus {
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "Upcoming";
  }

  if (nowMs >= endMs) {
    return "Ended";
  }

  if (nowMs >= startMs) {
    return "In progress";
  }

  return "Upcoming";
}

function formatUpdatedTime(updatedAt: string, timeZone: string): string {
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(updatedDate);
}

function MeetingStatusBadge({ status }: { status: MeetingTemporalStatus }) {
  if (status === "Ended") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
          <path d="M7.7 13.3 4.4 10l1.2-1.2 2.1 2.1 6.7-6.7L15.6 5l-7.9 8.3Z" />
        </svg>
        Ended
      </span>
    );
  }

  if (status === "In progress") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        In progress
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full border border-stroke bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
      Upcoming
    </span>
  );
}

function getBoardEdgeClass(task: WeekBoardTaskData): string {
  if (task.dueState === "Overdue") {
    return "border-l-red-400";
  }

  if (task.dueState === "Due Today") {
    return "border-l-accent";
  }

  if (task.status === "Blocked/Waiting" || task.blocker || task.dependencyBlocked || task.needsReview) {
    return "border-l-amber-400";
  }

  return "border-l-stroke";
}

function TaskMetaChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "red" | "amber" | "green" | "blue";
}) {
  const toneClass = {
    neutral: "border-stroke bg-panel-muted text-muted-foreground",
    red: "border-red-500/30 bg-red-500/10 text-red-300",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    blue: "border-blue-500/30 bg-blue-500/10 text-blue-200",
  }[tone];

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClass}`}>
      {children}
    </span>
  );
}

function WeeklyTaskCard({
  task,
  completing,
  pinning,
  onOpen,
  onDone,
  onTogglePinned,
}: {
  task: WeekBoardTaskData;
  completing: boolean;
  pinning: boolean;
  onOpen: () => void;
  onDone: () => void;
  onTogglePinned: (taskId: string, nextPinned: boolean) => void | Promise<void>;
}) {
  const contextName = task.projectName ?? task.implementationName ?? null;
  const dueTone = task.dueState === "Overdue" ? "red" : task.dueState === "Due Today" ? "amber" : "neutral";

  return (
    <article
      className={`rounded-card border border-l-4 border-stroke bg-panel p-3 shadow-sm transition-colors hover:border-foreground/20 hover:bg-panel-muted/50 ${getBoardEdgeClass(task)}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-sm font-semibold leading-relaxed text-foreground">{task.title}</h3>
          {task.pinned ? <TaskMetaChip tone="amber">Pinned</TaskMetaChip> : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {task.dueState ? <TaskMetaChip tone={dueTone}>{task.dueState}</TaskMetaChip> : null}
          {task.syncedToday ? <TaskMetaChip tone="green">Synced Today</TaskMetaChip> : null}
          {task.blocker || task.dependencyBlocked ? <TaskMetaChip tone="red">Blocker</TaskMetaChip> : null}
          {task.status === "Blocked/Waiting" ? <TaskMetaChip tone="amber">Waiting</TaskMetaChip> : null}
          {task.needsReview ? <TaskMetaChip tone="amber">Review</TaskMetaChip> : null}
          {task.tags.slice(0, 2).map((tag) => (
            <TaskMetaChip key={tag}>{tag}</TaskMetaChip>
          ))}
        </div>

        <dl className="mt-3 space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <dt>Estimate</dt>
            <dd className="font-semibold text-foreground">{task.estimatedMinutes} min</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt>Due</dt>
            <dd className="font-semibold text-foreground">{task.dueAt ? formatDate(task.dueAt) : "No due date"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt>Status</dt>
            <dd className="font-semibold text-foreground">{task.status}</dd>
          </div>
        </dl>

        {contextName ? (
          <p className="mt-3 rounded-md bg-panel-muted px-2.5 py-2 text-xs text-muted-foreground">
            {task.projectName ? "Project" : "Application"}: {contextName}
          </p>
        ) : null}
      </button>

      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={completing}
          aria-label="Mark task complete"
          className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:border-green-500/50 hover:bg-green-500/20 disabled:opacity-50"
        >
          {completing ? "Marking..." : "✓ Done"}
        </button>
        <button
          type="button"
          onClick={() => onTogglePinned(task.id, !task.pinned)}
          disabled={pinning}
          aria-label={task.pinned ? "Unpin task from Today" : "Pin task to Today"}
          className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
            task.pinned
              ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/20"
              : "border-stroke bg-panel-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {pinning ? "..." : "Pin"}
        </button>
      </div>
    </article>
  );
}

function WeeklyBoardColumn({
  column,
  completingIds,
  pinningIds,
  onOpenTask,
  onDoneTask,
  onTogglePinned,
}: {
  column: WeekBoardColumn;
  completingIds: Set<string>;
  pinningIds: Set<string>;
  onOpenTask: (taskId: string) => void;
  onDoneTask: (taskId: string) => void;
  onTogglePinned: (taskId: string, nextPinned: boolean) => void | Promise<void>;
}) {
  return (
    <section
      className={`min-w-0 rounded-card border p-3 ${
        column.isCurrentDay
          ? "border-accent/50 bg-accent-soft/30"
          : "border-stroke bg-background/50"
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {column.title}
            {column.isCurrentDay ? <span className="ml-2 text-[11px] font-bold text-red-200">Today</span> : null}
          </h3>
          <p className="text-xs text-muted-foreground">{column.subtitle}</p>
        </div>
        <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">
          {column.tasks.length}
        </span>
      </div>

      {column.tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-xs text-muted-foreground">
          No tasks here.
        </p>
      ) : (
        <div className="space-y-3">
          {column.tasks.map((task) => (
            <WeeklyTaskCard
              key={task.id}
              task={task}
              completing={completingIds.has(task.id)}
              pinning={pinningIds.has(task.id)}
              onOpen={() => onOpenTask(task.id)}
              onDone={() => onDoneTask(task.id)}
              onTogglePinned={onTogglePinned}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WaitingReviewColumn({
  waitingOn,
  needsReviewCount,
  sectionUpdatedAt,
  sectionErrors,
  timeZone,
}: {
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  sectionUpdatedAt: TodaySectionUpdatedAt;
  sectionErrors: TodaySectionErrors;
  timeZone: string;
}) {
  const total = waitingOn.length + needsReviewCount;

  return (
    <section className="min-w-0 rounded-card border border-stroke bg-background/50 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Waiting / Review</h3>
          <p className="text-xs text-muted-foreground">
            {sectionUpdatedAt.waitingOn ? `Updated ${formatUpdatedTime(sectionUpdatedAt.waitingOn, timeZone)}` : "Blocked and queue items"}
          </p>
        </div>
        <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">{total}</span>
      </div>

      {sectionErrors.waitingOn ? (
        <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Waiting list refresh failed. Showing available data.
        </p>
      ) : null}

      <div className="space-y-3">
        {waitingOn.slice(0, 5).map((item) => (
          <article key={item.id} className="rounded-card border border-l-4 border-stroke border-l-amber-400 bg-panel p-3 shadow-sm">
            <h3 className="text-sm font-semibold leading-relaxed text-foreground">{item.title}</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Waiting on {item.waitingOn}
              {item.followUpAt ? ` · follow up ${formatDate(item.followUpAt)}` : ""}
            </p>
            <Link
              href={`/backlog?expand=${item.id}`}
              className="mt-3 inline-flex rounded-md border border-stroke bg-panel-muted px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-panel"
            >
              Open Task
            </Link>
          </article>
        ))}

        {needsReviewCount > 0 ? (
          <article className="rounded-card border border-l-4 border-stroke border-l-amber-400 bg-panel p-3 shadow-sm">
            <h3 className="text-sm font-semibold leading-relaxed text-foreground">
              {needsReviewCount} {needsReviewCount === 1 ? "task needs" : "tasks need"} review
            </h3>
            {sectionErrors.needsReview ? (
              <p className="mt-2 text-xs text-amber-300">Review count refresh failed. Showing available data.</p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Review queue remains one click away from the board.</p>
            )}
            <Link
              href="/backlog?review=needs_review"
              className="mt-3 inline-flex rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
            >
              Open Review Queue
            </Link>
          </article>
        ) : null}

        {waitingOn.length === 0 && needsReviewCount === 0 ? (
          <p className="rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-xs text-muted-foreground">
            Nothing blocked or waiting for review.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-12 animate-pulse rounded bg-panel-muted" />
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="animate-pulse rounded-card border border-stroke bg-panel p-5">
          <div className="h-4 w-40 rounded bg-panel-muted" />
          <div className="mt-4 space-y-2">
            <div className="h-3 w-full rounded bg-panel-muted" />
            <div className="h-3 w-2/3 rounded bg-panel-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

async function markTaskDone(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Done" }),
  });

  if (!response.ok) {
    throw new Error("Failed to mark task as done");
  }
}

async function setTaskPinned(taskId: string, pinned: boolean): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });

  if (!response.ok) {
    throw new Error("Failed to update pinned state");
  }
}

function applyPinnedState(data: TodayData, taskId: string, pinned: boolean): TodayData {
  return {
    ...data,
    weekBoard: data.weekBoard.map((task) => (task.id === taskId ? { ...task, pinned } : task)),
  };
}

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [pinningIds, setPinningIds] = useState<Set<string>>(new Set());
  const [modalTaskId, setModalTaskId] = useState<string | null>(null);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [commitmentsLoaded, setCommitmentsLoaded] = useState(false);
  const [commitmentsLoading, setCommitmentsLoading] = useState(false);
  const [timeZone, setTimeZone] = useState(DEFAULT_WORKDAY_CONFIG.timezone);
  const [timeZoneReady, setTimeZoneReady] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setTimeZone(resolveClientTimeZone());
    setTimeZoneReady(true);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
  const weekColumns = data ? buildWeekBoardColumns(data.weekBoard, new Date(nowMs), timeZone) : [];
  const weekdayColumns = weekColumns.filter((column) => column.key !== "weekend");
  const weekendColumn = weekColumns.find((column) => column.key === "weekend") ?? null;
  const boardTaskCount = data?.weekBoard.length ?? 0;
  const overdueCount = data?.weekBoard.filter((task) => task.dueState === "Overdue").length ?? 0;
  const todayDueCount = data?.weekBoard.filter((task) => task.dueState === "Due Today").length ?? 0;
  const boardMinutes = data?.weekBoard.reduce((sum, task) => sum + task.estimatedMinutes, 0) ?? 0;

  useEffect(() => {
    if (!timeZoneReady) {
      return;
    }

    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const todayData = await fetchTodayData(timeZone);
        if (isMounted) {
          setData(todayData);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load data");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, [timeZone, timeZoneReady]);

  useEffect(() => {
    if (!modalTaskId || commitmentsLoaded || commitmentsLoading) {
      return;
    }

    let isMounted = true;
    setCommitmentsLoading(true);

    fetchCommitments()
      .then((rows) => {
        if (!isMounted) {
          return;
        }
        setCommitments(rows);
        setCommitmentsLoaded(true);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load commitments");
      })
      .finally(() => {
        if (isMounted) {
          setCommitmentsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [modalTaskId, commitmentsLoaded, commitmentsLoading]);

  async function handleQuickComplete(taskId: string) {
    if (!data) return;
    if (!confirm("Mark as done?")) return;

    const previousData = data;
    setCompletingIds((prev) => new Set(prev).add(taskId));
    setError(null);

    try {
      await markTaskDone(taskId);
      const syncedTaskIds = new Set(previousData.latestSync?.task_ids || []);
      const meetingMinutes = previousData.capacity.breakdown.meeting_minutes;
      const execution = await fetchExecutionSlices(
        timeZone,
        meetingMinutes,
        syncedTaskIds,
        getEndOfWeekIso(new Date()),
        {
          weekBoard: previousData.weekBoard,
          waitingOn: previousData.waitingOn,
          needsReviewCount: previousData.needsReviewCount,
          capacity: previousData.capacity,
          weekBoardRaw: previousData.weekBoardRaw,
        },
        previousData.sectionUpdatedAt
      );

      setData((current) => {
        if (!current) {
          return current;
        }

        const nextSectionErrors: TodaySectionErrors = { ...current.sectionErrors };
        delete nextSectionErrors.weekBoard;
        delete nextSectionErrors.waitingOn;
        delete nextSectionErrors.needsReview;

        return {
          ...current,
          ...execution.slices,
          sectionErrors: { ...nextSectionErrors, ...execution.sectionErrors },
          sectionUpdatedAt: { ...current.sectionUpdatedAt, ...execution.sectionUpdatedAt },
        };
      });

      if (Object.keys(execution.sectionErrors).length > 0) {
        setError("Task completed, but some cards could not refresh.");
      }
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : "Failed to complete task");
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  const handleTaskUpdated = useCallback((taskId: string, updates: TaskUpdatePayload) => {
    setData((prev) => {
      if (!prev) return prev;

      const nextDueAt = Object.prototype.hasOwnProperty.call(updates, "due_at")
        ? (updates.due_at ?? null)
        : undefined;
      const nextDueState = nextDueAt !== undefined ? getDueState(nextDueAt, new Date(), timeZone) : undefined;

      function mergeCard(task: WeekBoardTaskData): WeekBoardTaskData {
        if (task.id !== taskId) {
          return task;
        }

        return {
          ...task,
          ...(typeof updates.title === "string" ? { title: updates.title } : {}),
          ...(Array.isArray(updates.tags) ? { tags: updates.tags } : {}),
          ...(typeof updates.estimated_minutes === "number" ? { estimatedMinutes: updates.estimated_minutes } : {}),
          ...(typeof updates.status === "string" ? { status: updates.status } : {}),
          ...(typeof updates.blocker === "boolean" ? { blocker: updates.blocker } : {}),
          ...(typeof updates.pinned === "boolean" ? { pinned: updates.pinned } : {}),
          ...(typeof updates.needs_review === "boolean" ? { needsReview: updates.needs_review } : {}),
          ...(typeof updates.waiting_on === "string" || updates.waiting_on === null ? { waitingOn: updates.waiting_on } : {}),
          ...(typeof updates.follow_up_at === "string" || updates.follow_up_at === null ? { followUpAt: updates.follow_up_at } : {}),
          ...(nextDueAt !== undefined ? { dueAt: nextDueAt, dueState: nextDueState } : {}),
        };
      }

      function mergeTask(task: TaskWithImplementation): TaskWithImplementation {
        return task.id === taskId ? { ...task, ...updates } : task;
      }

      return {
        ...prev,
        weekBoard: prev.weekBoard.map(mergeCard),
        weekBoardRaw: prev.weekBoardRaw.map(mergeTask),
      };
    });
  }, [timeZone]);

  const handleTaskDeleted = useCallback((taskId: string) => {
    setModalTaskId((current) => (current === taskId ? null : current));
    setData((prev) => {
      if (!prev) {
        return prev;
      }

      return {
        ...prev,
        weekBoard: prev.weekBoard.filter((task) => task.id !== taskId),
        weekBoardRaw: prev.weekBoardRaw.filter((task) => task.id !== taskId),
      };
    });
  }, []);

  async function handleTogglePinned(taskId: string, nextPinned: boolean) {
    if (!data || pinningIds.has(taskId)) return;

    const previousData = data;
    setPinningIds((prev) => new Set(prev).add(taskId));
    setError(null);
    setData((prev) => (prev ? applyPinnedState(prev, taskId, nextPinned) : prev));

    try {
      await setTaskPinned(taskId, nextPinned);
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : "Failed to update pin state");
    } finally {
      setPinningIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Today"
        description="Quick-view dashboard for meetings, priorities, and near-term execution risk."
        actions={
          <div className="flex items-center gap-3">
            <Link
              href="/backlog?review=intelligence"
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                (data?.openArtifactCount ?? 0) > 0
                  ? "border-red-500/30 bg-red-500/10 text-red-300 hover:border-red-400/40 hover:bg-red-500/15"
                  : "border-stroke bg-panel text-muted-foreground hover:bg-panel-muted hover:text-foreground"
              }`}
            >
              Artifact Inbox ({data?.openArtifactCount ?? 0})
            </Link>
            {data && <CapacityMeter capacity={data.capacity} />}
            <p className="rounded-full bg-panel-muted px-3 py-1.5 text-sm font-medium text-muted-foreground">{today}</p>
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <FocusStatusBar />

      {loading ? (
        <LoadingSkeleton />
      ) : data ? (
        <>
          <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Today&apos;s Meetings</h2>
                {data.sectionUpdatedAt.meetings ? (
                  <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.meetings, timeZone)}</p>
                ) : null}
              </div>
              <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
                {data.sectionErrors.meetings ? (
                  <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                    Meeting feed refresh failed. Showing available data.
                  </p>
                ) : null}
                {data.meetings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No meetings on your calendar today.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.meetings.map((event, index) => {
                      const temporalStatus = getMeetingTemporalStatus(event, nowMs);
                      return (
                        <li
                          key={`${event.start}-${event.title}-${index}`}
                          className={`rounded-lg p-3 text-sm ${
                            temporalStatus === "Ended" ? "bg-emerald-500/5" : "bg-panel-muted"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className={`font-medium ${temporalStatus === "Ended" ? "text-muted-foreground" : "text-foreground"}`}>
                                {event.title || "Untitled meeting"}
                              </p>
                              <p className="mt-1 text-muted-foreground">{formatMeetingTimeRange(event.start, event.end, timeZone)}</p>
                              {event.location ? <p className="mt-1 text-muted-foreground">{event.location}</p> : null}
                            </div>
                            <div className="shrink-0 self-center">
                              <MeetingStatusBadge status={temporalStatus} />
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </article>
            </div>

            <div className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sprint Progress</h2>
                {data.sectionUpdatedAt.sprint ? (
                  <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.sprint, timeZone)}</p>
                ) : null}
              </div>
              <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
                {data.sectionErrors.sprint ? (
                  <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                    Sprint status refresh failed. Showing available data.
                  </p>
                ) : null}
                {data.currentSprint ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{data.currentSprint.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatShortDate(data.currentSprint.startDate)} - {formatShortDate(data.currentSprint.endDate)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                          data.currentSprint.onTrack
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                            : "border-red-500/40 bg-red-500/10 text-red-400"
                        }`}
                      >
                        {data.currentSprint.onTrack ? "On Track" : "At Risk"}
                      </span>
                    </div>

                    <div className="mt-4">
                      <div className="h-2 overflow-hidden rounded-full bg-panel-muted">
                        <div
                          className={`h-full rounded-full ${data.currentSprint.onTrack ? "bg-emerald-500" : "bg-red-500"}`}
                          style={{ width: `${Math.min(100, Math.max(0, data.currentSprint.completionPct))}%` }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {data.currentSprint.completedTasks}/{data.currentSprint.totalTasks} tasks complete (
                        {data.currentSprint.completionPct}%)
                      </p>
                    </div>

                    <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <div className="rounded-md bg-panel-muted px-2 py-2">
                        <dt>In Progress</dt>
                        <dd className="mt-1 text-sm font-semibold text-foreground">{data.currentSprint.inProgressTasks}</dd>
                      </div>
                      <div className="rounded-md bg-panel-muted px-2 py-2">
                        <dt>Planned</dt>
                        <dd className="mt-1 text-sm font-semibold text-foreground">{data.currentSprint.plannedTasks}</dd>
                      </div>
                      <div className="rounded-md bg-panel-muted px-2 py-2">
                        <dt>Blocked</dt>
                        <dd className="mt-1 text-sm font-semibold text-foreground">{data.currentSprint.blockedTasks}</dd>
                      </div>
                      <div className="rounded-md bg-panel-muted px-2 py-2">
                        <dt>Workdays Left</dt>
                        <dd className="mt-1 text-sm font-semibold text-foreground">{data.currentSprint.daysLeft}</dd>
                      </div>
                    </dl>

                    <p className="mt-4 text-xs text-muted-foreground">
                      Needed pace (workdays, excluding weekends{SPRINT_HOLIDAY_SET.size > 0 ? " + holidays" : ""}):{" "}
                      <span className="font-semibold text-foreground">
                        {formatTasksPerDay(data.currentSprint.requiredTasksPerDay)} tasks/day
                      </span>
                    </p>

                    <p className="mt-2 text-xs text-muted-foreground">
                      Pace gap:{" "}
                      {data.currentSprint.tasksBehindPace > 0 ? (
                        <span className="font-semibold text-red-400">
                          {data.currentSprint.tasksBehindPace} {data.currentSprint.tasksBehindPace === 1 ? "task" : "tasks"} behind
                        </span>
                      ) : (
                        <span className="font-semibold text-emerald-400">On pace</span>
                      )}
                    </p>

                    <p className="mt-2 text-xs text-muted-foreground">
                      Forecast finish:{" "}
                      {data.currentSprint.forecastFinishDate ? (
                        <span
                          className={`font-semibold ${
                            data.currentSprint.forecastWithinSprint === false ? "text-red-400" : "text-foreground"
                          }`}
                        >
                          {formatShortDate(data.currentSprint.forecastFinishDate)}
                          {data.currentSprint.forecastWithinSprint === false ? " (after sprint end)" : ""}
                        </span>
                      ) : (
                        <span className="font-semibold text-muted-foreground">Waiting for completion trend</span>
                      )}
                    </p>

                    <Link
                      href={`/sprints/${data.currentSprint.id}`}
                      className="mt-4 inline-flex rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-panel"
                    >
                      Open Sprint
                    </Link>
                  </>
                ) : (
                  <div>
                    <p className="text-sm text-muted-foreground">No active sprint for today.</p>
                    <Link
                      href="/sprints"
                      className="mt-4 inline-flex rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-panel"
                    >
                      View Sprints
                    </Link>
                  </div>
                )}
              </article>
            </div>
          </section>

          <section className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <article className="rounded-card border border-stroke bg-panel p-4 shadow-sm md:col-span-2 xl:col-span-2">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">This Week</p>
                <h2 className="mt-1 text-xl font-semibold text-foreground">What&apos;s due this week</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Deadline-driven board for Monday through Friday, with weekend work separated below so the normal workweek stays clean.
                </p>
              </article>
              <article className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Open</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">{boardTaskCount}</p>
                <p className="mt-1 text-xs text-muted-foreground">{boardMinutes} min estimated</p>
              </article>
              <article className="rounded-card border border-red-500/30 bg-red-500/10 p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-red-300">Overdue</p>
                <p className="mt-1 text-2xl font-semibold text-red-200">{overdueCount}</p>
                <p className="mt-1 text-xs text-red-200/80">Red card edge</p>
              </article>
              <article className="rounded-card border border-accent/40 bg-accent-soft p-4 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-red-200">Due Today</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">{todayDueCount}</p>
                <p className="mt-1 text-xs text-red-100/70">Accent card edge</p>
              </article>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Weekly Board</h2>
                {data.sectionUpdatedAt.weekBoard ? (
                  <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.weekBoard, timeZone)}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">Red = overdue</span>
                <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-1 text-red-100">Accent = due today</span>
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">Amber = blocked / waiting / review</span>
              </div>
            </div>

            {data.sectionErrors.weekBoard ? (
              <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Weekly board refresh failed. Showing available data.
              </p>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {weekdayColumns.map((column) => (
                <WeeklyBoardColumn
                  key={column.key}
                  column={column}
                  completingIds={completingIds}
                  pinningIds={pinningIds}
                  onOpenTask={setModalTaskId}
                  onDoneTask={handleQuickComplete}
                  onTogglePinned={handleTogglePinned}
                />
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
              {weekendColumn ? (
                <WeeklyBoardColumn
                  column={weekendColumn}
                  completingIds={completingIds}
                  pinningIds={pinningIds}
                  onOpenTask={setModalTaskId}
                  onDoneTask={handleQuickComplete}
                  onTogglePinned={handleTogglePinned}
                />
              ) : null}
              <WaitingReviewColumn
                waitingOn={data.waitingOn}
                needsReviewCount={data.needsReviewCount}
                sectionUpdatedAt={data.sectionUpdatedAt}
                sectionErrors={data.sectionErrors}
                timeZone={timeZone}
              />
            </div>
          </section>
        </>
      ) : null}

      <TaskDetailModal
        task={
          modalTaskId
            ? (data?.weekBoardRaw.find((t) => t.id === modalTaskId) ?? null)
            : null
        }
        allTasks={[...(data?.weekBoardRaw ?? [])]}
        commitments={commitments}
        onClose={() => setModalTaskId(null)}
        onTaskUpdated={handleTaskUpdated}
        onTaskDeleted={handleTaskDeleted}
      />
    </div>
  );
}
