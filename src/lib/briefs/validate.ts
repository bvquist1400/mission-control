import { normalizeDateOnly } from "@/lib/date-only";
import { todayInBriefTimeZone } from "@/lib/briefs/keys";
import { ACCEPT_DUE_HELP, isDateOnlyString, parseAcceptDue, type AcceptDueChoice } from "@/lib/briefs/due";
import { safeBriefHref } from "@/lib/briefs/href";
import { capIdentifier, capText, collectSaveWarnings } from "@/lib/briefs/text-cut";

export { safeBriefHref };
import {
  BRIEF_ACTIONS,
  BRIEF_EDITIONS,
  BRIEF_ITEM_KINDS,
  BRIEF_TILE_TYPES,
  DISMISS_NOTE_MAX,
  DISMISS_REASONS,
  type BriefAction,
  type BriefActionInput,
  type BriefAgendaLine,
  type BriefChoiceOption,
  type BriefContent,
  type BriefEdition,
  type BriefItemInput,
  type BriefItemKind,
  type BriefItemPayload,
  type BriefMeeting,
  type BriefMeetingRef,
  type BriefRefresh,
  type BriefStat,
  type BriefTile,
  type BriefTileGroup,
  type BriefTileRow,
  type BriefWorkDigestRef,
  type DismissReason,
  type SaveBriefInput,
} from "@/lib/briefs/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ITEMS = 60;
const MAX_CONTENT_CHARS = 200_000;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The footnote cap, on the page and on a tile (was 500; AM-1103's was cut mid-sentence at 500). */
export const FOOTNOTE_MAX = 1200;
/** A refresh's one-line reason ("AM digest added"). */
export const REFRESH_REASON_MAX = 200;

/**
 * Prose: trimmed, and over `max` cut at the last sentence end (else word
 * boundary) with "…". Inside a save's parse the cut is reported as a warning
 * naming `field`; nothing is cut mid-word or silently.
 */
function str(value: unknown, max: number, field: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return capText(trimmed, max, field);
}

/** Ids, keys, links and times: cut short as before (no "…"), but reported like prose. */
function ident(value: unknown, max: number, field: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return capIdentifier(trimmed, max, field);
}

/** Only http(s) links are ever rendered as hrefs. */
export function safeUrl(value: unknown, field = "url"): string | null {
  const raw = ident(value, 1000, field);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The first `maxItems` usable strings (later ones are left out before they are capped, so no warning names a dropped entry). */
function listOf(value: unknown, maxItems: number, read: (item: unknown, index: number) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let index = 0; index < value.length && out.length < maxItems; index += 1) {
    const item = read(value[index], index);
    if (item !== null) out.push(item);
  }
  return out;
}

function strList(value: unknown, maxItems: number, maxLen: number, field: string): string[] {
  return listOf(value, maxItems, (item, index) => str(item, maxLen, `${field}[${index}]`));
}

function identList(value: unknown, maxItems: number, maxLen: number, field: string): string[] {
  return listOf(value, maxItems, (item, index) => ident(item, maxLen, `${field}[${index}]`));
}

function isoOrNull(value: unknown, field = "time"): string | null {
  const raw = ident(value, 60, field);
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}


// ---------------------------------------------------------------------------
// Content: tolerant. Unknown or malformed fields are dropped, never rejected,
// so a slightly-off model output still renders. Used on save and on read.
// ---------------------------------------------------------------------------

/** The first `max` entries `read` accepts; later entries are never read, so no warning names one that was left out. */
function takeFirst<T>(value: unknown[], max: number, read: (item: unknown, index: number) => T | null): T[] {
  const out: T[] = [];
  for (let index = 0; index < value.length && out.length < max; index += 1) {
    const item = read(value[index], index);
    if (item !== null) out.push(item);
  }
  return out;
}

function normalizeMeeting(value: unknown, path: string): BriefMeeting | null {
  if (!isObject(value)) return null;
  const title = str(value.title, 300, `${path}.title`);
  const start = isoOrNull(value.start, `${path}.start`);
  if (!title || !start) return null;
  const id = ident(value.id, 200, `${path}.id`);
  const meeting: BriefMeeting = {
    id,
    title,
    short: str(value.short, 80, `${path}.short`),
    start,
    end: isoOrNull(value.end, `${path}.end`),
    url: safeUrl(value.url, `${path}.url`),
    has_notes: typeof value.has_notes === "boolean" ? value.has_notes : id !== null,
  };
  // Optional, and only present when given, so content without them round-trips unchanged.
  const prep = str(value.prep, 1000, `${path}.prep`);
  if (prep) meeting.prep = prep;
  if (Array.isArray(value.task_ids)) {
    const taskIds = [...new Set(value.task_ids.filter(isUuid).map((taskId) => taskId.toLowerCase()))].slice(0, 20);
    if (taskIds.length) meeting.task_ids = taskIds;
  }
  return meeting;
}

function normalizeTileRow(value: unknown, path: string): BriefTileRow | null {
  if (typeof value === "string") {
    const title = str(value, 500, `${path}.title`);
    return title ? { title } : null;
  }
  if (!isObject(value)) return null;
  const title = str(value.title, 500, `${path}.title`);
  if (!title) return null;
  const row: BriefTileRow = { title };
  const meta = str(value.meta, 500, `${path}.meta`);
  if (meta) row.meta = meta;
  if (isUuid(value.task_id)) row.task_id = value.task_id.toLowerCase();
  return row;
}

function normalizeTile(value: unknown, path: string): BriefTile | null {
  if (!isObject(value)) return null;
  const key = ident(value.key, 40, `${path}.key`);
  const label = str(value.label, 80, `${path}.label`);
  const type = (BRIEF_TILE_TYPES as readonly string[]).includes(String(value.type)) ? (value.type as BriefTile["type"]) : "list";
  if (!key || !label) return null;
  const tile: BriefTile = { key, type, label };
  if (typeof value.value === "number" && Number.isFinite(value.value)) tile.value = value.value;
  const suffix = str(value.suffix, 40, `${path}.suffix`);
  if (suffix) tile.suffix = suffix;
  const summary = str(value.summary, 300, `${path}.summary`);
  if (summary) tile.summary = summary;
  const text = str(value.text, 4000, `${path}.text`);
  if (text) tile.text = text;
  const list = strList(value.list, 12, 1000, `${path}.list`);
  if (list.length) tile.list = list;
  const listLabel = str(value.list_label, 80, `${path}.list_label`);
  if (listLabel) tile.list_label = listLabel;
  if (Array.isArray(value.groups)) {
    const groups = takeFirst(value.groups, 8, (group, groupIndex): BriefTileGroup | null => {
      if (!isObject(group)) return null;
      const groupPath = `${path}.groups[${groupIndex}]`;
      const rows = Array.isArray(group.rows)
        ? takeFirst(group.rows, 60, (row, rowIndex) => normalizeTileRow(row, `${groupPath}.rows[${rowIndex}]`))
        : [];
      if (!rows.length) return null;
      const groupLabel = str(group.label, 120, `${groupPath}.label`);
      return groupLabel ? { label: groupLabel, rows } : { rows };
    });
    if (groups.length) tile.groups = groups;
  }
  const footnote = str(value.footnote, FOOTNOTE_MAX, `${path}.footnote`);
  if (footnote) tile.footnote = footnote;
  const href = safeBriefHref(value.href);
  if (href) tile.href = href;
  return tile;
}

/** How many refreshes a brief keeps a record of on the page (all of them are in brief_revisions). */
export const MAX_REFRESH_RECORDS = 20;

/** content.refreshes as stored (server-written; a read drops anything malformed). */
function normalizeRefreshes(value: unknown): BriefRefresh[] {
  if (!Array.isArray(value)) return [];
  const out: BriefRefresh[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))) continue;
    const reason = str(entry.reason, REFRESH_REASON_MAX, "content.refreshes.reason");
    out.push(reason ? { at: entry.at, reason } : { at: entry.at });
  }
  return out.slice(-MAX_REFRESH_RECORDS);
}

