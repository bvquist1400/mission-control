import type { CascadeReply } from "@/lib/task-date-cascade";
import type { DateCascadeUndoReply } from "@/lib/task-date-cascade-undo";

/**
 * What the cascade toast and the "more than 25" confirm box say (cascade S2,
 * mockup baseline-design-mockups/cascade-s2). Pure: built from the server's
 * replies, so the words are tested without rendering (test:date-cascade-s2).
 * User-facing copy never names the assistant; it says "Baseline".
 */

export type CascadeModeChoice = "same_gap" | "only_collisions" | "none";
export type CascadeToastTone = "success" | "warning" | "danger" | "info";

export interface TextPart {
  text: string;
  mono?: boolean;
}

export interface MoveLine {
  task_id: string;
  title: string;
  from: string;
  to: string;
}

export interface WarnBlock {
  name: string;
  target: string;
  latest: string;
  count: number;
  ragBefore: string;
  ragAfter: string;
  /** The edited task itself is one of `count` (Brent 10/20: it flags its own project too). */
  includesRoot: boolean;
}

/** The warning block's sentence in three parts (the project name is shown bold). */
export function warnSentenceParts(warn: Pick<WarnBlock, "name" | "target" | "latest" | "count" | "includesRoot">): { lead: string; name: string; tail: string } {
  const lead = warn.includesRoot
    ? `This puts ${warn.count > 1 ? `this task and ${warn.count - 1} more` : "this task"} in `
    : `This pushes ${plural(warn.count, "task")} in `;
  return { lead, name: warn.name, tail: ` after its target (${warn.target}). The latest is now ${warn.latest}.` };
}

/** "This pushes 3 tasks in P after its target (Fri 10/23). The latest is now Tue 10/27." */
export function warnSentence(warn: Pick<WarnBlock, "name" | "target" | "latest" | "count" | "includesRoot">): string {
  const parts = warnSentenceParts(warn);
  return `${parts.lead}${parts.name}${parts.tail}`;
}

export type CascadeToastAction = "undo" | "retry" | "retry_patch" | "only_this";

export interface CascadeToastModel {
  tone: CascadeToastTone;
  title: string;
  sub: TextPart[] | null;
  moves: MoveLine[];
  left: string | null;
  warn: WarnBlock[];
  /** The "How far" row, with the active choice; null hides it. */
  modes: CascadeModeChoice | null;
  primary: { label: string; action: CascadeToastAction } | null;
  secondary: { label: string; action: CascadeToastAction } | null;
  /** "Show next week" (Week board only): how many moved tasks now sit next week. */
  nextWeek: number | null;
  /** A switch or undo that didn't go through (plain words); the rest of the toast stays as it was. */
  error: string | null;
}

export const MODE_OPTIONS: ReadonlyArray<{ value: CascadeModeChoice; label: string; hint: string }> = [
  { value: "same_gap", label: "Same gap", hint: "Move the rest by the same gap" },
  { value: "only_collisions", label: "Only what collides", hint: "Move only what would be due before the task it waits on" },
  { value: "none", label: "Just this task", hint: "Leave the other tasks where they were" },
];

/** How many moved tasks the toast lists before "+N more". */
export const TOAST_MOVES_SHOWN = 5;

