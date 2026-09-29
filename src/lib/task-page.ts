import { isDecisionTask } from "@/lib/task-handoff";
import type { TaskOwner, TaskStatus } from "@/types/database";

/**
 * The redesigned task page (/r/task/[id], Portfolio slice 2), built in code
 * from plain rows so it's tested without a database or a browser. Comment
 * gists are computed here with plain string rules, never an LLM.
 */

export const TASK_PAGE_TIME_ZONE = "America/New_York";
/** A gist is the comment's first sentence, or its first ~140 characters. */
export const GIST_MAX_LENGTH = 140;
/** Newest comments shown before the rest fold under "older comments". */
export const RECENT_COMMENT_COUNT = 20;
/** A description longer than this starts folded. */
export const DESCRIPTION_FOLD_LENGTH = 700;
/** Comments typed on the task page are saved with this prefix, so agents (and the gists) know they're Brent's. */
export const PAGE_COMMENT_PREFIX = "Brent:";

// ── Comment gists ─────────────────────────────────────────────────────────

/** Abbreviations whose trailing dot doesn't end a sentence. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "etc", "approx", "incl", "est", "mr", "mrs", "ms", "dr", "st", "no", "fig", "cf", "al"]);
const MIN_SENTENCE_LENGTH = 12;

/** Markdown to one line of plain text: no markers, code fences, bullets or link URLs. */
export function markdownToPlain(source: string): string {
  return source
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function endsWithAbbreviation(text: string): boolean {
  const word = /([A-Za-z.]+)$/.exec(text)?.[1]?.toLowerCase() ?? "";
  if (ABBREVIATIONS.has(word)) return true;
  // A single initial ("J. Smith") isn't a sentence end either.
  return /(^|\s)[A-Z]$/.test(text);
}

/** The first sentence of plain text, or null when no sentence ends in it. */
export function firstSentence(plain: string): string | null {
  const pattern = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(plain))) {
    const candidate = plain.slice(0, match.index + 1);
    const before = candidate.slice(0, -1);
    if (candidate.length < MIN_SENTENCE_LENGTH) continue;
    if (match[0] === "." && endsWithAbbreviation(before)) continue;
    return candidate.trim();
  }
  return null;
}

/** Cuts text to max characters at a word boundary, ending in "…". */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  const cut = space >= max * 0.6 ? slice.slice(0, space) : slice;
  return `${cut.replace(/[\s,;:—–-]+$/, "")}…`;
}

export interface CommentAuthor {
  /** "brent" for Brent, "agent" for a named agent, null when the text doesn't say. */
  who: TaskOwner | null;
  label: string | null;
  /** The comment with a leading "PM 9/28 ~4:15 PM:" / "Brent (handed back):" stamp removed. */
  body: string;
}

const STAMP = String.raw`(?:\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?(?:,?\s+~?\d{1,2}:\d{2}\s*(?:[AP]M)?)?`;
const BRENT_PREFIX = new RegExp(String.raw`^Brent(?:\s*\(([^)]{1,30})\))?${STAMP}\s*:\s*`, "i");
const AGENT_PREFIX = new RegExp(String.raw`^(PM|Codex|Fable|Builder)${STAMP}\s*:\s*`);

/**
 * Who wrote a comment, from how Baseline's comments are written (task
 * comments have no author column): "Brent…:" and "Brent (handed back):" are
 * Brent; "PM …", "HANDOFF …" (a builder), "REVIEW …" (a reviewer, or Codex /
 * Fable when named) and "Claimed by …" are agents. Anything else: unknown.
 */
export function commentAuthor(content: string): CommentAuthor {
  const text = content.trim();
  const brent = BRENT_PREFIX.exec(text);
  if (brent) return { who: "brent", label: "You", body: text.slice(brent[0].length) };
  const agent = AGENT_PREFIX.exec(text);
  if (agent) return { who: "agent", label: agent[1], body: text.slice(agent[0].length) };
  const head = text.slice(0, 80);
  if (/^REVIEW\b/.test(text)) {
    const label = /\bCodex\b/.test(head) ? "Codex" : /\bFable\b/.test(head) ? "Fable" : "Reviewer";
    return { who: "agent", label, body: text };
  }
  if (/^HANDOFF\b/.test(text)) return { who: "agent", label: "Builder", body: text };
  if (/^Claimed by (?:the )?review/i.test(text)) return { who: "agent", label: "Reviewer", body: text };
  if (/^Claimed by\b/i.test(text)) return { who: "agent", label: "Builder", body: text };
  // "PM 9/28 ~7:56 PM, first real use…": a dated stamp without the colon. ("PM, can you…" is to the PM, not by it.)
  const dated = /^(PM|Codex|Fable|Builder)\s+\d{1,2}\/\d{1,2}\b/.exec(text);
  if (dated) return { who: "agent", label: dated[1], body: text };
  return { who: null, label: null, body: text };
}

export interface CommentGist {
  gist: string;
  /** The gist leaves something out, so the full text is worth unfolding. */
  truncated: boolean;
}

/**
 * One line for a comment: the first sentence of its first paragraph, or its
 * first ~140 characters when that sentence is longer (or there is none).
 */
export function commentGist(body: string, max = GIST_MAX_LENGTH): CommentGist {
  const full = markdownToPlain(body);
  if (!full) return { gist: "", truncated: false };
  const firstParagraph = markdownToPlain(body.trim().split(/\n\s*\n/)[0] ?? "");
  const sentence = firstSentence(firstParagraph) ?? firstParagraph;
  const gist = cutAtWord(sentence || full, max);
  return { gist, truncated: gist !== full };
}

