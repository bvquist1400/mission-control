/**
 * Today v2 (Brent 11/6, mockup grocery-design-mockups/baseline-redesign/today-v2):
 * the week hides done tasks from earlier days, and a click on a day header
 * opens that day as a list at `/?day=YYYY-MM-DD`. Pure rules only, so they are
 * tested without a browser (`npm run test:today-v2`):
 *
 *   - the `?day` parameter (`parseDayParam`, `hrefWithDay`) and the week a day
 *     belongs to (`mondayOf`, `weekOffsetOf`);
 *   - the day list's groups and counts (`groupDayList`, `dayCounts`) and the
 *     seven day tabs (`dayTabs`);
 *   - a row's due words (`dayRowDue`), steps (`rowSteps`) and its status
 *     drop-down (`statusOptions`, `statusChange`);
 *   - the keys (`dayKeyAction`), a swipe (`swipeDay`) and whether Today opens
 *     straight into today's list (`isPhoneUserAgent`, `viewedDay`).
 *
 * Who goes where stays `splitTodayBoard` (today-board.ts): the day list only
 * regroups the board's tasks (and the Overdue ones due on an earlier day it
 * shows); Waiting tasks stay in Waiting.
 */
import { dayOfRange, etDate, isPastDue, rangeOf, type RangeDay, type RangeTaskInput } from '../task-range';
import { addDateOnlyDays } from './week-board';
import { dueTimeText, weekdayOf, type MoveChoice } from './today-board';

export const DAY_PARAM = 'day';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── The address ───────────────────────────────────────────────────────────

/**
 * `?day=2026-11-06` → "2026-11-06". Anything else (missing, two values, a
 * wrong shape, a day that doesn't exist like 2026-02-30, a year outside
 * 2000–2099) is null: Today shows the week.
 */
export function parseDayParam(raw: string | string[] | null | undefined): string | null {
  if (Array.isArray(raw)) return raw.length === 1 ? parseDayParam(raw[0]) : null;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

/** The same page with `day` set (or removed for null); every other parameter (`mode`, `task` …) is kept in place. */
export function hrefWithDay(pathname: string, search: string, day: string | null, hash = ''): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (day) params.set(DAY_PARAM, day);
  else params.delete(DAY_PARAM);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

/** The Monday of the week a day is in (weeks run Mon–Sun). */
export function mondayOf(dateOnly: string): string {
  const weekday = weekdayOf(dateOnly);
  return addDateOnlyDays(dateOnly, weekday === 0 ? -6 : 1 - weekday);
}

/** How many weeks a day's week is from the current one (0 = this week, -1 = last week). */
export function weekOffsetOf(dateOnly: string, currentWeekStart: string): number {
  const a = Date.parse(`${mondayOf(dateOnly)}T12:00:00Z`);
  const b = Date.parse(`${currentWeekStart}T12:00:00Z`);
  return Math.round((a - b) / (7 * 86_400_000));
}

/** "Friday" */
export function longDayName(dateOnly: string): string {
  return WEEKDAY_LONG[weekdayOf(dateOnly)];
}

/** "6 Nov" */
export function dayMonthLabel(dateOnly: string): string {
  return `${Number(dateOnly.slice(8, 10))} ${MONTH_SHORT[Number(dateOnly.slice(5, 7)) - 1]}`;
}

/** "Fri" */
export function shortDayName(dateOnly: string): string {
  return WEEKDAY_SHORT[weekdayOf(dateOnly)];
}

// ── Phone: Today opens straight into today's list ─────────────────────────

/** A phone's browser (Brent's pick: on a phone Today opens into today's list). iPad and desktop browsers are not. */
export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  if (/iPad|Tablet/i.test(userAgent)) return false;
  return /iPhone|iPod|Windows Phone/i.test(userAgent) || (/Android/i.test(userAgent) && /Mobile/i.test(userAgent));
}

/**
 * The day Today shows as a list: the `?day` one; on a phone with no `?day`,
 * today (unless "← Week" was picked); otherwise none (the week).
 */
export function viewedDay(input: { dayParam: string | null; phone: boolean; phoneWeek: boolean; todayDate: string }): string | null {
  if (input.dayParam) return input.dayParam;
  if (input.phone && !input.phoneWeek) return input.todayDate;
  return null;
}

// ── The list's groups ─────────────────────────────────────────────────────

export interface DayTaskLike extends RangeTaskInput {
  id: string;
  status: string;
  due_at: string | null;
  start_at?: string | null;
  priority_score?: number | null;
  title?: string | null;
}

export interface DayGroups<T> {
  /** One-day tasks due that day (due time, then priority). */
  due: T[];
  /** Multi-day tasks whose range covers the day (Day n of n). */
  running: T[];
  /** Done tasks due that day (Done tasks have no completion day; S4 call A). */
  done: T[];
}

