/**
 * Pace tracking (slice 1): the forecast, computed in code from stored facts.
 *
 * Pure: no database access. The service (`src/lib/work-sessions/service.ts`)
 * loads a project's sections, tasks, checklist rows and work sessions and hands
 * them here; `test:pace` pins the rules.
 *
 * Vocabulary
 * - A *unit* is whatever the project counts (`projects.unit_label`, e.g. stitches).
 *   Units live on checklist rows (`unit_count` + `work_type`, the row's type
 *   overriding the task's) or, for a task with no unit-bearing rows, on the task.
 * - *Scope*: units on a sample task (`tasks.is_sample`: a swatch, test piece,
 *   prototype) are "sample"; everything else is "main". Sample speeds are always
 *   returned labelled as such.
 * - A *counted* session has `exclude_from_stats = false`. Only counted sessions
 *   make speeds; every session (counted or not) is real time for cadence.
 */

export const UNTYPED_WORK_TYPE = "untyped";
export const WORK_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CADENCE_WINDOW_DAYS = 14;
export const MEASURED_WINDOW_SESSIONS = 8;
export const MIN_COUNTED_SESSIONS_FOR_HEALTH = 3;
export const SIZE_FIT_FIXED_CADENCES = [60, 90, 120] as const;
export const SAMPLE_SPEED_LABEL =
  "from the swatch/sample — rows are narrower, so per-row overhead makes this slower than the main work";
/** Tasks whose remaining units are not work left: finished, missed or set aside. */
const INACTIVE_TASK_STATUSES = new Set(["Missed", "Parked"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaceScope = "main" | "sample";
export type SpeedSource = "measured" | "measured_sample" | "other_projects" | "plan_x_ratio" | "plan" | "none";
/** `unknown`: enough sessions, but some unfinished units have no speed, so the finish can't be known. */
export type PaceHealth = "insufficient_data" | "on_track" | "behind" | "no_target" | "unknown";

// ── Settings ────────────────────────────────────────────────────────────────

export interface PaceSizeSettings {
  /** What the size is called, e.g. "width". */
  label: string;
  /** The planned size, e.g. 195. */
  current: number;
  /** Sizes are offset + step × k: 27, 39, 51 … 195 for step 12, offset 3. */
  step: number;
  offset: number;
  /** The smallest size worth considering. */
  min: number;
  /** The size's unit, e.g. "stitches". */
  unit: string;
  /** Work types whose units scale with the size. */
  work_types: string[];
  /**
   * Units on these tasks (and their rows) scale with the perimeter instead of linearly:
   * (w + side) ÷ (current + side). `side` is the side edge in size units, e.g. a blanket's
   * border runs 2 × (width + side). Such units are left out of the linear scaling even when
   * their work type is in `work_types`.
   */
  perimeter?: PacePerimeterSettings;
  /** Stitches per length, e.g. 18 stitches per 4 in; with it set, each width also returns its length. */
  gauge?: PaceGaugeSettings;
}

export interface PacePerimeterSettings {
  task_ids: string[];
  side: number;
}

export type GaugeLengthUnit = "in" | "cm";
export const GAUGE_LENGTH_UNITS: readonly GaugeLengthUnit[] = ["in", "cm"];

export interface PaceGaugeSettings {
  units: number;
  length: number;
  length_unit: GaugeLengthUnit;
}

export interface PaceSettings {
  size: PaceSizeSettings | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parsePerimeter(value: unknown): ParseResult<PacePerimeterSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "pace_settings.size.perimeter must be an object { task_ids, side }" };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "task_ids" && key !== "side");
  if (extra.length > 0) return { ok: false, error: `pace_settings.size.perimeter has unknown keys: ${extra.join(", ")}` };
  if (
    !Array.isArray(record.task_ids)
    || record.task_ids.length === 0
    || record.task_ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) {
    return { ok: false, error: "pace_settings.size.perimeter.task_ids must be a non-empty list of task uuids" };
  }
  if (!isPositiveNumber(record.side)) {
    return { ok: false, error: "pace_settings.size.perimeter.side must be a positive number (the side edge, in size units)" };
  }
  return { ok: true, value: { task_ids: [...new Set((record.task_ids as string[]).map((id) => id.toLowerCase()))], side: record.side } };
}

function parseGauge(value: unknown): ParseResult<PaceGaugeSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "pace_settings.size.gauge must be an object { units, length, length_unit }" };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !["units", "length", "length_unit"].includes(key));
  if (extra.length > 0) return { ok: false, error: `pace_settings.size.gauge has unknown keys: ${extra.join(", ")}` };
  if (!isPositiveNumber(record.units)) {
    return { ok: false, error: "pace_settings.size.gauge.units must be a positive number (e.g. 18 stitches)" };
  }
  if (!isPositiveNumber(record.length)) {
    return { ok: false, error: "pace_settings.size.gauge.length must be a positive number (e.g. 4 in)" };
  }
  if (!GAUGE_LENGTH_UNITS.includes(record.length_unit as GaugeLengthUnit)) {
    return { ok: false, error: `pace_settings.size.gauge.length_unit must be one of ${GAUGE_LENGTH_UNITS.join(", ")}` };
  }
  return { ok: true, value: { units: record.units, length: record.length, length_unit: record.length_unit as GaugeLengthUnit } };
}

