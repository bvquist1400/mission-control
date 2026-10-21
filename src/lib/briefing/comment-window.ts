import { excludePersonalTasks } from "@/lib/personal-exclusion";
import { commentAuthor, commentGist } from "@/lib/task-page";
import type { WorkIntelligenceCommentRow } from "@/lib/work-intelligence/types";
import type { TaskOwner, TaskStatus } from "@/types/database";

/**
 * The digest's activity window: "what's new since the last brief". Briefs
 * chain AM → EOD → AM, so each brief reads from the previous brief's save
 * (of either edition), not from its own calendar day; otherwise a comment
 * written after the 4:15 EOD, or over a weekend, never reaches any brief.
 * Pure, so the window rules are tested without a database.
 */

/** Never look back further than this before the brief's ET day start. */
export const COMMENT_WINDOW_MAX_DAYS = 4;
/**
 * A routine reads the digest a few minutes before it saves, so the window
 * starts this long before the previous save: a comment written while that
 * brief was being put together can show twice, but never zero times.
 */
export const BRIEF_RUN_MARGIN_MINUTES = 30;
/** At most this many tasks in `new_comments.tasks`; the totals stay real. */
export const NEW_COMMENTS_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type CommentWindowSource = "explicit" | "previous_brief" | "day_start";

export interface PreviousBriefRef {
  code: string;
  edition: string;
  brief_date: string;
  /** The brief's first save. */
  created_at: string;
}

