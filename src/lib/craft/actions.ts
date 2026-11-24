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
/** FR5 (Sol 2): one Done or "Mark all done" ticks at most this many checks per call (074's craft_check and the route). */
export const CRAFT_CHECK_IDS_MAX = 500;
/** FR5: check ids in calls of at most CRAFT_CHECK_IDS_MAX ("Mark all done" with more sends several, in order). */
export function checkBatches(ids: string[], size = CRAFT_CHECK_IDS_MAX): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
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
  /** S3 FR3: the row item's text ("Rnd 29 · knit (US 7)"); absent = a bare "Row N" label. */
  text?: string;
  /**
   * S3 FR5: added by a raise (Change total), i.e. its checklist item was made after the part was set up (the item's
   * created_at is later than the part's; set-up only links items that already exist). Only these can be taken back.
   * Absent = a row from the part's set-up.
   */
  raised?: boolean;
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
export function newRowItemText(lastText: string | null, word: RowWord, n: number, text?: string | null): string {
  const label = lastText?.match(/^(Row|Rnd|Round)[ \t]+[0-9]/)?.[1] ?? wordTitle(word);
  // FR3: the text typed for new rows goes after the label with the last row's separator (else " · "), as 074 writes it.
  const clean = (text ?? "").replace(/^[ \t]*(Row|Rnd|Round)[ \t]+[0-9]+[ \t]*([·:–-][ \t]*)?/, "").trim();
  if (!clean) return `${label} ${n}`;
  const sep = lastText?.match(/^(?:Row|Rnd|Round)[ \t]+[0-9]+(?:[ \t]+\(est\.\))?([ \t]*[·:–-][ \t]*)[^ \t]/)?.[1] ?? " · ";
  return `${label} ${n}${sep}${clean}`;
}

export type SetTotalPlan =
  | { kind: "same"; total: number }
  | { kind: "add"; total: number; add: number[] }
  | { kind: "remove"; total: number; remove: number[]; moves: { from: number; to: number }[] }
  | { kind: "refused"; total: number; reason: "ticked" | "in_sitting" | "range"; rows: number[] }
  | { kind: "refused"; total: number; reason: "not_est"; rows: number[]; need: number };

/** S3 FR3: a row whose text says "(est.)": a guessed row, the only kind lowering a total may drop (with bare rows). */
export const isEstRowText = (text: string | undefined) => text !== undefined && text.toLowerCase().includes("(est.)");
/** A row that is only its label ("Row 456", the scarf's tape-measure ending; no text = the same). */
export const isBareRowText = (text: string | undefined) => text === undefined || /^(Row|Rnd|Round)[ \t]+[0-9]+[ \t]*$/.test(text);
/** The rows lowering a total may drop (074's craft_set_total): "(est.)" or bare rows. */
export const isDroppableRow = (state: Pick<RowState, "text">) => isEstRowText(state.text) || isBareRowText(state.text);
// FR4: labels in any case ("rnd 6", "RND 6") and a leading range ("Rnd 4–6") count as the label.
const LABEL = /^(Row|Rnd|Round)[ \t]+[0-9]+(?:[–-][0-9]+)?(?:[ \t]+\(est\.\))?[ \t]*(?:[·:–-][ \t]*)?/i;
/** A row's pattern text after its label ("Rnd 24 (est.) · k1, p1 rib" → "k1, p1 rib"; "Row 519" → ""). */
export const rowDescription = (text: string | undefined) => (text ?? "").replace(LABEL, "").trim();
/** The label word a part's rows are written with ("Rnd"), else the part's word. */
export function rowLabelOf(rows: Pick<RowState, "text">[], word: RowWord): string {
  for (const state of rows) { const m = state.text?.match(/^(Row|Rnd|Round)[ \t]+[0-9]/i); if (m) return m[1]; }
  return wordTitle(word);
}
/**
 * FR4: a moved row's text, as 074's craft_set_total writes it: the leading label's number becomes the new row, in any
 * case ("rnd 6" → "rnd 5"); a leading range moves as a whole and keeps its width ("Rnd 4–6" → "Rnd 3–5"); numbers
 * later in the text ("as Rnd 4", "(see Rnd 3)") are left alone; text with no leading label is kept as it is.
 */
