/**
 * The launch-metrics database surface the sync needs, behind a small
 * interface so the sync, alert and stale rules can be tested with an
 * in-memory fake. The Supabase version always filters by user_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/types/supabase.generated';
import { LAUNCH_RELEASE_DATE } from './dates';
import { LaunchSourceError } from './http';
import { APPLE_FAMILY_TOTALS, type AppleDataThrough } from './stale';
import type { DailyMetricInput, LaunchRunKind, LaunchRunStatus, LaunchRunTrigger, LaunchSnapshotSource } from './types';

export interface RunRecord {
  id: string;
  trigger: LaunchRunTrigger;
  kind: LaunchRunKind;
  started_at: string;
  finished_at: string | null;
  status: LaunchRunStatus;
  sources: Record<string, string>;
}

export interface AlertTask {
  id: string;
  status: string;
}

export interface NewAlertTask {
  title: string;
  description: string;
  status_line: string;
  external_source_id: string;
  project_id: string | null;
}

export interface AlertTaskPatch {
  status?: 'Planned' | 'Done';
  owner?: 'brent' | 'agent';
  owner_label?: string | null;
  status_line?: string;
}

/** An Apple row already stored (what a newer instance must replace, never merge into). */
export interface AppleStoredKey {
  metric_date: string;
  metric: string;
  dimension: string;
  variant: string | null;
  apple_processing_date: string | null;
}

export interface AppleInstanceRecord {
  instance_id: string;
  report_name: string;
  granularity: 'DAILY';
  processing_date: string;
  segment_count: number;
  rows_parsed: number;
  fetched_at: string;
}

export interface LaunchStore {
  recentRuns(limit: number): Promise<RunRecord[]>;
  insertRun(run: { trigger: LaunchRunTrigger; kind: LaunchRunKind; started_at: string }): Promise<string>;
  finishRun(id: string, result: { status: LaunchRunStatus; sources: Record<string, string>; finished_at: string }): Promise<void>;
  upsertDaily(rows: DailyMetricInput[]): Promise<void>;
  upsertSnapshot(source: LaunchSnapshotSource, asOfDate: string, capturedAt: string, payload: Json): Promise<void>;
  findAlertTask(externalSourceId: string): Promise<AlertTask | null>;
  /** Returns null when another run created it first (unique external id). */
  createAlertTask(task: NewAlertTask): Promise<AlertTask | null>;
  updateAlertTask(id: string, patch: AlertTaskPatch): Promise<void>;
  addTaskComment(taskId: string, content: string): Promise<void>;
  /** Which of these Apple instance ids were already read (launch_apple_instances). */
  knownAppleInstances(instanceIds: string[]): Promise<Set<string>>;
  /** Stored Apple rows on these days (any metric, dimension and variant). */
  appleRowsFor(dates: string[]): Promise<AppleStoredKey[]>;
  recordAppleInstance(record: AppleInstanceRecord): Promise<void>;
  /** The newest day each Apple report family has a day total for, since release. */
  appleDataThrough(): Promise<AppleDataThrough>;
}

export const ALERT_SOURCE_SYSTEM = 'launch_metrics';
export const ALERT_TAGS = ['personal', 'stock-and-stir', 'live-dashboard'];
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** Run-log sources are codes only; anything else read back is shown as `error`. */
export function readRunSources(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, code] of Object.entries(value as Record<string, unknown>)) {
    if (CODE_PATTERN.test(key)) {
      out[key] = typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'error';
    }
  }
  return out;
}

const UPSERT_CHUNK = 500;
const ID_CHUNK = 100;
const READ_PAGE = 1000;

