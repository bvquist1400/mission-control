/**
 * Website numbers for menuandmarket.com from the Vercel Web Analytics API
 * (decision 3: a token scoped to the menuandmarket-site project only).
 *
 * Three GETs to https://api.vercel.com/v1/query/web-analytics/…:
 *   visits/aggregate by=day                          → visitors, pageviews per day
 *   visits/aggregate by=day&by=referrerHostname      → pageviews/visitors per referrer per day
 *   events/aggregate by=day&by=eventData/placement,
 *     filter eventName eq 'App Store tap'            → App Store taps per placement per day
 * Days are UTC (the API's `timestamp`). Production data only (the API's
 * default filter). Only the fields named here are read from each row, so a
 * visitor or user id the API might add never reaches Baseline.
 */

import { addDays, isIsoDate, LAUNCH_RELEASE_DATE } from './dates';
import { fetchJson, isPlainObject, LaunchSourceError, type FetchLike } from './http';
import type { DailyMetricInput } from './types';

export const VERCEL_API_HOST = 'api.vercel.com';
export const APP_STORE_TAP_EVENT = 'App Store tap';
const BASE = `https://${VERCEL_API_HOST}/v1/query/web-analytics`;
const MAX_VALUE = 100_000_000;

export interface VercelAnalyticsConfig {
  token: string;
  projectId: string;
  teamId: string | null;
  /** YYYY-MM-DD the token expires (shown on the page a month ahead). */
  tokenExpires: string | null;
}

export function readVercelAnalyticsConfig(env: Record<string, string | undefined>): VercelAnalyticsConfig | null {
  const token = env.VERCEL_ANALYTICS_TOKEN?.trim();
  const projectId = env.VERCEL_ANALYTICS_PROJECT_ID?.trim();
  if (!token || !projectId) {
    return null;
  }
  const teamId = env.VERCEL_ANALYTICS_TEAM_ID?.trim() || null;
  const expires = env.VERCEL_ANALYTICS_TOKEN_EXPIRES?.trim() || null;
  return { token, projectId, teamId, tokenExpires: isIsoDate(expires) ? expires : null };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function buildUrl(
  config: VercelAnalyticsConfig,
  path: 'visits/aggregate' | 'events/aggregate',
  params: Array<[string, string]>
): string {
  if (!ID_PATTERN.test(config.projectId) || (config.teamId !== null && !ID_PATTERN.test(config.teamId))) {
    throw new LaunchSourceError('web_bad_config');
  }
  const search = new URLSearchParams();
  search.append('projectId', config.projectId);
  if (config.teamId) {
    search.append('teamId', config.teamId);
  }
  for (const [key, value] of params) {
    search.append(key, value);
  }
  return `${BASE}/${path}?${search.toString()}`;
}

/** Row timestamp → UTC date; anything unreadable refuses the reply. */
function rowDate(row: Record<string, unknown>): string {
  const ts = row.timestamp;
  if (typeof ts !== 'string' || ts.length > 40) {
    throw new LaunchSourceError('web_shape');
  }
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) {
    throw new LaunchSourceError('web_shape');
  }
  return parsed.toISOString().slice(0, 10);
}

function rowCount(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE) {
    throw new LaunchSourceError('web_shape');
  }
  return Math.round(value);
}

/** Printable, single-line, ≤ 120 characters. Empty → the fallback label. */
export function cleanDimensionValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

function readRows(raw: unknown): Record<string, unknown>[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.data) || raw.data.length > 20_000) {
    throw new LaunchSourceError('web_shape');
  }
  return raw.data.map((row) => {
    if (!isPlainObject(row)) {
      throw new LaunchSourceError('web_shape');
    }
    return row;
  });
}

/** Sums rows that land on the same key (e.g. two referrers that clean to the same text). */
function addRow(map: Map<string, DailyMetricInput>, row: DailyMetricInput): void {
  const key = `${row.metric_date}|${row.metric}|${row.dimension}`;
  const existing = map.get(key);
  if (existing) {
    existing.value += row.value;
  } else {
    map.set(key, { ...row });
  }
}

