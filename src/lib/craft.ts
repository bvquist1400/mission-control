/** Pure read model. Checklist ticks are the only source of row progress. */
import { etDateOf } from "@/lib/work-sessions/parse";
import { LONG_RUN_MINUTES, SITTING_MAX_MINUTES, countFromCheckText, isCountItemText, timerElapsedAt, type RowState } from "@/lib/craft/actions";
import type { Database } from "@/types/supabase.generated";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type CraftPart = Pick<Row<"craft_parts">, "id" | "name" | "sort_order" | "total_rows" | "row_word" | "quarters" | "quarter" | "quarter_row" | "ridges" | "stitch_count">;
export type CraftSegment = Pick<Row<"craft_segments">, "id" | "part_id" | "task_id" | "name" | "from_row" | "to_row" | "sort_order" | "close_check">;
export type CraftItem = Pick<Row<"task_checklist_items">, "id" | "craft_part_id" | "craft_row" | "text" | "is_done" | "completed_at">;
export type CraftSession = Pick<Row<"work_sessions">, "id" | "session_date" | "created_at" | "minutes" | "note" | "exclude_from_stats">;
export interface CraftInput {
  project: { id: string; name: string };
  craft_project: Pick<Row<"craft_projects">, "craft" | "gear" | "active_part_id">;
  parts: CraftPart[];
  segments: CraftSegment[];
  items: CraftItem[];
  sessions: CraftSession[];
  session_items: Pick<Row<"work_session_items">, "session_id" | "checklist_item_id">[];
  sitting_details: Row<"craft_sitting_details">[];
  timer: Row<"craft_timers"> | null;
  server_now: string;
  /** From 072's craft_remove_blockers: what Remove would lose that Set up can't make again. Absent or null = unknown (no Remove). */
  remove_blockers?: string[] | null;
  /** S2: when the caller's one timer is on another project, that project (for "Save or discard the scarf's 23 min first?"). */
  timer_project?: { id: string; name: string } | null;
  /** S2: the tasks of close_check segments (status for the band close) and their plain "Count …" items. */
  band_tasks?: { id: string; status: string; title: string }[];
  count_items?: { id: string; task_id: string; text: string; is_done: boolean; sort_order: number }[];
  /** S2: notes on a row or the project, newest first. */
  notes?: Pick<Row<"craft_notes">, "id" | "part_id" | "row" | "text" | "created_at" | "session_id">[];
}

/** The craft timer as the screen shows it, at the view's server_now (073: one per user). */
export interface CraftTimerView {
  project_id: string; part_id: string | null; running: boolean; version: number;
  sitting_started_at: string; running_since: string | null; paused_at: string | null;
  banked_seconds: number; adjust_seconds: number; start_row: number; start_quarter: number;
  elapsed_seconds: number;
  /** Over LONG_RUN_MINUTES: "Was it left on?". */
  long_run: boolean;
  /** Over 1,440 minutes: a sitting can't hold it all. */
  over_cap: boolean;
  /** The sitting started on an earlier ET day than server_now. */
  new_day: boolean;
}

type ProgressItem = Pick<CraftItem, "craft_part_id" | "craft_row" | "is_done">;

/**
 * One part's progress from its ticks: the lowest unticked row is the current row. Row numbers may have
 * gaps (S1C: an "(est.)" round deleted once a measurement lands early), so counts use the rows that
 * exist (row_count), "next rows" skip missing numbers, and a part is finished when no row is unticked.
 */
function partProgress<P extends CraftPart>(part: P, items: ProgressItem[]) {
  const rows = items.filter((item) => item.craft_part_id === part.id && item.craft_row !== null && item.craft_row <= part.total_rows);
  const undone = rows.filter((item) => !item.is_done).map((item) => item.craft_row as number);
  const current_row = undone.length ? Math.min(...undone) : part.total_rows + 1;
  const finished = current_row > part.total_rows;
  const ridge = part.ridges && !finished ? Math.ceil(current_row / 2) : null;
  const row_word = part.row_word === "round" ? "round" : "row";
  return {
    ...part, row_word, current_row, finished, ridge,
    row_label: finished ? "Finished" : `${row_word === "round" ? "Round" : "Row"} ${current_row}${ridge === null ? "" : ` · ridge ${ridge}`}`,
    quarter: !finished && part.quarters && part.quarter_row === current_row ? part.quarter : 0,
    done_rows: rows.filter((item) => item.is_done).length,
    row_count: rows.length,
  };
}

function sortedProgress<P extends CraftPart>(parts: P[], items: ProgressItem[]) {
  return [...parts].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).map((part) => partProgress(part, items));
}

/**
 * The stored active part while it is unfinished; once it is finished, the first unfinished part by sort
 * order (FR1, F2: the mittens' cuff done → the hand; the stored value stays until S2 writes it). With
 * every part finished, the stored part (it reads "Finished"), else none.
 */
