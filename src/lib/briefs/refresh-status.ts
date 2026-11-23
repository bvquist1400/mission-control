// brief_status (Baseline task e8f1449d): a small, cheap read that tells a
// routine whether today's brief exists and whether a work digest note it
// should cover came in after it was built, or was re-filed after it was last
// built or refreshed (Baseline task 5dbe87fd: re-filing updates the same note). Pure assembly here; the reads are
// `getBriefStatus` in service.ts. Baseline can't see Granola, so late meetings
// are the routine's own check (its Granola list against covered_meeting_ids).

import { readWorkDigestNote, workDigestEditionsForMode, type WorkDigestEdition, type WorkDigestNoteRow } from "@/lib/briefing/work-digest";
import { briefLastBuiltAt, noteRefiledSince, readNoteVersions } from "@/lib/briefs/note-version";
import type { BriefEdition, BriefRefresh } from "@/lib/briefs/types";

/**
 * Why a brief needs a refresh. One code per note it doesn't have yet:
 * `*_not_in_brief` = the brief never read it; `*_digest_updated` = it read the
 * note, but the note was re-filed (updated) after the brief was last built or
 * refreshed, so it has old text.
 */
export const REFRESH_REASONS = ["am_digest_not_in_brief", "pm_digest_not_in_brief", "am_digest_updated", "pm_digest_updated"] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

export interface DigestNoteStatus {
  /** Which digest note: "am" or "pm". */
  edition: WorkDigestEdition;
  /** "Work digest 2026-11-03 AM". */
  title: string;
  /** ok = filed and readable; missing = not filed (yet); unreadable = filed but can't be cited (it never asks for a refresh). */
  status: "ok" | "missing" | "unreadable";
  note_id: string | null;
  /** When the note was filed in Baseline (the note's created_at, ISO), or null when missing. */
  filed_at: string | null;
  /** When the note was last written (re-filing updates the same note), ISO, or null when missing or unknown. */
  updated_at: string | null;
  /** Whether this brief's content.work_digest_note_ids records it (by id, whatever its version). */
  in_brief: boolean;
  /**
   * The version of this note the brief was built from (its updated_at as the
   * routine read it, or as the server read it at save time), or null when the
   * brief didn't record one (not read, or saved before versions).
   */
  brief_version: string | null;
  /**
   * Recorded in this brief, but updated after the version it was built from
   * (or, with no version recorded, after the brief was last built or
   * refreshed): the brief has old text.
   */
  updated_since_brief: boolean;
  /** EOD's AM note only: whether this morning's AM brief recorded it (by id). */
  in_morning_brief?: boolean;
  /** EOD's AM note only: recorded by the morning brief but updated after that brief was last built or refreshed. */
  updated_since_morning_brief?: boolean;
  /** Whether this note is why a refresh is needed. */
  needs_refresh: boolean;
  /** Why, when needs_refresh; else null. */
  reason: RefreshReason | null;
}

export interface BriefStatus {
  edition: BriefEdition;
  /** The ET day (YYYY-MM-DD). */
  date: string;
  brief: {
    exists: boolean;
    code: string | null;
    /** When the brief was first saved (created_at, ISO). */
    built_at: string | null;
    /** The newest refresh, or null. */
    last_refresh: BriefRefresh | null;
    /** The later of built_at and the newest refresh (ISO): a note updated after this is news to the brief. */
    last_built_at: string | null;
    refresh_count: number;
    work_digest_note_ids: string[];
    covered_meeting_ids: string[];
  };
  /** The digest notes this edition covers: AM for the morning brief; AM and PM for the EOD. */
  digest_notes: DigestNoteStatus[];
  /** digest = a readable note this brief should cover isn't in it, or is in it with old text. False while the brief doesn't exist (build it instead). */
  refresh_needed: { digest: boolean; reasons: RefreshReason[] };
}

export interface BriefStatusRow {
  code: string;
  created_at: string;
  content: { work_digest_note_ids?: string[]; work_digest_note_versions?: Record<string, string>; refreshes?: BriefRefresh[] } | null;
  covered_meeting_ids: string[] | null;
}

/** A note row as brief_status reads it (the reader's fields plus created_at for the filed time). */
export type BriefStatusNoteRow = WorkDigestNoteRow & { created_at?: string | null };

