export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isValidDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function localDayStamp(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
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
  const parsed = new Date(year, month - 1, day, 23, 59, 59, 999);
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
