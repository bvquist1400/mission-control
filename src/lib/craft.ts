/** Pure read model. Checklist ticks are the only source of row progress. */
import { etDateOf } from "@/lib/work-sessions/parse";
import { LONG_RUN_MINUTES, SITTING_MAX_MINUTES, countFromCheckText, isCountItemText, timerElapsedAt, type OtherPartRows, type RowState, type RowWord } from "@/lib/craft/actions";
import type { Database } from "@/types/supabase.generated";

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
export type CraftPart = Pick<Row<"craft_parts">, "id" | "name" | "sort_order" | "total_rows" | "row_word" | "quarters" | "quarter" | "quarter_row" | "ridges" | "stitch_count">;
export type CraftSegment = Pick<Row<"craft_segments">, "id" | "part_id" | "task_id" | "name" | "from_row" | "to_row" | "sort_order" | "close_check">;
export type CraftItem = Pick<Row<"task_checklist_items">, "id" | "craft_part_id" | "craft_row" | "text" | "is_done" | "completed_at">
  & Partial<Pick<Row<"task_checklist_items">, "unit_count" | "work_type" | "task_id" | "sort_order">>;
/** S3 FR3: a plain checklist item (no craft row) on a task that holds rows of the project's parts. */
export type CraftPlainItem = Pick<Row<"task_checklist_items">, "id" | "task_id" | "text" | "is_done" | "sort_order">;
export type CraftSession = Pick<Row<"work_sessions">, "id" | "session_date" | "created_at" | "minutes" | "note" | "exclude_from_stats">
  & Partial<Pick<Row<"work_sessions">, "exclude_reason" | "extra_units">>;
/** S3 (074): one rip-back, as the history list shows it. */
export type CraftFrog = Pick<Row<"craft_frogs">, "id" | "part_id" | "from_row" | "to_row" | "note" | "session_ids" | "created_at">;
export interface CraftInput {
  project: { id: string; name: string };
  craft_project: Pick<Row<"craft_projects">, "craft" | "gear" | "active_part_id">;
  parts: CraftPart[];
  segments: CraftSegment[];
  items: CraftItem[];
  sessions: CraftSession[];
  /** `in_progress` (074): the row was worked on in that sitting but not finished. Absent = finished. */
  session_items: (Pick<Row<"work_session_items">, "session_id" | "checklist_item_id"> & { in_progress?: boolean })[];
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
  /** S3: "Ripped back" history of the project's parts. */
  frogs?: CraftFrog[];
  /** S3 FR3: plain items on the tasks that hold the project's rows (the checks). */
  plain_items?: CraftPlainItem[];
}

/** S3: how far back the "Ripped back" sheet offers rows (the rows it lists, newest first). */
export const RIP_CHOICES = 40;