/** Validates `projects.pace_settings` (null clears it). Unknown keys are rejected so a typo can't pass silently. */
export function parsePaceSettings(value: unknown): ParseResult<PaceSettings | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "pace_settings must be an object or null" };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "size");
  if (unknownKeys.length > 0) {
    return { ok: false, error: `pace_settings has unknown keys: ${unknownKeys.join(", ")} (allowed: size)` };
  }
  if (record.size === undefined || record.size === null) return { ok: true, value: { size: null } };
  const size = record.size;
  if (typeof size !== "object" || Array.isArray(size)) {
    return { ok: false, error: "pace_settings.size must be an object" };
  }
  const s = size as Record<string, unknown>;
  const allowed = ["label", "current", "step", "offset", "min", "unit", "work_types", "perimeter", "gauge"];
  const extra = Object.keys(s).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return { ok: false, error: `pace_settings.size has unknown keys: ${extra.join(", ")}` };
  if (typeof s.label !== "string" || !s.label.trim() || s.label.length > 40) {
    return { ok: false, error: "pace_settings.size.label must be a short name, e.g. \"width\"" };
  }
  if (typeof s.unit !== "string" || !s.unit.trim() || s.unit.length > 40) {
    return { ok: false, error: "pace_settings.size.unit must be a short name, e.g. \"stitches\"" };
  }
  if (!isPositiveInteger(s.current)) return { ok: false, error: "pace_settings.size.current must be a positive integer" };
  if (!isPositiveInteger(s.step)) return { ok: false, error: "pace_settings.size.step must be a positive integer" };
  if (typeof s.offset !== "number" || !Number.isInteger(s.offset) || s.offset < 0) {
    return { ok: false, error: "pace_settings.size.offset must be a whole number ≥ 0" };
  }
  if (!isPositiveInteger(s.min) || s.min > s.current) {
    return { ok: false, error: "pace_settings.size.min must be a positive integer no larger than current" };
  }
  for (const [name, n] of [["current", s.current], ["min", s.min]] as const) {
    if ((n - s.offset) % s.step !== 0) {
      return { ok: false, error: `pace_settings.size.${name} (${n}) must be offset + step × k (${s.offset} + ${s.step} × k)` };
    }
  }
  if (
    !Array.isArray(s.work_types)
    || s.work_types.length === 0
    || s.work_types.some((type) => typeof type !== "string" || !WORK_TYPE_PATTERN.test(type))
  ) {
    return { ok: false, error: "pace_settings.size.work_types must be a non-empty list of work type slugs" };
  }
  let perimeter: PacePerimeterSettings | undefined;
  if (s.perimeter !== undefined && s.perimeter !== null) {
    const parsed = parsePerimeter(s.perimeter);
    if (!parsed.ok) return parsed;
    perimeter = parsed.value;
  }
  let gauge: PaceGaugeSettings | undefined;
  if (s.gauge !== undefined && s.gauge !== null) {
    const parsed = parseGauge(s.gauge);
    if (!parsed.ok) return parsed;
    gauge = parsed.value;
  }
  return {
    ok: true,
    value: {
      size: {
        label: s.label.trim(),
        current: s.current,
        step: s.step,
        offset: s.offset,
        min: s.min,
        unit: s.unit.trim(),
        work_types: [...new Set(s.work_types as string[])],
        ...(perimeter ? { perimeter } : {}),
        ...(gauge ? { gauge } : {}),
      },
    },
  };
}

/** Lowercase slug check for work types (mirrors the SQL CHECK). */
export function normalizeWorkType(value: unknown): ParseResult<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "work_type must be a string or null" };
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: null };
  if (!WORK_TYPE_PATTERN.test(trimmed)) {
    return { ok: false, error: `work_type "${value}" must be a lowercase slug (letters, digits, dashes; up to 40)` };
  }
  return { ok: true, value: trimmed };
}

