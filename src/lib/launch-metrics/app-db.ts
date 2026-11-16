/**
 * App database (Grocery app) counts, read from the Grocery `launch-metrics`
 * edge function (plan §3.2, decisions 1, 2, 4, 9).
 *
 * The function returns totals only. This side re-validates the reply and
 * rebuilds it from an allowlist: only known count fields are kept, every count
 * must be a whole number ≥ 0, and a reply that carries per-account data of any
 * kind (an `accounts` list, an id/email/name key, a string where a count
 * belongs) is refused, so a mistake on the Grocery side can't land an id in
 * Baseline (decision Q1: counts only).
 *
 * Contract: the Grocery function's "JSON contract (schema_version 1)"
 * (Grocery repo docs/handoffs/launch-metrics-db.md). The fixture
 * scripts/fixtures/launch-metrics/app-db-summary.json is that function's real
 * reply body.
 * - `schema_version`: exactly 1; anything else is refused.
 * - `generated_at`, `release_at`: ISO timestamps (strict pattern).
 * - `as_of_date_et`: the function's New York date, YYYY-MM-DD.
 *   These three are the ONLY strings allowed anywhere in the reply besides
 *   each daily row's `date` (a `date` in `totals` is refused like any other
 *   extra text field).
 * - Every count is a whole number from 0 to APP_DB_MAX_COUNT (10,000,000).
 * - `totals`: real_users, real_apple, real_email, real_unconfirmed,
 *   family_accounts, plus_paid, plus_trial, plus_comp (required);
 *   deleted_accounts, internal_accounts, real_households_own,
 *   real_households_joined, real_households_none, real_households (kept when
 *   sent). Plus counts and `real_households` are households (decision 9);
 *   `real_households_own/_joined/_none` count real USERS by how they belong to
 *   a household.
 * - `daily`: [{ date (ET YYYY-MM-DD), signups_real, signups_apple,
 *   signups_email (required), signups_deleted, signups_unconfirmed,
 *   signups_family, signups_internal (kept when sent) }]. `signups_real`
 *   includes `signups_deleted` (deleted accounts keep counting on their
 *   sign-up day, decision Q2).
 * - Household activity ("still using it", Grocery migration 20261102120000;
 *   definitions at the top of that migration and in the Grocery handoff).
 *   Optional, so this side works against the function before and after that
 *   migration: an older function simply doesn't send them, and the page then
 *   says "not available yet". schema_version stays 1. All are households:
 *   `totals`: active_households_7d, still_using_eligible,
 *   still_using_households, multi_member_households, shared_households_30d,
 *   shopping_households_7d. `daily` (the same rolling counts as of the end of
 *   that ET day, for the weekly trend): real_households_to_date,
 *   active_households_7d, still_using_eligible, still_using_households.
 *   Older Baseline builds drop these keys (unknown numeric keys are dropped).
 * - Reminders and the invite nudge (Grocery 1.0.3, plan docs
 *   mm-103-reminders-plan.md §3). Optional and additive like the activity
 *   keys: today's function doesn't send them and the page says "not
 *   available yet". All counts, none per account. `totals` (APP_DB_REMINDER_TOTALS):
 *   `reminders_ask_*` / `reminders_ios_*` (the in-app card and Apple's
 *   dialog), `reminders_{shop,share}_{scheduled,shown,tapped,acted,ignored,cancelled_opened}`,
 *   `reminders_off_in_app` / `_off_ios` / `_on_in_app`, `invite_nudge_*`,
 *   `reminders_households_said_yes`, `invite_prompted_households` /
 *   `invite_prompted_joined_7d`, `second_day_households` / `second_day_eligible`
 *   (households). `daily`: `reminders_shown`, `reminders_acted`.
 *   A malformed reminder NUMBER (negative, fractional, too large) or a
 *   boolean is DROPPED, not stored, and never fails the sign-up sync; a
 *   string, array or object under any key is refused (`app_db_not_counts`:
 *   it could be per-account data, decision Q1).
 */

import { addDays, etDate, isIsoDate } from './dates';
import { fetchJson, isPlainObject, LaunchSourceError, type FetchLike } from './http';
import type { DailyMetricInput } from './types';

export const APP_DB_SCHEMA_VERSION = 1;

