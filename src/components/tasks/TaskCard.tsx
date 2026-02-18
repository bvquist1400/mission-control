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
  implementationName?: string | null;
}

interface TaskCardProps {
  task: TaskCardData;
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

export function TaskCard({ task }: TaskCardProps) {
  return (
    <article className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold leading-relaxed text-foreground">{task.title}</h3>
        {task.blocker ? (
          <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-400">Blocker</span>
        ) : null}
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