export function renumberRowText(text: string, newRow: number): string {
  const m = text.match(/^((?:row|rnd|round)[ \t]+)([0-9]+)(?:([–-])([0-9]+))?/i);
  if (!m) return text;
  const range = m[4] === undefined ? "" : BigInt(m[4]) >= BigInt(m[2]) ? `${m[3]}${BigInt(newRow) + BigInt(m[4]) - BigInt(m[2])}` : `${m[3]}${m[4]}`;
  return `${m[1]}${newRow}${range}${text.slice(m[0].length)}`;
}

/**
 * Change total rows/rounds, as 074's craft_set_total decides it (FR3). More adds at the end. Fewer by k drops the k
 * highest droppable rows ("(est.)" or bare), never a pattern row: fewer such rows → not_est; a ticked one → ticked; one
 * in a sitting (finished or in progress) → in_sitting. Every row after a dropped one moves down (`moves`).
 */
export function setTotalPlan(rows: RowState[], total: number, next: number): SetTotalPlan {
  if (!Number.isInteger(next) || next < 1 || next > CRAFT_MAX_ROWS) return { kind: "refused", total: next, reason: "range", rows: [] };
  if (next === total) return { kind: "same", total };
  if (next > total) return { kind: "add", total: next, add: Array.from({ length: next - total }, (_, i) => total + 1 + i) };
  const need = total - next;
  const drop = rows.filter((s) => s.row <= total && isDroppableRow(s)).sort((a, b) => b.row - a.row).slice(0, need).sort((a, b) => a.row - b.row);
  if (drop.length < need) return { kind: "refused", total: next, reason: "not_est", rows: drop.map((s) => s.row), need };
  const ticked = drop.filter((s) => s.done).map((s) => s.row);
  if (ticked.length) return { kind: "refused", total: next, reason: "ticked", rows: ticked };
  // A row in progress in a sitting is in that sitting too (073/074 refuse it as in_sitting).
  const linked = drop.filter((s) => s.linked || s.in_progress).map((s) => s.row);
  if (linked.length) return { kind: "refused", total: next, reason: "in_sitting", rows: linked };
  const dropped = drop.map((s) => s.row);
  const moves = rows.filter((s) => s.row > dropped[0] && !dropped.includes(s.row)).sort((a, b) => a.row - b.row)
    .map((s) => ({ from: s.row, to: s.row - dropped.filter((d) => d < s.row).length }));
  return { kind: "remove", total: next, remove: dropped, moves };
}

/**
 * FR4, "take back": lowering to `next` by dropping every row above it, whatever its text (rows a raise added by
 * mistake). Offered only beside the default plan, never instead of it silently: the sheet names the rows and asks a
 * second time ("Also remove pattern rounds 25–27 · knit (US 7)?"). Still never a ticked row or one in a sitting.
 * FR5 (the 11/12 loss on Mitten 2): ONLY rows a raise added (`raised`) that are still at the end: null (not offered)
 * when any row above `next` came with the part's set-up or is an "(est.)" row (the default lowering handles those),
 * when it isn't a lowering, when there is nothing above `next`, or when it would drop exactly what the default drops.
 * A ticked raised row or one in a sitting gives `refused` (the sheet names that row as the blocker).
 */
