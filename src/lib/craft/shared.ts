/**
 * Craft estimates E4 (Baseline f98e79da; plan `baseline-plans/craft-estimates/PLAN.md` "Sharing time across projects",
 * Brent's pick B, 11/23): the Pace sheet's All projects tab. Pure: no database, no React.
 *
 * It adds nothing to the forecast. Every number comes from each project's own estimate (`buildCraftEstimate`, which
 * takes its minutes from the shared `computeForecast`), so a project's minutes a day here are exactly its This project
 * numbers, and one project alone reads the same as This project:
 * - Shared: open craft projects with a due date (Done, Cancelled and On Hold projects, all-done ones and ones with no
 *   due date are left out; the ones with no due date or on hold are named).
 * - Needed: the sum of each project's minutes a day needed (minutes, never rows: rows aren't the same size across
 *   projects).
 * - You: every sitting minute on these projects in the last 14 days ÷ the days since you started in them (the forecast's
 *   own cadence rule, `activeDays`, over all of them together).
 * - Soonest due first: the soonest due project gets its minutes a day first, what is left goes to the next, and so on
 *   (same due date: the one needing fewer minutes first). A project that gets less than it needs is short; its rows a
 *   day are the rows that fit in what it gets (`rowsWithin`, the same walk as "rows needed").
 * - Past due: listed first, never given time (its daily need can't be worked out); rows only (no stitch counts or
 *   speed): listed with its rows a day, not in the minutes.
 */
import { CADENCE_WINDOW_DAYS, MIN_DAYS_WITH_ROWS_FOR_FINISH, MIN_SITTINGS_WITH_ROWS_FOR_FINISH, activeDays, addDays, daysBetween, round } from "@/lib/pace";
import { rowsWithin, weekdayDate, type CraftEstimate, type EstimateTile } from "@/lib/craft/estimate";

/** Project stages that are not shared (a parked project is On Hold). */
export const NOT_SHARED_STAGES = ["Done", "Cancelled", "On Hold"] as const;

