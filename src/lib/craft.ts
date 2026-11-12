/** Pure read model. Checklist ticks are the only source of row progress. */
import { etDateOf } from "@/lib/work-sessions/parse";
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

/** The stored active part (even when finished), else the first unfinished part by sort order. */
function pickActivePart<P extends { id: string; finished: boolean }>(parts: P[], activePartId: string | null) {
  return parts.find((part) => part.id === activePartId) ?? parts.find((part) => !part.finished) ?? null;
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
  };
}
export type CraftView = ReturnType<typeof buildCraftView>;

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
