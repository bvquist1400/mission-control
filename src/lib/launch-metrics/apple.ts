/**
 * App Store numbers for Menu & Market (plan §3.4 `apple.ts`, piece 5; phase 2).
 *
 * Reads Apple's Analytics Reports API with a "Sales" team key:
 *   1. ES256 JWT signed here with node:crypto (kid, iss, aud appstoreconnect-v1,
 *      15 minutes; Apple refuses more than 20). No dependency.
 *   2. The app's report requests: the ONGOING one that is still running (a
 *      stopped one is `apple_request_stopped`) plus any ONE_TIME_SNAPSHOT
 *      (launch-week history).
 *   3. Each request's reports, keeping only the four we use (names below).
 *   4. Each report's DAILY instances that are not yet in launch_apple_instances
 *      (at most 40 a run; every call is checked against a deadline: 50 s from
 *      Apple's start and 95 s from the run's, each timeout cut to the time
 *      left; leftover work, cut mid-instance or not, is read next run). An
 *      instance listed before its file exists is not recorded (retried; after
 *      7 days it is recorded as empty).
 *   5. Each instance's segments: download (no credentials sent), check the size
 *      and checksum, gunzip when the bytes say gzip (plain text is fine too),
 *      parse the tab-separated file BY HEADER NAME (an unknown or missing
 *      column stops the source: fail closed), keep only rows for ASC_APP_ID,
 *      (none for it while the file has rows = `apple_tsv_app`), aggregate to
 *      daily metrics and upsert. The newest processing date wins for the whole
 *      day of a report: a day already holding a newer instance's rows gets
 *      nothing from an older one, and keys a newer instance no longer has are
 *      written as 0, so two instances are never merged (065's trigger backs
 *      it). The instance is then recorded, so it is never read twice.
 *
 * A list that can't be shown to be whole stops the source (`apple_paging`:
 * a repeated id, or a count that doesn't match `meta.paging.total`), so nothing
 * of a short or doubled instance is written or recorded. `syncApple` reports
 * how far the data went, because reaching Apple doesn't mean the data moved.
 *
 * Never stored, logged or returned: the key, the JWT, a response body, a
 * segment or its URL. Failures are a `LaunchSourceError` with a short code.
 * Only api.appstoreconnect.apple.com gets the token. Segment files are fetched
 * from Apple's own hosts (`*.apple.com`) without any credential.
 */

import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { addDays, isIsoDate, LAUNCH_RELEASE_DATE } from './dates';
import { assertAllowedUrl, fetchBytes, fetchJson, isPlainObject, LaunchSourceError, type FetchLike } from './http';
import type { AppleDataThrough } from './stale';
import type { AppleStoredKey, LaunchStore } from './store';
import type { DailyMetricInput } from './types';

export const APPLE_API_HOST = 'api.appstoreconnect.apple.com';
const API = `https://${APPLE_API_HOST}`;
/**
 * Where segment files may be downloaded from. Apple's docs don't name the
 * host of a segment's signed URL; it is assumed to be an apple.com host. Any
 * other host is refused (`apple_segment_host`) and nothing is downloaded.
 */
export const APPLE_SEGMENT_HOST_SUFFIXES = ['.apple.com'] as const;
export const APPLE_JWT_LIFETIME_SECONDS = 15 * 60;
export const APPLE_JWT_AUDIENCE = 'appstoreconnect-v1';

/** Rows dated before this are dropped (pre-launch). */
export const APPLE_HISTORY_START = addDays(LAUNCH_RELEASE_DATE, -7);
/** A run reads at most this many new instances; the rest wait for the next run. */
export const APPLE_MAX_INSTANCES_PER_RUN = 40;
/** No Apple call is started after this long from Apple's own start. */
export const APPLE_TIME_BUDGET_MS = 50_000;
/**
 * Nor after this long from the start of the whole sync run (the route has
 * 120 s in all; the rest is for the run log and alerts). Each call's timeout
 * is also cut to the time left, so no single slow call can overrun it.
 */
export const APPLE_RUN_DEADLINE_MS = 95_000;
/** Below this much time left, no new call is started. */
export const APPLE_MIN_CALL_MS = 2_000;
/**
 * An instance Apple lists with no segment yet is retried on later runs; once
 * its processing date is this many days old it is recorded as empty, so a
 * never-ready instance can't be retried forever.
 */
export const APPLE_EMPTY_GIVE_UP_DAYS = 7;
export const APPLE_MAX_PAGES = 20;
export const APPLE_MAX_SEGMENT_BYTES = 20_000_000;
export const APPLE_MAX_UNZIPPED_BYTES = 100_000_000;
export const APPLE_MAX_ROWS_PER_INSTANCE = 1_000_000;
export const APPLE_MAX_KEYS_PER_INSTANCE = 20_000;
const MAX_LABEL = 120;

