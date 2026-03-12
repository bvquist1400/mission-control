const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SprintWeekRange {
  startDate: string;
  endDate: string;
}

export function toUtcDateMs(dateOnly: string): number | null {
  const match = DATE_ONLY_REGEX.exec(dateOnly);
  if (!match) {
    return null;
  }

  const year = Number(match[0].slice(0, 4));
  const monthIndex = Number(match[0].slice(5, 7)) - 1;
  const day = Number(match[0].slice(8, 10));
  const utcMs = Date.UTC(year, monthIndex, day);
  const normalized = new Date(utcMs).toISOString().slice(0, 10);

  return normalized === dateOnly ? utcMs : null;
}

export function normalizeDateOnly(value: string): string | null {
  const trimmed = value.trim();
  if (!DATE_ONLY_REGEX.test(trimmed)) {
    return null;
  }

  return toUtcDateMs(trimmed) === null ? null : trimmed;
}

export function addDateOnlyDays(dateOnly: string, days: number): string | null {
  const startMs = toUtcDateMs(dateOnly);
  if (startMs === null || !Number.isFinite(days)) {
    return null;
  }

  return new Date(startMs + (Math.trunc(days) * DAY_MS)).toISOString().slice(0, 10);
}

export function getDateOnlyWeekday(dateOnly: string): number | null {
  const dateMs = toUtcDateMs(dateOnly);
  return dateMs === null ? null : new Date(dateMs).getUTCDay();
}

export function isDateOnlyAfter(dateOnly: string, otherDateOnly: string): boolean {
  const dateMs = toUtcDateMs(dateOnly);
  const otherDateMs = toUtcDateMs(otherDateOnly);

  return dateMs !== null && otherDateMs !== null && dateMs > otherDateMs;
}

export function getSprintWeekRange(anchorDateOnly: string): SprintWeekRange | null {
  const anchorMs = toUtcDateMs(anchorDateOnly);
  if (anchorMs === null) {
    return null;
  }

  const weekday = new Date(anchorMs).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const startMs = anchorMs + (mondayOffset * DAY_MS);

  return {
    startDate: new Date(startMs).toISOString().slice(0, 10),
    endDate: new Date(startMs + (4 * DAY_MS)).toISOString().slice(0, 10),
  };
}

export function resolveSprintWeekRange(startDate: string, endDate: string): SprintWeekRange | null {
  const normalizedStart = normalizeDateOnly(startDate);
  const normalizedEnd = normalizeDateOnly(endDate);
  if (!normalizedStart || !normalizedEnd) {
    return null;
  }

  const startRange = getSprintWeekRange(normalizedStart);
  const endRange = getSprintWeekRange(normalizedEnd);
  if (!startRange || !endRange || startRange.startDate !== endRange.startDate) {
    return null;
  }

  return startRange;
}

export function isMondayToFridaySprintRange(startDate: string, endDate: string): boolean {
  const range = resolveSprintWeekRange(startDate, endDate);
  return range !== null && range.startDate === startDate && range.endDate === endDate;
}
