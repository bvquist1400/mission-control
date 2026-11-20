/**
 * Craft S4 (E, G): checklist rows given as plain text or as objects, for create_task's initial_checklist and the
 * checklist POST (add / insert). Pure; every row is checked before anything is written.
 */
import { normalizeUnitCount, normalizeWorkType } from "@/lib/pace";

export interface ChecklistRowInput { text: string; unit_count: number | null; work_type: string | null; is_done?: boolean }
export const CHECKLIST_ROWS_MAX = 500;

/**
 * initial_checklist: strings or { text, unit_count?, work_type? }. Blank strings are dropped (as before S4);
 * anything else that isn't a usable row is a 400 with the row's index.
 */
export function parseInitialChecklist(value: unknown): { ok: true; rows: ChecklistRowInput[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, rows: [] };
  if (!Array.isArray(value)) return { ok: false, error: "initial_checklist must be a list" };
  if (value.length > CHECKLIST_ROWS_MAX) return { ok: false, error: `initial_checklist can have at most ${CHECKLIST_ROWS_MAX} rows` };
  const rows: ChecklistRowInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") { const text = entry.trim(); if (text) rows.push({ text, unit_count: null, work_type: null }); continue; }
    const parsed = parseRowObject(entry, false);
    if (!parsed.ok) return { ok: false, error: `initial_checklist[${index}]: ${parsed.error}` };
    rows.push(parsed.row);
  }
  return { ok: true, rows };
}

/** One row object: { text, unit_count?, work_type? } (+ is_done when allowDone). Unknown keys are refused. */
export function parseRowObject(entry: unknown, allowDone: boolean): { ok: true; row: ChecklistRowInput } | { ok: false; error: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "each row must be text or { text, unit_count?, work_type? }" };
  const record = entry as Record<string, unknown>;
  const allowed = allowDone ? ["text", "unit_count", "work_type", "is_done"] : ["text", "unit_count", "work_type"];
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) return { ok: false, error: `unknown field ${unknownKey}` };
  if (typeof record.text !== "string" || !record.text.trim()) return { ok: false, error: "text must be a non-empty string" };
  const units = normalizeUnitCount(record.unit_count);
  if (!units.ok) return { ok: false, error: units.error };
  const workType = normalizeWorkType(record.work_type);
  if (!workType.ok) return { ok: false, error: workType.error };
  if ("is_done" in record && typeof record.is_done !== "boolean") return { ok: false, error: "is_done must be true or false" };
  return { ok: true, row: { text: record.text.trim(), unit_count: units.value, work_type: workType.value, ...(typeof record.is_done === "boolean" ? { is_done: record.is_done } : {}) } };
}

/** POST /api/tasks/[id]/checklist with { items: [...], after_item_id?, at_start? }: several rows at one place. */
export function parseChecklistAdd(body: Record<string, unknown>): { ok: true; rows: ChecklistRowInput[]; after_item_id: string | null; at_start: boolean } | { ok: false; error: string } {
  const unknownKey = Object.keys(body).find((key) => !["items", "after_item_id", "at_start"].includes(key));
  if (unknownKey) return { ok: false, error: `Unknown field: ${unknownKey}` };
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > CHECKLIST_ROWS_MAX) return { ok: false, error: `items must list 1 to ${CHECKLIST_ROWS_MAX} rows` };
  const rows: ChecklistRowInput[] = [];
  for (const [index, entry] of body.items.entries()) {
    const parsed = typeof entry === "string" ? (entry.trim() ? { ok: true as const, row: { text: entry.trim(), unit_count: null, work_type: null } } : { ok: false as const, error: "text must be a non-empty string" }) : parseRowObject(entry, true);
    if (!parsed.ok) return { ok: false, error: `items[${index}]: ${parsed.error}` };
    rows.push(parsed.row);
  }
  const after = body.after_item_id;
  if (after !== undefined && after !== null && (typeof after !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after))) {
    return { ok: false, error: "after_item_id must be a checklist item UUID" };
  }
  if (body.at_start !== undefined && typeof body.at_start !== "boolean") return { ok: false, error: "at_start must be true or false" };
  if (after && body.at_start) return { ok: false, error: "give after_item_id or at_start, not both" };
  return { ok: true, rows, after_item_id: typeof after === "string" ? after.toLowerCase() : null, at_start: body.at_start === true };
}

/** DELETE /api/tasks/[id]: refused while the task has ticked craft rows or sittings, unless force (075). */
export const taskDeleteRefusalText = (ticked: number, sittings: number) => {
  const parts = [
    ticked > 0 ? `${ticked} ticked craft ${ticked === 1 ? "row" : "rows"}` : null,
    sittings > 0 ? `${sittings} ${sittings === 1 ? "sitting" : "sittings"}` : null,
  ].filter(Boolean);
  return `This task has ${parts.join(" and ")}. Deleting it loses them from the craft screen and the pace numbers. Delete it anyway only if you mean to (force).`;
};