// ── The page model ────────────────────────────────────────────────────────

export interface TaskPageTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  owner: TaskOwner;
  owner_label: string | null;
  status_line: string | null;
  due_at: string | null;
  waiting_on: string | null;
  follow_up_at: string | null;
  description: string | null;
  tags: string[] | null;
  app: string | null;
  project: string | null;
  section: string | null;
}

export interface TaskPageChecklistRow {
  id: string;
  text: string;
  is_done: boolean;
  sort_order: number;
}

export interface TaskPageCommentRow {
  id: string;
  content: string;
  created_at: string;
}

export interface TaskPageComment {
  id: string;
  who: TaskOwner | null;
  label: string | null;
  when: string;
  gist: string;
  truncated: boolean;
  /** The full text (Markdown), shown when unfolded. */
  body: string;
}

export interface TaskPageView {
  id: string;
  title: string;
  status: TaskStatus;
  owner: TaskOwner;
  ownerLabel: string;
  context: string[];
  due: string | null;
  overdue: boolean;
  blocked: boolean;
  /** A decision task: an empty hand-back answer gets a warning. */
  decision: boolean;
  /** What it waits on: waiting_on text and unfinished dependencies. */
  waits: string[];
  stand: string;
  /** The stand sentence was built from the task's fields (no status line yet). */
  standIsDerived: boolean;
  description: string | null;
  descriptionFolded: boolean;
  checklist: TaskPageChecklistRow[];
  checklistDone: number;
  recentComments: TaskPageComment[];
  olderComments: TaskPageComment[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function etParts(timestamp: string, timeZone: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    month: Number(parts.month),
    day: Number(parts.day),
    time: `${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`,
  };
}

/** "4:10 PM" today, else "Sep 28, 4:10 PM" (ET). */
export function formatCommentTime(timestamp: string, now: Date, timeZone = TASK_PAGE_TIME_ZONE): string {
  const at = etParts(timestamp, timeZone);
  const today = etParts(now.toISOString(), timeZone);
  if (!at) return "";
  if (today && at.date === today.date) return at.time;
  return `${MONTHS[at.month - 1]} ${at.day}, ${at.time}`;
}

/** ET calendar date (YYYY-MM-DD) of a timestamp. */
export function toEtDateOnly(timestamp: string | null, timeZone = TASK_PAGE_TIME_ZONE): string | null {
  return timestamp ? etParts(timestamp, timeZone)?.date ?? null : null;
}

const STATUS_PHRASES: Record<TaskStatus, string> = {
  Backlog: "in the backlog",
  Planned: "planned",
  "In Progress": "in progress",
  "Blocked/Waiting": "blocked",
  Parked: "parked",
  Missed: "missed",
  Done: "done",
};

export function buildTaskPageView(input: {
  task: TaskPageTaskRow;
  checklist: TaskPageChecklistRow[];
  comments: TaskPageCommentRow[];
  blockers: string[];
  now?: Date;
}): TaskPageView {
  const { task } = input;
  const now = input.now ?? new Date();
  const today = toEtDateOnly(now.toISOString());
  const checklist = [...input.checklist].sort((a, b) => a.sort_order - b.sort_order);
  const checklistDone = checklist.filter((item) => item.is_done).length;
  const ownerLabel = task.owner === "brent" ? "You" : task.owner_label?.trim() || "Agent";
  const waits = [
    task.waiting_on?.trim() ? `Waiting on ${task.waiting_on.trim()}` : null,
    ...input.blockers.map((title) => `Waits for “${title}”`),
  ].filter((value): value is string => Boolean(value));
  const blocked = task.status === "Blocked/Waiting" || input.blockers.length > 0;
  const due = toEtDateOnly(task.due_at);

  let stand = task.status_line?.trim() ?? "";
  const standIsDerived = !stand;
  if (!stand) {
    const holder = task.owner === "brent" ? "With you" : `With ${task.owner_label?.trim() ? task.owner_label.trim() : "the agents"}`;
    const status = STATUS_PHRASES[task.status] ?? task.status.toLowerCase();
    const waiting = blocked && waits.length ? ` (${waits[0].charAt(0).toLowerCase()}${waits[0].slice(1)})` : "";
    const list = checklist.length ? ` ${checklistDone} of ${checklist.length} checklist items done.` : "";
    stand = `${holder}, ${status}${waiting}.${list}`;
  }

  const comments = [...input.comments]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((row): TaskPageComment => {
      const author = commentAuthor(row.content);
      const { gist, truncated } = commentGist(author.body);
      return {
        id: row.id,
        who: author.who,
        label: author.label,
        when: formatCommentTime(row.created_at, now),
        gist,
        truncated,
        body: row.content,
      };
    });

  const description = task.description?.trim() || null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    ownerLabel,
    // "Stock & Stir · Release 3": the app (else the project), then the section.
    context: [task.app ?? task.project, task.section].filter((value): value is string => Boolean(value)),
    due,
    overdue: Boolean(due && today && due < today && task.status !== "Done"),
    blocked,
    decision: isDecisionTask(task),
    waits,
    stand,
    standIsDerived,
    description,
    descriptionFolded: Boolean(description && description.length > DESCRIPTION_FOLD_LENGTH),
    checklist,
    checklistDone,
    recentComments: comments.slice(0, RECENT_COMMENT_COUNT),
    olderComments: comments.slice(RECENT_COMMENT_COUNT),
  };
}

/** The saved text of a comment typed on the task page. */
export function composePageComment(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? `${PAGE_COMMENT_PREFIX} ${trimmed}` : null;
}