/** S3: a sitting the "Ripped back" sheet may change: all its links (part and row; null for a row of no part). */
export interface RipSitting {
  id: string; date: string; minutes: number; excluded: boolean; exclude_reason: string | null; extra_units: number;
  links: { part_id: string | null; row: number | null; in_progress: boolean }[];
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
  /** FR1: false when the timer is on another part than the screen's (that part was finished during the sitting). */
  on_active_part: boolean;
  /** S3 FR1 (074): the timer's timed seconds (no + / −) at the sitting's last Row done; null until one (or before 074). */
  last_done_seconds: number | null;
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
  sittings: "craft screen sittings", frogs: "ripped-back history",
};
/** ["links", "notes"] → "links and notes"; unknown keys are named as "other craft details". */
export function removeBlockersText(keys: string[]): string {
  const words = [...new Set(keys.map((key) => CRAFT_REMOVE_BLOCKER_WORDS[key] ?? "other craft details"))];
  if (!words.length) return "craft details";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** S3 FR3: an unticked check placed in pattern order, before the row it comes ahead of (its anchor). */
export interface CraftCheck {
  id: string; task_id: string; text: string;
  part_id: string; part_name: string; row_word: "row" | "round"; row: number;
  /** The check's own task holds another part's rows (it sits after that part's last row): name the part. */
  other_part: boolean;
}

/**
 * Checks in pattern order (FR3). A check is a plain checklist item (no craft row), not ticked, on a task holding rows of
 * the project's parts; a close_check band's "Count …" item is the band close's (S2), not a check. Its place is by the
 * task's sort order: after the task's row just before it, so it comes before the next row in pattern order (parts by
 * sort order, rows by number; the next part's first row when that row was its part's last); with no row before it on
 * its task, before the task's first row after it. A check after the project's very last row has no row to come before
 * and isn't shown.
 */
export function placeChecks(parts: { id: string; name: string; row_word: string; sort_order: number; total_rows: number }[], items: CraftItem[],
  plain: CraftPlainItem[], segments: Pick<CraftSegment, "task_id" | "close_check">[]): CraftCheck[] {
  const sortedParts = [...parts].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const partIndex = new Map(sortedParts.map((part, i) => [part.id, i]));
  const rows = items.filter((item) => item.craft_part_id && partIndex.has(item.craft_part_id) && item.craft_row !== null
    && item.craft_row <= (sortedParts[partIndex.get(item.craft_part_id) as number].total_rows))
    .sort((a, b) => (partIndex.get(a.craft_part_id as string) as number) - (partIndex.get(b.craft_part_id as string) as number) || (a.craft_row as number) - (b.craft_row as number));
  const order = new Map(rows.map((item, i) => [item.id, i]));
  const byKey = (a: { sort_order?: number | null; id: string }, b: { sort_order?: number | null; id: string }) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id);
  const byTask = new Map<string, CraftItem[]>();
  for (const item of rows) if (item.task_id) byTask.set(item.task_id, [...(byTask.get(item.task_id) ?? []), item]);
  for (const list of byTask.values()) list.sort(byKey);
  const bandTasks = new Set(segments.filter((segment) => segment.close_check && segment.task_id).map((segment) => segment.task_id as string));
  const placed: { at: number; check: CraftCheck }[] = [];
  for (const check of plain) {
    if (check.is_done || (bandTasks.has(check.task_id) && isCountItemText(check.text))) continue;
    const onTask = byTask.get(check.task_id);
    if (!onTask?.length) continue;
    const before = onTask.filter((item) => byKey(item, check) < 0).at(-1);
    const anchor = before ? rows[(order.get(before.id) as number) + 1] : onTask.find((item) => byKey(item, check) > 0);
    if (!anchor) continue;
    const own = (before ?? anchor).craft_part_id as string;
    const part = sortedParts[partIndex.get(anchor.craft_part_id as string) as number];
    placed.push({ at: order.get(anchor.id) as number, check: { id: check.id, task_id: check.task_id, text: check.text, part_id: part.id, part_name: part.name,
      row_word: part.row_word === "round" ? "round" : "row", row: anchor.craft_row as number, other_part: own !== part.id } });
  }
  return placed.sort((a, b) => a.at - b.at || (a.check.other_part === b.check.other_part ? 0 : a.check.other_part ? -1 : 1) || a.check.id.localeCompare(b.check.id))
    .map((entry) => entry.check);
}

/**
 * Upcoming rows with the checks that come before them (FR3), so a check is seen a row ahead: each check just before its
 * row; checks before the next part's first row last.
 */
export type UpcomingEntry = { kind: "row"; id: string; row: number; text: string } | { kind: "check"; check: CraftCheck };
export function upcomingWithChecks(rows: { id: string; row: number; text: string }[], checks: CraftCheck[], partId: string): UpcomingEntry[] {
  const out: UpcomingEntry[] = [];
  for (const row of rows) {
    for (const check of checks) if (check.part_id === partId && check.row === row.row) out.push({ kind: "check", check });
    out.push({ kind: "row", ...row });
  }
  for (const check of checks) if (check.part_id !== partId) out.push({ kind: "check", check });
  return out;
}

