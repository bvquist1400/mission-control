/**
 * Pure input helpers for logging work sessions: ET clock times, the rows
 * shorthand ("11-15", "11, 12", "row 10") and matching rows to checklist items
 * whose text starts with "Row N". No database access; tested in `test:pace`.
 */

export const ET_TIMEZONE = "America/New_York";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const ms = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function etParts(utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** ET wall-clock offset from UTC at an instant, in minutes (e.g. -240 in EDT). */
function etOffsetMinutes(utcMs: number): number {
  const p = etParts(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** The ET calendar date of an instant. */
export function etDateOf(instant: Date | string | number): string {
  const ms = new Date(instant).getTime();
  const p = etParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** UTC ISO string for an ET wall-clock time on an ET date. */
export function etLocalToUtcIso(date: string, minutesOfDay: number): string {
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + minutesOfDay * 60000;
  let utc = naive - etOffsetMinutes(naive) * 60000;
  const corrected = naive - etOffsetMinutes(utc) * 60000;
  if (corrected !== utc) utc = corrected;
  return new Date(utc).toISOString();
}

/** "13:20", "1:38 PM", "1:38pm", "9 am" → minutes since midnight. */
export function parseClockTime(value: string): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*$/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (match[2] === undefined || hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** An ET clock time on `date`, or a full ISO instant with an offset. */
export function parseSessionInstant(value: string, date: string | null): Parsed<string> {
  const trimmed = value.trim();
  if (ISO_INSTANT.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return { ok: false, error: `"${value}" is not a valid time` };
    return { ok: true, value: new Date(ms).toISOString() };
  }
  const minutes = parseClockTime(trimmed);
  if (minutes === null) {
    return { ok: false, error: `"${value}" is not a time: use HH:MM (24-hour ET), "1:38 PM", or an ISO timestamp with an offset` };
  }
  if (!date) return { ok: false, error: "a clock time needs a date" };
  return { ok: true, value: etLocalToUtcIso(date, minutes) };
}

export interface SessionTimingInput {
  date?: string | null;
  start?: string | null;
  end?: string | null;
  minutes?: number | null;
}

export interface SessionTiming {
  session_date: string;
  started_at: string | null;
  ended_at: string | null;
  minutes: number;
}

/**
 * Date defaults to today (ET). Minutes are required unless both start and end
 * are given; when all three are given they must agree within 1 minute.
 */
export function resolveSessionTiming(input: SessionTimingInput, now: Date = new Date()): Parsed<SessionTiming> {
  let date = input.date?.trim() || null;
  if (date && !isDateOnly(date)) return { ok: false, error: "date must be YYYY-MM-DD (ET)" };

  // An ISO start without a date sets the ET date.
  if (!date && input.start && ISO_INSTANT.test(input.start.trim())) date = etDateOf(input.start.trim());
  if (!date && input.end && ISO_INSTANT.test(input.end.trim())) date = etDateOf(input.end.trim());
  date = date ?? etDateOf(now);

  let startedAt: string | null = null;
  let endedAt: string | null = null;
  if (input.start) {
    const parsed = parseSessionInstant(input.start, date);
    if (!parsed.ok) return { ok: false, error: `start: ${parsed.error}` };
    startedAt = parsed.value;
  }
  if (input.end) {
    const parsed = parseSessionInstant(input.end, date);
    if (!parsed.ok) return { ok: false, error: `end: ${parsed.error}` };
    endedAt = parsed.value;
  }
  if (startedAt && endedAt && Date.parse(endedAt) <= Date.parse(startedAt)) {
    return { ok: false, error: "end must be after start" };
  }

  const span = startedAt && endedAt ? (Date.parse(endedAt) - Date.parse(startedAt)) / 60000 : null;
  let minutes: number;
  if (input.minutes !== undefined && input.minutes !== null) {
    if (typeof input.minutes !== "number" || !Number.isFinite(input.minutes)) return { ok: false, error: "minutes must be a number" };
    minutes = Math.round(input.minutes);
    if (span !== null && Math.abs(span - input.minutes) > 1) {
      return {
        ok: false,
        error: `minutes (${input.minutes}) and start–end (${Math.round(span)} min) disagree by more than 1 minute; give one or fix them`,
      };
    }
  } else if (span !== null) {
    minutes = Math.round(span);
  } else {
    return { ok: false, error: "give minutes, or both start and end" };
  }
  if (minutes < 1 || minutes > 1440) return { ok: false, error: "minutes must be between 1 and 1440" };
  return { ok: true, value: { session_date: date, started_at: startedAt, ended_at: endedAt, minutes } };
}

/** "11-15", "11–15", "11, 12", "row 10", "rows 11 to 15, 18" → sorted unique row numbers. */
export function parseRowsSpec(value: string): Parsed<number[]> {
  const cleaned = value.trim().replace(/^rows?\s*/i, "");
  if (!cleaned) return { ok: false, error: "rows is empty" };
  const rows = new Set<number>();
  for (const rawPart of cleaned.split(/\s*(?:,|;|\band\b|&)\s*/i)) {
    const part = rawPart.trim().replace(/^rows?\s*/i, "");
    if (!part) continue;
    const range = /^(\d+)\s*(?:-|–|—|to|through|thru)\s*(\d+)$/i.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from) return { ok: false, error: `rows "${part}": the range runs backwards` };
      if (to - from > 500) return { ok: false, error: `rows "${part}": range too large` };
      for (let row = from; row <= to; row += 1) rows.add(row);
      continue;
    }
    if (/^\d+$/.test(part)) {
      rows.add(Number(part));
      continue;
    }
    return { ok: false, error: `rows "${part}" is not a row number or range (e.g. "11-15", "11, 12", "row 10")` };
  }
  if (rows.size === 0) return { ok: false, error: "rows is empty" };
  return { ok: true, value: [...rows].sort((a, b) => a - b) };
}

/** The row number of a checklist item whose text starts with "Row N" (case-insensitive), else null. */
export function itemRowNumber(text: string): number | null {
  const match = /^\s*row\s+(\d+)\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

export interface RowMatchItem {
  id: string;
  text: string;
  task_id: string;
}

export interface RowMatch {
  item_ids: string[];
  missing: number[];
  ambiguous: Array<{ row: number; items: Array<{ id: string; task_id: string; text: string }> }>;
}

/** Matches row numbers to items; never guesses (missing and ambiguous rows are reported). */
export function matchRows(rows: number[], items: RowMatchItem[]): RowMatch {
  const byRow = new Map<number, RowMatchItem[]>();
  for (const item of items) {
    const row = itemRowNumber(item.text);
    if (row === null) continue;
    const list = byRow.get(row) ?? [];
    list.push(item);
    byRow.set(row, list);
  }
  const result: RowMatch = { item_ids: [], missing: [], ambiguous: [] };
  for (const row of rows) {
    const matches = byRow.get(row) ?? [];
    if (matches.length === 0) result.missing.push(row);
    else if (matches.length > 1) {
      result.ambiguous.push({ row, items: matches.map(({ id, task_id, text }) => ({ id, task_id, text })) });
    } else result.item_ids.push(matches[0].id);
  }
  return result;
}
