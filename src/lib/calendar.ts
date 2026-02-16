import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_WORKDAY_CONFIG, WorkdayConfig } from '@/lib/workday';

export type CalendarSource = 'local' | 'ical' | 'none';

export interface CalendarRangeInput {
  rangeStart: string;
  rangeEnd: string;
}

export interface ApiCalendarEvent {
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[];
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
  external_event_id: string;
}

export interface BusyBlock {
  start_at: string;
  end_at: string;
}

export interface BusyStats {
  busyMinutes: number;
  blocks: number;
  largestFocusBlockMinutes: number;
}

export interface SnapshotEntry {
  external_event_id: string;
  start_at: string;
  end_at: string;
  hash: string;
}

export interface CalendarDeltaChanged {
  external_event_id: string;
  previous_start_at: string;
  previous_end_at: string;
  start_at: string;
  end_at: string;
  timeChanged: boolean;
  contentChanged: boolean;
}

export interface CalendarChangesSince {
  added: Array<Pick<SnapshotEntry, 'external_event_id' | 'start_at' | 'end_at'>>;
  removed: Array<Pick<SnapshotEntry, 'external_event_id' | 'start_at' | 'end_at'>>;
  changed: CalendarDeltaChanged[];
}

export interface CalendarDayWindow {
  day: string;
  windowStartUtcMs: number;
  windowEndUtcMs: number;
}

interface CalendarRuntimeConfig {
  source: CalendarSource;
  workIcalUrl: string | null;
  localIcsPath: string;
  retentionDays: number;
  futureHorizonDays: number;
  bodyMaxChars: number;
  storeBody: boolean;
}

export interface CalendarIngestResult {
  source: CalendarSource;
  ingestedCount: number;
  warnings: string[];
}

