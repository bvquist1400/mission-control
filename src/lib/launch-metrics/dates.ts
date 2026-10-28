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

/** Inclusive list of dates from `from` to `to` (empty when from > to; capped at ten years, 3660 days). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let current = from;
  while (current <= to && out.length < 3660) {
    out.push(current);
    current = addDays(current, 1);
  }
  return out;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * "YYYY-MM-DDTHH:MM" (or with a space) as New York wall-clock time → ISO UTC.
 * Returns null for anything else, including a time skipped by the spring DST
 * change. In the repeated autumn hour the earlier (daylight) instant wins.
 */
export function etLocalToIso(local: string): string | null {
  const match = LOCAL_DATE_TIME.exec(local.trim());
  if (!match || !isIsoDate(match[1])) {
    return null;
  }
  const [, date, hh, mm] = match;
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23 || minute > 59) {
    return null;
  }
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(`${date}T${hh}:${mm}:00Z`);
    candidate.setUTCHours(candidate.getUTCHours() + offsetHours);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: LAUNCH_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    if (`${get('year')}-${get('month')}-${get('day')}` === date && Number(get('hour')) === hour && Number(get('minute')) === minute) {
      return candidate.toISOString();
    }
  }
  return null;
}

/** ISO instant → "YYYY-MM-DDTHH:MM" New York wall-clock (for a datetime-local input). */
export function isoToEtLocal(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAUNCH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
