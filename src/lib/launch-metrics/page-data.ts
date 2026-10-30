/**
 * The Launch page's data (piece 8): one loader that reads only what Baseline
 * has stored (no live calls to any source from the page), and a pure builder
 * that turns it into what each section shows. Counts only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase.generated';
import { appDbHasRows, latestTotals, type AppDbTotalsView } from './page-totals';
import { addDays, dateRange, etDate, LAUNCH_RELEASE_DATE, WEBSITE_TRACKING_START_DATE } from './dates';
import { readRunSources, type RunRecord } from './store';
import { APPLE_FAMILY_TOTALS, isRunUnfinished, sourceHealth, tokenDaysLeft, type SourceHealth } from './stale';
import type {
  LaunchAppStoreManualRead,
  LaunchMetricSource,
  LaunchMilestone,
  LaunchMilestoneKind,
  LaunchRedditPost,
  LaunchRunKind,
  LaunchRunStatus,
  LaunchRunTrigger,
} from './types';
import type { TopEntry } from './search-console';

export interface DailyValue {
  metric_date: string;
  source: LaunchMetricSource;
  metric: string;
  dimension: string;
  value: number;
}

export interface LaunchPageInput {
  daily: DailyValue[];
  searchTop: { since: string; until: string; top_queries: TopEntry[]; top_pages: TopEntry[] } | null;
  runs: RunRecord[];
  reddit: LaunchRedditPost[];
  milestones: LaunchMilestone[];
  manualReads: LaunchAppStoreManualRead[];
  tokenExpires: string | null;
}

const PAGE = 1000;
const MAX_ROWS = 20_000;

async function readDaily(supabase: SupabaseClient<Database>, userId: string): Promise<DailyValue[]> {
  const out: DailyValue[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('launch_metric_daily')
      .select('metric_date, source, metric, dimension, value')
      .eq('user_id', userId)
      .gte('metric_date', addDays(LAUNCH_RELEASE_DATE, -7))
      .order('metric_date', { ascending: true })
      .order('source', { ascending: true })
      .order('metric', { ascending: true })
      .order('dimension', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error('launch_daily_read_failed');
    }
    for (const row of data ?? []) {
      out.push({ ...row, source: row.source as LaunchMetricSource, value: Number(row.value) });
    }
    if (!data || data.length < PAGE) {
      break;
    }
  }
  return out;
}

function readTopEntries(value: unknown): TopEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      label: typeof entry.label === 'string' ? entry.label.slice(0, 120) : '',
      clicks: Number(entry.clicks) || 0,
      impressions: Number(entry.impressions) || 0,
      position: Number(entry.position) || 0,
    }))
    .filter((entry) => entry.label.length > 0)
    .slice(0, 10);
}

export async function loadLaunchPageInput(
  supabase: SupabaseClient<Database>,
  userId: string,
  tokenExpires: string | null
): Promise<LaunchPageInput> {
  const [daily, top, runs, reddit, milestones, manualReads] = await Promise.all([
    readDaily(supabase, userId),
    supabase
      .from('launch_source_snapshots')
      .select('payload')
      .eq('user_id', userId)
      .eq('source', 'search_console')
      .order('as_of_date', { ascending: false })
      .limit(1),
    supabase
      .from('launch_metric_runs')
      .select('id, trigger, kind, started_at, finished_at, status, sources')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(100),
    supabase.from('launch_reddit_posts').select('*').eq('user_id', userId).order('posted_at', { ascending: false }).limit(200),
    supabase.from('launch_milestones').select('*').eq('user_id', userId).order('happened_at', { ascending: true }).limit(500),
    supabase.from('launch_app_store_manual_reads').select('*').eq('user_id', userId).order('read_on', { ascending: false }).limit(50),
  ]);

  for (const result of [top, runs, reddit, milestones, manualReads]) {
    if (result.error) {
      throw new Error('launch_page_read_failed');
    }
  }

  const payload = top.data?.[0]?.payload as Record<string, unknown> | undefined;
  const searchTop =
    payload && typeof payload === 'object'
      ? {
          since: typeof payload.since === 'string' ? payload.since : '',
          until: typeof payload.until === 'string' ? payload.until : '',
          top_queries: readTopEntries(payload.top_queries),
          top_pages: readTopEntries(payload.top_pages),
        }
      : null;

  return {
    daily,
    searchTop,
    runs: (runs.data ?? []).map((row) => ({
      id: row.id,
      trigger: row.trigger as LaunchRunTrigger,
      kind: row.kind as LaunchRunKind,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status as LaunchRunStatus,
      sources: readRunSources(row.sources),
    })),
    reddit: (reddit.data ?? []) as LaunchRedditPost[],
    milestones: (milestones.data ?? []) as LaunchMilestone[],
    manualReads: (manualReads.data ?? []) as LaunchAppStoreManualRead[],
    tokenExpires,
  };
}

// ─── the pure builder ─────────────────────────────────────────────────────

export interface SignupDay {
  date: string;
  real: number;
  apple: number;
  email: number;
  /** Included in `real`: accounts deleted later still count on their sign-up day. */
  deleted: number;
  /** null = no unconfirmed number stored for that day (seeded days). */
  unconfirmed: number | null;
  family: number;
  totalReal: number | null;
}