interface ParsedIcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface ParsedCalendarEvent {
  external_event_id: string;
  start_at: string;
  end_at: string;
  is_all_day: boolean;
  title: string;
  organizer_display: string | null;
  with_display: string[];
  sanitized_body: string | null;
  body_scrubbed_preview: string | null;
  content_hash: string;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const URL_REGEX = /\bhttps?:\/\/\S+|\bwww\.[^\s]+/gi;
const MAILTO_REGEX = /\bmailto:[^\s]+/gi;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /\+?\d[\d().\s-]{7,}\d/g;
const LONG_NUMERIC_ID_REGEX = /\b\d{6,}\b/g;

const JOIN_BLOCK_KEYWORDS = [
  'join microsoft teams meeting',
  'click here to join',
  'meeting id',
  'passcode',
  'dial-in',
  'conference id',
  'join teams meeting',
  'join zoom meeting',
  'one tap mobile',
  'call in',
];

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function getCalendarSource(value: string | undefined): CalendarSource {
  if (value === 'local' || value === 'ical' || value === 'none') {
    return value;
  }

  return 'local';
}

function getCalendarRuntimeConfig(): CalendarRuntimeConfig {
  return {
    source: getCalendarSource(process.env.CALENDAR_SOURCE),
    workIcalUrl: process.env.WORK_ICAL_URL?.trim() || null,
    localIcsPath: process.env.CALENDAR_LOCAL_ICS_PATH?.trim() || 'data/calendar/work-calendar.ics',
    retentionDays: parsePositiveIntEnv('CALENDAR_RETENTION_DAYS', 14),
    futureHorizonDays: parsePositiveIntEnv('CALENDAR_FUTURE_HORIZON_DAYS', 30),
    bodyMaxChars: parsePositiveIntEnv('CALENDAR_BODY_MAX_CHARS', 4000),
    storeBody: parseBooleanEnv('CALENDAR_STORE_BODY', false),
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function unfoldIcsEscapes(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
}

function redactJoinBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const skip = new Set<number>();

  lines.forEach((line, index) => {
    const lowered = line.toLowerCase();
    if (!JOIN_BLOCK_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
      return;
    }

    for (let offset = -1; offset <= 2; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) {
        skip.add(target);
      }
    }
  });

  return lines.filter((_, index) => !skip.has(index)).join('\n');
}

function isProbablyHtml(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

function sanitizeParticipantDisplay(input: string | null): string | null {
  if (!input) {
    return null;
  }

  let value = unfoldIcsEscapes(input).replace(/"/g, '').trim();
  value = value.replace(MAILTO_REGEX, ' ');
  value = value.replace(EMAIL_REGEX, ' ');
  value = value.replace(URL_REGEX, ' ');
  value = value.replace(/\s+/g, ' ').trim();

  if (!value) {
    return null;
  }

  return value;
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function normalizeWithDisplayForStorage(values: string[]): string[] {
  const deduped = new Map<string, string>();

  for (const value of values) {
    const cleaned = sanitizeParticipantDisplay(value);
    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, cleaned);
    }
  }

  return [...deduped.values()];
}

function normalizeWithDisplayForHash(values: string[]): string[] {
  return normalizeWithDisplayForStorage(values)
    .map((value) => value.toLowerCase())
    .sort((a, b) => a.localeCompare(b));
}

function normalizeBodyForHash(value: string | null): string {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function hashSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toSnapshotDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateParts(dateString: string): DateParts | null {
  if (!DATE_ONLY_REGEX.test(dateString)) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = dateString.split('-');
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function addDays(dateString: string, days: number): string {
  const parts = parseDateParts(dateString);
  if (!parts) {
    throw new Error(`Invalid date string: ${dateString}`);
  }

  const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  current.setUTCDate(current.getUTCDate() + days);
  return toSnapshotDateString(current);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type === 'literal') {
      continue;
    }

    values[part.type] = part.value;
  }

  const asUtc = Date.UTC(
    Number.parseInt(values.year, 10),
    Number.parseInt(values.month, 10) - 1,
    Number.parseInt(values.day, 10),
    Number.parseInt(values.hour, 10),
    Number.parseInt(values.minute, 10),
    Number.parseInt(values.second, 10)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  let utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const guessDate = new Date(utcGuess);
    const offset = getTimeZoneOffsetMs(guessDate, timeZone);
    utcGuess = Date.UTC(year, month - 1, day, hour, minute, second) - offset;
  }

  return new Date(utcGuess);
}

function normalizeDateIso(isoString: string): string {
  return new Date(isoString).toISOString();
}

function parseIcsDateTime(
  rawValue: string,
  params: Record<string, string>,
  defaultTimeZone: string
): { iso: string | null; isAllDay: boolean } {
  const value = rawValue.trim();
  const tzid = params.TZID || defaultTimeZone;
  const valueType = params.VALUE?.toUpperCase();

  if (valueType === 'DATE' || /^\d{8}$/.test(value)) {
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10);
    const day = Number.parseInt(value.slice(6, 8), 10);

    try {
      const utc = zonedDateTimeToUtc(year, month, day, 0, 0, 0, tzid);
      return { iso: utc.toISOString(), isAllDay: true };
    } catch {
      return { iso: new Date(Date.UTC(year, month - 1, day)).toISOString(), isAllDay: true };
    }
  }

  if (/^\d{8}T\d{6}Z$/i.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    return { iso: new Date(iso).toISOString(), isAllDay: false };
  }

  if (/^\d{8}T\d{6}$/i.test(value)) {
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10);
    const day = Number.parseInt(value.slice(6, 8), 10);
    const hour = Number.parseInt(value.slice(9, 11), 10);
    const minute = Number.parseInt(value.slice(11, 13), 10);
    const second = Number.parseInt(value.slice(13, 15), 10);

    try {
      const utc = zonedDateTimeToUtc(year, month, day, hour, minute, second, tzid);
      return { iso: utc.toISOString(), isAllDay: false };
    } catch {
      const fallback = Date.parse(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`);
      return Number.isNaN(fallback) ? { iso: null, isAllDay: false } : { iso: new Date(fallback).toISOString(), isAllDay: false };
    }
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { iso: null, isAllDay: false };
  }

  return { iso: new Date(parsed).toISOString(), isAllDay: false };
}

function parseIcsProperty(line: string): ParsedIcsProperty | null {
  const separatorIndex = line.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const left = line.slice(0, separatorIndex);
  const value = line.slice(separatorIndex + 1);
  const [nameRaw, ...paramParts] = left.split(';');

  if (!nameRaw) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const equalIndex = part.indexOf('=');
    if (equalIndex <= 0) {
      continue;
    }

    const key = part.slice(0, equalIndex).trim().toUpperCase();
    const paramValue = part.slice(equalIndex + 1).trim().replace(/^"|"$/g, '');
    params[key] = paramValue;
  }

  return {
    name: nameRaw.trim().toUpperCase(),
    params,
    value,
  };
}

function unfoldIcs(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '');
}

function extractDisplayName(property: ParsedIcsProperty): string | null {
  if (property.params.CN) {
    return sanitizeParticipantDisplay(property.params.CN);
  }

  return sanitizeParticipantDisplay(property.value);
}

export function sanitizeBody(input: string, maxChars: number): string {
  if (!input) {
    return '';
  }

  const unfolded = unfoldIcsEscapes(input);
  const asText = isProbablyHtml(unfolded) ? stripHtmlToText(unfolded) : unfolded;
  const withoutJoinBlocks = redactJoinBlocks(asText);

  const scrubbed = withoutJoinBlocks
    .replace(URL_REGEX, ' ')
    .replace(MAILTO_REGEX, ' ')
    .replace(EMAIL_REGEX, ' ')
    .replace(PHONE_REGEX, ' ')
    .replace(LONG_NUMERIC_ID_REGEX, ' ');

  const normalized = normalizeWhitespace(scrubbed);
  return truncateText(normalized, maxChars);
}

export function buildBodyPreview(bodyScrubbed: string | null, previewChars = 280): string | null {
  if (!bodyScrubbed) {
    return null;
  }

  if (bodyScrubbed.length <= previewChars) {
    return bodyScrubbed;
  }

  return `${bodyScrubbed.slice(0, previewChars).trimEnd()}...`;
}

function buildContentHash(title: string, withDisplay: string[], sanitizedBody: string | null): string {
  const normalizedTitle = normalizeTitle(title).toLowerCase();
  const normalizedPeople = normalizeWithDisplayForHash(withDisplay).join('|');
  const normalizedBody = normalizeBodyForHash(sanitizedBody);
  return hashSha256(`${normalizedTitle}\n${normalizedPeople}\n${normalizedBody}`);
}

function buildExternalEventId(
  uid: string | null,
  recurrenceId: string | null,
  title: string,
  startAt: string,
  endAt: string
): string {
  const cleanedUid = uid?.trim();
  if (cleanedUid) {
    if (recurrenceId?.trim()) {
      return `${cleanedUid}::${recurrenceId.trim()}`;
    }

    return cleanedUid;
  }

  return hashSha256(`${normalizeTitle(title)}::${startAt}::${endAt}`);
}

function parseIcsEvents(ics: string, defaultTimeZone: string, bodyMaxChars: number): ParsedCalendarEvent[] {
  const unfolded = unfoldIcs(ics);
  const eventRegex = /BEGIN:VEVENT\s*([\s\S]*?)\s*END:VEVENT/gi;
  const parsedEvents: ParsedCalendarEvent[] = [];

  let match: RegExpExecArray | null = eventRegex.exec(unfolded);
  while (match) {
    const block = match[1] || '';
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    let summary = '';
    let dtStart: ParsedIcsProperty | null = null;
    let dtEnd: ParsedIcsProperty | null = null;
    let description: ParsedIcsProperty | null = null;
    let uid: string | null = null;
    let recurrenceId: string | null = null;
    let organizer: ParsedIcsProperty | null = null;
    const attendeeDisplays: string[] = [];

    for (const line of lines) {
      const property = parseIcsProperty(line);
      if (!property) {
        continue;
      }

      switch (property.name) {
        case 'SUMMARY':
          summary = unfoldIcsEscapes(property.value);
          break;
        case 'DTSTART':
          dtStart = property;
          break;
        case 'DTEND':
          dtEnd = property;
          break;
        case 'DESCRIPTION':
          description = description ?? property;
          break;
        case 'X-ALT-DESC':
          description = description ?? property;
          break;
        case 'COMMENT':
          description = description ?? property;
          break;
        case 'UID':
          uid = unfoldIcsEscapes(property.value).trim();
          break;
        case 'RECURRENCE-ID': {
          const recurrence = parseIcsDateTime(property.value, property.params, defaultTimeZone).iso;
          recurrenceId = recurrence ?? unfoldIcsEscapes(property.value).trim();
          break;
        }
        case 'ORGANIZER':
          organizer = organizer ?? property;
          break;
        case 'ATTENDEE': {
          const display = extractDisplayName(property);
          if (display) {
            attendeeDisplays.push(display);
          }
          break;
        }
        default:
          break;
      }
    }

    if (!dtStart) {
      match = eventRegex.exec(unfolded);
      continue;
    }

    const parsedStart = parseIcsDateTime(dtStart.value, dtStart.params, defaultTimeZone);
    if (!parsedStart.iso) {
      match = eventRegex.exec(unfolded);
      continue;
    }

    const parsedEnd = dtEnd
      ? parseIcsDateTime(dtEnd.value, dtEnd.params, defaultTimeZone)
      : { iso: null, isAllDay: parsedStart.isAllDay };

    let endIso = parsedEnd.iso;

    if (!endIso) {
      const base = new Date(parsedStart.iso);
      if (parsedStart.isAllDay) {
        base.setUTCDate(base.getUTCDate() + 1);
      } else {
        base.setUTCMinutes(base.getUTCMinutes() + 30);
      }
      endIso = base.toISOString();
    }

    if (Date.parse(endIso) <= Date.parse(parsedStart.iso)) {
      const base = new Date(parsedStart.iso);
      base.setUTCMinutes(base.getUTCMinutes() + (parsedStart.isAllDay ? 24 * 60 : 30));
      endIso = base.toISOString();
    }

    const organizerDisplay = organizer ? extractDisplayName(organizer) : null;
    const withDisplay = normalizeWithDisplayForStorage(
      organizerDisplay ? [...attendeeDisplays, organizerDisplay] : attendeeDisplays
    );

    const title = normalizeTitle(summary || 'Untitled Event');
    const sanitizedBody = description ? sanitizeBody(description.value, bodyMaxChars) : '';
    const bodyScrubbed = sanitizedBody.length > 0 ? sanitizedBody : null;

    parsedEvents.push({
      external_event_id: buildExternalEventId(uid, recurrenceId, title, parsedStart.iso, endIso),
      start_at: normalizeDateIso(parsedStart.iso),
      end_at: normalizeDateIso(endIso),
      is_all_day: parsedStart.isAllDay || parsedEnd.isAllDay,
      title,
      organizer_display: organizerDisplay,
      with_display: withDisplay,
      sanitized_body: bodyScrubbed,
      body_scrubbed_preview: buildBodyPreview(bodyScrubbed),
      content_hash: buildContentHash(title, withDisplay, bodyScrubbed),
    });

    match = eventRegex.exec(unfolded);
  }

  return parsedEvents.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}

function overlapsRange(startIso: string, endIso: string, utcRangeStart: string, utcRangeEndExclusive: string): boolean {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const rangeStartMs = Date.parse(utcRangeStart);
  const rangeEndMs = Date.parse(utcRangeEndExclusive);

  return endMs >= rangeStartMs && startMs < rangeEndMs;
}

export function buildDayWindows(
  range: CalendarRangeInput,
  config: WorkdayConfig = DEFAULT_WORKDAY_CONFIG
): { utcRangeStart: string; utcRangeEndExclusive: string; windows: CalendarDayWindow[] } {
  const startParts = parseDateParts(range.rangeStart);
  const endParts = parseDateParts(range.rangeEnd);

  if (!startParts || !endParts) {
    throw new Error('rangeStart and rangeEnd must be YYYY-MM-DD');
  }

  if (range.rangeEnd < range.rangeStart) {
    throw new Error('rangeEnd must be on or after rangeStart');
  }

  const rangeStartUtc = zonedDateTimeToUtc(startParts.year, startParts.month, startParts.day, 0, 0, 0, config.timezone).toISOString();
  const nextDay = parseDateParts(addDays(range.rangeEnd, 1));
  if (!nextDay) {
    throw new Error('Unable to compute range end boundary');
  }

  const rangeEndExclusiveUtc = zonedDateTimeToUtc(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, config.timezone).toISOString();

  const windows: CalendarDayWindow[] = [];
  let current = range.rangeStart;

  while (current <= range.rangeEnd) {
    const parts = parseDateParts(current);
    if (!parts) {
      throw new Error(`Invalid date in range: ${current}`);
    }

    const windowStart = zonedDateTimeToUtc(
      parts.year,
      parts.month,
      parts.day,
      config.focusWindowStartHour,
      0,
      0,
      config.timezone
    );

    const windowEnd = zonedDateTimeToUtc(
      parts.year,
      parts.month,
      parts.day,
      config.focusWindowEndHour,
      0,
      0,
      config.timezone
    );

    windows.push({
      day: current,
      windowStartUtcMs: windowStart.getTime(),
      windowEndUtcMs: windowEnd.getTime(),
    });

    current = addDays(current, 1);
  }

  return {
    utcRangeStart: rangeStartUtc,
    utcRangeEndExclusive: rangeEndExclusiveUtc,
    windows,
  };
}

function mergeIntervals(intervals: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];

    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
      continue;
    }

    merged.push({ ...current });
  }

  return merged;
}

function collectBusyIntervalsByDay(
  events: Array<Pick<ApiCalendarEvent, 'start_at' | 'end_at'>>,
  windows: CalendarDayWindow[]
): Array<{ day: string; merged: Array<{ startMs: number; endMs: number }> }> {
  return windows.map((window) => {
    const intervals: Array<{ startMs: number; endMs: number }> = [];

    for (const event of events) {
      const eventStart = Date.parse(event.start_at);
      const eventEnd = Date.parse(event.end_at);
      if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) {
        continue;
      }

      const clippedStart = Math.max(eventStart, window.windowStartUtcMs);
      const clippedEnd = Math.min(eventEnd, window.windowEndUtcMs);

      if (clippedEnd <= clippedStart) {
        continue;
      }

      intervals.push({ startMs: clippedStart, endMs: clippedEnd });
    }

    return {
      day: window.day,
      merged: mergeIntervals(intervals),
    };
  });
}

export function mergeBusyBlocks(
  events: Array<Pick<ApiCalendarEvent, 'start_at' | 'end_at'>>,
  windows: CalendarDayWindow[]
): BusyBlock[] {
  const mergedPerDay = collectBusyIntervalsByDay(events, windows);
  const busyBlocks: BusyBlock[] = [];

  for (const day of mergedPerDay) {
    for (const interval of day.merged) {
      busyBlocks.push({
        start_at: new Date(interval.startMs).toISOString(),
        end_at: new Date(interval.endMs).toISOString(),
      });
    }
  }

  return busyBlocks;
}

export function calculateBusyStats(
  events: Array<Pick<ApiCalendarEvent, 'start_at' | 'end_at'>>,
  windows: CalendarDayWindow[]
): BusyStats {
  const mergedPerDay = collectBusyIntervalsByDay(events, windows);
  let busyMinutes = 0;
  let blockCount = 0;
  let largestFocusBlockMinutes = 0;

  for (const day of mergedPerDay) {
    const window = windows.find((entry) => entry.day === day.day);
    if (!window) {
      continue;
    }

    blockCount += day.merged.length;

    for (const interval of day.merged) {
      busyMinutes += Math.round((interval.endMs - interval.startMs) / 60000);
    }

    if (day.merged.length === 0) {
      largestFocusBlockMinutes = Math.max(
        largestFocusBlockMinutes,
        Math.round((window.windowEndUtcMs - window.windowStartUtcMs) / 60000)
      );
      continue;
    }

    let cursor = window.windowStartUtcMs;
    for (const interval of day.merged) {
      const gap = interval.startMs - cursor;
      if (gap > 0) {
        largestFocusBlockMinutes = Math.max(largestFocusBlockMinutes, Math.round(gap / 60000));
      }
      cursor = Math.max(cursor, interval.endMs);
    }

    const trailingGap = window.windowEndUtcMs - cursor;
    if (trailingGap > 0) {
      largestFocusBlockMinutes = Math.max(largestFocusBlockMinutes, Math.round(trailingGap / 60000));
    }
  }

  return {
    busyMinutes,
    blocks: blockCount,
    largestFocusBlockMinutes,
  };
}

export function buildSnapshotPayload(
  events: Array<{ external_event_id: string; start_at: string; end_at: string; content_hash: string }>
): SnapshotEntry[] {
  return events
    .map((event) => ({
      external_event_id: event.external_event_id,
      start_at: event.start_at,
      end_at: event.end_at,
      hash: event.content_hash,
    }))
    .sort((a, b) => a.external_event_id.localeCompare(b.external_event_id));
}

export function parseSnapshotPayload(input: unknown): SnapshotEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const externalEventId = candidate.external_event_id;
      const startAt = candidate.start_at;
      const endAt = candidate.end_at;
      const hash = candidate.hash;

      if (
        typeof externalEventId !== 'string' ||
        typeof startAt !== 'string' ||
        typeof endAt !== 'string' ||
        typeof hash !== 'string'
      ) {
        return null;
      }

      return {
        external_event_id: externalEventId,
        start_at: startAt,
        end_at: endAt,
        hash,
      } satisfies SnapshotEntry;
    })
    .filter((value): value is SnapshotEntry => value !== null);
}

export function computeDeltas(previousSnapshot: SnapshotEntry[], currentSnapshot: SnapshotEntry[]): CalendarChangesSince {
  const previousById = new Map(previousSnapshot.map((entry) => [entry.external_event_id, entry]));
  const currentById = new Map(currentSnapshot.map((entry) => [entry.external_event_id, entry]));

  const added: CalendarChangesSince['added'] = [];
  const removed: CalendarChangesSince['removed'] = [];
  const changed: CalendarChangesSince['changed'] = [];

  for (const [externalEventId, currentEntry] of currentById.entries()) {
    const previousEntry = previousById.get(externalEventId);
    if (!previousEntry) {
      added.push({
        external_event_id: currentEntry.external_event_id,
        start_at: currentEntry.start_at,
        end_at: currentEntry.end_at,
      });
      continue;
    }

    const timeChanged =
      previousEntry.start_at !== currentEntry.start_at || previousEntry.end_at !== currentEntry.end_at;
    const contentChanged = previousEntry.hash !== currentEntry.hash;

    if (timeChanged || contentChanged) {
      changed.push({
        external_event_id: externalEventId,
        previous_start_at: previousEntry.start_at,
        previous_end_at: previousEntry.end_at,
        start_at: currentEntry.start_at,
        end_at: currentEntry.end_at,
        timeChanged,
        contentChanged,
      });
    }
  }

  for (const [externalEventId, previousEntry] of previousById.entries()) {
    if (currentById.has(externalEventId)) {
      continue;
    }

    removed.push({
      external_event_id: previousEntry.external_event_id,
      start_at: previousEntry.start_at,
      end_at: previousEntry.end_at,
    });
  }

  return {
    added,
    removed,
    changed,
  };
}

interface IcsLoadResult {
  ics: string | null;
  warnings: string[];
}

async function loadIcsFromConfig(config: CalendarRuntimeConfig): Promise<IcsLoadResult> {
  if (config.source === 'none') {
    return { ics: null, warnings: [] };
  }

  if (config.source === 'local') {
    const localPath = path.isAbsolute(config.localIcsPath)
      ? config.localIcsPath
      : path.join(process.cwd(), config.localIcsPath);

    try {
      const ics = await readFile(localPath, 'utf8');
      if (!ics.trim()) {
        return {
          ics: null,
          warnings: [`Local ICS file is empty at ${config.localIcsPath}.`],
        };
      }

      return { ics, warnings: [] };
    } catch {
      return {
        ics: null,
        warnings: [`Local ICS file not found at ${config.localIcsPath}.`],
      };
    }
  }

  if (!config.workIcalUrl) {
    return {
      ics: null,
      warnings: ['CALENDAR_SOURCE is set to ical but WORK_ICAL_URL is empty.'],
    };
  }

  try {
    const response = await fetch(config.workIcalUrl, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ics: null,
          warnings: ['ICS feed access denied (401/403). The Outlook publish URL may be expired or restricted.'],
        };
      }

      if (response.status === 404) {
        return {
          ics: null,
          warnings: ['ICS feed URL returned 404. Verify WORK_ICAL_URL in .env.local.'],
        };
      }

      if (response.status === 429) {
        return {
          ics: null,
          warnings: ['ICS feed rate-limited (429). Retry shortly.'],
        };
      }

      if (response.status >= 500) {
        return {
          ics: null,
          warnings: [`ICS feed provider error (${response.status}). Retry shortly.`],
        };
      }

      return {
        ics: null,
        warnings: [`Unable to fetch ICS feed (HTTP ${response.status}).`],
      };
    }

    const ics = await response.text();
    if (!ics.trim()) {
      return {
        ics: null,
        warnings: ['ICS feed returned an empty response body.'],
      };
    }

    return { ics, warnings: [] };
  } catch {
    return {
      ics: null,
      warnings: ['Unable to fetch ICS feed from WORK_ICAL_URL.'],
    };
  }
}

function getStaleEventKey(externalEventId: string, startAt: string): string {
  return `${externalEventId}::${new Date(startAt).toISOString()}`;
}

export async function ingestCalendarEvents(
  range: CalendarRangeInput,
  userId: string,
  supabase: SupabaseClient
): Promise<CalendarIngestResult> {
  const config = getCalendarRuntimeConfig();
  const warnings: string[] = [];

  if (config.source === 'none') {
    return { source: config.source, ingestedCount: 0, warnings };
  }

  const loadResult = await loadIcsFromConfig(config);
  warnings.push(...loadResult.warnings);
  if (!loadResult.ics) {
    return { source: config.source, ingestedCount: 0, warnings };
  }

  const parsedEvents = parseIcsEvents(loadResult.ics, DEFAULT_WORKDAY_CONFIG.timezone, config.bodyMaxChars);
  if (parsedEvents.length === 0) {
    warnings.push('ICS loaded successfully, but no events could be parsed.');
    return { source: config.source, ingestedCount: 0, warnings };
  }

  const rangeContext = buildDayWindows(range, DEFAULT_WORKDAY_CONFIG);

  const eventsInRange = parsedEvents.filter((event) =>
    overlapsRange(event.start_at, event.end_at, rangeContext.utcRangeStart, rangeContext.utcRangeEndExclusive)
  );

  const nowIso = new Date().toISOString();

  const rows = eventsInRange.map((event) => ({
    user_id: userId,
    source: config.source,
    external_event_id: event.external_event_id,
    start_at: event.start_at,
    end_at: event.end_at,
    is_all_day: event.is_all_day,
    title: event.title,
    organizer_display: event.organizer_display,
    with_display: event.with_display,
    body_scrubbed: config.storeBody ? event.sanitized_body : null,
    body_scrubbed_preview: event.body_scrubbed_preview,
    content_hash: event.content_hash,
    ingested_at: nowIso,
  }));

  if (rows.length > 0) {
    const { error: upsertError } = await supabase.from('calendar_events').upsert(rows, {
      onConflict: 'user_id,source,external_event_id,start_at',
    });

    if (upsertError) {
      throw upsertError;
    }
  }

  const { data: existingRows, error: existingRowsError } = await supabase
    .from('calendar_events')
    .select('id, external_event_id, start_at, end_at')
    .eq('user_id', userId)
    .eq('source', config.source)
    .gte('end_at', rangeContext.utcRangeStart)
    .lt('start_at', rangeContext.utcRangeEndExclusive);

  if (existingRowsError) {
    throw existingRowsError;
  }

  const currentKeys = new Set(rows.map((row) => getStaleEventKey(row.external_event_id, row.start_at)));
  const staleIds = (existingRows || [])
    .filter((row) => !currentKeys.has(getStaleEventKey(row.external_event_id, row.start_at)))
    .map((row) => row.id);

  if (staleIds.length > 0) {
    const { error: deleteError } = await supabase.from('calendar_events').delete().in('id', staleIds);
    if (deleteError) {
      throw deleteError;
    }
  }

  if (eventsInRange.length === 0) {
    warnings.push('ICS parsed successfully, but no events were found in the requested date range.');
  }

  return { source: config.source, ingestedCount: rows.length, warnings };
}

export async function enforceCalendarRetention(supabase: SupabaseClient, userId: string): Promise<void> {
  const config = getCalendarRuntimeConfig();
  const now = new Date();
  const pastCutoff = new Date(now);
  pastCutoff.setUTCDate(pastCutoff.getUTCDate() - config.retentionDays);

  const futureCutoff = new Date(now);
  futureCutoff.setUTCDate(futureCutoff.getUTCDate() + config.futureHorizonDays);

  const { error: pastDeleteError } = await supabase
    .from('calendar_events')
    .delete()
    .eq('user_id', userId)
    .lt('end_at', pastCutoff.toISOString());

  if (pastDeleteError) {
    throw pastDeleteError;
  }

  const { error: futureDeleteError } = await supabase
    .from('calendar_events')
    .delete()
    .eq('user_id', userId)
    .gt('start_at', futureCutoff.toISOString());

  if (futureDeleteError) {
    throw futureDeleteError;
  }

  const { error: snapshotDeleteError } = await supabase
    .from('calendar_snapshots')
    .delete()
    .eq('user_id', userId)
    .lt('captured_at', pastCutoff.toISOString());

  if (snapshotDeleteError) {
    throw snapshotDeleteError;
  }
}

export function parseEventPeople(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return normalizeWithDisplayForStorage(
    input.filter((value): value is string => typeof value === 'string')
  );
}

export function normalizeRequestedRange(rangeStart: string | null, rangeEnd: string | null): CalendarRangeInput {
  const today = new Date();
  const defaultStart = toSnapshotDateString(today);
  const defaultEnd = addDays(defaultStart, 7);

  const resolvedStart = rangeStart ?? defaultStart;
  const resolvedEnd = rangeEnd ?? defaultEnd;

  if (!parseDateParts(resolvedStart) || !parseDateParts(resolvedEnd)) {
    throw new Error('rangeStart and rangeEnd must be YYYY-MM-DD');
  }

  if (resolvedEnd < resolvedStart) {
    throw new Error('rangeEnd must be on or after rangeStart');
  }

  const startDate = new Date(`${resolvedStart}T00:00:00.000Z`);
  const endDate = new Date(`${resolvedEnd}T00:00:00.000Z`);
  const daySpan = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000);

  if (daySpan > 60) {
    throw new Error('range may not exceed 60 days');
  }

  return {
    rangeStart: resolvedStart,
    rangeEnd: resolvedEnd,
  };
}
