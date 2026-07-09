"use client";

import { useEffect } from "react";
import { useTodayModal } from "@/components/today/TodayModalProvider";
import type { BlockedReason, TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  prerequisite: "Prerequisite",
  need_info: "Need info",
  decision: "Decision",
  approval: "Approval",
  external: "External",
  other: "Other",
};

function formatFollowUp(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE }).format(parsed);
}

export function WaitingStrip({ tasks }: { tasks: TaskWithImplementation[] }) {
  const { openTask, registerTasks } = useTodayModal();

  useEffect(() => {
    registerTasks(tasks);
  }, [tasks, registerTasks]);

  if (tasks.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Blocked / Waiting</h2>
      <div className="flex flex-wrap gap-2">
        {tasks.map((task) => {
          const reasonLabel = task.blocked_reason ? BLOCKED_REASON_LABELS[task.blocked_reason] : null;
          const followUp = task.follow_up_at ? formatFollowUp(task.follow_up_at) : null;
          return (
            <button
              key={task.id}
              type="button"
              onClick={() => openTask(task)}
              className="group inline-flex max-w-full items-center gap-2 rounded-full border border-l-4 border-stroke border-l-amber-400 bg-panel px-3 py-1.5 text-left shadow-sm transition hover:border-foreground/20 hover:bg-panel-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-500/30">
                {reasonLabel ?? "Waiting"}
              </span>
              {followUp ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">follow up {followUp}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
