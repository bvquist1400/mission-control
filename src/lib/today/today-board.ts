/**
 * Today, board first (redesign S4; plan row S4, mockup d3-olive.html, NOTES.md
 * D "Today" + "Motion"). Pure rules only, so they are tested without a browser
 * (`npm run test:today-board`):
 *
 *   - where each task goes: the Overdue queue, the Waiting list (each Waiting
 *     task once) or the week board (`splitTodayBoard`);
 *   - the short Overdue queue (`railQueue`);
 *   - "Move to…": which days and undated states a card offers, and the update
 *     each one sends (`moveToChoices`, `moveUpdates`, `dueAtForBoardDay`);
 *   - the board's columns: widths with the task panel closed and open, which
 *     days fold to one "n done" line, the header counts (`dayColumns`);
 *   - the week number and labels.
 *
 * The multi-day rules stay in `task-range.ts` / `task-range-view.ts` /
 * `multi-day-board.ts` and are never re-derived here.
 */
import { etDate, isPastDue, rangeOf, type RangeTaskInput } from '../task-range';
import { addDateOnlyDays, getDateStartInTimeZone } from './week-board';

export const TODAY_BOARD_TIME_ZONE = 'America/New_York';

/** The Overdue queue shows this many cards before "Show n more". */
export const OVERDUE_RAIL_LIMIT = 5;

const CLOSED_STATUSES: ReadonlyArray<string> = ['Done', 'Missed', 'Parked'];
export const WAITING_STATUS = 'Blocked/Waiting';

export interface BoardTaskLike extends RangeTaskInput {
  id: string;
  status: string;
  due_at: string | null;
  priority_score?: number | null;
  title?: string | null;
}

// ── Dates ─────────────────────────────────────────────────────────────────

/**
 * due_at for a day picked on the board ("Move to…" or a drag): the END of that
 * ET day (23:59:59.999, DST-correct), like the brief's Tomorrow / Pick a date.
 * (The board used to send `<day>T23:59:59.999Z`, which is 7 PM in New York, so
 * a task moved to today after 7 PM was overdue at once.)
 */
