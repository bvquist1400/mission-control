/**
 * Dates for launch metrics. Each source keeps its own day:
 * app database = America/New_York, website (Vercel) = UTC,
 * Search Console = Pacific time (Google's reporting day). The page labels
 * each chart with its time zone instead of converting.
 */

export const LAUNCH_TIMEZONE = 'America/New_York';
export const SEARCH_CONSOLE_TIMEZONE = 'America/Los_Angeles';

/** Menu & Market 1.0 went live 2026-10-21 13:42 ET. */
export const LAUNCH_RELEASE_AT = '2026-10-21T17:42:00Z';
export const LAUNCH_RELEASE_DATE = '2026-10-21';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function etDate(date: Date): string {
  return dateInZone(date, LAUNCH_TIMEZONE);
}

export function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Inclusive list of dates from `from` to `to` (empty when from > to; capped at 1000). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let current = from;
  while (current <= to && out.length < 1000) {
    out.push(current);
    current = addDays(current, 1);
  }
  return out;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
