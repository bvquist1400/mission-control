/**
 * Multi-day tasks (Baseline task 6f87add5, slice S1): the pure rules for a task
 * with a start date and a due date. No database, no React: the API, the briefs
 * and (S2) the card fill all read the same answers from here.
 *
 * Brent's picks (design c37d72d9, 10/22; build OK 10/26):
 * - The due date IS the end of the range; the start date is optional (063).
 * - Late only after the due date has passed. A task between its start and due
 *   dates is never overdue (`isPastDue`, `isTaskLate`).
 * - "Day X of Y": work tasks count Mon–Fri; personal tasks ("weekends only for
 *   personal": the `personal` tag on the task or its project, the repo's usual
 *   rule, `isPersonalTaskOrProject`) count every day (`rangeOf`, `dayOfRange`).
 * - Progress = ticked checklist rows ÷ all rows, weighted by the rows' units
 *   (pace tracking's `unit_count`) when rows carry them ("weighted if its
 *   available"), else every row counts the same (`checklistProgress`).
 * - Behind pace = share of the range's days gone minus share of the work done is
 *   20 points or more (`BEHIND_PACE_GAP`). A hint only: never late, never red.
 * - Last step ticked: `allStepsDone` lights up the Done button; the task stays
 *   open until Brent presses it (nothing here closes a task).
 *
 * Dates are ET calendar dates (`RANGE_TIME_ZONE`), like the cascade's working
 * days and the Today page. "Today" always comes from the caller's `now`.
 *
 * For S2: build the card from `taskRangeState(task, checklistRows, now)`; it
 * returns everything a card needs (kind, day X of Y, elapsed and progress
 * fractions, behind pace, all steps done) plus `rangeChipText(state)` for the
 * chip words.
 */
import { addDateOnlyDays, getDateOnlyWeekday, toUtcDateMs } from './date-only';
import { isPersonalTaskOrProject } from './personal-exclusion';

export const RANGE_TIME_ZONE = 'America/New_York';
/** Behind pace when (share of days gone) − (share of work done) is at least this (Brent 10/22: 20 points). */
export const BEHIND_PACE_GAP = 0.2;
/** Statuses that are never late (closed, or parked on purpose). */
export const NEVER_LATE_STATUSES: ReadonlyArray<string> = ['Done', 'Missed', 'Parked'];

/** Which days a range counts: work tasks Mon–Fri, personal tasks every day. */
export type RangeCalendar = 'weekdays' | 'all_days';

/** The task fields the rules read (a Task row, a TaskWithImplementation or a slimmer select). */
export interface RangeTaskInput {
  start_at?: string | null;
  due_at: string | null;
  status?: string | null;
  tags?: string[] | null;
  /** The task's project; its `personal` tag counts like the task's own. */
  project?: unknown;
}

