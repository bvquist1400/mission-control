/**
 * Pace tracking (slice 2): the words and numbers on the Portfolio pace line and the
 * project page's Pace section, built in code from the forecast so they can be tested
 * without a browser. Pure: no database, no React.
 */

import {
  MIN_COUNTED_SESSIONS_FOR_HEALTH,
  SAMPLE_SPEED_LABEL,
  singularUnit,
  type PaceForecast,
  type PlanRatio,
  type SpeedSource,
} from "@/lib/pace";
import { etDateOf, etMinutesOf, itemRowNumber } from "@/lib/work-sessions/parse";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-19" → "Oct 19". */
export function formatMonthDay(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** "2027-09-14" → "Sep 2027". */
export function formatMonthYear(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** A finish date: "Dec 1" within the year of today, "Oct 2027" beyond it. */
export function formatFinish(date: string, today: string): string {
  return date.slice(0, 4) === today.slice(0, 4) ? formatMonthDay(date) : formatMonthYear(date);
}

/** Whole minutes: 31.1 → "31". */
function minutesText(value: number): string {
  return String(Math.round(value));
}

/** "width" → "wide": how the plan's size reads next to its number ("195 wide"). */
function sizeAdjective(label: string): string | null {
  switch (label.trim().toLowerCase()) {
    case "width":
      return "wide";
    case "height":
      return "tall";
    case "length":
      return "long";
    default:
      return null;
  }
}

// ── Chip and the Portfolio pace line ────────────────────────────────────────

export type PaceChipKind = "ok" | "behind" | "none" | "measuring";

export interface PaceChip {
  kind: PaceChipKind;
  label: string;
}

/** The health chip for a project's forecast. */
export function paceChip(forecast: Pick<PaceForecast, "health" | "counted_sessions">): PaceChip {
  switch (forecast.health) {
    case "on_track":
      return { kind: "ok", label: "On track" };
    case "behind":
      return { kind: "behind", label: "Behind" };
    case "no_target":
      return { kind: "none", label: "No target" };
    case "unknown":
      return { kind: "none", label: "No speed yet" };
    default:
      return { kind: "measuring", label: `Measuring · ${forecast.counted_sessions} of ${MIN_COUNTED_SESSIONS_FOR_HEALTH} sittings` };
  }
}

export interface PaceLine {
  chip: PaceChip;
  /** The sentence after the chip. */
  text: string;
  /** True when the page puts a "·" between the chip and the sentence (the no-target wording). */
  separator: boolean;
}

function unpricedText(forecast: PaceForecast): string | null {
  if (forecast.unpriced_units.length === 0) return null;
  const label = forecast.unit_label?.trim() || "units";
  const list = forecast.unpriced_units.map((entry) => `${entry.units_left} ${entry.work_type} ${label}`);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
  return `${joined} ${list.length === 1 && forecast.unpriced_units[0].units_left === 1 ? "has" : "have"} no speed yet`;
}

/**
 * The strip under a Portfolio lane's status line, e.g. "Swatch speeds are 3.1× the plan ·
 * 195 wide needs 229 min a day from Oct 19 · at 90 min a day, 63 stitches wide fits".
 * Once the width is locked the width parts become "you're at 31 min a day"; with no target
 * it reads "projected Dec 2026 at 31 min a day" after a "No target" chip.
 */
export function buildPaceLine(forecast: PaceForecast): PaceLine {
  const chip = paceChip(forecast);
  if (forecast.health === "no_target") {
    const text = forecast.projected_finish && forecast.cadence_minutes_per_day > 0
      ? `projected ${formatMonthYear(forecast.projected_finish)} at ${minutesText(forecast.cadence_minutes_per_day)} min a day`
      : "log a sitting to get a projection";
    return { chip, text, separator: true };
  }
  const parts: string[] = [];
  if (forecast.plan_ratio) {
    parts.push(`${forecast.plan_ratio.sample_based ? "Swatch" : "Body"} speeds are ${forecast.plan_ratio.ratio.toFixed(1)}× the plan`);
  }
  const fit = forecast.size_fit;
  const from = forecast.available_from ? ` from ${formatMonthDay(forecast.available_from)}` : "";
  if (forecast.size_fit_reason === "locked") {
    parts.push(`you're at ${minutesText(forecast.cadence_minutes_per_day)} min a day`);
  } else if (fit) {
    const adjective = sizeAdjective(fit.label);
    const size = adjective ? `${fit.current} ${adjective}` : `${fit.current} ${fit.unit}`;
    parts.push(`${size} needs ${minutesText(fit.needed_minutes_per_day_at_current)} min a day${from}`);
    const at90 = fit.fits.find((entry) => entry.source === "fixed" && entry.minutes_per_day === 90);
    if (at90) {
      parts.push(
        at90.widest === null
          ? `at 90 min a day, not even ${fit.widths[0]?.size ?? "the minimum"} ${fit.unit} ${adjective ?? "wide"} fits`
          : `at 90 min a day, ${at90.widest} ${fit.unit} ${adjective ?? "wide"} fits`
      );
    }
  } else if (forecast.needed_minutes_per_day !== null) {
    parts.push(`needs ${minutesText(forecast.needed_minutes_per_day)} min a day${from}`);
  } else {
    const unpriced = unpricedText(forecast);
    if (unpriced) parts.push(unpriced);
  }
  return { chip, text: parts.join(" · "), separator: false };
}

// ── Source labels ───────────────────────────────────────────────────────────

export type SourceTone = "body" | "swatch" | "other" | "plan" | "none";

export interface SourceLabel {
  text: string;
  tone: SourceTone;
  /** The tooltip / the line under the table. */
  title: string;
}

function sittings(n: number): string {
  return `${n} ${n === 1 ? "sitting" : "sittings"}`;
}

/** The short "Source" cell of the speed table ("Body · 4 sittings", "Plan × 3.1") with what it means. */
export function sourceLabel(
  row: { source: SpeedSource; n_sessions: number },
  planRatio: Pick<PlanRatio, "ratio"> | null
): SourceLabel {
  switch (row.source) {
    case "measured":
      return {
        text: `Body · ${sittings(row.n_sessions)}`,
        tone: "body",
        title: "Body: measured on this project's own work, total minutes ÷ total units over the last 8 counted sittings.",
      };
    case "measured_sample":
      return {
        text: `Swatch · ${sittings(row.n_sessions)}`,
        tone: "swatch",
        title: `Swatch: ${SAMPLE_SPEED_LABEL}. Body sittings replace it as soon as there are any.`,
      };
    case "other_projects":
      return {
        text: `Other projects · ${sittings(row.n_sessions)}`,
        tone: "other",
        title: "Other projects: measured on your other projects with the same unit and work type. This is how a new project gets its first estimate.",
      };
    case "plan_x_ratio": {
      const ratio = planRatio ? planRatio.ratio.toFixed(1) : "your ratio";
      return {
        text: `Plan × ${ratio}`,
        tone: "plan",
        title: `Plan × ${ratio}: nothing measured for this type yet, so the plan time is multiplied by your measured ratio to the plan.`,
      };
    }
    case "plan":
      return {
        text: "Plan",
        tone: "plan",
        title: "Plan: the plan time alone. Nothing is measured and there is no ratio to apply yet.",
      };
    default:
      return {
        text: "No speed yet",
        tone: "none",
        title: "No speed yet: no sittings, no other project with this unit, and no estimate on the task to take a plan time from.",
      };
  }
}

// ── Tiles ───────────────────────────────────────────────────────────────────

export interface PaceTile {
  key: "work_left" | "pace" | "needed" | "speed_vs_plan" | "finish";
  label: string;
  value: string;
  sub: string;
  tone: "" | "warn";
}

/** The four stat tiles. With no target the Needed tile becomes "Speed vs plan". */
export function buildTiles(forecast: PaceForecast): PaceTile[] {
  const fit = forecast.size_fit;
  const adjective = fit ? sizeAdjective(fit.label) : null;
  const atWidth = fit ? `at ${fit.current} ${adjective ?? fit.unit}` : "at current counts";
  const cadence = forecast.cadence_minutes_per_day;
  const hours = forecast.work_left_hours;
  const workLeft: PaceTile = {
    key: "work_left",
    label: "Work left",
    value: hours === null ? "—" : `≈ ${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} h`,
    sub: hours === null ? "some work has no speed yet" : atWidth,
    tone: "",
  };
  const pace: PaceTile = {
    key: "pace",
    label: "Your pace",
    value: `${minutesText(cadence)} min/day`,
    sub: forecast.excluded_sessions > 0 ? "14-day average, learning included" : "14-day average",
    tone: "",
  };
  let third: PaceTile;
  if (!forecast.target_date) {
    third = {
      key: "speed_vs_plan",
      label: "Speed vs plan",
      value: forecast.plan_ratio ? `${forecast.plan_ratio.ratio.toFixed(1)}×` : "—",
      sub: "measured ÷ plan, no target date",
      tone: "",
    };
  } else {
    const needed = forecast.needed_minutes_per_day;
    third = {
      key: "needed",
      label: "Needed",
      value: needed === null ? "—" : `${minutesText(needed)} min/day`,
      sub:
        needed === null
          ? forecast.unpriced_units.length > 0 ? "some work has no speed yet" : "no days left before the target"
          : `${forecast.available_from ? formatMonthDay(forecast.available_from) : "today"} – ${formatMonthDay(forecast.target_date)}${fit ? `, ${atWidth}` : ""}`,
      tone: needed !== null && needed > cadence ? "warn" : "",
    };
  }
  const finish = forecast.projected_finish;
  const finishTile: PaceTile = {
    key: "finish",
    label: "Projected finish",
    value: finish ? formatFinish(finish, forecast.today) : "—",
    sub: finish
      ? `at ${minutesText(cadence)} min/day${fit ? `, ${fit.current} ${adjective ?? fit.unit}` : ""}`
      : forecast.unpriced_units.length > 0 ? "some work has no speed yet" : "log a sitting to get a projection",
    tone: finish && forecast.target_date && finish > forecast.target_date ? "warn" : "",
  };
  return [workLeft, pace, third, finishTile];
}

/** "5 sittings logged (3 counted) · 436 min in the last 14 days · speeds from the swatch". */
export function buildSourceLine(forecast: PaceForecast, sessionTotal: number): string {
  if (sessionTotal <= 0) return "No sittings logged yet";
  const sources = new Set(forecast.work_types.map((row) => row.source));
  const body = sources.has("measured");
  const swatch = sources.has("measured_sample");
  let speeds: string;
  if (body && swatch) speeds = "speeds from your body rows and the swatch";
  else if (body) speeds = "speeds from your body rows";
  else if (swatch) speeds = "speeds from the swatch";
  else if (sources.has("other_projects")) speeds = "speeds from your other projects";
  else speeds = "no speeds measured yet (plan times)";
  return [
    `${sessionTotal} ${sessionTotal === 1 ? "sitting" : "sittings"} logged (${forecast.counted_sessions} counted)`,
    `${forecast.minutes_in_cadence_window} min in the last 14 days`,
    speeds,
  ].join(" · ");
}

// ── Speed table ─────────────────────────────────────────────────────────────

const WORK_TYPE_COLORS: Record<string, string> = {
  chain: "#6e7681",
  sc: "#e9e2cf",
  "plain-dc": "#b8b09a",
  waffle: "#d6c7a1",
  "colorwork-dc": "#8a9a3b",
};
const FALLBACK_COLORS = ["#7aa2c9", "#c98a7a", "#9a7ac9", "#7ac9a4", "#c9b87a", "#c97aa6"];

/** A stable colour for a work-type swatch. */
export function workTypeColor(workType: string): string {
  if (WORK_TYPE_COLORS[workType]) return WORK_TYPE_COLORS[workType];
  let hash = 0;
  for (const char of workType) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export interface SpeedRow {
  /** Null for the "no units" row (tasks priced by their estimate). */
  work_type: string | null;
  label: string;
  note: string | null;
  color: string | null;
  units_total: number | null;
  units_done: number | null;
  units_left: number | null;
  /** "27.1 s", or "—". */
  speed: string;
  source: SourceLabel;
  /** "80.2", or "—". */
  hours_left: string;
}

/** Seven columns per work type, plus a "no units" row when open tasks are priced by estimate. */
export function buildSpeedRows(forecast: PaceForecast, options: { unitlessNote?: string | null } = {}): SpeedRow[] {
  const rows: SpeedRow[] = forecast.work_types.map((row) => ({
    work_type: row.work_type,
    label: row.work_type,
    note: null,
    color: workTypeColor(row.work_type),
    units_total: row.units_total,
    units_done: row.units_done,
    units_left: row.units_left,
    speed: row.seconds_per_unit === null ? "—" : `${row.seconds_per_unit.toFixed(1)} s`,
    source: sourceLabel(row, forecast.plan_ratio),
    hours_left: row.hours_left === null ? "—" : row.hours_left.toFixed(1),
  }));
  if (forecast.unitless_minutes_left > 0) {
    rows.push({
      work_type: null,
      label: "no units",
      note: options.unitlessNote ?? null,
      color: null,
      units_total: null,
      units_done: null,
      units_left: null,
      speed: "—",
      source: sourceLabel({ source: "plan", n_sessions: 0 }, forecast.plan_ratio),
      hours_left: (forecast.unitless_minutes_left / 60).toFixed(1),
    });
  }
  return rows;
}

// ── Width that fits ─────────────────────────────────────────────────────────

export interface FitRow {
  label: string;
  minutes_per_day: number;
  /** Null when not even the minimum width fits. */
  width: number | null;
  none: boolean;
  length: number | null;
  lengthUnit: string | null;
  /** "under the 27-stitch minimum", "the plan". */
  note: string;
}

export interface FitView {
  title: string;
  window: string;
  rows: FitRow[];
  hasGauge: boolean;
  /** Shown instead of inches when no gauge is set. */
  gaugeNote: string | null;
  /** When it shows and why the widths read low. */
  note: string;
}

export const GAUGE_NOTE = "Add your gauge after measuring the swatch (step 5) to see inches";

/**
 * Your 14-day pace, 60, 90 and 120 min a day, and the full width with its needed min a day.
 * Null when the forecast has no `size_fit` (no target, width locked, no size setting).
 */
export function buildFitView(forecast: PaceForecast): FitView | null {
  const fit = forecast.size_fit;
  if (!fit) return null;
  const unit = singularUnit(fit.unit);
  const hasGauge = fit.length_unit !== null;
  const minimum = fit.widths[0]?.size;
  const rows: FitRow[] = [];
  fit.fits.forEach((entry) => {
    rows.push({
      label: entry.source === "measured" ? "Your 14-day pace" : "",
      minutes_per_day: entry.minutes_per_day,
      width: entry.widest,
      none: entry.widest === null,
      length: entry.widest_length,
      lengthUnit: entry.widest_length === null ? null : fit.length_unit,
      note: entry.widest === null ? `under the ${minimum ?? "minimum"}-${unit} minimum` : "",
    });
  });
  rows.push({
    label: "Full width",
    minutes_per_day: fit.needed_minutes_per_day_at_current,
    width: fit.current,
    none: false,
    length: fit.current_length,
    lengthUnit: fit.length_unit,
    note: "the plan",
  });
  const from = forecast.available_from ? formatMonthDay(forecast.available_from) : null;
  const to = forecast.target_date ? formatMonthDay(forecast.target_date) : null;
  return {
    title: `Width that fits by ${to ?? "the target"}`,
    window: from && to ? `${from} – ${to}${forecast.available_days ? `, ${forecast.available_days} days` : ""}` : "",
    rows,
    hasGauge,
    gaugeNote: hasGauge ? null : GAUGE_NOTE,
    note: [
      "Shown until the first body row is ticked, then off for good, because the width is locked then.",
      forecast.work_types.some((row) => row.source === "measured_sample")
        ? "Speeds come from the swatch, where narrower rows make each stitch look slower, so body rows will likely be faster and these widths are on the low side."
        : null,
      fit.perimeter_minutes_left > 0 ? "The border scales with the perimeter (2 × (width + side)), not just the width." : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// ── Sittings ────────────────────────────────────────────────────────────────

export interface PaceTaskLite {
  id: string;
  title: string;
  status: string;
  section_id: string | null;
  work_type: string | null;
  unit_count: number | null;
}

export interface PaceItemLite {
  id: string;
  task_id: string;
  text: string;
  is_done: boolean;
  unit_count: number | null;
  work_type: string | null;
}

export interface PaceSessionLite {
  id: string;
  task_id: string | null;
  session_date: string;
  started_at: string | null;
  ended_at: string | null;
  created_at?: string | null;
  minutes: number;
  note: string | null;
  exclude_from_stats: boolean;
  exclude_reason: string | null;
  item_ids: string[];
  extra_units: number | null;
  extra_work_type: string | null;
}

export interface SessionRow {
  id: string;
  session_date: string;
  /** "Oct 4". */
  when: string;
  task_id: string | null;
  /** The task, or "Several tasks (no single task)". */
  what: string;
  /** "rows 11–15", "row 10", or "". */
  rows: string;
  minutes: number;
  /** "135 colorwork-dc · 27.1 s/stitch · 1:38–2:39 PM", or "Not counted: ..." for an excluded one. */
  detail: string;
  note: string | null;
  excluded: boolean;
  excluded_reason: string | null;
}

const REASON_TEXT: Record<string, string> = {
  learning: "learning, not counted toward speed",
  "reading-instructions": "included reading the instructions",
  interrupted: "interrupted",
  frogged: "frogged (ripped out)",
  unclean: "not a clean sitting",
};

/** [11, 12, 13, 15] → "rows 11–13, 15"; [10] → "row 10". */
export function formatRowNumbers(rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  const flush = () => parts.push(start === prev ? String(start) : `${start}–${prev}`);
  for (const row of sorted.slice(1)) {
    if (row === prev + 1) {
      prev = row;
      continue;
    }
    flush();
    start = row;
    prev = row;
  }
  flush();
  return `${sorted.length === 1 ? "row" : "rows"} ${parts.join(", ")}`;
}

function clockText(iso: string): string {
  const minutes = etMinutesOf(iso);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")}`;
}

function meridiem(iso: string): string {
  return etMinutesOf(iso) >= 12 * 60 ? "PM" : "AM";
}

/** "1:38–2:39 PM" (the meridiem once when both are the same). */
export function formatTimeRange(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const sameDay = etDateOf(startedAt) === etDateOf(endedAt);
  if (sameDay && meridiem(startedAt) === meridiem(endedAt)) return `${clockText(startedAt)}–${clockText(endedAt)} ${meridiem(endedAt)}`;
  return `${clockText(startedAt)} ${meridiem(startedAt)}–${clockText(endedAt)} ${meridiem(endedAt)}`;
}

/**
 * Sittings newest first, each with its task and rows, minutes, s/unit when it was one work type, and
 * the reason when it is left out of speed.
 */
export function buildSessionRows(
  sessions: PaceSessionLite[],
  tasks: PaceTaskLite[],
  items: PaceItemLite[],
  unitLabel: string | null
): SessionRow[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const unit = singularUnit(unitLabel);
  const ordered = [...sessions].sort((a, b) => {
    if (a.session_date !== b.session_date) return a.session_date < b.session_date ? 1 : -1;
    const aKey = a.ended_at ?? a.started_at ?? a.created_at ?? "";
    const bKey = b.ended_at ?? b.started_at ?? b.created_at ?? "";
    if (aKey !== bKey) return aKey < bKey ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return ordered.map((session) => {
    const task = session.task_id ? taskById.get(session.task_id) ?? null : null;
    const rowNumbers: number[] = [];
    const byType = new Map<string, number>();
    const addUnits = (type: string | null, units: number | null) => {
      if (!units || units <= 0) return;
      const key = type ?? "units";
      byType.set(key, (byType.get(key) ?? 0) + units);
    };
    for (const itemId of new Set(session.item_ids)) {
      const item = itemById.get(itemId);
      if (!item) continue;
      const row = itemRowNumber(item.text);
      if (row !== null) rowNumbers.push(row);
      addUnits(item.work_type ?? taskById.get(item.task_id)?.work_type ?? null, item.unit_count);
    }
    addUnits(session.extra_work_type ?? task?.work_type ?? null, session.extra_units);
    const rows = formatRowNumbers(rowNumbers);
    const detailParts: string[] = [];
    if (session.exclude_from_stats) {
      const reason = session.exclude_reason ? REASON_TEXT[session.exclude_reason] ?? session.exclude_reason : "left out of speed";
      detailParts.push(`Not counted: ${reason}`);
    } else if (byType.size === 1) {
      const [[type, units]] = [...byType];
      const speed = Math.round(((session.minutes * 60) / units) * 10) / 10;
      detailParts.push(`${units} ${type === "units" ? unit : type}`, `${speed.toFixed(1)} s/${unit}`);
    } else if (byType.size > 1) {
      detailParts.push(`${[...byType.values()].reduce((sum, value) => sum + value, 0)} ${unit}s, ${byType.size} work types`);
    }
    const range = formatTimeRange(session.started_at, session.ended_at);
    if (range) detailParts.push(range);
    return {
      id: session.id,
      session_date: session.session_date,
      when: formatMonthDay(session.session_date),
      task_id: session.task_id,
      what: task?.title ?? "Several tasks (no single task)",
      rows,
      minutes: session.minutes,
      detail: detailParts.join(" · "),
      note: session.note,
      excluded: session.exclude_from_stats,
      excluded_reason: session.exclude_reason,
    };
  });
}

/** The task a new sitting defaults to: the one holding the lowest-numbered undone row. */
export function defaultSittingTask(tasks: PaceTaskLite[], items: PaceItemLite[]): string | null {
  const open = new Set(tasks.filter((task) => task.status !== "Done" && task.status !== "Parked" && task.status !== "Missed").map((task) => task.id));
  let best: { task_id: string; row: number } | null = null;
  for (const item of items) {
    if (item.is_done || !open.has(item.task_id)) continue;
    const row = itemRowNumber(item.text);
    if (row === null) continue;
    if (!best || row < best.row) best = { task_id: item.task_id, row };
  }
  return best?.task_id ?? null;
}
