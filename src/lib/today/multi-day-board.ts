/**
 * Multi-day tasks S2: where the week board puts each task (pure).
 *
 * - A task with a range (start date before its due date, `rangeOf`) that
 *   overlaps Mon–Fri of the shown week goes in the "Multi-day" lane, spanning
 *   the day columns it covers (desktop) or in the "Multi-day this week" stack
 *   with an M–S day strip (phone). It is not repeated in its due-day column.
 * - A range that touches the shown week only on Sat/Sun goes in the Weekend
 *   column like a one-day task there.
 * - Every other task keeps today's rule: the column of its due date.
 */
import { rangeOf, type RangeTaskInput } from '../task-range';
import { addDateOnlyDays } from './week-board';

export const WEEKDAY_COLUMNS = 5;

export interface LanePlacement<T> {
  task: T;
  /** First and last Mon–Fri column the range covers in this week (0 = Monday). */
  startCol: number;
  endCol: number;
  /** ET start date, due date. */
  startDate: string;
  dueDate: string;
  /** The range began before Monday / ends after Friday of this week. */
  startsBeforeWeek: boolean;
  endsAfterFriday: boolean;
}

export interface WeekPlacement<T> {
  /** Ranged tasks in the lane, sorted by start date then due date. */
  lane: LanePlacement<T>[];
  /** One-day tasks due this week (the board's usual rule), for their due-day column. */
  single: T[];
  /** Ranges that touch this week only on Sat/Sun: shown in the Weekend column. */
  weekendRanges: T[];
}

type BoardTask = RangeTaskInput & { id: string };

function dayIndex(weekStart: string, date: string): number {
  for (let index = 0; index < 7; index += 1) {
    if (addDateOnlyDays(weekStart, index) === date) return index;
  }
  return date < weekStart ? -1 : 7;
}

/** True when the task's start→due range overlaps the Mon–Sun week starting `weekStart`. */
export function rangeOverlapsWeek(task: RangeTaskInput, weekStart: string): boolean {
  const range = rangeOf(task);
  if (!range || !range.isRange || !range.startDate) return false;
  const weekEnd = addDateOnlyDays(weekStart, 6);
  return range.startDate <= weekEnd && range.dueDate >= weekStart;
}

/**
 * Splits the board's tasks for the week starting `weekStart`. `isInWeek`
 * decides one-day tasks (the board's existing due-date rule); ranged tasks are
 * placed by overlap. Each task appears once.
 */
export function placeWeekTasks<T extends BoardTask>(
  tasks: ReadonlyArray<T>,
  weekStart: string,
  isInWeek: (task: T) => boolean
): WeekPlacement<T> {
  const lane: LanePlacement<T>[] = [];
  const single: T[] = [];
  const weekendRanges: T[] = [];
  const seen = new Set<string>();
  const friday = addDateOnlyDays(weekStart, 4);

  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const range = rangeOf(task);
    if (range && range.isRange && range.startDate) {
      if (!rangeOverlapsWeek(task, weekStart)) continue;
      const startIndex = dayIndex(weekStart, range.startDate);
      const dueIndex = dayIndex(weekStart, range.dueDate);
      if (startIndex > 4) {
        // Starts on the weekend: Sat/Sun only in this week.
        weekendRanges.push(task);
        continue;
      }
      lane.push({
        task,
        startCol: Math.max(0, startIndex),
        endCol: Math.min(WEEKDAY_COLUMNS - 1, dueIndex),
        startDate: range.startDate,
        dueDate: range.dueDate,
        startsBeforeWeek: startIndex < 0,
        endsAfterFriday: range.dueDate > friday,
      });
      continue;
    }
    if (isInWeek(task)) single.push(task);
  }

  lane.sort((a, b) => (a.startDate === b.startDate ? (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) : a.startDate < b.startDate ? -1 : 1));
  return { lane, single, weekendRanges };
}

/** How many lane tasks cover each Mon–Fri column (for the column counts). */
export function laneCountsByColumn<T>(lane: ReadonlyArray<LanePlacement<T>>): number[] {
  const counts = new Array(WEEKDAY_COLUMNS).fill(0) as number[];
  for (const item of lane) {
    for (let col = item.startCol; col <= item.endCol; col += 1) counts[col] += 1;
  }
  return counts;
}

/**
 * Where the dashed "time gone" mark sits on a lane card that spans only part
 * of its range: the left edge of today's column within the span, as 0–100.
 * Null when today isn't inside the span (another week, or the range is cut
 * at Friday and today is the weekend).
 */
export function laneElapsedPercent(item: LanePlacement<unknown>, weekStart: string, today: string): number | null {
  const todayIndex = dayIndex(weekStart, today);
  if (todayIndex < item.startCol || todayIndex > item.endCol) return null;
  const span = item.endCol - item.startCol + 1;
  const share = (todayIndex - item.startCol) / span;
  return share > 0 ? Math.round(share * 100) : null;
}

export interface DayStripCell {
  /** "M", "T", "W", "T", "F", "S", "S". */
  letter: string;
  /** Full name for the label ("Monday"). */
  name: string;
  inRange: boolean;
  past: boolean;
  today: boolean;
}

const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The phone card's M–S strip for the shown week. */
export function dayStrip(startDate: string, dueDate: string, weekStart: string, today: string): DayStripCell[] {
  return LETTERS.map((letter, index) => {
    const date = addDateOnlyDays(weekStart, index);
    return {
      letter,
      name: NAMES[index],
      inRange: date >= startDate && date <= dueDate,
      past: date < today,
      today: date === today,
    };
  });
}

/** "continues to Sun →" / "continues to 11/4 →" for a lane card cut at Friday. */
export function laneContinuesText(item: LanePlacement<unknown>, weekStart: string): string | null {
  if (!item.endsAfterFriday) return null;
  const index = dayIndex(weekStart, item.dueDate);
  if (index === 5) return 'continues to Sat →';
  if (index === 6) return 'continues to Sun →';
  return `continues to ${Number(item.dueDate.slice(5, 7))}/${Number(item.dueDate.slice(8, 10))} →`;
}

/** "← from 10/22" for a lane card whose range began before Monday. */
export function laneStartedText(item: LanePlacement<unknown>): string | null {
  if (!item.startsBeforeWeek) return null;
  return `← from ${Number(item.startDate.slice(5, 7))}/${Number(item.startDate.slice(8, 10))}`;
}

/**
 * Merge board task lists by id: `incoming` wins, `kept` keeps the rest. The
 * board reconciles streamed props with tasks it loaded for other weeks; a
 * range that overlaps two weeks arrives in both, so a plain concat would
 * show it twice.
 */
export function mergeTasksById<T extends { id: string }>(kept: ReadonlyArray<T>, incoming: ReadonlyArray<T>): T[] {
  const incomingIds = new Set(incoming.map((task) => task.id));
  const result: T[] = [];
  const seen = new Set<string>();
  for (const task of kept) {
    if (incomingIds.has(task.id) || seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
  }
  for (const task of incoming) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
  }
  return result;
}