/** The checklist fields progress reads (task_checklist_items). */
export interface ChecklistRowInput {
  is_done: boolean;
  unit_count?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-9;

const etDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: RANGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The ET calendar date (YYYY-MM-DD) of an instant, or null when it isn't a timestamp. */
export function etDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(etDateFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's ET date for `now`. */
export function etToday(now: Date): string {
  return etDate(now.toISOString()) as string;
}

// ── Late ──────────────────────────────────────────────────────────────────

/**
 * The one "late" test: the due instant has passed. A start date never makes a
 * task late; a task inside its range is not late. Briefs, reviews and detectors
 * all use this.
 */
export function isPastDue(dueAt: string | null | undefined, now: Date): boolean {
  if (!dueAt) return false;
  const dueMs = Date.parse(dueAt);
  return Number.isFinite(dueMs) && dueMs < now.getTime();
}

/** An open task (not Done, Missed or Parked) whose due date has passed. */
export function isTaskLate(task: Pick<RangeTaskInput, 'due_at' | 'status'>, now: Date): boolean {
  if (task.status && NEVER_LATE_STATUSES.includes(task.status)) return false;
  return isPastDue(task.due_at, now);
}

// ── The start ≤ due rule (API + migration 063) ────────────────────────────

/** The plain error for a start date after the due date (API 400, task window). */
export const START_AFTER_DUE_ERROR = "The start date can't be after the due date.";
/** Task window hint for a start already saved after the due (an Undo or a FamCal due move). */
export const SAVED_START_AFTER_DUE_HINT = "The start date is after the due date, so this reads as a one-day task. Change either date to fix it.";
/** The name 063's trigger reports with errcode 23514. */
export const START_AT_GUARD_CONSTRAINT = 'tasks_start_at_before_due_at';

/** True when both instants are set and the start is after the due date (the rule 063 enforces). */
export function startIsAfterDue(startAt: string | null | undefined, dueAt: string | null | undefined): boolean {
  if (!startAt || !dueAt) return false;
  const startMs = Date.parse(startAt);
  const dueMs = Date.parse(dueAt);
  return Number.isFinite(startMs) && Number.isFinite(dueMs) && startMs > dueMs;
}

/** A database error from 063's guard (a write that set start_at after due_at). */
export function isStartAfterDueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === '23514' && typeof message === 'string' && message.includes('start_at must be on or before due_at');
}

/** PATCH /api/tasks/[id] when the date it didn't write changed after it was read (409). */
export const TASK_DATES_CHANGED_ERROR = "The task's dates changed since it was read, so nothing was saved; reload it and try again";

/**
 * The compare-and-set a date PATCH adds to its UPDATE: the date it doesn't
 * write, as it was read (the start ≤ due check used it). A due move keys on the
 * start, a start move on the due; a PATCH with both dates (or neither), or no
 * task read (the FamCal key passes null), keys on nothing.
 */
export function expectedOtherDate(
  current: { start_at?: string | null; due_at?: string | null } | null,
  updates: Record<string, unknown>
): Array<['start_at' | 'due_at', string | null]> {
  if (!current) return [];
  const writesStart = 'start_at' in updates;
  const writesDue = 'due_at' in updates;
  if (writesDue && !writesStart) return [['start_at', current.start_at ?? null]];
  if (writesStart && !writesDue) return [['due_at', current.due_at ?? null]];
  return [];
}

/** Two stored instants (or both null) are the same moment. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Date.parse(a) === Date.parse(b);
}

// ── Day counting ──────────────────────────────────────────────────────────

/** Work tasks count Mon–Fri; personal tasks (task or project tagged `personal`) count every day. */
export function rangeCalendarFor(task: Pick<RangeTaskInput, 'tags' | 'project'>): RangeCalendar {
  return isPersonalTaskOrProject({ tags: task.tags ?? null, project: task.project }) ? 'all_days' : 'weekdays';
}

function isCounted(dateOnly: string, calendar: RangeCalendar): boolean {
  if (calendar === 'all_days') return true;
  const weekday = getDateOnlyWeekday(dateOnly);
  return weekday !== null && weekday !== 0 && weekday !== 6;
}

/** Days counted in [from, to], both included (0 when `to` is before `from` or a date is invalid). */
export function countRangeDays(from: string, to: string, calendar: RangeCalendar): number {
  const fromMs = toUtcDateMs(from);
  const toMs = toUtcDateMs(to);
  if (fromMs === null || toMs === null || toMs < fromMs) return 0;
  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (calendar === 'all_days') return days;
  const fullWeeks = Math.floor(days / 7);
  let count = fullWeeks * 5;
  // The few days left over (at most 6), walked one by one.
  for (let offset = fullWeeks * 7; offset < days; offset += 1) {
    const date = addDateOnlyDays(from, offset);
    if (date && isCounted(date, 'weekdays')) count += 1;
  }
  return count;
}

export interface TaskRange {
  /** ET date of start_at, or null when the task has no (usable) start date. */
  startDate: string | null;
  /** ET date of due_at. */
  dueDate: string;
  /** True when the task spans more than one day: a start date before the due date. */
  isRange: boolean;
  /** The days this range counts (see `rangeCalendarFor`; a work range with no weekday in it counts every day). */
  calendar: RangeCalendar;
  /** "Y" in "Day X of Y": counted days from start to due, both included (1 for a one-day task). */
  totalDays: number;
}

/**
 * The task's range, or null without a due date. A start on or after the due
 * date (possible only via a due-only write such as a cascade Undo: the API and
 * 063 refuse it otherwise) is a one-day task on the due date.
 */
export function rangeOf(task: RangeTaskInput): TaskRange | null {
  const dueDate = etDate(task.due_at);
  if (!dueDate) return null;
  const startDate = etDate(task.start_at ?? null);
  const isRange = Boolean(startDate && startDate < dueDate);
  if (!isRange || !startDate) {
    return { startDate: startDate && startDate <= dueDate ? startDate : null, dueDate, isRange: false, calendar: rangeCalendarFor(task), totalDays: 1 };
  }
  let calendar = rangeCalendarFor(task);
  let totalDays = countRangeDays(startDate, dueDate, calendar);
  if (totalDays === 0) {
    // A work task set Sat → Sun: no weekday to count, so count the days themselves.
    calendar = 'all_days';
    totalDays = countRangeDays(startDate, dueDate, calendar);
  }
  return { startDate, dueDate, isRange: true, calendar, totalDays };
}

export interface RangeDay {
  /** "X" in "Day X of Y": counted days from the start through today (on a skipped weekend, the Friday's number). */
  day: number;
  /** "Y": counted days in the whole range. */
  of: number;
  /** Counted days fully gone: those before today (the elapsed share is daysGone ÷ of). */
  daysGone: number;
}

/**
 * Where today falls in a multi-day range: null when the task isn't a range or
 * today is outside it (before the start, or after the due date).
 */
export function dayOfRange(range: TaskRange | null, today: string): RangeDay | null {
  if (!range || !range.isRange || !range.startDate) return null;
  if (today < range.startDate || today > range.dueDate) return null;
  const day = Math.max(1, countRangeDays(range.startDate, today, range.calendar));
  const yesterday = addDateOnlyDays(today, -1);
  const daysGone = yesterday ? Math.min(range.totalDays, countRangeDays(range.startDate, yesterday, range.calendar)) : 0;
  return { day: Math.min(day, range.totalDays), of: range.totalDays, daysGone };
}

// ── Progress ──────────────────────────────────────────────────────────────

export interface ChecklistProgress {
  /** Rows ticked / all rows (whole rows, for "3/5 steps"). */
  doneRows: number;
  totalRows: number;
  /** 0..1, or null without a checklist. Weighted by units when `basis` is "units". */
  fraction: number | null;
  /** "units": rows weigh their unit_count; "rows": every row the same; "none": no checklist. */
  basis: 'units' | 'rows' | 'none';
}

function positiveUnits(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Progress from the checklist. When any row carries units (pace tracking's
 * unit_count, e.g. stitches) rows weigh their units, and a row without units
 * weighs the average of the rows that have them (so "Weave in ends" still
 * counts); with no units anywhere every row counts the same.
 */
export function checklistProgress(rows: ReadonlyArray<ChecklistRowInput>): ChecklistProgress {
  const totalRows = rows.length;
  const doneRows = rows.filter((row) => row.is_done).length;
  if (totalRows === 0) return { doneRows: 0, totalRows: 0, fraction: null, basis: 'none' };
  const known = rows.map((row) => positiveUnits(row.unit_count)).filter((units): units is number => units !== null);
  if (known.length === 0) return { doneRows, totalRows, fraction: doneRows / totalRows, basis: 'rows' };
  const fallback = known.reduce((sum, units) => sum + units, 0) / known.length;
  let total = 0;
  let done = 0;
  for (const row of rows) {
    const weight = positiveUnits(row.unit_count) ?? fallback;
    total += weight;
    if (row.is_done) done += weight;
  }
  return { doneRows, totalRows, fraction: total > 0 ? done / total : null, basis: 'units' };
}

/** Behind pace: days gone share minus work done share is at least BEHIND_PACE_GAP. */
export function isBehindPace(elapsed: number, progress: number): boolean {
  return elapsed - progress >= BEHIND_PACE_GAP - EPSILON;
}

// ── The whole state, for a card ───────────────────────────────────────────

/**
 * - `none`: no due date.
 * - `closed`: Done / Missed / Parked (never late).
 * - `late`: open and the due date has passed (red).
 * - `due_today`: due today (a range shows "Day Y of Y").
 * - `in_range`: a range that has started and isn't due yet (violet "Day X of Y").
 * - `before_start`: a range that hasn't started.
 * - `upcoming`: a one-day task due later.
 */
export type TaskRangeKind = 'none' | 'closed' | 'late' | 'due_today' | 'in_range' | 'before_start' | 'upcoming';

export interface TaskRangeState {
  kind: TaskRangeKind;
  range: TaskRange | null;
  /** Today within the range (in_range / due_today on a range), else null. */
  day: RangeDay | null;
  /** Share of the range's days gone, 0..1 (late = 1, before the start = 0; null for a one-day task or no due date). */
  elapsed: number | null;
  /** Checklist progress (Done = every row's worth, fraction 1). */
  progress: ChecklistProgress;
  /** Progress share 0..1 (a Done task is 1), or null without a checklist. */
  progressFraction: number | null;
  /** The behind-pace hint (only an open range that has started, isn't late, and has a checklist). */
  behindPace: boolean;
  /** Every checklist row is ticked: light up the Done button (the task stays open until it's pressed). */
  allStepsDone: boolean;
}

export function taskRangeState(
  task: RangeTaskInput,
  checklistRows: ReadonlyArray<ChecklistRowInput>,
  now: Date
): TaskRangeState {
  const range = rangeOf(task);
  const progress = checklistProgress(checklistRows);
  const isDone = task.status === 'Done';
  const progressFraction = isDone ? 1 : progress.fraction;
  const allStepsDone = progress.totalRows > 0 && progress.doneRows === progress.totalRows;
  const today = etToday(now);
  const base = { range, progress, progressFraction, allStepsDone };

  if (!range) return { ...base, kind: task.status && NEVER_LATE_STATUSES.includes(task.status) ? 'closed' : 'none', day: null, elapsed: null, behindPace: false };
  if (task.status && NEVER_LATE_STATUSES.includes(task.status)) {
    return { ...base, kind: 'closed', day: null, elapsed: null, behindPace: false };
  }
  if (isPastDue(task.due_at, now)) {
    return { ...base, kind: 'late', day: null, elapsed: range.isRange ? 1 : null, behindPace: false };
  }
  if (!range.isRange || !range.startDate) {
    return { ...base, kind: range.dueDate === today ? 'due_today' : 'upcoming', day: null, elapsed: null, behindPace: false };
  }
  if (today < range.startDate) {
    return { ...base, kind: 'before_start', day: null, elapsed: 0, behindPace: false };
  }
  const day = dayOfRange(range, today);
  const elapsed = day ? day.daysGone / day.of : 0;
  const behindPace = progress.fraction !== null && isBehindPace(elapsed, progress.fraction);
  return { ...base, kind: range.dueDate === today ? 'due_today' : 'in_range', day, elapsed, behindPace };
}

// ── Words ─────────────────────────────────────────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayName(dateOnly: string): string {
  const weekday = getDateOnlyWeekday(dateOnly);
  return weekday === null ? dateOnly : WEEKDAY_NAMES[weekday];
}

function monthDay(dateOnly: string): string {
  return `${Number(dateOnly.slice(5, 7))}/${Number(dateOnly.slice(8, 10))}`;
}

/** "Mon–Fri" for a range inside one week, else "10/26–11/6". */
export function rangeSpanText(range: TaskRange): string {
  if (!range.startDate) return dayName(range.dueDate);
  const startMs = toUtcDateMs(range.startDate) ?? 0;
  const dueMs = toUtcDateMs(range.dueDate) ?? 0;
  return dueMs - startMs < 7 * DAY_MS
    ? `${dayName(range.startDate)}–${dayName(range.dueDate)}`
    : `${monthDay(range.startDate)}–${monthDay(range.dueDate)}`;
}

/**
 * The chip words (mockup c37d72d9): "Mon–Fri · Day 4 of 5", "Due today · Day 5
 * of 5", "Starts Wed 10/28", "Overdue · Mon–Fri ended Fri". Null when the task needs no
 * range chip (no due date, closed, or a one-day task: those keep today's chips).
 */
export function rangeChipText(state: TaskRangeState): string | null {
  const range = state.range;
  if (!range || !range.isRange || !range.startDate) return null;
  switch (state.kind) {
    case 'in_range':
      return state.day ? `${rangeSpanText(range)} · Day ${state.day.day} of ${state.day.of}` : rangeSpanText(range);
    case 'due_today':
      return state.day ? `Due today · Day ${state.day.day} of ${state.day.of}` : 'Due today';
    case 'before_start':
      return `Starts ${dayName(range.startDate)} ${monthDay(range.startDate)}`;
    case 'late':
      return `Overdue · ${rangeSpanText(range)} ended ${dayName(range.dueDate)}`;
    default:
      return null;
  }
}
