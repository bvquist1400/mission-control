/**
 * Craft S2, pure: what the screen's buttons will do, shown before saving, and the timer's
 * numbers. Migration 073 (craft_rows, craft_timer, craft_log_sitting, craft_set_total) is the
 * source of truth; these mirror its rules for previews and are pinned by test:craft and
 * compared with the SQL in test:craft-db.
 */
import { etDateOf } from "@/lib/work-sessions/parse";

/** A sitting is 1 to 1,440 minutes (059's CHECK). */
export const SITTING_MAX_MINUTES = 1440;
/** A timer past this asks "Was it left on?" (plan risk 5). */
export const LONG_RUN_MINUTES = 240;
/** The Row done toast offers Undo this long. */
export const UNDO_TOAST_MS = 5000;
/** While the screen is visible the view is re-read this often (plan risk 5). */
export const VIEW_REFRESH_MS = 30_000;
/** The "Undo rows…" sheet lists at most this many ticked rows. */
export const UNDO_CHOICES = 12;
/** Change total: the setup's part limit. */
export const CRAFT_MAX_ROWS = 2000;

/** One row of the active part as the screen needs it (the rows that exist; numbers may have gaps). */
export interface RowState { row: number; done: boolean; linked: boolean; today: boolean }

export type RowWord = "row" | "round";
export const wordTitle = (word: RowWord) => (word === "round" ? "Round" : "Row");
const plural = (word: RowWord, n: number) => (n === 1 ? word : `${word}s`);

/** The lowest unticked row up to the total, else total + 1 (073's craft_current_row). */
export function currentRowOf(rows: RowState[], total: number): number {
  let best = total + 1;
  for (const state of rows) if (!state.done && state.row <= total && state.row < best) best = state.row;
  return best;
}

/** The next row that exists after `row` (rows may have gaps), or null. */
export function nextExistingRow(rows: RowState[], row: number, total: number): number | null {
  let best: number | null = null;
  for (const state of rows) if (state.row > row && state.row <= total && (best === null || state.row < best)) best = state.row;
  return best;
}

/** "row 57", "rows 57–58", "rows 3, 5–7" (rows sorted, runs of existing numbers joined). */
export function rowsText(word: RowWord, rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  if (!sorted.length) return `no ${word}s`;
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return `${plural(word, sorted.length)} ${runs.join(", ")}`;
}

/**
 * Fix count to `to` (the row to be on): ticks the unticked rows from the current row up to
 * `to`, or unticks the rows from `to` up to the current row; nothing outside. Same as
 * 073's craft_rows fix/undo.
 */
export function fixCountPlan(rows: RowState[], total: number, to: number) {
  const current = currentRowOf(rows, total);
  const tick = to > current ? rows.filter((s) => s.row >= current && s.row < to && !s.done).map((s) => s.row).sort((a, b) => a - b) : [];
  const untick = to < current ? rows.filter((s) => s.row >= to && s.row < current && s.done).map((s) => s.row).sort((a, b) => a - b) : [];
  const after = rows.map((s) => ({ ...s, done: tick.includes(s.row) ? true : untick.includes(s.row) ? false : s.done }));
  return { current, to, tick, untick, next: currentRowOf(after, total), linked: untick.filter((row) => rows.find((s) => s.row === row)?.linked) };
}

/** Ticked rows just below the current row, newest (highest) first: the "Undo rows…" choices. */
export function undoChoices(rows: RowState[], total: number, limit = UNDO_CHOICES): number[] {
  const current = currentRowOf(rows, total);
  return rows.filter((s) => s.done && s.row < current).map((s) => s.row).sort((a, b) => b - a).slice(0, limit);
}

/** Garter: ridges done ↔ rows. "48 ridges done" = 96 rows done, so the current row is 97. */
export const rowFromRidgesDone = (ridges: number) => ridges * 2 + 1;

/** The first number in a count item's text ("Count the last row: 195 stitches" → 195), as 073 reads it. */
export function countFromCheckText(text: string): number | null {
  const match = text.match(/[0-9][0-9,]*/);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isSafeInteger(value) ? value : null;
}
/** A band's count item: a plain checklist item (not a row) whose text starts "Count". */
export const isCountItemText = (text: string) => /^\s*count/i.test(text);

/** The text 073 gives an added row item: the word of the part's last row item ("Rnd"), else the part's word. */
export function newRowItemText(lastText: string | null, word: RowWord, n: number): string {
  const label = lastText?.match(/^(Row|Rnd|Round)[ \t]+[0-9]/)?.[1] ?? wordTitle(word);
  return `${label} ${n}`;
}

export type SetTotalPlan =
  | { kind: "same"; total: number }
  | { kind: "add"; total: number; add: number[] }
  | { kind: "remove"; total: number; remove: number[] }
  | { kind: "refused"; total: number; reason: "ticked" | "in_sitting" | "range"; rows: number[] };