export function takeBackPlan(rows: RowState[], total: number, next: number):
  | { kind: "remove"; total: number; remove: number[]; moves: [] }
  | { kind: "refused"; total: number; reason: "ticked" | "in_sitting"; rows: number[]; remove: number[] } | null {
  if (!Number.isInteger(next) || next < 1 || next >= total) return null;
  const above = rows.filter((s) => s.row > next).sort((a, b) => a.row - b.row);
  if (!above.length) return null;
  if (above.some((s) => !s.raised || isEstRowText(s.text))) return null;
  const remove = above.map((s) => s.row);
  const usual = setTotalPlan(rows, total, next);
  if (usual.kind === "remove" && usual.remove.length === remove.length && usual.remove.every((r, i) => r === remove[i])) return null;
  const ticked = above.filter((s) => s.done).map((s) => s.row);
  if (ticked.length) return { kind: "refused", total: next, reason: "ticked", rows: ticked, remove };
  const linked = above.filter((s) => s.linked || s.in_progress).map((s) => s.row);
  if (linked.length) return { kind: "refused", total: next, reason: "in_sitting", rows: linked, remove };
  return { kind: "remove", total: next, remove, moves: [] };
}
/**
 * FR5: why a take-back can't be saved, naming the real blocker: "Can't take back rounds 25–27, added by a raise: round
 * 25 is ticked." / "…: round 27 is part of a saved sitting."; 074's `not_raised` (a caller asked to take back rows
 * that came with the set-up or are "(est.)"): "Can't take back rounds 28–31: rounds 28–31 weren't added by a raise …".
 */
export function takeBackRefusalText(word: RowWord, plan: { reason: string; rows: number[]; remove: number[] }): string {
  const one = plan.rows.length === 1;
  if (plan.reason === "not_raised") {
    return `Can't take back ${rowsText(word, plan.remove)}: ${rowsText(word, plan.rows)} ${one ? "wasn't" : "weren't"} added by a raise or ${one ? "is" : "are"} (est.). Only ${word}s a raise added can be taken back; (est.) ${word}s go with the usual lowering.`;
  }
  const why = plan.reason === "ticked" ? `${one ? "is" : "are"} ticked` : `${one ? "is" : "are"} part of a saved sitting`;
  return `Can't take back ${rowsText(word, plan.remove)}, added by a raise: ${rowsText(word, plan.rows)} ${why}.`;
}
/**
 * FR5: the lowest total the usual lowering can reach now: the highest droppable rows ("(est.)" or blank) that are
 * unticked and in no sitting, taken from the top down to the first one that isn't (lowering always takes the
 * highest droppable rows first). `rows` = those rows; total = the part's total less them.
 */
export function lowestTotalPlan(rows: RowState[], total: number): { total: number; rows: number[] } {
  const free: number[] = [];
  for (const state of rows.filter((s) => s.row <= total && isDroppableRow(s)).sort((a, b) => b.row - a.row)) {
    if (state.done || state.linked || state.in_progress) break;
    free.push(state.row);
  }
  return { total: total - free.length, rows: free.sort((a, b) => a - b) };
}
/**
 * FR5: why lowering to `next` can't be saved, naming the real blocker, and the total it CAN reach ("Can't remove rounds
 * 22–24: they are ticked; drop only (est.) rounds 25–28 → total 27."). When the rows above `next` were all added by a raise, the
 * take-back's blocker is named instead ("Can't take back rounds 25–27, added by a raise: round 25 is ticked."), never
 * the ticked set-up rows below them. Ticked rows are knitted rows: it never suggests unticking them. `suggest` is the
 * reachable total to offer ("Use total 27"), null when there is none. `takeBackHint` (the route, no button there)
 * adds that the raised rows can be taken back. Null when the usual lowering can be saved.
 */
