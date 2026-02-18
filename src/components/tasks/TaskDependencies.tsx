"use client";

import { useState, useCallback } from "react";
import type { TaskStatus, TaskWithImplementation } from "@/types/database";

interface DependencyTask {
  id: string;
  title: string;
  status: TaskStatus;
  blocker: boolean;
  implementation?: { id: string; name: string } | null;
}

interface Dependency {
  id: string;
  blocker_task_id: string;
  blocked_task_id: string;
  created_at: string;
  blocker_task?: DependencyTask;
  blocked_task?: DependencyTask;
}

interface TaskDependenciesProps {
  taskId: string;
  blockedBy: Dependency[];
  blocking: Dependency[];
  availableTasks?: TaskWithImplementation[];
  onDependencyAdded?: (dependency: Dependency) => void;
  onDependencyRemoved?: (dependencyId: string) => void;
}

const statusColors: Record<TaskStatus, string> = {
  Backlog: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
  Planned: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  "In Progress": "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  "Blocked/Waiting": "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  Done: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

export function TaskDependencies({
  taskId,
  blockedBy,
  blocking,
  availableTasks = [],
  onDependencyAdded,
  onDependencyRemoved,
}: TaskDependenciesProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter out tasks that are already dependencies or the task itself
  const existingIds = new Set([
    taskId,
    ...blockedBy.map((d) => d.blocker_task_id),
    ...blocking.map((d) => d.blocked_task_id),
  ]);
  const selectableTasks = availableTasks.filter(
    (t) => !existingIds.has(t.id) && t.status !== "Done"
  );

  const handleAdd = useCallback(async () => {
    if (!selectedTaskId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocker_task_id: selectedTaskId }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to add dependency" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to add dependency");
      }

      const dependency = (await response.json()) as Dependency;
      onDependencyAdded?.(dependency);
      setSelectedTaskId("");
      setIsAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add dependency");
    } finally {
      setIsSubmitting(false);
    }
  }, [taskId, selectedTaskId, onDependencyAdded]);

  const handleRemove = useCallback(async (dependencyId: string) => {
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/dependencies?dependencyId=${dependencyId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to remove dependency" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to remove dependency");
      }

      onDependencyRemoved?.(dependencyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove dependency");
    }
  }, [taskId, onDependencyRemoved]);

  const renderTask = (task: DependencyTask | undefined, dependencyId: string) => {
    if (!task) return null;

    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-stroke bg-panel p-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{task.title}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusColors[task.status]}`}>
              {task.status}
            </span>
            {task.blocker && (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                Blocker
              </span>
            )}
            {task.implementation?.name && (
              <span className="truncate text-[10px] text-muted-foreground">
                {task.implementation.name}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => handleRemove(dependencyId)}
          className="shrink-0 rounded p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
          title="Remove dependency"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Blocked By Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Blocked By ({blockedBy.length})
          </h4>
          {!isAdding && selectableTasks.length > 0 && (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-accent transition hover:bg-accent/10"
            >
              + Add Blocker
            </button>
          )}
        </div>

        {blockedBy.length > 0 ? (
          <ul className="space-y-2">
            {blockedBy.map((dep) => (
              <li key={dep.id}>{renderTask(dep.blocker_task, dep.id)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground italic">No blocking dependencies</p>
        )}

        {isAdding && (
          <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <select
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Select a task that blocks this one...</option>
              {selectableTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                  {task.implementation?.name ? ` (${task.implementation.name})` : ""}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setSelectedTaskId("");
                }}
                disabled={isSubmitting}
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                disabled={isSubmitting || !selectedTaskId}
                className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Adding..." : "Add"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Blocking Section */}
      {blocking.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Blocking ({blocking.length})
          </h4>
          <ul className="space-y-2">
            {blocking.map((dep) => (
              <li key={dep.id}>{renderTask(dep.blocked_task, dep.id)}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
