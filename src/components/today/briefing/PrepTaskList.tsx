"use client";

import Link from "next/link";
import type { PrepTask, TaskSummary } from "@/lib/briefing";

interface PrepTaskListProps {
  tasks: PrepTask[];
  title?: string;
  maxTasks?: number;
}

export function PrepTaskList({ tasks, title = "Prep Tasks", maxTasks = 5 }: PrepTaskListProps) {
  const displayTasks = tasks.slice(0, maxTasks);
  const hasMore = tasks.length > maxTasks;

  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-stroke bg-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No prep tasks identified</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-stroke bg-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <ul className="space-y-3">
        {displayTasks.map((prepTask) => (
          <li key={prepTask.task.id} className="flex items-start gap-2">
            <span className="mt-0.5 text-yellow-400">&#9889;</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/tasks/${prepTask.task.id}`}
                  className="block truncate text-sm font-medium text-foreground hover:text-accent"
                >
                  {prepTask.task.title}
                </Link>
                {prepTask.task.implementation_phase === "Sundown" && (
                  <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                    Sundown
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {prepTask.reason}
                {prepTask.task.estimated_minutes > 0 && (
                  <span className="ml-2 text-foreground">
                    ({prepTask.task.estimated_minutes} min)
                  </span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <p className="mt-2 text-xs text-muted-foreground">
          +{tasks.length - maxTasks} more prep tasks
        </p>
      )}
    </div>
  );
}

interface RolledOverListProps {
  tasks: TaskSummary[];
  title?: string;
}

export function RolledOverList({ tasks, title = "Rolling Over" }: RolledOverListProps) {
  if (tasks.length === 0) {
    return null;
  }

  const totalMinutes = tasks.reduce((sum, t) => sum + t.estimated_minutes, 0);

  return (
    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-yellow-400">
          {tasks.length} tasks ({totalMinutes} min)
        </span>
      </div>
      <ul className="space-y-2">
        {tasks.slice(0, 5).map((task) => (
          <li key={task.id} className="flex items-center gap-2">
            <span className="text-yellow-400">&#8594;</span>
            <Link
              href={`/tasks/${task.id}`}
              className="truncate text-sm text-foreground hover:text-accent"
            >
              {task.title}
            </Link>
            {task.implementation_phase === "Sundown" && (
              <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                Sundown
              </span>
            )}
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              ({task.estimated_minutes} min)
            </span>
          </li>
        ))}
        {tasks.length > 5 && (
          <li className="text-xs text-muted-foreground">
            +{tasks.length - 5} more tasks rolling over
          </li>
        )}
      </ul>
    </div>
  );
}

interface CompletedListProps {
  tasks: TaskSummary[];
  title?: string;
}

export function CompletedList({ tasks, title = "Completed Today" }: CompletedListProps) {
  if (tasks.length === 0) {
    return null;
  }

  const totalMinutes = tasks.reduce((sum, t) => sum + t.estimated_minutes, 0);

  return (
    <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-green-400">
          {tasks.length} tasks ({totalMinutes} min)
        </span>
      </div>
      <ul className="space-y-1">
        {tasks.slice(0, 5).map((task) => (
          <li key={task.id} className="flex items-center gap-2 text-sm">
            <span className="text-green-400">&#10003;</span>
            <span className="truncate text-muted-foreground line-through">
              {task.title}
            </span>
          </li>
        ))}
        {tasks.length > 5 && (
          <li className="text-xs text-muted-foreground">
            +{tasks.length - 5} more completed
          </li>
        )}
      </ul>
    </div>
  );
}
