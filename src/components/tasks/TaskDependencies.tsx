"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  CommitmentStatus,
  CommitmentSummary,
  TaskDependencySummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";

interface TaskDependenciesProps {
  taskId: string;
  dependencies: TaskDependencySummary[];
  availableTasks?: TaskWithImplementation[];
  availableCommitments?: CommitmentSummary[];
  onDependencyAdded?: (dependency: TaskDependencySummary) => void;
  onDependencyRemoved?: (dependencyId: string) => void;
}

const taskStatusColors: Record<TaskStatus, string> = {
  Backlog: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
  Planned: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  "In Progress": "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  "Blocked/Waiting": "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  Done: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const commitmentStatusColors: Record<CommitmentStatus, string> = {
  Open: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
  Done: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  Dropped: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

function statusPillClass(dependency: TaskDependencySummary): string {
  if (dependency.type === "task") {
    return taskStatusColors[dependency.status as TaskStatus] ?? taskStatusColors.Backlog;
  }

  return commitmentStatusColors[dependency.status as CommitmentStatus] ?? commitmentStatusColors.Open;
}

function getDependencyOptionLabel(
  type: "task" | "commitment",
  item: TaskWithImplementation | CommitmentSummary
): string {
  if (type === "task") {
    const task = item as TaskWithImplementation;
    const implementationName = task.implementation?.name ? ` (${task.implementation.name})` : "";
    return `${task.title}${implementationName}`;
  }

  const commitment = item as CommitmentSummary;
  const stakeholderName = commitment.stakeholder?.name ? ` (${commitment.stakeholder.name})` : "";
  return `${commitment.title}${stakeholderName}`;
}

export function TaskDependencies({
  taskId,
  dependencies,
  availableTasks = [],
  availableCommitments = [],
  onDependencyAdded,
  onDependencyRemoved,
}: TaskDependenciesProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [dependencyType, setDependencyType] = useState<"task" | "commitment">("task");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unresolvedDependencies = useMemo(
    () => dependencies.filter((dependency) => dependency.unresolved),
    [dependencies]
  );

  const dependencyTaskIds = useMemo(
    () =>
      new Set(
        dependencies
          .filter((dependency) => dependency.type === "task" && dependency.depends_on_task_id)
          .map((dependency) => dependency.depends_on_task_id as string)
      ),
    [dependencies]
  );

  const dependencyCommitmentIds = useMemo(
    () =>
      new Set(
        dependencies
          .filter((dependency) => dependency.type === "commitment" && dependency.depends_on_commitment_id)
          .map((dependency) => dependency.depends_on_commitment_id as string)
      ),
    [dependencies]
  );

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const selectableTasks = useMemo(
    () =>
      availableTasks
        .filter((task) => task.id !== taskId)
        .filter((task) => !dependencyTaskIds.has(task.id))
        .filter((task) => task.status !== "Done")
        .filter((task) => {
          if (!normalizedSearch) {
            return true;
          }

          const implementationName = task.implementation?.name || "";
          return `${task.title} ${implementationName}`.toLowerCase().includes(normalizedSearch);
        })
        .sort((a, b) => b.priority_score - a.priority_score),
    [availableTasks, dependencyTaskIds, normalizedSearch, taskId]
  );

  const selectableCommitments = useMemo(
    () =>
      availableCommitments
        .filter((commitment) => !dependencyCommitmentIds.has(commitment.id))
        .filter((commitment) => commitment.status !== "Done")
        .filter((commitment) => {
          if (!normalizedSearch) {
            return true;
          }

          const stakeholderName = commitment.stakeholder?.name || "";
          return `${commitment.title} ${stakeholderName}`.toLowerCase().includes(normalizedSearch);
        })
        .sort((a, b) => a.title.localeCompare(b.title)),
    [availableCommitments, dependencyCommitmentIds, normalizedSearch]
  );

  const selectableItems = dependencyType === "task" ? selectableTasks : selectableCommitments;

  const handleAdd = useCallback(async () => {
    if (!selectedId) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          dependencyType === "task"
            ? { type: "task", depends_on_task_id: selectedId }
            : { type: "commitment", depends_on_commitment_id: selectedId }
        ),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to add dependency" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to add dependency");
      }

      const dependency = (await response.json()) as TaskDependencySummary;
      onDependencyAdded?.(dependency);
      setSelectedId("");
      setSearchQuery("");
      setIsAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add dependency");
    } finally {
      setIsSubmitting(false);
    }
  }, [dependencyType, onDependencyAdded, selectedId, taskId]);

  const handleRemove = useCallback(
    async (dependencyId: string) => {
      setError(null);

      try {
        const response = await fetch(`/api/tasks/${taskId}/dependencies/${dependencyId}`, {
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
    },
    [onDependencyRemoved, taskId]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Dependencies ({dependencies.length})
        </h4>
        {!isAdding && (
          <button
            type="button"
            onClick={() => {
              setDependencyType("task");
              setSelectedId("");
              setSearchQuery("");
              setIsAdding(true);
            }}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-accent transition hover:bg-accent/10"
          >
            + Add dependency
          </button>
        )}
      </div>

      {dependencies.length > 0 ? (
        <ul className="space-y-2">
          {dependencies.map((dependency) => (
            <li key={dependency.id}>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-stroke bg-panel p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{dependency.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-panel-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {dependency.type === "task" ? "Task" : "Commitment"}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusPillClass(dependency)}`}>
                      {dependency.status}
                    </span>
                    {!dependency.unresolved && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                        Resolved
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(dependency.id)}
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                  title="Remove dependency"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs italic text-muted-foreground">No dependencies linked yet</p>
      )}

      {dependencies.length > 0 && unresolvedDependencies.length === 0 && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300">
          Dependencies cleared — ready to activate?
        </p>
      )}

      {isAdding && (
        <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDependencyType("task");
                setSelectedId("");
              }}
              className={`rounded px-2 py-1 text-xs font-semibold transition ${
                dependencyType === "task"
                  ? "bg-accent text-white"
                  : "bg-panel text-muted-foreground hover:text-foreground"
              }`}
            >
              Task
            </button>
            <button
              type="button"
              onClick={() => {
                setDependencyType("commitment");
                setSelectedId("");
              }}
              className={`rounded px-2 py-1 text-xs font-semibold transition ${
                dependencyType === "commitment"
                  ? "bg-accent text-white"
                  : "bg-panel text-muted-foreground hover:text-foreground"
              }`}
            >
              Commitment
            </button>
          </div>

          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={
              dependencyType === "task" ? "Search tasks by title..." : "Search commitments by title..."
            }
            disabled={isSubmitting}
            className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          />

          <select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={isSubmitting}
            className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">
              {dependencyType === "task"
                ? "Select a task dependency..."
                : "Select a commitment dependency..."}
            </option>
            {selectableItems.map((item) => (
              <option key={item.id} value={item.id}>
                {getDependencyOptionLabel(dependencyType, item)}
              </option>
            ))}
          </select>

          {selectableItems.length === 0 && (
            <p className="text-xs text-muted-foreground">No matching {dependencyType}s available.</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setIsAdding(false);
                setSelectedId("");
                setSearchQuery("");
              }}
              disabled={isSubmitting}
              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={isSubmitting || !selectedId}
              className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Adding..." : "Add"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
