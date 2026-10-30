/**
 * Stale rules for the Launch page footer and section badges (plan §3.5 item 8).
 * App database and website: stale after 2 hours without a good update (the
 * hourly light run keeps them fresh). Search Console: 36 hours (it runs once a
 * day and Google's data lags). Apple: 72 hours (once a day, in the full run;
 * "not connected" while no ASC_* value is set). Light runs skip both.
 */

import { daysBetween } from './dates';
import type { RunRecord } from './store';
import { LAUNCH_SYNC_SOURCES, type LaunchSyncSource } from './types';

export const STALE_AFTER_HOURS: Record<LaunchSyncSource, number> = {
  app_db: 2,
  web: 2,
  search_console: 36,
  apple: 72,
};

/** A run still "running" after this long is shown as not finished. */
export const RUN_UNFINISHED_AFTER_MS = 10 * 60_000;
export const TOKEN_WARNING_DAYS = 30;

export type SourceState = 'fresh' | 'stale' | 'failing' | 'not_configured' | 'not_connected' | 'never';

export interface SourceHealth {
  source: LaunchSyncSource;
  state: SourceState;
  lastOkAt: string | null;
  lastTriedAt: string | null;
  lastCode: string | null;
}

export function sourceHealth(runs: RunRecord[], now: Date): SourceHealth[] {
  const finished = runs
    .filter((run) => run.finished_at !== null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  return LAUNCH_SYNC_SOURCES.map((source) => {
    const tried = finished.filter((run) => {
      const code = run.sources[source];
      return typeof code === 'string' && code !== 'skipped';
    });
    const last = tried[0] ?? null;
    const lastOk = tried.find((run) => run.sources[source] === 'ok') ?? null;
    const lastCode = last ? last.sources[source] : null;
    const lastOkAt = lastOk ? lastOk.finished_at : null;
    let state: SourceState;
    if (!last) {
      state = 'never';
    } else if (lastCode === 'not_configured') {
      state = 'not_configured';
    } else if (lastCode === 'not_connected') {
      state = 'not_connected';
    } else if (lastCode !== 'ok') {
      state = 'failing';
    } else {
      const ageHours = (now.getTime() - Date.parse(lastOkAt as string)) / 3_600_000;
      state = ageHours > STALE_AFTER_HOURS[source] ? 'stale' : 'fresh';
    }
    return { source, state, lastOkAt, lastTriedAt: last ? last.finished_at : null, lastCode };
  });
}

export function isRunUnfinished(run: RunRecord, now: Date): boolean {
  return run.finished_at === null && now.getTime() - Date.parse(run.started_at) > RUN_UNFINISHED_AFTER_MS;
}

/** Days left on the website token when 30 or fewer (negative = expired), else null. */
export function tokenDaysLeft(expires: string | null, today: string): number | null {
  if (!expires) {
    return null;
  }
  const left = daysBetween(today, expires);
  return left <= TOKEN_WARNING_DAYS ? left : null;
}