// ── ET dates (same rule as src/lib/task-date-cascade.ts; kept here so the client bundle doesn't load the server module) ──

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The ET calendar date (YYYY-MM-DD) of an instant. */
export function etDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(etFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekdayOf(dateOnly: string): number {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "Thu 10/22" for an ET date (YYYY-MM-DD). */
export function formatDateOnlyDay(dateOnly: string): string {
  return `${WEEKDAYS[weekdayOf(dateOnly)]} ${Number(dateOnly.slice(5, 7))}/${Number(dateOnly.slice(8, 10))}`;
}

/** "Thu 10/22" for an instant's ET date; "no date" when there is none. */
export function formatDay(iso: string | null | undefined): string {
  const date = etDateOf(iso);
  return date ? formatDateOnlyDay(date) : "no date";
}

export function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function quote(title: string): string {
  const trimmed = title.trim() || "Untitled task";
  return `“${trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed}”`;
}

function rootSub(rootTitle: string, from: string | null, to: string | null): TextPart[] {
  return [{ text: `${quote(rootTitle)} ` }, { text: `${formatDay(from)} → ${formatDay(to)}`, mono: true }];
}

function namesLine(titles: string[], max = 2): string {
  const shown = titles.slice(0, max).map(quote);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(" and ");
}

const SKIP_WORDS: Record<string, string> = {
  done: "already Done",
  missed: "Missed",
  recurring: "recurring",
  other_status: "its status",
};

function warnBlocks(cascade: Pick<CascadeReply, "project_flags">): WarnBlock[] {
  return (cascade.project_flags ?? []).map((flag) => ({
    name: flag.name,
    target: formatDateOnlyDay(flag.target_date),
    latest: formatDateOnlyDay(flag.latest_due_date),
    count: flag.tasks_past_target,
    ragBefore: flag.rag_before,
    ragAfter: flag.rag_after,
    includesRoot: flag.includes_edited_task === true,
  }));
}

function moveLines(cascade: Pick<CascadeReply, "moves">): MoveLine[] {
  return (cascade.moves ?? []).map((move) => ({
    task_id: move.task_id,
    title: move.title || "A task",
    from: formatDay(move.old_due_at),
    to: formatDay(move.new_due_at),
  }));
}

/** How many of the moved tasks now sit in the week after the one on screen (weekStart = that Monday, YYYY-MM-DD). */
export function movesIntoNextWeek(moves: Array<{ new_due_at: string }>, weekStart: string): number {
  const nextStart = addDays(weekStart, 7);
  const nextEnd = addDays(weekStart, 13);
  return moves.filter((move) => {
    const date = etDateOf(move.new_due_at);
    return Boolean(date && date >= nextStart && date <= nextEnd);
  }).length;
}

export interface ChangeToastInput {
  rootTitle: string;
  cascade: CascadeReply;
  /** The "how far" choice the server ran. */
  choice: CascadeModeChoice;
  /** "patch": the first save; "switch": after "How far" or Try again. */
  origin: "patch" | "switch";
  /** For "Just this task": how many tasks wait on it (the earlier move's count). */
  waitingCount?: number;
  /** Week board: the Monday on screen, for "Show next week". */
  weekStart?: string | null;
}

/** The toast after a date change (or a switch / retry); null when no toast should show. */
export function toastForChange(input: ChangeToastInput): CascadeToastModel | null {
  const { cascade, rootTitle } = input;
  const base: CascadeToastModel = {
    tone: "success",
    title: "",
    sub: rootSub(rootTitle, cascade.root_old_due_at, cascade.root_new_due_at),
    moves: [],
    left: null,
    warn: [],
    modes: input.choice,
    primary: { label: "Undo", action: "undo" },
    secondary: null,
    nextWeek: null,
    error: null,
  };

  switch (cascade.status) {
    case "moved": {
      const moves = moveLines(cascade);
      const changed = (cascade.skipped ?? []).filter((skip) => skip.reason === "changed" || skip.reason === "path_changed");
      const roomy = (cascade.skipped ?? []).filter((skip) => skip.reason === "not_needed");
      const stopped = (cascade.skipped ?? []).filter((skip) => SKIP_WORDS[skip.reason]);
      const leftParts: string[] = [];
      if (cascade.mode === "only_collisions" && moves.length > 0) {
        leftParts.push("Each one moved just far enough not to be due before the task it waits on.");
      }
      if (roomy.length > 0) leftParts.push(`${plural(roomy.length, "task")} already had room, so ${roomy.length === 1 ? "it" : "they"} stayed.`);
      if (stopped.length > 0) {
        leftParts.push(`Not moved: ${stopped.slice(0, 2).map((skip) => `${quote(skip.title || "A task")} (${SKIP_WORDS[skip.reason]})`).join(", ")}${stopped.length > 2 ? ` and ${stopped.length - 2} more` : ""}.`);
      }
      const warn = warnBlocks(cascade);
      const howFar = cascade.mode === "same_gap" ? ` by ${plural(cascade.delta_workdays, "workday")}` : " (only what collided)";
      let title = moves.length > 0 ? `Moved ${plural(moves.length, "task")}${howFar}` : "Nothing else moved";
      let sub = base.sub;
      if (changed.length > 0) {
        title += ` · ${changed.length} stayed as ${changed.length === 1 ? "it was" : "they were"}`;
        sub = [{ text: `${namesLine(changed.map((skip) => skip.title || "A task"))} changed while this was happening, so ${changed.length === 1 ? "it was" : "they were"} not touched.` }];
      }
      return {
        ...base,
        tone: warn.length > 0 || changed.length > 0 ? "warning" : "success",
        title,
        sub,
        moves,
        left: leftParts.join(" ") || null,
        warn,
        nextWeek: input.weekStart ? movesIntoNextWeek(cascade.moves, input.weekStart) || null : null,
      };
    }
    case "nothing_to_move":
    case "off":
    case "not_applicable": {
      // Nothing else moved. After the first save there is only a toast when the
      // edited task itself went past its project's target (Brent 10/20: warn, the
      // project turned Yellow, Undo puts it back).
      const warn = warnBlocks(cascade);
      if (input.origin === "patch") {
        if (warn.length === 0) return null;
        // "How far" only when something waits on it (or "Just this task" was the pick).
        const waits = cascade.status === "off" || (cascade.skipped ?? []).length > 0 || (cascade.planned_moves ?? 0) > 0;
        return { ...base, tone: "warning", title: "Moved only this task", warn, modes: waits ? input.choice : null };
      }
      if (cascade.status === "nothing_to_move") {
        return {
          ...base,
          tone: warn.length > 0 ? "warning" : "info",
          title: "Nothing else needed to move",
          left: input.choice === "only_collisions"
            ? "The tasks waiting on it are already due on or after its new date."
            : "None of the tasks waiting on it can move.",
          warn,
        };
      }
      const waiting = input.waitingCount ?? 0;
      return {
        ...base,
        tone: warn.length > 0 ? "warning" : "success",
        title: "Moved only this task",
        left: waiting > 0
          ? `The ${plural(waiting, "task")} waiting on it ${waiting === 1 ? "was" : "were"} not moved.`
          : "The tasks waiting on it were not moved.",
        warn,
        modes: input.choice,
      };
    }
    case "superseded":
      return {
        ...base,
        tone: "warning",
        title: "The linked tasks were left as they were",
        sub: [{ text: "The due date changed again before they moved, so nothing after it moved. Check the dates, then change it again if you still want them to follow." }],
        modes: null,
        primary: null,
      };
    case "failed": {
      const planned = cascade.planned_moves ?? 0;
      const what = planned > 0 ? `the ${plural(planned, "linked task")}` : "the linked tasks";
      return {
        ...base,
        tone: "danger",
        title: `Only this task moved — couldn’t move ${what}`,
        sub: [
          { text: `${quote(rootTitle)} is on ` },
          { text: formatDay(cascade.root_new_due_at), mono: true },
          { text: `. The tasks waiting on it are still on their old dates. ${cascade.reason === "busy" ? "Baseline was busy" : "Something went wrong"}; a note was left on the task.` },
        ],
        modes: null,
        primary: { label: "Try again", action: "retry" },
      };
    }
    default:
      return null;
  }
}

/** The toast when the date change itself was refused (nothing saved). */
export function toastForSaveFailure(input: {
  rootTitle: string;
  status: number;
  error: string | null;
  oldDueAt: string | null;
}): CascadeToastModel {
  const model: CascadeToastModel = {
    tone: "danger",
    title: "Nothing was saved",
    sub: null,
    moves: [],
    left: null,
    warn: [],
    modes: null,
    primary: null,
    secondary: null,
    nextWeek: null,
    error: null,
  };
  if (input.status === 503) {
    return {
      ...model,
      sub: [
        { text: `Baseline couldn’t read all the tasks that wait on ${quote(input.rootTitle)}, so its date is still ` },
        { text: formatDay(input.oldDueAt), mono: true },
        { text: ". Try again, or move only this task." },
      ],
      primary: { label: "Try again", action: "retry_patch" },
      secondary: { label: "Move only this task", action: "only_this" },
    };
  }
  if (input.status === 409) {
    return { ...model, sub: [{ text: `${quote(input.rootTitle)} changed since it was loaded, so nothing was saved. Reload it and try again.` }] };
  }
  const plain = input.status >= 400 && input.status < 500 && input.error ? input.error : "Something went wrong. Try again.";
  return { ...model, title: "Couldn’t save the date", sub: [{ text: plain }] };
}

/** The toast after Undo. */
export function toastForUndo(input: { rootTitle: string; reply: DateCascadeUndoReply }): CascadeToastModel {
  const restored = input.reply.cascade?.restored ?? [];
  const kept = input.reply.cascade?.kept ?? [];
  const projects = input.reply.cascade?.projects ?? [];
  const root = input.reply.root;
  const rootLine: TextPart[] = root.requested
    ? root.restored
      ? [{ text: `${quote(input.rootTitle)} is back on ` }, { text: formatDay(root.due_at), mono: true }, { text: restored.length > 0 ? " too." : "." }]
      : [{ text: `${quote(input.rootTitle)} was changed again since, so it stays on ` }, { text: formatDay(root.due_at), mono: true }, { text: "." }]
    : [];

  const healthParts: string[] = [];
  for (const project of projects) {
    if (project.rag_after === "Green" && project.rag_before !== "Green") {
      healthParts.push(`${project.name} is back to Green.`);
    } else {
      healthParts.push(`${project.name} is still ${project.rag_after}. Set it back if the dates no longer pass its target.`);
    }
  }

  const model: CascadeToastModel = {
    tone: root.requested && !root.restored ? "warning" : "success",
    title: "",
    sub: rootLine.length ? rootLine : null,
    moves: [],
    left: healthParts.join(" ") || null,
    warn: [],
    modes: null,
    primary: null,
    secondary: null,
    nextWeek: null,
    error: null,
  };

  if (kept.length === 0) {
    model.title = restored.length > 0
      ? `Undone — ${plural(restored.length, "task")} back to ${restored.length === 1 ? "its old date" : "their old dates"}`
      : root.restored ? `Undone — back to ${formatDay(root.due_at)}` : "Nothing needed to be put back";
    return model;
  }

  model.tone = "warning";
  model.title = `${restored.length} restored · ${kept.length} kept because you changed ${kept.length === 1 ? "it" : "them"} since`;
  const keptLine: TextPart[] = kept.length === 1
    ? [
        { text: `${quote(kept[0].title || "A task")} is on ` },
        { text: formatDay(kept[0].due_at), mono: true },
        { text: " now (the move had set " },
        { text: formatDay(kept[0].cascade_due_at), mono: true },
        { text: "), so Undo left it." },
      ]
    : [{ text: `${namesLine(kept.map((item) => item.title || "A task"))} were changed since, so Undo left them.` }];
  model.sub = [...keptLine, ...(rootLine.length ? [{ text: " " }, ...rootLine] : [])];
  model.moves = restored.map((item) => ({ task_id: item.task_id, title: item.title || "A task", from: formatDay(item.from_due_at), to: formatDay(item.to_due_at) }));
  return model;
}

/** The "more than 25" confirm box (panel 6), from a 409 reply. */
export interface CascadeConfirmModel {
  title: string;
  lead: TextPart[];
  notice: string | null;
  rows: MoveLine[];
  total: number;
  /** false when the walk was too large: only "Just this task" and Cancel are offered. */
  canMoveAll: boolean;
  moveAllLabel: string;
}

export function confirmModel(input: { rootTitle: string; cascade: CascadeReply }): CascadeConfirmModel {
  const { cascade } = input;
  // Earliest first (then by title), so the list reads like the plan.
  const rows = [...(cascade.moves ?? [])]
    .sort((a, b) => Date.parse(a.old_due_at) - Date.parse(b.old_due_at) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }))
    .map((move) => ({ task_id: move.task_id, title: move.title || "A task", from: formatDay(move.old_due_at), to: formatDay(move.new_due_at) }));
  const total = rows.length;
  const tooLarge = cascade.status === "too_large";
  const how = cascade.mode === "same_gap"
    ? `, each by ${plural(cascade.delta_workdays, "workday")}`
    : ", each just far enough not to be due before the task it waits on";
  const lead: TextPart[] = tooLarge
    ? [
        {
          text: cascade.reason === "links"
            ? `Too many tasks wait on ${quote(input.rootTitle)}, with too many links between them, to move them all at once. `
            : `Too many tasks wait on ${quote(input.rootTitle)} to move them all at once (more than 500). `,
        },
        { text: "Nothing has been saved yet. You can move only this task." },
      ]
    : [
        { text: `Moving ${quote(input.rootTitle)} from ` },
        { text: formatDay(cascade.root_old_due_at), mono: true },
        { text: " to " },
        { text: formatDay(cascade.root_new_due_at), mono: true },
        { text: ` would also move ${plural(total, "task")} that wait on it${how}. Nothing has been saved yet.` },
      ];
  const flags = cascade.project_flags ?? [];
  const notice = flags.length > 0
    ? flags
        .map((flag) => `It would also push tasks in ${flag.name} past its target (${formatDateOnlyDay(flag.target_date)})${flag.rag_before === "Green" ? " and turn it Yellow" : ""}.`)
        .join(" ")
    : null;
  return {
    title: tooLarge ? "Too many tasks to move at once" : `This would move ${plural(total, "task")}`,
    lead,
    notice,
    rows,
    total,
    canMoveAll: !tooLarge,
    moveAllLabel: `Move all ${total}`,
  };
}