/** Household activity totals (all households; optional, see the contract above). */
export const APP_DB_ACTIVITY_TOTALS = [
  'active_households_7d',
  'still_using_eligible',
  'still_using_households',
  'multi_member_households',
  'shared_households_30d',
  'shopping_households_7d',
] as const;
/** Per ET day, the rolling household activity counts as of that day (optional). */
export const APP_DB_ACTIVITY_DAILY = ['real_households_to_date', 'active_households_7d', 'still_using_eligible', 'still_using_households'] as const;

/**
 * Reminder and invite-nudge totals (Grocery 1.0.3; optional). Event counts
 * from the phones, except the households keys. The function counts real
 * households only and has no release-time cutoff of its own: the event counts
 * exist only because only the 1.0.3 app writes them. `second_day_*` is NOT
 * limited to 1.0.3: it covers every real household 7+ days old since launch.
 */
export const APP_DB_REMINDER_TOTALS = [
  'reminders_ask_shown',
  'reminders_ask_yes',
  'reminders_ask_not_now',
  'reminders_ios_allowed',
  'reminders_ios_denied',
  'reminders_shop_scheduled',
  'reminders_shop_shown',
  'reminders_shop_tapped',
  'reminders_shop_acted',
  'reminders_shop_ignored',
  'reminders_shop_cancelled_opened',
  'reminders_share_scheduled',
  'reminders_share_shown',
  'reminders_share_tapped',
  'reminders_share_acted',
  'reminders_share_ignored',
  'reminders_share_cancelled_opened',
  'reminders_off_in_app',
  'reminders_off_ios',
  'reminders_on_in_app',
  'invite_nudge_shown',
  'invite_nudge_send_tapped',
  'invite_nudge_dismissed',
  'invite_nudge_invite_made',
  /** Households (not events). */
  'invite_prompted_households',
  'invite_prompted_joined_7d',
  'reminders_households_said_yes',
  /** Households signed up 7+ days ago, and how many of them used it on 2+ different days in their first 7. */
  'second_day_households',
  'second_day_eligible',
] as const;
/** Per ET day, reminders shown and acted on (both types added together; optional). */
export const APP_DB_REMINDER_DAILY = ['reminders_shown', 'reminders_acted'] as const;

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
export const APP_DB_TOTAL_OPTIONAL = [
  'deleted_accounts',
  'internal_accounts',
  'real_households_own',
  'real_households_joined',
  'real_households_none',
  'real_households',
  // Household activity (Grocery migration 20261102120000).
  ...APP_DB_ACTIVITY_TOTALS,
  // Reminders and the invite nudge (Grocery 1.0.3).
  ...APP_DB_REMINDER_TOTALS,
] as const;
export const APP_DB_DAILY_REQUIRED = ['signups_real', 'signups_apple', 'signups_email'] as const;
export const APP_DB_DAILY_OPTIONAL = [
  'signups_deleted',
  'signups_unconfirmed',
  'signups_family',
  'signups_internal',
  // Household activity (Grocery migration 20261102120000).
  ...APP_DB_ACTIVITY_DAILY,
  // Reminders (Grocery 1.0.3).
  ...APP_DB_REMINDER_DAILY,
] as const;

type TotalKey = (typeof APP_DB_TOTAL_REQUIRED)[number] | (typeof APP_DB_TOTAL_OPTIONAL)[number];
type DailyKey = (typeof APP_DB_DAILY_REQUIRED)[number] | (typeof APP_DB_DAILY_OPTIONAL)[number];

export type AppDbTotals = Record<(typeof APP_DB_TOTAL_REQUIRED)[number], number> &
  Partial<Record<(typeof APP_DB_TOTAL_OPTIONAL)[number], number>>;

export type AppDbDay = { date: string } & Record<(typeof APP_DB_DAILY_REQUIRED)[number], number> &
  Partial<Record<(typeof APP_DB_DAILY_OPTIONAL)[number], number>>;

export interface AppDbSummary {
  schema_version: typeof APP_DB_SCHEMA_VERSION;
  generated_at: string;
  release_at: string;
  as_of_date_et: string;
  totals: AppDbTotals;
  daily: AppDbDay[];
}

/** Keys that would mean per-account data; their presence anywhere refuses the reply. */
const FORBIDDEN_KEYS = new Set(['accounts', 'users', 'emails', 'email', 'user_id', 'user_ids', 'ids', 'id', 'short_id', 'name', 'display_name']);
/**
 * Largest count accepted. Paired with the Grocery function's `MAX_COUNT`
 * (Grocery repo supabase/functions/_shared/launch-metrics-core.ts): both sides
 * refuse anything above 10,000,000. Change both together.
 */
