"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  CommitmentStatus,
  CommitmentSummary,
  TaskDependencySummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";

interface TaskDependenciesProps {
  taskId: string;
  dependencies: TaskDependencySummary[];
  availableTasks?: TaskWithImplementation[];
  availableCommitments?: CommitmentSummary[];
  onDependencyAdded?: (dependency: TaskDependencySummary) => void;
  onDependencyRemoved?: (dependencyId: string) => void;
}

const taskStatusColors: Record<TaskStatus, string> = {
  Backlog: "bg-panel-muted text-muted-foreground",
  Planned: "bg-blue-500/15 text-blue-300",
  "In Progress": "bg-indigo-500/15 text-indigo-300",
  "Blocked/Waiting": "bg-amber-500/15 text-amber-300",
  Parked: "bg-stone-500/15 text-stone-300",
  Missed: "bg-rose-500/15 text-rose-300",
  Done: "bg-success-soft text-success",
};

const commitmentStatusColors: Record<CommitmentStatus, string> = {
  Open: "bg-panel-muted text-muted-foreground",
  Done: "bg-success-soft text-success",
  Dropped: "bg-rose-500/15 text-rose-300",
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
        .filter((task) => task.status !== "Done" && task.status !== "Parked" && task.status !== "Missed")
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
            className="rounded-lg px-2 py-1 text-xs font-semibold text-accent-text transition hover:bg-accent/10"
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
                    <span className="rounded bg-panel-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground">
                      {dependency.type === "task" ? "Task" : "Commitment"}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${statusPillClass(dependency)}`}>
                      {dependency.status}
                    </span>
                    {!dependency.unresolved && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-semibold text-emerald-400">
                        Resolved
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRemove(dependency.id)}
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition hover:bg-danger-soft hover:text-danger"
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
            <Button variant="toggle" size="xs" active={dependencyType === "task"}
              onClick={() => {
                setDependencyType("task");
                setSelectedId("");
              }}>
              Task
            </Button>
            <Button variant="toggle" size="xs" active={dependencyType === "commitment"}
              onClick={() => {
                setDependencyType("commitment");
                setSelectedId("");
              }}>
              Commitment
            </Button>
          </div>

          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={ dependencyType === "task" ? "Search tasks by title..." : "Search commitments by title..." }
            disabled={isSubmitting}
          />

          <Select
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={isSubmitting}
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
          </Select>

          {selectableItems.length === 0 && (
            <p className="text-xs text-muted-foreground">No matching {dependencyType}s available.</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setIsAdding(false); setSelectedId(""); setSearchQuery(""); }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleAdd()}
              disabled={isSubmitting || !selectedId}
            >
              {isSubmitting ? "Adding..." : "Add"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p
          className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
