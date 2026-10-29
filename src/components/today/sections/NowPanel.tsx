"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTodayModal } from "@/components/today/TodayModalProvider";
import { useTaskMutation } from "@/hooks/useTaskMutation";
import type { TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { buildRangeCardView } from "@/lib/task-range-view";
import { progressRowsFor } from "@/lib/break-into-tasks";
import { NowTaskCard, nowStepsId } from "@/components/today/cards/NowTaskCard";
import { InlineSteps } from "@/components/tasks/InlineSteps";

type ChecklistRows = NonNullable<TaskWithImplementation["checklist_rows"]>;

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

export function NowPanel({ topTasks, nextMeeting, syncNote }: NowPanelProps) {
  const router = useRouter();
  const { openTask, registerTasks } = useTodayModal();
  const { completeTask } = useTaskMutation();
  // Multi-day tasks S2: the open steps, and rows ticked here until fresh props land.
  const [openStepsId, setOpenStepsId] = useState<string | null>(null);
  const [rowOverrides, setRowOverrides] = useState<Map<string, ChecklistRows>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  // Locally hidden while the server re-streams; cleared whenever fresh props land
  // so a task restored elsewhere (the detail modal) isn't filtered out forever.
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [renderedTasks, setRenderedTasks] = useState(topTasks);

  if (renderedTasks !== topTasks) {
    setRenderedTasks(topTasks);
    setCompletedIds(new Set());
    setRowOverrides(new Map());
  }

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    registerTasks(topTasks);
  }, [topTasks, registerTasks]);

  const visibleTasks = useMemo(
    () => topTasks.filter((task) => !completedIds.has(task.id)),
    [topTasks, completedIds]
  );

  async function handleDone(task: TaskWithImplementation) {
    if (completingIds.has(task.id)) {
      return;
    }

    setCompletingIds((prev) => new Set(prev).add(task.id));
    // Hide immediately, matching the week board. The streamed props are the
    // source of truth, so a failed request just needs the id released again.
    setCompletedIds((prev) => new Set(prev).add(task.id));

    await completeTask(task, {
      onRollback: () => {
        setCompletedIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      },
      onUndo: () => {
        setCompletedIds((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      },
    });

    setCompletingIds((prev) => {
      const next = new Set(prev);
      next.delete(task.id);
      return next;
    });
  }

  return (
    <section className="rounded-card border-2 border-accent/50 bg-panel p-6 shadow-sm">
      <h2 className="text-xl font-bold text-foreground">Now</h2>

      <div className="mt-4 rounded-xl border border-stroke bg-panel-muted/60 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Next meeting</p>
        {nextMeeting ? (
          <div className="mt-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-lg font-semibold text-foreground">{nextMeeting.title || "Untitled meeting"}</p>
              <span className="shrink-0 text-sm font-semibold text-accent-text">{formatCountdown(nextMeeting, nowMs)}</span>
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
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">Top priorities</p>
        {visibleTasks.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-sm text-muted-foreground">
            No planned or in-progress tasks. Enjoy the clear runway.
          </p>
        ) : (
          <ul className="mt-2 space-y-2.5">
            {visibleTasks.map((task) => {
              // An umbrella (Break into tasks) counts its step tasks; others their checklist.
              const progress = progressRowsFor(task);
              const stepsAreTasks = progress.source === "tasks";
              const rows = stepsAreTasks ? progress.rows : rowOverrides.get(task.id) ?? progress.rows;
              const range = buildRangeCardView(task, rows, new Date(nowMs), { stepsAreTasks });
              const stepsOpen = openStepsId === task.id;
              return (
                <NowTaskCard
                  key={task.id}
                  task={task}
                  nowMs={nowMs}
                  completing={completingIds.has(task.id)}
                  onOpen={() => openTask(task)}
                  onDone={() => handleDone(task)}
                  range={range}
                  stepsOpen={stepsOpen}
                  onToggleSteps={() => setOpenStepsId((current) => (current === task.id ? null : task.id))}
                  steps={
                    range && stepsOpen ? (
                      <InlineSteps
                        id={nowStepsId(task.id)}
                        taskId={task.id}
                        view={range}
                        stepTasks={stepsAreTasks ? task.step_tasks : undefined}
                        onRowsChange={(next) =>
                          setRowOverrides((prev) => new Map(prev).set(task.id, next))
                        }
                        onSaved={() => router.refresh()}
                        onDone={() => handleDone(task)}
                        doneDisabled={completingIds.has(task.id)}
                      />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-5 text-xs text-muted-foreground">{syncNote}</p>
    </section>
  );
}