export function normalizeBriefContent(value: unknown): BriefContent {
  if (!isObject(value)) return {};
  const content: BriefContent = {};
  const heading = str(value.heading, 80, "content.heading");
  if (heading) content.heading = heading;
  const narrative = str(value.narrative, 4000, "content.narrative");
  if (narrative) content.narrative = narrative;
  const moves = strList(value.first_moves, 8, 1000, "content.first_moves");
  if (moves.length) content.first_moves = moves;
  if (Array.isArray(value.stats)) {
    const stats = takeFirst(value.stats, 6, (stat, index): BriefStat | null => {
      if (!isObject(stat)) return null;
      if (typeof stat.value !== "number" || !Number.isFinite(stat.value)) return null;
      const key = ident(stat.key, 40, `content.stats[${index}].key`);
      const label = str(stat.label, 40, `content.stats[${index}].label`);
      if (!key || !label) return null;
      return { key, label, value: stat.value };
    });
    if (stats.length) content.stats = stats;
  }
  if (isObject(value.next)) {
    const label = str(value.next.label, 80, "content.next.label");
    const agenda = Array.isArray(value.next.agenda)
      ? takeFirst(value.next.agenda, 12, (line, index): BriefAgendaLine | null => {
          if (!isObject(line)) return null;
          const time = ident(line.time, 12, `content.next.agenda[${index}].time`);
          const title = str(line.title, 200, `content.next.agenda[${index}].title`);
          if (!time || !title) return null;
          const out: BriefAgendaLine = { time, title };
          if (line.free === true) out.free = true;
          if (Number.isInteger(line.choice_n) && (line.choice_n as number) > 0) out.choice_n = line.choice_n as number;
          if (Number.isInteger(line.choice_item) && (line.choice_item as number) >= 0) out.choice_item = line.choice_item as number;
          return out;
        })
      : [];
    if (label) content.next = { label, agenda };
  }
  if (Array.isArray(value.meetings)) {
    const meetings = takeFirst(value.meetings, 30, (meeting, index) => normalizeMeeting(meeting, `content.meetings[${index}]`));
    if (meetings.length) content.meetings = meetings;
  }
  if (Array.isArray(value.tiles)) {
    const tiles = takeFirst(value.tiles, 12, (tile, index) => normalizeTile(tile, `content.tiles[${index}]`));
    if (tiles.length) content.tiles = tiles;
  }
  const footnote = str(value.footnote, FOOTNOTE_MAX, "content.footnote");
  if (footnote) content.footnote = footnote;
  if (Array.isArray(value.work_digest_note_ids)) {
    const noteIds = [...new Set(value.work_digest_note_ids.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, MAX_DIGEST_NOTES);
    if (noteIds.length) content.work_digest_note_ids = noteIds;
  }
  if (Number.isSafeInteger(value.unblock_stuck) && (value.unblock_stuck as number) > 0) {
    content.unblock_stuck = value.unblock_stuck as number;
  }
  const refreshes = normalizeRefreshes(value.refreshes);
  if (refreshes.length) content.refreshes = refreshes;
  return content;
}

// ---------------------------------------------------------------------------
// Work digest citations (source.work_digest)
// ---------------------------------------------------------------------------

/** A brief reads at most today's AM and PM notes; a little room for a hand-made copy. */
const MAX_DIGEST_NOTES = 4;
const MAX_DIGEST_BLOCKS = 5;
const DIGEST_BLOCK_PATTERN = /^W(?:[1-9]|1[0-9]|20)$/;

/**
 * A stored or incoming source.work_digest, cleaned the same way on save and on
 * read. Returns the errors for a save; a read just drops a bad one.
 */
export function parseWorkDigestRef(value: unknown, path: string, errors: string[]): BriefWorkDigestRef | null {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const before = errors.length;
  if (!isUuid(value.note_id)) errors.push(`${path}.note_id must be the work digest note's UUID`);
  const edition = typeof value.edition === "string" ? value.edition.trim().toLowerCase() : "";
  if (edition !== "am" && edition !== "pm") errors.push(`${path}.edition must be am or pm`);

  const rawBlocks = Array.isArray(value.blocks) ? value.blocks : [];
  const blocks = [...new Set(rawBlocks.map((block) => (typeof block === "string" ? block.trim().toUpperCase() : "")))];
  if (blocks.length === 0 || blocks.length > MAX_DIGEST_BLOCKS) errors.push(`${path}.blocks must list 1 to ${MAX_DIGEST_BLOCKS} W blocks, e.g. ["W3"]`);
  if (blocks.some((block) => !DIGEST_BLOCK_PATTERN.test(block))) errors.push(`${path}.blocks entries must be W1 to W20`);

  const rawLines = value.lines ?? (value.line !== undefined ? [value.line] : []);
  const lines = strList(rawLines, MAX_DIGEST_BLOCKS, 1000, `${path}.lines`);
  if (lines.length === 0) errors.push(`${path}.lines must give each cited block's what line, verbatim`);

  if (errors.length > before) return null;
  const ref: BriefWorkDigestRef = { note_id: (value.note_id as string).toLowerCase(), edition: edition as "am" | "pm", blocks, lines };
  if (isDateOnlyString(value.date)) ref.date = value.date;
  const where = ident(value.where, 20, `${path}.where`);
  if (where && ["Mail", "Teams", "Mail and Teams"].includes(where)) ref.where = where;
  return ref;
}

/** The stored source.work_digest of an item read back from the database, or undefined when it's absent or malformed. */
export function normalizeStoredWorkDigestRef(value: unknown): BriefWorkDigestRef | undefined {
  if (value === undefined || value === null) return undefined;
  return parseWorkDigestRef(value, "source.work_digest", []) ?? undefined;
}

// ---------------------------------------------------------------------------
// Items: strict. A bad item is a routine bug the caller should see.
// ---------------------------------------------------------------------------

function parseMeetingRef(value: unknown, path: string, errors: string[]): BriefMeetingRef | null {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (typeof value.id === "string" && value.id.trim().length > 200) errors.push(`${path}.id must be 200 characters or fewer`);
  const id = ident(value.id, 200, `${path}.id`);
  const title = str(value.title, 300, `${path}.title`);
  if (!id) errors.push(`${path}.id is required`);
  if (!title) errors.push(`${path}.title is required`);
  if (!id || !title) return null;
  return {
    id,
    title,
    start: isoOrNull(value.start, `${path}.start`),
    url: safeUrl(value.url, `${path}.url`),
    lines: strList(value.lines ?? (value.line !== undefined ? [value.line] : []), 10, 1000, `${path}.lines`),
  };
}

function parseOptions(value: unknown, path: string, errors: string[]): BriefChoiceOption[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) {
    errors.push(`${path} must list 2 to 6 options`);
    return [];
  }
  const options: BriefChoiceOption[] = [];
  value.forEach((option, index) => {
    if (!isObject(option)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    const key = typeof option.key === "string" ? option.key.trim().toLowerCase() : "";
    const label = str(option.label, 200, `${path}[${index}].label`);
    if (!CHOICE_KEY_PATTERN.test(key)) errors.push(`${path}[${index}].key must match ${CHOICE_KEY_PATTERN}`);
    if (!label) errors.push(`${path}[${index}].label is required`);
    if (options.some((existing) => existing.key === key)) errors.push(`${path}[${index}].key "${key}" is repeated`);
    if (CHOICE_KEY_PATTERN.test(key) && label) {
      options.push({ key, label, recommended: option.recommended === true });
    }
  });
  return options;
}

function parseTaskIds(value: unknown, path: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of task UUIDs`);
    return [];
  }
  const ids: string[] = [];
  value.forEach((id, index) => {
    if (!isUuid(id)) errors.push(`${path}[${index}] is not a task UUID`);
    else ids.push(id.toLowerCase());
  });
  return [...new Set(ids)];
}

function parseItem(value: unknown, index: number, errors: string[]): BriefItemInput | null {
  const path = `items[${index}]`;
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const before = errors.length;
  const kind = value.kind as BriefItemKind;
  if (!(BRIEF_ITEM_KINDS as readonly string[]).includes(String(value.kind))) {
    errors.push(`${path}.kind must be one of ${BRIEF_ITEM_KINDS.join(", ")}`);
    return null;
  }

  const title = str(value.title, 500, `${path}.title`);
  if (!title) errors.push(`${path}.title is required`);
  if (typeof value.title === "string" && value.title.trim().length > 500) errors.push(`${path}.title must be 500 characters or fewer`);

  const payload: BriefItemPayload = { title: title ?? "" };
  const detail = str(value.detail, 4000, `${path}.detail`);
  if (detail) payload.detail = detail;
  const why = str(value.why, 1000, `${path}.why`);
  if (why) payload.why = why;
  const group = str(value.group, 80, `${path}.group`);
  if (group) payload.group = group;
  const label = str(value.label, 80, `${path}.label`);
  if (label) payload.label = label;

  // Optional, proposals only: a date the notes give. A malformed one is a routine bug, so it's rejected, not dropped.
  if (value.suggested_due !== undefined && value.suggested_due !== null) {
    if (kind !== "proposed_task") errors.push(`${path}.suggested_due only applies to a proposed_task`);
    else if (!isDateOnlyString(value.suggested_due)) errors.push(`${path}.suggested_due must be a real date written YYYY-MM-DD`);
    else payload.suggested_due = value.suggested_due;
  }

  const taskIds = parseTaskIds(value.task_ids, `${path}.task_ids`, errors);

  const rawSource = isObject(value.source) ? value.source : {};
  const rawMeetings = Array.isArray(rawSource.meetings) ? rawSource.meetings : [];
  if (rawMeetings.length > 10) errors.push(`${path}.source.meetings allows at most 10 meetings`);
  const meetings = rawMeetings
    .slice(0, 10)
    .map((meeting, meetingIndex) => parseMeetingRef(meeting, `${path}.source.meetings[${meetingIndex}]`, errors))
    .filter((meeting): meeting is BriefMeetingRef => meeting !== null);

  let workDigest: BriefWorkDigestRef | null = null;
  if (rawSource.work_digest !== undefined && rawSource.work_digest !== null) {
    if (kind !== "proposed_task") errors.push(`${path}.source.work_digest only applies to a proposed_task`);
    else workDigest = parseWorkDigestRef(rawSource.work_digest, `${path}.source.work_digest`, errors);
  }

  if (value.maybe_tracked !== undefined && value.maybe_tracked !== null) {
    const maybe = value.maybe_tracked;
    if (!isObject(maybe) || !isUuid(maybe.task_id)) {
      errors.push(`${path}.maybe_tracked.task_id must be a task UUID`);
    } else {
      payload.maybe_tracked = { task_id: maybe.task_id.toLowerCase(), text: str(maybe.text, 500, `${path}.maybe_tracked.text`) ?? "" };
    }
  }

  switch (kind) {
    case "proposed_task":
      if (meetings.length === 0 && !workDigest && (rawSource.work_digest === undefined || rawSource.work_digest === null)) {
        errors.push(`${path}: a proposed_task must cite at least one meeting in source.meetings or a work digest item in source.work_digest`);
      }
      if (taskIds.length) errors.push(`${path}: a proposed_task has no task_ids (it creates its task on Accept)`);
      break;
    case "carry_over":
      if (taskIds.length !== 1) errors.push(`${path}: a carry_over needs exactly one task_id`);
      break;
    case "carry_group":
      if (taskIds.length < 2 || taskIds.length > 50) errors.push(`${path}: a carry_group needs 2 to 50 task_ids`);
      break;
    case "choice":
      payload.options = parseOptions(value.options, `${path}.options`, errors);
      if (taskIds.length) errors.push(`${path}: a choice has no task_ids`);
      break;
  }

  if (errors.length > before) return null;
  return { kind, payload, task_ids: taskIds, source: workDigest ? { meetings, work_digest: workDigest } : { meetings } };
}

/** The save modes: "append" is the default (no `mode`); "refresh" rewrites the brief's content and keeps its items. */
export const SAVE_BRIEF_MODES = ["refresh"] as const;

/**
 * A save's input, checked. Text over its cap is cut at a sentence or word
 * boundary with "…" and listed in `warnings` (field, original length), which
 * the save result passes back; nothing is cut silently.
 */
export function parseSaveBriefInput(raw: unknown, now: Date = new Date()): ParseResult<SaveBriefInput> {
  const { value, warnings } = collectSaveWarnings(() => parseSaveBriefInputFields(raw, now));
  if (!value.ok) return value;
  return { ok: true, value: { ...value.value, warnings } };
}

function parseSaveBriefInputFields(raw: unknown, now: Date): ParseResult<SaveBriefInput> {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["body must be a JSON object"] };

  const edition = (typeof raw.edition === "string" ? raw.edition.trim().toLowerCase() : "eod") as BriefEdition;
  if (!(BRIEF_EDITIONS as readonly string[]).includes(edition)) {
    errors.push(`edition must be one of ${BRIEF_EDITIONS.join(", ")}`);
  }

  let briefDate = todayInBriefTimeZone(now);
  if (raw.date !== undefined && raw.date !== null) {
    const normalized = typeof raw.date === "string" ? normalizeDateOnly(raw.date) : null;
    if (!normalized) errors.push("date must be YYYY-MM-DD");
    else briefDate = normalized;
  }

  // Absent (or null / "") = the default save: create, or append to a same-day brief.
  let mode: SaveBriefInput["mode"];
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== "") {
    const given = typeof raw.mode === "string" ? raw.mode.trim().toLowerCase() : "";
    if ((SAVE_BRIEF_MODES as readonly string[]).includes(given)) mode = given as SaveBriefInput["mode"];
    else errors.push(`mode must be "refresh", or left out for a normal save`);
  }
  let refreshReason: string | null = null;
  if (raw.refresh_reason !== undefined && raw.refresh_reason !== null && raw.refresh_reason !== "") {
    if (typeof raw.refresh_reason !== "string") errors.push("refresh_reason must be a short line of text");
    else if (mode !== "refresh") errors.push(`refresh_reason only applies with mode "refresh"`);
    else refreshReason = str(raw.refresh_reason, REFRESH_REASON_MAX, "refresh_reason");
  }

  if (raw.content !== undefined && !isObject(raw.content)) errors.push("content must be an object");
  if (isObject(raw.content) && JSON.stringify(raw.content).length > MAX_CONTENT_CHARS) {
    errors.push(`content must be under ${MAX_CONTENT_CHARS} characters of JSON`);
  }

  if (raw.covered_meeting_ids !== undefined && !Array.isArray(raw.covered_meeting_ids)) {
    errors.push("covered_meeting_ids must be an array of meeting ids");
  }
  const covered = identList(raw.covered_meeting_ids, 100, 200, "covered_meeting_ids");

  if (!Array.isArray(raw.items)) errors.push("items must be an array");
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length > MAX_ITEMS) errors.push(`items allows at most ${MAX_ITEMS} entries`);
  const items = rawItems
    .slice(0, MAX_ITEMS)
    .map((item, index) => parseItem(item, index, errors))
    .filter((item): item is BriefItemInput => item !== null);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      edition,
      brief_date: briefDate,
      content: normalizeBriefContent(raw.content),
      covered_meeting_ids: [...new Set(covered)],
      items,
      ...(mode ? { mode } : {}),
      ...(mode === "refresh" ? { refresh_reason: refreshReason } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function normalizeDismissReason(value: unknown): DismissReason | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (DISMISS_REASONS as readonly string[]).includes(normalized) ? (normalized as DismissReason) : null;
}

export function parseBriefActions(raw: unknown): ParseResult<BriefActionInput[]> {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, errors: ["actions must be a non-empty array"] };
  if (raw.length > MAX_ITEMS) return { ok: false, errors: [`actions allows at most ${MAX_ITEMS} entries`] };

  const seen = new Set<number>();
  const actions: BriefActionInput[] = [];
  raw.forEach((entry, index) => {
    const path = `actions[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const n = entry.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      errors.push(`${path}.n must be a positive integer`);
      return;
    }
    if (seen.has(n)) {
      errors.push(`${path}: #${n} appears more than once`);
      return;
    }
    seen.add(n);

    const action = typeof entry.action === "string" ? (entry.action.trim().toLowerCase() as BriefAction) : null;
    if (!action || !(BRIEF_ACTIONS as readonly string[]).includes(action)) {
      errors.push(`${path}.action must be one of ${BRIEF_ACTIONS.join(", ")}`);
      return;
    }

    let reason: DismissReason | null = null;
    if (entry.reason !== undefined && entry.reason !== null && entry.reason !== "") {
      reason = normalizeDismissReason(entry.reason);
      if (!reason) errors.push(`${path}.reason must be one of ${DISMISS_REASONS.join(", ")}`);
    }

    let note: string | null = null;
    if (entry.note !== undefined && entry.note !== null) {
      if (typeof entry.note !== "string") errors.push(`${path}.note must be a string`);
      else {
        note = entry.note.trim() || null;
        if (note && note.length > DISMISS_NOTE_MAX) errors.push(`${path}.note must be ${DISMISS_NOTE_MAX} characters or fewer`);
      }
    }

    let choice: string | null = null;
    if (entry.choice !== undefined && entry.choice !== null) {
      choice = typeof entry.choice === "string" ? entry.choice.trim().toLowerCase() || null : null;
      if (!choice) errors.push(`${path}.choice must be an option key`);
    }

    if (action === "dismiss" && !reason && !note) {
      errors.push(`${path}: dismiss needs a reason (${DISMISS_REASONS.join(", ")}) or a note`);
    }
    if (action === "pick" && !choice) errors.push(`${path}: pick needs a choice`);

    // Accept's due choice. Absent = the default ("tomorrow"); present must be valid, and only on accept.
    let due: AcceptDueChoice | undefined;
    if (entry.due !== undefined) {
      if (action !== "accept") errors.push(`${path}.due only applies to accept`);
      else {
        const parsedDue = parseAcceptDue(entry.due);
        if (parsedDue) due = parsedDue;
        else errors.push(`${path}.${ACCEPT_DUE_HELP}`);
      }
    }

    // Move's day. Required, only on move, a real YYYY-MM-DD (whether it falls from today (ET) to 2 years ahead is
    // checked when the action runs).
    let date: string | undefined;
    if (entry.date !== undefined) {
      if (action !== "move") errors.push(`${path}.date only applies to move`);
      else if (isDateOnlyString(entry.date)) date = entry.date;
      else errors.push(`${path}.date must be a real date written YYYY-MM-DD`);
    } else if (action === "move") {
      errors.push(`${path}: move needs a date (YYYY-MM-DD)`);
    }

    actions.push({ n, action, reason, note, choice, ...(due ? { due } : {}), ...(date ? { date } : {}) });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: actions };
}
