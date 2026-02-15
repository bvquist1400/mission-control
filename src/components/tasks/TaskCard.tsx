import type { TaskStatus } from "@/types/database";

export interface TaskCardData {
  id: string;
  title: string;
  estimatedMinutes: number;
  dueAt: string | null;
  status: TaskStatus;
  blocker: boolean;
  implementationName?: string | null;
}

interface TaskCardProps {
  task: TaskCardData;
}

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
          <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">Blocker</span>
        ) : null}
      </div>

      <dl className="mt-4 space-y-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <dt>Estimate</dt>
          <dd className="font-semibold text-foreground">{task.estimatedMinutes} min</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>Due</dt>
          <dd className="font-semibold text-foreground">{formatDueDate(task.dueAt)}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt>Status</dt>
          <dd className="font-semibold text-foreground">{task.status}</dd>
        </div>
      </dl>

      {task.implementationName ? (
        <p className="mt-4 rounded-md bg-panel-muted px-2.5 py-2 text-xs text-muted-foreground">Implementation: {task.implementationName}</p>
      ) : null}
    </article>
  );
}
