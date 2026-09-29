// Stored brief pages (migration 055). A brief is content-as-data plus a list of
// actionable items; each item has a stable item_key so its state survives
// reruns and so Accept can use the key as the created task's external id.

import type { AcceptDueChoice } from "@/lib/briefs/due";

/** "eod" = end of day (EOD-MMDD), "am" = morning (AM-MMDD). Behavior never branches on edition. */
export const BRIEF_EDITIONS = ["eod", "am"] as const;
export type BriefEdition = (typeof BRIEF_EDITIONS)[number];

export const BRIEF_ITEM_KINDS = ["proposed_task", "carry_over", "carry_group", "choice"] as const;
export type BriefItemKind = (typeof BRIEF_ITEM_KINDS)[number];

export const BRIEF_ITEM_STATES = [
  "open",
  "accepted",
  "dismissed",
  "done",
  "deferred",
  "parked",
  "decided",
  "expired",
] as const;
export type BriefItemState = (typeof BRIEF_ITEM_STATES)[number];

export const DISMISS_REASONS = ["already_tracked", "not_mine", "not_worth_it"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const BRIEF_ACTIONS = ["accept", "dismiss", "done", "tomorrow", "park", "pick", "undo"] as const;
export type BriefAction = (typeof BRIEF_ACTIONS)[number];

/** Accepting a proposed_task creates a task with this external source system; the id is the item_key. */
export const EOD_PROPOSAL_SOURCE_SYSTEM = "eod_proposal";

export const DISMISS_NOTE_MAX = 500;

export interface BriefMeetingRef {
  /** Granola meeting id. */
  id: string;
  title: string;
  /** ISO timestamp of the meeting start. */
  start: string | null;
  url: string | null;
  /** The note line(s) the item came from. */
  lines: string[];
}

export interface BriefItemSource {
  meetings: BriefMeetingRef[];
}

export interface BriefChoiceOption {
  key: string;
  label: string;
  recommended: boolean;
}

export interface BriefItemPayload {
  title: string;
  detail?: string;
  why?: string;
  group?: string;
  /** Short kind-neutral eyebrow, e.g. "Due today" or "Tomorrow 10 AM". */
  label?: string;
  maybe_tracked?: { task_id: string; text: string };
  options?: BriefChoiceOption[];
  /**
   * proposed_task only: a due date the meeting notes themselves give
   * (YYYY-MM-DD, ET). Offered and pre-selected on Accept; never invented.
   */
  suggested_due?: string;
}

/**
 * One calendar event on the day timeline. Events without notes have no id.
 * A meeting that starts after the brief was saved is "upcoming": it draws solid,
 * and may carry a prep line and the tasks that prepare for it.
 */
export interface BriefMeeting {
  id: string | null;
  title: string;
  short: string | null;
  start: string;
  end: string | null;
  url: string | null;
  has_notes: boolean;
  /** One or two lines on how to go in (upcoming meetings). */
  prep?: string;
  /** Brent's tasks that prepare for this meeting. */
  task_ids?: string[];
}

export interface BriefStat {
  key: string;
  label: string;
  value: number;
}

export interface BriefAgendaLine {
  time: string;
  title: string;
  /** A free-time line ("Free until 10"); shown quieter. */
  free?: boolean;
  /** When set, this line shows the pick of the choice item with this n. */
  choice_n?: number;
  /**
   * Save input only: 0-based position of a choice item in the request's items.
   * The server swaps it for that item's n, since callers can't know n up front.
   */
  choice_item?: number;
}

export interface BriefTileRow {
  title: string;
  meta?: string;
  task_id?: string;
}

export interface BriefTileGroup {
  label?: string;
  rows: BriefTileRow[];
}

export const BRIEF_TILE_TYPES = ["narrative", "list"] as const;
export type BriefTileType = (typeof BRIEF_TILE_TYPES)[number];

export interface BriefTile {
  key: string;
  type: BriefTileType;
  label: string;
  value?: number;
  suffix?: string;
  summary?: string;
  text?: string;
  /** Extra ordered lines shown under the text in the sheet (e.g. first moves). */
  list?: string[];
  list_label?: string;
  groups?: BriefTileGroup[];
  footnote?: string;
  /** Link to another brief page. Only same-app /briefs/<CODE> paths survive validation. */
  href?: string;
}

export interface BriefContent {
  /** Human date line, e.g. "Thu, Sep 24". */
  heading?: string;
  narrative?: string;
  first_moves?: string[];
  /** In display order. The first one is the headline the ready notice quotes ("19 done", "9 due today"). */
  stats?: BriefStat[];
  next?: { label: string; agenda: BriefAgendaLine[] };
  meetings?: BriefMeeting[];
  tiles?: BriefTile[];
  footnote?: string;
}

export interface BriefItemInput {
  kind: BriefItemKind;
  payload: BriefItemPayload;
  task_ids: string[];
  source: BriefItemSource;
}

export interface SaveBriefInput {
  edition: BriefEdition;
  brief_date: string;
  content: BriefContent;
  covered_meeting_ids: string[];
  items: BriefItemInput[];
}

export interface BriefActionInput {
  n: number;
  action: BriefAction;
  reason: DismissReason | null;
  note: string | null;
  choice: string | null;
  /** accept only. Absent = "tomorrow". A date must equal the item's suggested_due. */
  due?: AcceptDueChoice | null;
}

export interface BriefRow {
  id: string;
  user_id: string;
  edition: string;
  brief_date: string;
  code: string;
  content: BriefContent;
  covered_meeting_ids: string[];
  notified_at: string | null;
  notify_sent_at: string | null;
  notify_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefItemRow {
  id: string;
  user_id: string;
  brief_id: string;
  n: number;
  item_key: string;
  kind: BriefItemKind;
  payload: BriefItemPayload;
  task_ids: string[];
  source: BriefItemSource;
  state: BriefItemState;
  dismissed_reason: DismissReason | null;
  dismissed_note: string | null;
  choice: string | null;
  created_task_id: string | null;
  acted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefTaskSummary {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  /** "brent" | "agent" (migration 056). */
  owner?: string | null;
}

export interface BriefCounts {
  total: number;
  open: number;
  from_meetings: number;
  calls: number;
}

export interface BriefView {
  brief: BriefRow;
  items: BriefItemRow[];
  tasks: Record<string, BriefTaskSummary>;
  counts: BriefCounts;
  url: string;
}
