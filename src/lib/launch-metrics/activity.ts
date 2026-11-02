/**
 * "Still using it" on the Launch page: the weekly trend and the "N of M"
 * words (pure). Counts only, households only. The numbers come from the
 * Grocery summary's household activity keys (migration 20261102120000),
 * stored by the app-db sync as `app_db` rows: each ET day carries
 * `real_households_to_date`, `active_households_7d`, `still_using_eligible`
 * and `still_using_households` as of the end of that day.
 *
 * A week runs Monday to Sunday (New York days). A finished week reads its
 * Sunday row, so "active" is "used it that week" and "still using" is "signed
 * up before that week began and used it that week". The newest row reads
 * today's row: the last 7 days, the same numbers as the tiles.
 */

import { addDays, dateRange, LAUNCH_RELEASE_DATE } from './dates';
import type { DailyValue } from './page-data';
import { formatCount } from './format';

/** Below this many households a share is shown as "N of M" only, never a percentage. */
export const PERCENT_MIN_HOUSEHOLDS = 20;

export interface ActivityWeek {
  /** First day shown for the week (its Monday, or the release day for the first week). */
  since: string;
  /** The day whose row is read: the week's Sunday, or today for the newest row. */
  until: string;
  /** true for the newest row: the last 7 days up to today, not a finished week. */
  current: boolean;
  activeHouseholds: number | null;
  realHouseholds: number | null;
  stillUsing: number | null;
  stillUsingEligible: number | null;
}

function weekday(isoDate: string): number {
  // 0 = Sunday … 6 = Saturday, for a calendar day.
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

/** The Monday on or before a day. */
export function weekStart(isoDate: string): string {
  return addDays(isoDate, -((weekday(isoDate) + 6) % 7));
}

/**
 * Finished weeks since launch (newest first), then the last 7 days on top.
 * A week whose row has no stored number shows null ("not available"), never
 * a made-up 0. Empty when no activity number is stored at all.
 */
export function activityTrend(daily: DailyValue[], today: string): ActivityWeek[] {
  const rows = new Map<string, number>();
  for (const row of daily) {
    if (row.source === 'app_db' && row.dimension === '') {
      rows.set(`${row.metric_date}|${row.metric}`, row.value);
    }
  }
  const read = (date: string, metric: string) => rows.get(`${date}|${metric}`) ?? null;
  const hasAny = daily.some(
    (row) => row.source === 'app_db' && row.dimension === '' && (row.metric === 'active_households_7d' || row.metric === 'still_using_households')
  );
  if (!hasAny || today < LAUNCH_RELEASE_DATE) {
    return [];
  }

  const weeks: ActivityWeek[] = [];
  const point = (since: string, until: string, current: boolean): ActivityWeek => ({
    since,
    until,
    current,
    activeHouseholds: read(until, 'active_households_7d'),
    realHouseholds: read(until, 'real_households_to_date'),
    stillUsing: read(until, 'still_using_households'),
    stillUsingEligible: read(until, 'still_using_eligible'),
  });
  for (const monday of dateRange(weekStart(LAUNCH_RELEASE_DATE), today).filter((date) => weekday(date) === 1)) {
    const sunday = addDays(monday, 6);
    if (sunday >= today) {
      break;
    }
    weeks.push(point(monday < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : monday, sunday, false));
  }
  const lastSeven = addDays(today, -6);
  weeks.push(point(lastSeven < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : lastSeven, today, true));
  return weeks.reverse();
}

/**
 * "6 of 11" and, only from PERCENT_MIN_HOUSEHOLDS households up, its
 * percentage ("65%") for a second line. A dash when either number isn't known.
 */
export function shareParts(count: number | null, of: number | null): { text: string; percent: string | null } {
  if (count === null || of === null) {
    return { text: '–', percent: null };
  }
  return {
    text: `${formatCount(count)} of ${formatCount(of)}`,
    percent: of >= PERCENT_MIN_HOUSEHOLDS && of > 0 ? `${Math.round((count / of) * 100)}%` : null,
  };
}

/** One line: "6 of 11", or "130 of 200 (65%)" from 20 households up; a dash when unknown. */
export function formatShare(count: number | null, of: number | null): string {
  const { text, percent } = shareParts(count, of);
  return percent ? `${text} (${percent})` : text;
}

/** true when at least one activity number is known (the section shows numbers, not "not available yet"). */
export function hasActivity(values: Array<number | null>): boolean {
  return values.some((value) => value !== null);
}