function compareDue(a: DayTaskLike, b: DayTaskLike): number {
  const aDue = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const bDue = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  const ap = a.priority_score ?? 0;
  const bp = b.priority_score ?? 0;
  if (ap !== bp) return bp - ap;
  return (a.title ?? '').localeCompare(b.title ?? '') || a.id.localeCompare(b.id);
}

/** A multi-day task covering `day` (start ≤ day ≤ due on ET dates). */
export function runsThrough(task: DayTaskLike, day: string): boolean {
  const range = rangeOf(task);
  return Boolean(range && range.isRange && range.startDate && range.startDate <= day && range.dueDate >= day);
}

/**
 * One day as a list. `board` and `overdue` are splitTodayBoard's (Waiting is
 * never here); `done` is the week's Done read. A task due on an earlier day
 * that is still open lives in Overdue, and also shows on that day's own list
 * (drawn late), so the day you click shows everything that was due then.
 */
export function groupDayList<T extends DayTaskLike>(input: {
  board: ReadonlyArray<T>;
  overdue: ReadonlyArray<T>;
  done: ReadonlyArray<T>;
  day: string;
}): DayGroups<T> {
  const due: T[] = [];
  const running: T[] = [];
  const seen = new Set<string>();
  for (const task of [...input.board, ...input.overdue]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (runsThrough(task, input.day)) running.push(task);
    else if (etDate(task.due_at) === input.day) due.push(task);
  }
  const done = input.done.filter((task) => !seen.has(task.id) && etDate(task.due_at) === input.day);
  due.sort(compareDue);
  running.sort(compareDue);
  done.sort(compareDue);
  return { due, running, done };
}

export function dayCounts<T>(groups: DayGroups<T>): { due: number; running: number; done: number } {
  return { due: groups.due.length, running: groups.running.length, done: groups.done.length };
}

export interface DayTab {
  date: string;
  name: string;
  day: number;
  tense: 'past' | 'today' | 'future';
  /** "2 done" on an earlier day (its open count when nothing was done but something is still open), "4 open" today and after. */
  label: string;
}

/** The seven day tabs over the list (the week as a strip). */
export function dayTabs(weekStart: string, todayDate: string, openCount: (date: string) => number, doneCount: (date: string) => number): DayTab[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDateOnlyDays(weekStart, index);
    const tense = date < todayDate ? 'past' : date === todayDate ? 'today' : 'future';
    const open = openCount(date);
    const done = doneCount(date);
    let label: string;
    if (tense === 'past') label = open > 0 && done === 0 ? `${open} open` : `${done} done`;
    else label = `${open} open`;
    return { date, name: WEEKDAY_SHORT[weekdayOf(date)], day: Number(date.slice(8, 10)), tense, label };
  });
}

// ── A row ─────────────────────────────────────────────────────────────────

export type DayGroupKind = 'due' | 'running' | 'done';

/**
 * The row's due words: "11 AM", "all day" (an end-of-day due), "late · 9 AM"
 * once passed; a running task "to Sun →" or "ends today" / "ends Fri"; a done
 * task "done".
 */
export function dayRowDue(task: DayTaskLike, group: DayGroupKind, day: string, todayDate: string, now: Date): { text: string; late: boolean } {
  if (group === 'done') return { text: 'done', late: false };
  const late = Boolean(task.due_at && isPastDue(task.due_at, now));
  if (group === 'running') {
    const due = etDate(task.due_at);
    if (!due) return { text: '', late: false };
    // Short: the due column is narrow ("late · Thu"; "late" when it ended on the day shown).
    if (late) return { text: due === day ? 'late' : `late · ${WEEKDAY_SHORT[weekdayOf(due)]}`, late: true };
    if (due === day) return { text: day === todayDate ? 'ends today' : `ends ${WEEKDAY_SHORT[weekdayOf(due)]}`, late: false };
    const within = due <= addDateOnlyDays(day, 6);
    return { text: `to ${within ? WEEKDAY_SHORT[weekdayOf(due)] : `${WEEKDAY_SHORT[weekdayOf(due)]} ${Number(due.slice(8, 10))} ${MONTH_SHORT[Number(due.slice(5, 7)) - 1]}`} →`, late: false };
  }
  const time = dueTimeText(task.due_at);
  if (late) return { text: time ? `late · ${time}` : 'late', late: true };
  return { text: time ?? 'all day', late: false };
}

/** "Day 5 of 7" for the day shown (not today), or null. */
export function rangeDayOn(task: DayTaskLike, day: string): RangeDay | null {
  return dayOfRange(rangeOf(task), day);
}

/** Steps ticked / all (checklist rows, or an umbrella's step tasks); null without any. */
export function rowSteps(rows: ReadonlyArray<{ is_done: boolean }> | null | undefined): { done: number; total: number } | null {
  if (!rows || rows.length === 0) return null;
  return { done: rows.filter((row) => row.is_done).length, total: rows.length };
}

// ── The status drop-down ──────────────────────────────────────────────────