export function lowerRefusal(word: RowWord, rows: RowState[], total: number, next: number, takeBackHint = false): { text: string; suggest: number | null } | null {
  const plan = setTotalPlan(rows, total, next);
  if (plan.kind !== "refused") return null;
  if (plan.reason === "range") return { text: setTotalRefusalText(word, plan), suggest: null };
  const back = takeBackPlan(rows, total, next);
  // The take-back's blocker is the real one when the usual lowering would have to reach the rows kept below the new
  // total (Mitten 1's ticked 22–24 under a wrong raise) or can't reach far enough; a blocker above it is named as is.
  if (back?.kind === "refused" && (plan.reason === "not_est" || plan.rows.some((r) => r <= next))) return { text: takeBackRefusalText(word, back), suggest: null };
  const low = lowestTotalPlan(rows, total);
  const byRow = new Map(rows.map((s) => [s.row, s]));
  const est = low.rows.every((r) => isEstRowText(byRow.get(r)?.text)) ? "(est.) " : "";
  const reach = low.rows.length ? `drop only ${est}${rowsText(word, low.rows)} → total ${low.total}.` : `no unticked (est.) ${word}s are left to drop.`;
  const one = plan.rows.length === 1;
  // S2's words up to the semicolon ("Can't remove row 140: it is ticked"), without its "Undo them first".
  const head = plan.reason === "ticked" ? `Can't remove ${rowsText(word, plan.rows)}: ${one ? "it is" : "they are"} ticked; ${reach}`
    : plan.reason === "in_sitting" ? `Can't remove ${rowsText(word, plan.rows)}: ${one ? "it is" : "they are"} part of a saved sitting; ${reach}`
    : `${setTotalRefusalText(word, plan)}${low.rows.length ? ` ${capital(reach)}` : ""}`;
  const hint = takeBackHint && back?.kind === "remove" ? ` ${capital(rowsText(word, back.remove))} ${back.remove.length === 1 ? "was" : "were"} added by a raise and can be taken back instead.` : "";
  return { text: `${head}${hint}`, suggest: low.rows.length && low.total < total && low.total !== next ? low.total : null };
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** "pattern rounds 25–27 · knit (US 7)", grouped by run and text (more than three groups: "pattern rounds 25–40"). */
export function takeBackRowsText(word: RowWord, rows: RowState[], remove: number[]): string {
  const byRow = new Map(rows.map((s) => [s.row, s]));
  const groups: { rows: number[]; desc: string }[] = [];
  for (const row of [...remove].sort((a, b) => a - b)) {
    const desc = rowDescription(byRow.get(row)?.text);
    const last = groups.at(-1);
    if (last && last.desc === desc && last.rows.at(-1) === row - 1) last.rows.push(row);
    else groups.push({ rows: [row], desc });
  }
  const many = (n: number) => (n === 1 ? word : `${word}s`);
  if (groups.length > 3) return `pattern ${many(remove.length)} ${runsText(remove)}`;
  return `pattern ${groups.map((g, i) => `${i === 0 ? `${many(remove.length)} ` : ""}${runsText(g.rows)}${g.desc ? ` · ${g.desc}` : ""}`).join(" and ")}`;
}

/**
 * FR4: what a raise starts from. Never prefilled from an "(est.)" row: `same` is the last row whose text has no
 * "(est.)" (the "Same as round 21: k1, p1 rib" choice; its description may be "" for a bare label), and the work type
 * picker starts on that row's type. Null without such a row.
 */
export function raiseDefaults(rows: RowState[]): { same: { row: number; text: string } | null; type: string | null } {
  const last = [...rows].filter((s) => !isEstRowText(s.text)).sort((a, b) => b.row - a.row)[0];
  return last ? { same: { row: last.row, text: rowDescription(last.text) }, type: last.type ?? null } : { same: null, type: null };
}

/** A step (plain checklist item) right after the part's last row on its task: a raise asks where the new rows go. */
export interface TrailingStep { id: string; text: string }
const quoted = (steps: TrailingStep[]) => steps.map((step) => `“${step.text}”`).join(" and ");
/**
 * FR4: the raise's line before Save. "Adds Rnd 25–27 · knit (US 7) at the end (stockinette), 36 stitches each. The
 * screen moves to this part." With a step after the last row it says where the rows go: right after the last row
 * (before the step, which then comes after them) or after the step (which then comes before the first new row).
 */
export function raiseSummary(args: { label: string; add: number[]; lastRow: number | null; text: string; type: string; units: number | null; onScreen: boolean;
  steps: TrailingStep[]; place: "after_row" | "after_steps" | null }): string {
  const { label, add, lastRow, text, type, units, onScreen, steps, place } = args;
  const what = `${label} ${runsText(add)}${text ? ` · ${text}` : ""}`;
  const typeText = type ? ` (${type})` : "";
  const each = units !== null ? `${units.toLocaleString("en-US")} stitches each` : "no stitch count";
  const move = onScreen ? "" : " The screen moves to this part.";
  const step = `${steps.length === 1 ? "The step" : "The steps"} ${quoted(steps)}`;
  if (steps.length && place === "after_row") return `Adds ${what} right after ${label} ${lastRow}${typeText}, ${each}. ${step} ${steps.length === 1 ? "moves" : "move"} after ${label} ${add.at(-1)}.${move}`;
  const stays = steps.length && place === "after_steps" ? ` ${step} ${steps.length === 1 ? "stays" : "stay"} before ${label} ${add[0]}.` : "";
  return `Adds ${what} at the end${typeText}, ${each}.${stays}${move}`;
}

/** "25–28", "3, 5–7" (numbers only). */
export function runsText(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b), runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return runs.join(", ");
}