/** "Before Round 25:", "Before Round 1 (Thumb gusset):" (FR3). */
export const checkBeforeText = (check: Pick<CraftCheck, "row_word" | "row" | "other_part" | "part_name">) =>
  `Before ${check.row_word === "round" ? "Round" : "Row"} ${check.row}${check.other_part ? ` (${check.part_name})` : ""}:`;

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
  // 074: "linked" = finished in a sitting; a row in progress somewhere is shown and counted apart.
  const linkedItems = new Set(input.session_items.filter((link) => !link.in_progress).map((link) => link.checklist_item_id));
  const inProgressItems = new Set(input.session_items.filter((link) => link.in_progress).map((link) => link.checklist_item_id));
  const timerRow = input.timer;
  // FR1: "ticked since this project's timer sitting started" (073 compares completed_at with sitting_started_at).
  const sittingStartMs = timerRow && timerRow.project_id === input.project.id ? Date.parse(timerRow.sitting_started_at) : null;
  const sinceTimer = (item: CraftItem) => sittingStartMs !== null && item.is_done && Boolean(item.completed_at) && Date.parse(item.completed_at as string) >= sittingStartMs;
  // S2: the active part's rows (numbers that exist, gaps left out) for the Undo, Fix count, Log sitting and total previews.
  const rowStatesOf = (partId: string): RowState[] => input.items.filter((item) => item.craft_part_id === partId && item.craft_row !== null)
    .map((item) => ({ row: item.craft_row as number, done: item.is_done, linked: linkedItems.has(item.id), in_progress: inProgressItems.has(item.id),
      today: Boolean(item.is_done && item.completed_at && etDateOf(item.completed_at) === today),
      since_timer: sinceTimer(item), done_at: item.is_done ? item.completed_at : null, units: item.unit_count ?? null, type: item.work_type ?? null, text: item.text }))
    .sort((a, b) => a.row - b.row);
  const row_states: RowState[] = active_part ? rowStatesOf(active_part.id) : [];
  // S3 FR3: every part's rows, for Change total… on any part (the Parts list), finished ones too.
  const part_rows: Record<string, RowState[]> = Object.fromEntries(parts.map((part) => [part.id, part.id === active_part?.id ? row_states : rowStatesOf(part.id)]));
  const checks = placeChecks(parts, input.items, input.plain_items ?? [], input.segments);
  // A check shows as a card once its row is reached on the screen's part: before the current row, or passed by Fix count.
  const due_checks = active_part && !active_part.finished ? checks.filter((check) => check.part_id === active_part.id && check.row <= active_part.current_row) : [];
  // Checks coming up: on rows after the current one, and before the next part's first row once this part's last few rows are left.
  const nextPart = active_part ? parts.slice(parts.findIndex((part) => part.id === active_part.id) + 1).find((part) => part.row_count > 0) : undefined;
  const rowsLeft = active_part ? row_states.filter((state) => !state.done && state.row <= active_part.total_rows).length : 0;
  const upcoming_checks = active_part && !active_part.finished ? checks.filter((check) => (check.part_id === active_part.id && check.row > active_part.current_row)
    || (nextPart !== undefined && rowsLeft <= 3 && check.part_id === nextPart.id && check.row === Math.min(...(part_rows[nextPart.id] ?? []).map((state) => state.row)))) : [];
  const work_types = [...new Set(input.items.filter((item) => item.craft_part_id && partIds.has(item.craft_part_id) && item.work_type).map((item) => item.work_type as string))].sort();
  const nowMs = Date.parse(input.server_now);
  const elapsed = timerRow ? timerElapsedAt(timerRow, nowMs) : 0;
  const timerFacts = timerRow ? {
    project_id: timerRow.project_id, part_id: timerRow.part_id, running: timerRow.running_since !== null, version: timerRow.version,
    sitting_started_at: timerRow.sitting_started_at, running_since: timerRow.running_since,
    paused_at: (timerRow as { paused_at?: string | null }).paused_at ?? null,
    banked_seconds: timerRow.banked_seconds, adjust_seconds: timerRow.adjust_seconds, start_row: timerRow.start_row,
    start_quarter: timerRow.start_quarter, elapsed_seconds: elapsed, long_run: elapsed >= LONG_RUN_MINUTES * 60,
    over_cap: elapsed > SITTING_MAX_MINUTES * 60,
    new_day: Boolean(timerRow.sitting_started_at) && etDateOf(input.server_now) > etDateOf(timerRow.sitting_started_at),
    on_active_part: !timerRow.part_id || !active_part || timerRow.part_id === active_part.id || !parts.some((p) => p.id === timerRow.part_id),
    last_done_seconds: (timerRow as { last_done_seconds?: number | null }).last_done_seconds ?? null,
  } satisfies CraftTimerView : null;
  const timer = timerFacts && timerFacts.project_id === input.project.id ? timerFacts : null;
  // S3: the sitting's last Row done on any of this project's parts (the "Partway through" default).
  const timer_last_done_at = timer ? input.items.filter((item) => item.craft_part_id && partIds.has(item.craft_part_id) && sinceTimer(item))
    .map((item) => item.completed_at as string).reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null) : null;
  // FR1: a timed sitting whose timer is on another part also saves that part's rows from its start row
  // (ticked, in no sitting) and, for parts between it and the screen's part, rows ticked since the
  // sitting started (in no sitting): the same rule as 073's craft_log_sitting, for the preview.
  const timer_rows: OtherPartRows[] = [];
  if (timer && !timer.on_active_part && active_part) {
    const from = parts.findIndex((p) => p.id === timer.part_id), to = parts.findIndex((p) => p.id === active_part.id);
    const rowsOf = (partId: string, keep: (item: CraftItem) => boolean) => input.items
      .filter((item) => item.craft_part_id === partId && item.craft_row !== null && item.is_done && !linkedItems.has(item.id) && keep(item))
      .map((item) => item.craft_row as number).sort((a, b) => a - b);
    const word = (p: (typeof parts)[number]): RowWord => (p.row_word === "round" ? "round" : "row");
    const tp = parts[from];
    timer_rows.push({ part_id: tp.id, name: tp.name, word: word(tp), rows: rowsOf(tp.id, (item) => (item.craft_row as number) >= timer.start_row) });
    for (let i = from + 1; i < to; i++) timer_rows.push({ part_id: parts[i].id, name: parts[i].name, word: word(parts[i]), rows: rowsOf(parts[i].id, sinceTimer) });
  }
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
  const linkRows = (sessionId: string, inProgress: boolean) => input.session_items
    .filter((link) => link.session_id === sessionId && Boolean(link.in_progress) === inProgress).flatMap((link) => {
      const item = itemById.get(link.checklist_item_id);
      const part = parts.find((part) => part.id === item?.craft_part_id);
      return item && part && item.craft_row !== null ? [{ part_id: part.id, part_name: part.name, row_word: part.row_word, row: item.craft_row, text: item.text }] : [];
    }).sort((a, b) => a.part_name.localeCompare(b.part_name) || a.row - b.row);
  const recent_sittings = [...input.sessions].sort((a, b) => b.session_date.localeCompare(a.session_date)
    || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, 10).map((session) => ({
    id: session.id, date: session.session_date, minutes: session.minutes, note: session.note,
    excluded_from_stats: session.exclude_from_stats, exclude_reason: session.exclude_reason ?? null,
    rows: linkRows(session.id, false),
    /** S3: rows worked on in this sitting but not finished ("part of row 63"). */
    in_progress_rows: linkRows(session.id, true),
    detail: input.sitting_details.find((detail) => detail.session_id === session.id) ?? null,
  }));
  // S3 "Ripped back": the sittings that link the active part's rows the sheet can rip (the last
  // RIP_CHOICES ticked rows below the current row, and the current row), each with all its links, so
  // the sheet can tell all-ripped sittings from partly ripped ones before saving.
  const ripLow = active_part ? (row_states.filter((state) => state.done && state.row < active_part.current_row)
    .map((state) => state.row).sort((a, b) => b - a)[RIP_CHOICES - 1] ?? 1) : 1;
  const ripItems = new Set(active_part ? input.items.filter((item) => item.craft_part_id === active_part.id && item.craft_row !== null
    && item.craft_row >= ripLow && item.craft_row <= active_part.current_row).map((item) => item.id) : []);
  const ripSessionIds = new Set(input.session_items.filter((link) => ripItems.has(link.checklist_item_id)).map((link) => link.session_id));
  const rip_sittings: RipSitting[] = input.sessions.filter((session) => ripSessionIds.has(session.id))
    .sort((a, b) => b.session_date.localeCompare(a.session_date) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .map((session) => ({
      id: session.id, date: session.session_date, minutes: session.minutes, excluded: session.exclude_from_stats,
      exclude_reason: session.exclude_reason ?? null, extra_units: Number(session.extra_units ?? 0) || 0,
      links: input.session_items.filter((link) => link.session_id === session.id).flatMap((link): RipSitting["links"] => {
        const item = itemById.get(link.checklist_item_id);
        return item?.craft_part_id && item.craft_row !== null
          ? [{ part_id: item.craft_part_id, row: item.craft_row, in_progress: Boolean(link.in_progress) }]
          : [{ part_id: null, row: null, in_progress: Boolean(link.in_progress) }];
      }),
    }));
  const partById = new Map(parts.map((part) => [part.id, part]));
  const frogs = [...(input.frogs ?? [])].filter((frog) => partById.has(frog.part_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, 20).map((frog) => ({
      id: frog.id, part_id: frog.part_id, part_name: partById.get(frog.part_id)?.name ?? "",
      row_word: partById.get(frog.part_id)?.row_word ?? "row", from_row: frog.from_row, to_row: frog.to_row,
      note: frog.note, created_at: frog.created_at, sittings_left_out: frog.session_ids.length,
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
    timer, other_timer, row_states, pending_checks, timer_rows, timer_last_done_at, rip_sittings, frogs,
    // S3 FR3: checks in pattern order, the ones due on the screen's part, every part's rows, the work types in use.
    checks, due_checks, upcoming_checks, part_rows, work_types,
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
