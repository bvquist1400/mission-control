// Brief pages render in ET on both server and client (explicit time zone, so
// hydration matches regardless of the viewer's clock).

const ET = "America/New_York";

const timeParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes since ET midnight, or null for an unparseable timestamp. */
export function etMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = timeParts.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

/** "8:15", "1:01" — the mockup's compact 12-hour clock without AM/PM. */
export function etClock(iso: string | null | undefined): string {
  const minutes = etMinutes(iso);
  if (minutes === null) return "";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")}`;
}

/** "4:15 PM". */
export function etTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}

/** "Thu, Sep 24" from a YYYY-MM-DD date. */
export function dateHeading(dateOnly: string): string {
  const date = new Date(`${dateOnly}T12:00:00Z`);
  return date.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export function hourTick(hour: number): string {
  if (hour === 12) return "12p";
  return hour > 12 ? `${hour - 12}p` : `${hour}a`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