/**
 * What lowering does, in the sheet's words (FR3): "Drops Rnd 25–28 (est.). Rnd 29–31 · knit (US 7) become Rnd 25–27.
 * New total 27." Moved rows are grouped by run and pattern text.
 */
export function renumberText(word: RowWord, rows: RowState[], plan: Extract<SetTotalPlan, { kind: "remove" }>): string {
  const label = rowLabelOf(rows, word);
  const byRow = new Map(rows.map((s) => [s.row, s]));
  const allEst = plan.remove.every((r) => isEstRowText(byRow.get(r)?.text));
  const parts = [`Drops ${label} ${runsText(plan.remove)}${allEst ? " (est.)" : ""}.`];
  const groups: { from: number[]; to: number[]; desc: string }[] = [];
  for (const move of plan.moves) {
    const desc = rowDescription(byRow.get(move.from)?.text);
    const last = groups.at(-1);
    if (last && last.desc === desc && last.from.at(-1) === move.from - 1 && last.to.at(-1) === move.to - 1) { last.from.push(move.from); last.to.push(move.to); }
    else groups.push({ from: [move.from], to: [move.to], desc });
  }
  if (groups.length > 3) {
    const shift = plan.moves[0].from - plan.moves[0].to;
    parts.push(`${label} ${plan.moves[0].from}–${plan.moves.at(-1)?.from} move down (text kept), starting at ${label} ${plan.moves[0].from - shift}.`);
  } else {
    for (const g of groups) parts.push(`${label} ${runsText(g.from)}${g.desc ? ` · ${g.desc}` : ""} ${g.from.length === 1 ? "becomes" : "become"} ${label} ${runsText(g.to)}.`);
  }
  parts.push(`New total ${plan.total}.`);
  return parts.join(" ");
}

/**
 * "Last (est.) round needed" (FR3): the part's unticked "(est.)" rows, the range the stepper offers (the row before the
 * lowest one up to the highest one) and the total a value gives (every droppable row after it goes). Null without any.
 */
export function estRange(rows: RowState[], total: number) {
  const est = rows.filter((s) => s.row <= total && !s.done && isEstRowText(s.text)).map((s) => s.row).sort((a, b) => a - b);
  if (!est.length) return null;
  return { min: Math.max(0, est[0] - 1), max: est.at(-1) as number };
}
export function totalForLastEst(rows: RowState[], total: number, lastNeeded: number): number {
  return total - rows.filter((s) => s.row <= total && s.row > lastNeeded && isDroppableRow(s)).length;
}

