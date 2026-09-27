// The day timeline's geometry, kept pure so it's testable without React.
// Everything comes from the data: a meeting is "upcoming" when it starts after
// the brief was saved, never because of the brief's edition.

import type { BriefMeeting } from "@/lib/briefs/types";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { etMinutes } from "@/components/briefs/format";

export interface TimelineSpan {
  meeting: BriefMeeting;
  /** Stable per meeting: its id, else title|start. */
  key: string;
  start: number;
  end: number;
  /** Starts after the save: drawn solid, listed with its prep line. */
  upcoming: boolean;
}

export interface TimelineModel {
  /** Axis bounds, minutes since ET midnight, on whole hours. */
  S: number;
  E: number;
  spans: TimelineSpan[];
  /** Unbooked stretches of the work window after the save, at least MIN_FREE_MINUTES long. */
  free: Array<{ start: number; end: number }>;
  freeMinutes: number;
  /** Where the save marker sits; never left of the axis (a 7:30 save sits at the start). */
  marker: number | null;
  withNotes: number;
  upcoming: number;
  /** Upcoming meetings that have tasks preparing for them. */
  withPrep: number;
}

export const MIN_FREE_MINUTES = 30;

export function meetingKey(meeting: Pick<BriefMeeting, "id" | "title" | "start">): string {
  return meeting.id ?? `${meeting.title}|${meeting.start}`;
}

export function hasNotes(meeting: BriefMeeting): boolean {
  return Boolean(meeting.id && meeting.has_notes);
}

function workWindow(): { start: number; end: number } {
  return {
    start: Math.round(DEFAULT_WORKDAY_CONFIG.focusWindowStartHour * 60),
    end: Math.round(DEFAULT_WORKDAY_CONFIG.focusWindowEndHour * 60),
  };
}

export function buildDayTimeline(meetings: BriefMeeting[], savedAt: string): TimelineModel {
  const savedMs = Date.parse(savedAt);
  const spans = meetings
    .map((meeting): TimelineSpan | null => {
      const start = etMinutes(meeting.start);
      if (start === null) return null;
      const end = Math.max(start, etMinutes(meeting.end) ?? start);
      const startMs = Date.parse(meeting.start);
      const upcoming = Number.isFinite(savedMs) && Number.isFinite(startMs) && startMs > savedMs;
      return { meeting, key: meetingKey(meeting), start, end, upcoming };
    })
    .filter((span): span is TimelineSpan => span !== null);
  const saved = etMinutes(savedAt);

  const first = Math.min(8 * 60, ...spans.map((span) => span.start));
  const last = Math.max(17 * 60, ...spans.map((span) => span.end), saved ?? 0);
  const S = Math.floor(first / 60) * 60;
  const E = Math.ceil(last / 60) * 60;
  const marker = saved === null ? null : Math.max(saved, S);

  // Free time: the rest of the work window after the save, minus every meeting still ahead or under way.
  const window = workWindow();
  const free: Array<{ start: number; end: number }> = [];
  let cursor = Math.max(window.start, marker ?? window.start);
  const busy = spans
    .filter((span) => span.end > cursor)
    .map((span) => ({ start: span.start, end: span.end }))
    .sort((a, b) => a.start - b.start);
  for (const block of busy) {
    const gapEnd = Math.min(block.start, window.end);
    if (gapEnd - cursor >= MIN_FREE_MINUTES) free.push({ start: cursor, end: gapEnd });
    cursor = Math.max(cursor, block.end);
    if (cursor >= window.end) break;
  }
  if (window.end - cursor >= MIN_FREE_MINUTES) free.push({ start: cursor, end: window.end });

  const upcomingSpans = spans.filter((span) => span.upcoming);
  return {
    S,
    E,
    spans,
    free,
    freeMinutes: free.reduce((total, block) => total + (block.end - block.start), 0),
    marker,
    withNotes: spans.filter((span) => !span.upcoming && hasNotes(span.meeting)).length,
    upcoming: upcomingSpans.length,
    withPrep: upcomingSpans.filter((span) => (span.meeting.task_ids?.length ?? 0) > 0).length,
  };
}

/** "5h 30m", "45m", "2h": rounded to 5 minutes so a save at 8:01 doesn't read "5h 29m". */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The timeline tile's heading, e.g. "3 on the calendar, 1 with prep tracked · free 5h 30m". */
export function timelineHeading(model: TimelineModel): string {
  const parts = [`${model.spans.length} on the calendar`];
  // Notes only exist for meetings that already happened; a day with nothing ahead keeps the notes count.
  if (model.upcoming < model.spans.length || model.upcoming === 0) parts.push(`${model.withNotes} with notes`);
  if (model.withPrep) parts.push(`${model.withPrep} with prep tracked`);
  const head = parts.join(", ");
  return model.freeMinutes ? `${head} · free ${formatDuration(model.freeMinutes)}` : head;
}
