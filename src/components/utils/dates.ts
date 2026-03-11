export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DATE_SHORTCUT_REGEX = /^([twmy])\s*([+-])\s*(\d+)$/i;
const US_DATE_REGEX = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

function isValidDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseLocalDateParts(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function parseDateOnly(dateOnly: string): Date | null {
  const normalized = dateOnly.split("T")[0];
  if (!isValidDateInput(normalized)) {
    return null;
  }

  const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return parseLocalDateParts(year, month, day);
}

function localDayStamp(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseUsDateInput(value: string): string | null {
  const match = US_DATE_REGEX.exec(value.trim());
  if (!match) {
    return null;
  }

  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const rawYear = Number.parseInt(match[3], 10);
  const year = match[3].length === 2 ? 2000 + rawYear : rawYear;
  const parsed = parseLocalDateParts(year, month, day);
  return parsed ? localDateString(parsed) : null;
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12, 0, 0, 0);
}

function addLocalMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12, 0, 0, 0);
  const maxDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12, 0, 0, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), maxDay), 12, 0, 0, 0);
}

function addLocalYears(date: Date, years: number): Date {
  const targetYear = date.getFullYear() + years;
  const maxDay = new Date(targetYear, date.getMonth() + 1, 0, 12, 0, 0, 0).getDate();
  return new Date(targetYear, date.getMonth(), Math.min(date.getDate(), maxDay), 12, 0, 0, 0);
}

export interface DueDateInputResolution {
  dateOnly: string | null;
  iso: string | null;
  error: string | null;
}

export function resolveDueDateInput(value: string, baseDate: Date = new Date()): DueDateInputResolution {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { dateOnly: null, iso: null, error: null };
  }

  const keyword = trimmed.toLowerCase();
  if (keyword === "today" || keyword === "t") {
    const dateOnly = localDateString(baseDate);
    return { dateOnly, iso: localDateInputToEndOfDayIso(dateOnly), error: null };
  }

  if (keyword === "tomorrow" || keyword === "tmr") {
    const dateOnly = localDateString(addLocalDays(baseDate, 1));
    return { dateOnly, iso: localDateInputToEndOfDayIso(dateOnly), error: null };
  }

  const shortcutMatch = DATE_SHORTCUT_REGEX.exec(keyword);
  if (shortcutMatch) {
    const amount = Number.parseInt(shortcutMatch[3], 10);
    const direction = shortcutMatch[2] === "-" ? -1 : 1;
    const delta = direction * amount;
    let targetDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 12, 0, 0, 0);

    if (shortcutMatch[1].toLowerCase() === "t") {
      targetDate = addLocalDays(targetDate, delta);
    } else if (shortcutMatch[1].toLowerCase() === "w") {
      targetDate = addLocalDays(targetDate, delta * 7);
    } else if (shortcutMatch[1].toLowerCase() === "m") {
      targetDate = addLocalMonths(targetDate, delta);
    } else {
      targetDate = addLocalYears(targetDate, delta);
    }

    const dateOnly = localDateString(targetDate);
    return { dateOnly, iso: localDateInputToEndOfDayIso(dateOnly), error: null };
  }

  if (isValidDateInput(trimmed)) {
    const parsed = parseDateOnly(trimmed);
    if (parsed) {
      const dateOnly = localDateString(parsed);
      return { dateOnly, iso: localDateInputToEndOfDayIso(dateOnly), error: null };
    }
  }

  const usDateOnly = parseUsDateInput(trimmed);
  if (usDateOnly) {
    return { dateOnly: usDateOnly, iso: localDateInputToEndOfDayIso(usDateOnly), error: null };
  }

  return {
    dateOnly: null,
    iso: null,
    error: "Use YYYY-MM-DD, MM/DD/YYYY, or shortcuts like t+30 and w+1.",
  };
}

export function formatDateOnly(dateOnly: string | null): string {
  if (!dateOnly) {
    return "Not set";
  }

  const parsed = parseDateOnly(dateOnly);
  if (!parsed) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

export function dateOnlyToInputValue(dateOnly: string | null): string {
  if (!dateOnly) {
    return "";
  }

  const normalized = dateOnly.split("T")[0];
  return isValidDateInput(normalized) ? normalized : "";
}

export function timestampToLocalDateInputValue(iso: string | null): string {
  if (!iso) {
    return "";
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return localDateString(parsed);
}

export function localDateInputToEndOfDayIso(dateString: string): string {
  if (!isValidDateInput(dateString)) {
    return "";
  }

  const [year, month, day] = dateString.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = parseLocalDateParts(year, month, day);
  if (!parsed) {
    return "";
  }

  parsed.setHours(23, 59, 59, 999);
  return parsed.toISOString();
}

export function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const now = new Date();
  const diffDays = Math.round((localDayStamp(date) - localDayStamp(now)) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  if (diffDays < -1) return `${Math.abs(diffDays)}d ago`;
  if (diffDays <= 7) return `in ${diffDays}d`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function isPastTimestamp(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.getTime() < Date.now();
}