export interface WebDay {
  date: string;
  visitors: number;
  pageviews: number;
  taps: number;
}

export interface SearchDay {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface NamedCount {
  label: string;
  value: number;
  secondary?: number;
}

/** null = Apple hasn't sent that report for that day yet ("no data yet", never 0). */
export interface AppStoreDay {
  date: string;
  impressions: number | null;
  pageViews: number | null;
  firstDownloads: number | null;
  redownloads: number | null;
}

/** null = that report has covered no day yet (a dash); a 0 is a real 0. */
export interface AppStoreSourceRow {
  label: string;
  impressions: number | null;
  pageViews: number | null;
  firstDownloads: number | null;
  redownloads: number | null;
}

/**
 * A Detailed-report group. null = no row for that number: Apple hides groups
 * under 5 people, so a missing row is "not shown", never 0.
 */
export interface AppStoreDetailedRow {
  label: string;
  firstDownloads: number | null;
  pageViews: number | null;
}

/** The report days a headline adds up: first to last covered day, and how many of them are covered. */
export interface HeadlineWindow {
  since: string;
  until: string;
  days: number;
  spanDays: number;
}

export interface AppStoreView {
  hasData: boolean;
  /** Apple's report days from release to the newest day either report covers. */
  days: AppStoreDay[];
  /** The newest day of either report family. */
  dataThrough: string | null;
  /** Newest day of the engagement report (impressions, page views) and of the downloads report. */
  engagementThrough: string | null;
  downloadsThrough: string | null;
  /**
   * Each family's headline covers its own newest 30 report days, so one report
   * running behind never holds the other's numbers back or blanks them. Null
   * = that family has covered no day, and its headlines are null (a dash).
   */
  downloadsWindow: HeadlineWindow | null;
  engagementWindow: HeadlineWindow | null;
  /** The newest 30 report days covered by BOTH families; null when they share none. */
  conversionWindow: HeadlineWindow | null;
  impressions: number | null;
  pageViews: number | null;
  pageViewsUnique: number | null;
  firstDownloads: number | null;
  redownloads: number | null;
  /** First-time downloads ÷ unique product page views over `conversionWindow`; null without one or without unique views. */
  conversion: number | null;
  /** Since release, Standard reports. */
  sourceTypes: AppStoreSourceRow[];
  /** Since release, Detailed reports (Apple drops groups under 5 people, so often empty). */
  sourceInfo: AppStoreDetailedRow[];
  campaigns: AppStoreDetailedRow[];
}

/** Days in the App Store headline window. */
export const APP_STORE_WINDOW_DAYS = 30;

export interface MilestoneMarker {
  date: string;
  label: string;
  kind: LaunchMilestoneKind;
  /** The stored instant, for the New York clock time in the chart's event key. */
  happenedAt: string;
}

export interface LaunchView {
  today: string;
  totals: AppDbTotalsView | null;
  signups: { days: SignupDay[]; hasData: boolean };
  website: {
    days: WebDay[];
    hasData: boolean;
    visitorsSum: number;
    pageviewsSum: number;
    tapsSum: number;
    /** First UTC day with website tracking; days before it are "not tracked yet", not zero. */
    trackingSince: string;
    referrers: NamedCount[];
    referrerWindow: { since: string; until: string } | null;
    placements: NamedCount[];
  };
  search: {
    days: SearchDay[];
    hasData: boolean;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    dataThrough: string | null;
    topQueries: TopEntry[];
    topPages: TopEntry[];
    topWindow: { since: string; until: string } | null;
  };
  appStore: AppStoreView;
  markers: MilestoneMarker[];
  health: SourceHealth[];
  lastRun: { started_at: string; status: string; trigger: string; unfinished: boolean } | null;
  tokenDaysLeft: number | null;
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function byKey(daily: DailyValue[], source: LaunchMetricSource) {
  const map = new Map<string, number>();
  for (const row of daily) {
    if (row.source === source) {
      map.set(`${row.metric_date}|${row.metric}|${row.dimension}`, row.value);
    }
  }
  return (date: string, metric: string, dimension = '') => map.get(`${date}|${metric}|${dimension}`) ?? 0;
}

function topDimensions(daily: DailyValue[], source: LaunchMetricSource, metric: string, prefix: string, since: string, until: string, secondaryMetric?: string): NamedCount[] {
  const totals = new Map<string, NamedCount>();
  for (const row of daily) {
    if (row.source !== source || !row.dimension.startsWith(prefix) || row.metric_date < since || row.metric_date > until) {
      continue;
    }
    const label = row.dimension.slice(prefix.length);
    const entry = totals.get(label) ?? { label, value: 0, secondary: secondaryMetric ? 0 : undefined };
    if (row.metric === metric) {
      entry.value += row.value;
    } else if (secondaryMetric && row.metric === secondaryMetric) {
      entry.secondary = (entry.secondary ?? 0) + row.value;
    } else {
      continue;
    }
    totals.set(label, entry);
  }
  return [...totals.values()].filter((entry) => entry.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 10);
}

function appStoreSourceRows(daily: DailyValue[], totals: DailyValue[]): AppStoreSourceRow[] {
  const prefix = 'source_type:';
  const metrics = { impressions: 'impressions', pageViews: 'product_page_views', firstDownloads: 'first_downloads', redownloads: 'redownloads' } as const;
  const fields = Object.keys(metrics) as Array<keyof typeof metrics>;
  // A Standard report's day totals are the sum of its source rows, so on a
  // covered day a source with no row really had none: 0. A metric no day
  // covers isn't known for any source: null.
  const known = (metric: string) => totals.some((row) => row.metric === metric);
  const blank = () => Object.fromEntries(fields.map((field) => [field, known(metrics[field]) ? 0 : null])) as Omit<AppStoreSourceRow, 'label'>;
  const rows = new Map<string, AppStoreSourceRow>();
  for (const row of daily) {
    if (row.source !== 'apple' || !row.dimension.startsWith(prefix) || row.metric_date < LAUNCH_RELEASE_DATE) {
      continue;
    }
    const field = fields.find((candidate) => metrics[candidate] === row.metric);
    if (!field) {
      continue;
    }
    const label = row.dimension.slice(prefix.length);
    const entry = rows.get(label) ?? { label, ...blank() };
    entry[field] = (entry[field] ?? 0) + row.value;
    rows.set(label, entry);
  }
  const n = (value: number | null) => value ?? 0;
  return [...rows.values()]
    .filter((entry) => n(entry.impressions) + n(entry.pageViews) + n(entry.firstDownloads) + n(entry.redownloads) > 0)
    .sort(
      (a, b) =>
        n(b.firstDownloads) - n(a.firstDownloads) || n(b.pageViews) - n(a.pageViews) || n(b.impressions) - n(a.impressions) || a.label.localeCompare(b.label)
    );
}

function appStoreDetailedRows(daily: DailyValue[], prefix: string, until: string): AppStoreDetailedRow[] {
  const rows = new Map<string, AppStoreDetailedRow>();
  for (const row of daily) {
    if (row.source !== 'apple' || !row.dimension.startsWith(prefix) || row.metric_date < LAUNCH_RELEASE_DATE || row.metric_date > until) {
      continue;
    }
    const field = row.metric === 'first_downloads' ? 'firstDownloads' : row.metric === 'product_page_views' ? 'pageViews' : null;
    if (!field) {
      continue;
    }
    const label = row.dimension.slice(prefix.length);
    const entry = rows.get(label) ?? { label, firstDownloads: null, pageViews: null };
    entry[field] = (entry[field] ?? 0) + row.value;
    rows.set(label, entry);
  }
  const n = (value: number | null) => value ?? 0;
  return [...rows.values()]
    .filter((entry) => n(entry.firstDownloads) + n(entry.pageViews) > 0)
    .sort((a, b) => n(b.firstDownloads) - n(a.firstDownloads) || n(b.pageViews) - n(a.pageViews) || a.label.localeCompare(b.label))
    .slice(0, 10);
}

/** The covered days inside the 30 report days ending at the newest of them; null when there are none. */
function headlineWindow(covered: Set<string>): { dates: string[]; window: HeadlineWindow } | null {
  const sorted = [...covered].sort();
  const until = sorted[sorted.length - 1];
  if (!until) {
    return null;
  }
  const start = addDays(until, -(APP_STORE_WINDOW_DAYS - 1));
  const dates = sorted.filter((date) => date >= start);
  const since = dates[0];
  return { dates, window: { since, until, days: dates.length, spanDays: dateRange(since, until).length } };
}

export function buildAppStoreView(daily: DailyValue[]): AppStoreView {
  const totals = daily.filter((row) => row.source === 'apple' && row.dimension === '' && row.metric_date >= LAUNCH_RELEASE_DATE);
  // A number is known only if its row is stored. A Standard report writes
  // every total for every day its file covers, zero included, so a stored 0 is
  // a real 0 and a missing row means Apple hasn't covered that day.
  const stored = new Map(totals.map((row) => [`${row.metric_date}|${row.metric}`, row.value]));
  const cell = (date: string, metric: string) => stored.get(`${date}|${metric}`) ?? null;
  const covered = (metrics: readonly string[]) => new Set(totals.filter((row) => metrics.includes(row.metric)).map((row) => row.metric_date));
  const engagementDays = covered(APPLE_FAMILY_TOTALS.engagement);
  const downloadDays = covered(APPLE_FAMILY_TOTALS.downloads);
  const latest = (days: Set<string>) => (days.size ? [...days].sort()[days.size - 1] : null);
  const engagementThrough = latest(engagementDays);
  const downloadsThrough = latest(downloadDays);
  const throughs = [engagementThrough, downloadsThrough].filter((date): date is string => date !== null).sort();
  const dataThrough = throughs.length ? throughs[throughs.length - 1] : null;

  const days: AppStoreDay[] = dataThrough
    ? dateRange(LAUNCH_RELEASE_DATE, dataThrough).map((date) => ({
        date,
        impressions: cell(date, 'impressions'),
        pageViews: cell(date, 'product_page_views'),
        firstDownloads: cell(date, 'first_downloads'),
        redownloads: cell(date, 'redownloads'),
      }))
    : [];

  // Every total of a headline: the rows it has in the window, null with none.
  const sum = (dates: string[] | undefined, metric: string) => {
    const values = (dates ?? []).map((date) => cell(date, metric)).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const downloads = headlineWindow(downloadDays);
  const engagement = headlineWindow(engagementDays);
  // Conversion needs both numbers on the same day, or one report's downloads
  // would be divided by another day's page views.
  const shared = headlineWindow(
    new Set(totals.filter((row) => row.metric === 'first_downloads' && cell(row.metric_date, 'product_page_views_unique') !== null).map((row) => row.metric_date))
  );
  const sharedDownloads = sum(shared?.dates, 'first_downloads');
  const sharedUnique = sum(shared?.dates, 'product_page_views_unique');
  const detailedUntil = dataThrough ?? LAUNCH_RELEASE_DATE;

  return {
    hasData: totals.length > 0,
    days,
    dataThrough,
    engagementThrough,
    downloadsThrough,
    downloadsWindow: downloads?.window ?? null,
    engagementWindow: engagement?.window ?? null,
    conversionWindow: shared?.window ?? null,
    impressions: sum(engagement?.dates, 'impressions'),
    pageViews: sum(engagement?.dates, 'product_page_views'),
    pageViewsUnique: sum(engagement?.dates, 'product_page_views_unique'),
    firstDownloads: sum(downloads?.dates, 'first_downloads'),
    redownloads: sum(downloads?.dates, 'redownloads'),
    conversion: sharedDownloads !== null && sharedUnique ? sharedDownloads / sharedUnique : null,
    sourceTypes: appStoreSourceRows(daily, totals),
    sourceInfo: appStoreDetailedRows(daily, 'source_info:', detailedUntil),
    campaigns: appStoreDetailedRows(daily, 'campaign:', detailedUntil),
  };
}

export function buildLaunchView(input: LaunchPageInput, now: Date): LaunchView {
  const today = etDate(now);
  const utcToday = now.toISOString().slice(0, 10);
  const days = dateRange(LAUNCH_RELEASE_DATE, today);

  // Sign-ups (ET days).
  const app = byKey(input.daily, 'app_db');
  const hasApp = (date: string, metric: string) =>
    input.daily.some((row) => row.source === 'app_db' && row.metric_date === date && row.metric === metric && row.dimension === '');
  const signupDays: SignupDay[] = days.map((date) => ({
    date,
    real: app(date, 'signups_real'),
    apple: app(date, 'signups_apple'),
    email: app(date, 'signups_email'),
    deleted: app(date, 'signups_deleted'),
    unconfirmed: hasApp(date, 'signups_unconfirmed') ? app(date, 'signups_unconfirmed') : null,
    family: app(date, 'signups_family'),
    totalReal: hasApp(date, 'total_real_users') ? app(date, 'total_real_users') : null,
  }));

  // Website (UTC days).
  const webDates = dateRange(LAUNCH_RELEASE_DATE, utcToday);
  const webGet = byKey(input.daily, 'web');
  const webDays: WebDay[] = webDates.map((date) => ({
    date,
    visitors: webGet(date, 'visitors'),
    pageviews: webGet(date, 'pageviews'),
    taps: webGet(date, 'app_store_taps'),
  }));
  // Tracking start: the known go-live day, or an earlier day that has a stored number.
  const firstWebDay = webDays.find((day) => day.visitors > 0 || day.pageviews > 0 || day.taps > 0)?.date ?? null;
  const trackingSince = firstWebDay && firstWebDay < WEBSITE_TRACKING_START_DATE ? firstWebDay : WEBSITE_TRACKING_START_DATE;
  const referrerSince = addDays(utcToday, -6) < LAUNCH_RELEASE_DATE ? LAUNCH_RELEASE_DATE : addDays(utcToday, -6);

  // Search Console (Pacific days, lags 2–3 days).
  const searchRows = input.daily.filter((row) => row.source === 'search_console' && row.dimension === '');
  const searchDates = [...new Set(searchRows.map((row) => row.metric_date))].sort();
  const searchGet = byKey(input.daily, 'search_console');
  const searchDays: SearchDay[] = searchDates.length
    ? dateRange(LAUNCH_RELEASE_DATE, searchDates[searchDates.length - 1]).map((date) => ({
        date,
        clicks: searchGet(date, 'clicks'),
        impressions: searchGet(date, 'impressions'),
        position: searchDates.includes(date) && searchGet(date, 'impressions') > 0 ? searchGet(date, 'position') : null,
      }))
    : [];
  const clicks = sumBy(searchDays, (day) => day.clicks);
  const impressions = sumBy(searchDays, (day) => day.impressions);
  const weightedPosition = sumBy(searchDays, (day) => (day.position ?? 0) * day.impressions);

  const lastRunRecord = input.runs[0] ?? null;
  const appStore = buildAppStoreView(input.daily);

  return {
    today,
    totals: appDbHasRows(input.daily) ? latestTotals(input.daily) : null,
    signups: { days: signupDays, hasData: input.daily.some((row) => row.source === 'app_db') },
    website: {
      days: webDays,
      hasData: input.daily.some((row) => row.source === 'web'),
      visitorsSum: sumBy(webDays, (day) => day.visitors),
      pageviewsSum: sumBy(webDays, (day) => day.pageviews),
      tapsSum: sumBy(webDays, (day) => day.taps),
      trackingSince,
      referrers: topDimensions(input.daily, 'web', 'pageviews', 'referrer:', referrerSince, utcToday, 'visitors'),
      referrerWindow: { since: referrerSince, until: utcToday },
      placements: topDimensions(input.daily, 'web', 'app_store_taps', 'placement:', LAUNCH_RELEASE_DATE, utcToday),
    },
    search: {
      days: searchDays,
      hasData: searchRows.length > 0,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position: impressions > 0 ? weightedPosition / impressions : null,
      dataThrough: searchDates.length ? searchDates[searchDates.length - 1] : null,
      topQueries: input.searchTop?.top_queries ?? [],
      topPages: input.searchTop?.top_pages ?? [],
      topWindow: input.searchTop && input.searchTop.since ? { since: input.searchTop.since, until: input.searchTop.until } : null,
    },
    appStore,
    markers: input.milestones.map((milestone) => ({
      date: etDate(new Date(milestone.happened_at)),
      label: milestone.label,
      kind: milestone.kind,
      happenedAt: milestone.happened_at,
    })),
    health: sourceHealth(input.runs, now, { engagement: appStore.engagementThrough, downloads: appStore.downloadsThrough }),
    lastRun: lastRunRecord
      ? {
          started_at: lastRunRecord.started_at,
          status: lastRunRecord.status,
          trigger: lastRunRecord.trigger,
          unfinished: isRunUnfinished(lastRunRecord, now),
        }
      : null,
    tokenDaysLeft: tokenDaysLeft(input.tokenExpires, today),
  };
}
