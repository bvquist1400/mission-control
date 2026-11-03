// brief_status (Baseline task e8f1449d): a small, cheap read that tells a
// routine whether today's brief exists and whether a work digest note it
// should cover came in after it was built. Pure assembly here; the reads are
// `getBriefStatus` in service.ts. Baseline can't see Granola, so late meetings
// are the routine's own check (its Granola list against covered_meeting_ids).

import { readWorkDigestNote, workDigestEditionsForMode, type WorkDigestEdition, type WorkDigestNoteRow } from "@/lib/briefing/work-digest";
import type { BriefEdition, BriefRefresh } from "@/lib/briefs/types";

/** Why a brief needs a refresh. One code per note it doesn't have yet. */
export const REFRESH_REASONS = ["am_digest_not_in_brief", "pm_digest_not_in_brief"] as const;
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
  /** Whether this brief's content.work_digest_note_ids records it. */
  in_brief: boolean;
  /** EOD's AM note only: whether this morning's AM brief recorded it (then the EOD doesn't need it). */
  in_morning_brief?: boolean;
  /** Whether this note is why a refresh is needed. */
  needs_refresh: boolean;
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
    refresh_count: number;
    work_digest_note_ids: string[];
    covered_meeting_ids: string[];
  };
  /** The digest notes this edition covers: AM for the morning brief; AM and PM for the EOD. */
  digest_notes: DigestNoteStatus[];
  /** digest = a readable note this brief should cover isn't in it. False while the brief doesn't exist (build it instead). */
  refresh_needed: { digest: boolean; reasons: RefreshReason[] };
}

export interface BriefStatusRow {
  code: string;
  created_at: string;
  content: { work_digest_note_ids?: string[]; refreshes?: BriefRefresh[] } | null;
  covered_meeting_ids: string[] | null;
}

/** A note row as brief_status reads it (the reader's fields plus created_at for the filed time). */
export type BriefStatusNoteRow = WorkDigestNoteRow & { created_at?: string | null };

/**
 * Which notes an edition covers and whether each one is in the brief. The
 * morning brief covers today's AM note. The EOD covers the PM note, and the AM
 * note only when this morning's brief didn't record it (the same rule the EOD
 * routine follows with `work_digest.am.in_morning_brief`).
 */
export function buildBriefStatus(input: {
  edition: BriefEdition;
  date: string;
  brief: BriefStatusRow | null;
  /** EOD only: this morning's AM brief (its recorded note ids), or null. */
  morningNoteIds?: string[] | null;
  notes: BriefStatusNoteRow[];
}): BriefStatus {
  const recorded = input.brief?.content?.work_digest_note_ids ?? [];
  const refreshes = input.brief?.content?.refreshes ?? [];
  const isEod = input.edition === "eod";
  const digestNotes: DigestNoteStatus[] = [];
  const reasons: RefreshReason[] = [];

  for (const edition of workDigestEditionsForMode(isEod ? "eod" : "morning")) {
    const read = readWorkDigestNote(input.notes, input.date, edition);
    const noteId = read.status === "missing" ? null : read.note_id || null;
    const row = noteId ? input.notes.find((note) => note.id === noteId) : undefined;
    const inBrief = noteId !== null && recorded.includes(noteId);
    const inMorningBrief = isEod && edition === "am" ? noteId !== null && (input.morningNoteIds ?? []).includes(noteId) : undefined;
    const needsRefresh = input.brief !== null && read.status === "ok" && !inBrief && inMorningBrief !== true;
    if (needsRefresh) reasons.push(edition === "am" ? "am_digest_not_in_brief" : "pm_digest_not_in_brief");
    digestNotes.push({
      edition,
      title: read.title,
      status: read.status,
      note_id: noteId,
      filed_at: row?.created_at ?? null,
      in_brief: inBrief,
      ...(inMorningBrief === undefined ? {} : { in_morning_brief: inMorningBrief }),
      needs_refresh: needsRefresh,
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
      refresh_count: refreshes.length,
      work_digest_note_ids: recorded,
      covered_meeting_ids: input.brief?.covered_meeting_ids ?? [],
    },
    digest_notes: digestNotes,
    refresh_needed: { digest: reasons.length > 0, reasons },
  };
}
