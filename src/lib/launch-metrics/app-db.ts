/**
 * App database (Grocery app) counts, read from the Grocery `launch-metrics`
 * edge function (plan §3.2, decisions 1, 2, 4, 9).
 *
 * The function returns totals only. This side re-validates the reply and
 * rebuilds it from an allowlist: only known count fields are kept, every count
 * must be a whole number ≥ 0, and a reply that carries per-account data of any
 * kind (an `accounts` list, a string where a count belongs) is refused, so a
 * mistake on the Grocery side can't land an id in Baseline.
 *
 * Contract assumptions (reconciled by the PM at integration):
 * - `generated_at`: ISO timestamp.
 * - `totals`: real_users, real_apple, real_email, real_unconfirmed,
 *   family_accounts, plus_paid, plus_trial, plus_comp (required);
 *   real_households_own, real_households_joined, excluded_accounts (optional).
 *   Plus counts are households (decision 9).
 * - `daily`: [{ date (ET YYYY-MM-DD), signups_real, signups_apple,
 *   signups_email (required), signups_family, signups_unconfirmed,
 *   signups_excluded (optional) }]. `day` is accepted as the date key too.
 */

import { addDays, etDate, isIsoDate } from './dates';
import { fetchJson, isPlainObject, LaunchSourceError, type FetchLike } from './http';
import type { DailyMetricInput } from './types';

export const APP_DB_TOTAL_REQUIRED = [
  'real_users',
  'real_apple',
  'real_email',
  'real_unconfirmed',
  'family_accounts',
  'plus_paid',
  'plus_trial',
  'plus_comp',
] as const;
export const APP_DB_TOTAL_OPTIONAL = ['real_households_own', 'real_households_joined', 'excluded_accounts'] as const;
export const APP_DB_DAILY_REQUIRED = ['signups_real', 'signups_apple', 'signups_email'] as const;
export const APP_DB_DAILY_OPTIONAL = ['signups_family', 'signups_unconfirmed', 'signups_excluded'] as const;

type TotalKey = (typeof APP_DB_TOTAL_REQUIRED)[number] | (typeof APP_DB_TOTAL_OPTIONAL)[number];
type DailyKey = (typeof APP_DB_DAILY_REQUIRED)[number] | (typeof APP_DB_DAILY_OPTIONAL)[number];

export type AppDbTotals = Record<(typeof APP_DB_TOTAL_REQUIRED)[number], number> &
  Partial<Record<(typeof APP_DB_TOTAL_OPTIONAL)[number], number>>;

export type AppDbDay = { date: string } & Record<(typeof APP_DB_DAILY_REQUIRED)[number], number> &
  Partial<Record<(typeof APP_DB_DAILY_OPTIONAL)[number], number>>;

export interface AppDbSummary {
  generated_at: string;
  totals: AppDbTotals;
  daily: AppDbDay[];
}

/** Keys that would mean per-account data; their presence anywhere refuses the reply. */
const FORBIDDEN_KEYS = new Set(['accounts', 'users', 'emails', 'email', 'user_id', 'user_ids', 'ids', 'id', 'short_id', 'name', 'display_name']);
const MAX_COUNT = 10_000_000;
const MAX_DAYS = 1000;
const EARLIEST_DATE = '2024-01-01';

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new LaunchSourceError('app_db_shape');
  }
  return value;
}

function assertNoForbiddenKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new LaunchSourceError('app_db_not_counts');
    }
  }
}

function pickCounts<K extends string>(
  record: Record<string, unknown>,
  required: readonly K[],
  optional: readonly K[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of required) {
    if (!(key in record)) {
      throw new LaunchSourceError('app_db_shape');
    }
    out[key] = readCount(record[key]);
  }
  for (const key of optional) {
    if (key in record && record[key] !== null) {
      out[key] = readCount(record[key]);
    }
  }
  // Any other key is dropped. A non-count value under an unknown key is still
  // refused: counts-only means nothing but numbers comes back.
  for (const [key, value] of Object.entries(record)) {
    if (!(required as readonly string[]).includes(key) && !(optional as readonly string[]).includes(key) && key !== 'date' && key !== 'day') {
      if (value !== null && typeof value !== 'number') {
        throw new LaunchSourceError('app_db_not_counts');
      }
    }
  }
  return out;
}

/**
 * Validates the edge function's reply and rebuilds it from the allowlist.
 * Throws `app_db_shape` (wrong shape) or `app_db_not_counts` (anything that
 * looks like per-account data).
 */
