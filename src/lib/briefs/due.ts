// ET date math for brief actions. Pure and browser-safe (no node: imports), so
// the page can show the date a choice resolves to before Brent taps Accept.
// Every due date is the END of an ET day (23:59:59.999, DST-correct), the same
// rule the carry-over "Tomorrow" button has always used.

import { addDateOnlyDays, getDateOnlyInTimeZone, getDateOnlyWeekday, normalizeDateOnly } from "@/lib/date-only";
import { buildRecurringDueAt } from "@/lib/recurrence";

export const BRIEF_TIME_ZONE = "America/New_York";

function isWeekday(dateOnly: string): boolean {
  const weekday = getDateOnlyWeekday(dateOnly);
  return weekday !== null && weekday !== 0 && weekday !== 6;
}

export function nextWeekday(dateOnly: string): string {
  let candidate = addDateOnlyDays(dateOnly, 1);
  while (candidate && !isWeekday(candidate)) {
    candidate = addDateOnlyDays(candidate, 1);
  }
  if (!candidate) {
    throw new Error(`Invalid date: ${dateOnly}`);
  }
  return candidate;
}

export function todayInBriefTimeZone(now: Date = new Date()): string {
  return getDateOnlyInTimeZone(BRIEF_TIME_ZONE, now);
}

/**
 * The ET date "Tomorrow" means for a brief: the next weekday after the brief's
 * date. If the brief is being worked late and that day is already past (in ET,
 * never UTC), it's today when today is a weekday, else the next weekday.
 */
export function resolveTomorrowDate(briefDate: string, now: Date = new Date()): string {
  const todayEt = todayInBriefTimeZone(now);
  const target = nextWeekday(briefDate);
  if (target >= todayEt) return target;
  return isWeekday(todayEt) ? todayEt : nextWeekday(todayEt);
}

/** due_at for "Tomorrow": end of that ET day, DST-correct. */
export function resolveTomorrowDueAt(briefDate: string, now: Date = new Date()): string {
  return buildRecurringDueAt(resolveTomorrowDate(briefDate, now), BRIEF_TIME_ZONE);
}

/**
 * "This week": Friday of the current ET week (Mon–Thu), or next week's Friday
 * when today is already Friday, Saturday or Sunday.
 */
export function resolveThisWeekDate(now: Date = new Date()): string {
  const today = todayInBriefTimeZone(now);
  const weekday = getDateOnlyWeekday(today) ?? 1;
  // Sun 0 → +5, Mon 1 → +4, … Thu 4 → +1, Fri 5 → +7, Sat 6 → +6.
  const days = weekday === 0 ? 5 : weekday <= 4 ? 5 - weekday : weekday === 5 ? 7 : 6;
  return addDateOnlyDays(today, days)!;
}

// ---------------------------------------------------------------------------
// Accept's due choice
// ---------------------------------------------------------------------------

export const ACCEPT_DUE_PRESETS = ["today", "tomorrow", "this_week", "none"] as const;
export type AcceptDuePreset = (typeof ACCEPT_DUE_PRESETS)[number];

/** A preset, or a YYYY-MM-DD that must equal the proposal's suggested_due. */
export type AcceptDueChoice = AcceptDuePreset | `${number}-${number}-${number}`;

/** What Accept does when the caller sends no choice (Brent: "I don't want to miss any"). */
export const DEFAULT_ACCEPT_DUE: AcceptDuePreset = "tomorrow";

export const ACCEPT_DUE_HELP = 'due must be "today", "tomorrow", "this_week", "none" or the item\'s suggested date (YYYY-MM-DD)';

export function isAcceptDuePreset(value: unknown): value is AcceptDuePreset {
  return typeof value === "string" && (ACCEPT_DUE_PRESETS as readonly string[]).includes(value);
}

/** A real calendar date written exactly as YYYY-MM-DD (no surrounding space, no time). */
export function isDateOnlyString(value: unknown): value is string {
  return typeof value === "string" && normalizeDateOnly(value) === value;
}

/** Strict: a preset (any case, trimmed) or an exact YYYY-MM-DD; anything else, null included, is null. */
export function parseAcceptDue(value: unknown): AcceptDueChoice | null {
  if (typeof value !== "string") return null;
  const preset = value.trim().toLowerCase();
  if (isAcceptDuePreset(preset)) return preset;
  return isDateOnlyString(value) ? (value as AcceptDueChoice) : null;
}

/** The ET date a choice lands on, or null for "none". */
export function resolveAcceptDueDate(choice: AcceptDueChoice, briefDate: string, now: Date = new Date()): string | null {
  switch (choice) {
    case "none":
      return null;
    case "today":
      return todayInBriefTimeZone(now);
    case "tomorrow":
      return resolveTomorrowDate(briefDate, now);
    case "this_week":
      return resolveThisWeekDate(now);
    default:
      if (!isDateOnlyString(choice)) throw new Error(`Invalid due choice: ${choice}`);
      return choice;
  }
}

/** due_at for Accept: the end of the chosen ET day, or null for "none". */
export function resolveAcceptDueAt(choice: AcceptDueChoice, briefDate: string, now: Date = new Date()): string | null {
  const date = resolveAcceptDueDate(choice, briefDate, now);
  return date ? buildRecurringDueAt(date, BRIEF_TIME_ZONE) : null;
}

/** True when a YYYY-MM-DD is before today in ET (never UTC). Today itself is not passed. */
export function isDatePassed(dateOnly: string, now: Date = new Date()): boolean {
  return dateOnly < todayInBriefTimeZone(now);
}

/**
 * Which chip a proposal's Due row starts on. The notes' date when it is today or
 * later; Tomorrow when the notes carry no date or the date has already passed
 * (a pre-selected past date would make the task overdue the moment it's accepted).
 * The passed date stays offered as a chip, so Brent can still pick it on purpose.
 */
export function defaultAcceptDueChoice(suggestedDue: string | null, now: Date = new Date()): AcceptDueChoice {
  if (suggestedDue && isDateOnlyString(suggestedDue) && !isDatePassed(suggestedDue, now)) {
    return suggestedDue as AcceptDueChoice;
  }
  return DEFAULT_ACCEPT_DUE;
}
