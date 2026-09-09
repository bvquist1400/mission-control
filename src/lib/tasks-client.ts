import type { TaskUpdatePayload } from "@/types/database";

/**
 * Single client-side entry point for task PATCHes. Previously each panel
 * hand-rolled its own fetch + error string, which is how NowPanel and WeekBoard
 * ended up with different behaviour for the same action.
 */
export async function patchTask(
  taskId: string,
  updates: TaskUpdatePayload
): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error(await readTaskErrorMessage(response));
  }
}

/**
 * The tasks API returns `{ error: string }` for handled failures. Surface that
 * text when present so the user sees the real reason (an unmet dependency, a
 * conflicting external ID) instead of a generic failure string.
 */
async function readTaskErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Non-JSON body; fall through to the status-based message.
  }

  return `Request failed (${response.status})`;
}
