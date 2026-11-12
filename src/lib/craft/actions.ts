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

/**
 * One row of the active part as the screen needs it (the rows that exist; numbers may have gaps).
 * `since_timer`: ticked since this project's timer sitting started (FR1); `units` / `type`: the
 * row's unit_count and work type (Change total copies the last row's).
 */
export interface RowState {
  row: number; done: boolean;
  /** Finished in a saved sitting (074: an in-progress link is `in_progress`, not `linked`). */
  linked: boolean;
  today: boolean; since_timer?: boolean; units?: number | null; type?: string | null;
  /** S3: worked on in a saved sitting but not finished there. */
  in_progress?: boolean;
  /** S3: when it was ticked (null while unticked). */
  done_at?: string | null;
}

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

/** The quarter picker's words: none, ¼, ½, ¾ (knitting only; S1's quarter chip uses the same marks). */
export const quarterText = (quarter: number) => ["none", "¼", "½", "¾"][quarter] ?? "none";

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
  // A row in progress in a sitting is in that sitting too (073/074 refuse it as in_sitting).
  const linked = cut.filter((s) => s.linked || s.in_progress).map((s) => s.row);
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
 * The sheet's starting values, as 073's craft_log_sitting decides "from" when the sheet sends none.
 * With the timer on this part: from its start row − 1 (never past "last full row"), minutes from the
 * clock. With the timer on an earlier part (it was finished during the sitting and the screen moved
 * on; `on_active_part` false): from the row before this part's first row ticked since the sitting
 * started and in no sitting, else current − 1. Without the timer: from just before the first row
 * ticked today that no sitting has yet (else the current row, zero rows), and no minutes until
 * typed. "Last full row" = current − 1.
 */
