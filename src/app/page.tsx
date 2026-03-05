"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { TaskCard, type TaskCardData } from "@/components/tasks/TaskCard";
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

type TodaySectionKey = "meetings" | "topThree" | "dueSoon" | "waitingOn" | "needsReview" | "sync" | "sprint";
type TodaySectionErrors = Partial<Record<TodaySectionKey, string>>;
type TodaySectionUpdatedAt = Partial<Record<TodaySectionKey, string>>;

interface TodayData {
  topThree: TaskCardData[];
  dueSoon: TaskCardData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  capacity: CapacityResult;
  meetings: MeetingEvent[];
  latestSync: SyncTodaySummary | null;
  currentSprint: SprintProgressSummary | null;
  sectionErrors: TodaySectionErrors;
  sectionUpdatedAt: TodaySectionUpdatedAt;
  // Raw tasks kept for modal lookup
  topThreeRaw: TaskWithImplementation[];
  dueSoonRaw: TaskWithImplementation[];
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

function dedupeTasksForCapacity(...groups: TaskWithImplementation[][]): TaskWithImplementation[] {
  const byId = new Map<string, TaskWithImplementation>();

  for (const group of groups) {
    for (const task of group) {
      if (!byId.has(task.id)) {
        byId.set(task.id, task);
      }
    }
  }

  return Array.from(byId.values());
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
  topThree: TaskCardData[];
  dueSoon: TaskCardData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  capacity: CapacityResult;
  topThreeRaw: TaskWithImplementation[];
  dueSoonRaw: TaskWithImplementation[];
}

function buildExecutionSlices(
  topThreeTasks: TaskWithImplementation[],
  dueSoonTasks: TaskWithImplementation[],
  waitingTasks: WaitingTaskSource[],
  needsReviewCount: number,
  timeZone: string,
  meetingMinutes: number,
  syncedTaskIds: Set<string>
): ExecutionSlices {
  const now = new Date();
  const topThree = topThreeTasks.map((task) => taskToCardData(task, undefined, syncedTaskIds.has(task.id)));
  const dueSoon = dueSoonTasks
    .slice(0, 6)
    .map((task) => taskToCardData(task, getDueState(task.due_at, now, timeZone), syncedTaskIds.has(task.id)));
  const waitingOn: WaitingTask[] = waitingTasks.map((task) => ({
    id: task.id,
    title: task.title,
    waitingOn: task.waiting_on || "Unknown",
    followUpAt: task.follow_up_at,
  }));

  const tasksForCapacity = dedupeTasksForCapacity(topThreeTasks, dueSoonTasks);
  const topThreeIds = new Set(topThreeTasks.map((task) => task.id));
  const capacity = calculateCapacity(tasksForCapacity, topThreeIds, normalizeBusyMinutes(meetingMinutes));

  return {
    topThree,
    dueSoon,
    waitingOn,
    needsReviewCount,
    capacity,
    topThreeRaw: topThreeTasks,
    dueSoonRaw: dueSoonTasks.slice(0, 6),
  };
}

async function fetchExecutionSlices(
  timeZone: string,
  meetingMinutes: number,
  syncedTaskIds: Set<string>,
  previous: ExecutionSlices | null = null,
  previousSectionUpdatedAt: TodaySectionUpdatedAt = {}
): Promise<{ slices: ExecutionSlices; sectionErrors: TodaySectionErrors; sectionUpdatedAt: TodaySectionUpdatedAt }> {
  const [topThreeRes, dueSoonRes, waitingRes, needsReviewRes] = await Promise.allSettled([
    fetchJson<TaskWithImplementation[]>("/api/tasks?view=top3", "Failed to fetch top priorities"),
    fetchJson<TaskWithImplementation[]>("/api/tasks?view=due_soon&limit=30", "Failed to fetch due soon tasks"),
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

  const topThreeTasks = resolveSettled(topThreeRes, previous?.topThreeRaw ?? [], "topThree", "Failed to fetch top priorities");
  const dueSoonTasks = resolveSettled(dueSoonRes, previous?.dueSoonRaw ?? [], "dueSoon", "Failed to fetch due soon tasks");
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
      topThreeTasks,
      dueSoonTasks,
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
  const [calendarRes, latestSyncRes, sprintRes] = await Promise.allSettled([
    fetchJson<CalendarTodayResponse>(calendarTodayUrl, "Failed to fetch today's meetings"),
    fetchJson<LatestSyncResponse>("/api/planner/sync-today/latest", "Failed to fetch sync summary"),
    fetchCurrentSprintProgress(timeZone),
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

  const syncedTaskIds = new Set(latestSync?.task_ids || []);
  const meetingMinutes = normalizeBusyMinutes(calendarPayload.busyMinutes);
  const execution = await fetchExecutionSlices(timeZone, meetingMinutes, syncedTaskIds, null, sectionUpdatedAt);

  const meetings = (calendarPayload.events ?? [])
    .filter((event) => typeof event.start === "string" && typeof event.end === "string")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return {
    ...execution.slices,
    meetings,
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

function formatSyncTime(syncAt: string, timeZone: string): string {
  const syncDate = new Date(syncAt);
  if (Number.isNaN(syncDate.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(syncDate);
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
    topThree: data.topThree.map((task) => (task.id === taskId ? { ...task, pinned } : task)),
    dueSoon: data.dueSoon.map((task) => (task.id === taskId ? { ...task, pinned } : task)),
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
        {
          topThree: previousData.topThree,
          dueSoon: previousData.dueSoon,
          waitingOn: previousData.waitingOn,
          needsReviewCount: previousData.needsReviewCount,
          capacity: previousData.capacity,
          topThreeRaw: previousData.topThreeRaw,
          dueSoonRaw: previousData.dueSoonRaw,
        },
        previousData.sectionUpdatedAt
      );

      setData((current) => {
        if (!current) {
          return current;
        }

        const nextSectionErrors: TodaySectionErrors = { ...current.sectionErrors };
        delete nextSectionErrors.topThree;
        delete nextSectionErrors.dueSoon;
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
      function mergeTask(task: TaskWithImplementation): TaskWithImplementation {
        return task.id === taskId ? { ...task, ...updates } : task;
      }
      return {
        ...prev,
        topThree: prev.topThree.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        dueSoon: prev.dueSoon.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        topThreeRaw: prev.topThreeRaw.map(mergeTask),
        dueSoonRaw: prev.dueSoonRaw.map(mergeTask),
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
              href="/planner"
              className="rounded-full border border-stroke bg-panel px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              Open Planner
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

      {data ? (
        <section className="rounded-lg border border-stroke bg-panel-muted px-4 py-3 text-sm">
          {data.sectionErrors.sync ? (
            <p className="text-muted-foreground">Sync status is temporarily unavailable.</p>
          ) : data.latestSync ? (
            <p className="text-muted-foreground">
              Last sync at{" "}
              <span className="font-semibold text-foreground">{formatSyncTime(data.latestSync.synced_at, timeZone)}</span>
              {" · "}
              promoted <span className="font-semibold text-foreground">{data.latestSync.promoted}</span>
              {", "}
              demoted <span className="font-semibold text-foreground">{data.latestSync.demoted}</span>
              {", "}
              pinned protected <span className="font-semibold text-foreground">{data.latestSync.skipped_pinned}</span>
            </p>
          ) : (
            <p className="text-muted-foreground">
              No recent sync found. Top 3 is rank-ordered from active work; sync selects the planned set.
            </p>
          )}
          {data.sectionUpdatedAt.sync ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Updated {formatUpdatedTime(data.sectionUpdatedAt.sync, timeZone)}
            </p>
          ) : null}
        </section>
      ) : null}

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

          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Top 3 Today</h2>
              {data.sectionUpdatedAt.topThree ? (
                <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.topThree, timeZone)}</p>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              Rank-ordered active work. Tasks tagged{" "}
              <span className="font-semibold text-emerald-400">Synced Today</span> came from your latest sync run.
            </p>
            {data.sectionErrors.topThree ? (
              <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Top 3 refresh failed. Showing available data.
              </p>
            ) : null}
            {data.topThree.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks scheduled.</p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-3">
                {data.topThree.map((task) => (
                  <div key={task.id} className="flex flex-col gap-2">
                    <div
                      role="button"
                      tabIndex={0}
                      className="block cursor-pointer text-left focus:outline-none focus-visible:rounded-card focus-visible:ring-2 focus-visible:ring-accent/50"
                      aria-label={`Open task details for ${task.title}`}
                      onClick={() => setModalTaskId(task.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setModalTaskId(task.id);
                        }
                      }}
                    >
                      <TaskCard
                        task={task}
                        pinning={pinningIds.has(task.id)}
                        onTogglePinned={handleTogglePinned}
                      />
                    </div>
                    <button
                      onClick={() => handleQuickComplete(task.id)}
                      disabled={completingIds.has(task.id)}
                      aria-label="Mark task complete"
                      className="w-full rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:border-green-500/50 hover:bg-green-500/20 disabled:opacity-50"
                      title="Mark as done"
                    >
                      {completingIds.has(task.id) ? "Marking done..." : "✓ Done"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Due Soon (48h)</h2>
              {data.sectionUpdatedAt.dueSoon ? (
                <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.dueSoon, timeZone)}</p>
              ) : null}
            </div>
            {data.sectionErrors.dueSoon ? (
              <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Due-soon refresh failed. Showing available data.
              </p>
            ) : null}
            {data.dueSoon.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing due in the next 48 hours.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {data.dueSoon.map((task) => (
                  <div key={task.id} className="flex flex-col gap-2">
                    <div
                      role="button"
                      tabIndex={0}
                      className="block cursor-pointer text-left focus:outline-none focus-visible:rounded-card focus-visible:ring-2 focus-visible:ring-accent/50"
                      aria-label={`Open task details for ${task.title}`}
                      onClick={() => setModalTaskId(task.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setModalTaskId(task.id);
                        }
                      }}
                    >
                      <TaskCard
                        task={task}
                        pinning={pinningIds.has(task.id)}
                        onTogglePinned={handleTogglePinned}
                      />
                    </div>
                    <button
                      onClick={() => handleQuickComplete(task.id)}
                      disabled={completingIds.has(task.id)}
                      aria-label="Mark task complete"
                      className="w-full rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:border-green-500/50 hover:bg-green-500/20 disabled:opacity-50"
                      title="Mark as done"
                    >
                      {completingIds.has(task.id) ? "Marking done..." : "✓ Done"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Blocked / Waiting</h2>
                {data.sectionUpdatedAt.waitingOn ? (
                  <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.waitingOn, timeZone)}</p>
                ) : null}
              </div>
              {data.sectionErrors.waitingOn ? (
                <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  Waiting list refresh failed. Showing available data.
                </p>
              ) : null}
              {data.waitingOn.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No tasks waiting on others.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {data.waitingOn.map((item) => (
                    <li key={item.id} className="rounded-lg bg-panel-muted p-3 text-sm">
                      <p className="font-medium text-foreground">{item.title}</p>
                      <p className="mt-1 text-muted-foreground">
                        {item.waitingOn}
                        {item.followUpAt ? ` · follow up ${formatDate(item.followUpAt)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Needs Review</h2>
                {data.sectionUpdatedAt.needsReview ? (
                  <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(data.sectionUpdatedAt.needsReview, timeZone)}</p>
                ) : null}
              </div>
              {data.sectionErrors.needsReview ? (
                <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  Review count refresh failed. Showing available data.
                </p>
              ) : null}
              {data.needsReviewCount === 0 ? (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">All caught up! No tasks need review.</p>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">
                    {data.needsReviewCount} {data.needsReviewCount === 1 ? "task needs" : "tasks need"} review in backlog.
                  </p>
                  <Link
                    href="/backlog?review=needs_review"
                    className="mt-4 inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    Open Review Queue ({data.needsReviewCount})
                  </Link>
                </div>
              )}
            </article>
          </section>
        </>
      ) : null}

      <TaskDetailModal
        task={
          modalTaskId
            ? (data?.topThreeRaw.find((t) => t.id === modalTaskId) ??
               data?.dueSoonRaw.find((t) => t.id === modalTaskId) ??
               null)
            : null
        }
        allTasks={[...(data?.topThreeRaw ?? []), ...(data?.dueSoonRaw ?? [])]}
        commitments={commitments}
        onClose={() => setModalTaskId(null)}
        onTaskUpdated={handleTaskUpdated}
      />
    </div>
  );
}
