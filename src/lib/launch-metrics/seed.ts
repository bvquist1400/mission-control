/**
 * Seed import (piece 9): turns the hand-kept dashboard CSVs into launch rows.
 *
 * signups.csv becomes COUNTS ONLY: new accounts per New York day by sign-in
 * method and who (real / family; internal rows are skipped), plus a running
 * total per day. Its `account` column is never read, so no id reaches a row,
 * a log line or the database. plus.csv becomes as-of Plus counts (households).
 * reddit.csv, milestones.csv and app_store.csv become their own tables.
 * Every app-database row is marked variant 'seed'; the live sync overwrites
 * the same day with real numbers.
 */

import { dateRange, etLocalToIso, isIsoDate, LAUNCH_RELEASE_DATE } from './dates';
import type { DailyMetricInput, LaunchMilestoneKind } from './types';

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** RFC 4180-ish: commas, double quotes, "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new SeedError('unclosed quote');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Rows as objects keyed by the header; checks the header names exactly. */
function readTable(text: string, file: string, required: string[]): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) {
    throw new SeedError(`${file}: empty`);
  }
  const names = header.map((name) => name.trim());
  for (const name of required) {
    if (!names.includes(name)) {
      throw new SeedError(`${file}: missing column ${name}`);
    }
  }
  return rows.map((cells, rowIndex) => {
    if (cells.length !== names.length) {
      throw new SeedError(`${file}: row ${rowIndex + 2} has ${cells.length} cells, expected ${names.length}`);
    }
    const record: Record<string, string> = {};
    names.forEach((name, index) => {
      if (required.includes(name)) record[name] = cells[index].trim();
    });
    return record;
  });
}

function etTime(value: string, file: string, row: number): string {
  const iso = etLocalToIso(value);
  if (!iso) {
    throw new SeedError(`${file}: row ${row}: not a New York date and time (YYYY-MM-DD HH:MM)`);
  }
  return iso;
}

function count(value: string, file: string, row: number, column: string, allowEmpty = false, allowNegative = false): number | null {
  if (value === '' && allowEmpty) return null;
  if (!/^-?\d{1,9}$/.test(value) || (!allowNegative && value.startsWith('-'))) {
    throw new SeedError(`${file}: row ${row}: ${column} must be a whole number`);
  }
  return Number(value);
}

export interface SignupCounts {
  date: string;
  real: number;
  apple: number;
  email: number;
  family: number;
}

/** signups.csv → per-day counts. The `account` column is not in the read set. */
export function signupCounts(text: string): { days: SignupCounts[]; skippedInternal: number } {
  const rows = readTable(text, 'signups.csv', ['signed_up_et', 'sign_in', 'who']);
  const byDay = new Map<string, SignupCounts>();
  let skippedInternal = 0;
  rows.forEach((row, index) => {
    etTime(row.signed_up_et, 'signups.csv', index + 2); // validates; only the ET date is kept
    const date = row.signed_up_et.slice(0, 10);
    const day = byDay.get(date) ?? { date, real: 0, apple: 0, email: 0, family: 0 };
    if (row.who === 'Real user') {
      day.real += 1;
      if (row.sign_in === 'Apple') day.apple += 1;
      else if (row.sign_in === 'Email') day.email += 1;
      else throw new SeedError(`signups.csv: row ${index + 2}: sign_in must be Apple or Email`);
    } else if (row.who === 'Family') {
      day.family += 1;
    } else if (row.who === 'Internal') {
      skippedInternal += 1;
      return;
    } else {
      throw new SeedError(`signups.csv: row ${index + 2}: who must be Real user, Family or Internal`);
    }
    byDay.set(date, day);
  });
  return { days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)), skippedInternal };
}

export function signupRows(days: SignupCounts[]): DailyMetricInput[] {
  const rows: DailyMetricInput[] = [];
  if (days.length === 0) return rows;
  const seed = { source: 'app_db' as const, dimension: '', variant: 'seed' as const };
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = days[0].date < LAUNCH_RELEASE_DATE ? days[0].date : LAUNCH_RELEASE_DATE;
  const last = days[days.length - 1].date;
  let real = 0;
  let apple = 0;
  let email = 0;
  let family = 0;
  for (const date of dateRange(first, last)) {
    const day = byDate.get(date) ?? { date, real: 0, apple: 0, email: 0, family: 0 };
    real += day.real;
    apple += day.apple;
    email += day.email;
    family += day.family;
    rows.push(
      { ...seed, metric_date: date, metric: 'signups_real', value: day.real },
      { ...seed, metric_date: date, metric: 'signups_apple', value: day.apple },
      { ...seed, metric_date: date, metric: 'signups_email', value: day.email },
      { ...seed, metric_date: date, metric: 'signups_family', value: day.family },
      { ...seed, metric_date: date, metric: 'total_real_users', value: real },
      { ...seed, metric_date: date, metric: 'total_real_apple', value: apple },
      { ...seed, metric_date: date, metric: 'total_real_email', value: email },
      { ...seed, metric_date: date, metric: 'total_family_accounts', value: family }
    );
  }
  return rows;
}

