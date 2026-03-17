"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useSprints } from "@/hooks/useSprints";
import { ChecklistSection } from "@/components/tasks/ChecklistSection";
import { TaskComments } from "@/components/tasks/TaskComments";
import { TaskDependencies } from "@/components/tasks/TaskDependencies";
import { TaskMetaEditor } from "@/components/tasks/TaskMetaEditor";
import { TaskTagChips } from "@/components/tasks/TaskTagChips";
import {
  localDateInputToEndOfDayIso,
  timestampToLocalDateInputValue,
} from "@/components/utils/dates";
import { StatusSelector } from "@/components/ui/StatusSelector";
import { fetchTaskDetails, type TaskDetailData } from "@/lib/task-detail";
import type {
  CommitmentSummary,
  ImplementationSummary,
  TaskChecklistItem,
  TaskComment,
  TaskDependencySummary,
  TaskStatus,
  TaskUpdatePayload,
  TaskWithImplementation,
} from "@/types/database";

export type TaskGridScopeMode = "global" | "implementation" | "project";

type SortDirection = "asc" | "desc";
type SortField = "task" | "estimate" | "due" | "priority";

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

const DEFAULT_SORT_DIRECTIONS: Record<SortField, SortDirection> = {
  task: "asc",
  estimate: "asc",
  due: "asc",
  priority: "desc",
};

interface TaskGridProps {
  tasks: TaskWithImplementation[];
  visibleTasks?: TaskWithImplementation[];
  setTasks: Dispatch<SetStateAction<TaskWithImplementation[]>>;
  implementations: ImplementationSummary[];
  commitments: CommitmentSummary[];
  scopeMode: TaskGridScopeMode;
  emptyStateTitle: string;
  emptyStateBody: string;
  initialExpandedTaskId?: string | null;
}

