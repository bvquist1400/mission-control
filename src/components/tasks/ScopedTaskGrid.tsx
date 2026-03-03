"use client";

import { useEffect, useState } from "react";
import { TaskGrid, TaskGridLoadingSkeleton, type TaskGridScopeMode } from "@/components/tasks/TaskGrid";
import type {
  CommitmentSummary,
  ImplementationSummary,
  TaskWithImplementation,
} from "@/types/database";

interface ScopedTaskGridProps {
  scopeMode: Exclude<TaskGridScopeMode, "global">;
  scopeId: string;
  newTask?: TaskWithImplementation | null;
}

function matchesScope(task: TaskWithImplementation, scopeMode: ScopedTaskGridProps["scopeMode"], scopeId: string): boolean {
  return scopeMode === "implementation"
    ? task.implementation_id === scopeId
    : task.project_id === scopeId;
}

function mergeTask(current: TaskWithImplementation[], nextTask: TaskWithImplementation): TaskWithImplementation[] {
  const normalizedTask = {
    ...nextTask,
    dependencies: nextTask.dependencies || [],
    dependency_blocked: nextTask.dependency_blocked ?? false,
  };

  const existingIndex = current.findIndex((task) => task.id === normalizedTask.id);
  if (existingIndex === -1) {
    return [normalizedTask, ...current];
  }

  const next = [...current];
  next[existingIndex] = {
    ...next[existingIndex],
    ...normalizedTask,
  };
  return next;
}

async function fetchScopedTasks(
  scopeMode: ScopedTaskGridProps["scopeMode"],
  scopeId: string,
  includeCompleted: boolean
): Promise<TaskWithImplementation[]> {
  const params = new URLSearchParams({
    limit: "500",
    [scopeMode === "implementation" ? "implementation_id" : "project_id"]: scopeId,
  });

  if (includeCompleted) {
    params.set("include_done", "true");
  }

  const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
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

async function fetchCommitments(): Promise<CommitmentSummary[]> {
  const response = await fetch("/api/commitments?include_done=true", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch commitments");
  }

  return response.json();
}

export function ScopedTaskGrid({ scopeMode, scopeId, newTask = null }: ScopedTaskGridProps) {
  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [taskData, implementationData, commitmentData] = await Promise.all([
          fetchScopedTasks(scopeMode, scopeId, includeCompleted),
          fetchImplementations(),
          fetchCommitments(),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData);
        setImplementations(implementationData);
        setCommitments(commitmentData);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load tasks");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      isMounted = false;
    };
  }, [includeCompleted, scopeId, scopeMode]);

  useEffect(() => {
    let isMounted = true;

    async function refreshData() {
      try {
        const [taskData, commitmentData] = await Promise.all([
          fetchScopedTasks(scopeMode, scopeId, includeCompleted),
          fetchCommitments(),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData);
        setCommitments(commitmentData);
      } catch {
        // Non-blocking refresh.
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshData();
    }, 15000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [includeCompleted, scopeId, scopeMode]);

  useEffect(() => {
    if (!newTask || !matchesScope(newTask, scopeMode, scopeId)) {
      return;
    }

    setTasks((current) => mergeTask(current, newTask));
  }, [newTask, scopeId, scopeMode]);

  const emptyStateBody = scopeMode === "implementation"
    ? "Add a task above or include completed work to see historical items."
    : "Add a task above or include completed work to see project history.";

  return (
    <div className="space-y-4">
      <label className="inline-flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={includeCompleted}
          onChange={(event) => setIncludeCompleted(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        Include completed tasks
      </label>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <TaskGridLoadingSkeleton />
      ) : (
        <TaskGrid
          tasks={tasks}
          setTasks={setTasks}
          implementations={implementations}
          commitments={commitments}
          scopeMode={scopeMode}
          emptyStateTitle="No tasks in this view"
          emptyStateBody={emptyStateBody}
        />
      )}
    </div>
  );
}
