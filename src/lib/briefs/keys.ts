import { createHash } from "node:crypto";
import { addDateOnlyDays, getDateOnlyInTimeZone, getDateOnlyWeekday } from "@/lib/date-only";
import { buildRecurringDueAt } from "@/lib/recurrence";
import type { BriefEdition, BriefItemInput } from "@/lib/briefs/types";

export const BRIEF_TIME_ZONE = "America/New_York";

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Stable identity for a brief item. It must not depend on wording the model is
 * free to change between runs, or on the order items/meetings/lines arrive in.
 *
 * - proposed_task: the cited meetings plus the cited note lines (the title only
 *   when no line is cited). No date: a meeting id already pins the day, and the
 *   key doubles as the created task's external_source_id, so the same proposal
 *   can never produce two tasks across briefs.
 * - carry_over / carry_group / choice: scoped to the brief date, because the
 *   same task can legitimately need a call again on another day.
 */
export function computeBriefItemKey(edition: BriefEdition, briefDate: string, item: BriefItemInput): string {
  switch (item.kind) {
    case "proposed_task": {
      const meetings = sortedUnique(item.source.meetings.map((meeting) => meeting.id.trim()));
      const lines = sortedUnique(
        item.source.meetings.flatMap((meeting) => meeting.lines).map(normalizeText).filter(Boolean)
      );
      const basis = lines.length > 0 ? lines : [normalizeText(item.payload.title)];
      return `proposal:${shortHash({ m: meetings, b: basis })}`;
    }
    case "carry_over":
      return `${edition}:${briefDate}:carry_over:${item.task_ids[0]}`;
    case "carry_group":
      return `${edition}:${briefDate}:carry_group:${shortHash(sortedUnique(item.task_ids))}`;
    case "choice":
      return `${edition}:${briefDate}:choice:${shortHash({
        t: normalizeText(item.payload.title),
        o: sortedUnique((item.payload.options ?? []).map((option) => option.key)),
      })}`;
  }
}

/** "EOD-0924" for 2026-09-24; "EOD-09242027" when a prior year already holds the short code. */
export function buildBriefCode(edition: BriefEdition, briefDate: string, withYear = false): string {
  const [year, month, day] = briefDate.split("-");
  return `${edition.toUpperCase()}-${month}${day}${withYear ? year : ""}`;
}

export function normalizeBriefCode(value: string): string {
  return value.trim().toUpperCase();
}

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