/** Dates that changed on screen after a switch or undo (for local task lists). */
export function datesChangedBy(input: {
  cascade?: Pick<CascadeReply, "moves"> | null;
  restored?: Array<{ task_id: string; to_due_at: string }> | null;
  root?: { task_id: string; due_at: string | null } | null;
}): Array<{ task_id: string; due_at: string | null }> {
  const out = new Map<string, string | null>();
  for (const item of input.restored ?? []) out.set(item.task_id, item.to_due_at);
  for (const move of input.cascade?.moves ?? []) out.set(move.task_id, move.new_due_at);
  if (input.root) out.set(input.root.task_id, input.root.due_at);
  return [...out.entries()].map(([task_id, due_at]) => ({ task_id, due_at }));
}

/** The bold part of the line under the editor's Due Date field before saving (panel 1): how many waiting tasks would follow a later date. */
export function followHint(input: {
  currentDueAt: string | null;
  nextDateOnly: string | null;
  blocks: Array<{ status: string | null; due_at: string | null }> | null;
}): string | null {
  const current = etDateOf(input.currentDueAt);
  if (!input.nextDateOnly || !current || !(input.nextDateOnly > current) || !input.blocks) return null;
  const following = input.blocks.filter((block) => block.status && ["Backlog", "Planned", "In Progress", "Blocked/Waiting"].includes(block.status) && block.due_at).length;
  if (following === 0) return null;
  return `${plural(following, "task")} ${following === 1 ? "waits" : "wait"} on this one and will follow`;
}
