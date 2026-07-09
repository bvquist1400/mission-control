"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import type {
  CommitmentSummary,
  TaskUpdatePayload,
  TaskWithImplementation,
} from "@/types/database";

interface TodayModalContextValue {
  openTask: (task: TaskWithImplementation) => void;
  registerTasks: (tasks: TaskWithImplementation[]) => void;
}

const TodayModalContext = createContext<TodayModalContextValue | null>(null);

export function useTodayModal(): TodayModalContextValue {
  const ctx = useContext(TodayModalContext);
  if (!ctx) {
    throw new Error("useTodayModal must be used within a TodayModalProvider");
  }
  return ctx;
}

/**
 * Owns the selected-task state for the Today page so any client island (the
 * Now panel today, the week board in a later step) can open the shared
 * TaskDetailModal. Mutations propagate via router.refresh() so the streamed
 * server sections re-render with fresh data.
 */
export function TodayModalProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [tasksById, setTasksById] = useState<Map<string, TaskWithImplementation>>(
    () => new Map()
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [commitmentsLoaded, setCommitmentsLoaded] = useState(false);

  const openTask = useCallback((task: TaskWithImplementation) => {
    setTasksById((prev) => {
      const next = new Map(prev);
      next.set(task.id, task);
      return next;
    });
    setSelectedId(task.id);
  }, []);

  const registerTasks = useCallback((tasks: TaskWithImplementation[]) => {
    if (tasks.length === 0) {
      return;
    }
    setTasksById((prev) => {
      const next = new Map(prev);
      for (const task of tasks) {
        next.set(task.id, task);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectedId || commitmentsLoaded) {
      return;
    }

    let isMounted = true;
    fetch("/api/commitments", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: CommitmentSummary[]) => {
        if (isMounted) {
          setCommitments(Array.isArray(rows) ? rows : []);
          setCommitmentsLoaded(true);
        }
      })
      .catch(() => {
        /* commitments are optional in the modal; ignore fetch failures */
      });

    return () => {
      isMounted = false;
    };
  }, [selectedId, commitmentsLoaded]);

  const handleTaskUpdated = useCallback(
    (taskId: string, updates: TaskUpdatePayload) => {
      setTasksById((prev) => {
        const existing = prev.get(taskId);
        if (!existing) {
          return prev;
        }
        const next = new Map(prev);
        next.set(taskId, { ...existing, ...updates } as TaskWithImplementation);
        return next;
      });
      router.refresh();
    },
    [router]
  );

  const handleTaskDeleted = useCallback(
    (taskId: string) => {
      setSelectedId((current) => (current === taskId ? null : current));
      router.refresh();
    },
    [router]
  );

  const selectedTask = selectedId ? tasksById.get(selectedId) ?? null : null;
  const allTasks = useMemo(() => Array.from(tasksById.values()), [tasksById]);
  const contextValue = useMemo<TodayModalContextValue>(
    () => ({ openTask, registerTasks }),
    [openTask, registerTasks]
  );

  return (
    <TodayModalContext.Provider value={contextValue}>
      {children}
      <TaskDetailModal
        task={selectedTask}
        allTasks={allTasks}
        commitments={commitments}
        onClose={() => setSelectedId(null)}
        onTaskUpdated={handleTaskUpdated}
        onTaskDeleted={handleTaskDeleted}
      />
    </TodayModalContext.Provider>
  );
}
