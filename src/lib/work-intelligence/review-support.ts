import { addDateOnlyDays, getDateOnlyWeekday, normalizeDateOnly } from "@/lib/date-only";
import type { RagStatus } from "@/types/database";

export interface ReviewPeriodWindow {
  startDate: string;
  endDate: string;
  anchorDate: string;
  timezone: string;
}

export interface StoredReviewSnapshotRow<TPayload = Record<string, unknown>> {
  id: string;
  review_type: string;
  anchor_date: string;
  period_start: string;
  period_end: string;
  title: string;
  summary: string;
  source: string;
  payload: TPayload;
  created_at: string;
  updated_at: string;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}

export function latestIso(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      continue;
    }

    const iso = parsed.toISOString();
    if (!latest || iso > latest) {
      latest = iso;
    }
  }

  return latest;
}

export function getTodayDateOnlyInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function buildReviewPeriodWindow(
  anchorDate: string,
  startDate: string,
  timezone: string
): ReviewPeriodWindow {
  return {
    startDate,
    endDate: anchorDate,
    anchorDate,
    timezone,
  };
}

export function getWeekStartDate(anchorDate: string): string {
  const normalized = normalizeDateOnly(anchorDate);
  if (!normalized) {
    throw new Error("anchorDate must be YYYY-MM-DD");
  }

  const weekday = getDateOnlyWeekday(normalized);
  if (weekday === null) {
    throw new Error("anchorDate must be YYYY-MM-DD");
  }

  const offset = weekday === 0 ? -6 : 1 - weekday;
  const startDate = addDateOnlyDays(normalized, offset);
  if (!startDate) {
    throw new Error("Unable to compute week start");
  }

  return startDate;
}

export function getMonthStartDate(anchorDate: string): string {
  const normalized = normalizeDateOnly(anchorDate);
  if (!normalized) {
    throw new Error("anchorDate must be YYYY-MM-DD");
  }

  return `${normalized.slice(0, 8)}01`;
}

export function listDateRange(startDate: string, endDate: string): string[] {
  const normalizedStart = normalizeDateOnly(startDate);
  const normalizedEnd = normalizeDateOnly(endDate);
  if (!normalizedStart || !normalizedEnd || normalizedStart > normalizedEnd) {
    return [];
  }

  const dates: string[] = [];
  let cursor = normalizedStart;

  while (cursor <= normalizedEnd) {
    dates.push(cursor);
    const next = addDateOnlyDays(cursor, 1);
    if (!next) {
      break;
    }
    cursor = next;
  }

  return dates;
}

export function listBusinessDates(startDate: string, endDate: string): string[] {
  return listDateRange(startDate, endDate).filter((dateOnly) => {
    const weekday = getDateOnlyWeekday(dateOnly);
    return weekday !== null && weekday >= 1 && weekday <= 5;
  });
}

export function listWeekStartDates(startDate: string, endDate: string): string[] {
  const firstWeekStart = getWeekStartDate(startDate);
  const results: string[] = [];
  let cursor = firstWeekStart;

  while (cursor <= endDate) {
    results.push(cursor);
    const next = addDateOnlyDays(cursor, 7);
    if (!next) {
      break;
    }
    cursor = next;
  }

  return results;
}

export function countDaysSince(referenceNow: Date, iso: string | null | undefined): number {
  if (!iso) {
    return 0;
  }

  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return Math.max(0, Math.floor((referenceNow.getTime() - timestamp) / (24 * 60 * 60 * 1000)));
}

export function getSingleRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function getRagSeverity(value: RagStatus | null | undefined): number {
  switch (value) {
    case "Green":
      return 0;
    case "Yellow":
      return 1;
    case "Red":
      return 2;
    default:
      return -1;
  }
}

export function summarizeRagTrend(
  first: RagStatus | null | undefined,
  latest: RagStatus | null | undefined,
  updatesCount = 2
): "improving" | "stable" | "worsening" | "new" | "unknown" {
  if (updatesCount <= 1) {
    return "new";
  }

  const firstSeverity = getRagSeverity(first);
  const latestSeverity = getRagSeverity(latest);

  if (firstSeverity < 0 || latestSeverity < 0) {
    return "unknown";
  }

  if (latestSeverity < firstSeverity) {
    return "improving";
  }

  if (latestSeverity > firstSeverity) {
    return "worsening";
  }

  return "stable";
}
