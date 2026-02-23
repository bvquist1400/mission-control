"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { TaskCard, type TaskCardData } from "@/components/tasks/TaskCard";
import { CapacityMeter } from "@/components/today/CapacityMeter";
import { FocusStatusBar } from "@/components/today/FocusStatusBar";
import type { TaskWithImplementation, CapacityResult } from "@/types/database";
import { calculateCapacity } from "@/lib/capacity";

interface WaitingTask {
  id: string;
  title: string;
  waitingOn: string;
  followUpAt: string | null;
}

interface MeetingEvent {
  title: string;
  start: string;
  end: string;
  location: string | null;
}

interface TodayData {
  topThree: TaskCardData[];
  dueSoon: TaskCardData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  capacity: CapacityResult;
  meetings: MeetingEvent[];
}

interface NeedsReviewCountResponse {
  count?: number;
}

interface CalendarTodayResponse {
  events?: MeetingEvent[];
  busyMinutes?: number;
}

interface ApiErrorPayload {
  error?: string;
}

function taskToCardData(task: TaskWithImplementation, dueState?: TaskCardData["dueState"]): TaskCardData {
  return {
    id: task.id,
    title: task.title,
    estimatedMinutes: task.estimated_minutes,
    dueAt: task.due_at,
    dueState,
    status: task.status,
    blocker: task.blocker,
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

function getDueState(dueAt: string | null, now: Date): TaskCardData["dueState"] {
  if (!dueAt) {
    return null;
  }

  const dueDate = new Date(dueAt);
  if (dueDate.getTime() < now.getTime()) {
    return "Overdue";
  }

  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (dueDate.getTime() <= endOfToday.getTime()) {
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

async function fetchTodayData(): Promise<TodayData> {
  const [topThreeTasks, dueSoonTasks, waitingTasks, reviewCountPayload, calendarPayload] = await Promise.all([
    fetchJson<TaskWithImplementation[]>("/api/tasks?view=top3", "Failed to fetch top priorities"),
    fetchJson<TaskWithImplementation[]>("/api/tasks?view=due_soon&limit=30", "Failed to fetch due soon tasks"),
    fetchJson<TaskWithImplementation[]>("/api/tasks?status=Blocked%2FWaiting", "Failed to fetch blocked tasks"),
    fetchJson<NeedsReviewCountResponse>("/api/tasks?view=needs_review_count", "Failed to fetch review count"),
    fetchJson<CalendarTodayResponse>("/api/calendar/today", "Failed to fetch today's meetings"),
  ]);

  const now = new Date();

  const topThree = topThreeTasks.map((task) => taskToCardData(task));
  const dueSoon = dueSoonTasks.slice(0, 6).map((task) => taskToCardData(task, getDueState(task.due_at, now)));
  const waitingOn: WaitingTask[] = waitingTasks.map((task) => ({
    id: task.id,
    title: task.title,
    waitingOn: task.waiting_on || "Unknown",
    followUpAt: task.follow_up_at,
  }));

  const tasksForCapacity = dedupeTasksForCapacity(topThreeTasks, dueSoonTasks);
  const topThreeIds = new Set(topThreeTasks.map((task) => task.id));
  const meetingMinutes = normalizeBusyMinutes(calendarPayload.busyMinutes);
  const capacity = calculateCapacity(tasksForCapacity, topThreeIds, meetingMinutes);

  const meetings = (calendarPayload.events || [])
    .filter((event) => typeof event.start === "string" && typeof event.end === "string")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return {
    topThree,
    dueSoon,
    waitingOn,
    needsReviewCount: typeof reviewCountPayload.count === "number" ? reviewCountPayload.count : 0,
    capacity,
    meetings,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

function formatMeetingTimeRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Time unavailable";
  }

  return `${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(startDate)} - ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(endDate)}`;
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

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const todayData = await fetchTodayData();
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
  }, []);

  async function handleQuickComplete(taskId: string) {
    if (!data) return;
    if (!confirm("Mark as done?")) return;

    const previousData = data;
    setCompletingIds((prev) => new Set(prev).add(taskId));
    setError(null);

    try {
      await markTaskDone(taskId);
      const todayData = await fetchTodayData();
      setData(todayData);
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

      {loading ? (
        <LoadingSkeleton />
      ) : data ? (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Today&apos;s Meetings</h2>
            <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              {data.meetings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No meetings on your calendar today.</p>
              ) : (
                <ul className="space-y-3">
                  {data.meetings.map((event, index) => (
                    <li key={`${event.start}-${event.title}-${index}`} className="rounded-lg bg-panel-muted p-3 text-sm">
                      <p className="font-medium text-foreground">{event.title || "Untitled meeting"}</p>
                      <p className="mt-1 text-muted-foreground">{formatMeetingTimeRange(event.start, event.end)}</p>
                      {event.location ? <p className="mt-1 text-muted-foreground">{event.location}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Top 3 Today</h2>
            {data.topThree.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks scheduled.</p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-3">
                {data.topThree.map((task) => (
                  <div key={task.id} className="flex flex-col gap-2">
                    <Link href={`/backlog?expand=${task.id}`} className="block">
                      <TaskCard task={task} />
                    </Link>
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
            <h2 className="text-lg font-semibold text-foreground">Due Soon (48h)</h2>
            {data.dueSoon.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing due in the next 48 hours.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {data.dueSoon.map((task) => (
                  <div key={task.id} className="relative">
                    <Link href={`/backlog?expand=${task.id}`} className="block">
                      <TaskCard task={task} />
                    </Link>
                    <button
                      onClick={() => handleQuickComplete(task.id)}
                      disabled={completingIds.has(task.id)}
                      aria-label="Mark task complete"
                      className="absolute right-3 top-3 rounded-md bg-green-500/15 px-2 py-1 text-xs font-medium text-green-400 transition hover:bg-green-500/25 disabled:opacity-50"
                      title="Mark as done"
                    >
                      {completingIds.has(task.id) ? "..." : "✓ Done"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground">Blocked / Waiting</h2>
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
              <h2 className="text-lg font-semibold text-foreground">Needs Review</h2>
              {data.needsReviewCount === 0 ? (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">All caught up! No tasks need review.</p>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">
                    {data.needsReviewCount} {data.needsReviewCount === 1 ? "task needs" : "tasks need"} review in triage.
                  </p>
                  <Link
                    href="/triage"
                    className="mt-4 inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    Open Triage ({data.needsReviewCount})
                  </Link>
                </div>
              )}
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}
