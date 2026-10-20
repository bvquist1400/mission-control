import type { CascadeReply } from "@/lib/task-date-cascade";
import type { DateCascadeApplyReply, DateCascadeUndoReply } from "@/lib/task-date-cascade-undo";

/** Client calls to POST /api/tasks/{id}/date-cascade (cascade S2: Undo, switch how far, try again). */

export interface DateCascadeUndoBody {
  action: "undo";
  cascade_id: string | null;
  from_due_at: string | null;
  to_due_at: string | null;
  restore_root?: boolean;
}

export interface DateCascadeApplyBody {
  action: "apply";
  cascade_id: string | null;
  mode: "same_gap" | "only_collisions" | "none";
  from_due_at: string | null;
  to_due_at: string | null;
  confirm?: boolean;
}

export type DateCascadeCallResult<T> =
  | { ok: true; reply: T }
  | { ok: false; status: number; error: string; cascade: CascadeReply | null };

async function post<T>(taskId: string, body: DateCascadeUndoBody | DateCascadeApplyBody, doFetch: typeof fetch): Promise<DateCascadeCallResult<T>> {
  let response: Response;
  try {
    response = await doFetch(`/api/tasks/${taskId}/date-cascade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn’t reach Baseline, so nothing was changed. Try again.", cascade: null };
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = data && typeof data.error === "string" && response.status < 500 ? data.error
      : response.status === 503 && data && typeof data.error === "string" ? data.error
      : "Couldn’t do that, so nothing was changed. Try again.";
    return { ok: false, status: response.status, error, cascade: data && typeof data.cascade === "object" ? (data.cascade as CascadeReply) : null };
  }
  return { ok: true, reply: data as T };
}

export function undoDateChange(taskId: string, body: Omit<DateCascadeUndoBody, "action">, doFetch: typeof fetch = fetch) {
  return post<DateCascadeUndoReply>(taskId, { action: "undo", ...body }, doFetch);
}

export function applyDateChange(taskId: string, body: Omit<DateCascadeApplyBody, "action">, doFetch: typeof fetch = fetch) {
  return post<DateCascadeApplyReply>(taskId, { action: "apply", ...body }, doFetch);
}
