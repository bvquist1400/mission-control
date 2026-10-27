/**
 * The Launch page's data (piece 8): one loader that reads only what Baseline
 * has stored (no live calls to any source from the page), and a pure builder
 * that turns it into what each section shows. Counts only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase.generated';
import { appDbHasRows, latestTotals, type AppDbTotalsView } from './page-totals';
import { addDays, dateRange, etDate, LAUNCH_RELEASE_DATE } from './dates';
import { readRunSources, type RunRecord } from './store';
import { isRunUnfinished, sourceHealth, tokenDaysLeft, type SourceHealth } from './stale';
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
  unconfirmed: number;
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

export interface MilestoneMarker {
  date: string;
  label: string;
  kind: LaunchMilestoneKind;
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

export function buildLaunchView(input: LaunchPageInput, now: Date): LaunchView {
  const today = etDate(now);
  const utcToday = now.toISOString().slice(0, 10);
  const days = dateRange(LAUNCH_RELEASE_DATE, today);

  // Sign-ups (ET days).
  const app = byKey(input.daily, 'app_db');
  const signupDays: SignupDay[] = days.map((date) => ({
    date,
    real: app(date, 'signups_real'),
    apple: app(date, 'signups_apple'),
    email: app(date, 'signups_email'),
    unconfirmed: app(date, 'signups_unconfirmed'),
    family: app(date, 'signups_family'),
    totalReal: input.daily.some((row) => row.source === 'app_db' && row.metric_date === date && row.metric === 'total_real_users')
      ? app(date, 'total_real_users')
      : null,
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
    markers: input.milestones.map((milestone) => ({
      date: etDate(new Date(milestone.happened_at)),
      label: milestone.label,
      kind: milestone.kind,
    })),
    health: sourceHealth(input.runs, now),
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
