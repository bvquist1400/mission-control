import { getDateOnlyInTimeZone } from "@/lib/date-only";
import {
  OWNER_LABEL_MAX_LENGTH,
  STATUS_LINE_MAX_LENGTH,
  type TaskOwnerFields,
} from "@/lib/task-owner";
import type { TaskOwner } from "@/types/database";

/**
 * Brent's side of task ownership (Portfolio slice 2a): editing who has a task
 * and handing it back to an agent. Pure, so the payloads are tested without a
 * browser; the components only send what these return.
 */

export const HAND_BACK_OWNER_LABEL = "PM";
export const HAND_BACK_COMMENT_PREFIX = "Brent (handed back):";
/** The note lands in a task comment (5,000 max, with the prefix). */
export const HAND_BACK_NOTE_MAX_LENGTH = 2000;
export const AGENT_LABEL_SUGGESTIONS = ["PM", "Builder", "Codex", "Fable"] as const;
/** The hand-back box's label: Brent's answer goes here, not in "Where it stands" (9/28). */
export const HAND_BACK_NOTE_LABEL = "Your answer or decision (the agent reads this)";
export const HAND_BACK_EMPTY_DECISION_WARNING =
  "This task asks for a decision, and your answer box is empty. The agent won't know what you decided.";

/** A decision for Brent: tagged `decision`, or titled "Decide: …" / "Decision …". */
export function isDecisionTask(task: { title: string; tags?: string[] | null }): boolean {
  if ((task.tags ?? []).some((tag) => tag.trim().toLowerCase() === "decision")) return true;
  return /^\s*(decide\s*:|decision\b)/i.test(task.title);
}

/**
 * Whether sending a hand-back should stop for a warning first: a decision task
 * (isDecisionTask) handed back with nothing in the box.
 */
export function handBackNeedsAnswerWarning(isDecision: boolean, note: string | null | undefined): boolean {
  return isDecision && toOneLine(note).length === 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One line: whitespace (including newlines) collapsed and trimmed. */
export function toOneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Cuts a line to max characters, ending in "…" when it had to cut. */
export function truncateLine(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface OwnerDraft {
  owner: TaskOwner;
  ownerLabel: string;
  statusLine: string;
}

export interface OwnerSnapshot {
  owner: TaskOwner;
  owner_label: string | null;
  status_line: string | null;
}

export type OwnerUpdateResult =
  | { ok: true; changes: TaskOwnerFields; changed: boolean }
  | { ok: false; error: string };

/**
 * The PATCH body for the "Who has it" editor: only the fields that changed,
 * normalized the way the API stores them. A task handed to Brent drops its
 * agent label (the label names which agent holds it).
 */
export function buildOwnerUpdate(current: OwnerSnapshot, draft: OwnerDraft): OwnerUpdateResult {
  const label = draft.owner === "agent" ? toOneLine(draft.ownerLabel) || null : null;
  const line = toOneLine(draft.statusLine) || null;

  if (label && label.length > OWNER_LABEL_MAX_LENGTH) {
    return { ok: false, error: `Agent name must be ${OWNER_LABEL_MAX_LENGTH} characters or fewer.` };
  }
  if (line && line.length > STATUS_LINE_MAX_LENGTH) {
    return { ok: false, error: `"Where it stands" must be ${STATUS_LINE_MAX_LENGTH} characters or fewer.` };
  }

  const changes: TaskOwnerFields = {};
  if (draft.owner !== current.owner) changes.owner = draft.owner;
  if (label !== current.owner_label) changes.owner_label = label;
  if (line !== current.status_line) changes.status_line = line;
  return { ok: true, changes, changed: Object.keys(changes).length > 0 };
}

export interface HandBackPlan {
  update: { owner: "agent"; owner_label: string; status_line: string };
  /** The task comment to post, or null when Brent left no note. */
  comment: string | null;
}

/** "Sep 28" for a moment, on the ET calendar. */
export function formatHandBackDate(now: Date, timeZone = "America/New_York"): string {
  const [, month, day] = getDateOnlyInTimeZone(timeZone, now).split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

/**
 * Hand a task back: owner agent (the PM), a status line built from Brent's
 * note, and the note itself as a comment. The comment keeps Brent's line
 * breaks; the status line is one line, cut to fit.
 */
export function composeHandBack(note: string | null | undefined, now: Date = new Date()): HandBackPlan {
  const trimmedNote = (note ?? "").trim().slice(0, HAND_BACK_NOTE_MAX_LENGTH).trim();
  const noteLine = toOneLine(trimmedNote);
  const statusLine = noteLine
    ? truncateLine(`With the ${HAND_BACK_OWNER_LABEL}: ${noteLine}`, STATUS_LINE_MAX_LENGTH)
    : `With the ${HAND_BACK_OWNER_LABEL}: handed back by Brent ${formatHandBackDate(now)}`;
  return {
    update: { owner: "agent", owner_label: HAND_BACK_OWNER_LABEL, status_line: statusLine },
    comment: trimmedNote ? `${HAND_BACK_COMMENT_PREFIX} ${trimmedNote}` : null,
  };
}

export type HandBackResult<TTask = unknown, TComment = unknown> =
  | { ok: false; error: string }
  | { ok: true; task: TTask; comment: TComment | null; commentError: string | null };

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return body && typeof body.error === "string" ? body.error : fallback;
}

/**
 * Runs a hand-back against the task API. The ownership change goes first
 * (it's what takes the task off Brent's list); the note follows as a comment.
 * If only the comment fails, the hand-back still stands, the status line
 * already carries the note, and the caller shows commentError.
 */
export async function handBackTask<TTask = unknown, TComment = unknown>(
  taskId: string,
  note: string | null | undefined,
  options: { fetchImpl?: typeof fetch; now?: Date } = {}
): Promise<HandBackResult<TTask, TComment>> {
  const doFetch = options.fetchImpl ?? fetch;
  const plan = composeHandBack(note, options.now);
  const id = encodeURIComponent(taskId);

  let task: TTask;
  try {
    const response = await doFetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan.update),
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response, "Couldn't hand the task back.") };
    }
    task = (await response.json()) as TTask;
  } catch {
    return { ok: false, error: "Couldn't reach Baseline to hand the task back." };
  }

  if (!plan.comment) {
    return { ok: true, task, comment: null, commentError: null };
  }

  try {
    const response = await doFetch(`/api/tasks/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: plan.comment }),
    });
    if (!response.ok) {
      const error = await readError(response, "the note wasn't saved");
      return { ok: true, task, comment: null, commentError: `Handed back, but the note wasn't saved as a comment: ${error}` };
    }
    return { ok: true, task, comment: (await response.json()) as TComment, commentError: null };
  } catch {
    return { ok: true, task, comment: null, commentError: "Handed back, but the note wasn't saved as a comment." };
  }
}
