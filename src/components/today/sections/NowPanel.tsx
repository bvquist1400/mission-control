"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getTaskVisualState, TaskStateBadge } from "@/components/tasks/task-state";
import { useTodayModal } from "@/components/today/TodayModalProvider";
import type { TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

export interface NowPanelMeeting {
  title: string;
  start: string;
  end: string;
  location: string | null;
}

interface NowPanelProps {
  topTasks: TaskWithImplementation[];
  nextMeeting: NowPanelMeeting | null;
  syncNote: string;
}

function formatTimeRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Time unavailable";
  }
  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE }).format(date);
  return `${format(startDate)} - ${format(endDate)}`;
}

function formatCountdown(meeting: NowPanelMeeting, nowMs: number): string {
  const startMs = Date.parse(meeting.start);
  const endMs = Date.parse(meeting.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "";
  }

  if (nowMs >= startMs && nowMs < endMs) {
    const minsLeft = Math.max(1, Math.round((endMs - nowMs) / 60000));
    return `in progress · ${minsLeft} min left`;
  }

  const minsUntil = Math.round((startMs - nowMs) / 60000);
  if (minsUntil <= 0) {
    return "starting now";
  }
  if (minsUntil < 60) {
    return `in ${minsUntil} min`;
  }
  const hours = Math.floor(minsUntil / 60);
  const mins = minsUntil % 60;
  return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
}

function getDueLabel(dueAt: string | null, nowMs: number): string | null {
  if (!dueAt) {
    return null;
  }
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) {
    return null;
  }
  if (dueMs < nowMs) {
    return "Overdue";
  }
  const dueDay = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(dueMs));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(nowMs));
  if (dueDay === today) {
    return "Due today";
  }
  return "Due soon";
}

export function NowPanel({ topTasks, nextMeeting, syncNote }: NowPanelProps) {
  const router = useRouter();
  const { openTask, registerTasks } = useTodayModal();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    registerTasks(topTasks);
  }, [topTasks, registerTasks]);

  async function handleDone(task: TaskWithImplementation) {
    if (completingIds.has(task.id)) {
      return;
    }
    if (!window.confirm("Mark as done?")) {
      return;
    }

    setCompletingIds((prev) => new Set(prev).add(task.id));
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Done" }),
      });
      if (!response.ok) {
        throw new Error("Failed to mark task as done");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete task");
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <section className="rounded-card border-2 border-accent/50 bg-panel p-6 shadow-sm">
      <h2 className="text-xl font-bold text-foreground">Now</h2>

      <div className="mt-4 rounded-xl border border-stroke bg-panel-muted/60 p-4">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Next meeting</p>
        {nextMeeting ? (
          <div className="mt-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-lg font-semibold text-foreground">{nextMeeting.title || "Untitled meeting"}</p>
              <span className="shrink-0 text-sm font-semibold text-accent">{formatCountdown(nextMeeting, nowMs)}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{formatTimeRange(nextMeeting.start, nextMeeting.end)}</p>
            {nextMeeting.location ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{nextMeeting.location}</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1.5 text-base font-medium text-muted-foreground">No more meetings today.</p>
        )}
      </div>

      <div className="mt-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Top priorities</p>
        {error ? (
          <p className="mt-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {error}
          </p>
        ) : null}
        {topTasks.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-sm text-muted-foreground">
            No planned or in-progress tasks. Enjoy the clear runway.
          </p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {topTasks.map((task) => {
              const dueLabel = getDueLabel(task.due_at, nowMs);
              const state = getTaskVisualState({
                status: task.status,
                dependencyBlocked: Boolean(task.dependency_blocked),
                updatedAt: task.updated_at ?? null,
              });
              const completing = completingIds.has(task.id);
              return (
                <li
                  key={task.id}
                  className="rounded-xl border border-l-4 border-stroke border-l-accent bg-panel-muted/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => openTask(task)}
                      className="min-w-0 flex-1 text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      <p className="text-base font-semibold leading-snug text-foreground">{task.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {dueLabel ? (
                          <span
                            className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              dueLabel === "Overdue"
                                ? "bg-red-500/15 text-red-300"
                                : dueLabel === "Due today"
                                  ? "bg-accent-soft text-red-100"
                                  : "bg-panel text-muted-foreground"
                            }`}
                          >
                            {dueLabel}
                          </span>
                        ) : null}
                        {state ? <TaskStateBadge state={state} /> : null}
                        {task.implementation?.name ? (
                          <span className="text-[11px] text-muted-foreground">{task.implementation.name}</span>
                        ) : null}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDone(task)}
                      disabled={completing}
                      aria-label="Mark task complete"
                      className="shrink-0 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:border-green-500/50 hover:bg-green-500/20 disabled:opacity-50"
                    >
                      {completing ? "Marking..." : "✓ Done"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-5 text-xs text-muted-foreground">{syncNote}</p>
    </section>
  );
}
