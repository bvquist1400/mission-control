"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { TaskCard, type TaskCardData } from "@/components/tasks/TaskCard";
import { CapacityMeter } from "@/components/today/CapacityMeter";
import { FocusStatusBar } from "@/components/today/FocusStatusBar";
import { PlannerCard } from "@/components/today/PlannerCard";
import { DailyBriefing } from "@/components/today/briefing";
import { localDateString } from "@/components/utils/dates";
import type { TaskWithImplementation, CapacityResult } from "@/types/database";
import { calculateCapacity } from "@/lib/capacity";

const TASKS_PAGE_SIZE = 200;
const DAILY_BRIEFING_ENABLED = process.env.NEXT_PUBLIC_ENABLE_DAILY_BRIEFING === "true";

interface WaitingTask {
  id: string;
  title: string;
  waitingOn: string;
  followUpAt: string | null;
}

interface TodayData {
  topThree: TaskCardData[];
  dueSoon: TaskCardData[];
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  capacity: CapacityResult;
}

interface CalendarStatsResponse {
  stats?: {
    busyMinutes?: number;
  };
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

async function fetchTaskPage(params: Record<string, string>): Promise<TaskWithImplementation[]> {
  const searchParams = new URLSearchParams(params);
  const response = await fetch(`/api/tasks?${searchParams.toString()}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }

  return response.json();
}

async function fetchAllTaskPages(baseParams: Record<string, string>): Promise<TaskWithImplementation[]> {
  const allTasks: TaskWithImplementation[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchTaskPage({
      ...baseParams,
      limit: String(TASKS_PAGE_SIZE),
      offset: String(offset),
    });

    allTasks.push(...page);

    if (page.length < TASKS_PAGE_SIZE) {
      break;
    }

    offset += TASKS_PAGE_SIZE;
  }

  return allTasks;
}

async function fetchTodayMeetingMinutes(): Promise<number> {
  const today = localDateString();
  const response = await fetch(`/api/calendar?rangeStart=${today}&rangeEnd=${today}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    return 0;
  }

  const payload = (await response.json()) as CalendarStatsResponse;
  const meetingMinutes = payload.stats?.busyMinutes;

  if (typeof meetingMinutes !== "number" || !Number.isFinite(meetingMinutes) || meetingMinutes < 0) {
    return 0;
  }

  return meetingMinutes;
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

async function fetchTodayData(): Promise<TodayData> {
  const [allTasks, meetingMinutes] = await Promise.all([
    fetchAllTaskPages({}),
    fetchTodayMeetingMinutes().catch(() => 0),
  ]);

  // Sort by priority_score descending for top 3
  const sortedByPriority = [...allTasks]
    .filter((t) => t.status === "Planned" || t.status === "In Progress")
    .sort((a, b) => b.priority_score - a.priority_score);

  const topThree = sortedByPriority.slice(0, 3).map((task) => taskToCardData(task));
  const topThreeIds = new Set(topThree.map((t) => t.id));

  // Due soon: tasks due within 48h + overdue, excluding top 3 and done tasks.
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const dueSoon = allTasks
    .filter((task) => {
      if (task.status === "Done" || topThreeIds.has(task.id)) return false;
      if (!task.due_at) return false;
      const dueDate = new Date(task.due_at);
      return dueDate <= in48h;
    })
    .sort((a, b) => {
      const aDue = new Date(a.due_at!).getTime();
      const bDue = new Date(b.due_at!).getTime();
      const aOverdue = aDue < now.getTime();
      const bOverdue = bDue < now.getTime();

      if (aOverdue !== bOverdue) {
        return aOverdue ? -1 : 1;
      }

      return aDue - bDue;
    })
    .slice(0, 6)
    .map((task) => taskToCardData(task, getDueState(task.due_at, now)));

  // Waiting on: tasks with status "Blocked/Waiting"
  const waitingOn: WaitingTask[] = allTasks
    .filter((task) => task.status === "Blocked/Waiting")
    .map((task) => ({
      id: task.id,
      title: task.title,
      waitingOn: task.waiting_on || "Unknown",
      followUpAt: task.follow_up_at,
    }));

  // Calculate capacity
  const tasksForCapacity = allTasks.map((t) => ({
    ...t,
    stakeholder_mentions: t.stakeholder_mentions || [],
  }));
  const capacity = calculateCapacity(tasksForCapacity, new Set(topThree.map((t) => t.id)), meetingMinutes);

  return {
    topThree,
    dueSoon,
    waitingOn,
    needsReviewCount: allTasks.filter((t) => t.needs_review).length,
    capacity,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 animate-pulse rounded bg-panel-muted" />
        <div className="h-8 w-48 animate-pulse rounded bg-panel-muted" />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse rounded-card border border-stroke bg-panel p-4">
            <div className="h-4 w-2/3 rounded bg-panel-muted" />
            <div className="mt-4 space-y-2">
              <div className="h-3 w-full rounded bg-panel-muted" />
              <div className="h-3 w-full rounded bg-panel-muted" />
              <div className="h-3 w-full rounded bg-panel-muted" />
            </div>
          </div>
        ))}
      </div>
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
  const activeFocusDirectiveIdRef = useRef<string | null>(null);
  const [plannerReplanSignal, setPlannerReplanSignal] = useState(0);
  const [plannerAutoReplanKey, setPlannerAutoReplanKey] = useState<string | null>(null);

  const handleFocusDirectiveChange = useCallback((directiveId: string | null) => {
    if (activeFocusDirectiveIdRef.current === directiveId) {
      return;
    }

    activeFocusDirectiveIdRef.current = directiveId;
    setPlannerReplanSignal((value) => value + 1);
    setPlannerAutoReplanKey(directiveId ? `focus:${directiveId}` : null);
  }, []);

  const handlePlannerAutoReplanHandled = useCallback((handledKey: string) => {
    setPlannerAutoReplanKey((current) => (current === handledKey ? null : current));
  }, []);

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
      // Reload data to get updated lists and capacity
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
        description="Daily operating view with top priorities, near-term due work, and review queue."
        actions={
          <div className="flex items-center gap-4">
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

      <FocusStatusBar onDirectiveChange={handleFocusDirectiveChange} />

      {DAILY_BRIEFING_ENABLED ? <DailyBriefing replanSignal={plannerReplanSignal} /> : null}

      <PlannerCard autoReplanKey={plannerAutoReplanKey} onAutoReplanHandled={handlePlannerAutoReplanHandled} />

      {loading ? (
        <LoadingSkeleton />
      ) : data ? (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Top 3 Today</h2>
            {data.topThree.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks scheduled.</p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-3">
                {data.topThree.map((task) => (
                  <div key={task.id} className="relative">
                    <TaskCard task={task} />
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

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Due Soon (48h)</h2>
            {data.dueSoon.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing due in the next 48 hours.</p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {data.dueSoon.map((task) => (
                  <div key={task.id} className="relative">
                    <TaskCard task={task} />
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
