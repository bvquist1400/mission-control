import type { SupabaseClient } from "@supabase/supabase-js";
import { isDateOnlyString } from "@/lib/briefs/due";

/**
 * The work digest (Baseline task edb01f58). Brent's Copilot writes a
 * de-identified list of what his work mail and Teams ask of him, twice a day;
 * the `baseline-digest-filer` skill on his work PC files each one as a Baseline
 * working note titled exactly "Work digest YYYY-MM-DD AM" (or "PM"): the file
 * verbatim plus a last "Filed from the Cooper digest file on <date time ET>."
 * line. The briefs read those notes through `get_brief_digest`'s
 * `work_digest` field.
 *
 * A note can be edited by hand in Baseline, so nothing in it is trusted:
 * every field is re-validated on read (counts bounded, unknown keys and
 * sections dropped, strings capped, the filer's privacy scan repeated). A note
 * that fails is `unreadable` with a reason, never thrown: a brief must still
 * build without it. The layout is the filer's contract (work-digest SKILL.md
 * section 4); the older layout without `status` and the "still waiting" list
 * is unreadable, the same as the filer would refuse it.
 */

export const WORK_DIGEST_EDITIONS = ["am", "pm"] as const;
export type WorkDigestEdition = (typeof WORK_DIGEST_EDITIONS)[number];

export const WORK_DIGEST_KINDS = ["act", "wait", "fyi", "question"] as const;
export type WorkDigestKind = (typeof WORK_DIGEST_KINDS)[number];
export const WORK_DIGEST_WHERE = ["Teams", "Mail"] as const;
export type WorkDigestWhere = (typeof WORK_DIGEST_WHERE)[number];

/** Layout limits from the Cowork skill and the filer (items ≤ 20, still waiting ≤ 10, under 10,000 characters). */
export const WORK_DIGEST_MAX_ITEMS = 20;
export const WORK_DIGEST_MAX_WAITING = 10;
/** The filer refuses a file of 10,000 characters or more; the note adds one line. Anything far over that was hand-edited. */
export const WORK_DIGEST_MAX_BODY_CHARS = 12_000;
/** The filer refuses a `what` line over 25 words. */
export const WORK_DIGEST_MAX_WHAT_WORDS = 25;

const MAX_TOPIC_CHARS = 120;
const MAX_WHAT_CHARS = 300;
const MAX_NAME_CHARS = 60;
const MAX_COUNT = 1000;
const MAX_AGE_DAYS = 3650;

export interface WorkDigestItem {
  /** "W1" … "W20". */
  block: string;
  kind: WorkDigestKind;
  /** "mine", "unclear" or "waiting-on <first name or role>", as written. */
  owner: string;
  /** The name or role after "waiting-on", else null. */
  waiting_on: string | null;
  status: "open" | "settled";
  topic: string;
  /** The item's one sentence, verbatim (a proposal cites it in source.work_digest.lines). */
  what: string;
  /** YYYY-MM-DD or null ("none"). */
  due: string | null;
  where: WorkDigestWhere;
  confirm: boolean;
  age: number;
}

export interface WorkDigestWait {
  /** "S1" … "S10". */
  block: string;
  person: string;
  topic: string;
  /** YYYY-MM-DD. */
  asked: string;
  days: number;
  where: WorkDigestWhere;
}

export interface ParsedWorkDigest {
  date: string;
  edition: WorkDigestEdition;
  window: { start: string; end: string };
  /** The filer's "Filed from the Cooper digest file on …" text (stripped from the body), or null. */
  filed_at: string | null;
  items: WorkDigestItem[];
  still_waiting: WorkDigestWait[];
  skipped_sensitive: number;
  left_out_for_length: number;
}

export type WorkDigestParse = { ok: true; value: ParsedWorkDigest } | { ok: false; reason: string };

export type WorkDigestNoteRead =
  | ({ status: "ok"; note_id: string; title: string } & ParsedWorkDigest)
  | { status: "missing"; title: string }
  | { status: "unreadable"; note_id: string; title: string; reason: string };

