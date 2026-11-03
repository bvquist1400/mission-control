// Words for a refreshed brief and for a late work digest (Baseline task
// e8f1449d). Pure and browser-safe: the page computes the banner on the server
// (it needs "now") and the refresh line from the brief's own content.

import type { BriefEdition, BriefRefresh } from "@/lib/briefs/types";

const ET = "America/New_York";

/**
 * When each edition's catch-up run goes (ET, weekdays): it refreshes the brief
 * if a digest or a meeting came in after it was built. A schedule table, not
 * page logic: the routines' cron lives in docs/routines/*-catchup.md and must
 * match it.
 */
export const BRIEF_CATCHUP_TIME_ET: Record<BriefEdition, { hour: number; minute: number }> = {
  am: { hour: 8, minute: 45 },
  eod: { hour: 17, minute: 0 },
};

/** "8:45 AM" in ET, or "" for a bad timestamp. */
export function etClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}

function catchupLabel(edition: BriefEdition): string {
  const { hour, minute } = BRIEF_CATCHUP_TIME_ET[edition];
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** Minutes since ET midnight and the ET date of `now`. */
function etNow(now: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * The line under the heading: "Refreshed 8:45 AM: AM work digest added", plus
 * "(refreshed 3 times)" when there was more than one. Null when the brief was
 * never refreshed.
 */
export function refreshLineText(refreshes: BriefRefresh[] | undefined): string | null {
  if (!refreshes?.length) return null;
  const last = refreshes[refreshes.length - 1];
  const time = etClockTime(last.at);
  const head = time ? `Refreshed ${time}` : "Refreshed";
  const reason = last.reason ? `: ${last.reason}` : "";
  const count = refreshes.length > 1 ? ` (refreshed ${refreshes.length} times)` : "";
  return `${head}${reason}${count}`;
}

export interface LateDigestNote {
  edition: "am" | "pm";
  /** When the note was filed in Baseline (ISO), or null. */
  filed_at: string | null;
}

/**
 * The banner on a brief whose day has a work digest note it should cover but
 * doesn't record (brief_status's `needs_refresh` notes). Says when it was filed
 * and what happens next: before that day's catch-up run, "a refresh is queued";
 * after it, that it hasn't been added. Null when nothing is late.
 */
export function lateDigestBannerText(input: {
  edition: BriefEdition;
  briefDate: string;
  builtAt: string | null;
  notes: LateDigestNote[];
  now: Date;
}): string | null {
  const notes = [...input.notes].sort((a, b) => a.edition.localeCompare(b.edition));
  if (!notes.length) return null;
  const which = notes.length === 1 ? `The ${notes[0].edition.toUpperCase()} work digest` : `The ${notes.map((note) => note.edition.toUpperCase()).join(" and ")} work digests`;
  const times = notes.map((note) => etClockTime(note.filed_at)).filter(Boolean);
  const filed = times.length ? ` (filed ${times.join(" and ")})` : "";
  const builtAt = input.builtAt ? Date.parse(input.builtAt) : Number.NaN;
  const allAfter =
    Number.isFinite(builtAt) && notes.every((note) => note.filed_at !== null && Date.parse(note.filed_at) > builtAt);
  const verb = notes.length === 1 ? "is" : "are";
  const head = allAfter ? `${which} came in after this brief was built${filed}.` : `${which}${filed} ${verb} not in this brief yet.`;

  const { date, minutes } = etNow(input.now);
  const catchup = BRIEF_CATCHUP_TIME_ET[input.edition];
  const beforeCatchup = date < input.briefDate || (date === input.briefDate && minutes < catchup.hour * 60 + catchup.minute);
  const tail = beforeCatchup
    ? ` A refresh is queued for ${catchupLabel(input.edition)}.`
    : ` The catch-up run hasn't added ${notes.length === 1 ? "it" : "them"} yet. Run the catch-up again to refresh this page.`;
  return `${head}${tail}`;
}
