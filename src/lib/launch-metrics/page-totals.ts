/**
 * Headline totals from the app database's as-of rows (`total_*`, one set per
 * ET day; each total's newest day wins). Counts only; Plus counts and
 * `realHouseholds` are households; `usersInOwnHousehold` / `usersJoinedHousehold`
 * count real users by how they belong to a household (Grocery contract).
 * A total with no stored row is `null` (unknown), never a made-up 0, where the
 * hand-kept seed has no such number (unconfirmed, deleted, households).
 *
 * Household activity ("still using it", Grocery migration 20261102120000) is
 * read only from the same as-of day as the sign-up totals: a number the
 * function stopped sending (an older function) is `null` ("not available
 * yet"), never a stale value from an earlier day.
 */

import type { DailyValue } from './page-data';

export interface AppDbTotalsView {
  asOfDate: string;
  realUsers: number;
  realApple: number;
  realEmail: number;
  /** Unknown (null) until the live sync has sent it; the seed has no unconfirmed data. */
  unconfirmed: number | null;
  familyAccounts: number;
  deletedAccounts: number | null;
  realHouseholds: number | null;
  usersInOwnHousehold: number | null;
  usersJoinedHousehold: number | null;
  /** The day the Plus numbers are from (can differ from asOfDate after a seed). */
  plusAsOfDate: string;
  plusPaid: number;
  plusTrial: number;
  plusComp: number;
  activity: ActivityTotalsView;
}

/** Households. Each pair is shown as "N of M"; null = not available yet. */
export interface ActivityTotalsView {
  /** Real households with activity in the last 7 days, of `realHouseholds`. */
  activeHouseholds: number | null;
  /** The real households on the same day (the "of M" for active and shopping). */
  realHouseholds: number | null;
  /** Of `stillUsingEligible` (signed up 7+ days ago), active in the last 7 days. */
  stillUsing: number | null;
  stillUsingEligible: number | null;
  /** Of `multiMemberHouseholds` (2+ members), 2+ people made changes in the last 30 days. */
  sharedHouseholds: number | null;
  multiMemberHouseholds: number | null;
  /** Real households that checked items off in the last 7 days, of `realHouseholds`. */
  shoppingHouseholds: number | null;
}

export function appDbHasRows(daily: DailyValue[]): boolean {
  return daily.some((row) => row.source === 'app_db' && row.metric.startsWith('total_'));
}

export function latestTotals(daily: DailyValue[]): AppDbTotalsView | null {
  const totals = daily.filter((row) => row.source === 'app_db' && row.metric.startsWith('total_') && row.dimension === '');
  if (totals.length === 0) {
    return null;
  }
  // Each total takes its own newest day: a seeded Plus row for a later day
  // must not hide the sign-up totals of the day before.
  const latest = new Map<string, { date: string; value: number }>();
  for (const row of totals) {
    const current = latest.get(row.metric);
    if (!current || row.metric_date > current.date) {
      latest.set(row.metric, { date: row.metric_date, value: row.value });
    }
  }
  const asOfDate = latest.get('total_real_users')?.date
    ?? [...latest.values()].reduce((max, entry) => (entry.date > max ? entry.date : max), totals[0].metric_date);
  const sameDay = new Map([...latest.entries()].map(([metric, entry]) => [metric, entry.value]));
  const get = (metric: string) => sameDay.get(`total_${metric}`) ?? 0;
  const maybe = (metric: string) => (sameDay.has(`total_${metric}`) ? get(metric) : null);
  // Activity numbers count only when stored for the same as-of day.
  const onAsOf = (metric: string) => {
    const entry = latest.get(`total_${metric}`);
    return entry && entry.date === asOfDate ? entry.value : null;
  };
  return {
    asOfDate,
    realUsers: get('real_users'),
    realApple: get('real_apple'),
    realEmail: get('real_email'),
    unconfirmed: maybe('real_unconfirmed'),
    familyAccounts: get('family_accounts'),
    deletedAccounts: maybe('deleted_accounts'),
    realHouseholds: maybe('real_households'),
    usersInOwnHousehold: maybe('real_households_own'),
    usersJoinedHousehold: maybe('real_households_joined'),
    plusAsOfDate: latest.get('total_plus_paid')?.date ?? asOfDate,
    plusPaid: get('plus_paid'),
    plusTrial: get('plus_trial'),
    plusComp: get('plus_comp'),
    activity: {
      activeHouseholds: onAsOf('active_households_7d'),
      realHouseholds: onAsOf('real_households'),
      stillUsing: onAsOf('still_using_households'),
      stillUsingEligible: onAsOf('still_using_eligible'),
      sharedHouseholds: onAsOf('shared_households_30d'),
      multiMemberHouseholds: onAsOf('multi_member_households'),
      shoppingHouseholds: onAsOf('shopping_households_7d'),
    },
  };
}