export function createSupabaseLaunchStore(supabase: SupabaseClient<Database>, userId: string): LaunchStore {
  return {
    async recentRuns(limit) {
      const { data, error } = await supabase
        .from('launch_metric_runs')
        .select('id, trigger, kind, started_at, finished_at, status, sources')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) {
        throw new LaunchSourceError('db_read');
      }
      return (data ?? []).map((row) => ({
        id: row.id,
        trigger: row.trigger as LaunchRunTrigger,
        kind: row.kind as LaunchRunKind,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status as LaunchRunStatus,
        sources: readRunSources(row.sources),
      }));
    },

    async insertRun(run) {
      const { data, error } = await supabase
        .from('launch_metric_runs')
        .insert({ user_id: userId, trigger: run.trigger, kind: run.kind, started_at: run.started_at, status: 'running', sources: {} })
        .select('id')
        .single();
      if (error || !data) {
        throw new LaunchSourceError('db_write');
      }
      return data.id;
    },

    async finishRun(id, result) {
      const { error } = await supabase
        .from('launch_metric_runs')
        .update({ status: result.status, sources: result.sources, finished_at: result.finished_at })
        .eq('id', id)
        .eq('user_id', userId);
      if (error) {
        throw new LaunchSourceError('db_write');
      }
    },

    async upsertDaily(rows) {
      for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
        const chunk = rows.slice(index, index + UPSERT_CHUNK).map((row) => ({
          user_id: userId,
          metric_date: row.metric_date,
          source: row.source,
          metric: row.metric,
          dimension: row.dimension,
          value: row.value,
          variant: row.variant ?? null,
          apple_processing_date: row.apple_processing_date ?? null,
        }));
        const { error } = await supabase
          .from('launch_metric_daily')
          .upsert(chunk, { onConflict: 'user_id,metric_date,source,metric,dimension' });
        if (error) {
          throw new LaunchSourceError('db_write');
        }
      }
    },

    async upsertSnapshot(source, asOfDate, capturedAt, payload) {
      const { error } = await supabase
        .from('launch_source_snapshots')
        .upsert(
          { user_id: userId, source, as_of_date: asOfDate, captured_at: capturedAt, payload },
          { onConflict: 'user_id,source,as_of_date' }
        );
      if (error) {
        throw new LaunchSourceError('db_write');
      }
    },

    async findAlertTask(externalSourceId) {
      const { data, error } = await supabase
        .from('tasks')
        .select('id, status')
        .eq('user_id', userId)
        .eq('external_source_system', ALERT_SOURCE_SYSTEM)
        .eq('external_source_id', externalSourceId)
        .maybeSingle();
      if (error) {
        throw new LaunchSourceError('db_read');
      }
      return data ? { id: data.id, status: data.status } : null;
    },

    async createAlertTask(task) {
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          user_id: userId,
          title: task.title,
          description: task.description,
          status: 'Planned',
          task_type: 'Admin',
          owner: 'brent',
          owner_label: null,
          status_line: task.status_line,
          tags: ALERT_TAGS,
          project_id: task.project_id,
          priority_score: 70,
          base_priority: 70,
          needs_review: false,
          source_type: 'System',
          external_source_system: ALERT_SOURCE_SYSTEM,
          external_source_id: task.external_source_id,
        })
        .select('id, status')
        .single();
      if (error) {
        if (error.code === '23505') {
          return null;
        }
        throw new LaunchSourceError('db_write');
      }
      return { id: data.id, status: data.status };
    },

    async updateAlertTask(id, patch) {
      const { error } = await supabase.from('tasks').update(patch).eq('id', id).eq('user_id', userId);
      if (error) {
        throw new LaunchSourceError('db_write');
      }
    },

    async addTaskComment(taskId, content) {
      const { error } = await supabase
        .from('task_comments')
        .insert({ user_id: userId, task_id: taskId, content, source: 'system' });
      if (error) {
        throw new LaunchSourceError('db_write');
      }
    },

    async knownAppleInstances(instanceIds) {
      const known = new Set<string>();
      for (let index = 0; index < instanceIds.length; index += ID_CHUNK) {
        const chunk = instanceIds.slice(index, index + ID_CHUNK);
        const { data, error } = await supabase
          .from('launch_apple_instances')
          .select('instance_id')
          .eq('user_id', userId)
          .in('instance_id', chunk);
        if (error) {
          throw new LaunchSourceError('db_read');
        }
        for (const row of data ?? []) {
          known.add(row.instance_id);
        }
      }
      return known;
    },

    async appleRowsFor(dates) {
      const out: AppleStoredKey[] = [];
      for (let index = 0; index < dates.length; index += ID_CHUNK) {
        const chunk = dates.slice(index, index + ID_CHUNK);
        for (let from = 0; ; from += READ_PAGE) {
          const { data, error } = await supabase
            .from('launch_metric_daily')
            .select('metric_date, metric, dimension, variant, apple_processing_date')
            .eq('user_id', userId)
            .eq('source', 'apple')
            .in('metric_date', chunk)
            .order('metric_date', { ascending: true })
            .order('metric', { ascending: true })
            .order('dimension', { ascending: true })
            .range(from, from + READ_PAGE - 1);
          if (error) {
            throw new LaunchSourceError('db_read');
          }
          out.push(...(data ?? []));
          if (!data || data.length < READ_PAGE) {
            break;
          }
        }
      }
      return out;
    },

    async recordAppleInstance(record) {
      const { error } = await supabase
        .from('launch_apple_instances')
        .upsert({ user_id: userId, ...record }, { onConflict: 'user_id,instance_id' });
      if (error) {
        throw new LaunchSourceError('db_write');
      }
    },

    async appleDataThrough() {
      const newest = async (metrics: readonly string[]) => {
        const { data, error } = await supabase
          .from('launch_metric_daily')
          .select('metric_date')
          .eq('user_id', userId)
          .eq('source', 'apple')
          .eq('dimension', '')
          .in('metric', [...metrics])
          .gte('metric_date', LAUNCH_RELEASE_DATE)
          .order('metric_date', { ascending: false })
          .limit(1);
        if (error) {
          throw new LaunchSourceError('db_read');
        }
        return data?.[0]?.metric_date ?? null;
      };
      const [engagement, downloads] = await Promise.all([newest(APPLE_FAMILY_TOTALS.engagement), newest(APPLE_FAMILY_TOTALS.downloads)]);
      return { engagement, downloads };
    },
  };
}
