"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommitmentStatus,
  CommitmentSummary,
  TaskDependencySummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { formatDay } from "@/lib/date-cascade-view";
import { dependencyTaskCandidates, fetchOpenTasksForPicker, pickerHint } from "@/lib/dependency-picker";
import type { TaskBlocksLink } from "@/lib/task-detail";

interface TaskDependenciesProps {
  taskId: string;
  dependencies: TaskDependencySummary[];
  /** Tasks that wait on this one (cascade S2 "Blocks" list); null = couldn't be read; omitted = not shown. */
  blocks?: TaskBlocksLink[] | null;
  /** The page's tasks; the picker also loads every open task itself (src/lib/dependency-picker.ts). */
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
  blocks,
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
  // Every open task, loaded once per window on "+ Add dependency" (the page
  // may know only the opened task). null = not loaded yet.
  const [loadedTasks, setLoadedTasks] = useState<TaskWithImplementation[] | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadingRef = useRef(false);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => loadAbortRef.current?.abort(), []);

  const loadOpenTasks = useCallback(() => {
    if (loadedTasks || loadingRef.current) return;
    loadingRef.current = true;
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadingTasks(true);
    setLoadFailed(false);
    fetchOpenTasksForPicker(fetch, controller.signal)
      .then((tasks) => {
        if (!controller.signal.aborted) setLoadedTasks(tasks);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      })
      .finally(() => {
        loadingRef.current = false;
        if (!controller.signal.aborted) setLoadingTasks(false);
      });
  }, [loadedTasks]);

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
      dependencyTaskCandidates({
        taskId,
        passed: availableTasks,
        loaded: loadedTasks,
        linkedIds: dependencyTaskIds,
        search: normalizedSearch,
      }),
    [availableTasks, dependencyTaskIds, loadedTasks, normalizedSearch, taskId]
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
  const hint = pickerHint(dependencyType, { loading: loadingTasks, failed: loadFailed, count: selectableItems.length });

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
              loadOpenTasks();
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

          {hint && (
            <p className="text-xs text-muted-foreground" aria-live="polite">{hint}</p>
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

      {blocks !== undefined ? <BlocksList blocks={blocks} /> : null}
    </div>
  );
}

/** Statuses whose task moves when the one it waits on moves later (S1's movable set). */
const FOLLOWS = new Set(["Backlog", "Planned", "In Progress", "Blocked/Waiting"]);

/**
 * Cascade S2 panel 9: the tasks that wait on this one, each with its date. Done
 * tasks are dimmed (they won't move); Parked or undated ones stay put too, but
 * the tasks after them can still move.
 */
function BlocksList({ blocks }: { blocks: TaskBlocksLink[] | null }) {
  return (
    <div className="mt-4 space-y-2 border-t border-stroke pt-3.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Blocks{blocks ? ` (${blocks.length})` : ""}
      </h4>
      {blocks === null ? (
        <p className="text-xs text-muted-foreground">Couldn’t load the tasks that wait on this one.</p>
      ) : blocks.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">Nothing waits on this task</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">These wait on this task. If its date moves later, the ones that can move will follow.</p>
          <ul className="space-y-2">
            {blocks.map((block) => {
              const status = (block.status ?? "Backlog") as TaskStatus;
              const stays = !FOLLOWS.has(status) || !block.due_at;
              const done = status === "Done";
              return (
                <li key={block.dependency_id}>
                  <div className={`rounded-lg border border-stroke bg-panel p-2.5 ${done ? "opacity-60" : ""}`}>
                    <p className="truncate text-sm font-medium text-foreground">{block.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="rounded bg-panel-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground">Task</span>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${taskStatusColors[status] ?? taskStatusColors.Backlog}`}>
                        {block.status ?? "Unknown"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {block.due_at ? (
                          <>
                            {done ? "Was due" : "Due"} <b className="font-semibold text-foreground">{formatDay(block.due_at)}</b>
                            {stays ? " · stays put" : ""}
                          </>
                        ) : (
                          "No due date · stays put"
                        )}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
