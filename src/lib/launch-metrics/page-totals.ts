/**
 * Headline totals from the app database's as-of rows (`total_*`, one set per
 * ET day; the newest day wins). Counts only; Plus counts are households.
 */

import type { DailyValue } from './page-data';

export interface AppDbTotalsView {
  asOfDate: string;
  realUsers: number;
  realApple: number;
  realEmail: number;
  unconfirmed: number;
  familyAccounts: number;
  householdsOwn: number | null;
  householdsJoined: number | null;
  plusPaid: number;
  plusTrial: number;
  plusComp: number;
}

export function appDbHasRows(daily: DailyValue[]): boolean {
  return daily.some((row) => row.source === 'app_db' && row.metric.startsWith('total_'));
}

export function latestTotals(daily: DailyValue[]): AppDbTotalsView | null {
  const totals = daily.filter((row) => row.source === 'app_db' && row.metric.startsWith('total_') && row.dimension === '');
  if (totals.length === 0) {
    return null;
  }
  const asOfDate = totals.reduce((latest, row) => (row.metric_date > latest ? row.metric_date : latest), totals[0].metric_date);
  const sameDay = new Map(totals.filter((row) => row.metric_date === asOfDate).map((row) => [row.metric, row.value]));
  const get = (metric: string) => sameDay.get(`total_${metric}`) ?? 0;
  const maybe = (metric: string) => (sameDay.has(`total_${metric}`) ? get(metric) : null);
  return {
    asOfDate,
    realUsers: get('real_users'),
    realApple: get('real_apple'),
    realEmail: get('real_email'),
    unconfirmed: get('real_unconfirmed'),
    familyAccounts: get('family_accounts'),
    householdsOwn: maybe('real_households_own'),
    householdsJoined: maybe('real_households_joined'),
    plusPaid: get('plus_paid'),
    plusTrial: get('plus_trial'),
    plusComp: get('plus_comp'),
  };
}