export function normalizeUnitCount(value: unknown, field = "unit_count"): ParseResult<number | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a number ≥ 0 or null` };
  }
  return { ok: true, value };
}

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface PaceProjectInput {
  unit_label: string | null;
  target_date: string | null;
  pace_settings: unknown;
}

export interface PaceSectionInput {
  id: string;
  planned_start: string | null;
  /** Needed for the lane projection's health (projected end vs planned end). */
  planned_end?: string | null;
}

export interface PaceTaskInput {
  id: string;
  status: string;
  estimated_minutes: number | null;
  unit_count: number | null;
  work_type: string | null;
  is_sample: boolean;
  section_id: string | null;
}

export interface PaceItemInput {
  id: string;
  task_id: string;
  is_done: boolean;
  unit_count: number | null;
  work_type: string | null;
}

export interface PaceSessionInput {
  id: string;
  task_id: string | null;
  /** ET calendar day. */
  session_date: string;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  minutes: number;
  exclude_from_stats: boolean;
  /** Linked checklist rows. */
  item_ids: string[];
  extra_units: number | null;
  extra_work_type: string | null;
}

/** A measured main-scope speed from other projects with the same unit label. */
export interface CrossProjectRate {
  work_type: string;
  seconds_per_unit: number;
  n_sessions: number;
}

export interface PaceInput {
  project: PaceProjectInput;
  sections: PaceSectionInput[];
  tasks: PaceTaskInput[];
  items: PaceItemInput[];
  sessions: PaceSessionInput[];
  /** ET date, YYYY-MM-DD. */
  today: string;
  otherProjectRates?: CrossProjectRate[];
}

// ── Units ───────────────────────────────────────────────────────────────────

export interface UnitEntry {
  /** Checklist item id, or `task:<id>` for task-level units. */
  key: string;
  item_id: string | null;
  task_id: string;
  section_id: string | null;
  work_type: string;
  units: number;
  scope: PaceScope;
  /** Ticked, or its task is Done. */
  done: boolean;
  /** Its task is Missed or Parked: not done, but not work left either. */
  inactive: boolean;
}

function isInactive(task: PaceTaskInput): boolean {
  return INACTIVE_TASK_STATUSES.has(task.status);
}

/** Done, Missed or Parked: no work left on it. */
function isClosed(task: PaceTaskInput): boolean {
  return task.status === "Done" || isInactive(task);
}

function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Every unit-bearing thing in the project: checklist rows with units (type =
 * row type ?? task type), or the task itself when none of its rows carry units.
 * Rows of a Done task count as done; units of a Missed or Parked task are
 * `inactive` (not work left, but not done either).
 */
export function buildUnitEntries(tasks: PaceTaskInput[], items: PaceItemInput[]): UnitEntry[] {
  const itemsByTask = new Map<string, PaceItemInput[]>();
  for (const item of items) {
    const list = itemsByTask.get(item.task_id) ?? [];
    list.push(item);
    itemsByTask.set(item.task_id, list);
  }
  const entries: UnitEntry[] = [];
  for (const task of tasks) {
    const scope: PaceScope = task.is_sample ? "sample" : "main";
    const finished = task.status === "Done";
    const inactive = isInactive(task);
    const unitItems = (itemsByTask.get(task.id) ?? []).filter((item) => positive(item.unit_count) > 0);
    if (unitItems.length > 0) {
      for (const item of unitItems) {
        entries.push({
          key: item.id,
          item_id: item.id,
          task_id: task.id,
          section_id: task.section_id,
          work_type: item.work_type ?? task.work_type ?? UNTYPED_WORK_TYPE,
          units: positive(item.unit_count),
          scope,
          done: finished || item.is_done,
          inactive,
        });
      }
    } else if (positive(task.unit_count) > 0) {
      entries.push({
        key: `task:${task.id}`,
        item_id: null,
        task_id: task.id,
        section_id: task.section_id,
        work_type: task.work_type ?? UNTYPED_WORK_TYPE,
        units: positive(task.unit_count),
        scope,
        done: finished,
        inactive,
      });
    }
  }
  return entries;
}

// ── Plan speeds ─────────────────────────────────────────────────────────────

/**
 * Seconds per unit implied by the plan, per work type: from non-sample tasks
 * with an estimate and units, task_rate = estimate ÷ its units, and a type's
 * plan speed is the unit-weighted mean of the rates of the tasks it appears in.
 */
export function computePlanSpeeds(tasks: PaceTaskInput[], entries: UnitEntry[]): Map<string, number> {
  const entriesByTask = new Map<string, UnitEntry[]>();
  for (const entry of entries) {
    const list = entriesByTask.get(entry.task_id) ?? [];
    list.push(entry);
    entriesByTask.set(entry.task_id, list);
  }
  const weighted = new Map<string, { secondsTimesUnits: number; units: number }>();
  for (const task of tasks) {
    if (task.is_sample) continue;
    const estimate = positive(task.estimated_minutes);
    const taskEntries = entriesByTask.get(task.id) ?? [];
    const totalUnits = taskEntries.reduce((sum, entry) => sum + entry.units, 0);
    if (estimate <= 0 || totalUnits <= 0) continue;
    const rate = (estimate * 60) / totalUnits;
    for (const entry of taskEntries) {
      const acc = weighted.get(entry.work_type) ?? { secondsTimesUnits: 0, units: 0 };
      acc.secondsTimesUnits += rate * entry.units;
      acc.units += entry.units;
      weighted.set(entry.work_type, acc);
    }
  }
  const speeds = new Map<string, number>();
  for (const [type, acc] of weighted) {
    if (acc.units > 0) speeds.set(type, acc.secondsTimesUnits / acc.units);
  }
  return speeds;
}

// ── Session allocation ──────────────────────────────────────────────────────

export interface SessionAllocation {
  session_id: string;
  session_date: string;
  /** Sort key within a day (end, else start, else created). */
  time_key: string;
  work_type: string;
  scope: PaceScope;
  units: number;
  minutes: number;
  counted: boolean;
}

/**
 * Splits each session's minutes across the (type, scope) of the units it
 * covered (linked rows + extra units), in proportion to units × plan speed, or
 * to units alone when any of its types has no plan speed. Sessions with no
 * units allocate nothing (they still count toward cadence).
 */
export function allocateSessions(
  sessions: PaceSessionInput[],
  tasks: PaceTaskInput[],
  entries: UnitEntry[],
  planSpeeds: Map<string, number>
): SessionAllocation[] {
  const entryByItem = new Map<string, UnitEntry>();
  for (const entry of entries) if (entry.item_id) entryByItem.set(entry.item_id, entry);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const allocations: SessionAllocation[] = [];

  for (const session of sessions) {
    const parts = new Map<string, { work_type: string; scope: PaceScope; units: number }>();
    const add = (workType: string, scope: PaceScope, units: number) => {
      if (units <= 0) return;
      const key = `${workType}\u0000${scope}`;
      const part = parts.get(key) ?? { work_type: workType, scope, units: 0 };
      part.units += units;
      parts.set(key, part);
    };
    for (const itemId of new Set(session.item_ids)) {
      const entry = entryByItem.get(itemId);
      if (entry) add(entry.work_type, entry.scope, entry.units);
    }
    const extra = positive(session.extra_units);
    if (extra > 0) {
      const task = session.task_id ? taskById.get(session.task_id) : undefined;
      add(
        session.extra_work_type ?? task?.work_type ?? UNTYPED_WORK_TYPE,
        task?.is_sample ? "sample" : "main",
        extra
      );
    }
    if (parts.size === 0) continue;

    const list = [...parts.values()];
    const allPlanned = list.every((part) => planSpeeds.has(part.work_type));
    const weights = list.map((part) => part.units * (allPlanned ? planSpeeds.get(part.work_type)! : 1));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const timeKey = session.ended_at ?? session.started_at ?? session.created_at ?? "";
    list.forEach((part, index) => {
      allocations.push({
        session_id: session.id,
        session_date: session.session_date,
        time_key: timeKey,
        work_type: part.work_type,
        scope: part.scope,
        units: part.units,
        minutes: totalWeight > 0 ? (session.minutes * weights[index]) / totalWeight : 0,
        counted: !session.exclude_from_stats,
      });
    });
  }
  return allocations;
}

// ── Measured speeds ─────────────────────────────────────────────────────────

export interface MeasuredSpeed {
  work_type: string;
  scope: PaceScope;
  seconds_per_unit: number;
  n_sessions: number;
  units: number;
  minutes: number;
  label: string | null;
}

function newestFirst(a: SessionAllocation, b: SessionAllocation): number {
  if (a.session_date !== b.session_date) return a.session_date < b.session_date ? 1 : -1;
  if (a.time_key !== b.time_key) return a.time_key < b.time_key ? 1 : -1;
  return a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0;
}

/**
 * Seconds per unit per (type, scope) from counted sessions only: a ratio of
 * sums over the most recent `MEASURED_WINDOW_SESSIONS` sessions that
 * contributed to that (type, scope).
 */
export function computeMeasuredSpeeds(allocations: SessionAllocation[]): MeasuredSpeed[] {
  const byKey = new Map<string, SessionAllocation[]>();
  for (const allocation of allocations) {
    if (!allocation.counted || allocation.units <= 0) continue;
    const key = `${allocation.work_type}\u0000${allocation.scope}`;
    const list = byKey.get(key) ?? [];
    list.push(allocation);
    byKey.set(key, list);
  }
  const speeds: MeasuredSpeed[] = [];
  for (const list of byKey.values()) {
    const recent = [...list].sort(newestFirst).slice(0, MEASURED_WINDOW_SESSIONS);
    const units = recent.reduce((sum, allocation) => sum + allocation.units, 0);
    const minutes = recent.reduce((sum, allocation) => sum + allocation.minutes, 0);
    if (units <= 0) continue;
    const { work_type, scope } = recent[0];
    speeds.push({
      work_type,
      scope,
      seconds_per_unit: (minutes * 60) / units,
      n_sessions: new Set(recent.map((allocation) => allocation.session_id)).size,
      units,
      minutes,
      label: scope === "sample" ? SAMPLE_SPEED_LABEL : null,
    });
  }
  return speeds.sort((a, b) => a.work_type.localeCompare(b.work_type) || a.scope.localeCompare(b.scope));
}

// ── Plan ratio ──────────────────────────────────────────────────────────────

export interface PlanRatio {
  /** Measured minutes ÷ plan minutes for the same units (1 = on plan, 3.5 = 3.5× slower). */
  ratio: number;
  /** Which units the ratio comes from. */
  basis: "main" | "sample" | "mixed";
  sample_based: boolean;
  n_sessions: number;
  label: string | null;
}

export function computePlanRatio(allocations: SessionAllocation[], planSpeeds: Map<string, number>): PlanRatio | null {
  let measured = 0;
  let planned = 0;
  let mainUnits = 0;
  let sampleUnits = 0;
  const sessions = new Set<string>();
  for (const allocation of allocations) {
    if (!allocation.counted || allocation.units <= 0) continue;
    const plan = planSpeeds.get(allocation.work_type);
    if (plan === undefined) continue;
    measured += allocation.minutes;
    planned += (allocation.units * plan) / 60;
    if (allocation.scope === "sample") sampleUnits += allocation.units;
    else mainUnits += allocation.units;
    sessions.add(allocation.session_id);
  }
  if (planned <= 0) return null;
  const basis = sampleUnits > 0 && mainUnits > 0 ? "mixed" : sampleUnits > 0 ? "sample" : "main";
  return {
    ratio: measured / planned,
    basis,
    sample_based: sampleUnits > 0,
    n_sessions: sessions.size,
    label: sampleUnits > 0 ? `partly or wholly ${SAMPLE_SPEED_LABEL}` : null,
  };
}

// ── Speed resolution ────────────────────────────────────────────────────────

export interface ResolvedSpeed {
  work_type: string;
  seconds_per_unit: number | null;
  source: SpeedSource;
  n_sessions: number;
  label: string | null;
}

export function resolveSpeed(
  workType: string,
  measured: MeasuredSpeed[],
  otherProjects: CrossProjectRate[],
  planSpeeds: Map<string, number>,
  planRatio: PlanRatio | null
): ResolvedSpeed {
  const main = measured.find((speed) => speed.work_type === workType && speed.scope === "main");
  if (main) {
    return { work_type: workType, seconds_per_unit: main.seconds_per_unit, source: "measured", n_sessions: main.n_sessions, label: null };
  }
  const sample = measured.find((speed) => speed.work_type === workType && speed.scope === "sample");
  if (sample) {
    return {
      work_type: workType,
      seconds_per_unit: sample.seconds_per_unit,
      source: "measured_sample",
      n_sessions: sample.n_sessions,
      label: SAMPLE_SPEED_LABEL,
    };
  }
  const other = otherProjects.find((rate) => rate.work_type === workType && rate.seconds_per_unit > 0);
  if (other) {
    return {
      work_type: workType,
      seconds_per_unit: other.seconds_per_unit,
      source: "other_projects",
      n_sessions: other.n_sessions,
      label: "measured on other projects with the same unit",
    };
  }
  const plan = planSpeeds.get(workType);
  if (plan !== undefined && planRatio) {
    return {
      work_type: workType,
      seconds_per_unit: plan * planRatio.ratio,
      source: "plan_x_ratio",
      n_sessions: planRatio.n_sessions,
      label: `plan speed × your measured pace vs plan (${round(planRatio.ratio, 2)}×${planRatio.sample_based ? `, ${SAMPLE_SPEED_LABEL}` : ""})`,
    };
  }
  if (plan !== undefined) {
    return { work_type: workType, seconds_per_unit: plan, source: "plan", n_sessions: 0, label: "plan speed (no sessions yet)" };
  }
  return { work_type: workType, seconds_per_unit: null, source: "none", n_sessions: 0, label: "no speed: no sessions and no plan estimate" };
}

// ── Dates ───────────────────────────────────────────────────────────────────

function dateMs(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

export function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
}

// ── Forecast ────────────────────────────────────────────────────────────────

export interface WorkLeftByType {
  work_type: string;
  units_left: number;
  main_units_left: number;
  sample_units_left: number;
  seconds_per_unit: number | null;
  source: SpeedSource;
  n_sessions: number;
  label: string | null;
  minutes_left: number | null;
  hours_left: number | null;
  plan_seconds_per_unit: number | null;
}

export interface SizeFitCadence {
  minutes_per_day: number;
  source: "measured" | "fixed";
  /** The widest size that fits by the target date at this cadence; null when not even `min` fits. */
  widest: number | null;
  /** `widest` in the gauge's length unit (1 decimal); null without a gauge or when none fits. */
  widest_length: number | null;
}

export interface SizeFitWidth {
  size: number;
  minutes_left: number;
  needed_minutes_per_day: number;
  /** Only with a gauge: size ÷ units × length (1 decimal), in `length_unit`. */
  length?: number;
  length_unit?: GaugeLengthUnit;
}

export interface SizeFit {
  label: string;
  unit: string;
  current: number;
  /** Minutes per day needed at the current size (same as needed_minutes_per_day). */
  needed_minutes_per_day_at_current: number;
  /** Minutes left that scale linearly with the size. */
  scaled_minutes_left: number;
  /** Minutes left that scale with the perimeter (the tasks in `pace_settings.size.perimeter`). */
  perimeter_minutes_left: number;
  fixed_minutes_left: number;
  fits: SizeFitCadence[];
  widths: SizeFitWidth[];
  /** The current size in the gauge's length unit; null without a gauge. */
  current_length: number | null;
  length_unit: GaugeLengthUnit | null;
}

/** One work type in the speed table: all its units (done, left), with the speed that prices what is left. */
export interface WorkTypeSummary {
  work_type: string;
  units_total: number;
  units_done: number;
  units_left: number;
  seconds_per_unit: number | null;
  source: SpeedSource;
  n_sessions: number;
  label: string | null;
  hours_left: number | null;
}

export type SectionHealthBasis = "time" | "rows";

/**
 * One planned section's projection: the running clock walks sections in planned_start order,
 * so a section starts when the work before it is done or on its planned start, whichever is later.
 */
export interface SectionProjection {
  section_id: string;
  planned_start: string | null;
  planned_end: string | null;
  /** Units still to do in the section (not done, not parked or missed). */
  units_left: number;
  /** Unit work at its speeds plus unit-less tasks' estimates; null while any unfinished type has no speed. */
  work_left_minutes: number | null;
  /** Null for a section with no unit work left, with cadence 0, or while a type is unpriced. */
  projected_end: string | null;
  /** Null unless `health_basis` is "time" (or `unknown` for unpriced units, with enough sittings). */
  health: "on_track" | "behind" | "unknown" | null;
  /** "time": the Portfolio chip follows `health`. "rows": it keeps the row-count chip. */
  health_basis: SectionHealthBasis;
}

export interface PaceForecast {
  today: string;
  unit_label: string | null;
  target_date: string | null;
  counted_sessions: number;
  excluded_sessions: number;
  plan_speeds: Array<{ work_type: string; seconds_per_unit: number }>;
  measured_speeds: MeasuredSpeed[];
  plan_ratio: PlanRatio | null;
  work_left: WorkLeftByType[];
  /** Every work type with units (finished ones too), for the speed table. */
  work_types: WorkTypeSummary[];
  /** Open tasks without units: estimate × (1 − ticked share of its checklist). */
  unitless_minutes_left: number;
  /** Types with units left but no speed at all (source none). */
  unpriced_types: string[];
  /** The same, with the units left. While non-empty, every time-based output below is null / unknown. */
  unpriced_units: Array<{ work_type: string; units_left: number }>;
  /** Null while any unfinished type is unpriced. */
  work_left_minutes: number | null;
  work_left_hours: number | null;
  /** Minutes for the units that do have a speed, plus unit-less tasks (always computed). */
  priced_work_left_minutes: number;
  /** Minutes per day over the last 14 days, including excluded sessions (it is real time). */
  cadence_minutes_per_day: number;
  sessions_in_cadence_window: number;
  /** Session minutes in the last 14 days (cadence × 14, unrounded). */
  minutes_in_cadence_window: number;
  /** Work left at plan speeds ÷ available days: the plan's own pace. */
  plan_cadence_minutes_per_day: number | null;
  available_from: string | null;
  available_days: number | null;
  needed_minutes_per_day: number | null;
  projected_finish: string | null;
  slack_days: number | null;
  health: PaceHealth;
  size_fit: SizeFit | null;
  size_fit_reason: "not_configured" | "locked" | "unpriced_units" | "no_target" | "no_days_left" | null;
  /** Lane (section) projections, in planned_start order. */
  sections: SectionProjection[];
}

export function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Whole days of work at a cadence; the epsilon keeps an exact multiple (60 min ÷ 6 a day) from rounding up on float dust. */
function daysOfWork(minutes: number, cadence: number): number {
  return Math.max(0, Math.ceil(minutes / cadence - 1e-9));
}

export function computeForecast(input: PaceInput): PaceForecast {
  const { project, tasks, items, sessions, today } = input;
  const entries = buildUnitEntries(tasks, items);
  const planSpeeds = computePlanSpeeds(tasks, entries);
  const allocations = allocateSessions(sessions, tasks, entries, planSpeeds);
  const measured = computeMeasuredSpeeds(allocations);
  const planRatio = computePlanRatio(allocations, planSpeeds);
  const otherProjects = input.otherProjectRates ?? [];

  // Units left per type and scope.
  const leftByType = new Map<string, { main: number; sample: number }>();
  for (const entry of entries) {
    if (entry.done || entry.inactive) continue;
    const acc = leftByType.get(entry.work_type) ?? { main: 0, sample: 0 };
    acc[entry.scope] += entry.units;
    leftByType.set(entry.work_type, acc);
  }

  const workLeft: WorkLeftByType[] = [];
  const secondsByType = new Map<string, number>();
  let planUnitMinutes = 0;
  const unpriced: string[] = [];
  for (const [type, acc] of [...leftByType].sort(([a], [b]) => a.localeCompare(b))) {
    const speed = resolveSpeed(type, measured, otherProjects, planSpeeds, planRatio);
    const units = acc.main + acc.sample;
    const minutes = speed.seconds_per_unit === null ? null : (units * speed.seconds_per_unit) / 60;
    if (speed.seconds_per_unit === null) unpriced.push(type);
    else secondsByType.set(type, speed.seconds_per_unit);
    const plan = planSpeeds.get(type);
    if (plan !== undefined) planUnitMinutes += (units * plan) / 60;
    workLeft.push({
      work_type: type,
      units_left: units,
      main_units_left: acc.main,
      sample_units_left: acc.sample,
      seconds_per_unit: speed.seconds_per_unit === null ? null : round(speed.seconds_per_unit, 2),
      source: speed.source,
      n_sessions: speed.n_sessions,
      label: speed.label,
      minutes_left: minutes === null ? null : round(minutes, 1),
      hours_left: minutes === null ? null : round(minutes / 60, 1),
      plan_seconds_per_unit: plan === undefined ? null : round(plan, 2),
    });
  }

  // The minutes of one unit entry that is still to do (null while its type has no speed).
  const entryMinutes = (entry: UnitEntry): number | null => {
    const seconds = secondsByType.get(entry.work_type);
    return seconds === undefined ? null : (entry.units * seconds) / 60;
  };
  const leftEntries = entries.filter((entry) => !entry.done && !entry.inactive);

  // Open tasks without units: estimate × (1 − ticked share). Also kept per section for the lane projections.
  const taskHasUnits = new Set(entries.map((entry) => entry.task_id));
  const itemsByTask = new Map<string, PaceItemInput[]>();
  for (const item of items) {
    const list = itemsByTask.get(item.task_id) ?? [];
    list.push(item);
    itemsByTask.set(item.task_id, list);
  }
  let unitlessMinutes = 0;
  const unitlessBySection = new Map<string, number>();
  for (const task of tasks) {
    if (isClosed(task) || taskHasUnits.has(task.id)) continue;
    const checklist = itemsByTask.get(task.id) ?? [];
    const tickedShare = checklist.length > 0 ? checklist.filter((item) => item.is_done).length / checklist.length : 0;
    const minutes = positive(task.estimated_minutes) * (1 - tickedShare);
    unitlessMinutes += minutes;
    if (task.section_id) unitlessBySection.set(task.section_id, (unitlessBySection.get(task.section_id) ?? 0) + minutes);
  }

  const unitMinutes = leftEntries.reduce((sum, entry) => sum + (entryMinutes(entry) ?? 0), 0);
  const pricedWorkLeftMinutes = unitMinutes + unitlessMinutes;
  // While any unfinished type has no speed, the total (and everything built on
  // it) is unknown: pricing those units at 0 would claim a false finish.
  const unpricedUnits = workLeft
    .filter((row) => row.seconds_per_unit === null)
    .map((row) => ({ work_type: row.work_type, units_left: row.units_left }));
  const workLeftMinutes: number | null = unpricedUnits.length > 0 ? null : pricedWorkLeftMinutes;

  // Every work type with units, finished ones too, for the speed table.
  const totals = new Map<string, { total: number; done: number }>();
  for (const entry of entries) {
    const acc = totals.get(entry.work_type) ?? { total: 0, done: 0 };
    acc.total += entry.units;
    if (entry.done) acc.done += entry.units;
    totals.set(entry.work_type, acc);
  }
  const workTypes: WorkTypeSummary[] = [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, acc]) => {
      const speed = resolveSpeed(type, measured, otherProjects, planSpeeds, planRatio);
      const left = leftByType.get(type);
      const unitsLeft = left ? left.main + left.sample : 0;
      const hours = unitsLeft <= 0 ? 0 : speed.seconds_per_unit === null ? null : (unitsLeft * speed.seconds_per_unit) / 3600;
      return {
        work_type: type,
        units_total: acc.total,
        units_done: acc.done,
        units_left: unitsLeft,
        seconds_per_unit: speed.seconds_per_unit === null ? null : round(speed.seconds_per_unit, 2),
        source: speed.source,
        n_sessions: speed.n_sessions,
        label: speed.label,
        hours_left: hours === null ? null : round(hours, 1),
      };
    });

  // Cadence: every session minute in the last 14 days (today included) ÷ 14.
  const windowStart = addDays(today, -(CADENCE_WINDOW_DAYS - 1));
  const windowSessions = sessions.filter((session) => session.session_date >= windowStart && session.session_date <= today);
  const windowMinutes = windowSessions.reduce((sum, session) => sum + session.minutes, 0);
  const cadence = windowMinutes / CADENCE_WINDOW_DAYS;

  // Available days: from max(today, earliest planned start of a section that
  // still has unit work left) to the target date, inclusive.
  const sectionsWithWork = new Set(
    leftEntries.filter((entry) => entry.section_id).map((entry) => entry.section_id)
  );
  const starts = input.sections
    .filter((section) => sectionsWithWork.has(section.id) && section.planned_start)
    .map((section) => section.planned_start as string)
    .sort();
  const availableFrom = starts.length > 0 && starts[0] > today ? starts[0] : today;
  const target = project.target_date ? project.target_date.slice(0, 10) : null;
  const availableDays = target ? Math.max(0, daysBetween(availableFrom, target) + 1) : null;
  const needed = workLeftMinutes !== null && availableDays && availableDays > 0 ? workLeftMinutes / availableDays : null;
  const planCadence = unpricedUnits.length === 0 && availableDays && availableDays > 0
    ? (planUnitMinutes + unitlessMinutes) / availableDays
    : null;

  const projectedFinish = workLeftMinutes === null
    ? null
    : workLeftMinutes <= 0
      ? today
      : cadence > 0
        ? addDays(today, daysOfWork(workLeftMinutes, cadence))
        : null;
  const slack = target && projectedFinish ? daysBetween(projectedFinish, target) : null;

  const countedSessions = sessions.filter((session) => !session.exclude_from_stats).length;
  let health: PaceHealth;
  if (countedSessions < MIN_COUNTED_SESSIONS_FOR_HEALTH) health = "insufficient_data";
  else if (!target) health = "no_target";
  else if (workLeftMinutes === null) health = "unknown";
  else health = projectedFinish !== null && projectedFinish <= target ? "on_track" : "behind";

  // Lane (section) projections: a running clock from today walks the sections in
  // planned_start order. A section with unit work left starts at max(clock, its
  // planned start) and ends ceil(work ÷ cadence) days later; the clock moves to that end.
  const sectionProjections = projectSections(
    input.sections,
    leftEntries,
    entryMinutes,
    unitlessBySection,
    { today, cadence, countedSessions, anyUnpriced: unpricedUnits.length > 0 }
  );

  // Size fit.
  const settings = parsePaceSettings(project.pace_settings ?? null);
  const size = settings.ok ? settings.value?.size ?? null : null;
  let sizeFit: SizeFit | null = null;
  let sizeFitReason: PaceForecast["size_fit_reason"] = null;
  if (!size) sizeFitReason = "not_configured";
  else if (entries.some((entry) => entry.scope === "main" && entry.done && size.work_types.includes(entry.work_type))) {
    sizeFitReason = "locked";
  } else if (workLeftMinutes === null) sizeFitReason = "unpriced_units";
  else if (availableDays === null) sizeFitReason = "no_target";
  else if (availableDays <= 0) sizeFitReason = "no_days_left";
  else {
    const perimeterTasks = new Set((size.perimeter?.task_ids ?? []).map((id) => id.toLowerCase()));
    const side = size.perimeter?.side ?? 0;
    let scaled = 0;
    let perimeter = 0;
    for (const entry of leftEntries) {
      const minutes = entryMinutes(entry) ?? 0;
      if (perimeterTasks.has(entry.task_id.toLowerCase())) perimeter += minutes;
      else if (entry.scope === "main" && size.work_types.includes(entry.work_type)) scaled += minutes;
    }
    // Reached only when nothing is unpriced, so the priced total is the total.
    const fixed = pricedWorkLeftMinutes - scaled - perimeter;
    const minutesAt = (width: number) =>
      fixed + (scaled * width) / size.current + (perimeter * (width + side)) / (size.current + side);
    const gauge = size.gauge;
    const lengthOf = (width: number) => (gauge ? round((width / gauge.units) * gauge.length, 1) : null);
    const candidates: number[] = [];
    for (let width = size.offset; width <= size.current; width += size.step) {
      if (width >= size.min) candidates.push(width);
    }
    const cadences: Array<{ minutes_per_day: number; source: "measured" | "fixed" }> = [];
    if (cadence > 0) cadences.push({ minutes_per_day: cadence, source: "measured" });
    for (const fixedCadence of SIZE_FIT_FIXED_CADENCES) cadences.push({ minutes_per_day: fixedCadence, source: "fixed" });
    const fits = cadences.map(({ minutes_per_day, source }) => {
      const budget = minutes_per_day * availableDays;
      const fitting = candidates.filter((width) => minutesAt(width) <= budget + 1e-9);
      const widest = fitting.length > 0 ? fitting[fitting.length - 1] : null;
      return {
        minutes_per_day: round(minutes_per_day, 1),
        source,
        widest,
        widest_length: widest === null ? null : lengthOf(widest),
      };
    });
    sizeFit = {
      label: size.label,
      unit: size.unit,
      current: size.current,
      needed_minutes_per_day_at_current: round(pricedWorkLeftMinutes / availableDays, 1),
      scaled_minutes_left: round(scaled, 1),
      perimeter_minutes_left: round(perimeter, 1),
      fixed_minutes_left: round(fixed, 1),
      fits,
      widths: candidates.map((width) => ({
        size: width,
        minutes_left: round(minutesAt(width), 0),
        needed_minutes_per_day: round(minutesAt(width) / availableDays, 1),
        ...(gauge ? { length: lengthOf(width) as number, length_unit: gauge.length_unit } : {}),
      })),
      current_length: lengthOf(size.current),
      length_unit: gauge ? gauge.length_unit : null,
    };
  }

  return {
    today,
    unit_label: project.unit_label,
    target_date: target,
    counted_sessions: countedSessions,
    excluded_sessions: sessions.length - countedSessions,
    plan_speeds: [...planSpeeds]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([work_type, seconds]) => ({ work_type, seconds_per_unit: round(seconds, 2) })),
    measured_speeds: measured.map((speed) => ({
      ...speed,
      seconds_per_unit: round(speed.seconds_per_unit, 2),
      minutes: round(speed.minutes, 1),
    })),
    plan_ratio: planRatio ? { ...planRatio, ratio: round(planRatio.ratio, 2) } : null,
    work_left: workLeft,
    work_types: workTypes,
    unitless_minutes_left: round(unitlessMinutes, 1),
    unpriced_types: unpriced,
    unpriced_units: unpricedUnits,
    work_left_minutes: workLeftMinutes === null ? null : round(workLeftMinutes, 0),
    work_left_hours: workLeftMinutes === null ? null : round(workLeftMinutes / 60, 1),
    priced_work_left_minutes: round(pricedWorkLeftMinutes, 0),
    cadence_minutes_per_day: round(cadence, 1),
    sessions_in_cadence_window: windowSessions.length,
    minutes_in_cadence_window: windowMinutes,
    plan_cadence_minutes_per_day: planCadence === null ? null : round(planCadence, 1),
    available_from: target ? availableFrom : null,
    available_days: availableDays,
    needed_minutes_per_day: needed === null ? null : round(needed, 1),
    projected_finish: projectedFinish,
    slack_days: slack,
    health,
    size_fit: sizeFit,
    size_fit_reason: sizeFitReason,
    sections: sectionProjections,
  };
}

function projectSections(
  sections: PaceSectionInput[],
  leftEntries: UnitEntry[],
  entryMinutes: (entry: UnitEntry) => number | null,
  unitlessBySection: Map<string, number>,
  context: { today: string; cadence: number; countedSessions: number; anyUnpriced: boolean }
): SectionProjection[] {
  const { today, cadence, countedSessions, anyUnpriced } = context;
  const enoughSittings = countedSessions >= MIN_COUNTED_SESSIONS_FOR_HEALTH;
  const ordered = [...sections].sort((a, b) => {
    const aStart = a.planned_start ?? "9999-12-31";
    const bStart = b.planned_start ?? "9999-12-31";
    return aStart < bStart ? -1 : aStart > bStart ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  let clock = today;
  let clockKnown = true;
  return ordered.map((section) => {
    const here = leftEntries.filter((entry) => entry.section_id === section.id);
    const unitsLeft = here.reduce((sum, entry) => sum + entry.units, 0);
    const unitless = unitlessBySection.get(section.id) ?? 0;
    const plannedStart = section.planned_start ?? null;
    const plannedEnd = section.planned_end ?? null;
    const base = { section_id: section.id, planned_start: plannedStart, planned_end: plannedEnd, units_left: unitsLeft };
    if (unitsLeft <= 0) {
      return { ...base, work_left_minutes: round(unitless, 0), projected_end: null, health: null, health_basis: "rows" as const };
    }
    if (anyUnpriced) {
      // While any unfinished type has no speed no lane can be timed (slice 1's rule for the project).
      return { ...base, work_left_minutes: null, projected_end: null, health: enoughSittings ? ("unknown" as const) : null, health_basis: "rows" as const };
    }
    const minutes = here.reduce((sum, entry) => sum + (entryMinutes(entry) ?? 0), 0) + unitless;
    let projectedEnd: string | null = null;
    if (clockKnown && cadence > 0) {
      const start = plannedStart && plannedStart > clock ? plannedStart : clock;
      projectedEnd = addDays(start, daysOfWork(minutes, cadence));
      clock = projectedEnd;
    } else {
      clockKnown = false;
    }
    if (enoughSittings && plannedEnd) {
      const late = projectedEnd === null || projectedEnd > plannedEnd;
      return { ...base, work_left_minutes: round(minutes, 0), projected_end: projectedEnd, health: late ? ("behind" as const) : ("on_track" as const), health_basis: "time" as const };
    }
    return { ...base, work_left_minutes: round(minutes, 0), projected_end: projectedEnd, health: null, health_basis: "rows" as const };
  });
}

/**
 * Pooled measured main-scope speeds for a set of projects (for the
 * `other_projects` tier and `get_pace_rates`). Each project's sessions are
 * split with its own plan speeds; the last-8 window then runs over the pool.
 */
export function computePooledRates(
  projects: Array<Pick<PaceInput, "tasks" | "items" | "sessions">>
): MeasuredSpeed[] {
  const pooled: SessionAllocation[] = [];
  for (const project of projects) {
    const entries = buildUnitEntries(project.tasks, project.items);
    const planSpeeds = computePlanSpeeds(project.tasks, entries);
    pooled.push(...allocateSessions(project.sessions, project.tasks, entries, planSpeeds));
  }
  return computeMeasuredSpeeds(pooled);
}

// ── One-line summary ────────────────────────────────────────────────────────

/** "colorwork-dc" → "Colorwork dc". */
export function formatWorkType(workType: string): string {
  const words = workType.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "stitches" → "stitch", "rows" → "row", "pages" → "page". */
export function singularUnit(label: string | null): string {
  if (!label) return "unit";
  const trimmed = label.trim();
  if (/(ches|shes|sses|xes)$/i.test(trimmed)) return trimmed.slice(0, -2);
  if (/s$/i.test(trimmed) && !/ss$/i.test(trimmed)) return trimmed.slice(0, -1);
  return trimmed;
}

function formatShortDate(date: string): string {
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(date.slice(5, 7)) - 1];
  return `${month} ${Number(date.slice(8, 10))}`;
}

const SOURCE_WORDS: Record<SpeedSource, string> = {
  measured: "measured",
  measured_sample: "swatch",
  other_projects: "other projects",
  plan_x_ratio: "plan × your pace",
  plan: "plan",
  none: "no data",
};

/**
 * One plain line for chat, e.g. "Colorwork dc 27.1 s/stitch (swatch, 1 session) ·
 * needs 198 min/day to finish by Dec 5 · at 60 min/day a 51-stitch width fits".
 * `focusType` picks the speed shown (default: the type with the most time left).
 */
export function formatForecastLine(forecast: PaceForecast, focusType?: string | null): string {
  const parts: string[] = [];
  const unit = singularUnit(forecast.unit_label);
  const focus = (focusType && forecast.work_left.find((row) => row.work_type === focusType))
    || [...forecast.work_left].sort((a, b) => (b.minutes_left ?? 0) - (a.minutes_left ?? 0))[0];
  const measuredFocus = focusType
    ? forecast.measured_speeds.find((speed) => speed.work_type === focusType && speed.scope === "main")
      ?? forecast.measured_speeds.find((speed) => speed.work_type === focusType)
    : undefined;
  if (focus && focus.seconds_per_unit !== null) {
    const sessions = focus.n_sessions === 1 ? "1 session" : `${focus.n_sessions} sessions`;
    const detail = focus.source === "measured" || focus.source === "measured_sample" || focus.source === "other_projects"
      ? `${SOURCE_WORDS[focus.source]}, ${sessions}`
      : SOURCE_WORDS[focus.source];
    parts.push(`${formatWorkType(focus.work_type)} ${focus.seconds_per_unit.toFixed(1)} s/${unit} (${detail})`);
  } else if (measuredFocus) {
    parts.push(`${formatWorkType(measuredFocus.work_type)} ${measuredFocus.seconds_per_unit.toFixed(1)} s/${unit} (${measuredFocus.scope === "sample" ? "swatch" : "measured"}, ${measuredFocus.n_sessions} session${measuredFocus.n_sessions === 1 ? "" : "s"})`);
  }
  if (forecast.unpriced_units.length > 0) {
    const label = forecast.unit_label?.trim() || "units";
    const list = forecast.unpriced_units.map((entry) => `${entry.units_left} ${entry.work_type} ${label}`);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
    parts.push(`${joined} ${list.length === 1 && forecast.unpriced_units[0].units_left === 1 ? "has" : "have"} no speed yet; log a session or set an estimate`);
  } else if (forecast.work_left_minutes === null || forecast.work_left_minutes <= 0) {
    parts.push("no work left");
  } else if (forecast.needed_minutes_per_day !== null && forecast.target_date) {
    parts.push(`needs ${Math.round(forecast.needed_minutes_per_day)} min/day to finish by ${formatShortDate(forecast.target_date)}`);
  } else if (forecast.target_date) {
    parts.push(`no days left before ${formatShortDate(forecast.target_date)}`);
  } else {
    parts.push(`${forecast.work_left_hours} h left (no target date)`);
  }
  if (forecast.size_fit) {
    const at60 = forecast.size_fit.fits.find((fit) => fit.source === "fixed" && fit.minutes_per_day === 60);
    if (at60) {
      parts.push(at60.widest === null
        ? `at 60 min/day not even a ${forecast.size_fit.widths[0]?.size ?? "minimum"}-${unit} ${forecast.size_fit.label} fits`
        : `at 60 min/day a ${at60.widest}-${unit} ${forecast.size_fit.label} fits`);
    }
  } else if (forecast.size_fit_reason === "locked") {
    parts.push("size locked (body started)");
  }
  if (forecast.health === "insufficient_data") {
    parts.push(`${forecast.counted_sessions} of ${MIN_COUNTED_SESSIONS_FOR_HEALTH} counted sessions for a health call`);
  } else if (forecast.health === "on_track" || forecast.health === "behind") {
    parts.push(forecast.health === "on_track" ? "on track" : "behind");
  }
  return parts.join(" · ");
}