export function parseVisitsByDay(raw: unknown): DailyMetricInput[] {
  const out = new Map<string, DailyMetricInput>();
  for (const row of readRows(raw)) {
    const date = rowDate(row);
    addRow(out, { metric_date: date, source: 'web', metric: 'pageviews', dimension: '', value: rowCount(row, 'pageviews') });
    addRow(out, { metric_date: date, source: 'web', metric: 'visitors', dimension: '', value: rowCount(row, 'visitors') });
  }
  return [...out.values()];
}

export function parseVisitsByReferrer(raw: unknown): DailyMetricInput[] {
  const out = new Map<string, DailyMetricInput>();
  for (const row of readRows(raw)) {
    const date = rowDate(row);
    const host = cleanDimensionValue(row.referrerHostname, '(direct)').toLowerCase();
    const dimension = `referrer:${host}`;
    addRow(out, { metric_date: date, source: 'web', metric: 'pageviews', dimension, value: rowCount(row, 'pageviews') });
    addRow(out, { metric_date: date, source: 'web', metric: 'visitors', dimension, value: rowCount(row, 'visitors') });
  }
  return [...out.values()];
}

function eventPlacement(row: Record<string, unknown>): unknown {
  // The docs show a by=eventData/<key> group under the key `eventData`; accept
  // the full dimension name or a nested object too.
  if (typeof row.eventData === 'string') {
    return row.eventData;
  }
  if (isPlainObject(row.eventData)) {
    return row.eventData.placement;
  }
  return row['eventData/placement'];
}

export function parseAppStoreTaps(raw: unknown): DailyMetricInput[] {
  const out = new Map<string, DailyMetricInput>();
  for (const row of readRows(raw)) {
    const date = rowDate(row);
    const count = rowCount(row, 'count');
    const placement = cleanDimensionValue(eventPlacement(row), '(none)');
    addRow(out, { metric_date: date, source: 'web', metric: 'app_store_taps', dimension: `placement:${placement}`, value: count });
    addRow(out, { metric_date: date, source: 'web', metric: 'app_store_taps', dimension: '', value: count });
  }
  return [...out.values()];
}

export interface WebFetchResult {
  rows: DailyMetricInput[];
  since: string;
  until: string;
}

/** Days re-read on every run. Older days are already stored and kept. */
export const WEB_TOTALS_WINDOW_DAYS = 45;
export const WEB_BREAKDOWN_WINDOW_DAYS = 7;

function windowStart(today: string, days: number): string {
  const start = addDays(today, -days);
  return start < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : start;
}

/**
 * `today` is the UTC date of the run. Day totals: the last 45 days; referrer
 * and placement breakdowns: the last 7 (short windows keep each grouped reply
 * well under the API's 100-group limit, past which it folds the rest into
 * "Others"). Never before the release date.
 */
export async function fetchWebMetrics(
  config: VercelAnalyticsConfig,
  fetchImpl: FetchLike,
  today: string
): Promise<WebFetchResult> {
  if (config.token.length < 16 || /\s/.test(config.token)) {
    throw new LaunchSourceError('web_bad_token');
  }
  const until = today < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : today;
  const since = windowStart(until, WEB_TOTALS_WINDOW_DAYS);
  const breakdownSince = windowStart(until, WEB_BREAKDOWN_WINDOW_DAYS);
  const headers = { Authorization: `Bearer ${config.token}`, Accept: 'application/json' };
  const request = (url: string) =>
    fetchJson(fetchImpl, { url, headers, allowedHosts: [VERCEL_API_HOST], timeoutMs: 20_000, maxBytes: 2_000_000 });

  const visits = await request(
    buildUrl(config, 'visits/aggregate', [['since', since], ['until', until], ['by', 'day'], ['limit', '100']])
  );
  const referrers = await request(
    buildUrl(config, 'visits/aggregate', [
      ['since', breakdownSince],
      ['until', until],
      ['by', 'day'],
      ['by', 'referrerHostname'],
      ['limit', '100'],
    ])
  );
  const taps = await request(
    buildUrl(config, 'events/aggregate', [
      ['since', breakdownSince],
      ['until', until],
      ['by', 'day'],
      ['by', 'eventData/placement'],
      ['limit', '100'],
      ['filter', `eventName eq '${APP_STORE_TAP_EVENT}'`],
    ])
  );

  const rows = [...parseVisitsByDay(visits), ...parseVisitsByReferrer(referrers), ...parseAppStoreTaps(taps)].filter(
    (row) => row.metric_date >= since && row.metric_date <= until
  );
  return { rows, since, until };
}
