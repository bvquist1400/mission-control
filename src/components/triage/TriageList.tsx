"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TriageRow } from "@/components/triage/TriageRow";
import type { ImplementationSummary, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

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
  const response = await fetch("/api/applications", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }
  if (!response.ok) {
    throw new Error("Failed to fetch applications");
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

export function TriageList() {
  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Record<string, number>>({});

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
    if (!confirm("Dismiss this task from triage?")) {
      return;
    }

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

  if (loading) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Manual Task Creation Moved</h2>
            <p className="text-xs text-muted-foreground">Create and manage manual tasks in Backlog, then use Triage only for review decisions.</p>
          </div>
          <Link
            href="/backlog"
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90"
          >
            Open Backlog
          </Link>
        </div>
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