export interface StatusOption {
  value: string;
  label: string;
  /** "no date", "someday" */
  hint?: string;
}

const PLAIN_STATUSES: ReadonlyArray<StatusOption> = [
  { value: 'Planned', label: 'Planned' },
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Blocked/Waiting', label: 'Blocked' },
];

/**
 * What the row's status drop-down offers (mockup frame 6): Planned, In
 * Progress, Blocked, then Backlog (no date) and Park (someday). A multi-day
 * task has no Backlog / Park (like Move to…: clearing its due would leave a
 * start without an end).
 */
export function statusOptions(task: DayTaskLike): StatusOption[] {
  const range = rangeOf(task);
  const options = [...PLAIN_STATUSES];
  if (!(range && range.isRange)) {
    options.push({ value: 'Backlog', label: 'Backlog', hint: 'no date' });
    options.push({ value: 'Parked', label: 'Park', hint: 'someday' });
  }
  if (!options.some((option) => option.value === task.status)) options.unshift({ value: task.status, label: task.status });
  return options;
}

export type StatusChange =
  | { kind: 'none' }
  /** Planned / In Progress / Blocked: a status PATCH with Undo putting the old status back. */
  | { kind: 'status'; updates: { status: string }; undo: { status: string } }
  /** Backlog / Park: exactly Move to…'s choice (same PATCH and Undo). */
  | { kind: 'move'; choice: MoveChoice };

/** The write a pick in the drop-down makes (through the existing paths only). */
export function statusChange(task: DayTaskLike, value: string): StatusChange {
  if (value === task.status) return { kind: 'none' };
  if (value === 'Backlog') return { kind: 'move', choice: { key: 'backlog', kind: 'backlog', label: 'Backlog', hint: 'no date' } };
  if (value === 'Parked') return { kind: 'move', choice: { key: 'park', kind: 'park', label: 'Park', hint: 'someday' } };
  if (!PLAIN_STATUSES.some((option) => option.value === value)) return { kind: 'none' };
  return { kind: 'status', updates: { status: value }, undo: { status: task.status } };
}

/** The toast after a status pick. */
export function statusToastText(title: string, value: string): string {
  const short = title.trim().length > 48 ? `${title.trim().slice(0, 47)}…` : title.trim();
  const label = PLAIN_STATUSES.find((option) => option.value === value)?.label ?? value;
  return `“${short}” is ${label === 'Blocked' ? 'Blocked (now in Waiting)' : label}`;
}

// ── Keys and swipes ───────────────────────────────────────────────────────

export type DayKeyAction = 'prev' | 'next' | 'week' | 'up' | 'down' | null;

/**
 * Keys on the day list (listed in the ? dialog): ← / → the day before / after,
 * Esc back to the week (the open panel closes first: Esc is its key then),
 * ↑ / ↓ between rows (the panel's own ↑ / ↓ while it is open). Nothing while a
 * field has focus, a dialog or menu is up, or with a modifier key.
 */
export function dayKeyAction(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean },
  state: { typing: boolean; dialogOpen: boolean; panelOpen: boolean }
): DayKeyAction {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (state.typing || state.dialogOpen) return null;
  switch (event.key) {
    case 'ArrowLeft':
      return 'prev';
    case 'ArrowRight':
      return 'next';
    case 'Escape':
      return state.panelOpen ? null : 'week';
    case 'ArrowUp':
      return state.panelOpen ? null : 'up';
    case 'ArrowDown':
      return state.panelOpen ? null : 'down';
    default:
      return null;
  }
}

/** The next row to focus for ↑ / ↓ (no wrap; -1 = nothing focused yet). */
export function nextRowIndex(count: number, current: number, direction: 'up' | 'down'): number | null {
  if (count === 0) return null;
  if (current < 0) return direction === 'down' ? 0 : count - 1;
  const next = direction === 'down' ? current + 1 : current - 1;
  return next >= 0 && next < count ? next : null;
}

/** A sideways swipe on the phone list: left = the next day, right = the day before. */
export function swipeDay(dx: number, dy: number): 'prev' | 'next' | null {
  if (Math.abs(dx) < 60 || Math.abs(dy) > 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** The day before / after. */
export function stepDay(day: string, direction: 'prev' | 'next'): string {
  return addDateOnlyDays(day, direction === 'next' ? 1 : -1);
}

/** The day keys for the ? dialog. */
export const TODAY_DAY_KEYS: Array<{ keys: string[]; label: string }> = [
  { keys: ['←'], label: 'Day list: the day before' },
  { keys: ['→'], label: 'Day list: the day after' },
  { keys: ['↑'], label: 'Day list: the row above' },
  { keys: ['↓'], label: 'Day list: the row below' },
  { keys: ['Enter'], label: 'Day list: open the row in the panel' },
  { keys: ['Esc'], label: 'Day list: back to the week (closes the panel first)' },
];