export type WorkDigestAmRead = WorkDigestNoteRead & {
  /**
   * EOD only: whether this morning's AM brief recorded this note in
   * `content.work_digest_note_ids` (it read it), and that brief's code. The
   * EOD uses the AM note's items only when the morning didn't.
   */
  in_morning_brief?: boolean;
  morning_brief_code?: string | null;
};

export interface WorkDigestSection {
  /** The ET day the notes are for. */
  date: string;
  am?: WorkDigestAmRead;
  pm?: WorkDigestNoteRead;
}

export function workDigestTitle(date: string, edition: WorkDigestEdition): string {
  return `Work digest ${date} ${edition.toUpperCase()}`;
}

const TITLE_PATTERN = /^Work digest (\d{4}-\d{2}-\d{2}) (AM|PM)$/;

/** The date and edition a note title names, or null when it isn't a work digest title. */
export function parseWorkDigestTitle(title: unknown): { date: string; edition: WorkDigestEdition } | null {
  if (typeof title !== "string") return null;
  const match = TITLE_PATTERN.exec(title.trim());
  if (!match || !isDateOnlyString(match[1])) return null;
  return { date: match[1], edition: match[2].toLowerCase() as WorkDigestEdition };
}

// ---------------------------------------------------------------------------
// The filer's privacy scan, repeated on read (baseline-digest-filer step 3).
// ---------------------------------------------------------------------------

const SCAN_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /[^\s@]+@[^\s@]+\.[^\s@]+/, label: "an email address" },
  { pattern: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, label: "a phone number" },
  { pattern: /\bhttps?:\/\/|\bwww\./i, label: "a web address" },
  { pattern: /\d{6,}/, label: "a run of six or more digits" },
  { pattern: /\b(?:MRN|DOB|SSN|patients?|participants?|subject\s+IDs?|passwords?|tokens?|secrets?)\b/i, label: "a word the digest must never contain" },
];

function quotedTooLong(text: string): boolean {
  const quoted = /["“”]([^"“”\n]*)["“”]/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(text))) {
    if (match[1].trim().split(/\s+/).filter(Boolean).length > 3) return true;
  }
  return false;
}

function scanProblem(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const rule of SCAN_RULES) {
      if (rule.pattern.test(line)) return `line ${index + 1} has ${rule.label}`;
    }
    if (quotedTooLong(line)) return `line ${index + 1} quotes more than three words`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FILED_LINE = /^Filed from the Cooper digest file on (.+?)\.?$/;
const KEY_VALUE = /^([a-z_]+):\s*(.*)$/;
const BLOCK_HEADING = /^##\s+(.+)$/;
const ITEM_BLOCK = /^W(\d{1,2})$/;
const WAIT_BLOCK = /^S(\d{1,2})$/;

const W_KEYS = ["kind", "owner", "status", "topic", "what", "due", "where", "confirm", "age"] as const;
const S_KEYS = ["person", "topic", "asked", "days", "where"] as const;
const HEADER_KEYS = ["date", "edition", "window", "items", "still_waiting", "skipped_sensitive", "left_out_for_length"] as const;

function cap(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() : trimmed;
}