export function logSittingDefaults(rows: RowState[], total: number, timer: { start_row: number; elapsed_seconds: number; on_active_part?: boolean } | null) {
  const current = currentRowOf(rows, total);
  const to = Math.min(current - 1, total);
  if (timer) {
    const minutes = Math.min(SITTING_MAX_MINUTES, timerMinutes(timer.elapsed_seconds));
    if (timer.on_active_part === false) {
      const fresh = rows.filter((s) => s.done && s.since_timer && !s.linked).map((s) => s.row);
      const first = fresh.length ? Math.min(...fresh) : current;
      return { from: Math.max(0, Math.min(to, current - 1, first - 1)), to, minutes };
    }
    return { from: Math.max(0, Math.min(timer.start_row - 1, to)), to, minutes };
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

/** Rows a timed sitting also saves from other parts (the timer's part and any between): 073's rule, from the view. */
export interface OtherPartRows { part_id: string; name: string; word: RowWord; rows: number[] }

/**
 * The Log sitting preview line: exactly what is saved. One part: "Saves rows 59–61, 38 min".
 * Across parts: "Saves Cuff rounds 15–31 and Hand rounds 1–3, 52 min". Then what it ticks,
 * unticks, and rows already in an earlier sitting (saved there, not here).
 */
export function sittingSummary(word: RowWord, partName: string, plan: ReturnType<typeof sittingPlan>, other: OtherPartRows[], minutes: number | null, partway: number | null = null): string {
  let text = savedRowsText({ word, partName, mine: plan.link, other, partway, minutes, verb: "Saves" });
  if (plan.tick.length) text += ` · ticks ${rowsText(word, plan.tick)}`;
  if (plan.untick.length) text += ` · unticks ${rowsText(word, plan.untick)}`;
  const earlier = plan.rows.filter((r) => !plan.link.includes(r));
  if (earlier.length) text += ` · ${rowsText(word, earlier)} already in an earlier sitting`;
  return text;
}

/**
 * "Saves rows 61–62 and part of row 63, 48 min" (S3): the rows finished, the row in progress (if any),
 * other parts' rows named by part, then the minutes. Used by the preview and by the confirmation.
 */
export function savedRowsText(args: { word: RowWord; partName: string; mine: number[]; other: OtherPartRows[]; partway: number | null; minutes: number | null; verb: "Saves" | "Saved" }): string {
  const { word, partName, mine, other, partway, minutes, verb } = args;
  const named = other.filter((o) => o.rows.length).map((o) => `${o.name} ${rowsText(o.word, o.rows)}`);
  const pieces = named.length ? [...named, ...(mine.length ? [`${partName} ${rowsText(word, mine)}`] : [])] : mine.length ? [rowsText(word, mine)] : [];
  if (partway !== null) pieces.push(named.length ? `part of ${partName} ${word} ${partway}` : `part of ${word} ${partway}`);
  const time = minutes && minutes > 0 ? minutesText(minutes) : null;
  return pieces.length ? `${verb} ${pieces.join(" and ")}${time ? `, ${time}` : ""}` : `${verb} ${time ? `${time}, ` : ""}the time only (no ${word}s)`;
}

// ── S3: Partway through row N ─────────────────────────────────────────────────

/** A sitting that ran this long after its last Row done is taken to have stopped partway through a row. */
export const PARTWAY_IDLE_SECONDS = 120;

/** The row a sitting is partway through: the next row after "last full row" (074's rule), or null. */
export function partwayRow(rows: RowState[], total: number, to: number): number | null {
  const next = nextExistingRow(rows, to, total);
  if (next === null) return null;
  const current = currentRowOf(rows, total);
  const state = rows.find((s) => s.row === next);
  // Rows after "last full row" below the current row are unticked by the save; one past it must be unticked already.
  return state && state.done && next >= current ? null : next;
}

/**
 * "Partway through row N" starts ON when the timer ran more than 2 minutes after the sitting's last
 * Row done (or the sitting has no Row done at all), OFF otherwise. Without a timer it starts OFF unless
 * no rows are saved (the minutes went into the row being worked). Always OFF with no row to be partway through.
 * `lastDoneAt`: the newest Row done of this project's rows since the timer's sitting started (any part).
 */
export function partwayDefault(rows: RowState[], total: number, form: { from: number; to: number },
  timer: { running: boolean; paused_at: string | null; elapsed_seconds: number } | null, nowIso: string, lastDoneAt: string | null): boolean {
  if (partwayRow(rows, total, form.to) === null) return false;
  if (!timer) return form.to <= form.from;
  if (!lastDoneAt) return true;
  const stopMs = timer.running || !timer.paused_at ? Date.parse(nowIso) : Date.parse(timer.paused_at);
  const after = Math.min(Math.max(0, (stopMs - Date.parse(lastDoneAt)) / 1000), timer.elapsed_seconds);
  return after > PARTWAY_IDLE_SECONDS;
}

/**
 * F6: "N rounds this sitting" counts every part the sitting saves, not only the screen's part:
 * "3 rounds this sitting" or "20 rounds this sitting (17 on Cuff)".
 */
export function sittingCountText(word: RowWord, from: number, to: number, other: OtherPartRows[]): string {
  const mine = Math.max(0, to - from);
  const elsewhere = other.filter((o) => o.rows.length);
  const extra = elsewhere.reduce((sum, o) => sum + o.rows.length, 0);
  const n = mine + extra;
  const where = elsewhere.map((o) => `${o.rows.length} on ${o.name}`).join(", ");
  return `${n} ${plural(word, n)} this sitting${extra ? ` (${where})` : ""}`;
}

/** F6: the Log sitting form after "Use the new count": the new count's rows, but the typed note and minutes kept. */
export interface LogForm { minutes: number | null; minutesTouched: boolean; from: number; to: number; quarter: number; note: string; key: string; partway: boolean; partwayTouched: boolean }
export function retakeLogForm(previous: LogForm, fresh: LogForm): LogForm {
  return {
    ...fresh, note: previous.note, key: previous.key,
    minutes: previous.minutesTouched ? previous.minutes : fresh.minutes, minutesTouched: previous.minutesTouched,
  };
}

/** F3: the line shown once a sitting is saved, from the rows the server actually saved. */
export function savedSittingText(result: { saved_rows?: number[]; in_progress_row?: number | null; other_rows?: { part_id: string; rows: number[] }[]; minutes?: number; status?: string },
  word: RowWord, partName: string, parts: { id: string; name: string; row_word: string }[]): string {
  const other: OtherPartRows[] = (result.other_rows ?? []).map((o) => {
    const part = parts.find((p) => p.id === o.part_id);
    return { part_id: o.part_id, name: part?.name ?? "another part", word: part?.row_word === "round" ? "round" : "row", rows: o.rows };
  });
  const text = savedRowsText({ word, partName, mine: result.saved_rows ?? [], other, partway: result.in_progress_row ?? null, minutes: result.minutes ?? null, verb: "Saved" });
  return result.status === "duplicate" ? `Already saved: ${text.replace(/^Saved /, "")}.` : `${text}.`;
}

// ── S3: Ripped back ────────────────────────────────────────────────────────────

/** A sitting the Ripped back sheet may change (the view's rip_sittings). */
export interface RipSittingFacts {
  id: string; date: string; minutes: number; excluded: boolean; exclude_reason: string | null; extra_units: number;
  links: { part_id: string | null; row: number | null; in_progress: boolean }[];
}

/** The reason a rip-back leaves a sitting out of speed (074 writes the same words). */
export function frogReason(word: RowWord, from: number, to: number): string {
  return from === to ? `ripped back ${word} ${from}` : `ripped back ${word}s ${from}–${to}`;
}

/**
 * What "Ripped back to row N" does, as 074's craft_frog decides it: rows N to current − 1 unticked;
 * every link to them and to the current row (worked partway, ripped out with them) removed from its
 * sitting; sittings left with nothing are all ripped (left out of speed); the rest are partly ripped
 * (left out only when ticked in the sheet); sittings already left out keep their reason.
 */
export function frogPlan(rows: RowState[], total: number, partId: string, sittings: RipSittingFacts[], from: number) {
  const current = currentRowOf(rows, total);
  const to = current - 1;
  const ripped = rows.filter((s) => s.row >= from && s.row <= to).map((s) => s.row).sort((a, b) => a - b);
  const hit = (link: RipSittingFacts["links"][number]) => link.part_id === partId && link.row !== null && link.row >= from && link.row <= current;
  const touched = sittings.filter((sitting) => sitting.links.some(hit)).map((sitting) => {
    const keeps = sitting.links.filter((link) => !hit(link));
    return { ...sitting, removed: sitting.links.filter(hit).length, keeps, all: keeps.length === 0 && !(sitting.extra_units > 0) };
  });
  const partwayLinks = sittings.some((sitting) => sitting.links.some((link) => link.part_id === partId && link.row === current));
  return {
    from, to, current, ripped, partway: partwayLinks && current <= total ? current : null,
    all: touched.filter((s) => s.all && !s.excluded), partly: touched.filter((s) => !s.all && !s.excluded), already: touched.filter((s) => s.excluded),
  };
}
export type FrogPlan = ReturnType<typeof frogPlan>;

/** What a partly ripped sitting keeps, in words: "keeps rows 58–60", "keeps 3 other rows". */
export function keepsText(word: RowWord, partId: string, keeps: RipSittingFacts["links"]): string {
  const here = keeps.filter((link) => link.part_id === partId && link.row !== null).map((link) => link.row as number);
  const elsewhere = keeps.length - here.length;
  const pieces = [...(here.length ? [rowsText(word, here)] : []), ...(elsewhere ? [`${elsewhere} ${elsewhere === 1 ? "row" : "rows"} of other parts`] : [])];
  return pieces.length ? `keeps ${pieces.join(" and ")}` : "keeps other work";
}

/** The body POST /api/craft/[id]/frog sends: the part, the current row it saw, the rows, the note, the picked sittings, a key. */
export function frogBody(part: { id: string; current_row: number }, plan: FrogPlan, form: { note: string; key: string; exclude: string[] }) {
  const partly = new Set(plan.partly.map((s) => s.id));
  return {
    part_id: part.id, expected_row: part.current_row, from_row: plan.from, to_row: plan.to,
    note: form.note.trim() || null, exclude_session_ids: form.exclude.filter((id) => partly.has(id)), idempotency_key: form.key,
  };
}

// ── Stale sheets (FR1) ─────────────────────────────────────────────────────────

/** What a sheet captured when it opened: it sends these, never what a later refresh shows. */
export interface SheetFacts { part_id: string; part_name: string; word: RowWord; current_row: number; total: number; timer_version: number | null; timer_part_id: string | null }
export function sheetFactsOf(view: { active_part: { id: string; name: string; row_word: string; current_row: number; total_rows: number } | null; timer: { version: number; part_id: string | null } | null }): SheetFacts | null {
  const part = view.active_part;
  if (!part) return null;
  return { part_id: part.id, part_name: part.name, word: part.row_word === "round" ? "round" : "row", current_row: part.current_row, total: part.total_rows,
    timer_version: view.timer?.version ?? null, timer_part_id: view.timer?.part_id ?? null };
}
/**
 * The line a sheet shows when what it captured changed underneath (another screen, the chat, the 30 s
 * refresh), or null. The sheet then needs a new tap; 073's expected-row and timer-version guards
 * refuse a stale body anyway.
 */
export function sheetChangeText(before: SheetFacts, now: SheetFacts | null, use: { timer?: boolean; total?: boolean } = {}): string | null {
  if (!now) return "This part changed on another screen. Close this and check the count.";
  const where = now.part_id !== before.part_id ? `${now.part_name} ${now.word} ${now.current_row}` : `${now.word} ${now.current_row}`;
  if (now.part_id !== before.part_id || now.current_row !== before.current_row) return `Your count changed on another screen (now ${where}). Check and save again.`;
  // S3 F5: every sheet watches the total and the timer too (Undo, Fix count and Ripped back move the
  // timer's start row; Change total's preview rests on the rows), unless a caller opts out.
  if (use.total !== false && now.total !== before.total) return `Your total changed on another screen (now ${now.total} ${now.word}s). Check and save again.`;
  if (use.timer !== false && (now.timer_version !== before.timer_version || now.timer_part_id !== before.timer_part_id)) return "Your timer changed on another screen. Check and save again.";
  return null;
}

// ── The Row done toast (FR1) ───────────────────────────────────────────────────

/**
 * What the toast's Undo does after Row done `row` (rows = the part's rows before the tap): with no
 * row after it ticked, Undo unticks only that row ({ to_row: row, expected_row: current after });
 * with rows after it already ticked (chat, the task panel), Undo opens "Undo rows…" instead, so it
 * never unticks more than the row it names without showing it first.
 */
export function toastUndo(rows: RowState[], total: number, row: number, currentAfter: number): { kind: "one"; body: { mode: "undo_one"; to_row: number; expected_row: number } } | { kind: "sheet"; to: number } {
  const expected = nextExistingRow(rows, row, total) ?? total + 1;
  // S3 F2: mode "undo_one" makes the server untick only this row, and refuse when rows after it are ticked.
  if (currentAfter === expected) return { kind: "one", body: { mode: "undo_one", to_row: row, expected_row: currentAfter } };
  return { kind: "sheet", to: row };
}

/** Change total: what added rows carry (073: the part's stitch count, else the last row's units; the last row's type). */
export function addedRowsText(word: RowWord, rows: RowState[], stitchCount: number | null): string | null {
  const last = [...rows].sort((a, b) => b.row - a.row)[0];
  if (!last) return null;
  const type = last.type ? ` and its stitch type (${last.type})` : "";
  if (stitchCount !== null) return `New ${word}s get the part's ${stitchCount.toLocaleString("en-US")} stitches${last.type ? ` and ${word} ${last.row}'s stitch type (${last.type})` : ""}.`;
  const units = last.units ?? null;
  return units !== null ? `New ${word}s copy ${word} ${last.row}: ${units.toLocaleString("en-US")} stitches each${type}.`
    : `New ${word}s copy ${word} ${last.row}: no stitch count${type}.`;
}

/**
 * The body Log sitting sends, from what the sheet captured when it opened (part, its current row as the
 * expected row, the timer's version) and the form. With the timer, "from" is left to 073 (the rule above)
 * and untouched minutes too (the server takes the timer's own at save time).
 */
export function logSittingBody(part: { id: string; current_row: number }, timer: { version: number; over_cap: boolean } | null,
  form: { from: number; to: number; quarter: number; note: string; key: string; minutesTouched: boolean; partway?: boolean }, minutes: number | null): Record<string, unknown> {
  return {
    part_id: part.id, use_timer: Boolean(timer), to_row: form.to, to_quarter: form.quarter, expected_row: part.current_row,
    // S3: "Partway through row N" (a quarter is always partway).
    in_progress: Boolean(form.partway) || form.quarter > 0,
    note: form.note.trim() || null, idempotency_key: form.key,
    ...(timer ? { timer_version: timer.version } : { from_row: form.from }),
    ...(!timer || form.minutesTouched || timer.over_cap ? { minutes } : {}),
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
