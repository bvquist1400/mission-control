// Which version of a work digest note a brief has (Baseline task 5dbe87fd).
// Re-filing the digest from the work PC updates the SAME note (same id, newer
// updated_at), so "the brief recorded this note id" is not enough: the brief
// has the note's current text only if the note wasn't updated after the brief
// was last built or refreshed. Pure and browser-safe; used by brief_status,
// get_brief_digest's in_morning_brief and the refresh's append rule.
//
// Any time that is missing or unreadable falls back to the id-only rule (the
// behaviour before this change): a recorded note counts as current.
//
// Versions (Baseline task 483846c2): comparing the note's updated_at with the
// brief's SAVE time misses a re-file between the routine reading the note and
// saving the brief (the save is later than the re-file, so the brief looks
// current), and mixes two clocks (the database's updated_at, the app's save
// time). So a brief also records, per note, the version it was built from
// (`content.work_digest_note_versions`: note id -> that note's updated_at as
// the routine read it, or as the server read it at save time when the routine
// didn't say). "Re-filed since" is then the note's updated_at being later than
// that version: both from the database clock, so no skew. A brief with no
// version for a note (saved before this change) keeps the save-time rule.

/** ms since epoch, or null for a missing or unreadable timestamp. */
function instant(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a brief was last built or refreshed (ISO): the later of its first save
 * (`created_at`) and its newest `content.refreshes[].at`. Null when neither is
 * readable.
 */
export function briefLastBuiltAt(createdAt: string | null | undefined, refreshes: ReadonlyArray<{ at?: string | null }> | null | undefined): string | null {
  let best: { iso: string; ms: number } | null = null;
  for (const iso of [createdAt, ...(refreshes ?? []).map((entry) => entry?.at)]) {
    const ms = instant(iso);
    if (ms !== null && (best === null || ms > best.ms)) best = { iso: iso as string, ms };
  }
  return best?.iso ?? null;
}

/** Whether the note was updated strictly after the brief was last built. False when either time is unknown. */
export function noteUpdatedAfter(noteUpdatedAt: string | null | undefined, briefBuiltAt: string | null | undefined): boolean {
  const updated = instant(noteUpdatedAt);
  const built = instant(briefBuiltAt);
  return updated !== null && built !== null && updated > built;
}

/** content.work_digest_note_versions as stored or sent: note id -> the note's updated_at the brief was built from. */
export type NoteVersions = Record<string, string>;

const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A brief reads at most today's AM and PM notes; room for a hand-made copy and an old id. */
const MAX_NOTE_VERSIONS = 8;

/**
 * An updated_at as microseconds since epoch (Postgres writes microseconds;
 * Date.parse keeps only milliseconds, which could call two versions written in
 * the same millisecond equal). Null for a missing or unreadable value.
 */
export function noteVersionMicros(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(iso.trim());
  if (!match) {
    const ms = instant(iso);
    return ms === null ? null : ms * 1000;
  }
  const zone = /^[+-]\d{2}$/.test(match[3]) ? `${match[3]}:00` : match[3];
  const seconds = Date.parse(`${match[1].replace(" ", "T")}${zone}`);
  if (!Number.isFinite(seconds)) return null;
  const fraction = Number((match[2] ?? "").padEnd(6, "0").slice(0, 6));
  return seconds * 1000 + fraction;
}

/**
 * The versions a brief's content records, read leniently (a malformed entry is
 * dropped, so that note falls back to the save-time rule). Keys lower-cased.
 */
export function readNoteVersions(content: unknown): NoteVersions {
  if (!content || typeof content !== "object") return {};
  const raw = (content as { work_digest_note_versions?: unknown }).work_digest_note_versions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: NoteVersions = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_NOTE_VERSIONS) break;
    if (!UUID_KEY.test(key) || typeof value !== "string" || noteVersionMicros(value) === null) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Whether a recorded note was re-filed after the brief got its text. With a
 * recorded version: the note's updated_at is later than it (one clock, exact).
 * Without one (a brief saved before versions): the old rule, updated after the
 * brief was last built or refreshed. Unknown times: false (the id-only rule).
 */
export function noteRefiledSince(input: {
  noteUpdatedAt: string | null | undefined;
  recordedVersion?: string | null;
  briefBuiltAt: string | null | undefined;
}): boolean {
  const recorded = noteVersionMicros(input.recordedVersion);
  if (recorded !== null) {
    const current = noteVersionMicros(input.noteUpdatedAt);
    return current !== null && current > recorded;
  }
  return noteUpdatedAfter(input.noteUpdatedAt, input.briefBuiltAt);
}

/**
 * The version a save records for one note: the version the caller says it read
 * (the updated_at get_brief_digest gave it), when that is readable and not
 * later than the note's current updated_at; otherwise the current updated_at
 * (what the server reads at save time). Null when the note's current version is
 * unknown (nothing is recorded; that note keeps the save-time rule).
 *
 * Postgres keeps microseconds; a caller that copies the time cut to
 * milliseconds ("…50.217Z") or whole seconds ("…50Z") sent the current
 * version, only shorter. Recording the short value would make the note look
 * re-filed on every run (each catch-up would refresh). So a sent version that
 * is exactly the current one cut to the millisecond or to the second counts as
 * the current one (Baseline 483846c2 F1). A real re-file after the read moves
 * updated_at past that cut, so it is still caught; only a re-file in the same
 * millisecond (or, for a caller that sends whole seconds, the same second) as
 * the read could hide.
 */
export function versionToRecord(sent: string | null | undefined, current: string | null | undefined): { version: string; as_read: boolean } | null {
  const now = noteVersionMicros(current);
  if (now === null) return null;
  const read = noteVersionMicros(sent);
  if (read === null || read > now) return { version: current as string, as_read: false };
  if (read === now || read === cutTo(now, 1_000) || read === cutTo(now, 1_000_000)) return { version: current as string, as_read: true };
  return { version: sent as string, as_read: true };
}

/** `micros` cut down to a whole `step` (1,000 = the millisecond, 1,000,000 = the second). */
function cutTo(micros: number, step: number): number {
  return Math.floor(micros / step) * step;
}
