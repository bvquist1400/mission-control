"use client";

import { useEffect, useState } from "react";
import { TriageRow } from "@/components/triage/TriageRow";
import { EstimateButtons } from "@/components/ui/EstimateButtons";
import type { ImplementationSummary, TaskStatus, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

async function fetchTriageTasks(): Promise<TaskWithImplementation[]> {
  const response = await fetch("/api/tasks?needs_review=true", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }
  if (!response.ok) {
    throw new Error("Failed to fetch triage tasks");
  }
  return response.json();
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

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((item) => (
        <div key={item} className="animate-pulse rounded-card border border-stroke bg-panel p-4">
          <div className="h-4 w-2/3 rounded bg-panel-muted" />
          <div className="mt-4 h-8 w-full rounded bg-panel-muted" />
          <div className="mt-3 h-8 w-full rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
      <p className="text-lg font-medium text-foreground">All caught up!</p>
      <p className="mt-1 text-sm text-muted-foreground">No tasks need review.</p>
    </div>
  );
}

interface TaskDraft {
  title: string;
  implementationId: string;
  estimatedMinutes: number;
  dueDate: string;
  status: TaskStatus;
  blocker: boolean;
}

const INITIAL_DRAFT: TaskDraft = {
  title: "",
  implementationId: "",
  estimatedMinutes: 30,
  dueDate: "",
  status: "Next",
  blocker: false,
};

const NEW_TASK_STATUSES: TaskStatus[] = ["Next", "Scheduled", "Waiting"];

function dateToIso(dateString: string): string {
  const date = new Date(`${dateString}T23:59:59`);
  return date.toISOString();
}

export function TriageList() {
  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, number>>({});
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(INITIAL_DRAFT);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [tasksData, implementationsData] = await Promise.all([fetchTriageTasks(), fetchImplementations()]);
        if (!isMounted) {
          return;
        }
        setTasks(tasksData);
        setImplementations(implementationsData);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "Failed to load triage data");
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
    const previousTasks = tasks;
    markSaving(taskId);
    setError(null);

    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...updates,
              implementation:
                "implementation_id" in updates
                  ? implementations.find((implementation) => implementation.id === updates.implementation_id) ?? null
                  : task.implementation,
            }
          : task
      )
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
      setTasks(previousTasks);
      setError(updateError instanceof Error ? updateError.message : "Failed to update task");
    } finally {
      unmarkSaving(taskId);
    }
  }

  async function dismissTask(taskId: string): Promise<void> {
    const previousTasks = tasks;
    markSaving(taskId);
    setError(null);
    setTasks((current) => current.filter((task) => task.id !== taskId));

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needs_review: false }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Dismiss failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Dismiss failed");
      }
    } catch (dismissError) {
      setTasks(previousTasks);
      setError(dismissError instanceof Error ? dismissError.message : "Failed to dismiss task");
    } finally {
      unmarkSaving(taskId);
    }
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const title = draft.title.trim();
    if (!title) {
      setError("Task title is required");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          implementation_id: draft.implementationId || null,
          estimated_minutes: draft.estimatedMinutes,
          estimate_source: "manual",
          due_at: draft.dueDate ? dateToIso(draft.dueDate) : null,
          status: draft.status,
          blocker: draft.blocker,
          needs_review: true,
          task_type: "Admin",
          source_type: "Manual",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const createdTask = (await response.json()) as TaskWithImplementation;
      setTasks((current) => [createdTask, ...current]);
      setDraft(INITIAL_DRAFT);
      setIsCreateOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create task");
    } finally {
      setIsCreating(false);
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Add Task</h2>
            <p className="text-xs text-muted-foreground">Create a manual task and route it into triage.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreateOpen((open) => !open)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            {isCreateOpen ? "Close" : "+ New Task"}
          </button>
        </div>

        {isCreateOpen ? (
          <form onSubmit={createTask} className="mt-4 space-y-4 border-t border-stroke pt-4">
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="What needs to get done?"
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Implementation</span>
                <select
                  value={draft.implementationId}
                  onChange={(event) => setDraft((current) => ({ ...current, implementationId: event.target.value }))}
                  disabled={isCreating}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {implementations.map((implementation) => (
                    <option key={implementation.id} value={implementation.id}>
                      {implementation.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</span>
                <input
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
                  disabled={isCreating}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
                <select
                  value={draft.status}
                  onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                  disabled={isCreating}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {NEW_TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-end">
                <span className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={draft.blocker}
                    onChange={(event) => setDraft((current) => ({ ...current, blocker: event.target.checked }))}
                    disabled={isCreating}
                    className="h-4 w-4 accent-red-500"
                  />
                  Blocker
                </span>
              </label>
            </div>

            <div className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimate (min)</span>
              <EstimateButtons
                value={draft.estimatedMinutes}
                onChange={(minutes) => setDraft((current) => ({ ...current, estimatedMinutes: minutes }))}
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(INITIAL_DRAFT);
                  setIsCreateOpen(false);
                }}
                disabled={isCreating}
                className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating..." : "Create Task"}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        tasks.map((task) => (
          <TriageRow
            key={task.id}
            task={task}
            implementations={implementations}
            isSaving={Boolean(savingIds[task.id])}
            onUpdate={updateTask}
            onDismiss={dismissTask}
          />
        ))
      )}
    </div>
  );
}