/**
 * Which notes an edition covers and whether the brief has each one's current
 * text. The morning brief covers today's AM note. The EOD covers the PM note,
 * and the AM note only when this morning's brief doesn't have its current text
 * (the same rule the EOD routine follows with `work_digest.am.in_morning_brief`).
 *
 * A brief "has" a note when it recorded the note's id AND the note wasn't
 * updated after the version the brief recorded for it
 * (`content.work_digest_note_versions`; with none, after the brief was last
 * built or refreshed, `briefLastBuiltAt`). A missing or unreadable time on
 * either side falls back to the id alone.
 */
export function buildBriefStatus(input: {
  edition: BriefEdition;
  date: string;
  brief: BriefStatusRow | null;
  /** EOD only: this morning's AM brief (its recorded note ids), or null. */
  morningNoteIds?: string[] | null;
  /** EOD only: when this morning's AM brief was last built or refreshed (ISO); unknown = the id-only rule. */
  morningBuiltAt?: string | null;
  /** EOD only: the note versions this morning's AM brief recorded (its content.work_digest_note_versions). */
  morningNoteVersions?: Record<string, string> | null;
  notes: BriefStatusNoteRow[];
}): BriefStatus {
  const recorded = input.brief?.content?.work_digest_note_ids ?? [];
  const refreshes = input.brief?.content?.refreshes ?? [];
  const lastBuiltAt = input.brief ? briefLastBuiltAt(input.brief.created_at, refreshes) : null;
  const versions = readNoteVersions(input.brief?.content);
  const morningVersions = readNoteVersions({ work_digest_note_versions: input.morningNoteVersions ?? undefined });
  const isEod = input.edition === "eod";
  const digestNotes: DigestNoteStatus[] = [];
  const reasons: RefreshReason[] = [];

  for (const edition of workDigestEditionsForMode(isEod ? "eod" : "morning")) {
    const read = readWorkDigestNote(input.notes, input.date, edition);
    const noteId = read.status === "missing" ? null : read.note_id || null;
    const row = noteId ? input.notes.find((note) => note.id === noteId) : undefined;
    const updatedAt = row?.updated_at ?? null;
    const inBrief = noteId !== null && recorded.includes(noteId);
    const briefVersion = inBrief && noteId ? (versions[noteId.toLowerCase()] ?? null) : null;
    const updatedSinceBrief = inBrief && noteRefiledSince({ noteUpdatedAt: updatedAt, recordedVersion: briefVersion, briefBuiltAt: lastBuiltAt });
    const morningSide = isEod && edition === "am";
    const inMorningBrief = morningSide ? noteId !== null && (input.morningNoteIds ?? []).includes(noteId) : undefined;
    const updatedSinceMorning = morningSide
      ? inMorningBrief === true &&
        noteRefiledSince({ noteUpdatedAt: updatedAt, recordedVersion: noteId ? morningVersions[noteId.toLowerCase()] : null, briefBuiltAt: input.morningBuiltAt })
      : undefined;
    const briefHasIt = inBrief && !updatedSinceBrief;
    const morningHasIt = inMorningBrief === true && updatedSinceMorning !== true;
    const needsRefresh = input.brief !== null && read.status === "ok" && !briefHasIt && !morningHasIt;
    // Updated = some brief read this note and it changed since; not in brief = no brief read it.
    const updated = updatedSinceBrief || updatedSinceMorning === true;
    const reason: RefreshReason | null = needsRefresh ? (`${edition}_digest_${updated ? "updated" : "not_in_brief"}` as RefreshReason) : null;
    if (reason) reasons.push(reason);
    digestNotes.push({
      edition,
      title: read.title,
      status: read.status,
      note_id: noteId,
      filed_at: row?.created_at ?? null,
      updated_at: updatedAt,
      in_brief: inBrief,
      brief_version: briefVersion,
      updated_since_brief: updatedSinceBrief,
      ...(inMorningBrief === undefined ? {} : { in_morning_brief: inMorningBrief, updated_since_morning_brief: updatedSinceMorning === true }),
      needs_refresh: needsRefresh,
      reason,
    });
  }

  return {
    edition: input.edition,
    date: input.date,
    brief: {
      exists: input.brief !== null,
      code: input.brief?.code ?? null,
      built_at: input.brief?.created_at ?? null,
      last_refresh: refreshes.length ? refreshes[refreshes.length - 1] : null,
      last_built_at: lastBuiltAt,
      refresh_count: refreshes.length,
      work_digest_note_ids: recorded,
      covered_meeting_ids: input.brief?.covered_meeting_ids ?? [],
    },
    digest_notes: digestNotes,
    refresh_needed: { digest: reasons.length > 0, reasons },
  };
}