export function setTotalRefusalText(word: RowWord, plan: { reason: string; rows: number[]; need?: number; remove?: number[] }): string {
  if (plan.reason === "range") return `The total has to be a whole number from 1 to ${CRAFT_MAX_ROWS.toLocaleString("en-US")}.`;
  const what = rowsText(word, plan.rows);
  if (plan.reason === "ticked") return `Can't remove ${what}: ${plan.rows.length === 1 ? "it is" : "they are"} ticked. Undo ${plan.rows.length === 1 ? "it" : "them"} first if that was a mistake.`;
  if (plan.reason === "in_sitting") return `Can't remove ${what}: ${plan.rows.length === 1 ? "it is" : "they are"} part of a saved sitting.`;
  if (plan.reason === "not_est") {
    const need = plan.need ?? plan.rows.length + 1;
    return plan.rows.length
      ? `Can't drop ${need} ${plural(word, need)}: only ${what} ${plan.rows.length === 1 ? "is an (est.) or blank" : "are (est.) or blank"} ${plural(word, plan.rows.length)}. ${wordTitle(word)}s with pattern steps are never dropped.`
      : `Can't drop ${need} ${plural(word, need)}: this part has no (est.) or blank ${word}s left. ${wordTitle(word)}s with pattern steps are never dropped.`;
  }
  if (plan.reason === "no_rows") return `This part has no ${word}s to add after.`;
  if (plan.reason === "not_raised") return takeBackRefusalText(word, { reason: plan.reason, rows: plan.rows, remove: plan.remove ?? plan.rows });
  return "That total can't be saved.";
}
/**
 * FR5 (Sol 1): a raise with no `how` while a step follows the part's last row (074 refuses it, `where`): "Not saved:
 * the step “Check: …” comes after Rnd 24. Say whether the new rounds go before or after the step." The craft screen
 * always asks first; this is for any other caller (the S2 four-argument call, the API).
 */
