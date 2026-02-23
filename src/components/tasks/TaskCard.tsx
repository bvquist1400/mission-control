import type { MouseEvent } from "react";
import type { TaskStatus } from "@/types/database";

type DueState = "Overdue" | "Due Today" | "Due Soon";

export interface TaskCardData {
  id: string;
  title: string;
  estimatedMinutes: number;
  dueAt: string | null;
  dueState?: DueState | null;
  status: TaskStatus;
  blocker: boolean;
  pinned: boolean;
  implementationName?: string | null;
}

interface TaskCardProps {
  task: TaskCardData;
  pinning?: boolean;
  onTogglePinned?: (taskId: string, nextPinned: boolean) => void | Promise<void>;
}

const dueStateStyles: Record<DueState, string> = {
  Overdue: "border-red-200 bg-red-50 text-red-700",
  "Due Today": "border-amber-200 bg-amber-50 text-amber-700",
  "Due Soon": "border-slate-200 bg-slate-100 text-slate-700",
};

function formatDueDate(date: string | null): string {
  if (!date) {
    return "No due date";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill={pinned ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={pinned ? 1.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 4h8v2l-2.5 2.5V12l2 2v1h-3v5l-.5.5L11.5 20v-5h-3v-1l2-2V8.5L8 6V4Z" />
    </svg>
  );
}

export function TaskCard({ task, pinning = false, onTogglePinned }: TaskCardProps) {
  function handlePinClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!onTogglePinned || pinning) {
      return;
    }

    void onTogglePinned(task.id, !task.pinned);
  }

  return (
    <article
      className={`rounded-card border border-stroke bg-panel p-4 shadow-sm transition-colors hover:border-foreground/20 hover:bg-panel-muted/50 ${
        task.pinned ? "border-l-4 border-l-amber-400/80" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <h3 className="flex-1 text-sm font-semibold leading-relaxed text-foreground">{task.title}</h3>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handlePinClick}
            disabled={!onTogglePinned || pinning}
            aria-label={task.pinned ? "Unpin task from Today" : "Pin task to Today"}
            title="Pin to Today (protected from sync)"
            className={`rounded-md border px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-60 ${
              task.pinned
                ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/20"
                : "border-stroke bg-panel text-muted-foreground hover:bg-panel-muted hover:text-foreground"
            }`}
          >
            {pinning ? (
              <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <PinIcon pinned={task.pinned} />
            )}
          </button>
          {task.blocker ? (
            <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-400">Blocker</span>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <dt>Estimate</dt>
          <dd className="font-semibold text-foreground">{task.estimatedMinutes} min</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>Due</dt>
          <dd className="flex items-center gap-2 font-semibold text-foreground">
            <span>{formatDueDate(task.dueAt)}</span>
            {task.dueState ? (
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${dueStateStyles[task.dueState]}`}>
                {task.dueState}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>Status</dt>
          <dd className="font-semibold text-foreground">{task.status}</dd>
        </div>
      </dl>

      {task.implementationName ? (
        <p className="mt-4 rounded-md bg-panel-muted px-2.5 py-2 text-xs text-muted-foreground">Application: {task.implementationName}</p>
      ) : null}
    </article>
  );
}
