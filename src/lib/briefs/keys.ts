import { createHash } from "node:crypto";
import type { BriefEdition, BriefItemInput } from "@/lib/briefs/types";

// The ET date math moved to due.ts (browser-safe); re-exported so callers keep working.
export {
  BRIEF_TIME_ZONE,
  nextWeekday,
  resolveTomorrowDate,
  resolveTomorrowDueAt,
  todayInBriefTimeZone,
} from "@/lib/briefs/due";

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