export function plusRows(text: string): DailyMetricInput[] {
  const rows = readTable(text, 'plus.csv', ['as_of', 'trial', 'paid', 'comp']);
  return rows.flatMap((row, index) => {
    if (!isIsoDate(row.as_of)) {
      throw new SeedError(`plus.csv: row ${index + 2}: as_of must be YYYY-MM-DD`);
    }
    const base = { metric_date: row.as_of, source: 'app_db' as const, dimension: '', variant: 'seed' as const };
    return [
      { ...base, metric: 'total_plus_trial', value: count(row.trial, 'plus.csv', index + 2, 'trial') as number },
      { ...base, metric: 'total_plus_paid', value: count(row.paid, 'plus.csv', index + 2, 'paid') as number },
      { ...base, metric: 'total_plus_comp', value: count(row.comp, 'plus.csv', index + 2, 'comp') as number },
    ];
  });
}

export interface SeedRedditPost {
  label: string;
  subreddit: string;
  posted_at: string;
  views: number | null;
  upvotes: number | null;
  comments: number | null;
  stats_as_of: string | null;
}

export function redditPosts(text: string): SeedRedditPost[] {
  const rows = readTable(text, 'reddit.csv', ['post', 'subreddit', 'posted_et', 'views', 'upvotes', 'comments', 'stats_as_of']);
  return rows.map((row, index) => {
    const line = index + 2;
    if (!/^r\/[A-Za-z0-9_]{2,21}$/.test(row.subreddit)) {
      throw new SeedError(`reddit.csv: row ${line}: subreddit must look like r/apps`);
    }
    if (row.post.length === 0 || row.post.length > 200) {
      throw new SeedError(`reddit.csv: row ${line}: post must be 1–200 characters`);
    }
    return {
      label: row.post,
      subreddit: row.subreddit,
      posted_at: etTime(row.posted_et, 'reddit.csv', line),
      views: count(row.views, 'reddit.csv', line, 'views', true),
      upvotes: count(row.upvotes, 'reddit.csv', line, 'upvotes', true, true),
      comments: count(row.comments, 'reddit.csv', line, 'comments', true),
      stats_as_of: row.stats_as_of ? etTime(row.stats_as_of, 'reddit.csv', line) : null,
    };
  });
}

const KINDS: LaunchMilestoneKind[] = ['Release', 'Tracking', 'Users', 'Marketing', 'Feedback', 'Other'];

export interface SeedMilestone {
  happened_at: string;
  label: string;
  kind: LaunchMilestoneKind;
}

export function milestones(text: string): SeedMilestone[] {
  const rows = readTable(text, 'milestones.csv', ['when_et', 'event', 'kind']);
  return rows.map((row, index) => {
    const line = index + 2;
    if (row.event.length === 0 || row.event.length > 200) {
      throw new SeedError(`milestones.csv: row ${line}: event must be 1–200 characters`);
    }
    return {
      happened_at: etTime(row.when_et, 'milestones.csv', line),
      label: row.event,
      kind: KINDS.includes(row.kind as LaunchMilestoneKind) ? (row.kind as LaunchMilestoneKind) : 'Other',
    };
  });
}

export interface SeedManualRead {
  read_on: string;
  data_through: string;
  window_label: string;
  impressions: number;
  product_page_views: number;
  first_downloads: number;
}

export function appStoreReads(text: string): SeedManualRead[] {
  const rows = readTable(text, 'app_store.csv', ['read_on', 'data_through', 'window', 'impressions', 'product_page_views', 'first_downloads']);
  return rows.map((row, index) => {
    const line = index + 2;
    if (!isIsoDate(row.read_on) || !isIsoDate(row.data_through)) {
      throw new SeedError(`app_store.csv: row ${line}: dates must be YYYY-MM-DD`);
    }
    if (row.window.length === 0 || row.window.length > 80) {
      throw new SeedError(`app_store.csv: row ${line}: window must be 1–80 characters`);
    }
    return {
      read_on: row.read_on,
      data_through: row.data_through,
      window_label: row.window,
      impressions: count(row.impressions, 'app_store.csv', line, 'impressions') as number,
      product_page_views: count(row.product_page_views, 'app_store.csv', line, 'product_page_views') as number,
      first_downloads: count(row.first_downloads, 'app_store.csv', line, 'first_downloads') as number,
    };
  });
}

export interface SeedPlan {
  daily: DailyMetricInput[];
  reddit: SeedRedditPost[];
  milestones: SeedMilestone[];
  manualReads: SeedManualRead[];
  signupDays: SignupCounts[];
  skippedInternal: number;
}

/** files: the CSV texts by name; a missing file is simply not imported. */
export function buildSeedPlan(files: Partial<Record<'signups.csv' | 'plus.csv' | 'reddit.csv' | 'milestones.csv' | 'app_store.csv', string>>): SeedPlan {
  const signups = files['signups.csv'] ? signupCounts(files['signups.csv']) : { days: [], skippedInternal: 0 };
  return {
    daily: [...signupRows(signups.days), ...(files['plus.csv'] ? plusRows(files['plus.csv']) : [])],
    reddit: files['reddit.csv'] ? redditPosts(files['reddit.csv']) : [],
    milestones: files['milestones.csv'] ? milestones(files['milestones.csv']) : [],
    manualReads: files['app_store.csv'] ? appStoreReads(files['app_store.csv']) : [],
    signupDays: signups.days,
    skippedInternal: signups.skippedInternal,
  };
}
