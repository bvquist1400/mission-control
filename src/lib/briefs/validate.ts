import { normalizeDateOnly } from "@/lib/date-only";
import { todayInBriefTimeZone } from "@/lib/briefs/keys";
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
  type BriefStat,
  type BriefTile,
  type BriefTileGroup,
  type BriefTileRow,
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

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Only http(s) links are ever rendered as hrefs. */
export function safeUrl(value: unknown): string | null {
  const raw = str(value, 1000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function strList(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item, maxLen)).filter((item): item is string => item !== null).slice(0, maxItems);
}

function isoOrNull(value: unknown): string | null {
  const raw = str(value, 60);
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

function normalizeMeeting(value: unknown): BriefMeeting | null {
  if (!isObject(value)) return null;
  const title = str(value.title, 300);
  const start = isoOrNull(value.start);
  if (!title || !start) return null;
  const id = str(value.id, 200);
  return {
    id,
    title,
    short: str(value.short, 80),
    start,
    end: isoOrNull(value.end),
    url: safeUrl(value.url),
    has_notes: typeof value.has_notes === "boolean" ? value.has_notes : id !== null,
  };
}

function normalizeTileRow(value: unknown): BriefTileRow | null {
  if (typeof value === "string") {
    const title = str(value, 500);
    return title ? { title } : null;
  }
  if (!isObject(value)) return null;
  const title = str(value.title, 500);
  if (!title) return null;
  const row: BriefTileRow = { title };
  const meta = str(value.meta, 500);
  if (meta) row.meta = meta;
  if (isUuid(value.task_id)) row.task_id = value.task_id.toLowerCase();
  return row;
}

function normalizeTile(value: unknown): BriefTile | null {
  if (!isObject(value)) return null;
  const key = str(value.key, 40);
  const label = str(value.label, 80);
  const type = (BRIEF_TILE_TYPES as readonly string[]).includes(String(value.type)) ? (value.type as BriefTile["type"]) : "list";
  if (!key || !label) return null;
  const tile: BriefTile = { key, type, label };
  if (typeof value.value === "number" && Number.isFinite(value.value)) tile.value = value.value;
  const suffix = str(value.suffix, 40);
  if (suffix) tile.suffix = suffix;
  const summary = str(value.summary, 300);
  if (summary) tile.summary = summary;
  const text = str(value.text, 4000);
  if (text) tile.text = text;
  const list = strList(value.list, 12, 1000);
  if (list.length) tile.list = list;
  const listLabel = str(value.list_label, 80);
  if (listLabel) tile.list_label = listLabel;
  if (Array.isArray(value.groups)) {
    const groups = value.groups
      .map((group): BriefTileGroup | null => {
        if (!isObject(group)) return null;
        const rows = Array.isArray(group.rows)
          ? group.rows.map(normalizeTileRow).filter((row): row is BriefTileRow => row !== null).slice(0, 60)
          : [];
        if (!rows.length) return null;
        const groupLabel = str(group.label, 120);
        return groupLabel ? { label: groupLabel, rows } : { rows };
      })
      .filter((group): group is BriefTileGroup => group !== null)
      .slice(0, 8);
    if (groups.length) tile.groups = groups;
  }
  const footnote = str(value.footnote, 500);
  if (footnote) tile.footnote = footnote;
  return tile;
}

export function normalizeBriefContent(value: unknown): BriefContent {
  if (!isObject(value)) return {};
  const content: BriefContent = {};
  const heading = str(value.heading, 80);
  if (heading) content.heading = heading;
  const narrative = str(value.narrative, 4000);
  if (narrative) content.narrative = narrative;
  const moves = strList(value.first_moves, 8, 1000);
  if (moves.length) content.first_moves = moves;
  if (Array.isArray(value.stats)) {
    const stats = value.stats
      .map((stat): BriefStat | null => {
        if (!isObject(stat)) return null;
        const key = str(stat.key, 40);
        const label = str(stat.label, 40);
        if (!key || !label || typeof stat.value !== "number" || !Number.isFinite(stat.value)) return null;
        return { key, label, value: stat.value };
      })
      .filter((stat): stat is BriefStat => stat !== null)
      .slice(0, 6);
    if (stats.length) content.stats = stats;
  }
  if (isObject(value.next)) {
    const label = str(value.next.label, 80);
    const agenda = Array.isArray(value.next.agenda)
      ? value.next.agenda
          .map((line): BriefAgendaLine | null => {
            if (!isObject(line)) return null;
            const time = str(line.time, 12);
            const title = str(line.title, 200);
            if (!time || !title) return null;
            const out: BriefAgendaLine = { time, title };
            if (Number.isInteger(line.choice_n) && (line.choice_n as number) > 0) out.choice_n = line.choice_n as number;
            return out;
          })
          .filter((line): line is BriefAgendaLine => line !== null)
          .slice(0, 12)
      : [];
    if (label) content.next = { label, agenda };
  }
  if (Array.isArray(value.meetings)) {
    const meetings = value.meetings
      .map(normalizeMeeting)
      .filter((meeting): meeting is BriefMeeting => meeting !== null)
      .slice(0, 30);
    if (meetings.length) content.meetings = meetings;
  }
  if (Array.isArray(value.tiles)) {
    const tiles = value.tiles.map(normalizeTile).filter((tile): tile is BriefTile => tile !== null).slice(0, 12);
    if (tiles.length) content.tiles = tiles;
  }
  const footnote = str(value.footnote, 500);
  if (footnote) content.footnote = footnote;
  return content;
}

// ---------------------------------------------------------------------------
// Items: strict. A bad item is a routine bug the caller should see.
// ---------------------------------------------------------------------------

function parseMeetingRef(value: unknown, path: string, errors: string[]): BriefMeetingRef | null {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  const id = str(value.id, 200);
  const title = str(value.title, 300);
  if (!id) errors.push(`${path}.id is required`);
  if (!title) errors.push(`${path}.title is required`);
  if (!id || !title) return null;
  return {
    id,
    title,
    start: isoOrNull(value.start),
    url: safeUrl(value.url),
    lines: strList(value.lines ?? (value.line !== undefined ? [value.line] : []), 10, 1000),
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
    const label = str(option.label, 200);
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

  const title = str(value.title, 500);
  if (!title) errors.push(`${path}.title is required`);
  if (typeof value.title === "string" && value.title.trim().length > 500) errors.push(`${path}.title must be 500 characters or fewer`);

  const payload: BriefItemPayload = { title: title ?? "" };
  const detail = str(value.detail, 4000);
  if (detail) payload.detail = detail;
  const why = str(value.why, 1000);
  if (why) payload.why = why;
  const group = str(value.group, 80);
  if (group) payload.group = group;
  const label = str(value.label, 80);
  if (label) payload.label = label;

  const taskIds = parseTaskIds(value.task_ids, `${path}.task_ids`, errors);

  const rawSource = isObject(value.source) ? value.source : {};
  const rawMeetings = Array.isArray(rawSource.meetings) ? rawSource.meetings : [];
  if (rawMeetings.length > 10) errors.push(`${path}.source.meetings allows at most 10 meetings`);
  const meetings = rawMeetings
    .slice(0, 10)
    .map((meeting, meetingIndex) => parseMeetingRef(meeting, `${path}.source.meetings[${meetingIndex}]`, errors))
    .filter((meeting): meeting is BriefMeetingRef => meeting !== null);

  if (value.maybe_tracked !== undefined && value.maybe_tracked !== null) {
    const maybe = value.maybe_tracked;
    if (!isObject(maybe) || !isUuid(maybe.task_id)) {
      errors.push(`${path}.maybe_tracked.task_id must be a task UUID`);
    } else {
      payload.maybe_tracked = { task_id: maybe.task_id.toLowerCase(), text: str(maybe.text, 500) ?? "" };
    }
  }

  switch (kind) {
    case "proposed_task":
      if (meetings.length === 0) errors.push(`${path}: a proposed_task must cite at least one meeting in source.meetings`);
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
  return { kind, payload, task_ids: taskIds, source: { meetings } };
}

export function parseSaveBriefInput(raw: unknown, now: Date = new Date()): ParseResult<SaveBriefInput> {
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

  if (raw.content !== undefined && !isObject(raw.content)) errors.push("content must be an object");
  if (isObject(raw.content) && JSON.stringify(raw.content).length > MAX_CONTENT_CHARS) {
    errors.push(`content must be under ${MAX_CONTENT_CHARS} characters of JSON`);
  }

  if (raw.covered_meeting_ids !== undefined && !Array.isArray(raw.covered_meeting_ids)) {
    errors.push("covered_meeting_ids must be an array of meeting ids");
  }
  const covered = strList(raw.covered_meeting_ids, 100, 200);

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
      claim_email: raw.claim_email === true,
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

    actions.push({ n, action, reason, note, choice });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: actions };
}
