"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { patchTask } from "@/lib/tasks-client";
import type { TaskStatus, TaskUpdatePayload } from "@/types/database";

interface TaskLike {
  id: string;
  title: string;
  status: TaskStatus;
}

interface LocalStateHandlers {
  /** Apply the change locally before the request goes out. */
  onOptimistic?: () => void;
  /** Revert the local change when the request fails. */
  onRollback?: () => void;
  /** Restore local state when the user undoes. Optional — the router refresh
   *  re-streams the task anyway; this just makes it feel instant. */
  onUndo?: () => void;
}

/** Keeps toast copy readable when a task title is very long. */
function truncateTitle(title: string, max = 48): string {
  const trimmed = title.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Owns the full lifecycle of a task mutation: optimistic update, request,
 * rollback on failure, success toast, and undo.
 *
 * Undo is safe for status changes: no database trigger fires on a transition to
 * Done, and recurring instances are produced by the explicit generator rather
 * than by completion, so restoring the previous status fully reverses the edit.
 * It does append a second row to `task_status_transitions`, which is the
 * intended behaviour for an append-only audit log.
 */
export function useTaskMutation() {
  const router = useRouter();
  const { toast } = useToast();

  const completeTask = useCallback(
    async (task: TaskLike, handlers: LocalStateHandlers = {}): Promise<boolean> => {
      const previousStatus = task.status;

      handlers.onOptimistic?.();

      try {
        await patchTask(task.id, { status: "Done" });
      } catch (error) {
        handlers.onRollback?.();
        toast({
          tone: "danger",
          message:
            error instanceof Error
              ? error.message
              : `Couldn't complete "${truncateTitle(task.title)}"`,
        });
        return false;
      }

      toast({
        tone: "success",
        message: `Completed “${truncateTitle(task.title)}”`,
        action: {
          label: "Undo",
          onClick: async () => {
            handlers.onUndo?.();
            try {
              await patchTask(task.id, { status: previousStatus });
            } catch (error) {
              toast({
                tone: "danger",
                message:
                  error instanceof Error
                    ? error.message
                    : "Couldn't undo — the task is still marked done.",
              });
            } finally {
              router.refresh();
            }
          },
        },
      });

      router.refresh();
      return true;
    },
    [router, toast]
  );

  /**
   * Generic optimistic update for edits that don't need an undo affordance
   * (pinning, rescheduling). Failures roll back and surface a toast.
   */
  const updateTask = useCallback(
    async (
      taskId: string,
      updates: TaskUpdatePayload,
      handlers: LocalStateHandlers & { failureMessage?: string } = {}
    ): Promise<boolean> => {
      handlers.onOptimistic?.();

      try {
        await patchTask(taskId, updates);
      } catch (error) {
        handlers.onRollback?.();
        toast({
          tone: "danger",
          message:
            error instanceof Error
              ? error.message
              : handlers.failureMessage ?? "Couldn't update the task.",
        });
        return false;
      }

      router.refresh();
      return true;
    },
    [router, toast]
  );

  return { completeTask, updateTask };
}
