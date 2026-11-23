/**
 * Craft estimates (E1, Baseline b3d45d2e; plan `baseline-plans/craft-estimates/PLAN.md`, Brent 11/23 "Accept all 4"):
 * the forecast in rows, for the craft screen's Today box, Pace sheet and Parts list. Pure: no database, no React.
 *
 * It reuses `computeForecast` (work left, min a day needed, speeds, the E1 days and the 3-sittings rule) and
 * turns minutes into rows with each row's own stitches × the speed for its stitch type:
 * - Rows needed: walk the next rows in pattern order (the screen's part first, then the other parts by sort
 *   order, rows by number), adding each row's own minutes, until the day's minutes are used. Equal rows are
 *   the same walk (min a day ÷ min a row, rounded up); unequal rows never use a flat rows ÷ days.
 * - Today's target: the same walk from where you were this morning (rows finished today put back on the pile,
 *   work left then ÷ days left), at the speed from before today's sittings (today's only on the first day).
 *   It holds all day and resets each morning (Brent's pick 1).
 * - What you're doing: rows a day over the forecast's days (a row counts on the day of the sitting that
 *   finished it, else the day it was ticked); unequal rows show today's rows against today's target.
 * - Chips: Too early to tell / Behind so far (pick 2: warn early, never On track early) / On track / Behind /
 *   No due date. A finish date only with 3 counted sittings with rows on 3 days; more than a month late is
 *   words, never a far date.
 * - No stitch counts or no speed: rows only (rows left ÷ days left), no minutes, no date.
 */
import {
  FAR_LATE_DAYS, MIN_DAYS_WITH_ROWS_FOR_FINISH, MIN_SITTINGS_WITH_ROWS_FOR_FINISH, UNTYPED_WORK_TYPE,
  activeDays, addDays, buildUnitEntries, computeForecast, daysBetween, singularUnit,
  type PaceForecast, type PaceInput, type SpeedSource,
} from "@/lib/pace";
import { etDateOf } from "@/lib/work-sessions/parse";

/** `stitch_count`: the part's planned stitches (FR1: what a row with no stitch count counts as when no row of the part has one). */
export interface EstimatePart { id: string; name: string; sort_order: number; row_word: string; total_rows: number; stitch_count?: number | null }
/** A craft row: a checklist item linked to a part (`craft_part_id` + `craft_row`). Its units and type come from `pace.items`. */
export interface EstimateRow { item_id: string; part_id: string; row: number; is_done: boolean; completed_at: string | null }
export interface CraftEstimateInput {
  /** The project's forecast input (`today` is the ET day). */
  pace: PaceInput;
  parts: EstimatePart[];
  rows: EstimateRow[];
  /** The stored active part (the screen's part while it is unfinished). */
  active_part_id: string | null;
}

