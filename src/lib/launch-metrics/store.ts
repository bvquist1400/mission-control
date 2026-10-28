/**
 * The launch-metrics database surface the sync needs, behind a small
 * interface so the sync, alert and stale rules can be tested with an
 * in-memory fake. The Supabase version always filters by user_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/types/supabase.generated';
import { LaunchSourceError } from './http';
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
  };
}