function wholeNumber(value: string, max: number): number | null {
  if (!/^\d{1,6}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed <= max ? parsed : null;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

interface RawBlock {
  id: string;
  fields: Map<string, string>;
  duplicate: string | null;
}

/** Splits the body into header fields and `## ` blocks. Unknown keys are kept here and dropped by the readers. */
function splitBlocks(lines: string[]): { header: RawBlock; blocks: RawBlock[] } {
  const header: RawBlock = { id: "header", fields: new Map(), duplicate: null };
  const blocks: RawBlock[] = [];
  let current = header;
  for (const line of lines) {
    const heading = BLOCK_HEADING.exec(line);
    if (heading) {
      current = { id: heading[1].trim(), fields: new Map(), duplicate: null };
      blocks.push(current);
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (!pair) continue; // stray text is dropped, never passed on
    const key = pair[1];
    if (current.fields.has(key)) current.duplicate ??= key;
    else current.fields.set(key, pair[2].trim());
  }
  return { header, blocks };
}

function readItem(block: RawBlock): WorkDigestItem | string {
  const id = block.id;
  for (const key of W_KEYS) if (!block.fields.get(key)) return `${id} has no ${key} line`;
  const field = (key: (typeof W_KEYS)[number]) => block.fields.get(key) as string;

  const kind = field("kind").toLowerCase();
  if (!(WORK_DIGEST_KINDS as readonly string[]).includes(kind)) return `${id} kind must be act, wait, fyi or question`;

  const ownerRaw = field("owner").replace(/\s+/g, " ");
  let owner: string;
  let waitingOn: string | null = null;
  if (/^mine$/i.test(ownerRaw)) owner = "mine";
  else if (/^unclear$/i.test(ownerRaw)) owner = "unclear";
  else {
    const waiting = /^waiting-on\s+(.+)$/i.exec(ownerRaw);
    if (!waiting) return `${id} owner must be mine, unclear or waiting-on <name or role>`;
    waitingOn = cap(waiting[1], MAX_NAME_CHARS);
    owner = `waiting-on ${waitingOn}`;
  }

  const status = field("status").toLowerCase();
  if (status !== "open" && status !== "settled") return `${id} status must be open or settled`;

  const what = cap(field("what"), MAX_WHAT_CHARS);
  if (what.split(/\s+/).filter(Boolean).length > WORK_DIGEST_MAX_WHAT_WORDS) return `${id} what is over ${WORK_DIGEST_MAX_WHAT_WORDS} words`;

  const dueRaw = field("due");
  let due: string | null = null;
  if (dueRaw.toLowerCase() !== "none") {
    if (!isDateOnlyString(dueRaw)) return `${id} due must be none or a date written YYYY-MM-DD`;
    due = dueRaw;
  }

  const where = field("where");
  if (!(WORK_DIGEST_WHERE as readonly string[]).includes(where)) return `${id} where must be Teams or Mail`;

  const confirm = field("confirm").toLowerCase();
  if (confirm !== "yes" && confirm !== "no") return `${id} confirm must be yes or no`;

  const age = wholeNumber(field("age"), MAX_AGE_DAYS);
  if (age === null) return `${id} age must be a whole number of days`;

  return {
    block: id,
    kind: kind as WorkDigestKind,
    owner,
    waiting_on: waitingOn,
    status,
    topic: cap(field("topic"), MAX_TOPIC_CHARS),
    what,
    due,
    where: where as WorkDigestWhere,
    confirm: confirm === "yes",
    age,
  };
}

function readWait(block: RawBlock): WorkDigestWait | string {
  const id = block.id;
  for (const key of S_KEYS) if (!block.fields.get(key)) return `${id} has no ${key} line`;
  const field = (key: (typeof S_KEYS)[number]) => block.fields.get(key) as string;
  const asked = field("asked");
  if (!isDateOnlyString(asked)) return `${id} asked must be a date written YYYY-MM-DD`;
  const days = wholeNumber(field("days"), MAX_AGE_DAYS);
  if (days === null) return `${id} days must be a whole number`;
  const where = field("where");
  if (!(WORK_DIGEST_WHERE as readonly string[]).includes(where)) return `${id} where must be Teams or Mail`;
  return {
    block: id,
    person: cap(field("person"), MAX_NAME_CHARS),
    topic: cap(field("topic"), MAX_TOPIC_CHARS),
    asked,
    days,
    where: where as WorkDigestWhere,
  };
}

/**
 * Parses a work digest note body. Pure; never throws. `ok: false` carries a
 * short, plain reason that names the line or block, never its text.
 */
export function parseWorkDigestNote(body: unknown): WorkDigestParse {
  if (typeof body !== "string" || !body.trim()) return { ok: false, reason: "the note is empty" };
  if (body.length > WORK_DIGEST_MAX_BODY_CHARS) return { ok: false, reason: `the note is over ${WORK_DIGEST_MAX_BODY_CHARS} characters` };

  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  while (lines.length && !lines[lines.length - 1]) lines.pop();

  // The filer's own last line is metadata, not digest text.
  let filedAt: string | null = null;
  const last = lines[lines.length - 1] ?? "";
  const filed = FILED_LINE.exec(last);
  if (filed) {
    filedAt = cap(filed[1], 80);
    lines.pop();
  }

  const scan = scanProblem(lines);
  if (scan) return { ok: false, reason: `${scan}; the filer would have refused it` };

  const content = lines.filter(Boolean);
  if (content[0] !== "# Work digest") return { ok: false, reason: "the first line is not '# Work digest'" };

  const { header, blocks } = splitBlocks(content.slice(1));
  if (header.duplicate) return { ok: false, reason: `the header has two ${header.duplicate} lines` };
  for (const key of HEADER_KEYS) {
    if (!header.fields.get(key)) return { ok: false, reason: `the header has no ${key} line (an older digest layout?)` };
  }
  const head = (key: (typeof HEADER_KEYS)[number]) => header.fields.get(key) as string;

  const date = head("date");
  if (!isDateOnlyString(date)) return { ok: false, reason: "date must be written YYYY-MM-DD" };
  const edition = head("edition").toLowerCase();
  if (edition !== "am" && edition !== "pm") return { ok: false, reason: "edition must be am or pm" };
  const windowMatch = /^(\S+)\s+to\s+(\S+)$/.exec(head("window"));
  if (!windowMatch || !isIsoTimestamp(windowMatch[1]) || !isIsoTimestamp(windowMatch[2])) {
    return { ok: false, reason: "window must be '<ISO time> to <ISO time>'" };
  }

  const itemCount = wholeNumber(head("items"), WORK_DIGEST_MAX_ITEMS);
  if (itemCount === null) return { ok: false, reason: `items must be a whole number up to ${WORK_DIGEST_MAX_ITEMS}` };
  const waitCount = wholeNumber(head("still_waiting"), WORK_DIGEST_MAX_WAITING);
  if (waitCount === null) return { ok: false, reason: `still_waiting must be a whole number up to ${WORK_DIGEST_MAX_WAITING}` };
  const skipped = wholeNumber(head("skipped_sensitive"), MAX_COUNT);
  if (skipped === null) return { ok: false, reason: "skipped_sensitive must be a whole number" };
  const leftOut = wholeNumber(head("left_out_for_length"), MAX_COUNT);
  if (leftOut === null) return { ok: false, reason: "left_out_for_length must be a whole number" };

  const items: WorkDigestItem[] = [];
  const waits: WorkDigestWait[] = [];
  for (const block of blocks) {
    const itemMatch = ITEM_BLOCK.exec(block.id);
    const waitMatch = WAIT_BLOCK.exec(block.id);
    if (!itemMatch && !waitMatch) continue; // an unknown section is dropped with its lines
    if (block.duplicate) return { ok: false, reason: `${block.id} has two ${block.duplicate} lines` };
    if (itemMatch) {
      if (waits.length) return { ok: false, reason: `${block.id} comes after the still-waiting blocks` };
      if (Number(itemMatch[1]) !== items.length + 1) return { ok: false, reason: `${block.id} is out of order (expected W${items.length + 1})` };
      if (items.length >= WORK_DIGEST_MAX_ITEMS) return { ok: false, reason: `more than ${WORK_DIGEST_MAX_ITEMS} W blocks` };
      const item = readItem(block);
      if (typeof item === "string") return { ok: false, reason: item };
      items.push(item);
    } else if (waitMatch) {
      if (Number(waitMatch[1]) !== waits.length + 1) return { ok: false, reason: `${block.id} is out of order (expected S${waits.length + 1})` };
      if (waits.length >= WORK_DIGEST_MAX_WAITING) return { ok: false, reason: `more than ${WORK_DIGEST_MAX_WAITING} S blocks` };
      const wait = readWait(block);
      if (typeof wait === "string") return { ok: false, reason: wait };
      waits.push(wait);
    }
  }
  if (items.length !== itemCount) return { ok: false, reason: `items says ${itemCount} but the note has ${items.length} W blocks` };
  if (waits.length !== waitCount) return { ok: false, reason: `still_waiting says ${waitCount} but the note has ${waits.length} S blocks` };

  return {
    ok: true,
    value: {
      date,
      edition,
      window: { start: windowMatch[1], end: windowMatch[2] },
      filed_at: filedAt,
      items,
      still_waiting: waits,
      skipped_sensitive: skipped,
      left_out_for_length: leftOut,
    },
  };
}

export interface WorkDigestNoteRow {
  id: string;
  title: string;
  body_markdown: string | null;
  status?: string | null;
  updated_at?: string | null;
}

/**
 * One edition's read: the note with exactly that title (the newest if a
 * hand-made copy exists), parsed, or `missing` / `unreadable`. The note's own
 * date and edition must match its title.
 */
export function readWorkDigestNote(rows: WorkDigestNoteRow[], date: string, edition: WorkDigestEdition): WorkDigestNoteRead {
  const title = workDigestTitle(date, edition);
  const note = rows
    .filter((row) => row && row.title === title && (row.status ?? "active") === "active")
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  if (!note) return { status: "missing", title };
  const parsed = parseWorkDigestNote(note.body_markdown);
  if (!parsed.ok) return { status: "unreadable", note_id: note.id, title, reason: parsed.reason };
  if (parsed.value.date !== date || parsed.value.edition !== edition) {
    return { status: "unreadable", note_id: note.id, title, reason: "the note's date or edition doesn't match its title" };
  }
  return { status: "ok", note_id: note.id, title, ...parsed.value };
}

/** Which editions a digest mode reads: the morning brief (and midday) the AM note; the EOD both. */
export function workDigestEditionsForMode(mode: string): WorkDigestEdition[] {
  return mode === "eod" ? ["am", "pm"] : ["am"];
}

/** The note ids a brief's content says it read (`content.work_digest_note_ids`). */
function recordedNoteIds(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const ids = (content as { work_digest_note_ids?: unknown }).work_digest_note_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Pure assembly of the digest's `work_digest` field from the note rows and,
 * for the EOD, this morning's AM brief (its code and content).
 */
export function buildWorkDigestSection(input: {
  date: string;
  mode: string;
  rows: WorkDigestNoteRow[];
  morningBrief?: { code: string; content: unknown } | null;
}): WorkDigestSection {
  const section: WorkDigestSection = { date: input.date };
  for (const edition of workDigestEditionsForMode(input.mode)) {
    const read = readWorkDigestNote(input.rows, input.date, edition);
    if (edition === "am") {
      if (input.mode === "eod") {
        const recorded = recordedNoteIds(input.morningBrief?.content);
        section.am = {
          ...read,
          in_morning_brief: read.status !== "missing" && "note_id" in read && recorded.includes(read.note_id),
          morning_brief_code: input.morningBrief?.code ?? null,
        };
      } else {
        section.am = read;
      }
    } else {
      section.pm = read;
    }
  }
  return section;
}

function unavailable(date: string, mode: string, reason: string): WorkDigestSection {
  const section: WorkDigestSection = { date };
  for (const edition of workDigestEditionsForMode(mode)) {
    const read: WorkDigestNoteRead = { status: "unreadable", note_id: "", title: workDigestTitle(date, edition), reason };
    if (edition === "am") section.am = read;
    else section.pm = read;
  }
  return section;
}

/**
 * Reads today's (ET) digest notes by exact title. Never throws: a failed read
 * comes back as `unreadable` so the brief still builds.
 */
export async function fetchWorkDigestSection(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  mode: string
): Promise<WorkDigestSection> {
  try {
    const titles = workDigestEditionsForMode(mode).map((edition) => workDigestTitle(date, edition));
    const { data, error } = await supabase
      .from("notes")
      .select("id, title, body_markdown, status, updated_at")
      .eq("user_id", userId)
      .eq("status", "active")
      .in("title", titles);
    if (error) throw error;

    let morningBrief: { code: string; content: unknown } | null = null;
    if (mode === "eod") {
      try {
        const { data: brief, error: briefError } = await supabase
          .from("briefs")
          .select("code, content")
          .eq("user_id", userId)
          .eq("edition", "am")
          .eq("brief_date", date)
          .maybeSingle();
        if (briefError) throw briefError;
        morningBrief = (brief as { code: string; content: unknown } | null) ?? null;
      } catch (err) {
        console.error("[digest] morning brief lookup for the work digest failed:", err);
      }
    }

    return buildWorkDigestSection({ date, mode, rows: (data ?? []) as WorkDigestNoteRow[], morningBrief });
  } catch (err) {
    console.error("[digest] work digest read failed:", err);
    return unavailable(date, mode, "the notes couldn't be read");
  }
}
