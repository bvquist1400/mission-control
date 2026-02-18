"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { TaskComments } from "@/components/tasks/TaskComments";
import { TaskDependencies } from "@/components/tasks/TaskDependencies";
import { StatusSelector } from "@/components/ui/StatusSelector";
import type {
  ImplementationSummary,
  TaskChecklistItem,
  TaskComment,
  TaskStatus,
  TaskType,
  TaskUpdatePayload,
  TaskWithImplementation,
} from "@/types/database";

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

interface TaskDetailData {
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  blockedBy: Dependency[];
  blocking: Dependency[];
}

const TASKS_PAGE_SIZE = 200;

type StatusFilter = "All" | TaskStatus;
type ReviewFilter = "All" | "Needs review" | "Ready";
type ImplementationFilter = "All" | "Unassigned" | string;

const STATUS_FILTER_OPTIONS: StatusFilter[] = ["All", "Backlog", "Planned", "In Progress", "Blocked/Waiting", "Done"];
const REVIEW_FILTER_OPTIONS: ReviewFilter[] = ["All", "Needs review", "Ready"];
const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "Task", label: "Task" },
  { value: "Admin", label: "Admin" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Build", label: "Build" },
];

function toDateInputValue(isoString: string | null): string {
  if (!isoString) {
    return "";
  }

  return isoString.split("T")[0];
}

function dateToIso(dateString: string): string {
  const date = new Date(`${dateString}T23:59:59`);
  return date.toISOString();
}

