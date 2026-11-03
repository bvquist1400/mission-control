// Length caps on brief text (Baseline task e8f1449d). Before this, every capped
// field was cut with a plain `.slice(0, max)`: mid-word and silently (AM-1103's
// footnote ended mid-sentence at exactly 500 characters). Now prose is cut at
// the last sentence end (else the last word boundary) and ends in "…", and every
// cut is reported back to the caller as a warning. Pure and browser-safe.

export const ELLIPSIS = "…";

/** One field that was over its cap on save: where it was and how long it came in. */
export interface SaveWarning {
  /** Where the text was, e.g. "content.footnote" or "items[2].why". */
  field: string;
  /** Characters the caller sent (after trimming). */
  original_length: number;
  /** Characters kept, including the "…" for prose. */
  kept_length: number;
  /** The cap that applied. */
  max: number;
  /** "cut" = prose cut at a sentence or word boundary with "…"; "cut_identifier" = an id, key, link or time cut short (no "…"). */
  action: "cut" | "cut_identifier";
}

/** A sentence end must keep at least this share of the room, else the cut falls back to the last word boundary. */
const SENTENCE_MIN_SHARE = 0.5;

/** Trailing punctuation that reads badly right before "…". */
const TRAILING_JOINERS = /[\s,;:–—-]+$/u;

/**
 * `text` cut to at most `max` characters (the "…" included): at the last
 * sentence end (". ", "! ", "? ", optionally followed by a closing quote or
 * bracket) when that keeps at least half the room, else at the last word
 * boundary, else (one unbroken run of characters) a hard cut. Text within the
 * cap comes back unchanged.
 */
export function cutAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return text.slice(0, Math.max(0, max));
  const room = max - ELLIPSIS.length;
  // One character past the room so a sentence that ends exactly at the room's edge counts.
  const window = text.slice(0, room + 1);

  let sentenceEnd = -1;
  for (const match of window.matchAll(/[.!?]["'”’)\]]?(?=\s)/gu)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end <= room) sentenceEnd = end;
  }
  if (sentenceEnd >= Math.ceil(room * SENTENCE_MIN_SHARE)) {
    return `${text.slice(0, sentenceEnd)}${ELLIPSIS}`;
  }

  const head = text.slice(0, room);
  // A word boundary: whitespace inside the room, or the room ending right before whitespace.
  const nextIsSpace = /\s/u.test(text.charAt(room));
  let boundary = nextIsSpace ? room : -1;
  if (boundary < 0) {
    for (let index = head.length - 1; index > 0; index -= 1) {
      if (/\s/u.test(head.charAt(index))) {
        boundary = index;
        break;
      }
    }
  }
  if (boundary > 0) {
    const kept = head.slice(0, boundary).replace(TRAILING_JOINERS, "");
    if (kept) return `${kept}${ELLIPSIS}`;
  }
  return `${head}${ELLIPSIS}`;
}

/**
 * Where warnings go while a save's input is parsed. Parsing is synchronous, so
 * one module-level collector is safe: `collectSaveWarnings` sets it, runs the
 * parse and clears it. Outside a collection (reading stored content) nothing is
 * recorded.
 */
let activeCollector: SaveWarning[] | null = null;

export function collectSaveWarnings<T>(run: () => T): { value: T; warnings: SaveWarning[] } {
  const previous = activeCollector;
  const warnings: SaveWarning[] = [];
  activeCollector = warnings;
  try {
    return { value: run(), warnings };
  } finally {
    activeCollector = previous;
  }
}

export function recordSaveWarning(warning: SaveWarning): void {
  activeCollector?.push(warning);
}

/** Prose cap: cut at a boundary with "…", and recorded when a save is being parsed. */
export function capText(text: string, max: number, field: string): string {
  if (text.length <= max) return text;
  const kept = cutAtBoundary(text, max);
  recordSaveWarning({ field, original_length: text.length, kept_length: kept.length, max, action: "cut" });
  return kept;
}

/** Identifier cap (ids, keys, links, times): cut short as before (an "…" would only break it further), but recorded. */
export function capIdentifier(text: string, max: number, field: string): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max);
  recordSaveWarning({ field, original_length: text.length, kept_length: kept.length, max, action: "cut_identifier" });
  return kept;
}