export interface CommentWindow {
  /** ISO start of the window (inclusive). */
  since: string;
  source: CommentWindowSource;
  previous_brief_code: string | null;
  /** The start was pulled forward to the cap (COMMENT_WINDOW_MAX_DAYS before day start). */
  capped: boolean;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The window start: an explicit `since` wins, else the previous brief's save
 * (less the run margin), else the ET day start. Whatever wins is never earlier
 * than `maxDays` before the day start.
 */
export function resolveCommentWindow(input: {
  explicitSince: string | null;
  previousBrief: PreviousBriefRef | null;
  dayStartIso: string;
  maxDays?: number;
}): CommentWindow {
  const dayStartMs = toMs(input.dayStartIso);
  if (dayStartMs === null) throw new Error(`Invalid day start: ${input.dayStartIso}`);
  const floorMs = dayStartMs - (input.maxDays ?? COMMENT_WINDOW_MAX_DAYS) * DAY_MS;

  const explicitMs = toMs(input.explicitSince);
  const previousMs = toMs(input.previousBrief?.created_at);
  let startMs: number;
  let source: CommentWindowSource;
  if (explicitMs !== null) {
    startMs = explicitMs;
    source = "explicit";
  } else if (previousMs !== null) {
    startMs = previousMs - BRIEF_RUN_MARGIN_MINUTES * MINUTE_MS;
    source = "previous_brief";
  } else {
    startMs = dayStartMs;
    source = "day_start";
  }

  const capped = startMs < floorMs;
  return {
    since: new Date(capped ? floorMs : startMs).toISOString(),
    source,
    previous_brief_code: source === "previous_brief" ? input.previousBrief?.code ?? null : null,
    capped,
  };
}

/** The brief edition a digest mode is building, so "the previous brief" skips a same-day rerun's own brief. */
export function briefEditionForDigestMode(mode: string): "am" | "eod" | null {
  if (mode === "morning") return "am";
  if (mode === "eod") return "eod";
  return null;
}

/**
 * The newest brief saved before the one being built: the first of `briefs`
 * (newest first) that isn't the same edition and date as `building`.
 */
export function pickPreviousBrief(
  briefs: PreviousBriefRef[],
  building: { edition: string | null; brief_date: string }
): PreviousBriefRef | null {
  const sorted = [...briefs].sort((a, b) => (toMs(b.created_at) ?? 0) - (toMs(a.created_at) ?? 0));
  return sorted.find((brief) => !(brief.edition === building.edition && brief.brief_date === building.brief_date)) ?? null;
}

export type CommentFlag = "hand_back" | "review" | "handoff";

const HAND_BACK = /^Brent\s*\(handed back\)/i;

/** House-format markers worth calling out in a brief. */
export function commentFlags(content: string): CommentFlag[] {
  const text = content.trim();
  const flags: CommentFlag[] = [];
  if (HAND_BACK.test(text)) flags.push("hand_back");
  if (/^REVIEW\b/.test(text)) flags.push("review");
  if (/^HANDOFF\b/.test(text)) flags.push("handoff");
  return flags;
}

/** "Brent", "Brent (handed back)", the agent's label ("PM", "Codex", "Builder"…), or null when the text doesn't say. */
export function commentAuthorLabel(content: string): string | null {
  const author = commentAuthor(content);
  if (author.who === "brent") return HAND_BACK.test(content.trim()) ? "Brent (handed back)" : "Brent";
  return author.label;
}

export interface NewCommentsTask {
  id: string;
  title: string;
  status: TaskStatus;
  owner: TaskOwner | null;
  owner_label: string | null;
  /** Comments on this task in the window. */
  count: number;
  latest_at: string;
  latest_author: string | null;
  /** First sentence of the latest comment (code, never an LLM). Read the thread for the rest. */
  latest_gist: string;
  /** Hand-backs, REVIEW and HANDOFF comments anywhere in the window, not just the latest. */
  flags: CommentFlag[];
}

export interface NewCommentsSection {
  since: string;
  source: CommentWindowSource;
  previous_brief_code: string | null;
  capped: boolean;
  /** Real totals before the NEW_COMMENTS_LIMIT cap. */
  total_tasks: number;
  total_comments: number;
  tasks: NewCommentsTask[];
}

interface CommentTaskInput {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: TaskOwner | null;
  owner_label?: string | null;
  tags?: string[] | null;
  project?: unknown;
}

const FLAG_ORDER: CommentFlag[] = ["hand_back", "review", "handoff"];

/**
 * Every work task with a comment written in [since, until): personal tasks
 * and comments on tasks not in `tasks` are left out. Tasks with a hand-back
 * come first, then REVIEW / HANDOFF, then the newest.
 */
export function buildNewCommentsSection(input: {
  window: CommentWindow;
  comments: WorkIntelligenceCommentRow[];
  tasks: CommentTaskInput[];
  untilIso?: string | null;
  limit?: number;
}): NewCommentsSection {
  const sinceMs = toMs(input.window.since) ?? 0;
  const untilMs = toMs(input.untilIso ?? null);
  const taskById = new Map(excludePersonalTasks(input.tasks).map((task) => [task.id, task]));

  const groups = new Map<string, { task: CommentTaskInput; rows: Array<{ row: WorkIntelligenceCommentRow; ms: number }> }>();
  for (const row of input.comments) {
    const ms = toMs(row.created_at);
    if (ms === null || ms < sinceMs || (untilMs !== null && ms >= untilMs)) continue;
    const task = taskById.get(row.task_id);
    if (!task) continue;
    const group = groups.get(task.id) ?? { task, rows: [] };
    group.rows.push({ row, ms });
    groups.set(task.id, group);
  }

  const all: NewCommentsTask[] = [...groups.values()].map(({ task, rows }) => {
    rows.sort((a, b) => b.ms - a.ms || b.row.id.localeCompare(a.row.id));
    const latest = rows[0].row;
    const flagSet = new Set(rows.flatMap(({ row }) => commentFlags(row.content)));
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      owner: task.owner ?? null,
      owner_label: task.owner_label ?? null,
      count: rows.length,
      latest_at: new Date(rows[0].ms).toISOString(),
      latest_author: commentAuthorLabel(latest.content),
      latest_gist: commentGist(commentAuthor(latest.content).body).gist,
      flags: FLAG_ORDER.filter((flag) => flagSet.has(flag)),
    };
  });

  const rank = (item: NewCommentsTask) => (item.flags.length ? FLAG_ORDER.indexOf(item.flags[0]) : FLAG_ORDER.length);
  // latest_at is a normalized ISO string, so it sorts as text.
  all.sort((a, b) => rank(a) - rank(b) || b.latest_at.localeCompare(a.latest_at) || a.id.localeCompare(b.id));

  return {
    since: input.window.since,
    source: input.window.source,
    previous_brief_code: input.window.previous_brief_code,
    capped: input.window.capped,
    total_tasks: all.length,
    total_comments: all.reduce((sum, item) => sum + item.count, 0),
    tasks: all.slice(0, input.limit ?? NEW_COMMENTS_LIMIT),
  };
}