async function fetchTaskPage(params: Record<string, string>): Promise<TaskWithImplementation[]> {
  const searchParams = new URLSearchParams(params);
  const response = await fetch(`/api/tasks?${searchParams.toString()}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }

  return response.json();
}

async function fetchAllTaskPages(includeCompleted: boolean): Promise<TaskWithImplementation[]> {
  const allTasks: TaskWithImplementation[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchTaskPage({
      include_done: includeCompleted ? "true" : "false",
      limit: String(TASKS_PAGE_SIZE),
      offset: String(offset),
    });

    allTasks.push(...page);

    if (page.length < TASKS_PAGE_SIZE) {
      break;
    }

    offset += TASKS_PAGE_SIZE;
  }

  return allTasks;
}

async function fetchImplementations(): Promise<ImplementationSummary[]> {
  const response = await fetch("/api/implementations", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch implementations");
  }

  return response.json();
}

async function fetchTaskDetails(taskId: string): Promise<TaskDetailData> {
  const [commentsRes, checklistRes, dependenciesRes] = await Promise.all([
    fetch(`/api/tasks/${taskId}/comments`, { cache: "no-store" }),
    fetch(`/api/tasks/${taskId}/checklist`, { cache: "no-store" }),
    fetch(`/api/tasks/${taskId}/dependencies`, { cache: "no-store" }),
  ]);

  const comments = commentsRes.ok ? await commentsRes.json() : [];
  const checklist = checklistRes.ok ? await checklistRes.json() : [];
  const dependencies = dependenciesRes.ok ? await dependenciesRes.json() : { blocked_by: [], blocking: [] };

  return {
    comments,
    checklist,
    blockedBy: dependencies.blocked_by,
    blocking: dependencies.blocking,
  };
}

function LoadingSkeleton() {
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
      <p className="text-lg font-medium text-foreground">No matching tasks</p>
      <p className="mt-1 text-sm text-muted-foreground">Adjust your filters or add a new task above.</p>
    </div>
  );
}

function ChecklistAddForm({ onAdd }: { onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  if (!isAdding) {
    return (
      <button
        type="button"
        onClick={() => setIsAdding(true)}
        className="text-xs font-semibold text-accent hover:underline"
      >
        + Add item
      </button>
    );
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            onAdd(text);
            setText("");
            setIsAdding(false);
          }
          if (e.key === "Escape") {
            setText("");
            setIsAdding(false);
          }
        }}
        placeholder="New checklist item..."
        autoFocus
        className="flex-1 rounded-lg border border-stroke bg-panel px-2 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="button"
        onClick={() => {
          if (text.trim()) {
            onAdd(text);
            setText("");
            setIsAdding(false);
          }
        }}
        className="rounded-lg bg-accent px-2 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setText("");
          setIsAdding(false);
        }}
        className="rounded-lg px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  );
}

interface TaskMetaEditorProps {
  task: TaskWithImplementation;
  isSaving: boolean;
  onUpdate: (taskId: string, updates: TaskUpdatePayload) => Promise<void>;
}

function TaskMetaEditor({ task, isSaving, onUpdate }: TaskMetaEditorProps) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [taskTypeDraft, setTaskTypeDraft] = useState<TaskType>(task.task_type);
  const [waitingOnDraft, setWaitingOnDraft] = useState(task.waiting_on ?? "");

  const normalizedTitle = titleDraft.trim();
  const normalizedWaitingOn = waitingOnDraft.trim();
  const nextWaitingOn = normalizedWaitingOn.length > 0 ? normalizedWaitingOn : null;

  const hasChanges =
    normalizedTitle !== task.title || taskTypeDraft !== task.task_type || nextWaitingOn !== task.waiting_on;
  const canSave = normalizedTitle.length > 0 && hasChanges && !isSaving;

  function saveEdits() {
    if (!canSave) {
      return;
    }

    const updates: TaskUpdatePayload = {};
    if (normalizedTitle !== task.title) {
      updates.title = normalizedTitle;
    }
    if (taskTypeDraft !== task.task_type) {
      updates.task_type = taskTypeDraft;
    }
    if (nextWaitingOn !== task.waiting_on) {
      updates.waiting_on = nextWaitingOn;
    }

    if (Object.keys(updates).length > 0) {
      void onUpdate(task.id, updates);
    }
  }

  return (
    <section className="rounded-lg border border-stroke bg-panel p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Details</h4>
        <button
          type="button"
          onClick={saveEdits}
          disabled={!canSave}
          className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save edits"}
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isSaving}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Type</span>
          <select
            value={taskTypeDraft}
            onChange={(event) => setTaskTypeDraft(event.target.value as TaskType)}
            disabled={isSaving}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {TASK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Waiting On</span>
          <input
            value={waitingOnDraft}
            onChange={(event) => setWaitingOnDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isSaving}
            placeholder={task.status === "Blocked/Waiting" ? "Who or what is this waiting on?" : "Optional context"}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      </div>
    </section>
  );
}

export function BacklogList() {
  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, number>>({});

  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [implementationFilter, setImplementationFilter] = useState<ImplementationFilter>("All");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("All");

  // Expanded task panel state
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskDetailsById, setTaskDetailsById] = useState<Record<string, TaskDetailData>>({});
  const [loadingDetailIds, setLoadingDetailIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [taskData, implementationData] = await Promise.all([
          fetchAllTaskPages(includeCompleted),
          fetchImplementations(),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData);
        setImplementations(implementationData);
        setExpandedTaskId(null);
        setTaskDetailsById({});
        setLoadingDetailIds({});
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load backlog data");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, [includeCompleted]);

  // Toggle expanded panel and load details
  const toggleExpanded = useCallback(async (taskId: string) => {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
      return;
    }

    setExpandedTaskId(taskId);

    if (taskDetailsById[taskId] || loadingDetailIds[taskId]) {
      return;
    }

    setLoadingDetailIds((current) => ({ ...current, [taskId]: true }));

    try {
      const details = await fetchTaskDetails(taskId);
      setTaskDetailsById((current) => ({ ...current, [taskId]: details }));
    } catch {
      // Silently fail - panel will show empty state for this task
      setTaskDetailsById((current) => ({
        ...current,
        [taskId]: { comments: [], checklist: [], blockedBy: [], blocking: [] },
      }));
    } finally {
      setLoadingDetailIds((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
    }
  }, [expandedTaskId, loadingDetailIds, taskDetailsById]);

  // Handlers for updating task detail data
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

  const handleDependencyAdded = useCallback((taskId: string, dependency: Dependency) => {
    setTaskDetailsById((current) => {
      const details = current[taskId];
      if (!details) {
        return current;
      }

      return {
        ...current,
        [taskId]: { ...details, blockedBy: [...details.blockedBy, dependency] },
      };
    });
  }, []);

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
          blockedBy: details.blockedBy.filter((dependency) => dependency.id !== dependencyId),
          blocking: details.blocking.filter((dependency) => dependency.id !== dependencyId),
        },
      };
    });
  }, []);

  const handleChecklistToggle = useCallback(async (taskId: string, item: TaskChecklistItem) => {
    // Optimistic update
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
      await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: item.id, is_done: !item.is_done }] }),
      });
    } catch {
      // Revert on error
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

      if (response.ok) {
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
      }
    } catch {
      // Silently fail
    }
  }, []);

  const handleDeleteChecklistItem = useCallback(async (taskId: string, itemId: string) => {
    // Optimistic update
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
      await fetch(`/api/tasks/${taskId}/checklist?itemId=${itemId}`, {
        method: "DELETE",
      });
    } catch {
      // Reload on error
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

        return {
          ...task,
          ...updates,
          implementation: nextImplementation,
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
      setTasks((current) => current.map((task) => (task.id === taskId ? updatedTask : task)));
    } catch (updateError) {
      if (previousTask) {
        setTasks((current) => current.map((task) => (task.id === taskId ? previousTask : task)));
      }
      setError(updateError instanceof Error ? updateError.message : "Failed to update task");
    } finally {
      unmarkSaving(taskId);
    }
  }

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [task, ...current]);
    setError(null);
  }

  function handleToggleDone(task: TaskWithImplementation) {
    const nextStatus: TaskStatus = task.status === "Done" ? "Backlog" : "Done";
    void updateTask(task.id, { status: nextStatus });
  }

  const filteredTasks = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();

    return tasks
      .filter((task) => {
        if (normalizedSearch && !task.title.toLowerCase().includes(normalizedSearch)) {
          return false;
        }

        if (statusFilter !== "All" && task.status !== statusFilter) {
          return false;
        }

        if (implementationFilter === "Unassigned" && task.implementation_id !== null) {
          return false;
        }

        if (implementationFilter !== "All" && implementationFilter !== "Unassigned" && task.implementation_id !== implementationFilter) {
          return false;
        }

        if (reviewFilter === "Needs review" && !task.needs_review) {
          return false;
        }

        if (reviewFilter === "Ready" && task.needs_review) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (a.priority_score !== b.priority_score) {
          return b.priority_score - a.priority_score;
        }

        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
  }, [implementationFilter, reviewFilter, searchQuery, statusFilter, tasks]);

  return (
    <div className="space-y-4">
      <TaskCreateForm implementations={implementations} onTaskCreated={handleTaskCreated} defaultNeedsReview={false} />

      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="space-y-1 xl:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search task title"
              className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {STATUS_FILTER_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Implementation</span>
            <select
              value={implementationFilter}
              onChange={(event) => setImplementationFilter(event.target.value as ImplementationFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {implementations.map((implementation) => (
                <option key={implementation.id} value={implementation.id}>
                  {implementation.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Review</span>
            <select
              value={reviewFilter}
              onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {REVIEW_FILTER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-3 inline-flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(event) => setIncludeCompleted(event.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Include completed tasks
        </label>
      </section>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <LoadingSkeleton />
      ) : filteredTasks.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="overflow-hidden rounded-card border border-stroke bg-panel shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px]">
              <thead className="border-b-2 border-stroke bg-panel-muted">
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground [&>th]:border-r [&>th]:border-solid [&>th]:border-stroke [&>th:last-child]:border-r-0">
                  <th className="w-10 px-2 py-3" />
                  <th className="min-w-[280px] px-3 py-3">Task</th>
                  <th className="w-[160px] px-3 py-3">Implementation</th>
                  <th className="w-[170px] px-3 py-3">Status</th>
                  <th className="w-[80px] px-3 py-3 text-center">Est (min)</th>
                  <th className="w-[120px] px-3 py-3">Due</th>
                  <th className="w-[80px] px-3 py-3 text-center">Type</th>
                  <th className="w-[70px] px-3 py-3 text-center">Priority</th>
                  <th className="w-[60px] px-3 py-3 text-center">Flags</th>
                  <th className="w-[120px] px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => {
                  const isSaving = Boolean(savingIds[task.id]);
                  const isExpanded = expandedTaskId === task.id;
                  const details = taskDetailsById[task.id];
                  const isLoadingDetails = Boolean(loadingDetailIds[task.id]);

                  return (
                    <Fragment key={task.id}>
                      <tr className={`border-b border-solid border-stroke [&>td]:border-r [&>td]:border-solid [&>td]:border-stroke [&>td:last-child]:border-r-0 ${isSaving ? "opacity-70" : ""} ${isExpanded ? "bg-accent/10" : "hover:bg-panel-muted/40"}`}>
                        {/* Expand button */}
                        <td className="w-10 px-2 py-2.5 align-middle text-center">
                          <button
                            type="button"
                            onClick={() => void toggleExpanded(task.id)}
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

                        {/* Task title */}
                        <td className="min-w-[280px] px-3 py-2.5 align-middle">
                          <p className="text-sm font-medium text-foreground leading-tight">{task.title}</p>
                          {task.status === "Blocked/Waiting" && (
                            <p
                              className={`mt-1 text-xs ${
                                task.waiting_on ? "text-amber-300" : "text-rose-400"
                              }`}
                            >
                              {task.waiting_on ? `Waiting on: ${task.waiting_on}` : "Waiting on: not set"}
                            </p>
                          )}
                        </td>

                        {/* Implementation */}
                        <td className="w-[160px] px-3 py-2.5 align-middle">
                          <select
                            value={task.implementation_id ?? ""}
                            onChange={(event) =>
                              void updateTask(task.id, { implementation_id: event.target.value || null })
                            }
                            disabled={isSaving}
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

                        {/* Status */}
                        <td className="w-[170px] px-3 py-2.5 align-middle">
                          <StatusSelector
                            value={task.status}
                            onChange={(status) => {
                              if (isSaving) return;
                              void updateTask(task.id, { status });
                            }}
                          />
                        </td>

                        {/* Estimate - numeric input */}
                        <td className="w-[80px] px-2 py-2.5 align-middle text-center">
                          <input
                            type="number"
                            min={1}
                            max={480}
                            value={task.estimated_minutes}
                            onChange={(event) => {
                              const value = parseInt(event.target.value, 10);
                              if (!isNaN(value) && value >= 1 && value <= 480 && !isSaving) {
                                void updateTask(task.id, { estimated_minutes: value, estimate_source: "manual" });
                              }
                            }}
                            disabled={isSaving}
                            className="w-full rounded border border-stroke bg-transparent px-1.5 py-1 text-center text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </td>

                        {/* Due date */}
                        <td className="w-[120px] px-2 py-2.5 align-middle">
                          <input
                            type="date"
                            value={toDateInputValue(task.due_at)}
                            onChange={(event) => {
                              const nextDue = event.target.value;
                              void updateTask(task.id, { due_at: nextDue ? dateToIso(nextDue) : null });
                            }}
                            disabled={isSaving}
                            className="w-full rounded border border-stroke bg-transparent px-1 py-1 text-xs text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </td>

                        {/* Task type */}
                        <td className="w-[80px] px-2 py-2.5 align-middle text-center">
                          <span className="text-xs text-muted-foreground">{task.task_type}</span>
                        </td>

                        {/* Priority */}
                        <td className="w-[70px] px-2 py-2.5 align-middle text-center">
                          <span className="text-xs font-medium text-foreground">{task.priority_score}</span>
                        </td>

                        {/* Flags (blocker, needs review) */}
                        <td className="w-[60px] px-2 py-2.5 align-middle">
                          <div className="flex items-center justify-center gap-1">
                            {task.blocker && (
                              <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400" title="Blocker">B</span>
                            )}
                            {task.needs_review && (
                              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400" title="Needs review">R</span>
                            )}
                            {!task.blocker && !task.needs_review && (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="w-[120px] px-2 py-2.5 align-middle">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleToggleDone(task)}
                              disabled={isSaving}
                              className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {task.status === "Done" ? "Reopen" : "Done"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void updateTask(task.id, { blocker: !task.blocker })}
                              disabled={isSaving}
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

                      {isExpanded && (
                        <tr className="bg-accent/5">
                          <td colSpan={10} className="border-b border-stroke px-4 py-4">
                            {isLoadingDetails ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                              </div>
                            ) : details ? (
                              <div className="space-y-4">
                                <TaskMetaEditor
                                  key={`${task.id}:${task.updated_at}`}
                                  task={task}
                                  isSaving={isSaving}
                                  onUpdate={updateTask}
                                />

                                <div className="grid gap-6 xl:grid-cols-3">
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      Checklist ({details.checklist.length})
                                    </h4>
                                    {details.checklist.length > 0 ? (
                                      <ul className="space-y-1">
                                        {details.checklist.map((item) => (
                                          <li key={item.id} className="group flex items-center gap-2">
                                            <input
                                              type="checkbox"
                                              checked={item.is_done}
                                              onChange={() => void handleChecklistToggle(task.id, item)}
                                              className="h-4 w-4 rounded accent-accent"
                                            />
                                            <span
                                              className={`flex-1 text-sm ${
                                                item.is_done ? "text-muted-foreground line-through" : "text-foreground"
                                              }`}
                                            >
                                              {item.text}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() => void handleDeleteChecklistItem(task.id, item.id)}
                                              className="rounded p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600"
                                              title="Delete"
                                            >
                                              <svg
                                                className="h-3.5 w-3.5"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                              >
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                              </svg>
                                            </button>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <p className="text-xs italic text-muted-foreground">No checklist items</p>
                                    )}
                                    <ChecklistAddForm onAdd={(text) => void handleAddChecklistItem(task.id, text)} />
                                  </div>

                                  <TaskDependencies
                                    taskId={task.id}
                                    blockedBy={details.blockedBy}
                                    blocking={details.blocking}
                                    availableTasks={tasks}
                                    onDependencyAdded={(dependency) => handleDependencyAdded(task.id, dependency)}
                                    onDependencyRemoved={(dependencyId) =>
                                      handleDependencyRemoved(task.id, dependencyId)
                                    }
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
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
