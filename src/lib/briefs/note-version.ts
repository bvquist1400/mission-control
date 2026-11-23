// Which version of a work digest note a brief has (Baseline task 5dbe87fd).
// Re-filing the digest from the work PC updates the SAME note (same id, newer
// updated_at), so "the brief recorded this note id" is not enough: the brief
// has the note's current text only if the note wasn't updated after the brief
// was last built or refreshed. Pure and browser-safe; used by brief_status,
// get_brief_digest's in_morning_brief and the refresh's append rule.
//
// Any time that is missing or unreadable falls back to the id-only rule (the
// behaviour before this change): a recorded note counts as current.

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
