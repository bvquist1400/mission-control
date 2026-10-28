/**
 * Google Search Console numbers for menuandmarket.com (decision 7).
 *
 * Auth: a Google service account that Brent adds as a Restricted user on the
 * Search Console property. Baseline signs a short-lived JWT (RS256, scope
 * webmasters.readonly) with the account's key, swaps it at Google's token
 * endpoint for an access token, then calls searchAnalytics.query:
 *   - dimensions [date]  → clicks, impressions, position per day (Pacific days)
 *   - dimensions [query] → top 10 queries for the window (aggregated by Google)
 *   - dimensions [page]  → top 10 pages for the window (path only, own site only)
 * The key, the JWT and the access token are never logged, stored or returned.
 * Only two hosts are ever called: oauth2.googleapis.com and
 * searchconsole.googleapis.com.
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { addDays, dateInZone, isIsoDate, LAUNCH_RELEASE_DATE, SEARCH_CONSOLE_TIMEZONE } from './dates';
import { fetchJson, isPlainObject, LaunchSourceError, type FetchLike } from './http';
import type { DailyMetricInput } from './types';

export const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
export const GOOGLE_TOKEN_URL = `https://${GOOGLE_TOKEN_HOST}/token`;
export const SEARCH_CONSOLE_HOST = 'searchconsole.googleapis.com';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** Lifetime of the signed assertion (Google allows up to 1 hour). */
export const JWT_LIFETIME_SECONDS = 600;
export const TOP_LIST_SIZE = 10;
/** Days re-read on every run (Google revises the last few days). */
export const SEARCH_CONSOLE_WINDOW_DAYS = 30;

const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,61}[a-z0-9]@[a-z][a-z0-9-]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const DOMAIN_PROPERTY = /^sc-domain:([a-z0-9-]+(\.[a-z0-9-]+)+)$/;
const URL_PROPERTY = /^https:\/\/([a-z0-9-]+(\.[a-z0-9-]+)+)\/$/;

export interface SearchConsoleConfig {
  clientEmail: string;
  privateKeyPem: string;
  siteUrl: string;
}

export function readSearchConsoleConfig(env: Record<string, string | undefined>): SearchConsoleConfig | null {
  const clientEmail = env.GSC_CLIENT_EMAIL?.trim();
  const privateKeyPem = env.GSC_PRIVATE_KEY;
  const siteUrl = env.GSC_SITE_URL?.trim();
  if (!clientEmail || !privateKeyPem?.trim() || !siteUrl) {
    return null;
  }
  return { clientEmail, privateKeyPem, siteUrl };
}

/** The property's own host (for turning page URLs into paths). */
export function siteHost(siteUrl: string): string {
  const domain = DOMAIN_PROPERTY.exec(siteUrl);
  if (domain) {
    return domain[1];
  }
  const prefix = URL_PROPERTY.exec(siteUrl);
  if (prefix) {
    return prefix[1];
  }
  throw new LaunchSourceError('gsc_bad_site');
}

