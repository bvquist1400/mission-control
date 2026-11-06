/**
 * Estimate, Priority and Blocker in the task panel's "All fields" (redesign S5
 * fix round 1; Brent 11/6 "Fix bug + fields"). The old Tasks table edited the
 * estimate and the blocker flag in place and showed type and priority; the
 * card list doesn't, so the panel (every page) carries them now. Pure rules,
 * pinned by `npm run test:task-fields`; the save goes through the panel's
 * ordinary PATCH /api/tasks/[id] (`priority_score` there sets `base_priority`,
 * the stored score is recomputed with its boosts; an estimate becomes
 * `estimate_source: "manual"`).
 */

export const ESTIMATE_MIN_MINUTES = 1;
/** Same bound as the MCP tools and the old grid's Estimate cell. */
export const ESTIMATE_MAX_MINUTES = 480;

export type FieldParse = { ok: true; value: number } | { ok: false; error: string };

/**
 * Minutes from what was typed: "45", "45m", "45 min", "1h", "1.5h", "1h 30m",
 * "1:30". Whole minutes from 1 to 480 (8 hours).
 */
export function parseEstimateDraft(text: string): FieldParse {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return { ok: false, error: "Give the estimate in minutes (1 to 480)." };
  let minutes: number | null = null;
  let match: RegExpMatchArray | null;
  if ((match = value.match(/^(\d+)\s*(?:m|min|mins|minutes?)?$/))) minutes = Number(match[1]);
  else if ((match = value.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)$/))) minutes = Number(match[1]) * 60;
  else if ((match = value.match(/^(\d+)\s*(?:h|hr|hrs|hours?)\s*(\d+)\s*(?:m|min|mins|minutes?)?$/))) minutes = Number(match[1]) * 60 + Number(match[2]);
  else if ((match = value.match(/^(\d+):([0-5]\d)$/))) minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes === null || !Number.isFinite(minutes)) return { ok: false, error: "Type minutes (45) or hours (1.5h, 1h 30m)." };
  if (!Number.isInteger(minutes)) minutes = Math.round(minutes);
  if (minutes < ESTIMATE_MIN_MINUTES || minutes > ESTIMATE_MAX_MINUTES) {
    return { ok: false, error: `The estimate must be 1 to ${ESTIMATE_MAX_MINUTES} minutes (8 hours).` };
  }
  return { ok: true, value: minutes };
}

/** The base priority, a whole number 0 to 100 (boosts are added on top by the server). */
export function parsePriorityDraft(text: string): FieldParse {
  const value = text.trim();
  if (!/^\d{1,3}$/.test(value)) return { ok: false, error: "Priority is a whole number from 0 to 100." };
  const number = Number(value);
  if (number > 100) return { ok: false, error: "Priority is a whole number from 0 to 100." };
  return { ok: true, value: number };
}

/** "30 min", "1 h", "1 h 30 min". */
export function estimateText(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "none";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface FieldsTask {
  estimated_minutes?: number | null;
  base_priority?: number | null;
  priority_score?: number | null;
  blocker?: boolean | null;
}

/** The base priority a task shows in the box (older rows without one fall back to the score). */
export function basePriorityOf(task: FieldsTask): number {
  if (typeof task.base_priority === "number" && Number.isFinite(task.base_priority)) return task.base_priority;
  if (typeof task.priority_score === "number" && Number.isFinite(task.priority_score)) return task.priority_score;
  return 0;
}

/** The line under the Priority box: the score lists and briefs sort by, and what it is made of. */
export function priorityHint(task: FieldsTask): string {
  const base = basePriorityOf(task);
  const score = typeof task.priority_score === "number" ? task.priority_score : base;
  if (score === base) return `Score ${score}. Due dates and people add to it on their own.`;
  return `Score ${score} = ${base} + ${score - base} from the due date and people.`;
}

export interface FieldDrafts {
  estimate: string;
  priority: string;
  blocker: boolean;
}

export function fieldDraftsOf(task: FieldsTask): FieldDrafts {
  return {
    estimate: typeof task.estimated_minutes === "number" ? String(task.estimated_minutes) : "",
    priority: String(basePriorityOf(task)),
    blocker: Boolean(task.blocker),
  };
}

export interface FieldUpdatePlan {
  /** The PATCH keys to send (only what changed). */
  updates: { estimated_minutes?: number; estimate_source?: "manual"; priority_score?: number; blocker?: boolean };
  changed: boolean;
  errors: { estimate?: string; priority?: string };
}

/**
 * What the drafts change. An invalid box blocks the save (its error shows under
 * it); a box left as it was sends nothing. The estimate saves as manual.
 */
export function fieldUpdates(task: FieldsTask, drafts: FieldDrafts): FieldUpdatePlan {
  const updates: FieldUpdatePlan["updates"] = {};
  const errors: FieldUpdatePlan["errors"] = {};
  const saved = fieldDraftsOf(task);

  if (drafts.estimate.trim() !== saved.estimate) {
    const estimate = parseEstimateDraft(drafts.estimate);
    if (!estimate.ok) errors.estimate = estimate.error;
    else if (estimate.value !== task.estimated_minutes) {
      updates.estimated_minutes = estimate.value;
      updates.estimate_source = "manual";
    }
  }
  if (drafts.priority.trim() !== saved.priority) {
    const priority = parsePriorityDraft(drafts.priority);
    if (!priority.ok) errors.priority = priority.error;
    else if (priority.value !== basePriorityOf(task)) updates.priority_score = priority.value;
  }
  if (drafts.blocker !== saved.blocker) updates.blocker = drafts.blocker;

  return { updates, changed: Object.keys(updates).length > 0, errors };
}
