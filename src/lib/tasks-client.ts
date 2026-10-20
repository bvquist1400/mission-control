import type { CascadeReply } from "@/lib/task-date-cascade";
import type { TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

/**
 * Single client-side entry point for task PATCHes. Previously each panel
 * hand-rolled its own fetch + error string, which is how NowPanel and WeekBoard
 * ended up with different behaviour for the same action.
 */
export async function patchTask(
  taskId: string,
  updates: TaskUpdatePayload
): Promise<void> {
  const result = await patchTaskWithReply(taskId, updates);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

/** Extra keys a date change may carry in the PATCH body (cascade S1/S2); never part of the task row. */
export interface TaskPatchCascadeOptions {
  cascade?: boolean;
  cascade_mode?: "same_gap" | "only_collisions";
  cascade_confirm?: boolean;
}

export type TaskPatchResult =
  | { ok: true; status: number; task: TaskWithImplementation; cascade: CascadeReply | null }
  | { ok: false; status: number; error: string; cascade: CascadeReply | null; reason: string | null };

/**
 * PATCH that keeps the server's reply: the saved task and, for a due-date
 * change, its `cascade` object; on a refusal the plain error and, for a 409
 * "more than 25" refusal, the preview (`cascade.status` "needs_confirm" /
 * "too_large"), where nothing was saved.
 */
export async function patchTaskWithReply(
  taskId: string,
  updates: TaskUpdatePayload,
  options: TaskPatchCascadeOptions = {},
  doFetch: typeof fetch = fetch
): Promise<TaskPatchResult> {
  let response: Response;
  try {
    response = await doFetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, ...options }),
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn’t reach Baseline. Check the connection and try again.", cascade: null, reason: null };
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const cascade = body && typeof body.cascade === "object" && body.cascade !== null ? (body.cascade as CascadeReply) : null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: readErrorText(body, response.status),
      cascade,
      reason: body && typeof body.reason === "string" ? body.reason : null,
    };
  }
  const task = { ...(body ?? {}) } as Record<string, unknown>;
  delete task.cascade;
  return { ok: true, status: response.status, task: task as unknown as TaskWithImplementation, cascade };
}

/**
 * The tasks API returns `{ error: string }` for handled failures. Surface that
 * text when present so the user sees the real reason (an unmet dependency, a
 * conflicting external ID) instead of a generic failure string.
 */
function readErrorText(body: Record<string, unknown> | null, status: number): string {
  if (body && typeof body.error === "string" && body.error.trim()) {
    return body.error;
  }
  return `Request failed (${status})`;
}