export function validateAppDbSummary(raw: unknown, now: Date = new Date()): AppDbSummary {
  if (!isPlainObject(raw)) {
    throw new LaunchSourceError('app_db_shape');
  }
  assertNoForbiddenKeys(raw);
  for (const [key, value] of Object.entries(raw)) {
    if (!['generated_at', 'totals', 'daily'].includes(key) && value !== null && typeof value !== 'number') {
      throw new LaunchSourceError('app_db_not_counts');
    }
  }

  const generatedAt = raw.generated_at;
  if (typeof generatedAt !== 'string' || generatedAt.length > 40 || Number.isNaN(Date.parse(generatedAt))) {
    throw new LaunchSourceError('app_db_shape');
  }

  if (!isPlainObject(raw.totals)) {
    throw new LaunchSourceError('app_db_shape');
  }
  assertNoForbiddenKeys(raw.totals);
  const totals = pickCounts<TotalKey>(raw.totals, APP_DB_TOTAL_REQUIRED, APP_DB_TOTAL_OPTIONAL) as AppDbTotals;

  if (!Array.isArray(raw.daily) || raw.daily.length > MAX_DAYS) {
    throw new LaunchSourceError('app_db_shape');
  }
  const latestAllowed = addDays(etDate(now), 1);
  const seen = new Set<string>();
  const daily: AppDbDay[] = [];
  for (const entry of raw.daily) {
    if (!isPlainObject(entry)) {
      throw new LaunchSourceError('app_db_shape');
    }
    assertNoForbiddenKeys(entry);
    const date = entry.date ?? entry.day;
    if (!isIsoDate(date) || date < EARLIEST_DATE || date > latestAllowed || seen.has(date)) {
      throw new LaunchSourceError('app_db_shape');
    }
    seen.add(date);
    const counts = pickCounts<DailyKey>(entry, APP_DB_DAILY_REQUIRED, APP_DB_DAILY_OPTIONAL);
    daily.push({ date, ...counts } as AppDbDay);
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return { generated_at: new Date(generatedAt).toISOString(), totals, daily };
}

export interface AppDbConfig {
  url: string;
  token: string;
}

/** Supabase project ref host + the one function path; anything else is refused. */
const FUNCTION_HOST = /^[a-z0-9]{20}\.supabase\.co$/;
const FUNCTION_PATH = '/functions/v1/launch-metrics';

export function readAppDbConfig(env: Record<string, string | undefined>): AppDbConfig | null {
  const url = env.MM_METRICS_URL?.trim();
  const token = env.MM_METRICS_TOKEN?.trim();
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

export function appDbHost(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LaunchSourceError('app_db_bad_url');
  }
  if (
    url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !FUNCTION_HOST.test(url.hostname)
    || url.pathname !== FUNCTION_PATH
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new LaunchSourceError('app_db_bad_url');
  }
  return url.hostname;
}

export async function fetchAppDbSummary(config: AppDbConfig, fetchImpl: FetchLike, now: Date = new Date()): Promise<AppDbSummary> {
  if (config.token.length < 32 || /\s/.test(config.token)) {
    throw new LaunchSourceError('app_db_bad_token');
  }
  const host = appDbHost(config.url);
  const raw = await fetchJson(fetchImpl, {
    url: config.url,
    method: 'GET',
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    allowedHosts: [host],
    timeoutMs: 20_000,
    maxBytes: 500_000,
  });
  return validateAppDbSummary(raw, now);
}

/** Daily rows (ET days) + the as-of totals for today (ET). */
export function appDbDailyRows(summary: AppDbSummary, asOfDate: string): DailyMetricInput[] {
  const rows: DailyMetricInput[] = [];
  const dailyKeys: DailyKey[] = [...APP_DB_DAILY_REQUIRED, ...APP_DB_DAILY_OPTIONAL];
  for (const day of summary.daily) {
    for (const key of dailyKeys) {
      const value = day[key];
      if (typeof value === 'number') {
        rows.push({ metric_date: day.date, source: 'app_db', metric: key, dimension: '', value });
      }
    }
  }
  const totalKeys: TotalKey[] = [...APP_DB_TOTAL_REQUIRED, ...APP_DB_TOTAL_OPTIONAL];
  for (const key of totalKeys) {
    const value = summary.totals[key];
    if (typeof value === 'number') {
      rows.push({ metric_date: asOfDate, source: 'app_db', metric: `total_${key}`, dimension: '', value });
    }
  }
  return rows;
}