export function TaskGridLoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((item) => (
        <div key={item} className="animate-pulse rounded-card border border-stroke bg-panel p-4">
          <div className="h-4 w-2/5 rounded bg-panel-muted" />
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((block) => (
              <div key={block} className="h-9 rounded bg-panel-muted" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
      <p className="text-lg font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function getUnresolvedDependencies(task: TaskWithImplementation): TaskDependencySummary[] {
  return (task.dependencies || []).filter((dependency) => dependency.unresolved);
}

function getDependencyWaitingLabel(task: TaskWithImplementation): string | null {
  const unresolvedDependencies = getUnresolvedDependencies(task);
  if (unresolvedDependencies.length === 0) {
    return null;
  }

  const [first] = unresolvedDependencies;
  if (!first) {
    return null;
  }

  if (unresolvedDependencies.length === 1) {
    return first.title;
  }

  return `${first.title} +${unresolvedDependencies.length - 1} more`;
}

function getDependencyBlockedState(dependencies: TaskDependencySummary[]): boolean {
  return dependencies.some((dependency) => dependency.unresolved);
}

function getDueTimestamp(task: TaskWithImplementation): number | null {
  if (!task.due_at) {
    return null;
  }

  const timestamp = new Date(task.due_at).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function TaskGrid({
  tasks,
  visibleTasks,
  setTasks,
  implementations,
  commitments,
  scopeMode,
  emptyStateTitle,
  emptyStateBody,
  initialExpandedTaskId = null,
}: TaskGridProps) {
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, number>>({});
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [estimateDrafts, setEstimateDrafts] = useState<Record<string, string>>({});
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(initialExpandedTaskId);
  const [taskDetailsById, setTaskDetailsById] = useState<Record<string, TaskDetailData>>({});
  const [loadingDetailIds, setLoadingDetailIds] = useState<Record<string, boolean>>({});
  const { sprints } = useSprints();
  const isMountedRef = useRef(true);
  const taskDetailsByIdRef = useRef(taskDetailsById);
  const activeDetailRequestIdsRef = useRef<Record<string, number>>({});
  const detailRequestCounterRef = useRef(0);

  const scopedTasks = visibleTasks ?? tasks;
  const showImplementationColumn = scopeMode === "global";
  const showSprintColumn = true;
  const columnCount = showImplementationColumn ? 11 : 10;

  useEffect(() => {
    setExpandedTaskId(initialExpandedTaskId ?? null);
  }, [initialExpandedTaskId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    taskDetailsByIdRef.current = taskDetailsById;
  }, [taskDetailsById]);

  useEffect(() => {
    if (!expandedTaskId) {
      return;
    }

    if (tasks.some((task) => task.id === expandedTaskId)) {
      return;
    }

    setExpandedTaskId(null);
  }, [expandedTaskId, tasks]);

  useEffect(() => {
    if (!expandedTaskId || taskDetailsByIdRef.current[expandedTaskId]) {
      return;
    }

    const taskId = expandedTaskId;
    const controller = new AbortController();
    const requestId = detailRequestCounterRef.current + 1;
    detailRequestCounterRef.current = requestId;
    activeDetailRequestIdsRef.current = { ...activeDetailRequestIdsRef.current, [taskId]: requestId };
    setLoadingDetailIds((current) => {
      if (current[taskId]) {
        return current;
      }

      return { ...current, [taskId]: true };
    });

    void fetchTaskDetails(taskId, controller.signal)
      .then((details) => {
        if (
          controller.signal.aborted ||
          !isMountedRef.current ||
          activeDetailRequestIdsRef.current[taskId] !== requestId
        ) {
          return;
        }

        setTaskDetailsById((current) => ({ ...current, [taskId]: details }));
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          !isMountedRef.current ||
          activeDetailRequestIdsRef.current[taskId] !== requestId
        ) {
          return;
        }

        setTaskDetailsById((current) => ({
          ...current,
          [taskId]: { comments: [], checklist: [], dependencies: [] },
        }));
      })
      .finally(() => {
        if (!isMountedRef.current || activeDetailRequestIdsRef.current[taskId] !== requestId) {
          return;
        }

        const nextRequests = { ...activeDetailRequestIdsRef.current };
        delete nextRequests[taskId];
        activeDetailRequestIdsRef.current = nextRequests;
        setLoadingDetailIds((current) => {
          if (!current[taskId]) {
            return current;
          }

          const next = { ...current };
          delete next[taskId];
          return next;
        });
      });

    return () => {
      controller.abort();
    };
  }, [expandedTaskId]);

  useEffect(() => {
    if (!expandedTaskId) {
      return;
    }

    let isMounted = true;
    const intervalId = window.setInterval(() => {
      void fetchTaskDetails(expandedTaskId)
        .then((details) => {
          if (!isMounted) {
            return;
          }

          setTaskDetailsById((current) => ({ ...current, [expandedTaskId]: details }));
        })
        .catch(() => {
          // Non-blocking refresh.
        });
    }, 15000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [expandedTaskId]);

  const toggleExpanded = useCallback((taskId: string) => {
    setExpandedTaskId((current) => (current === taskId ? null : taskId));
  }, []);

  const handleCommentAdded = useCallback((taskId: string, comment: TaskComment) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: { ...details, comments: [...details.comments, comment] },
      };
    });
  }, []);

  const handleCommentUpdated = useCallback((taskId: string, updated: TaskComment) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...details,
          comments: details.comments.map((comment) => (comment.id === updated.id ? updated : comment)),
        },
      };
    });
  }, []);

  const handleCommentDeleted = useCallback((taskId: string, commentId: string) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...details,
          comments: details.comments.filter((comment) => comment.id !== commentId),
        },
      };
    });
  }, []);

  const handleDependencyAdded = useCallback((taskId: string, dependency: TaskDependencySummary) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: { ...details, dependencies: [...details.dependencies, dependency] },
      };
    });

    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        const nextDependencies = [...(task.dependencies || []), dependency];
        return {
          ...task,
          dependencies: nextDependencies,
          dependency_blocked: getDependencyBlockedState(nextDependencies),
        };
      })
    );
  }, [setTasks]);

  const handleDependencyRemoved = useCallback((taskId: string, dependencyId: string) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...details,
          dependencies: details.dependencies.filter((dependency) => dependency.id !== dependencyId),
        },
      };
    });

    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        const nextDependencies = (task.dependencies || []).filter((dependency) => dependency.id !== dependencyId);
        return {
          ...task,
          dependencies: nextDependencies,
          dependency_blocked: getDependencyBlockedState(nextDependencies),
        };
      })
    );
  }, [setTasks]);

  const handleChecklistToggle = useCallback(async (taskId: string, item: TaskChecklistItem) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...details,
          checklist: details.checklist.map((checklistItem) =>
            checklistItem.id === item.id ? { ...checklistItem, is_done: !checklistItem.is_done } : checklistItem
          ),
        },
      };
    });

    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: item.id, is_done: !item.is_done }] }),
      });

      if (!response.ok) {
        throw new Error("Failed to update checklist");
      }
    } catch {
      setTaskDetailsById((current) => {
        const details = current[taskId];
        if (!details) {
          return current;
        }

        return {
          ...current,
          [taskId]: {
            ...details,
            checklist: details.checklist.map((checklistItem) =>
              checklistItem.id === item.id ? { ...checklistItem, is_done: item.is_done } : checklistItem
            ),
          },
        };
      });
    }
  }, []);

  const handleAddChecklistItem = useCallback(async (taskId: string, text: string) => {
    if (!text.trim()) {
      return;
    }

    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });

      if (!response.ok) {
        return;
      }

      const newItem = (await response.json()) as TaskChecklistItem;
      setTaskDetailsById((current) => {
        const details = current[taskId];
        if (!details) {
          return current;
        }

        return {
          ...current,
          [taskId]: { ...details, checklist: [...details.checklist, newItem] },
        };
      });
    } catch {
      // Silently fail.
    }
  }, []);

  const handleUpdateChecklistItem = useCallback(async (taskId: string, itemId: string, text: string) => {
    const nextText = text.trim();
    if (!nextText) {
      return;
    }

    const details = taskDetailsById[taskId];
    const existingItem = details?.checklist.find((checklistItem) => checklistItem.id === itemId);
    if (!existingItem) {
      return;
    }

    const previousText = existingItem.text;
    if (previousText === nextText) {
      return;
    }

    setTaskDetailsById((current) => {
      const currentDetails = current[taskId];
      if (!currentDetails) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...currentDetails,
          checklist: currentDetails.checklist.map((checklistItem) =>
            checklistItem.id === itemId ? { ...checklistItem, text: nextText } : checklistItem
          ),
        },
      };
    });

    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: itemId, text: nextText }] }),
      });

      if (!response.ok) {
        throw new Error("Failed to update checklist item");
      }
    } catch {
      setTaskDetailsById((current) => {
        const details = current[taskId];
        if (!details) {
          return current;
        }

        return {
          ...current,
          [taskId]: {
            ...details,
            checklist: details.checklist.map((checklistItem) =>
              checklistItem.id === itemId ? { ...checklistItem, text: previousText ?? checklistItem.text } : checklistItem
            ),
          },
        };
      });
    }
  }, [taskDetailsById]);

  const handleDeleteChecklistItem = useCallback(async (taskId: string, itemId: string) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: {
          ...details,
          checklist: details.checklist.filter((checklistItem) => checklistItem.id !== itemId),
        },
      };
    });

    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist?itemId=${itemId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete checklist item");
      }
    } catch {
      const details = await fetchTaskDetails(taskId);
      setTaskDetailsById((current) => ({ ...current, [taskId]: details }));
    }
  }, []);

  function markSaving(taskId: string) {
    setSavingIds((current) => ({
      ...current,
      [taskId]: (current[taskId] ?? 0) + 1,
    }));
  }

  function unmarkSaving(taskId: string) {
    setSavingIds((current) => {
      const count = current[taskId] ?? 0;
      if (count <= 1) {
        const next = { ...current };
        delete next[taskId];
        return next;
      }

      return {
        ...current,
        [taskId]: count - 1,
      };
    });
  }

  function clearTaskLocalState(taskId: string) {
    setExpandedTaskId((current) => (current === taskId ? null : current));
    setTaskDetailsById((current) => {
      if (!(taskId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[taskId];
      return next;
    });
    setLoadingDetailIds((current) => {
      if (!(taskId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[taskId];
      return next;
    });
    setEstimateDrafts((current) => {
      if (!(taskId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[taskId];
      return next;
    });

    const nextRequests = { ...activeDetailRequestIdsRef.current };
    delete nextRequests[taskId];
    activeDetailRequestIdsRef.current = nextRequests;
  }

  function replaceTaskSnapshot(updatedTask: TaskWithImplementation) {
    setTasks((current) =>
      current.map((task) =>
        task.id === updatedTask.id
          ? {
              ...task,
              ...updatedTask,
              dependencies: task.dependencies || [],
              dependency_blocked: task.dependency_blocked ?? false,
            }
          : task
      )
    );
  }

  async function updateTask(taskId: string, updates: TaskUpdatePayload): Promise<void> {
    const previousTask = tasks.find((task) => task.id === taskId);
    markSaving(taskId);
    setError(null);

    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        const nextImplementation =
          "implementation_id" in updates
            ? updates.implementation_id === null
              ? null
              : implementations.find((implementation) => implementation.id === updates.implementation_id) ?? task.implementation
            : task.implementation;
        const matchedSprint =
          "sprint_id" in updates && typeof updates.sprint_id === "string"
            ? sprints.find((sprint) => sprint.id === updates.sprint_id) ?? null
            : null;
        const nextSprint =
          "sprint_id" in updates
            ? updates.sprint_id === null
              ? null
              : matchedSprint
                ? {
                    id: matchedSprint.id,
                    name: matchedSprint.name,
                    start_date: matchedSprint.start_date,
                    end_date: matchedSprint.end_date,
                  }
                : task.sprint
            : task.sprint;

        return {
          ...task,
          ...updates,
          implementation: nextImplementation,
          sprint: nextSprint,
        };
      })
    );

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Update failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Update failed");
      }

      const updatedTask = (await response.json()) as TaskWithImplementation;
      replaceTaskSnapshot(updatedTask);
    } catch (updateError) {
      if (previousTask) {
        setTasks((current) => current.map((task) => (task.id === taskId ? previousTask : task)));
      }
      setError(updateError instanceof Error ? updateError.message : "Failed to update task");
    } finally {
      unmarkSaving(taskId);
    }
  }

  function handleToggleDone(task: TaskWithImplementation) {
    const nextStatus: TaskStatus = task.status === "Done" ? "Backlog" : "Done";
    void updateTask(task.id, { status: nextStatus });
  }

  async function deleteTask(taskId: string): Promise<void> {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || deletingIds[taskId]) {
      return;
    }

    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) {
      return;
    }

    setDeletingIds((current) => ({ ...current, [taskId]: true }));
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Delete failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Delete failed");
      }

      clearTaskLocalState(taskId);
      setTasks((current) => current.filter((item) => item.id !== taskId));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete task");
    } finally {
      setDeletingIds((current) => {
        if (!current[taskId]) {
          return current;
        }

        const next = { ...current };
        delete next[taskId];
        return next;
      });
    }
  }

  async function commitEstimatedMinutes(task: TaskWithImplementation): Promise<void> {
    const draftValue = estimateDrafts[task.id];
    if (typeof draftValue !== "string") {
      return;
    }

    const trimmedValue = draftValue.trim();
    if (!trimmedValue) {
      setEstimateDrafts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      return;
    }

    const parsed = Number.parseInt(trimmedValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 480) {
      setEstimateDrafts((current) => ({
        ...current,
        [task.id]: String(task.estimated_minutes),
      }));
      return;
    }

    setEstimateDrafts((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });

    if (parsed !== task.estimated_minutes && !savingIds[task.id]) {
      await updateTask(task.id, { estimated_minutes: parsed, estimate_source: "manual" });
    }
  }

  const sortedTasks = useMemo(() => {
    return [...scopedTasks].sort((a, b) => {
      if (sortConfig) {
        switch (sortConfig.field) {
          case "task": {
            const titleCompare = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
            if (titleCompare !== 0) {
              return sortConfig.direction === "asc" ? titleCompare : -titleCompare;
            }
            break;
          }
          case "estimate": {
            if (a.estimated_minutes !== b.estimated_minutes) {
              return sortConfig.direction === "asc"
                ? a.estimated_minutes - b.estimated_minutes
                : b.estimated_minutes - a.estimated_minutes;
            }
            break;
          }
          case "due": {
            const dueA = getDueTimestamp(a);
            const dueB = getDueTimestamp(b);

            if (dueA !== dueB) {
              if (dueA === null) {
                return 1;
              }
              if (dueB === null) {
                return -1;
              }

              return sortConfig.direction === "asc" ? dueA - dueB : dueB - dueA;
            }
            break;
          }
          case "priority": {
            if (a.priority_score !== b.priority_score) {
              return sortConfig.direction === "asc"
                ? a.priority_score - b.priority_score
                : b.priority_score - a.priority_score;
            }
            break;
          }
          default:
            break;
        }
      }

      if (a.priority_score !== b.priority_score) {
        return b.priority_score - a.priority_score;
      }

      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [scopedTasks, sortConfig]);

  function toggleSort(field: SortField) {
    setSortConfig((current) => {
      if (current?.field === field) {
        return {
          field,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }

      return {
        field,
        direction: DEFAULT_SORT_DIRECTIONS[field],
      };
    });
  }

  function getSortDirection(field: SortField): SortDirection | null {
    if (!sortConfig || sortConfig.field !== field) {
      return null;
    }

    return sortConfig.direction;
  }

  if (sortedTasks.length === 0) {
    return (
      <div className="space-y-4">
        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        <EmptyState title={emptyStateTitle} body={emptyStateBody} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <section className="overflow-hidden rounded-card border border-stroke bg-panel shadow-sm">
        <p className="border-b border-stroke px-4 py-2 text-[11px] font-medium text-muted-foreground sm:hidden">
          Scroll for more &rarr;
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px]">
            <thead className="border-b-2 border-stroke bg-panel-muted">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground [&>th]:border-r [&>th]:border-solid [&>th]:border-stroke [&>th:last-child]:border-r-0">
                <th className="w-10 px-2 py-3" />
                <th className="w-[320px] px-3 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("task")}
                    className="inline-flex items-center gap-1 text-left hover:text-foreground"
                    title="Sort by task name"
                  >
                    <span>Task</span>
                    <span aria-hidden="true" className="text-[10px] leading-none">
                      {getSortDirection("task") === "asc" ? "↑" : getSortDirection("task") === "desc" ? "↓" : "↕"}
                    </span>
                    <span className="sr-only">
                      {getSortDirection("task") === "asc"
                        ? "Sorted by task name A to Z"
                        : getSortDirection("task") === "desc"
                          ? "Sorted by task name Z to A"
                          : "Not sorted by task name"}
                    </span>
                  </button>
                </th>
                {showImplementationColumn ? (
                  <th className="w-[160px] px-3 py-3">Application</th>
                ) : null}
                {showSprintColumn ? (
                  <th className="w-[170px] px-3 py-3">Sprint</th>
                ) : null}
                <th className="w-[170px] px-3 py-3">Status</th>
                <th className="w-[80px] px-3 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => toggleSort("estimate")}
                    className="mx-auto inline-flex items-center gap-1 hover:text-foreground"
                    title="Sort by estimate"
                  >
                    <span>Est (min)</span>
                    <span aria-hidden="true" className="text-[10px] leading-none">
                      {getSortDirection("estimate") === "asc" ? "↑" : getSortDirection("estimate") === "desc" ? "↓" : "↕"}
                    </span>
                    <span className="sr-only">
                      {getSortDirection("estimate") === "asc"
                        ? "Sorted by lowest estimate first"
                        : getSortDirection("estimate") === "desc"
                          ? "Sorted by highest estimate first"
                          : "Not sorted by estimate"}
                    </span>
                  </button>
                </th>
                <th className="w-[120px] px-3 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort("due")}
                    className="inline-flex items-center gap-1 text-left hover:text-foreground"
                    title="Sort by due date"
                  >
                    <span>Due</span>
                    <span aria-hidden="true" className="text-[10px] leading-none">
                      {getSortDirection("due") === "asc" ? "↑" : getSortDirection("due") === "desc" ? "↓" : "↕"}
                    </span>
                    <span className="sr-only">
                      {getSortDirection("due") === "asc"
                        ? "Sorted by soonest due date first"
                        : getSortDirection("due") === "desc"
                          ? "Sorted by farthest due date first"
                          : "Not sorted by due date"}
                    </span>
                  </button>
                </th>
                <th className="w-[80px] px-3 py-3 text-center">Type</th>
                <th className="w-[70px] px-3 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => toggleSort("priority")}
                    className="mx-auto inline-flex items-center gap-1 hover:text-foreground"
                    title="Sort by priority"
                  >
                    <span>Priority</span>
                    <span aria-hidden="true" className="text-[10px] leading-none">
                      {getSortDirection("priority") === "asc" ? "↑" : getSortDirection("priority") === "desc" ? "↓" : "↕"}
                    </span>
                    <span className="sr-only">
                      {getSortDirection("priority") === "asc"
                        ? "Sorted by lowest priority first"
                        : getSortDirection("priority") === "desc"
                          ? "Sorted by highest priority first"
                          : "Not sorted by priority"}
                    </span>
                  </button>
                </th>
                <th className="w-[60px] px-3 py-3 text-center">Flags</th>
                <th className="w-[120px] px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedTasks.map((task) => {
                const isSaving = Boolean(savingIds[task.id]);
                const isDeleting = Boolean(deletingIds[task.id]);
                const isBusy = isSaving || isDeleting;
                const isExpanded = expandedTaskId === task.id;
                const details = taskDetailsById[task.id];
                const isLoadingDetails = Boolean(loadingDetailIds[task.id]);
                const dependencyWaitingLabel = getDependencyWaitingLabel(task);

                return (
                  <Fragment key={task.id}>
                    <tr
                      id={`task-${task.id}`}
                      className={`border-b border-solid border-stroke [&>td]:border-r [&>td]:border-solid [&>td]:border-stroke [&>td:last-child]:border-r-0 ${isBusy ? "opacity-70" : ""} ${isExpanded ? "bg-accent/10" : "hover:bg-panel-muted/40"}`}
                    >
                      <td className="w-10 px-2 py-2.5 align-middle text-center">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(task.id)}
                          aria-label={isExpanded ? "Collapse task details" : "Expand task details"}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-stroke bg-panel-muted text-foreground transition hover:bg-accent hover:text-white hover:border-accent"
                          title={isExpanded ? "Collapse" : "Expand"}
                        >
                          <svg
                            className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </td>

                      <td className="w-[320px] max-w-[320px] px-3 py-2.5 align-middle">
                        <p className="break-words text-sm font-medium leading-tight text-foreground">{task.title}</p>
                        {task.implementation?.phase === "Sundown" ? (
                          <p className="mt-1 inline-flex rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                            Sundown implementation
                          </p>
                        ) : null}
                        {task.description ? (
                          <p className="mt-1 line-clamp-3 break-words whitespace-pre-wrap text-xs text-muted-foreground">{task.description}</p>
                        ) : null}
                        {(task.tags?.length ?? 0) > 0 ? (
                          <TaskTagChips tags={task.tags ?? []} className="mt-2" />
                        ) : null}
                        {dependencyWaitingLabel ? (
                          <p className="mt-1 flex items-start gap-1.5 break-words text-xs text-amber-300">
                            <svg
                              className="mt-0.5 h-3 w-3 shrink-0"
                              viewBox="0 0 20 20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M8 7l-2.5 2.5a2.5 2.5 0 003.5 3.5L11 11m1-2l2.5-2.5a2.5 2.5 0 10-3.5-3.5L9 5"
                              />
                            </svg>
                            <span>Waiting on: {dependencyWaitingLabel}</span>
                          </p>
                        ) : null}
                        {!dependencyWaitingLabel && task.status === "Blocked/Waiting" ? (
                          <p className={`mt-1 break-words text-xs ${task.waiting_on ? "text-amber-300" : "text-rose-400"}`}>
                            {task.waiting_on ? `Waiting on: ${task.waiting_on}` : "Waiting on: not set"}
                          </p>
                        ) : null}
                      </td>

                      {showImplementationColumn ? (
                        <td className="w-[160px] px-3 py-2.5 align-middle">
                          <select
                            value={task.implementation_id ?? ""}
                            onChange={(event) =>
                              void updateTask(task.id, { implementation_id: event.target.value || null })
                            }
                            disabled={isBusy}
                            className="w-full rounded border border-stroke bg-transparent px-1.5 py-1 text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="">—</option>
                            {implementations.map((implementation) => (
                              <option key={implementation.id} value={implementation.id}>
                                {implementation.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      ) : null}

                      {showSprintColumn ? (
                        <td className="w-[170px] px-3 py-2.5 align-middle">
                          <select
                            value={task.sprint_id ?? ""}
                            onChange={(event) =>
                              void updateTask(task.id, { sprint_id: event.target.value || null })
                            }
                            disabled={isBusy}
                            className="w-full rounded border border-stroke bg-transparent px-1.5 py-1 text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="">—</option>
                            {sprints.map((sprint) => (
                              <option key={sprint.id} value={sprint.id}>
                                {sprint.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      ) : null}

                      <td className="w-[170px] px-3 py-2.5 align-middle">
                        <StatusSelector
                          value={task.status}
                          onChange={(status) => {
                            if (isBusy) {
                              return;
                            }
                            void updateTask(task.id, { status });
                          }}
                        />
                      </td>

                      <td className="w-[80px] px-2 py-2.5 align-middle text-center">
                        <input
                          type="number"
                          min={1}
                          max={480}
                          value={estimateDrafts[task.id] ?? String(task.estimated_minutes)}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setEstimateDrafts((current) => ({ ...current, [task.id]: nextValue }));
                          }}
                          onBlur={() => {
                            void commitEstimatedMinutes(task);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }

                            if (event.key === "Escape") {
                              setEstimateDrafts((current) => {
                                const next = { ...current };
                                delete next[task.id];
                                return next;
                              });
                              event.currentTarget.blur();
                            }
                          }}
                          disabled={isBusy}
                          className="w-full rounded border border-stroke bg-transparent px-1.5 py-1 text-center text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </td>

                      <td className="w-[120px] px-2 py-2.5 align-middle">
                        <input
                          type="date"
                          value={timestampToLocalDateInputValue(task.due_at)}
                          onChange={(event) => {
                            const nextDue = event.target.value;
                            void updateTask(task.id, { due_at: nextDue ? localDateInputToEndOfDayIso(nextDue) : null });
                          }}
                          disabled={isBusy}
                          className="w-full rounded border border-stroke bg-transparent px-1 py-1 text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </td>

                      <td className="w-[80px] px-2 py-2.5 align-middle text-center">
                        <span className="text-xs text-muted-foreground">{task.task_type}</span>
                      </td>

                      <td className="w-[70px] px-2 py-2.5 align-middle text-center">
                        <span className="text-xs font-medium text-foreground">{task.priority_score}</span>
                      </td>

                      <td className="w-[60px] px-2 py-2.5 align-middle">
                        <div className="flex items-center justify-center gap-1">
                          {task.blocker ? (
                            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400" title="Blocker">B</span>
                          ) : null}
                          {task.needs_review ? (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400" title="Needs review">R</span>
                          ) : null}
                          {!task.blocker && !task.needs_review ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : null}
                        </div>
                      </td>

                      <td className="w-[120px] px-2 py-2.5 align-middle">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleToggleDone(task)}
                            disabled={isBusy}
                            className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {task.status === "Done" ? "Reopen" : "Done"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void updateTask(task.id, { blocker: !task.blocker })}
                            disabled={isBusy}
                            className={`rounded border px-2 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                              task.blocker
                                ? "border-red-500/40 bg-red-500/15 text-red-400"
                                : "border-stroke bg-panel text-muted-foreground hover:bg-panel-muted"
                            }`}
                            title={task.blocker ? "Clear blocker" : "Mark as blocker"}
                          >
                            {task.blocker ? "!" : "B"}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isExpanded ? (
                      <tr className="bg-accent/5">
                        <td colSpan={columnCount} className="border-b border-stroke px-4 py-4">
                          {isLoadingDetails ? (
                            <div className="flex items-center justify-center py-8">
                              <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                            </div>
                          ) : details ? (
                            <div className="space-y-4">
                              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stroke bg-panel-muted px-3 py-2">
                                <p className="text-xs text-muted-foreground">Manage task details, checklist, dependencies, and comments.</p>
                                <button
                                  type="button"
                                  onClick={() => void deleteTask(task.id)}
                                  disabled={isBusy}
                                  className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isDeleting ? "Deleting..." : "Delete Task"}
                                </button>
                              </div>

                              <TaskMetaEditor
                                key={`${task.id}:${task.updated_at}`}
                                task={task}
                                isSaving={isBusy}
                                onUpdate={updateTask}
                                onReplaceTask={replaceTaskSnapshot}
                              />

                              <div className="grid gap-6 xl:grid-cols-3">
                                <ChecklistSection
                                  checklist={details.checklist}
                                  onToggle={(item) => void handleChecklistToggle(task.id, item)}
                                  onAdd={(text) => void handleAddChecklistItem(task.id, text)}
                                  onUpdate={(itemId, text) => void handleUpdateChecklistItem(task.id, itemId, text)}
                                  onDelete={(itemId) => void handleDeleteChecklistItem(task.id, itemId)}
                                />

                                <TaskDependencies
                                  taskId={task.id}
                                  dependencies={details.dependencies}
                                  availableTasks={tasks}
                                  availableCommitments={commitments}
                                  onDependencyAdded={(dependency) => handleDependencyAdded(task.id, dependency)}
                                  onDependencyRemoved={(dependencyId) => handleDependencyRemoved(task.id, dependencyId)}
                                />

                                <TaskComments
                                  taskId={task.id}
                                  comments={details.comments}
                                  onCommentAdded={(comment) => handleCommentAdded(task.id, comment)}
                                  onCommentUpdated={(comment) => handleCommentUpdated(task.id, comment)}
                                  onCommentDeleted={(commentId) => handleCommentDeleted(task.id, commentId)}
                                />
                              </div>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
