function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to resolve date in timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function formatUtcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour === "24" ? "0" : values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return asUtc - date.getTime();
}

export function addDateOnlyDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDateKey(result);
}

export function getDisplayedWeekRange(now: Date, timeZone: string): { start: string; end: string } {
  const todayKey = getDateInTimeZone(now, timeZone);
  const [year, month, day] = todayKey.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = todayUtc.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const start = addDateOnlyDays(todayKey, -daysFromMonday);

  return { start, end: addDateOnlyDays(start, 6) };
}

/** Start of a date in the configured timezone, expressed as a UTC instant. */
export function getDateStartInTimeZone(dateOnly: string, timeZone: string): Date {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let result = new Date(naiveUtc);

  // A second pass handles offsets that differ between the initial guess and the target date.
  for (let index = 0; index < 2; index += 1) {
    result = new Date(naiveUtc - getTimeZoneOffsetMs(result, timeZone));
  }

  return result;
}

/**
 * Whether a due instant belongs to the Monday-Sunday week displayed for `now`.
 * Date-only comparisons keep this independent of the browser's local timezone.
 */
export function isDueAtInDisplayedWeek(dueAt: string | null, now: Date, timeZone: string): boolean {
  if (!dueAt) {
    return false;
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }

  const range = getDisplayedWeekRange(now, timeZone);
  const dueKey = getDateInTimeZone(dueDate, timeZone);
  return dueKey >= range.start && dueKey <= range.end;
}

export function isDueAtInWeekStarting(
  dueAt: string | null,
  weekStart: string,
  timeZone: string
): boolean {
  if (!dueAt) {
    return false;
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }

  const dueKey = getDateInTimeZone(dueDate, timeZone);
  return dueKey >= weekStart && dueKey <= addDateOnlyDays(weekStart, 6);
}
