import { normalizeDateOnly, toUtcDateMs } from '../date-only.ts';

export { normalizeDateOnly, toUtcDateMs } from '../date-only.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PACE_TOLERANCE_TASKS = 1;
const EMPTY_HOLIDAY_SET = new Set<string>();

export interface SprintProgressMetricsInput {
  sprintStartDate: string;
  sprintEndDate: string;
  totalTasks: number;
  completedTasks: number;
  todayDate: string;
  holidaySet?: ReadonlySet<string>;
  paceToleranceTasks?: number;
}

export interface SprintProgressMetrics {
  totalWorkdays: number;
  elapsedWorkdays: number;
  daysLeft: number;
  remainingTasks: number;
  requiredTasksPerDay: number;
  expectedCompletedByNow: number;
  tasksBehindPace: number;
  forecastFinishDate: string | null;
  forecastWithinSprint: boolean | null;
  onTrack: boolean;
}

export function parseSprintHolidaySet(raw: string | undefined): Set<string> {
  if (!raw || raw.trim().length === 0) {
    return new Set();
  }

  const tokens = raw
    .split(/[,\n]/)
    .map((token) => normalizeDateOnly(token))
    .filter((token): token is string => token !== null);

  return new Set(tokens);
}

export function isBusinessDayUtc(ms: number): boolean {
  const day = new Date(ms).getUTCDay();
  return day >= 1 && day <= 5;
}

export function countBusinessDaysInclusive(
  startDateOnly: string,
  endDateOnly: string,
  holidaySet: ReadonlySet<string> = EMPTY_HOLIDAY_SET
): number {
  const startMs = toUtcDateMs(startDateOnly);
  const endMs = toUtcDateMs(endDateOnly);
  if (startMs === null || endMs === null || startMs > endMs) {
    return 0;
  }

  let count = 0;
  for (let cursor = startMs; cursor <= endMs; cursor += DAY_MS) {
    const cursorDateOnly = new Date(cursor).toISOString().slice(0, 10);
    if (isBusinessDayUtc(cursor) && !holidaySet.has(cursorDateOnly)) {
      count += 1;
    }
  }

  return count;
}

export function addBusinessDays(
  startDateOnly: string,
  businessDaysToAdd: number,
  holidaySet: ReadonlySet<string> = EMPTY_HOLIDAY_SET
): string | null {
  const startMs = toUtcDateMs(startDateOnly);
  if (startMs === null) {
    return null;
  }

  const normalizedStart = new Date(startMs).toISOString().slice(0, 10);
  const startIsBusinessDay = isBusinessDayUtc(startMs) && !holidaySet.has(normalizedStart);
  let cursor = startMs;

  if (businessDaysToAdd <= 0) {
    if (startIsBusinessDay) {
      return normalizedStart;
    }

    while (true) {
      cursor += DAY_MS;
      const cursorDateOnly = new Date(cursor).toISOString().slice(0, 10);
      if (isBusinessDayUtc(cursor) && !holidaySet.has(cursorDateOnly)) {
        return cursorDateOnly;
      }
    }
  }

  let added = 0;
  while (added < businessDaysToAdd) {
    cursor += DAY_MS;
    const cursorDateOnly = new Date(cursor).toISOString().slice(0, 10);
    if (isBusinessDayUtc(cursor) && !holidaySet.has(cursorDateOnly)) {
      added += 1;
    }
  }

  return new Date(cursor).toISOString().slice(0, 10);
}

export function calculateSprintProgressMetrics(input: SprintProgressMetricsInput): SprintProgressMetrics {
  const holidaySet = input.holidaySet ?? EMPTY_HOLIDAY_SET;
  const paceToleranceTasks = Math.max(0, input.paceToleranceTasks ?? DEFAULT_PACE_TOLERANCE_TASKS);
  const totalTasks = Number.isFinite(input.totalTasks) ? Math.max(0, input.totalTasks) : 0;
  const completedTasks = Number.isFinite(input.completedTasks) ? Math.max(0, input.completedTasks) : 0;

  const totalWorkdays = countBusinessDaysInclusive(input.sprintStartDate, input.sprintEndDate, holidaySet);
  const elapsedWorkdays = Math.min(
    totalWorkdays,
    countBusinessDaysInclusive(input.sprintStartDate, input.todayDate, holidaySet)
  );
  const daysLeft =
    input.todayDate <= input.sprintEndDate
      ? countBusinessDaysInclusive(input.todayDate, input.sprintEndDate, holidaySet)
      : 0;
  const remainingTasks = Math.max(totalTasks - completedTasks, 0);
  const requiredTasksPerDay = daysLeft > 0 ? remainingTasks / daysLeft : remainingTasks;
  const expectedCompletedByNow = totalWorkdays > 0 ? Math.round((elapsedWorkdays / totalWorkdays) * totalTasks) : 0;
  const tasksBehindPace = Math.max(expectedCompletedByNow - completedTasks, 0);

  const completionRatePerWorkday = elapsedWorkdays > 0 ? completedTasks / elapsedWorkdays : 0;
  const forecastWorkdaysNeeded =
    remainingTasks <= 0
      ? 0
      : completionRatePerWorkday > 0
        ? Math.ceil(remainingTasks / completionRatePerWorkday)
        : null;
  const forecastFinishDate =
    forecastWorkdaysNeeded === null
      ? null
      : addBusinessDays(input.todayDate, Math.max(0, forecastWorkdaysNeeded - 1), holidaySet);
  const forecastWithinSprint =
    forecastFinishDate === null
      ? null
      : forecastFinishDate <= input.sprintEndDate;

  const onTrack =
    remainingTasks === 0 ||
    (tasksBehindPace <= paceToleranceTasks && (forecastWithinSprint ?? true));

  return {
    totalWorkdays,
    elapsedWorkdays,
    daysLeft,
    remainingTasks,
    requiredTasksPerDay,
    expectedCompletedByNow,
    tasksBehindPace,
    forecastFinishDate,
    forecastWithinSprint,
    onTrack,
  };
}