export interface SharedProjectInput {
  project_id: string;
  name: string | null;
  /** The project's stage (null when unknown: treated as open). */
  stage: string | null;
  estimate: CraftEstimate | null;
}
export type SharedState = "fits" | "short" | "no_time" | "rows_only" | "past_due";
export interface SharedProjectLine {
  project_id: string;
  name: string;
  due: string;
  due_text: string;
  state: SharedState;
  /** Minutes a day needed (the project's own, unrounded to the minute); null for rows only and past due. */
  needed: number | null;
  /** Minutes a day it gets, soonest due first; null when it isn't given time. */
  given: number | null;
  /** Rows a day: needed when it fits, what fits in `given` when short; null when there is no daily row count. */
  rows: number | null;
  rows_text: string;
  minutes_text: string | null;
  /** Share of the need it gets (0–1) for the bar; null with no need. */
  bar: number | null;
  line: string;
}
export interface SharedFact { key: "order" | "finish"; label: string; strong: string; small: string }
export interface SharedTime {
  today: string;
  /** Projects given time (a minutes need, not past due). */
  counted: number;
  needed_minutes_per_day: number | null;
  you_minutes_per_day: number;
  you_days: number;
  tiles: [EstimateTile, EstimateTile];
  warn: { strong: string; rest: string } | null;
  projects: SharedProjectLine[];
  facts: SharedFact[];
  left_out: string | null;
  /** No project to share: the one line shown instead. */
  empty: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const listOf = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const allOf = (n: number) => (n === 2 ? "both" : `all ${n}`);

export function buildSharedTime(inputs: SharedProjectInput[], today: string): SharedTime {
  const wd = (date: string) => `${weekdayDate(date)}${date.slice(0, 4) === today.slice(0, 4) ? "" : `, ${date.slice(0, 4)}`}`;

  // Which projects share time.
  const noDue: string[] = [], onHold: string[] = [];
  let unreadable = 0;
  const shared: Array<{ input: SharedProjectInput; estimate: CraftEstimate; name: string; due: string }> = [];
  for (const input of inputs) {
    const name = input.name?.trim() || "A craft project";
    const estimate = input.estimate;
    if (!estimate) { unreadable += 1; continue; }
    if (input.stage === "On Hold") { onHold.push(name); continue; }
    if (NOT_SHARED_STAGES.includes(input.stage as (typeof NOT_SHARED_STAGES)[number])) continue;
    if (estimate.chip.kind === "done") continue;
    if (!estimate.target_date) { noDue.push(name); continue; }
    shared.push({ input, estimate, name, due: estimate.target_date });
  }
  const leftOut = [
    noDue.length ? `${listOf(noDue)} (no due date)` : null,
    onHold.length ? `${listOf(onHold)} (on hold)` : null,
  ].filter(Boolean).join("; ");
  const leftOutText = [leftOut ? `Not shared: ${leftOut}.` : null, unreadable ? `${plural(unreadable, "project")} couldn't be read.` : null].filter(Boolean).join(" ") || null;

  // Every sitting minute on these projects in the last 14 days ÷ the days since you started in them (the forecast's rule).
  const byDay = new Map<string, number>();
  for (const { estimate } of shared) for (const day of estimate.sitting_days) byDay.set(day.date, (byDay.get(day.date) ?? 0) + day.minutes);
  const windowStart = addDays(today, -(CADENCE_WINDOW_DAYS - 1));
  const windowMinutes = [...byDay].filter(([date]) => date >= windowStart && date <= today).reduce((sum, [, minutes]) => sum + minutes, 0);
  const span = activeDays([...byDay.keys()], today);
  const you = round(span.days > 0 ? windowMinutes / span.days : 0, 1);

  const needOf = (estimate: CraftEstimate): number | null => {
    if (estimate.mode === "rows" || estimate.target_date === null || estimate.target_date < today) return null;
    return estimate.forecast.needed_minutes_per_day;
  };
  // Soonest due first; same due date: the one needing fewer minutes first (more projects fit), then by name.
  const ordered = [...shared].sort((a, b) => a.due.localeCompare(b.due)
    || (needOf(a.estimate) ?? Infinity) - (needOf(b.estimate) ?? Infinity)
    || a.name.localeCompare(b.name) || a.input.project_id.localeCompare(b.input.project_id));
  const tie = ordered.some((entry, i) => i > 0 && ordered[i - 1].due === entry.due);

  let left = you;
  const lines: SharedProjectLine[] = ordered.map(({ input, estimate, name, due }) => {
    const word = estimate.row_word;
    const rowsWord = (n: number) => (n === 1 ? word : `${word}s`);
    const need = needOf(estimate);
    const base = { project_id: input.project_id, name, due, due_text: `due ${wd(due)}` };
    if (due < today) {
      const past = daysBetween(due, today);
      return {
        ...base, state: "past_due", needed: null, given: null, rows: null, bar: null, minutes_text: null,
        rows_text: `${plural(estimate.rows_left, word)} left`,
        line: `${plural(past, "day")} past. No time is set aside for it until it has a new due date.`,
      };
    }
    if (need === null) {
      const rows = estimate.rows_needed_per_day;
      return {
        ...base, state: "rows_only", needed: null, given: null, rows, bar: null, minutes_text: null,
        rows_text: rows === null ? `${plural(estimate.rows_left, word)} left` : `${rows} ${rowsWord(rows)} a day`,
        line: "Rows only: no stitch counts or speed, so its time isn't in the minutes above.",
      };
    }
    const rowsText = (rows: number | null) => (rows === null ? (estimate.rows_left === 0 ? "Finishing" : "—") : `${rows} ${rowsWord(rows)} a day`);
    if (you <= 0) {
      return {
        ...base, state: "no_time", needed: need, given: 0, rows: estimate.rows_needed_per_day, bar: 0, minutes_text: `${whole(need)} min`,
        rows_text: rowsText(estimate.rows_needed_per_day), line: `Needs ${whole(need)} min a day.`,
      };
    }
    const given = Math.min(need, Math.max(0, left));
    left -= given;
    const fits = given >= need - 1e-9;
    const rows = fits ? estimate.rows_needed_per_day : estimate.walk_minutes ? rowsWithin(estimate.walk_minutes, given) : null;
    const speed = estimate.measured ? "your" : "plan";
    const line = fits ? `Fits, at ${speed} speed.`
      : given <= 1e-9 ? `Short: no time left for it at ${whole(you)} min a day.`
        : `Short: ${whole(given)} min a day left for it${rows !== null && estimate.walk_minutes ? `, about ${rows} ${rowsWord(rows)}` : ""}.`;
    return {
      ...base, state: fits ? "fits" : "short", needed: need, given, rows, bar: need > 0 ? Math.min(1, given / need) : 1,
      minutes_text: `${whole(need)} min`, rows_text: fits ? rowsText(rows) : rowsText(estimate.rows_needed_per_day), line,
    };
  });

  const counted = lines.filter((line) => line.needed !== null);
  const needed = counted.length ? counted.reduce((sum, line) => sum + (line.needed as number), 0) : null;
  const notCounted = lines.length - counted.length;
  const tiles: [EstimateTile, EstimateTile] = [
    {
      label: "Needed", value: needed === null ? "—" : whole(needed), unit: "min a day",
      sub: notCounted > 0 ? `for ${counted.length} of ${plural(lines.length, "project")}` : `for ${plural(counted.length, "project")}`,
    },
    { label: "You", value: whole(you), unit: "min a day", sub: span.days > 0 ? `over ${plural(span.days, "day")}` : "no sittings in 14 days" },
  ];

  // The warning: who gives way, and what plan speed would need.
  let warn: SharedTime["warn"] = null;
  const short = counted.filter((line) => line.state === "short");
  if (counted.length > 0 && you <= 0) {
    warn = { strong: "No sittings on these projects in the last 14 days.", rest: " So far there is no time to share." };
  } else if (short.length > 0) {
    const fitting = counted.filter((line) => line.state === "fits").map((line) => line.name);
    const n = counted.length;
    const strong = fitting.length === 0
      ? `At ${whole(you)} min a day there isn't time for ${n === 1 ? "it" : n === 2 ? "either" : "any of them"}.`
      : `At ${whole(you)} min a day there is time for ${listOf(fitting)}, but not ${allOf(n)}.`;
    const byId = new Map(ordered.map((entry) => [entry.input.project_id, entry.estimate]));
    const faster = counted.filter((line) => {
      const plan = byId.get(line.project_id)?.forecast.plan_cadence_minutes_per_day;
      return plan !== null && plan !== undefined && Math.round(plan) < Math.round(line.needed as number);
    });
    const alt = counted.reduce((sum, line) => {
      const plan = byId.get(line.project_id)?.forecast.plan_cadence_minutes_per_day;
      return sum + (faster.includes(line) ? (plan as number) : (line.needed as number));
    }, 0);
    const rest = faster.length > 0 && Math.round(alt) < Math.round(needed as number)
      ? ` If ${listOf(faster.map((line) => line.name))} ${faster.length === 1 ? "reaches its" : "reach their"} plan speed, ${n === 1 ? "it needs" : `${allOf(n)} need`} ${whole(alt)}.`
      : "";
    warn = { strong, rest };
  }

  const facts: SharedFact[] = [{
    key: "order", label: "Order", strong: "Soonest due first",
    small: `Its ${ordered.length > 0 && ordered.every(({ estimate }) => estimate.row_word === "round") ? "rounds" : "rows"} come first. The rest goes to the next one.${tie ? " Same due date: the smaller one first." : ""}${lines.some((line) => line.state === "past_due") ? " Past due projects get no time until they have a new due date." : ""}`,
  }];
  const notReady = ordered.filter(({ estimate }) => !estimate.forecast.finish_ready);
  if (lines.length > 0) {
    facts.push(notReady.length > 0
      ? {
        key: "finish", label: "Finish", strong: `No dates until ${MIN_DAYS_WITH_ROWS_FOR_FINISH} days of sittings`,
        small: `Each needs ${MIN_SITTINGS_WITH_ROWS_FOR_FINISH} sittings with rows, on ${MIN_DAYS_WITH_ROWS_FOR_FINISH} different days${ordered.length > 1 ? `; ${listOf(notReady.map((entry) => entry.name))} ${notReady.length === 1 ? "doesn't" : "don't"} have them yet` : ""}.`,
      }
      : { key: "finish", label: "Finish", strong: "Under This project", small: "Each project's date comes from its own sittings, before sharing." });
  }

  return {
    today, counted: counted.length, needed_minutes_per_day: needed === null ? null : round(needed, 1),
    you_minutes_per_day: you, you_days: span.days, tiles, warn, projects: lines, facts, left_out: leftOutText,
    empty: lines.length === 0 ? "No open craft project has a due date, so there is no time to share." : null,
  };
}