export function raiseWhereText(word: RowWord, steps: string[], afterRow: number | null): string {
  const quotedSteps = steps.map((text) => `“${text}”`).join(" and ");
  return `Not saved: ${steps.length === 1 ? "the step" : "the steps"} ${quotedSteps} ${steps.length === 1 ? "comes" : "come"} after ${word} ${afterRow ?? "the last"}. Say whether the new ${word}s go before or after ${steps.length === 1 ? "the step" : "the steps"}.`;
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
 * FR1 (Codex P3): only TIMED time after the last Row done counts, never a pause (`timedSinceLastDone`).
 */
export function partwayDefault(rows: RowState[], total: number, form: { from: number; to: number },
  timer: PartwayTimer | null, nowIso: string, lastDoneAt: string | null): boolean {
  if (partwayRow(rows, total, form.to) === null) return false;
  if (!timer) return form.to <= form.from;
  if (!lastDoneAt) return true;
  return timedSinceLastDone(timer, nowIso, lastDoneAt) > PARTWAY_IDLE_SECONDS;
}

/** What the Partway default reads from the timer (the view's CraftTimerView has all of it; older callers may pass less). */
export interface PartwayTimer {
  running: boolean; paused_at: string | null; elapsed_seconds: number;
  running_since?: string | null; banked_seconds?: number; sitting_started_at?: string; last_done_seconds?: number | null;
}

/**
 * Seconds the timer ran (pauses left out, + / − left out) after the sitting's last Row done.
 * 074 FR1 stores the timer's timed seconds at that Row done (`last_done_seconds`, written by craft_rows), so
 * this is timed-now minus that. Without it (a timer from before 074, or rows ticked outside the craft screen)
 * the timer can't tell its pauses apart once resumed, so the lower bound is used: the larger of the running
 * stretch after the Row done and the timed seconds less all the time before it since the sitting started
 * (exact when every pause is on one side of the Row done). Never more than the clock or the timer allows.
 */
export function timedSinceLastDone(timer: PartwayTimer, nowIso: string, lastDoneAt: string): number {
  const now = Date.parse(nowIso), done = Date.parse(lastDoneAt);
  const runningSince = timer.running && timer.running_since ? Date.parse(timer.running_since) : null;
  const timed = timer.banked_seconds === undefined ? timer.elapsed_seconds
    : timer.banked_seconds + (runningSince === null ? 0 : Math.max(0, Math.floor((now - runningSince) / 1000)));
  if (timer.last_done_seconds !== undefined && timer.last_done_seconds !== null) return Math.max(0, timed - timer.last_done_seconds);
  const stop = timer.running || !timer.paused_at ? now : Date.parse(timer.paused_at);
  const upper = Math.min(Math.max(0, (stop - done) / 1000), timed);
  if (!timer.sitting_started_at) return upper;
  const stretch = runningSince === null ? 0 : Math.max(0, (now - Math.max(done, runningSince)) / 1000);
  const beforeDone = Math.max(0, (done - Date.parse(timer.sitting_started_at)) / 1000);
  return Math.min(upper, Math.max(stretch, timed - beforeDone, 0));
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

// ── Craft estimates E3: add rows to a sitting already logged ─────────────────

/** A sitting with time but no rows, as the estimate lists it (`sittings_without_rows`). */
export interface SittingChoice { id: string; date: string; minutes: number }
/** "Sat 11/21, 90 min" (the Pace sheet's own words for these sittings). */
export function sittingChoiceText(sitting: SittingChoice): string {
  const [y, m, d] = sitting.date.split("-").map(Number);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${day} ${m}/${d}, ${sitting.minutes} min`;
}

/**
 * The Add rows sheet's first guess: from the lowest row no sitting finished, on through the rows that are ticked and in
 * no sitting, stopping at the first row that is unticked or already in a sitting (FR1, Codex LOW: never across a row
 * another sitting has); gaps in the row numbers don't stop it. With that first row unticked, just that row.
 */
export function addRowsDefaults(rows: RowState[], total: number): { from: number; to: number } {
  const sorted = rows.filter((s) => s.row <= total).sort((a, b) => a.row - b.row);
  const start = sorted.findIndex((s) => !s.linked);
  if (start < 0) {
    const row = Math.max(1, Math.min(total, currentRowOf(rows, total)));
    return { from: row, to: row };
  }
  const from = sorted[start].row;
  let to = from;
  if (sorted[start].done) {
    for (let i = start; i < sorted.length; i += 1) {
      if (sorted[i].linked || !sorted[i].done) break;
      to = sorted[i].row;
    }
  }
  return { from, to };
}

export interface AddRowsPlan {
  /** Rows of from–to that exist on the part. */
  rows: number[];
  /** Unticked rows Save ticks (in the same call that adds them; migration 076). */
  tick: number[];
  /** Rows added to the sitting as finished (a row partway in that sitting becomes finished). */
  add: number[];
  /** Rows the chosen sitting already has (kept, not added again). */
  already: number[];
  /** Rows another sitting already finished: nothing is saved while any are picked. */
  in_sitting: number[];
  /** Unticked rows before `from` when Save would have to tick: ticking them too would be wrong, so nothing is saved. */
  earlier: number[];
}
/**
 * What Save does for rows from–to (pure; the server re-checks every part of it under its locks). `own` = the rows the
 * chosen sitting already has on this part (FR1, Fable L4: they are "already in that sitting", not another one's).
 */
export function addRowsPlan(rows: RowState[], total: number, from: number, to: number, own: number[] = []): AddRowsPlan {
  const mine = new Set(own);
  const picked = rows.filter((s) => s.row >= from && s.row <= to && s.row <= total).sort((a, b) => a.row - b.row);
  const tick = picked.filter((s) => !s.done).map((s) => s.row);
  const earlier = tick.length ? rows.filter((s) => !s.done && s.row < from && s.row <= total).map((s) => s.row).sort((a, b) => a - b) : [];
  return {
    rows: picked.map((s) => s.row), tick,
    add: picked.filter((s) => !s.linked && !mine.has(s.row)).map((s) => s.row),
    already: picked.filter((s) => mine.has(s.row)).map((s) => s.row),
    in_sitting: picked.filter((s) => s.linked && !mine.has(s.row)).map((s) => s.row),
    earlier,
  };
}

/** Why rows from–to can't be added, in plain words (the sheet and the server's refusal), or null when they can. */
export function addRowsRefusal(word: RowWord, plan: Pick<AddRowsPlan, "rows" | "in_sitting" | "earlier">, from: number, to: number): string | null {
  if (!plan.rows.length) return `There ${from === to ? `is no ${word} ${from}` : `are no ${word}s ${from}–${to}`} on this part.`;
  if (plan.in_sitting.length) {
    const n = plan.in_sitting.length;
    return `${wordTitle(word)}${n === 1 ? "" : "s"} ${rowsText(word, plan.in_sitting).replace(/^\w+ /, "")} ${n === 1 ? "is" : "are"} already in another sitting. A row is finished in one sitting only.`;
  }
  if (plan.earlier.length) {
    return `${wordTitle(word)}${plan.earlier.length === 1 ? "" : "s"} ${rowsText(word, plan.earlier).replace(/^\w+ /, "")} before ${word} ${from} ${plan.earlier.length === 1 ? "isn't" : "aren't"} ticked. Start at ${word} ${plan.earlier[0]}.`;
  }
  return null;
}

/** "Cuff rounds 1–20" with a part name (two or more parts), else "rounds 1–20". */
const partRowsText = (word: RowWord, rows: number[], partName: string | null) => `${partName ? `${partName} ` : ""}${rowsText(word, rows)}`;

/** What Save will do: "Ticks rows 1–30. Adds rows 1–30 to Sat 11/21, 90 min. Its 90 min stay as they are." */
export function addRowsSummary(word: RowWord, plan: AddRowsPlan, sitting: SittingChoice, partName: string | null = null): string {
  if (!plan.add.length) return `Nothing to add: ${partRowsText(word, plan.rows, partName)} ${plan.rows.length === 1 ? "is" : "are"} already in that sitting.`;
  const tick = plan.tick.length ? `Ticks ${partRowsText(word, plan.tick, partName)}. ` : "";
  const kept = plan.already.length ? ` ${wordTitle(word)}${plan.already.length === 1 ? "" : "s"} ${rowsText(word, plan.already).replace(/^\w+ /, "")} ${plan.already.length === 1 ? "is" : "are"} in it already.` : "";
  return `${tick}Adds ${partRowsText(word, plan.add, partName)} to ${sittingChoiceText(sitting)}.${kept} Its ${sitting.minutes} min stay as they are.`;
}

/**
 * The part the Add rows sheet works on (FR1, Codex P2: any part, finished ones too, apart from the screen's working
 * part): its rows, name, word and current row, which is the `expected_row` the save is guarded by.
 */
export interface AddRowsTarget { part_id: string; name: string; word: RowWord; total: number; finished: boolean; rows: RowState[]; expected_row: number }
export function addRowsTarget(
  view: { parts: Array<{ id: string; name: string; row_word: string; total_rows: number }>; active_part: { id: string } | null; row_states: RowState[]; part_rows: Record<string, RowState[]> },
  partId: string,
): AddRowsTarget | null {
  const part = view.parts.find((entry) => entry.id === partId);
  if (!part) return null;
  const rows = (view.active_part?.id === partId ? view.row_states : view.part_rows[partId]) ?? [];
  const expected = currentRowOf(rows, part.total_rows);
  return { part_id: part.id, name: part.name, word: part.row_word === "round" ? "round" : "row", total: part.total_rows, finished: expected > part.total_rows, rows, expected_row: expected };
}
/** The part a sitting most likely belongs to: the estimate's guess from the sitting's task, else the screen's part. */
export function addRowsDefaultPart(sittingParts: Record<string, string> | undefined, sessionId: string | null, parts: Array<{ id: string }>, screenPartId: string | null): string | null {
  const guess = sessionId ? sittingParts?.[sessionId] : undefined;
  if (guess && parts.some((part) => part.id === guess)) return guess;
  return screenPartId ?? parts[0]?.id ?? null;
}
/** The body POST /api/craft/[id]/sitting-rows gets: the picked part and its own current row. */
export function addRowsBody(target: AddRowsTarget, sessionId: string, from: number, to: number) {
  return { session_id: sessionId, part_id: target.part_id, expected_row: target.expected_row, from_row: from, to_row: to };
}

/** The line after a save, from the server's reply ("Added Cuff rounds 1–20 to Sat 11/21, 40 min."). */
export function sittingRowsAddedText(word: RowWord, result: { added?: number[]; ticked?: number[]; session_date?: string; minutes?: number }, partName: string | null = null): string {
  const added = result.added ?? [];
  const where = result.session_date ? ` to ${sittingChoiceText({ id: "", date: result.session_date, minutes: result.minutes ?? 0 })}` : "";
  if (!added.length) return `Nothing new to add${where}.`;
  return `Added ${partRowsText(word, added, partName)}${where}.${result.ticked?.length ? ` Ticked ${rowsText(word, result.ticked)}.` : ""}`;
}
