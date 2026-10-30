/**
 * Stale rules for the Launch page footer and section badges (plan §3.5 item 8).
 * App database and website: stale after 2 hours without a good update (the
 * hourly light run keeps them fresh). Search Console: 36 hours (it runs once a
 * day and Google's data lags). Light runs skip Search Console and Apple.
 *
 * Apple alone separates "we reached Apple" from "the data is new", because a
 * poll can succeed every day while Apple's reports stand still. Its rule goes
 * by the data, per report family (`appleDataIsStale`), and also goes stale if
 * Apple hasn't been reached for 72 hours. "Not connected" while no ASC_* value
 * is set.
 */

import { daysBetween } from './dates';
import type { RunRecord } from './store';
import { APPLE_NO_NEW_DATA, LAUNCH_SYNC_SOURCES, type LaunchSyncSource } from './types';

export const STALE_AFTER_HOURS: Record<LaunchSyncSource, number> = {
  app_db: 2,
  web: 2,
  search_console: 36,
  apple: 72,
};

/** Apple's report families and the day totals that mark a day as covered. */
export const APPLE_FAMILY_TOTALS = {
  engagement: ['impressions', 'product_page_views'],
  downloads: ['first_downloads', 'redownloads'],
} as const;
export type AppleFamilyName = keyof typeof APPLE_FAMILY_TOTALS;

/** The newest day each family has in launch_metric_daily (null = none yet). */
export type AppleDataThrough = Record<AppleFamilyName, string | null>;

/** Apple's normal delay: the page tells Brent its numbers arrive 2–3 days late. */
export const APPLE_REPORT_LAG_DAYS = 3;

/**
 * The 72 hours count from when a day's report was due, not from the poll: the
 * end of the family's newest data day, plus Apple's normal 3-day delay, plus
 * 72 hours. So a family goes stale 6 days after its newest day ends (UTC).
 *
 * Measured against the data day and not the instance processing date, because
 * a processing date moves when Apple re-issues old days: a new date on old
 * data would reset the clock with nothing new to show. Without the delay, a
 * normal 3-day-late report would already be stale on arrival.
 */
export function appleDataIsStale(through: string, now: Date): boolean {
  const dayEnds = Date.parse(`${through}T00:00:00Z`) + 86_400_000;
  return now.getTime() - dayEnds > (APPLE_REPORT_LAG_DAYS * 24 + STALE_AFTER_HOURS.apple) * 3_600_000;
}

/**
 * What a run that reached Apple logs: `ok` only when the data moved forward
 * and no family is left out of date, else `apple_no_new_data`. Only `ok` closes
 * an alert, so a poll that brings nothing never reads as a recovery.
 */
export function appleRunCode(before: AppleDataThrough, after: AppleDataThrough, now: Date): string {
  const families = Object.keys(APPLE_FAMILY_TOTALS) as AppleFamilyName[];
  const moved = families.some((family) => {
    const through = after[family];
    const previous = before[family];
    return through !== null && (previous === null || through > previous);
  });
  const behind = families.some((family) => {
    const through = after[family];
    return through !== null && appleDataIsStale(through, now);
  });
  return moved && !behind ? 'ok' : APPLE_NO_NEW_DATA;
}

/** A run still "running" after this long is shown as not finished. */
export const RUN_UNFINISHED_AFTER_MS = 10 * 60_000;
export const TOKEN_WARNING_DAYS = 30;

/** `waiting` = Apple answers but has sent no report yet: not fresh, nothing to be stale. */
export type SourceState = 'fresh' | 'stale' | 'failing' | 'not_configured' | 'not_connected' | 'never' | 'waiting';

export interface AppleFamilyHealth {
  through: string | null;
  stale: boolean;
}

export interface SourceHealth {
  source: LaunchSyncSource;
  state: SourceState;
  /** Last run that reached the source without an error. For Apple that says nothing about its data. */
  lastOkAt: string | null;
  lastTriedAt: string | null;
  lastCode: string | null;
  /** Apple only: how far each report family's data goes. */
  appleData?: Record<AppleFamilyName, AppleFamilyHealth>;
}

const NO_APPLE_DATA: AppleDataThrough = { engagement: null, downloads: null };

/** A run that reached the source, whether or not it brought anything new. */
export function reachedSource(code: string | null | undefined): boolean {
  return code === 'ok' || code === APPLE_NO_NEW_DATA;
}

function appleFamilyHealth(through: string | null, now: Date): AppleFamilyHealth {
  return { through, stale: through !== null && appleDataIsStale(through, now) };
}

export function sourceHealth(runs: RunRecord[], now: Date, appleThrough: AppleDataThrough = NO_APPLE_DATA): SourceHealth[] {
  const finished = runs
    .filter((run) => run.finished_at !== null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  return LAUNCH_SYNC_SOURCES.map((source) => {
    const tried = finished.filter((run) => {
      const code = run.sources[source];
      return typeof code === 'string' && code !== 'skipped';
    });
    const last = tried[0] ?? null;
    const lastOk = tried.find((run) => reachedSource(run.sources[source])) ?? null;
    const lastCode = last ? last.sources[source] : null;
    const lastOkAt = lastOk ? lastOk.finished_at : null;
    const appleData =
      source === 'apple'
        ? { engagement: appleFamilyHealth(appleThrough.engagement, now), downloads: appleFamilyHealth(appleThrough.downloads, now) }
        : undefined;
    let state: SourceState;
    if (!last) {
      state = 'never';
    } else if (lastCode === 'not_configured') {
      state = 'not_configured';
    } else if (lastCode === 'not_connected') {
      state = 'not_connected';
    } else if (!reachedSource(lastCode)) {
      state = 'failing';
    } else {
      const ageHours = (now.getTime() - Date.parse(lastOkAt as string)) / 3_600_000;
      if (ageHours > STALE_AFTER_HOURS[source]) {
        state = 'stale';
      } else if (!appleData) {
        state = 'fresh';
      } else if (appleData.engagement.through === null && appleData.downloads.through === null) {
        state = 'waiting';
      } else {
        state = appleData.engagement.stale || appleData.downloads.stale ? 'stale' : 'fresh';
      }
    }
    return { source, state, lastOkAt, lastTriedAt: last ? last.finished_at : null, lastCode, ...(appleData ? { appleData } : {}) };
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
