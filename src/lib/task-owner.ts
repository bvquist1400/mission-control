import type { TaskOwner } from "@/types/database";

/**
 * Task owner + "where this stands" (migration 056).
 *
 * owner = "brent" means Brent must act; "agent" (the database default) means an
 * agent has it. owner_label says which agent ("PM", "Codex"). status_line is one
 * plain sentence on where the task stands. The limits mirror the migration's
 * CHECK constraints so callers get a 400 with a reason instead of a 500.
 */
export const TASK_OWNERS: readonly TaskOwner[] = ["brent", "agent"] as const;
export const DEFAULT_TASK_OWNER: TaskOwner = "agent";
export const OWNER_LABEL_MAX_LENGTH = 40;
export const STATUS_LINE_MAX_LENGTH = 280;

export interface TaskOwnerFields {
  owner?: TaskOwner;
  owner_label?: string | null;
  status_line?: string | null;
}

export type TaskOwnerFieldsResult = { ok: true; value: TaskOwnerFields } | { ok: false; error: string };

export function isTaskOwner(value: unknown): value is TaskOwner {
  return typeof value === "string" && (TASK_OWNERS as readonly string[]).includes(value);
}

/** Lower-cases and trims an owner filter or input; null when it isn't a known owner. */
export function normalizeTaskOwner(value: unknown): TaskOwner | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isTaskOwner(normalized) ? normalized : null;
}

/** One line of plain text: whitespace (including newlines) collapsed; empty becomes null. */
function normalizeLine(
  value: unknown,
  field: string,
  maxLength: number
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string or null` };
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length === 0) return { ok: true, value: null };
  if (line.length > maxLength) {
    return { ok: false, error: `${field} must be ${maxLength} characters or fewer` };
  }
  return { ok: true, value: line };
}

/**
 * Reads owner / owner_label / status_line from a create or PATCH body. Only the
 * keys present in the body appear in the result, so an older caller that sends
 * none of them changes nothing (and a create falls back to the column defaults).
 */
export function parseTaskOwnerFields(body: Record<string, unknown>): TaskOwnerFieldsResult {
  const value: TaskOwnerFields = {};

  if ("owner" in body && body.owner !== undefined) {
    const owner = normalizeTaskOwner(body.owner);
    if (!owner) {
      return { ok: false, error: `Invalid owner. Must be one of: ${TASK_OWNERS.join(", ")}` };
    }
    value.owner = owner;
  }

  if ("owner_label" in body && body.owner_label !== undefined) {
    const result = normalizeLine(body.owner_label, "owner_label", OWNER_LABEL_MAX_LENGTH);
    if (!result.ok) return result;
    value.owner_label = result.value;
  }

  if ("status_line" in body && body.status_line !== undefined) {
    const result = normalizeLine(body.status_line, "status_line", STATUS_LINE_MAX_LENGTH);
    if (!result.ok) return result;
    value.status_line = result.value;
  }

  return { ok: true, value };
}