const KEY_ID = /^[A-Za-z0-9]{8,20}$/;
const ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[0-9]{1,20}$/;
const RESOURCE_ID = /^[A-Za-z0-9-]{1,200}$/;
const NUMBER = /^\d{1,15}(\.\d{1,6})?$/;

// ─── config ────────────────────────────────────────────────────────────────

export interface AppleConfig {
  privateKeyPem: string;
  keyId: string;
  issuerId: string;
  appId: string;
}

/**
 * null only when none of the four values is set (Apple "not connected yet").
 * When some are set and some are not, the config comes back with the blanks so
 * the run reports `apple_bad_config` instead of silently not connecting.
 */
export function readAppleConfig(env: Record<string, string | undefined>): AppleConfig | null {
  const privateKeyPem = env.ASC_PRIVATE_KEY ?? '';
  const keyId = env.ASC_KEY_ID?.trim() ?? '';
  const issuerId = env.ASC_ISSUER_ID?.trim() ?? '';
  const appId = env.ASC_APP_ID?.trim() ?? '';
  if (!privateKeyPem.trim() && !keyId && !issuerId && !appId) {
    return null;
  }
  return { privateKeyPem, keyId, issuerId, appId };
}

export function validateAppleConfig(config: AppleConfig): void {
  if (!KEY_ID.test(config.keyId) || !ISSUER_ID.test(config.issuerId) || !APP_ID.test(config.appId) || !config.privateKeyPem.trim()) {
    throw new LaunchSourceError('apple_bad_config');
  }
}