export function dueAtForBoardDay(dateOnly: string): string {
  const nextStart = getDateStartInTimeZone(addDateOnlyDays(dateOnly, 1), TODAY_BOARD_TIME_ZONE);
  return new Date(nextStart.getTime() - 1).toISOString();
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcOf(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(dateOnly: string): number {
  return utcOf(dateOnly).getUTCDay();
}

/** "Thu 5" */
export function shortDayLabel(dateOnly: string): string {
  return `${WEEKDAY_SHORT[weekdayOf(dateOnly)]} ${Number(dateOnly.slice(8, 10))}`;
}

/** "Thu 5 Nov" */
export function stripDateLabel(dateOnly: string): string {
  return `${shortDayLabel(dateOnly)} ${MONTH_SHORT[Number(dateOnly.slice(5, 7)) - 1]}`;
}

/** "2 – 8 Nov", "27 Oct – 2 Nov", "29 Dec 2025 – 4 Jan 2026" across a year. */
export function weekRangeLabel(weekStart: string): string {
  const end = addDateOnlyDays(weekStart, 6);
  const sm = MONTH_SHORT[Number(weekStart.slice(5, 7)) - 1];
  const em = MONTH_SHORT[Number(end.slice(5, 7)) - 1];
  const sd = Number(weekStart.slice(8, 10));
  const ed = Number(end.slice(8, 10));
  if (weekStart.slice(0, 4) !== end.slice(0, 4)) {
    return `${sd} ${sm} ${weekStart.slice(0, 4)} – ${ed} ${em} ${end.slice(0, 4)}`;
  }
  return sm === em ? `${sd} – ${ed} ${em}` : `${sd} ${sm} – ${ed} ${em}`;
}

/** ISO 8601 week number of a date (weeks start Monday; week 1 holds the first Thursday). */
export function isoWeekNumber(dateOnly: string): number {
  const date = utcOf(dateOnly);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

// ── Where each task goes ──────────────────────────────────────────────────

function mergeById<T extends { id: string }>(first: ReadonlyArray<T>, second: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const task of [...first, ...second]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/**
 * Overdue = an open task whose due ET date is before today (its due instant has
 * passed). A task due earlier TODAY stays in today's column (shown late there):
 * the queue is for work left over from earlier days.
 */
export function isOverdueForRail(task: BoardTaskLike, todayDate: string, now: Date): boolean {
  if (!task.due_at || CLOSED_STATUSES.includes(task.status) || task.status === WAITING_STATUS) return false;
  const due = etDate(task.due_at);
  return due !== null && due < todayDate && isPastDue(task.due_at, now);
}

function compareOldestFirst(a: BoardTaskLike, b: BoardTaskLike): number {
  const aDue = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const bDue = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  const ap = a.priority_score ?? 0;
  const bp = b.priority_score ?? 0;
  if (ap !== bp) return bp - ap;
  return (a.title ?? '').localeCompare(b.title ?? '') || a.id.localeCompare(b.id);
}

export interface TodayBoardSplit<T> {
  /** Oldest due first. */
  overdue: T[];
  /** Every Blocked/Waiting task once: the Waiting read's order, then any on the board it didn't carry. */
  waiting: T[];
  /** Everything else: the week board (lane, columns, weekend). */
  board: T[];
}

/**
 * Each task has one home on Today. A Blocked/Waiting task lives only in
 * Waiting (never also on a day, in the lane or in Overdue); an overdue task
 * only in the Overdue queue; the rest on the board.
 */
export function splitTodayBoard<T extends BoardTaskLike>(input: {
  tasks: ReadonlyArray<T>;
  waiting: ReadonlyArray<T>;
  todayDate: string;
  now: Date;
}): TodayBoardSplit<T> {
  const waiting = mergeById(
    input.waiting.filter((task) => task.status === WAITING_STATUS),
    input.tasks.filter((task) => task.status === WAITING_STATUS)
  );
  const waitingIds = new Set(waiting.map((task) => task.id));
  const overdue: T[] = [];
  const board: T[] = [];
  const seen = new Set<string>();
  for (const task of input.tasks) {
    if (seen.has(task.id) || waitingIds.has(task.id)) continue;
    seen.add(task.id);
    if (CLOSED_STATUSES.includes(task.status)) continue;
    if (isOverdueForRail(task, input.todayDate, input.now)) overdue.push(task);
    else board.push(task);
  }
  overdue.sort(compareOldestFirst);
  return { overdue, waiting, board };
}

/** The short queue: the first `limit` (all when expanded) and how many are folded away. */
export function railQueue<T>(items: ReadonlyArray<T>, expanded: boolean, limit = OVERDUE_RAIL_LIMIT): { shown: T[]; hidden: number } {
  if (expanded || items.length <= limit) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/** "was due Tue", "was due Oct 28" (older than a week), for an Overdue card. */
export function overdueLabel(dueAt: string | null, todayDate: string): string | null {
  const due = etDate(dueAt);
  if (!due) return null;
  if (due >= addDateOnlyDays(todayDate, -6)) return `was due ${WEEKDAY_SHORT[weekdayOf(due)]}`;
  return `was due ${MONTH_SHORT[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))}`;
}

/** The due time a card shows ("5 PM", "10:30 AM"); null for an end-of-day due (minute :59), which the column already says. */
export function dueTimeText(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TODAY_BOARD_TIME_ZONE }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const period = parts.find((part) => part.type === 'dayPeriod')?.value ?? '';
  if (minute === '59') return null;
  return minute === '00' ? `${hour} ${period}` : `${hour}:${minute} ${period}`;
}

/**
 * The due words on a board card: "due today 5 PM" / "due today", "late · was
 * due 9 AM" once a time earlier today has passed, a bare time on other days
 * ("5 PM"; the column says the day), nothing for an end-of-day due.
 */
export function cardDueText(dueAt: string | null | undefined, todayDate: string, now: Date): { text: string | null; late: boolean } {
  const due = etDate(dueAt ?? null);
  if (!dueAt || !due) return { text: null, late: false };
  const time = dueTimeText(dueAt);
  if (due === todayDate) {
    if (isPastDue(dueAt, now)) return { text: time ? `late · was due ${time}` : 'late', late: true };
    return { text: time ? `due today ${time}` : 'due today', late: false };
  }
  return { text: time, late: false };
}

// ── The day columns ───────────────────────────────────────────────────────

export type DayTense = 'past' | 'today' | 'future';

export interface DayColumnModel {
  date: string;
  /** "Mon", "Tue" … */
  name: string;
  /** Day of the month. */
  day: number;
  tense: DayTense;
  /** Grid weight with the panel closed / open (past days fold narrow when it is open). */
  weight: number;
  weightOpen: number;
  /** The header's right-hand count: "2/2" (done of all) on a past day, "4 open" otherwise, null when empty. */
  count: string | null;
  /** A past day folds to one "n done" line while the panel is open (and always on a phone). */
  folds: boolean;
}

export function dayTense(date: string, todayDate: string): DayTense {
  if (date < todayDate) return 'past';
  if (date === todayDate) return 'today';
  return 'future';
}

/** Column weights (mockup: closed 1 / 1.55 / 1.25, open .6 / 1.65 / 1.3; a week without today is even). */
export function dayWeights(tense: DayTense, weekHasToday: boolean): { weight: number; weightOpen: number } {
  if (!weekHasToday) return { weight: 1, weightOpen: 1 };
  if (tense === 'past') return { weight: 1, weightOpen: 0.6 };
  if (tense === 'today') return { weight: 1.55, weightOpen: 1.65 };
  return { weight: 1.25, weightOpen: 1.3 };
}

/** The Mon–Fri columns of the week starting `weekStart`, with `open[i]` / `done[i]` task counts. */
export function dayColumns(weekStart: string, todayDate: string, open: ReadonlyArray<number>, done: ReadonlyArray<number>): DayColumnModel[] {
  const weekEnd = addDateOnlyDays(weekStart, 6);
  const weekHasToday = todayDate >= weekStart && todayDate <= weekEnd;
  return [0, 1, 2, 3, 4].map((index) => {
    const date = addDateOnlyDays(weekStart, index);
    const tense = dayTense(date, todayDate);
    const openCount = open[index] ?? 0;
    const doneCount = done[index] ?? 0;
    let count: string | null = null;
    if (tense === 'past') count = openCount + doneCount > 0 ? `${doneCount}/${openCount + doneCount}` : null;
    else if (openCount > 0) count = `${openCount} open`;
    return {
      date,
      name: WEEKDAY_SHORT[weekdayOf(date)],
      day: Number(date.slice(8, 10)),
      tense,
      ...dayWeights(tense, weekHasToday),
      count,
      folds: tense === 'past',
    };
  });
}

/** CSS grid track list for the weights, e.g. "minmax(0,1fr) minmax(0,1.55fr) …". */
export function gridTracks(weights: ReadonlyArray<number>): string {
  return weights.map((weight) => `minmax(0,${Number(weight.toFixed(2))}fr)`).join(' ');
}

/** The folded line: "2 done" (a past day with nothing done: "nothing done"). */
export function foldedDayText(doneCount: number): string {
  return doneCount > 0 ? `${doneCount} done` : 'nothing done';
}

// ── Move to… ──────────────────────────────────────────────────────────────

export type MoveChoiceKind = 'day' | 'backlog' | 'park';

export interface MoveChoice {
  key: string;
  kind: MoveChoiceKind;
  /** The ET day a 'day' choice moves the due date to. */
  date?: string;
  label: string;
  /** Mono hint on the right ("next week", "no date", "someday"). */
  hint?: string;
  /** The task is already due that day. */
  current?: boolean;
  disabled?: boolean;
  /** Why it is disabled (shown, and read out). */
  reason?: string;
}

export interface MoveTaskInput extends RangeTaskInput {
  status: string;
  due_at: string | null;
}

/**
 * What "Move to…" offers a card (no drag needed): today, tomorrow, the rest of
 * the shown week, the Monday after it, then two undated states (Backlog with
 * no date, Park for someday). A pick-a-date row sits under them in the menu.
 *
 * A multi-day task (a start before its due) only moves its END: days before
 * its start are disabled (the API refuses a due before the start), and the
 * undated states are left out (clearing the due would leave a start without
 * an end); its start changes in the task panel.
 */
export function moveToChoices(task: MoveTaskInput, todayDate: string, weekStart: string): MoveChoice[] {
  const weekEnd = addDateOnlyDays(weekStart, 6);
  const range = rangeOf(task);
  const startDate = range && range.isRange ? range.startDate : null;
  const currentDue = etDate(task.due_at);
  const nextMonday = addDateOnlyDays(weekStart, 7);
  const candidates = new Set<string>([todayDate, addDateOnlyDays(todayDate, 1)]);
  for (let index = 0; index < 7; index += 1) {
    const date = addDateOnlyDays(weekStart, index);
    if (date >= todayDate) candidates.add(date);
  }
  if (nextMonday > todayDate) candidates.add(nextMonday);
  const days = [...candidates].sort();
  const choices: MoveChoice[] = days.map((date) => {
    const label =
      date === todayDate
        ? `Today · ${shortDayLabel(date)}`
        : date === addDateOnlyDays(todayDate, 1)
          ? `Tomorrow · ${shortDayLabel(date)}`
          : shortDayLabel(date);
    const choice: MoveChoice = { key: `day:${date}`, kind: 'day', date, label };
    if (date > weekEnd) choice.hint = 'next week';
    if (date === currentDue) {
      choice.current = true;
      choice.disabled = true;
      choice.reason = 'already due then';
    } else if (startDate && date < startDate) {
      choice.disabled = true;
      choice.reason = `before its start (${shortDayLabel(startDate)})`;
    }
    return choice;
  });
  if (!startDate) {
    choices.push({ key: 'backlog', kind: 'backlog', label: 'Backlog', hint: 'no date', disabled: task.status === 'Backlog' && !task.due_at });
    choices.push({ key: 'park', kind: 'park', label: 'Park', hint: 'someday', disabled: task.status === 'Parked' });
  }
  return choices;
}

/** A picked date from the menu's date box, checked the same way as the listed days. */
export function pickedDateChoice(task: MoveTaskInput, date: string): MoveChoice {
  const range = rangeOf(task);
  const startDate = range && range.isRange ? range.startDate : null;
  const choice: MoveChoice = { key: `day:${date}`, kind: 'day', date, label: shortDayLabel(date) };
  if (date === etDate(task.due_at)) {
    choice.current = true;
    choice.disabled = true;
    choice.reason = 'already due then';
  } else if (startDate && date < startDate) {
    choice.disabled = true;
    choice.reason = `before its start (${shortDayLabel(startDate)})`;
  }
  return choice;
}

export type MoveUpdates =
  | { kind: 'date'; updates: { due_at: string } }
  | { kind: 'status'; updates: { status: 'Backlog'; due_at: null } | { status: 'Parked' } };

/**
 * The PATCH a choice sends. A day goes through the date cascade (the same path
 * as the task panel's Due box and the old drag); Backlog / Park are status
 * changes (clearing a date never cascades).
 */
export function moveUpdates(choice: MoveChoice): MoveUpdates {
  if (choice.kind === 'day') {
    if (!choice.date) throw new Error('A day choice needs a date');
    return { kind: 'date', updates: { due_at: dueAtForBoardDay(choice.date) } };
  }
  if (choice.kind === 'backlog') return { kind: 'status', updates: { status: 'Backlog', due_at: null } };
  return { kind: 'status', updates: { status: 'Parked' } };
}

/** The toast after an undated move ("Moved “X” to the Backlog"). */
export function moveToastText(choice: MoveChoice, title: string): string {
  const short = title.trim().length > 48 ? `${title.trim().slice(0, 47)}…` : title.trim();
  if (choice.kind === 'backlog') return `Moved “${short}” to the Backlog (no date)`;
  if (choice.kind === 'park') return `Parked “${short}”`;
  return `Moved “${short}” to ${choice.label}`;
}

// ── The one-line strip ────────────────────────────────────────────────────

export interface StripMeeting {
  title: string;
  start: string;
  end: string;
}

/** The meeting the strip names (in progress or next) and how many others are still to come today. */
export function nextMeetingOf<T extends StripMeeting>(events: ReadonlyArray<T>, nowMs: number): { next: T | null; moreLater: number } {
  const upcoming = events
    .filter((event) => {
      const end = Date.parse(event.end);
      return Number.isFinite(end) && end > nowMs;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { next: upcoming[0] ?? null, moreLater: Math.max(0, upcoming.length - 1) };
}

/** "in 40 min", "in 2h 5m", "now · 12 min left". */
export function meetingCountdown(meeting: StripMeeting, nowMs: number): string {
  const start = Date.parse(meeting.start);
  const end = Date.parse(meeting.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  if (nowMs >= start && nowMs < end) return `now · ${Math.max(1, Math.round((end - nowMs) / 60000))} min left`;
  const mins = Math.round((start - nowMs) / 60000);
  if (mins <= 0) return 'starting now';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

/** "30 min", "1h 30m". */
export function meetingLength(meeting: StripMeeting): string {
  const mins = Math.round((Date.parse(meeting.end) - Date.parse(meeting.start)) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return '';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}