export type EstimateChipKind = "early" | "behind_so_far" | "ok" | "behind" | "none" | "done";
export interface EstimateChip { kind: EstimateChipKind; label: string }
export interface EstimateTile { label: string; value: string; unit: string; sub: string }
export interface EstimateFact { key: "from_here" | "finish" | "time" | "speed" | "left"; label: string; strong: string; small: string }
export interface EstimatePartLine { part_id: string; rows_left: number; finish_by: string | null; text: string }
export interface CraftEstimate {
  today: string;
  target_date: string | null;
  chip: EstimateChip;
  /** "equal" rows, "unequal" rows (the walk), or "rows" only (no stitch counts or no speed: no minutes). */
  mode: "equal" | "unequal" | "rows";
  row_word: "row" | "round";
  rows_left: number;
  /** Rows a day needed from here (null with no due date, past due, or nothing left). */
  rows_needed_per_day: number | null;
  /** Today's target: rows from this morning's position (holds all day); null with no due date. */
  today_target: { rows: number; part_id: string | null; row: number | null } | null;
  rows_done_today: number;
  /** A row worked on today but not finished ("+ part of row 52"). */
  partial_row: number | null;
  rows_to_go_today: number;
  minutes_to_go_today: number | null;
  rows_per_day: number;
  finish: { date: string | null; far_late: boolean; ready: boolean };
  /** Sittings in the forecast's days with minutes but no rows (counted ones only). */
  sittings_without_rows: Array<{ id: string; date: string; minutes: number }>;
  front: { head: string; bar: number | null; line: string; no_rows_line: string | null };
  sheet: {
    tiles: [EstimateTile, EstimateTile];
    warn: { strong: string; rest: string } | null;
    fix: string | null;
    chart: { days: Array<{ date: string; rows: number }>; needed: number | null } | null;
    facts: EstimateFact[];
  };
  parts: EstimatePartLine[];
  forecast: Pick<PaceForecast, "needed_minutes_per_day" | "cadence_minutes_per_day" | "cadence_days" | "finish_ready"
    | "sittings_with_rows" | "days_with_rows" | "behind_so_far" | "projected_finish" | "health" | "longest_day_minutes" | "plan_cadence_minutes_per_day">;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "2026-12-18" → "Dec 18". */
export const monthDay = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
/** "2026-12-18" → "Fri, Dec 18". */
export function weekdayDate(date: string): string {
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
  return `${WEEKDAYS[day]}, ${monthDay(date)}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
/** Rows that differ by no more than this share are "equal". */
const EQUAL_ROWS_TOLERANCE = 0.02;

interface Walk { count: number; ids: string[]; last: OrderedRow | null; minutes: number }
interface OrderedRow { row: EstimateRow; part: EstimatePart; cost: number | null }

/** Walk rows in order, adding each row's cost, until `budget` is used (the row that crosses it counts). */
function walk(rows: OrderedRow[], budget: number, costOf: (row: OrderedRow) => number): Walk {
  const out: Walk = { count: 0, ids: [], last: null, minutes: 0 };
  if (!(budget > 0)) return out;
  for (const entry of rows) {
    if (out.minutes >= budget - 1e-9) break;
    out.minutes += costOf(entry);
    out.count += 1;
    out.ids.push(entry.row.item_id);
    out.last = entry;
  }
  return out;
}

export function buildCraftEstimate(input: CraftEstimateInput): CraftEstimate {
  const { pace, parts } = input;
  const today = pace.today;
  const forecast = computeForecast(pace);
  const target = forecast.target_date;
  const partById = new Map(parts.map((part) => [part.id, part]));
  const rows = input.rows.filter((row) => partById.has(row.part_id) && row.row <= (partById.get(row.part_id) as EstimatePart).total_rows);
  const itemById = new Map(pace.items.map((item) => [item.id, item]));
  const taskById = new Map(pace.tasks.map((task) => [task.id, task]));
  // FR1 (P3a): a date in another year carries its year ("Jun 5, 2031").
  const md = (date: string) => `${monthDay(date)}${date.slice(0, 4) === today.slice(0, 4) ? "" : `, ${date.slice(0, 4)}`}`;
  const wd = (date: string) => `${weekdayDate(date)}${date.slice(0, 4) === today.slice(0, 4) ? "" : `, ${date.slice(0, 4)}`}`;

  // A row counts on the day of the sitting that finished it, else the day it was ticked.
  const finishedOn = new Map<string, string>();
  for (const session of pace.sessions) {
    for (const id of session.item_ids) {
      const known = finishedOn.get(id);
      if (known === undefined || session.session_date < known) finishedOn.set(id, session.session_date);
    }
  }
  const rowDay = (row: EstimateRow): string | null => (row.is_done
    ? finishedOn.get(row.item_id) ?? (row.completed_at ? etDateOf(row.completed_at) : null) : null);
  const doneToday = rows.filter((row) => rowDay(row) === today);
  const doneTodayIds = new Set(doneToday.map((row) => row.item_id));

  // This morning (FR1 P2-1): the whole project as it was: today's rows back on the pile, and a task that was closed
  // today (a band closed when its last row was ticked: one of its rows or steps was ticked today) open again.
  // Speed from before today's sittings (today's on the first day).
  const tickedToday = (item: { id: string; completed_at?: string | null }) => doneTodayIds.has(item.id)
    || Boolean(item.completed_at && etDateOf(item.completed_at) === today);
  const reopenedTasks = new Set(pace.items.filter((item) => item.is_done && tickedToday(item as { id: string; completed_at?: string | null }))
    .map((item) => item.task_id).filter((taskId) => taskById.get(taskId)?.status === "Done"));
  const earlier = pace.sessions.filter((session) => session.session_date < today);
  const morning = computeForecast({
    ...pace,
    tasks: pace.tasks.map((task) => (reopenedTasks.has(task.id) ? { ...task, status: "In Progress" } : task)),
    items: pace.items.map((item) => (doneTodayIds.has(item.id) ? { ...item, is_done: false } : item)),
    sessions: earlier.length > 0 ? earlier : pace.sessions,
  });

  const secondsFor = (f: PaceForecast, type: string) => f.work_types.find((entry) => entry.work_type === type)?.seconds_per_unit ?? null;
  const typeOf = (row: EstimateRow) => {
    const item = itemById.get(row.item_id);
    return item?.work_type ?? (item ? taskById.get(item.task_id)?.work_type : null) ?? UNTYPED_WORK_TYPE;
  };
  const unitsOf = (row: EstimateRow) => {
    const units = itemById.get(row.item_id)?.unit_count;
    return typeof units === "number" && units > 0 ? units : 0;
  };
  // FR2: the minutes of each row come from the shared forecast's own pricing (pace.ts), so the craft screen, the project
  // page and Portfolio agree. A row with a stitch count, or a craft row with none that the forecast counts as an average
  // row (an estimated entry), costs its units × its type's speed. A row of a task with no counted rows shares that
  // task's minutes (task units × speed, or its estimate) with the task's other open items. Nothing is ever free: a row
  // the forecast can't price leaves the forecast unpriced, and the screen goes by rows.
  const unitEntries = buildUnitEntries(pace.tasks, pace.items);
  const entryByItem = new Map(unitEntries.filter((entry) => entry.item_id).map((entry) => [entry.item_id as string, entry]));
  const taskEntry = new Map(unitEntries.filter((entry) => !entry.item_id).map((entry) => [entry.task_id, entry]));
  const itemsOfTask = new Map<string, typeof pace.items>();
  for (const item of pace.items) itemsOfTask.set(item.task_id, [...(itemsOfTask.get(item.task_id) ?? []), item]);
  const costWith = (f: PaceForecast, isDone: (itemId: string, done: boolean) => boolean) => (row: EstimateRow): number | null => {
    const entry = entryByItem.get(row.item_id);
    if (entry) {
      const seconds = secondsFor(f, entry.work_type);
      return seconds !== null && seconds > 0 ? (entry.units * seconds) / 60 : null;
    }
    const item = itemById.get(row.item_id);
    const task = item ? taskById.get(item.task_id) : undefined;
    if (!item || !task) return null;
    const siblings = itemsOfTask.get(task.id) ?? [];
    const whole = taskEntry.get(task.id);
    if (whole) {
      const seconds = secondsFor(f, whole.work_type);
      const open = siblings.filter((other) => !isDone(other.id, other.is_done)).length;
      return seconds !== null && seconds > 0 && open > 0 ? (whole.units * seconds) / 60 / open : null;
    }
    const estimate = Number(task.estimated_minutes) || 0;
    return estimate > 0 && siblings.length > 0 ? estimate / siblings.length : null;
  };

  // Pattern order: parts by sort order, rows by number. "Now" puts the screen's part first; this morning's walk
  // never does (FR1 P2-1: the part on the screen changes during the day, the morning doesn't).
  const sortedParts = [...parts].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const ordered = (isDone: (row: EstimateRow) => boolean, cost: (row: EstimateRow) => number | null, anchorFirst: boolean): OrderedRow[] => {
    const undone = rows.filter((row) => !isDone(row));
    const hasUndone = (partId: string) => undone.some((row) => row.part_id === partId);
    const anchor = anchorFirst ? (input.active_part_id && hasUndone(input.active_part_id) ? input.active_part_id : null) : null;
    const partOrder = [...sortedParts.filter((part) => part.id === anchor), ...sortedParts.filter((part) => part.id !== anchor)];
    return partOrder.flatMap((part) => undone.filter((row) => row.part_id === part.id).sort((a, b) => a.row - b.row)
      .map((row) => ({ row, part, cost: cost(row) })));
  };
  const nowRows = ordered((row) => row.is_done, costWith(forecast, (_id, done) => done), true);
  const morningRows = ordered((row) => row.is_done && !doneTodayIds.has(row.item_id), costWith(morning, (id, done) => done && !doneTodayIds.has(id)), false);
  const rowsLeft = nowRows.length;
  const anchorPart = nowRows[0]?.part ?? morningRows[0]?.part ?? partById.get(input.active_part_id ?? "") ?? sortedParts[0];
  const rowWord: "row" | "round" = anchorPart?.row_word === "round" ? "round" : "row";
  const rowsWord = (n: number) => (n === 1 ? rowWord : `${rowWord}s`);
  const Rows = rowWord === "round" ? "Rounds" : "Rows";

  // Minutes or rows only: no stitch counts at all, or work with no speed, are counted in rows.
  const isPriced = (list: OrderedRow[], f: PaceForecast) => (list.length > 0 ? list.some((entry) => entry.cost !== null) : true) && f.work_left_minutes !== null;
  const priced = isPriced(nowRows, forecast);
  const morningPriced = isPriced(morningRows, morning);
  const costs = nowRows.map((entry) => entry.cost).filter((cost): cost is number => cost !== null);
  const isEqual = (list: number[]) => list.length === 0 || Math.max(...list) <= Math.min(...list) * (1 + EQUAL_ROWS_TOLERANCE);
  const mode: CraftEstimate["mode"] = !priced ? "rows" : isEqual(costs) ? "equal" : "unequal";
  // Today's line keeps this morning's kind of target all day (a part finished today can leave only equal rows).
  const morningMode: CraftEstimate["mode"] = !morningPriced ? "rows"
    : isEqual(morningRows.map((entry) => entry.cost).filter((cost): cost is number => cost !== null)) ? "equal" : "unequal";
  const pricedCost = (entry: OrderedRow) => entry.cost ?? 0;
  const estimatedRows = nowRows.filter((entry) => entryByItem.get(entry.row.item_id)?.estimated);
  const sharedRows = nowRows.filter((entry) => !entryByItem.has(entry.row.item_id) && entry.cost !== null);

  const daysLeft = forecast.available_days;
  const pastDue = target !== null && target < today;
  const dueToday = target === today;
  // Work left and min a day: the shared forecast's (FR2: rows with no stitch count are priced there, once).
  const workLeft = forecast.work_left_minutes;
  const needed = forecast.needed_minutes_per_day;
  const morningNeeded = morning.needed_minutes_per_day;
  const nowWalk = priced && needed !== null ? walk(nowRows, needed, pricedCost) : null;
  const rowsNeededPerDay = rowsLeft === 0 || pastDue || !target || !daysLeft ? null
    : priced ? (nowWalk ? nowWalk.count : null) : Math.ceil(rowsLeft / daysLeft);

  // Today's target, from this morning (holds all day, FR1 P2-1 / P3b: its own mode, minutes or rows).
  let todayTarget: CraftEstimate["today_target"] = null;
  let targetIds: string[] = [];
  if (target && !pastDue && daysLeft && morningRows.length > 0) {
    if (morningPriced && morningNeeded !== null) {
      const w = walk(morningRows, morningNeeded, pricedCost);
      todayTarget = { rows: w.count, part_id: w.last?.part.id ?? null, row: w.last?.row.row ?? null };
      targetIds = w.ids;
    } else if (!morningPriced) {
      const n = Math.min(morningRows.length, Math.ceil(morningRows.length / daysLeft));
      const last = morningRows[n - 1];
      todayTarget = { rows: n, part_id: last?.part.id ?? null, row: last?.row.row ?? null };
      targetIds = morningRows.slice(0, n).map((entry) => entry.row.item_id);
    }
  }
  const rowsDoneToday = doneToday.length;
  // Done means the target's own rows are ticked (FR1 P2-1), never just "as many rows" somewhere else.
  const targetSet = new Set(targetIds);
  const toGo = nowRows.filter((entry) => targetSet.has(entry.row.item_id));
  const rowsToGo = todayTarget ? toGo.length : 0;
  const targetDone = todayTarget ? todayTarget.rows - rowsToGo : 0;
  const minutesToGo = todayTarget && priced ? toGo.reduce((sum, entry) => sum + pricedCost(entry), 0) : null;
  const undoneIds = new Set(nowRows.map((entry) => entry.row.item_id));
  const partialId = pace.sessions.filter((session) => session.session_date === today)
    .flatMap((session) => session.in_progress_item_ids ?? []).find((id) => undoneIds.has(id));
  const partialRow = partialId ? rows.find((row) => row.item_id === partialId)?.row ?? null : null;
  const partialText = partialRow !== null ? `part of ${rowWord} ${partialRow}` : null;

  // What you're doing: rows a day over the forecast's days (or, with no sittings, the days rows were ticked).
  const rowDays = rows.map(rowDay).filter((day): day is string => day !== null);
  const span = forecast.cadence_days > 0 ? { from: forecast.cadence_from, days: forecast.cadence_days } : activeDays(rowDays, today);
  const inSpan = (day: string | null) => day !== null && span.from !== null && day >= span.from && day <= today;
  const rowsInSpan = rows.filter((row) => inSpan(rowDay(row))).length;
  const rowsPerDay = span.days > 0 ? rowsInSpan / span.days : 0;
  const windowStart = addDays(today, -13);
  const inWindow = pace.sessions.filter((session) => session.session_date >= windowStart && session.session_date <= today);
  const todaySessions = pace.sessions.filter((session) => session.session_date === today);
  const minutesToday = todaySessions.reduce((sum, session) => sum + session.minutes, 0);
  const sittingsWithoutRows = inWindow.filter((session) => !session.exclude_from_stats && session.minutes > 0
    && session.item_ids.length === 0 && (session.in_progress_item_ids ?? []).length === 0 && !(Number(session.extra_units) > 0))
    .sort((a, b) => a.session_date.localeCompare(b.session_date) || a.id.localeCompare(b.id))
    .map((session) => ({ id: session.id, date: session.session_date, minutes: session.minutes }));

  // Finish and health. Rows only: no date; On track / Behind from rows a day once there is enough.
  const ready = forecast.finish_ready;
  const finishDate = priced ? forecast.projected_finish : null;
  const health = forecast.health;
  const behindSoFar = forecast.behind_so_far;
  const farLate = Boolean(finishDate && target && daysBetween(target, finishDate) > FAR_LATE_DAYS);
  // FR1 (P2-2): every row ticked is not "done" while finishing (or any other open work) is left.
  const otherLeft = workLeft === null ? null : Math.max(0, workLeft - nowRows.reduce((sum, entry) => sum + pricedCost(entry), 0));
  const allDone = rows.length > 0 && rowsLeft === 0 && workLeft !== null && workLeft <= 0;
  let chip: EstimateChip;
  if (allDone) chip = { kind: "done", label: "All done" };
  else if (!target) chip = { kind: "none", label: "No due date" };
  else if (pastDue) chip = { kind: "behind", label: "Behind" };
  else if (!ready) chip = priced && behindSoFar ? { kind: "behind_so_far", label: "Behind so far" } : { kind: "early", label: "Too early to tell" };
  // FR1 (P3d): rows a day against the unrounded rows a day needed.
  else if (!priced) chip = daysLeft && rowsPerDay + 1e-9 >= rowsLeft / daysLeft ? { kind: "ok", label: "On track" } : { kind: "behind", label: "Behind" };
  else if (health === "on_track") chip = { kind: "ok", label: "On track" };
  else if (health === "behind") chip = { kind: "behind", label: "Behind" };
  else chip = { kind: "early", label: "Too early to tell" };

  // ── Front: the Today box ──
  const reached = todayTarget !== null && todayTarget.rows > 0 && rowsToGo === 0;
  const head = todayTarget && !reached ? `${targetDone} of ${todayTarget.rows} ${rowsWord(todayTarget.rows)}` : `${rowsDoneToday} ${rowsWord(rowsDoneToday)}`;
  const bar = todayTarget && todayTarget.rows > 0 ? Math.min(1, targetDone / todayTarget.rows) : null;
  const finishWords = finishDate && !farLate ? `Finish about ${md(finishDate)}` : farLate && target ? `Finish more than a month after ${md(target)}` : null;
  const measured = isMeasured(focusSource(forecast, nowRows, typeOf)?.source);
  const finishingLeft = otherLeft !== null && otherLeft > 0 ? `about ${whole(otherLeft)} min of finishing left` : null;
  let line: string;
  if (rows.length === 0) line = "No rows on the craft screen yet.";
  else if (allDone) line = `Every ${rowWord} is ticked.`;
  else if (rowsLeft === 0) line = `Every ${rowWord} is ticked; ${finishingLeft ?? "some work is left"}${pastDue ? `, ${plural(daysBetween(target as string, today), "day")} past` : dueToday ? ", due today" : ""}.`;
  else if (pastDue) line = `${plural(rowsLeft, rowWord)} left, ${plural(daysBetween(target as string, today), "day")} past`;
  else if (!target) line = finishWords ?? (span.days > 0 && rowsInSpan > 0 ? `${whole(rowsPerDay)} ${rowsWord(Math.round(rowsPerDay))} a day so far. No due date.` : "No due date, so no daily target.");
  else if (dueToday) line = `${plural(rowsLeft, rowWord)} left, due today`;
  else if (reached && todayTarget) line = `${todayTarget.rows} needed, done.${finishWords ? ` ${finishWords}` : ""}`;
  else if (morningMode === "unequal" && todayTarget) line = `${plural(rowsToGo, rowWord)} to go, about ${whole(minutesToGo ?? 0)} min at ${measured ? "your" : "plan"} speed`;
  else if (todayTarget) line = `${todayTarget.rows} ${rowsWord(todayTarget.rows)} a day to finish by ${wd(target)}`;
  else line = "No daily target yet.";
  // FR1 (P3c): a row partway today shows in every mode.
  if (partialText && rowsLeft > 0) line = `${line}${line.endsWith(".") ? "" : " ·"} + ${partialText}`;
  const noRowsLine = sittingsWithoutRows.length > 0
    ? `${plural(sittingsWithoutRows.length, "sitting")} ${sittingsWithoutRows.length === 1 ? "has" : "have"} no ${rowWord}s.` : null;

  // ── The Pace sheet: This project ──
  const unit = singularUnit(pace.project.unit_label?.trim() || "stitches");
  const targetRowText = todayTarget?.row !== null && todayTarget?.row !== undefined
    ? (todayTarget.part_id && todayTarget.part_id !== anchorPart?.id
      ? `to ${partById.get(todayTarget.part_id)?.name ?? "the next part"} ${rowWord} ${todayTarget.row}`
      : `to ${rowWord} ${todayTarget.row} of ${anchorPart?.total_rows ?? todayTarget.row}`) : "";
  let neededTile: EstimateTile;
  if (allDone) neededTile = { label: "Needed", value: "0", unit: `${rowWord}s left`, sub: "all ticked" };
  else if (rowsLeft === 0) neededTile = {
    label: "Needed", value: needed === null || !target || pastDue ? "—" : whole(needed), unit: "min a day",
    sub: target ? `finishing, ${pastDue ? "due" : "by"} ${wd(target)}` : "finishing, no due date",
  };
  else if (!target) neededTile = { label: "Needed", value: "—", unit: "", sub: "no due date" };
  else if (pastDue) neededTile = { label: "Needed", value: whole(rowsLeft), unit: `${rowsWord(rowsLeft)} left`, sub: `due ${wd(target)}` };
  else if (mode === "unequal" && todayTarget) neededTile = { label: "Needed today", value: whole(todayTarget.rows), unit: rowsWord(todayTarget.rows), sub: targetRowText };
  else neededTile = {
    label: "Needed", value: rowsNeededPerDay === null ? "—" : whole(rowsNeededPerDay), unit: `${rowsWord(rowsNeededPerDay ?? 2)} a day`,
    sub: ready && priced && needed !== null ? `${whole(needed)} min, by ${wd(target)}` : `to finish by ${wd(target)}`,
  };
  let youTile: EstimateTile;
  if (mode === "unequal") {
    youTile = {
      label: "You", value: whole(rowsDoneToday), unit: `${rowsWord(rowsDoneToday)} today${partialText ? ` + ${partialText}` : ""}`,
      sub: todaySessions.length ? `${whole(minutesToday)} min in ${plural(todaySessions.length, "sitting")}` : "no sittings today",
    };
  } else if (rowsInSpan === 0) {
    youTile = {
      label: "You", value: "0", unit: `${rowWord}s ticked`,
      sub: `${span.days > 0 ? `${whole(forecast.minutes_in_cadence_window)} min in ${plural(span.days, "day")}` : "no sittings in 14 days"}${partialText ? ` · + ${partialText}` : ""}`,
    };
  } else {
    youTile = {
      label: "You", value: whole(rowsPerDay), unit: `${rowsWord(Math.round(rowsPerDay))} a day`,
      sub: `${whole(forecast.cadence_minutes_per_day)} min, ${span.days === 1 ? "today" : `last ${span.days} days`}${partialText ? ` · + ${partialText}` : ""}`,
    };
  }

  const planNeed = forecast.plan_cadence_minutes_per_day;
  const planText = planNeed !== null && needed !== null && Math.round(planNeed) !== Math.round(needed) ? ` At plan speed it would need ${whole(planNeed)}.` : "";
  let warn: CraftEstimate["sheet"]["warn"] = null;
  if (!allDone && pastDue) warn = { strong: `The due date, ${wd(target as string)}, has passed.`, rest: ` ${plural(rowsLeft, rowWord)} left.` };
  else if (!allDone && chip.kind === "behind_so_far" && needed !== null) {
    warn = { strong: `Needs ${whole(needed)} min a day${measured ? " at your speed" : ""}. Your longest day is ${whole(forecast.longest_day_minutes)}.`, rest: planText };
  } else if (!allDone && chip.kind === "behind" && priced && needed !== null) {
    warn = { strong: `Needs ${whole(needed)} min a day. You're doing ${whole(forecast.cadence_minutes_per_day)}.`, rest: planText };
  }
  const fix = sittingsWithoutRows.length > 0
    ? `${plural(sittingsWithoutRows.length, "sitting")} ${sittingsWithoutRows.length === 1 ? "has" : "have"} time but no ${rowWord}s: ${sittingsWithoutRows.slice(0, 4)
      .map((s) => `${wd(s.date).slice(0, 3)} ${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8, 10))}, ${s.minutes} min`).join("; ")}${sittingsWithoutRows.length > 4 ? "; …" : ""}. Their time counts, but they can't give a speed until they have ${rowWord}s.`
    : null;
  const chart = span.days >= 3 && span.from && rowsInSpan > 0 ? {
    days: Array.from({ length: span.days }, (_, i) => {
      const date = addDays(span.from as string, i);
      return { date, rows: rows.filter((row) => rowDay(row) === date).length };
    }),
    needed: rowsNeededPerDay,
  } : null;

  const facts: EstimateFact[] = [];
  if (mode === "unequal" && nowWalk && nowWalk.count > 0 && rowsNeededPerDay !== null && daysLeft) {
    const first = nowRows[0];
    const last = nowWalk.last as OrderedRow;
    const average = rowsLeft / daysLeft;
    const span1 = first.part.id === last.part.id
      ? `${Rows} ${first.row.row} to ${last.row.row} next.`
      : `${first.part.name} ${rowWord} ${first.row.row} to ${last.part.name} ${rowWord} ${last.row.row} next.`;
    const trend = Math.round(average) < rowsNeededPerDay ? ` ${Rows} get longer, so the count drops: about ${whole(average)} a day on average.`
      : Math.round(average) > rowsNeededPerDay ? ` ${Rows} get shorter, so the count rises: about ${whole(average)} a day on average.` : "";
    facts.push({ key: "from_here", label: "From here", strong: `${rowsNeededPerDay} ${rowsWord(rowsNeededPerDay)} a day`, small: `${span1}${trend}` });
  }
  const sittingsWord = forecast.sittings_with_rows;
  let finishFact: EstimateFact;
  if (allDone) finishFact = { key: "finish", label: "Finish", strong: "Done", small: `Every ${rowWord} is ticked.` };
  else if (!priced && rowsLeft > 0) finishFact = { key: "finish", label: "Finish", strong: "No date", small: `These ${rowWord}s have no stitch counts or speed, so it goes by ${rowWord}s a day.` };
  else if (!ready) {
    finishFact = {
      key: "finish", label: "Finish", strong: "No date yet",
      small: `Needs ${MIN_SITTINGS_WITH_ROWS_FOR_FINISH} counted sittings with ${rowWord}s, on ${MIN_DAYS_WITH_ROWS_FOR_FINISH} different days. You have ${sittingsWord === 0 ? "none yet" : `${sittingsWord} on ${plural(forecast.days_with_rows, "day")}`}.`,
    };
  } else if (!finishDate) {
    finishFact = { key: "finish", label: "Finish", strong: "No date yet", small: forecast.cadence_days === 0 ? "No sittings in the last 14 days." : "Some work has no speed yet." };
  } else if (farLate && target) {
    finishFact = { key: "finish", label: "Finish", strong: "More than a month late", small: `More than a month after ${wd(target)} at ${whole(forecast.cadence_minutes_per_day)} min a day.` };
  } else {
    const slack = target ? daysBetween(finishDate, target) : null;
    finishFact = {
      key: "finish", label: "Finish", strong: `About ${wd(finishDate)}`,
      small: slack === null ? `At ${whole(forecast.cadence_minutes_per_day)} min a day.` : slack > 0 ? `${plural(slack, "day")} early.` : slack === 0 ? "On the due date." : `${plural(-slack, "day")} late.`,
    };
  }
  facts.push(finishFact);
  const source = focusSource(forecast, nowRows, typeOf);
  if (priced && rowsLeft > 0 && source) {
    const minPerRow = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null;
    const plan = forecast.plan_speeds.find((entry) => entry.work_type === source.work_type)?.seconds_per_unit ?? null;
    const avgUnits = nowRows.length ? nowRows.reduce((sum, entry) => sum + unitsOf(entry.row), 0) / nowRows.length : 0;
    if (source.source === "plan" && !ready && !warn && needed !== null) {
      facts.push({
        key: "time", label: "Time", strong: `${whole(needed)} min a day needed`,
        small: `At plan speed, about ${minPerRow === null ? "?" : whole(minPerRow)} min a ${rowWord}. You: ${whole(forecast.cadence_minutes_per_day)} a day${forecast.cadence_days > 0 ? ` over ${plural(forecast.cadence_days, "day")}` : ""}.`,
      });
    } else if (source.seconds_per_unit !== null) {
      const excludedInWindow = inWindow.filter((session) => session.exclude_from_stats).length;
      const from = source.source === "measured"
        ? `From ${plural(source.n_sessions, "sitting")}${excludedInWindow ? `; ${excludedInWindow} left out as learning` : ""}.`
        : source.source === "measured_sample" ? `From the swatch (${plural(source.n_sessions, "sitting")}).`
          : source.source === "other_projects" ? `From ${plural(source.n_sessions, "sitting")} on your other projects; none with ${rowWord}s here yet.`
            : source.source === "plan_x_ratio" ? "Plan × your pace so far." : "Plan speed: nothing measured yet.";
      const planWord = plan === null ? "" : mode === "equal" ? `Plan ${((plan * avgUnits) / 60).toFixed(1)}. ` : `Plan ${plan.toFixed(2)}. `;
      facts.push({
        key: "speed", label: "Speed",
        strong: mode === "equal" && minPerRow !== null ? `${minPerRow.toFixed(1)} min a ${rowWord}` : `${source.seconds_per_unit.toFixed(1)} s a ${unit}`,
        small: `${planWord}${from}`,
      });
    }
  }
  const partsLeft = new Set(nowRows.map((entry) => entry.part.id)).size;
  // FR2: "finishing" is the unit-less work of tasks that hold no craft rows (a row task's estimate is its rows' time).
  const rowTaskIds = new Set(rows.map((row) => itemById.get(row.item_id)?.task_id).filter((id): id is string => Boolean(id)));
  const sharedTasks = new Set(sharedRows.map((entry) => itemById.get(entry.row.item_id)?.task_id)).size;
  const rowTaskUnitless = pace.tasks.filter((task) => rowTaskIds.has(task.id) && !taskEntry.has(task.id) && !unitEntries.some((entry) => entry.task_id === task.id)
    && !["Done", "Missed", "Parked"].includes(task.status)).reduce((sum, task) => {
    const list = itemsOfTask.get(task.id) ?? [];
    const share = list.length ? list.filter((item) => item.is_done).length / list.length : 0;
    return sum + (Number(task.estimated_minutes) || 0) * (1 - share);
  }, 0);
  const finishingMinutes = Math.max(0, forecast.unitless_minutes_left - rowTaskUnitless);
  const unitsLeft = nowRows.reduce((sum, entry) => sum + unitsOf(entry.row), 0);
  const leftSmall = [
    unitsLeft > 0 ? `${whole(unitsLeft)} ${unitsLeft === 1 ? unit : pace.project.unit_label?.trim() || "stitches"}.` : null,
    estimatedRows.length > 0 ? `${plural(estimatedRows.length, rowWord)} ${estimatedRows.length === 1 ? "has" : "have"} no stitch count; ${estimatedRows.length === 1 ? "it counts" : "each counts"} as an average ${rowWord}.` : null,
    sharedRows.length > 0 ? `${plural(sharedRows.length, rowWord)} ${sharedRows.length === 1 ? "has" : "have"} no stitch count; ${sharedRows.length === 1 ? "it shares its task's estimate" : sharedTasks === 1 ? "they share their task's estimate" : "they share their tasks' estimates"}.` : null,
    finishingMinutes > 0 ? `Plus about ${whole(finishingMinutes)} min of finishing.` : null,
    target ? `Due ${wd(target)}.` : "No due date.",
  ].filter(Boolean).join(" ");
  facts.push({ key: "left", label: "Left", strong: `${whole(rowsLeft)} ${rowsWord(rowsLeft)}${partsLeft > 1 ? ` in ${partsLeft} parts` : ""}`, small: leftSmall });

  // ── Parts: rows left; with two or more parts, a "finish by" date each (today + the walk at the needed pace) ──
  const finishBy = new Map<string, string>();
  const budget = priced ? needed : rowsNeededPerDay;
  if (target && !pastDue && budget !== null && budget > 0 && rowsLeft > 0) {
    let cumulative = 0;
    for (const entry of nowRows) {
      cumulative += priced ? pricedCost(entry) : 1;
      const day = addDays(today, Math.max(0, Math.ceil(cumulative / budget - 1e-9) - 1));
      finishBy.set(entry.part.id, day);
    }
  }
  // Parts with no rows (hidden on the screen until Reset) get no line.
  const partLines: EstimatePartLine[] = sortedParts.filter((part) => rows.some((row) => row.part_id === part.id)).map((part) => {
    const left = nowRows.filter((entry) => entry.part.id === part.id).length;
    const by = left > 0 && partsLeft >= 2 ? finishBy.get(part.id) ?? null : null;
    const word = part.row_word === "round" ? "round" : "row";
    const text = left === 0 ? `All ${word}s ticked`
      : by && target ? `${plural(left, word)} left · finish by ${by >= target ? md(target) : `about ${md(by)}`}`
        : `${plural(left, word)} left${target && partsLeft < 2 ? ` · due ${wd(target)}` : ""}`;
    return { part_id: part.id, rows_left: left, finish_by: by, text };
  });

  return {
    today, target_date: target, chip, mode, row_word: rowWord, rows_left: rowsLeft,
    rows_needed_per_day: rowsNeededPerDay, today_target: todayTarget, rows_done_today: rowsDoneToday, partial_row: partialRow,
    rows_to_go_today: rowsToGo, minutes_to_go_today: minutesToGo === null ? null : Math.round(minutesToGo),
    rows_per_day: Math.round(rowsPerDay * 10) / 10,
    finish: { date: farLate ? null : finishDate, far_late: farLate, ready },
    sittings_without_rows: sittingsWithoutRows,
    front: { head, bar, line, no_rows_line: noRowsLine },
    sheet: { tiles: [neededTile, youTile], warn, fix, chart, facts },
    parts: partLines,
    forecast: {
      needed_minutes_per_day: needed, cadence_minutes_per_day: forecast.cadence_minutes_per_day,
      cadence_days: forecast.cadence_days, finish_ready: forecast.finish_ready, sittings_with_rows: forecast.sittings_with_rows,
      days_with_rows: forecast.days_with_rows, behind_so_far: behindSoFar, projected_finish: farLate ? null : finishDate,
      health, longest_day_minutes: forecast.longest_day_minutes, plan_cadence_minutes_per_day: forecast.plan_cadence_minutes_per_day,
    },
  };
}

const isMeasured = (source: SpeedSource | null | undefined) => source === "measured" || source === "measured_sample" || source === "other_projects";

/** The speed shown: the stitch type with the most minutes left among the rows to do. */
function focusSource(forecast: PaceForecast, rows: OrderedRow[], typeOf: (row: EstimateRow) => string) {
  const minutes = new Map<string, number>();
  for (const entry of rows) minutes.set(typeOf(entry.row), (minutes.get(typeOf(entry.row)) ?? 0) + (entry.cost ?? 0));
  const type = [...minutes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const row = type ? forecast.work_types.find((entry) => entry.work_type === type) : undefined;
  return row ?? null;
}