/** Vercel stores multi-line values fine, but a pasted key often has literal \n. */
export function loadServiceAccountKey(pem: string): KeyObject {
  const normalised = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: normalised, format: 'pem' });
  } catch {
    throw new LaunchSourceError('gsc_bad_key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new LaunchSourceError('gsc_bad_key');
  }
  return key;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signServiceAccountJwt(config: SearchConsoleConfig, nowSeconds: number): string {
  if (!SERVICE_ACCOUNT_EMAIL.test(config.clientEmail)) {
    throw new LaunchSourceError('gsc_bad_email');
  }
  const key = loadServiceAccountKey(config.privateKeyPem);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: config.clientEmail,
    scope: SEARCH_CONSOLE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(key))}`;
}

const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

export async function exchangeForAccessToken(assertion: string, fetchImpl: FetchLike): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();
  let raw: unknown;
  try {
    raw = await fetchJson(fetchImpl, {
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      allowedHosts: [GOOGLE_TOKEN_HOST],
      timeoutMs: 15_000,
      maxBytes: 20_000,
    });
  } catch (error) {
    // Name the step: a 400/401 here means the key or the account is wrong.
    if (error instanceof LaunchSourceError && error.code.startsWith('http_')) {
      throw new LaunchSourceError(`gsc_token_${error.code}`);
    }
    throw error;
  }
  if (!isPlainObject(raw) || typeof raw.access_token !== 'string' || !ACCESS_TOKEN.test(raw.access_token)) {
    throw new LaunchSourceError('gsc_token_shape');
  }
  return raw.access_token;
}

interface QueryRow {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number;
}

function readNumber(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new LaunchSourceError('gsc_shape');
  }
  return value;
}

export function parseQueryRows(raw: unknown): QueryRow[] {
  if (!isPlainObject(raw)) {
    throw new LaunchSourceError('gsc_shape');
  }
  // No rows at all is a normal answer for a quiet site.
  if (raw.rows === undefined) {
    return [];
  }
  if (!Array.isArray(raw.rows) || raw.rows.length > 25_000) {
    throw new LaunchSourceError('gsc_shape');
  }
  return raw.rows.map((row) => {
    if (!isPlainObject(row) || !Array.isArray(row.keys) || row.keys.length !== 1 || typeof row.keys[0] !== 'string') {
      throw new LaunchSourceError('gsc_shape');
    }
    return {
      keys: [row.keys[0]],
      clicks: readNumber(row.clicks ?? 0, 1e9),
      impressions: readNumber(row.impressions ?? 0, 1e10),
      position: readNumber(row.position ?? 0, 1e4),
    };
  });
}

export function dailyRowsFromQuery(rows: QueryRow[], since: string, until: string): DailyMetricInput[] {
  const out: DailyMetricInput[] = [];
  for (const row of rows) {
    const date = row.keys[0];
    if (!isIsoDate(date) || date < since || date > until) {
      throw new LaunchSourceError('gsc_shape');
    }
    out.push({ metric_date: date, source: 'search_console', metric: 'clicks', dimension: '', value: Math.round(row.clicks) });
    out.push({ metric_date: date, source: 'search_console', metric: 'impressions', dimension: '', value: Math.round(row.impressions) });
    out.push({
      metric_date: date,
      source: 'search_console',
      metric: 'position',
      dimension: '',
      value: Math.round(row.position * 100) / 100,
    });
  }
  return out;
}

export interface TopEntry {
  label: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface SearchConsoleTopLists {
  since: string;
  until: string;
  top_queries: TopEntry[];
  top_pages: TopEntry[];
}

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120);
}

function toTopEntry(row: QueryRow, label: string): TopEntry {
  return {
    label,
    clicks: Math.round(row.clicks),
    impressions: Math.round(row.impressions),
    position: Math.round(row.position * 10) / 10,
  };
}

export function topQueries(rows: QueryRow[]): TopEntry[] {
  return rows
    .map((row) => toTopEntry(row, cleanLabel(row.keys[0])))
    .filter((entry) => entry.label.length > 0)
    .slice(0, TOP_LIST_SIZE);
}

/** Page URLs become paths; a URL on any other host is dropped. */
export function topPages(rows: QueryRow[], host: string): TopEntry[] {
  const out: TopEntry[] = [];
  for (const row of rows) {
    let url: URL;
    try {
      url = new URL(row.keys[0]);
    } catch {
      continue;
    }
    const pageHost = url.hostname.replace(/^www\./, '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      continue;
    }
    if (pageHost !== host.replace(/^www\./, '')) {
      continue;
    }
    out.push(toTopEntry(row, cleanLabel(url.pathname || '/')));
    if (out.length >= TOP_LIST_SIZE) {
      break;
    }
  }
  return out;
}

export interface SearchConsoleResult {
  rows: DailyMetricInput[];
  topLists: SearchConsoleTopLists;
}

/** `now` drives the JWT clock and the window (Pacific days, ending today). */
export async function fetchSearchConsoleMetrics(
  config: SearchConsoleConfig,
  fetchImpl: FetchLike,
  now: Date
): Promise<SearchConsoleResult> {
  const host = siteHost(config.siteUrl);
  const assertion = signServiceAccountJwt(config, Math.floor(now.getTime() / 1000));
  const accessToken = await exchangeForAccessToken(assertion, fetchImpl);

  const until = dateInZone(now, SEARCH_CONSOLE_TIMEZONE);
  const windowStart = addDays(until, -SEARCH_CONSOLE_WINDOW_DAYS);
  const since = windowStart < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : windowStart;
  const url = `https://${SEARCH_CONSOLE_HOST}/webmasters/v3/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`;
  const query = (dimension: 'date' | 'query' | 'page', rowLimit: number) =>
    fetchJson(fetchImpl, {
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        startDate: since,
        endDate: until,
        dimensions: [dimension],
        type: 'web',
        dataState: 'all',
        rowLimit,
      }),
      allowedHosts: [SEARCH_CONSOLE_HOST],
      timeoutMs: 20_000,
      maxBytes: 2_000_000,
    });

  const daily = parseQueryRows(await query('date', 1000));
  const queries = parseQueryRows(await query('query', TOP_LIST_SIZE));
  const pages = parseQueryRows(await query('page', TOP_LIST_SIZE * 3));

  return {
    rows: dailyRowsFromQuery(daily, since, until),
    topLists: { since, until, top_queries: topQueries(queries), top_pages: topPages(pages, host) },
  };
}