function pickActivePart<P extends { id: string; finished: boolean }>(parts: P[], activePartId: string | null) {
  const stored = parts.find((part) => part.id === activePartId);
  if (stored && !stored.finished) return stored;
  return parts.find((part) => !part.finished) ?? stored ?? null;
}

/** 072's craft_remove_blockers keys in plain words, in its order. */
export const CRAFT_REMOVE_BLOCKER_WORDS: Record<string, string> = {
  links: "links", instructions: "instructions", notes: "notes", yarn: "yarn", timer: "a timer", gear: "gear notes",
  quarters: "quarter rows", ridges: "ridge counts", close_checks: "band checks",
  sittings: "craft screen sittings",
};
/** ["links", "notes"] → "links and notes"; unknown keys are named as "other craft details". */
export function removeBlockersText(keys: string[]): string {
  const words = [...new Set(keys.map((key) => CRAFT_REMOVE_BLOCKER_WORDS[key] ?? "other craft details"))];
  if (!words.length) return "craft details";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function buildCraftView(input: CraftInput) {
  const today = etDateOf(input.server_now);
  const parts = sortedProgress(input.parts, input.items);
  const active_part = pickActivePart(parts, input.craft_project.active_part_id);
  const segments = active_part ? input.segments.filter((segment) => segment.part_id === active_part.id)
    .sort((a, b) => a.sort_order - b.sort_order || a.from_row - b.from_row || a.id.localeCompare(b.id))
    .map((segment) => ({
      ...segment,
      state: segment.to_row < active_part.current_row ? "done" as const
        : segment.from_row <= active_part.current_row ? "current" as const : "upcoming" as const,
    })) : [];
  const current_segment = segments.find((segment) => segment.state === "current") ?? null;
  const next_segment = segments.find((segment) => segment.state === "upcoming") ?? null;
  const next_rows = active_part ? input.items.filter((item) => item.craft_part_id === active_part.id && !item.is_done
    && item.craft_row !== null && item.craft_row <= active_part.total_rows)
    .sort((a, b) => (a.craft_row as number) - (b.craft_row as number)).slice(0, 5)
    .map((item) => ({ id: item.id, row: item.craft_row as number, text: item.text })) : [];
  const partIds = new Set(parts.map((part) => part.id));
  const linkedItems = new Set(input.session_items.map((link) => link.checklist_item_id));
  // S2: the active part's rows (numbers that exist, gaps left out) for the Undo, Fix count, Log sitting and total previews.
  const row_states: RowState[] = active_part ? input.items.filter((item) => item.craft_part_id === active_part.id && item.craft_row !== null)
    .map((item) => ({ row: item.craft_row as number, done: item.is_done, linked: linkedItems.has(item.id),
      today: Boolean(item.is_done && item.completed_at && etDateOf(item.completed_at) === today) }))
    .sort((a, b) => a.row - b.row) : [];
  const timerRow = input.timer;
  const nowMs = Date.parse(input.server_now);
  const elapsed = timerRow ? timerElapsedAt(timerRow, nowMs) : 0;
  const timerFacts = timerRow ? {
    project_id: timerRow.project_id, part_id: timerRow.part_id, running: timerRow.running_since !== null, version: timerRow.version,
    sitting_started_at: timerRow.sitting_started_at, running_since: timerRow.running_since,
    paused_at: (timerRow as { paused_at?: string | null }).paused_at ?? null,
    banked_seconds: timerRow.banked_seconds, adjust_seconds: timerRow.adjust_seconds, start_row: timerRow.start_row,
    start_quarter: timerRow.start_quarter, elapsed_seconds: elapsed, long_run: elapsed >= LONG_RUN_MINUTES * 60,
    over_cap: elapsed > SITTING_MAX_MINUTES * 60, new_day: etDateOf(input.server_now) > etDateOf(timerRow.sitting_started_at),
  } satisfies CraftTimerView : null;
  const timer = timerFacts && timerFacts.project_id === input.project.id ? timerFacts : null;
  const other_timer = timerFacts && timerFacts.project_id !== input.project.id ? {
    project_id: timerFacts.project_id, project_name: input.timer_project?.name ?? "another project",
    elapsed_seconds: timerFacts.elapsed_seconds, running: timerFacts.running, version: timerFacts.version,
  } : null;
  // S2 band close (073's craft_band_check): close_check bands whose rows are all ticked and whose task isn't Done.
  const taskById = new Map((input.band_tasks ?? []).map((task) => [task.id, task]));
  const pending_checks = active_part ? segments.filter((segment) => segment.close_check && segment.task_id && taskById.get(segment.task_id)
    && taskById.get(segment.task_id)?.status !== "Done").flatMap((segment) => {
    const bandRows = row_states.filter((state) => state.row >= segment.from_row && state.row <= segment.to_row);
    if (!bandRows.length || bandRows.some((state) => !state.done)) return [];
    const check = bandCheckFor(segment.task_id as string, input.count_items ?? [], active_part.stitch_count);
    // A band whose count item is already ticked was confirmed before (the blanket's rows 1–52 at setup).
    if (check.item_id && (input.count_items ?? []).find((item) => item.id === check.item_id)?.is_done) return [];
    return [{ segment_id: segment.id, name: segment.name, from_row: segment.from_row, to_row: segment.to_row, ...check }];
  }) : [];
  const craftItems = input.items.filter((item) => item.craft_part_id && partIds.has(item.craft_part_id));
  const itemById = new Map(craftItems.map((item) => [item.id, item]));
  const recent_sittings = [...input.sessions].sort((a, b) => b.session_date.localeCompare(a.session_date)
    || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, 10).map((session) => ({
    id: session.id, date: session.session_date, minutes: session.minutes, note: session.note,
    excluded_from_stats: session.exclude_from_stats,
    rows: input.session_items.filter((link) => link.session_id === session.id).flatMap((link) => {
      const item = itemById.get(link.checklist_item_id);
      const part = parts.find((part) => part.id === item?.craft_part_id);
      return item && part && item.craft_row !== null ? [{ part_id: part.id, part_name: part.name, row_word: part.row_word, row: item.craft_row, text: item.text }] : [];
    }).sort((a, b) => a.part_name.localeCompare(b.part_name) || a.row - b.row),
    detail: input.sitting_details.find((detail) => detail.session_id === session.id) ?? null,
  }));
  return {
    project: input.project, craft: input.craft_project.craft, gear: input.craft_project.gear,
    parts, active_part, segments, current_segment, next_segment, next_rows,
    today: {
      date: today,
      rows: craftItems.filter((item) => item.is_done && item.completed_at && etDateOf(item.completed_at) === today).length,
      minutes: input.sessions.filter((session) => session.session_date === today).reduce((sum, session) => sum + session.minutes, 0),
    },
    recent_sittings, server_now: input.server_now,
    timer, other_timer, row_states, pending_checks,
    notes: [...(input.notes ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, 50),
    // Remove is offered only when the server said nothing would be lost (072 refuses otherwise too).
    can_remove: Array.isArray(input.remove_blockers) && input.remove_blockers.length === 0,
    remove_blockers: input.remove_blockers ?? null,
  };
}
export type CraftView = ReturnType<typeof buildCraftView>;

/**
 * The count to confirm when a band closes, as 073's craft_band_check reads it: the band task's first plain item
 * starting "Count" (unticked first, then sort order, then id); the number is the first number in its text, else the
 * part's stitch count.
 */
export function bandCheckFor(taskId: string, countItems: NonNullable<CraftInput["count_items"]>, stitchCount: number | null) {
  const item = countItems.filter((entry) => entry.task_id === taskId && isCountItemText(entry.text))
    .sort((a, b) => Number(a.is_done) - Number(b.is_done) || a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
  const fromText = item ? countFromCheckText(item.text) : null;
  return {
    task_id: taskId, item_id: item?.id ?? null, item_text: item?.text ?? null,
    count: fromText ?? stitchCount, count_source: fromText !== null ? "item" as const : stitchCount !== null ? "part" as const : null,
  };
}

/** One entry per craft project for the title switcher: "row 61", "round 1", "done", or null with no parts. */
export interface CraftProjectOption { id: string; name: string; craft: string; progress: string | null }
export interface CraftProjectListInput {
  craft_projects: Pick<Row<"craft_projects">, "project_id" | "craft" | "active_part_id">[];
  projects: { id: string; name: string }[];
  parts: (CraftPart & { project_id: string })[];
  /** Unticked craft rows are enough: ticked ones never change the current row. */
  items: ProgressItem[];
}
export function buildCraftProjectList(input: CraftProjectListInput): CraftProjectOption[] {
  const names = new Map(input.projects.map((project) => [project.id, project.name]));
  return input.craft_projects.flatMap((craft) => {
    const name = names.get(craft.project_id);
    if (name === undefined) return [];
    const parts = sortedProgress(input.parts.filter((part) => part.project_id === craft.project_id), input.items);
    const active = pickActivePart(parts, craft.active_part_id);
    const progress = active ? (active.finished ? "done" : `${active.row_word} ${active.current_row}`) : parts.length ? "done" : null;
    return [{ id: craft.project_id, name, craft: craft.craft, progress }];
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
/** What the craft screen and GET /api/craft return: the view plus the switcher list. */
export type CraftScreenView = CraftView & { projects: CraftProjectOption[] };
export const craftProjectHref = (projectId: string) => `/craft/${projectId}`;
export const craftProjectOptionLabel = (option: Pick<CraftProjectOption, "name" | "progress">) =>
  option.progress ? `${option.name} · ${option.progress}` : option.name;