/** The .p8 text as pasted into Vercel: literal `\n`, or one long line, are both fine. */
export function loadApplePrivateKey(pem: string): KeyObject {
  let text = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  const body = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(text);
  if (body) {
    const base64 = body[1].replace(/\s+/g, '');
    text = `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw new LaunchSourceError('apple_bad_key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new LaunchSourceError('apple_bad_key');
  }
  return key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** ES256 (P-256, raw r||s signature) as App Store Connect requires. */
export function signAppleJwt(config: AppleConfig, nowSeconds: number): string {
  validateAppleConfig(config);
  const key = loadApplePrivateKey(config.privateKeyPem);
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const claims = {
    iss: config.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + APPLE_JWT_LIFETIME_SECONDS,
    aud: APPLE_JWT_AUDIENCE,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

// ─── time budget ──────────────────────────────────────────────────────────

/** A deadline every Apple call is checked against (and its timeout cut to). */
export interface AppleBudget {
  deadline: number;
  now: () => Date;
}

/** Thrown (internally) when the budget has run out; never stored as a code by itself. */
export class AppleBudgetExhausted extends Error {
  constructor() {
    super('apple_budget');
    this.name = 'AppleBudgetExhausted';
  }
}

/** The timeout for the next call: at most `max`, at most the time left. Throws when too little is left. */
export function callTimeout(budget: AppleBudget | undefined, max: number): number {
  if (!budget) {
    return max;
  }
  const left = budget.deadline - budget.now().getTime();
  if (left < APPLE_MIN_CALL_MS) {
    throw new AppleBudgetExhausted();
  }
  return Math.min(max, left);
}

// ─── API reads (JSON:API, paged) ───────────────────────────────────────────

async function appleGet(fetchImpl: FetchLike, token: string, url: string, budget?: AppleBudget): Promise<Record<string, unknown>> {
  const raw = await fetchJson(fetchImpl, {
    url,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    allowedHosts: [APPLE_API_HOST],
    timeoutMs: callTimeout(budget, 20_000),
    maxBytes: 2_000_000,
  });
  if (!isPlainObject(raw) || !Array.isArray(raw.data)) {
    throw new LaunchSourceError('apple_shape');
  }
  return raw;
}

/**
 * Apple's count of the whole list from one page's `meta.paging.total`, or null
 * when the page doesn't give one (`meta` and `paging` are optional in Apple's
 * documented responses, and so is `total`). A value that is there but isn't a
 * count proves nothing, so it fails closed.
 */
function pagingTotal(meta: unknown): number | null {
  if (meta === undefined || meta === null) {
    return null;
  }
  if (!isPlainObject(meta)) {
    throw new LaunchSourceError('apple_paging');
  }
  const paging = meta.paging;
  if (paging === undefined || paging === null) {
    return null;
  }
  if (!isPlainObject(paging)) {
    throw new LaunchSourceError('apple_paging');
  }
  const total = paging.total;
  if (total === undefined || total === null) {
    return null;
  }
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw new LaunchSourceError('apple_paging');
  }
  return total as number;
}

/**
 * Every item of a paged list, or a failure: a list that can't be shown to be
 * whole never reaches a caller, because a short list would be written and
 * recorded as if it were all of it, and a repeated item counted twice.
 *
 * - `links.next` must stay on Apple's API host and never repeat (`apple_shape`).
 * - Every item needs an id, and no id may appear twice in the chain
 *   (`apple_shape`, `apple_paging`).
 * - Where a page gives `meta.paging.total`, every page that gives it must agree
 *   and the chain must end with exactly that many items (`apple_paging`). A
 *   chain with no total at all is accepted: Apple's responses may omit it.
 */
export async function listAllPages(fetchImpl: FetchLike, token: string, firstUrl: string, budget?: AppleBudget): Promise<unknown[]> {
  const items: unknown[] = [];
  const seenLinks = new Set<string>();
  const seenIds = new Set<string>();
  let expectedTotal: number | null = null;
  let url = firstUrl;
  for (let page = 0; page < APPLE_MAX_PAGES; page += 1) {
    const json = await appleGet(fetchImpl, token, url, budget);
    const total = pagingTotal(json.meta);
    if (total !== null) {
      if (expectedTotal !== null && expectedTotal !== total) {
        throw new LaunchSourceError('apple_paging');
      }
      expectedTotal = total;
    }
    for (const item of json.data as unknown[]) {
      if (!isPlainObject(item) || typeof item.id !== 'string') {
        throw new LaunchSourceError('apple_shape');
      }
      if (seenIds.has(item.id)) {
        throw new LaunchSourceError('apple_paging');
      }
      seenIds.add(item.id);
      items.push(item);
    }
    if (json.links !== undefined && !isPlainObject(json.links)) {
      throw new LaunchSourceError('apple_shape');
    }
    const next = (json.links as Record<string, unknown> | undefined)?.next;
    if (next === undefined || next === null) {
      if (expectedTotal !== null && items.length !== expectedTotal) {
        throw new LaunchSourceError('apple_paging');
      }
      return items;
    }
    if (typeof next !== 'string') {
      throw new LaunchSourceError('apple_shape');
    }
    try {
      assertAllowedUrl(next, [APPLE_API_HOST]);
    } catch {
      throw new LaunchSourceError('apple_shape');
    }
    if (seenLinks.has(next)) {
      throw new LaunchSourceError('apple_shape');
    }
    seenLinks.add(next);
    url = next;
  }
  throw new LaunchSourceError('apple_too_many_pages');
}

function resource(item: unknown, type: string): { id: string; attributes: Record<string, unknown> } {
  if (!isPlainObject(item) || item.type !== type || typeof item.id !== 'string' || !RESOURCE_ID.test(item.id)) {
    throw new LaunchSourceError('apple_shape');
  }
  const attributes = item.attributes === undefined ? {} : item.attributes;
  if (!isPlainObject(attributes)) {
    throw new LaunchSourceError('apple_shape');
  }
  return { id: item.id, attributes };
}

export interface AppleReportRequest {
  id: string;
  accessType: 'ONGOING' | 'ONE_TIME_SNAPSHOT';
  stopped: boolean;
}

export function parseReportRequests(items: unknown[]): AppleReportRequest[] {
  const out: AppleReportRequest[] = [];
  for (const item of items) {
    const { id, attributes } = resource(item, 'analyticsReportRequests');
    const stopped = attributes.stoppedDueToInactivity;
    if (stopped !== undefined && stopped !== null && typeof stopped !== 'boolean') {
      throw new LaunchSourceError('apple_shape');
    }
    if (attributes.accessType === 'ONGOING' || attributes.accessType === 'ONE_TIME_SNAPSHOT') {
      out.push({ id, accessType: attributes.accessType, stopped: stopped === true });
    } else {
      throw new LaunchSourceError('apple_shape');
    }
  }
  return out;
}

/**
 * The requests to read: the running ONGOING one(s) and every snapshot. No
 * running ONGOING request is `apple_request_stopped` (Apple stopped it for
 * inactivity) or `apple_no_request` (the setup script never ran).
 */
export function pickRequests(requests: AppleReportRequest[]): AppleReportRequest[] {
  const ongoing = requests.filter((request) => request.accessType === 'ONGOING' && !request.stopped);
  if (ongoing.length === 0) {
    throw new LaunchSourceError(requests.some((request) => request.accessType === 'ONGOING') ? 'apple_request_stopped' : 'apple_no_request');
  }
  const snapshots = requests.filter((request) => request.accessType === 'ONE_TIME_SNAPSHOT');
  return [...snapshots, ...ongoing];
}

// ─── the four reports and their columns ────────────────────────────────────

export type AppleFamily = 'engagement' | 'downloads';
export type AppleVariant = 'standard' | 'detailed';

export interface AppleReportSpec {
  name: string;
  family: AppleFamily;
  variant: AppleVariant;
  /** Columns that must be present (canonical spelling). */
  required: readonly string[];
  /** Columns that may be present and are ignored. Anything else fails closed. */
  optional: readonly string[];
}

const ENGAGEMENT_COLUMNS = ['Date', 'App Apple Identifier', 'Event', 'Source Type', 'Counts', 'Unique Counts'];
const ENGAGEMENT_OPTIONAL = ['App Name', 'Page Type', 'Page Title', 'Engagement Type', 'Device', 'Platform Version', 'Territory'];
const DOWNLOAD_COLUMNS = ['Date', 'App Apple Identifier', 'Download Type', 'Source Type', 'Counts'];
const DOWNLOAD_OPTIONAL = ['App Name', 'App Version', 'Device', 'Platform Version', 'Page Type', 'Page Title', 'Pre-Order', 'Territory'];
const DETAILED_COLUMNS = ['Source Info', 'Campaign'];

/**
 * Built from Apple's documented report fields (developer.apple.com, Analytics
 * Reports: "App Store Discovery and Engagement", "App Downloads"). Not yet
 * checked against a real file: the first live run proves them, and a column
 * Apple adds or renames stops the source with `apple_tsv_header`.
 */
export const APPLE_REPORTS: readonly AppleReportSpec[] = [
  {
    name: 'App Store Discovery and Engagement Standard',
    family: 'engagement',
    variant: 'standard',
    required: ENGAGEMENT_COLUMNS,
    optional: [...ENGAGEMENT_OPTIONAL, ...DETAILED_COLUMNS],
  },
  {
    name: 'App Store Discovery and Engagement Detailed',
    family: 'engagement',
    variant: 'detailed',
    required: [...ENGAGEMENT_COLUMNS, ...DETAILED_COLUMNS],
    optional: ENGAGEMENT_OPTIONAL,
  },
  {
    name: 'App Downloads Standard',
    family: 'downloads',
    variant: 'standard',
    required: DOWNLOAD_COLUMNS,
    optional: [...DOWNLOAD_OPTIONAL, ...DETAILED_COLUMNS],
  },
  {
    name: 'App Downloads Detailed',
    family: 'downloads',
    variant: 'detailed',
    required: [...DOWNLOAD_COLUMNS, ...DETAILED_COLUMNS],
    optional: DOWNLOAD_OPTIONAL,
  },
];

/** Metrics each report writes, so a newer instance can zero what it no longer has. */
export function specMetrics(spec: AppleReportSpec): string[] {
  if (spec.family === 'engagement') {
    return spec.variant === 'standard'
      ? ['impressions', 'impressions_unique', 'product_page_views', 'product_page_views_unique']
      : ['impressions', 'product_page_views'];
  }
  return ['first_downloads', 'redownloads'];
}

/**
 * Standard reports own the day totals ('') and `source_type:` rows; Detailed
 * reports own `source_info:` and `campaign:` rows only (their totals are
 * thinned by Apple's privacy threshold, so they never write a total).
 */
export function ownsDimension(spec: AppleReportSpec, dimension: string): boolean {
  if (spec.variant === 'standard') {
    return dimension === '' || dimension.startsWith('source_type:');
  }
  return dimension.startsWith('source_info:') || dimension.startsWith('campaign:');
}

export interface AppleReport {
  id: string;
  spec: AppleReportSpec;
}

export function parseReports(items: unknown[]): { matched: AppleReport[]; total: number } {
  const matched: AppleReport[] = [];
  for (const item of items) {
    const { id, attributes } = resource(item, 'analyticsReports');
    const spec = APPLE_REPORTS.find((candidate) => candidate.name === attributes.name);
    if (spec) {
      matched.push({ id, spec });
    }
  }
  return { matched, total: items.length };
}

export interface AppleInstance {
  id: string;
  processingDate: string;
}

export function parseInstances(items: unknown[]): AppleInstance[] {
  const out: AppleInstance[] = [];
  for (const item of items) {
    const { id, attributes } = resource(item, 'analyticsReportInstances');
    if (attributes.granularity !== 'DAILY') {
      continue;
    }
    if (!isIsoDate(attributes.processingDate)) {
      throw new LaunchSourceError('apple_shape');
    }
    out.push({ id, processingDate: attributes.processingDate });
  }
  return out;
}

export interface AppleSegment {
  url: string;
  checksum: string;
  sizeInBytes: number;
}

export function parseSegments(items: unknown[]): AppleSegment[] {
  const urls = new Set<string>();
  return items.map((item) => {
    const { attributes } = resource(item, 'analyticsReportSegments');
    const { url, checksum, sizeInBytes } = attributes;
    if (typeof url !== 'string' || typeof checksum !== 'string' || !Number.isSafeInteger(sizeInBytes) || (sizeInBytes as number) < 0) {
      throw new LaunchSourceError('apple_shape');
    }
    // Two ids for one file would add its rows up twice, just like a repeated id.
    if (urls.has(url)) {
      throw new LaunchSourceError('apple_paging');
    }
    urls.add(url);
    return { url, checksum, sizeInBytes: sizeInBytes as number };
  });
}

// ─── segment download and decode ───────────────────────────────────────────

/** md5 (32 hex) or sha256 (64 hex) of the bytes as served; any other form fails closed. */
export function checksumMatches(bytes: Uint8Array, checksum: string): boolean {
  const expected = checksum.trim().toLowerCase();
  let algorithm: 'md5' | 'sha256';
  if (/^[0-9a-f]{32}$/.test(expected)) {
    algorithm = 'md5';
  } else if (/^[0-9a-f]{64}$/.test(expected)) {
    algorithm = 'sha256';
  } else {
    throw new LaunchSourceError('apple_checksum');
  }
  return createHash(algorithm).update(bytes).digest('hex') === expected;
}

/** gzip when the first two bytes say so (1f 8b); otherwise the bytes are the text. */
export function decodeSegment(bytes: Uint8Array): string {
  let raw: Uint8Array = bytes;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      raw = gunzipSync(bytes, { maxOutputLength: APPLE_MAX_UNZIPPED_BYTES });
    } catch {
      throw new LaunchSourceError('apple_gzip');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new LaunchSourceError('apple_tsv_encoding');
  }
}

export async function downloadSegment(fetchImpl: FetchLike, segment: AppleSegment, budget?: AppleBudget): Promise<string> {
  try {
    assertAllowedUrl(segment.url, [], APPLE_SEGMENT_HOST_SUFFIXES);
  } catch {
    throw new LaunchSourceError('apple_segment_host');
  }
  if (segment.sizeInBytes > APPLE_MAX_SEGMENT_BYTES) {
    throw new LaunchSourceError('apple_segment_too_large');
  }
  // A signed URL: no Authorization header, so the token never leaves Apple's API host.
  const bytes = await fetchBytes(fetchImpl, {
    url: segment.url,
    headers: { Accept: '*/*' },
    allowedHosts: [],
    allowedHostSuffixes: APPLE_SEGMENT_HOST_SUFFIXES,
    timeoutMs: callTimeout(budget, 30_000),
    maxBytes: segment.sizeInBytes,
  }).catch((error: unknown) => {
    if (error instanceof LaunchSourceError && error.code === 'too_large') {
      throw new LaunchSourceError('apple_segment_size');
    }
    throw error;
  });
  if (bytes.byteLength !== segment.sizeInBytes) {
    throw new LaunchSourceError('apple_segment_size');
  }
  if (!checksumMatches(bytes, segment.checksum)) {
    throw new LaunchSourceError('apple_checksum');
  }
  return decodeSegment(bytes);
}

// ─── TSV parse (by header name, fail closed) ───────────────────────────────

function canonical(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Rows as {canonical column: value}. Unknown, duplicate or missing columns throw. */
export function parseTsv(text: string, spec: AppleReportSpec): Array<Record<string, string>> {
  const lines = text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, ''));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    throw new LaunchSourceError('apple_tsv_header');
  }
  const known = new Map<string, string>();
  for (const name of [...spec.required, ...spec.optional]) {
    known.set(canonical(name), name);
  }
  const header = lines[0].split('\t').map(canonical);
  const seen = new Set<string>();
  for (const column of header) {
    if (!known.has(column) || seen.has(column)) {
      throw new LaunchSourceError('apple_tsv_header');
    }
    seen.add(column);
  }
  for (const name of spec.required) {
    if (!seen.has(canonical(name))) {
      throw new LaunchSourceError('apple_tsv_header');
    }
  }
  if (lines.length - 1 > APPLE_MAX_ROWS_PER_INSTANCE) {
    throw new LaunchSourceError('apple_too_many_rows');
  }
  const rows: Array<Record<string, string>> = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '') {
      continue;
    }
    const cells = lines[index].split('\t');
    if (cells.length !== header.length) {
      throw new LaunchSourceError('apple_tsv_shape');
    }
    const row: Record<string, string> = {};
    header.forEach((column, cell) => {
      row[column] = cells[cell].trim();
    });
    rows.push(row);
  }
  return rows;
}

// ─── aggregate ─────────────────────────────────────────────────────────────

const EVENT_METRIC: Record<string, string> = {
  impression: 'impressions',
  'page view': 'product_page_views',
};
const DOWNLOAD_METRIC: Record<string, string> = {
  'first-time download': 'first_downloads',
  redownload: 'redownloads',
};

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

function readCount(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 0;
  }
  if (!NUMBER.test(value)) {
    throw new LaunchSourceError('apple_tsv_number');
  }
  return Number(value);
}

export interface InstanceAggregate {
  rows: DailyMetricInput[];
  dates: string[];
  rowsParsed: number;
}

/**
 * One instance's rows (all its segments) → daily metric rows. Rows for any
 * other app are dropped. Each day the file covers gets every Standard total,
 * zero included (a zero in Apple's file is a fact); Detailed reports add only
 * `source_info:` / `campaign:` breakdowns.
 */
export function aggregateInstance(
  rows: Array<Record<string, string>>,
  spec: AppleReportSpec,
  appId: string,
  processingDate: string
): InstanceAggregate {
  const totals = new Map<string, number>();
  const dates = new Set<string>();
  const latestAllowed = addDays(processingDate, 1);
  const add = (date: string, metric: string, dimension: string, value: number) => {
    const key = `${date}\u0000${metric}\u0000${dimension}`;
    totals.set(key, (totals.get(key) ?? 0) + value);
    if (totals.size > APPLE_MAX_KEYS_PER_INSTANCE) {
      throw new LaunchSourceError('apple_too_many_rows');
    }
  };
  let rowsParsed = 0;

  for (const row of rows) {
    if (row['app apple identifier'] !== appId) {
      continue;
    }
    const date = row.date;
    if (!isIsoDate(date) || date > latestAllowed) {
      throw new LaunchSourceError('apple_tsv_date');
    }
    const counts = readCount(row.counts);
    const unique = spec.family === 'engagement' ? readCount(row['unique counts']) : 0;
    rowsParsed += 1;
    if (date < APPLE_HISTORY_START) {
      continue;
    }
    if (!dates.has(date)) {
      dates.add(date);
      if (spec.variant === 'standard') {
        for (const metric of specMetrics(spec)) {
          add(date, metric, '', 0);
        }
      }
    }
    const kind = canonical(spec.family === 'engagement' ? row.event ?? '' : row['download type'] ?? '');
    const metric = spec.family === 'engagement' ? EVENT_METRIC[kind] : DOWNLOAD_METRIC[kind];
    if (!metric) {
      continue; // other events (taps, updates, restores) aren't shown
    }
    if (spec.variant === 'standard') {
      add(date, metric, '', counts);
      if (spec.family === 'engagement') {
        add(date, `${metric}_unique`, '', unique);
      }
      const sourceType = cleanLabel(row['source type'] ?? '');
      if (sourceType) {
        add(date, metric, `source_type:${sourceType}`, counts);
      }
    } else {
      const sourceInfo = cleanLabel(row['source info'] ?? '');
      const campaign = cleanLabel(row.campaign ?? '');
      if (sourceInfo) {
        add(date, metric, `source_info:${sourceInfo}`, counts);
      }
      if (campaign) {
        add(date, metric, `campaign:${campaign}`, counts);
      }
    }
  }

  // Rows in the file but none for our app: the id is wrong or Apple spells it
  // differently. Fail closed so the instance is retried, never "read as empty".
  if (rows.length > 0 && rowsParsed === 0) {
    throw new LaunchSourceError('apple_tsv_app');
  }

  const out: DailyMetricInput[] = [];
  for (const [key, value] of totals) {
    const [metricDate, metric, dimension] = key.split('\u0000');
    out.push({
      metric_date: metricDate,
      source: 'apple',
      metric,
      dimension,
      value: Math.round(value * 100) / 100,
      variant: spec.variant,
      apple_processing_date: processingDate,
    });
  }
  return { rows: out, dates: [...dates].sort(), rowsParsed };
}

/**
 * "Latest instance wins, never merge": a key this report stored for one of
 * these days from an older-or-same processing date, and that the new instance
 * doesn't have, is written as 0 with the new processing date.
 */
export function zeroMissing(
  aggregate: InstanceAggregate,
  stored: AppleStoredKey[],
  spec: AppleReportSpec,
  processingDate: string
): DailyMetricInput[] {
  const present = new Set(aggregate.rows.map((row) => `${row.metric_date}\u0000${row.metric}\u0000${row.dimension}`));
  const days = new Set(aggregate.dates);
  const metrics = new Set(specMetrics(spec));
  const zeros: DailyMetricInput[] = [];
  for (const row of stored) {
    if (
      !days.has(row.metric_date)
      || !metrics.has(row.metric)
      || row.variant !== spec.variant
      || !ownsDimension(spec, row.dimension)
      || (row.apple_processing_date !== null && row.apple_processing_date > processingDate)
      || present.has(`${row.metric_date}\u0000${row.metric}\u0000${row.dimension}`)
    ) {
      continue;
    }
    zeros.push({
      metric_date: row.metric_date,
      source: 'apple',
      metric: row.metric,
      dimension: row.dimension,
      value: 0,
      variant: spec.variant,
      apple_processing_date: processingDate,
    });
  }
  return zeros;
}

/**
 * What one instance writes. "Latest instance wins" applies to the whole day of
 * this report: on a day where a row this report owns already carries a NEWER
 * processing date, nothing from this instance is written for that day (no
 * update, no new key, no zero), so totals and breakdowns of a day always come
 * from one instance. Other days get the instance's rows plus zeros for keys
 * an older-or-same instance stored that this one no longer has.
 */
export function planInstanceWrites(
  aggregate: InstanceAggregate,
  stored: AppleStoredKey[],
  spec: AppleReportSpec,
  processingDate: string
): { rows: DailyMetricInput[]; skippedDays: string[] } {
  const metrics = new Set(specMetrics(spec));
  const newerDays = new Set<string>();
  for (const row of stored) {
    if (
      row.variant === spec.variant
      && metrics.has(row.metric)
      && ownsDimension(spec, row.dimension)
      && row.apple_processing_date !== null
      && row.apple_processing_date > processingDate
    ) {
      newerDays.add(row.metric_date);
    }
  }
  const rows = [...aggregate.rows, ...zeroMissing(aggregate, stored, spec, processingDate)].filter(
    (row) => !newerDays.has(row.metric_date)
  );
  return { rows, skippedDays: aggregate.dates.filter((date) => newerDays.has(date)) };
}

// ─── the run ───────────────────────────────────────────────────────────────

export interface AppleSyncResult {
  instancesRead: number;
  /** Instances Apple listed with no segment yet: retried next run. */
  instancesWaiting: number;
  /** Instances not reached this run (cap or time budget): read next run. */
  instancesLeft: number;
  rowsWritten: number;
  /** Each report family's newest stored day, before and after this run. */
  dataThroughBefore: AppleDataThrough;
  dataThroughAfter: AppleDataThrough;
}

interface PendingInstance {
  report: AppleReport;
  instance: AppleInstance;
  order: number;
}

export interface AppleSyncOptions {
  /** The sync run's start (ms); Apple stops starting calls APPLE_RUN_DEADLINE_MS after it. */
  runStartedAt?: number;
}

export async function syncApple(
  config: AppleConfig,
  fetchImpl: FetchLike,
  store: LaunchStore,
  now: () => Date,
  options: AppleSyncOptions = {}
): Promise<AppleSyncResult> {
  const started = now().getTime();
  const budget: AppleBudget = {
    deadline: Math.min(started + APPLE_TIME_BUDGET_MS, (options.runStartedAt ?? started) + APPLE_RUN_DEADLINE_MS),
    now,
  };
  const token = signAppleJwt(config, Math.floor(started / 1000));
  const dataThroughBefore = await store.appleDataThrough();
  // Running out of time while listing leaves nothing safe to read: a code.
  const listing = async (url: string) => {
    try {
      return await listAllPages(fetchImpl, token, url, budget);
    } catch (error) {
      if (error instanceof AppleBudgetExhausted) {
        throw new LaunchSourceError('apple_timeout');
      }
      throw error;
    }
  };

  const requestsUrl = `${API}/v1/apps/${encodeURIComponent(config.appId)}/analyticsReportRequests?${new URLSearchParams({
    'fields[analyticsReportRequests]': 'accessType,stoppedDueToInactivity',
    limit: '200',
  })}`;
  const requests = pickRequests(parseReportRequests(await listing(requestsUrl)));

  const pending: PendingInstance[] = [];
  let reportsListed = 0;
  let reportsMatched = 0;
  for (const [order, request] of requests.entries()) {
    const reportsUrl = `${API}/v1/analyticsReportRequests/${encodeURIComponent(request.id)}/reports?limit=200`;
    const { matched, total } = parseReports(await listing(reportsUrl));
    reportsListed += total;
    reportsMatched += matched.length;
    for (const report of matched) {
      const instancesUrl = `${API}/v1/analyticsReports/${encodeURIComponent(report.id)}/instances?${new URLSearchParams({
        'filter[granularity]': 'DAILY',
        limit: '200',
      })}`;
      for (const instance of parseInstances(await listing(instancesUrl))) {
        pending.push({ report, instance, order });
      }
    }
  }
  // Apple lists reports but none of ours: their names changed. Nothing listed
  // at all is normal for the first day or two after the request is made.
  if (reportsListed > 0 && reportsMatched === 0) {
    throw new LaunchSourceError('apple_reports_missing');
  }

  const unique = new Map<string, PendingInstance>();
  for (const entry of pending) {
    if (!unique.has(entry.instance.id)) {
      unique.set(entry.instance.id, entry);
    }
  }
  const known = await store.knownAppleInstances([...unique.keys()]);
  // Oldest processing date first (snapshot before ongoing on a tie), so the
  // newest instance is the last one written for any day.
  const todo = [...unique.values()]
    .filter((entry) => !known.has(entry.instance.id))
    .sort(
      (a, b) =>
        a.instance.processingDate.localeCompare(b.instance.processingDate)
        || a.order - b.order
        || a.instance.id.localeCompare(b.instance.id)
    );

  const giveUpBefore = addDays(new Date(started).toISOString().slice(0, 10), -APPLE_EMPTY_GIVE_UP_DAYS);
  let attempted = 0;
  let instancesRead = 0;
  let instancesWaiting = 0;
  let rowsWritten = 0;
  let cutShort = false;
  for (const entry of todo) {
    if (attempted >= APPLE_MAX_INSTANCES_PER_RUN) {
      break;
    }
    attempted += 1;
    const { report, instance } = entry;
    const record = (segmentCount: number, rowsParsed: number) =>
      store.recordAppleInstance({
        instance_id: instance.id,
        report_name: report.spec.name,
        granularity: 'DAILY',
        processing_date: instance.processingDate,
        segment_count: segmentCount,
        rows_parsed: rowsParsed,
        fetched_at: now().toISOString(),
      });
    let rows: Array<Record<string, string>>;
    let segmentCount: number;
    try {
      const segmentsUrl = `${API}/v1/analyticsReportInstances/${encodeURIComponent(instance.id)}/segments?limit=200`;
      const segments = parseSegments(await listAllPages(fetchImpl, token, segmentsUrl, budget));
      segmentCount = segments.length;
      if (segments.length === 0) {
        // Listed before its file exists: not read yet. Retried next run, until
        // it is old enough that Apple clearly has nothing for it.
        if (instance.processingDate < giveUpBefore) {
          await record(0, 0);
        } else {
          instancesWaiting += 1;
        }
        continue;
      }
      rows = [];
      for (const segment of segments) {
        const parsed = parseTsv(await downloadSegment(fetchImpl, segment, budget), report.spec);
        for (const row of parsed) {
          rows.push(row);
        }
        if (rows.length > APPLE_MAX_ROWS_PER_INSTANCE) {
          throw new LaunchSourceError('apple_too_many_rows');
        }
      }
    } catch (error) {
      if (error instanceof AppleBudgetExhausted) {
        // Out of time mid-instance: nothing of it is written or recorded; the
        // next run starts it again.
        attempted -= 1;
        cutShort = true;
        break;
      }
      throw error;
    }
    const aggregate = aggregateInstance(rows, report.spec, config.appId, instance.processingDate);
    const stored = aggregate.dates.length > 0 ? await store.appleRowsFor(aggregate.dates) : [];
    const { rows: writes } = planInstanceWrites(aggregate, stored, report.spec, instance.processingDate);
    if (writes.length > 0) {
      await store.upsertDaily(writes);
    }
    await record(segmentCount, aggregate.rowsParsed);
    instancesRead += 1;
    rowsWritten += writes.length;
  }

  // The time ran out before a single instance could be read: say so, or a
  // too-slow instance would look "updated" every morning while nothing moves.
  if (cutShort && instancesRead === 0) {
    throw new LaunchSourceError('apple_timeout');
  }

  return {
    instancesRead,
    instancesWaiting,
    instancesLeft: todo.length - attempted,
    rowsWritten,
    dataThroughBefore,
    dataThroughAfter: await store.appleDataThrough(),
  };
}