/** Change total rows/rounds, as 073's craft_set_total decides it (adds at the end; removes only unticked rows in no sitting). */
export function setTotalPlan(rows: RowState[], total: number, next: number): SetTotalPlan {
  if (!Number.isInteger(next) || next < 1 || next > CRAFT_MAX_ROWS) return { kind: "refused", total: next, reason: "range", rows: [] };
  if (next === total) return { kind: "same", total };
  if (next > total) return { kind: "add", total: next, add: Array.from({ length: next - total }, (_, i) => total + 1 + i) };
  const cut = rows.filter((s) => s.row > next).sort((a, b) => a.row - b.row);
  const ticked = cut.filter((s) => s.done).map((s) => s.row);
  if (ticked.length) return { kind: "refused", total: next, reason: "ticked", rows: ticked };
  const linked = cut.filter((s) => s.linked).map((s) => s.row);
  if (linked.length) return { kind: "refused", total: next, reason: "in_sitting", rows: linked };
  return { kind: "remove", total: next, remove: cut.map((s) => s.row) };
}

export function setTotalRefusalText(word: RowWord, plan: { reason: string; rows: number[] }): string {
  if (plan.reason === "range") return `The total has to be a whole number from 1 to ${CRAFT_MAX_ROWS.toLocaleString("en-US")}.`;
  const what = rowsText(word, plan.rows);
  if (plan.reason === "ticked") return `Can't remove ${what}: ${plan.rows.length === 1 ? "it is" : "they are"} ticked. Undo ${plan.rows.length === 1 ? "it" : "them"} first if that was a mistake.`;
  if (plan.reason === "in_sitting") return `Can't remove ${what}: ${plan.rows.length === 1 ? "it is" : "they are"} part of a saved sitting.`;
  if (plan.reason === "no_rows") return `This part has no ${word}s to add after.`;
  return "That total can't be saved.";
}

// ── Timer ─────────────────────────────────────────────────────────────────────

export interface TimerFacts {
  running_since: string | null;
  banked_seconds: number;
  adjust_seconds: number;
}
/** Seconds on the timer at `nowMs` (server time): banked + adjust + the running stretch, never negative. */
export function timerElapsedAt(timer: TimerFacts, nowMs: number): number {
  const running = timer.running_since ? Math.max(0, Math.floor((nowMs - Date.parse(timer.running_since)) / 1000)) : 0;
  return Math.max(0, timer.banked_seconds + timer.adjust_seconds + running);
}
/** Server time now from a client clock and the offset measured when the view arrived. */
export const serverNowMs = (clientNowMs: number, offsetMs: number) => clientNowMs + offsetMs;
/** offset = server − client, measured when a response with server_now arrived. */
export const clockOffsetMs = (serverNowIso: string, clientReceivedMs: number) => Date.parse(serverNowIso) - clientReceivedMs;

/** "4:07", "23:14", "1:02:03". */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
/** "45 min", "1 h", "2 h 05 min". */
export function minutesText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} h ${String(rest).padStart(2, "0")} min` : `${h} h`;
}
/** Whole minutes the way 073 rounds the timer for a sitting. */
export const timerMinutes = (seconds: number) => Math.round(seconds / 60);

/** The timer's ET day differs from today's: resuming offers to save the earlier day's stretch first. */
export const isNewEtDay = (sittingStartedAt: string, nowIso: string) => etDateOf(nowIso) > etDateOf(sittingStartedAt);

// ── Log sitting ───────────────────────────────────────────────────────────────

/**
 * The sheet's starting values. With the timer: from its start row, minutes from the clock.
 * Without: from just before the first row ticked today that no sitting has yet (else the
 * current row, zero rows), and no minutes until typed. "Last full row" = current − 1.
 */
export function logSittingDefaults(rows: RowState[], total: number, timer: { start_row: number; elapsed_seconds: number } | null) {
  const current = currentRowOf(rows, total);
  const to = Math.min(current - 1, total);
  if (timer) {
    return { from: Math.min(timer.start_row - 1, to), to, minutes: Math.min(SITTING_MAX_MINUTES, timerMinutes(timer.elapsed_seconds)) };
  }
  const loose = rows.filter((s) => s.done && !s.linked && s.today && s.row < current).map((s) => s.row);
  const from = loose.length ? Math.min(...loose) - 1 : to;
  return { from: Math.max(0, Math.min(from, to)), to, minutes: null as number | null };
}

/** What Log sitting will change: (from, to] ticked and linked unless another sitting has them; (to, current) unticked. */
export function sittingPlan(rows: RowState[], total: number, from: number, to: number) {
  const current = currentRowOf(rows, total);
  const inRange = rows.filter((s) => s.row > from && s.row <= to);
  return {
    current,
    rows: inRange.map((s) => s.row).sort((a, b) => a - b),
    tick: inRange.filter((s) => !s.done).map((s) => s.row).sort((a, b) => a - b),
    link: inRange.filter((s) => !s.linked).map((s) => s.row).sort((a, b) => a - b),
    untick: rows.filter((s) => s.row > to && s.row < current && s.done).map((s) => s.row).sort((a, b) => a - b),
  };
}

/** A fresh key per sheet open (the idempotency key of POST /api/craft/[id]/sittings). */
export function newIdempotencyKey(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `craft-${random}`;
}

// ── Write replies in plain words ─────────────────────────────────────────────

/** The line a failed write shows. Never silent: the count on screen is the server's. */
export function writeFailureText(status: number | null, body: { error?: string } | null): string {
  if (status === null) return "Not saved, retry. The connection dropped before the server answered.";
  if (status === 409) return body?.error ?? "Not saved: this changed on another screen. The screen now shows the latest.";
  if (status >= 400 && status < 500 && body?.error) return `Not saved: ${body.error}`;
  return "Not saved, retry. The server didn't save it.";
}