export const APP_DB_MAX_COUNT = 10_000_000;
// One row per ET day from release; ten years of days (the Grocery side caps at 3660).
const MAX_DAYS = 3660;
const EARLIEST_DATE = '2024-01-01';
/** The Grocery function's own timestamp pattern: no other text can ride along. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/** A daily row's `date` is read and checked by validateAppDbSummary itself; totals get no such key. */
const DAILY_READ_BY_CALLER = ['date'] as const;
const TOP_LEVEL_KEYS = new Set(['schema_version', 'generated_at', 'release_at', 'as_of_date_et', 'totals', 'daily']);

/**
 * A top-level string the contract allows. A string that is not a timestamp
 * (or a date) is treated as possible per-account data (`app_db_not_counts`);
 * a missing value or a non-string is a shape error.
 */
function readTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LaunchSourceError('app_db_shape');
  }
  if (!TIMESTAMP.test(value)) {
    throw new LaunchSourceError('app_db_not_counts');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new LaunchSourceError('app_db_shape');
  }
  return new Date(parsed).toISOString();
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > APP_DB_MAX_COUNT) {
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

const REMINDER_KEYS: ReadonlySet<string> = new Set<string>([...APP_DB_REMINDER_TOTALS, ...APP_DB_REMINDER_DAILY]);

/**
 * A reminder count that is a whole number 0..APP_DB_MAX_COUNT, else null (the
 * value is dropped). Anything that is not a plain number or boolean (text, an
 * array, an object) could carry per-account data, so it refuses the reply.
 */
function readReminderCount(value: unknown): number | null {
  if (typeof value === 'string' || (typeof value === 'object' && value !== null)) {
    throw new LaunchSourceError('app_db_not_counts');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > APP_DB_MAX_COUNT) {
    return null;
  }
  return value;
}

function pickCounts<K extends string>(
  record: Record<string, unknown>,
  required: readonly K[],
  optional: readonly K[],
  /** Keys the caller reads itself (only a daily row's `date`); every other non-count is refused. */
  readByCaller: readonly string[] = []
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
      if (REMINDER_KEYS.has(key)) {
        // Additive and not needed for the sign-up numbers: a malformed number is dropped, the rest of the reply stands.
        const count = readReminderCount(record[key]);
        if (count !== null) {
          out[key] = count;
        }
      } else {
        out[key] = readCount(record[key]);
      }
    }
  }
  // Any other key is dropped. A non-count value under an unknown key is still
  // refused: counts-only means nothing but numbers comes back.
  for (const [key, value] of Object.entries(record)) {
    if (!(required as readonly string[]).includes(key) && !(optional as readonly string[]).includes(key) && !readByCaller.includes(key)) {
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
    if (!TOP_LEVEL_KEYS.has(key) && value !== null && typeof value !== 'number') {
      throw new LaunchSourceError('app_db_not_counts');
    }
  }

  if (typeof raw.schema_version === 'string') {
    throw new LaunchSourceError('app_db_not_counts');
  }
  if (raw.schema_version !== APP_DB_SCHEMA_VERSION) {
    throw new LaunchSourceError('app_db_shape');
  }
  const generatedAt = readTimestamp(raw.generated_at);
  const releaseAt = readTimestamp(raw.release_at);
  const latestAllowed = addDays(etDate(now), 1);
  if (typeof raw.as_of_date_et === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of_date_et)) {
    throw new LaunchSourceError('app_db_not_counts');
  }
  const asOfDate = raw.as_of_date_et;
  if (!isIsoDate(asOfDate) || asOfDate < EARLIEST_DATE || asOfDate > latestAllowed) {
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
  const seen = new Set<string>();
  const daily: AppDbDay[] = [];
  for (const entry of raw.daily) {
    if (!isPlainObject(entry)) {
      throw new LaunchSourceError('app_db_shape');
    }
    assertNoForbiddenKeys(entry);
    const date = entry.date;
    if (!isIsoDate(date) || date < EARLIEST_DATE || date > latestAllowed || seen.has(date)) {
      throw new LaunchSourceError('app_db_shape');
    }
    seen.add(date);
    const counts = pickCounts<DailyKey>(entry, APP_DB_DAILY_REQUIRED, APP_DB_DAILY_OPTIONAL, DAILY_READ_BY_CALLER);
    daily.push({ date, ...counts } as AppDbDay);
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    schema_version: APP_DB_SCHEMA_VERSION,
    generated_at: generatedAt,
    release_at: releaseAt,
    as_of_date_et: asOfDate,
    totals,
    daily,
  };
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
