"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDateCascade } from "@/components/tasks/DateCascadeProvider";
import { fetchTaskDetails, type TaskBlocksLink } from "@/lib/task-detail";
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
  /** Other tasks' due dates changed by a cascade switch or Undo (lists on screen follow). */
  onDatesChanged?: (changes: Array<{ task_id: string; due_at: string | null }>) => void;
}

export interface TaskUpdateOptions {
  /** For a due-date change: the task as shown (the cascade toast and confirm box name it). */
  title?: string;
  previousDueAt?: string | null;
  /** The "more than 25" box was cancelled: nothing was saved. */
  onCancelled?: () => void;
}

interface UseTaskDetailResult {
  loading: boolean;
  error: string | null;
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  dependencies: TaskDependencySummary[];
  /** Tasks that wait on this one (null when they couldn't be read). */
  blocks: TaskBlocksLink[] | null;
  isSaving: boolean;
  /** Resolves true when the PATCH succeeded; on failure `error` is set and it resolves false. */
  updateTask: (updates: TaskUpdatePayload, options?: TaskUpdateOptions) => Promise<boolean>;
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

export function useTaskDetail({ taskId, onTaskUpdated, onDatesChanged }: UseTaskDetailOptions): UseTaskDetailResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [checklist, setChecklist] = useState<TaskChecklistItem[]>([]);
  const [dependencies, setDependencies] = useState<TaskDependencySummary[]>([]);
  const [blocks, setBlocks] = useState<TaskBlocksLink[] | null>([]);
  const [isSaving, setIsSaving] = useState(false);
  const isMountedRef = useRef(true);
  const dateCascade = useDateCascade();

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
      setBlocks([]);
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
        setBlocks(data.blocks);
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

  // After a due-date change (or a cascade switch / Undo) the "Blocks" dates moved: read the links again.
  const refreshLinks = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await fetchTaskDetails(taskId);
      if (!isMountedRef.current) return;
      setDependencies(data.dependencies);
      setBlocks(data.blocks);
      setComments(data.comments);
    } catch {
      // The rest of the window stays as it was.
    }
  }, [taskId]);

  const updateTask = useCallback(
    async (updates: TaskUpdatePayload, options: TaskUpdateOptions = {}): Promise<boolean> => {
      if (!taskId) return false;
      setIsSaving(true);
      setError(null);

      // A due-date change goes through the cascade provider: it saves at once,
      // then the toast lists what moved (Undo, how far), or asks first above 25.
      if ("due_at" in updates && dateCascade) {
        const result = await dateCascade.changeDueDate({
          taskId,
          title: options.title ?? updates.title ?? "This task",
          previousDueAt: options.previousDueAt ?? null,
          updates,
          quietErrors: true,
          onSaved: (task) => onTaskUpdated?.(taskId, task as unknown as TaskUpdatePayload),
          onDatesChanged: (changes) => {
            onDatesChanged?.(changes);
            void refreshLinks();
          },
        });
        if (result.ok) void refreshLinks();
        if (isMountedRef.current) {
          setIsSaving(false);
          if (!result.ok && !result.cancelled) setError(result.error ?? "Failed to update task");
        }
        if (result.cancelled) options.onCancelled?.();
        return result.ok;
      }

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

        const { cascade: _cascade, ...updatedTask } = (await response.json()) as TaskWithImplementation & { cascade?: unknown };
        void _cascade;
        onTaskUpdated?.(taskId, updatedTask as unknown as TaskUpdatePayload);
        return true;
      } catch (err) {
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to update task");
        }
        return false;
      } finally {
        if (isMountedRef.current) setIsSaving(false);
      }
    },
    [taskId, onTaskUpdated, onDatesChanged, dateCascade, refreshLinks]
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
    blocks,
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
