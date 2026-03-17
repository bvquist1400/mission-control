"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskDetails } from "@/lib/task-detail";
import type {
  TaskChecklistItem,
  TaskComment,
  TaskDependencySummary,
  TaskUpdatePayload,
  TaskWithImplementation,
} from "@/types/database";

interface UseTaskDetailOptions {
  taskId: string | null;
  onTaskUpdated?: (taskId: string, updates: TaskUpdatePayload) => void;
}

interface UseTaskDetailResult {
  loading: boolean;
  error: string | null;
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  dependencies: TaskDependencySummary[];
  isSaving: boolean;
  updateTask: (updates: TaskUpdatePayload) => Promise<void>;
  addComment: (comment: TaskComment) => void;
  updateComment: (comment: TaskComment) => void;
  deleteComment: (commentId: string) => void;
  toggleChecklistItem: (item: TaskChecklistItem) => Promise<void>;
  addChecklistItem: (text: string) => Promise<void>;
  updateChecklistItem: (itemId: string, text: string) => Promise<void>;
  deleteChecklistItem: (itemId: string) => Promise<void>;
  addDependency: (dependency: TaskDependencySummary) => void;
  removeDependency: (dependencyId: string) => void;
}

function getDependencyBlockedState(dependencies: TaskDependencySummary[]): boolean {
  return dependencies.some((d) => d.unresolved);
}

export function useTaskDetail({ taskId, onTaskUpdated }: UseTaskDetailOptions): UseTaskDetailResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [checklist, setChecklist] = useState<TaskChecklistItem[]>([]);
  const [dependencies, setDependencies] = useState<TaskDependencySummary[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Fetch details when taskId changes
  useEffect(() => {
    if (!taskId) {
      setLoading(false);
      setComments([]);
      setChecklist([]);
      setDependencies([]);
      setError(null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchTaskDetails(taskId, controller.signal)
      .then((data) => {
        if (!active) return;
        setComments(data.comments);
        setChecklist(data.checklist);
        setDependencies(data.dependencies);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (!active) return;
        setError("Failed to load task details");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [taskId]);

  const updateTask = useCallback(
    async (updates: TaskUpdatePayload) => {
      if (!taskId) return;
      setIsSaving(true);
      setError(null);

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
        onTaskUpdated?.(taskId, updatedTask as unknown as TaskUpdatePayload);
      } catch (err) {
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to update task");
        }
      } finally {
        if (isMountedRef.current) setIsSaving(false);
      }
    },
    [taskId, onTaskUpdated]
  );

  const addComment = useCallback((comment: TaskComment) => {
    setComments((current) => [...current, comment]);
  }, []);

  const updateComment = useCallback((updated: TaskComment) => {
    setComments((current) => current.map((c) => (c.id === updated.id ? updated : c)));
  }, []);

  const deleteComment = useCallback((commentId: string) => {
    setComments((current) => current.filter((c) => c.id !== commentId));
  }, []);

  const toggleChecklistItem = useCallback(
    async (item: TaskChecklistItem) => {
      if (!taskId) return;

      // Optimistic update
      setChecklist((current) =>
        current.map((ci) => (ci.id === item.id ? { ...ci, is_done: !ci.is_done } : ci))
      );

      try {
        const response = await fetch(`/api/tasks/${taskId}/checklist`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id: item.id, is_done: !item.is_done }] }),
        });
        if (!response.ok) throw new Error("Failed to update checklist");
      } catch {
        // Revert on error
        setChecklist((current) =>
          current.map((ci) => (ci.id === item.id ? { ...ci, is_done: item.is_done } : ci))
        );
      }
    },
    [taskId]
  );

  const addChecklistItem = useCallback(
    async (text: string) => {
      if (!taskId || !text.trim()) return;

      try {
        const response = await fetch(`/api/tasks/${taskId}/checklist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.trim() }),
        });

        if (response.ok) {
          const newItem = (await response.json()) as TaskChecklistItem;
          if (isMountedRef.current) {
            setChecklist((current) => [...current, newItem]);
          }
        }
      } catch {
        // Silently fail
      }
    },
    [taskId]
  );

  const updateChecklistItem = useCallback(
    async (itemId: string, text: string) => {
      if (!taskId) return;

      const nextText = text.trim();
      if (!nextText) return;

      const existingItem = checklist.find((ci) => ci.id === itemId);
      if (!existingItem) {
        return;
      }

      const previousText = existingItem.text;
      if (previousText === nextText) {
        return;
      }

      setChecklist((current) => current.map((ci) => (ci.id === itemId ? { ...ci, text: nextText } : ci)));

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
        setChecklist((current) =>
          current.map((ci) => (ci.id === itemId ? { ...ci, text: previousText ?? ci.text } : ci))
        );
      }
    },
    [taskId, checklist]
  );

  const deleteChecklistItem = useCallback(
    async (itemId: string) => {
      if (!taskId) return;

      // Optimistic update
      setChecklist((current) => current.filter((ci) => ci.id !== itemId));

      try {
        const response = await fetch(`/api/tasks/${taskId}/checklist?itemId=${itemId}`, { method: "DELETE" });
        if (!response.ok) {
          throw new Error("Failed to delete checklist item");
        }
      } catch {
        // Reload on error
        fetchTaskDetails(taskId).then((data) => {
          if (isMountedRef.current) setChecklist(data.checklist);
        });
      }
    },
    [taskId]
  );

  const addDependency = useCallback(
    (dependency: TaskDependencySummary) => {
      setDependencies((current) => {
        const next = [...current, dependency];
        if (taskId) {
          onTaskUpdated?.(taskId, { blocker: getDependencyBlockedState(next) } as TaskUpdatePayload);
        }
        return next;
      });
    },
    [taskId, onTaskUpdated]
  );

  const removeDependency = useCallback(
    (dependencyId: string) => {
      setDependencies((current) => {
        const next = current.filter((d) => d.id !== dependencyId);
        if (taskId) {
          onTaskUpdated?.(taskId, { blocker: getDependencyBlockedState(next) } as TaskUpdatePayload);
        }
        return next;
      });
    },
    [taskId, onTaskUpdated]
  );

  return {
    loading,
    error,
    comments,
    checklist,
    dependencies,
    isSaving,
    updateTask,
    addComment,
    updateComment,
    deleteComment,
    toggleChecklistItem,
    addChecklistItem,
    updateChecklistItem,
    deleteChecklistItem,
    addDependency,
    removeDependency,
  };
}
