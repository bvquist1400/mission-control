/**
 * The value rules behind the shared date field (`DateField`, Baseline task
 * afe37a69, plan "Now unblocked + calendar date picker" slice S1). No React here,
 * so the rules can be tested on their own.
 *
 * - The field always hands back a plain day ("YYYY-MM-DD", or "" for none). Each
 *   screen keeps its own save rule (end of the local day for a due date, start
 *   of the day for a start date, a bare date for a target date): nothing about
 *   what a date means changes.
 * - The chips use the same day arithmetic as the typing shortcuts: Today is "t",
 *   Tomorrow "t+1", Next week "t+7" (= "w+1").
 * - In the task editor the typed shortcuts keep working (t+7, 10/26, 2026-11-04);
 *   everywhere else the field is the phone's own calendar.
 */
import {
  dateOnlyToInputValue,
  resolveDueDateInput,
  resolveStartDateInput,
  timestampToLocalDateInputValue,
  type DueDateInputResolution,
} from "./dates";
import { SAVED_START_AFTER_DUE_HINT, START_AFTER_DUE_ERROR } from "@/lib/task-range";

export type DateChip = "today" | "tomorrow" | "next_week";

export const DATE_CHIPS: ReadonlyArray<{ chip: DateChip; label: string; shortcut: string }> = [
  { chip: "today", label: "Today", shortcut: "t" },
  { chip: "tomorrow", label: "Tomorrow", shortcut: "t+1" },
  { chip: "next_week", label: "Next week", shortcut: "t+7" },
];

/** The day a chip picks, as "YYYY-MM-DD" (the same day its typing shortcut gives). */
export function chipDate(chip: DateChip, baseDate: Date = new Date()): string {
  const entry = DATE_CHIPS.find((candidate) => candidate.chip === chip);
  // The shortcuts never fail to resolve; "" only for an unknown chip name.
  return entry ? resolveDueDateInput(entry.shortcut, baseDate).dateOnly ?? "" : "";
}

/** True when a day is inside the field's optional min / max (both "YYYY-MM-DD"). */
export function withinLimits(dateOnly: string, min?: string, max?: string): boolean {
  if (!dateOnly) return false;
  if (min && dateOnly < min) return false;
  if (max && dateOnly > max) return false;
  return true;
}

export interface DateFieldResolution {
  /** The day the value stands for, or null for none / not a date. */
  dateOnly: string | null;
  /** Why a typed value isn't a date (typing mode only); null when it is fine. */
  error: string | null;
}

/**
 * What a field's value stands for. With `allowTyping` the task editor's rules
 * apply (blank, YYYY-MM-DD, MM/DD/YYYY, t / t+N / w+N / m+N / y+N). Without it
 * the value comes from the phone's picker or a chip: a "YYYY-MM-DD" day or "".
 */
export function resolveDateFieldValue(
  value: string,
  { allowTyping = false, baseDate = new Date() }: { allowTyping?: boolean; baseDate?: Date } = {},
): DateFieldResolution {
  if (allowTyping) {
    const resolution = resolveDueDateInput(value, baseDate);
    return { dateOnly: resolution.dateOnly, error: resolution.error };
  }
  const day = dateOnlyToInputValue(value.trim());
  return { dateOnly: day || null, error: null };
}

/** The value to give the phone's picker: the resolved day of whatever is in the field, or "" (opens on today). */
export function pickerValue(value: string, options: { allowTyping?: boolean; baseDate?: Date } = {}): string {
  return resolveDateFieldValue(value, options).dateOnly ?? "";
}

const WEEKDAY_MONTH_DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const WEEKDAY_MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/**
 * The read-back under the field: "Fri, Oct 30" (this year) or "Mon, Jan 4, 2027".
 * Null for no day. Read at local noon so a DST change can't move it.
 */
export function landsOnLabel(dateOnly: string | null, baseDate: Date = new Date()): string | null {
  const day = dateOnlyToInputValue(dateOnly);
  if (!day) return null;
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(year, month - 1, date, 12, 0, 0, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== date) return null;
  return (year === baseDate.getFullYear() ? WEEKDAY_MONTH_DAY : WEEKDAY_MONTH_DAY_YEAR).format(parsed);
}

export interface TaskDateDrafts {
  start: DueDateInputResolution;
  due: DueDateInputResolution;
  /** The saved days, "" for none. */
  currentStartDate: string;
  currentDueDate: string;
  hasStartDateChange: boolean;
  hasDueDateChange: boolean;
  /** The days as they would be saved (a draft that doesn't parse keeps the saved day). */
  nextStartDate: string | null;
  nextDueDate: string | null;
  /** Blocks Save: this edit changes a date and leaves the start after the due. */
  rangeError: string | null;
  /** Shown, not blocking: the start was already saved after the due (Undo / FamCal move). */
  savedRangeHint: string | null;
}

/**
 * The task editor's Start and Due drafts, whether typed, picked on the calendar
 * or set by a chip. The rules are the editor's (063 multi-day tasks):
 * start saves at the start of its day, due at the end; an empty draft clears;
 * start <= due is enforced only when this edit changes a date.
 */
export function resolveTaskDateDrafts(input: {
  startDraft: string;
  dueDraft: string;
  savedStartAt: string | null;
  savedDueAt: string | null;
  baseDate?: Date;
}): TaskDateDrafts {
  const baseDate = input.baseDate ?? new Date();
  const start = resolveStartDateInput(input.startDraft, baseDate);
  const due = resolveDueDateInput(input.dueDraft, baseDate);
  const currentStartDate = timestampToLocalDateInputValue(input.savedStartAt);
  const currentDueDate = timestampToLocalDateInputValue(input.savedDueAt);
  // An empty draft resolves to null; the saved "no date" reads as "". Both mean none.
  const hasStartDateChange = start.error === null && (start.dateOnly ?? "") !== currentStartDate;
  const hasDueDateChange = due.error === null && (due.dateOnly ?? "") !== currentDueDate;
  const nextStartDate = start.error === null ? start.dateOnly : currentStartDate || null;
  const nextDueDate = due.error === null ? due.dateOnly : currentDueDate || null;
  const rangeReversed = Boolean(nextStartDate && nextDueDate && nextStartDate > nextDueDate);
  const editsADate = hasStartDateChange || hasDueDateChange;
  return {
    start,
    due,
    currentStartDate,
    currentDueDate,
    hasStartDateChange,
    hasDueDateChange,
    nextStartDate,
    nextDueDate,
    rangeError: rangeReversed && editsADate ? START_AFTER_DUE_ERROR : null,
    savedRangeHint: rangeReversed && !editsADate ? SAVED_START_AFTER_DUE_HINT : null,
  };
}
