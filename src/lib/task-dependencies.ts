import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from '@/lib/task-dependency-links';
import type {
  CommitmentStatus,
  RecentlyResolvedTaskDependencySummary,
  TaskStatus,
} from '@/types/database';

export type DependencyType = 'task' | 'commitment';
export type DependencyStatus = TaskStatus | CommitmentStatus;

interface TaskDependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  resolved_at: string | null;
  is_resolved: boolean;
  created_at: string;
}

interface DependencyTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
}

interface DependencyCommitmentRow {
  id: string;
  title: string;
  status: CommitmentStatus;
}

export interface TaskDependencySummary {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  type: DependencyType;
  title: string;
  status: DependencyStatus;
  unresolved: boolean;
  resolved_at?: string | null;
  created_at: string;
}

const UNKNOWN_TASK_TITLE = 'Unknown task';
const UNKNOWN_COMMITMENT_TITLE = 'Unknown commitment';
const UNKNOWN_TASK_STATUS: TaskStatus = 'Blocked/Waiting';
const UNKNOWN_COMMITMENT_STATUS: CommitmentStatus = 'Open';

const ID_CHUNK_SIZE = 100;
const DEPENDENCY_ROW_SELECT = 'id, task_id, depends_on_task_id, depends_on_commitment_id, resolved_at, is_resolved, created_at';

function chunkIds(values: string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < values.length; index += ID_CHUNK_SIZE) {
    out.push(values.slice(index, index + ID_CHUNK_SIZE));
  }
  return out;
}

interface DependencyRowQuery {
  eq(column: string, value: unknown): DependencyRowQuery;
  gt(column: string, value: unknown): DependencyRowQuery;
  gte(column: string, value: unknown): DependencyRowQuery;
  in(column: string, values: unknown[]): DependencyRowQuery;
  not(column: string, operator: string, value: unknown): DependencyRowQuery;
  order(column: string, options: { ascending: boolean }): DependencyRowQuery;
  limit(count: number): PromiseLike<{ data: TaskDependencyRow[] | null; error: unknown }>;
}

/**
 * Every dependency row for these tasks, read completely: task ids in chunks of
 * 100 (a long in() list makes the URL too long), each chunk keyset-paged on the
 * row id until an empty page (fetchAllPages), so PostgREST's max_rows cap can't
 * cut the list short. A read that can't be proven complete throws
 * DependencyReadIncompleteError instead of returning a short list.
 */
async function readDependencyRows(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
  apply: (query: DependencyRowQuery) => DependencyRowQuery
): Promise<TaskDependencyRow[]> {
  const rows: TaskDependencyRow[] = [];
  for (const ids of chunkIds(taskIds)) {
    rows.push(
      ...(await fetchAllPages<TaskDependencyRow>((afterId, limit) => {
        let query = apply(
          supabase
            .from('task_dependencies')
            .select(DEPENDENCY_ROW_SELECT)
            .eq('user_id', userId) as unknown as DependencyRowQuery
        ).in('task_id', ids);
        if (afterId !== null) query = query.gt('id', afterId);
        return query.order('id', { ascending: true }).limit(limit);
      }))
    );
  }
  return rows;
}

/** Rows of `table` with these ids (chunked), scoped to the user. */
async function readRowsById<T>(
  supabase: SupabaseClient,
  userId: string,
  table: 'tasks' | 'commitments',
  ids: string[]
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await supabase.from(table).select('id, title, status').eq('user_id', userId).in('id', chunk);
    if (error) {
      throw error;
    }
    out.push(...((data || []) as T[]));
  }
  return out;
}

export function isDependencyResolved(status: DependencyStatus): boolean {
  return status === 'Done';
}

export async function fetchTaskDependencySummaries(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[]
): Promise<Map<string, TaskDependencySummary[]>> {
  const byTaskId = new Map<string, TaskDependencySummary[]>();

  if (taskIds.length === 0) {
    return byTaskId;
  }

  const uniqueTaskIds = [...new Set(taskIds)];
  const dependencies = await readDependencyRows(supabase, userId, uniqueTaskIds, (query) => query.eq('is_resolved', false));
  if (dependencies.length === 0) {
    return byTaskId;
  }

  const dependencyTaskIds = [
    ...new Set(
      dependencies
        .map((row) => row.depends_on_task_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ),
  ];
  const dependencyCommitmentIds = [
    ...new Set(
      dependencies
        .map((row) => row.depends_on_commitment_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ),
  ];

  const dependencyTasks = await readRowsById<DependencyTaskRow>(supabase, userId, 'tasks', dependencyTaskIds);
  const dependencyCommitments = await readRowsById<DependencyCommitmentRow>(supabase, userId, 'commitments', dependencyCommitmentIds);

  const taskById = new Map<string, DependencyTaskRow>();
  for (const row of dependencyTasks) {
    taskById.set(row.id, row);
  }

  const commitmentById = new Map<string, DependencyCommitmentRow>();
  for (const row of dependencyCommitments) {
    commitmentById.set(row.id, row);
  }

  for (const row of dependencies) {
    let summary: TaskDependencySummary | null = null;

    if (row.depends_on_task_id) {
      const target = taskById.get(row.depends_on_task_id);
      const status = target?.status ?? UNKNOWN_TASK_STATUS;
      summary = {
        id: row.id,
        task_id: row.task_id,
        depends_on_task_id: row.depends_on_task_id,
        depends_on_commitment_id: null,
        type: 'task',
        title: target?.title ?? UNKNOWN_TASK_TITLE,
        status,
        unresolved: !isDependencyResolved(status),
        resolved_at: row.resolved_at,
        created_at: row.created_at,
      };
    } else if (row.depends_on_commitment_id) {
      const target = commitmentById.get(row.depends_on_commitment_id);
      const status = target?.status ?? UNKNOWN_COMMITMENT_STATUS;
      summary = {
        id: row.id,
        task_id: row.task_id,
        depends_on_task_id: null,
        depends_on_commitment_id: row.depends_on_commitment_id,
        type: 'commitment',
        title: target?.title ?? UNKNOWN_COMMITMENT_TITLE,
        status,
        unresolved: !isDependencyResolved(status),
        resolved_at: row.resolved_at,
        created_at: row.created_at,
      };
    }

    if (!summary) {
      continue;
    }

    const list = byTaskId.get(row.task_id) || [];
    list.push(summary);
    byTaskId.set(row.task_id, list);
  }

  for (const [taskId, list] of byTaskId.entries()) {
    list.sort((a, b) => {
      if (a.unresolved !== b.unresolved) {
        return a.unresolved ? -1 : 1;
      }

      const createdDiff = Date.parse(b.created_at) - Date.parse(a.created_at);
      if (Number.isFinite(createdDiff) && createdDiff !== 0) {
        return createdDiff;
      }

      return a.title.localeCompare(b.title);
    });

    byTaskId.set(taskId, list);
  }

  return byTaskId;
}

export async function fetchRecentlyResolvedTaskDependencySummaries(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
  resolvedAfterIso: string
): Promise<Map<string, RecentlyResolvedTaskDependencySummary[]>> {
  const byTaskId = new Map<string, RecentlyResolvedTaskDependencySummary[]>();

  if (taskIds.length === 0) {
    return byTaskId;
  }

  const uniqueTaskIds = [...new Set(taskIds)];
  const dependencies = await readDependencyRows(supabase, userId, uniqueTaskIds, (query) =>
    query.eq('is_resolved', true).not('resolved_at', 'is', null).gte('resolved_at', resolvedAfterIso)
  );
  if (dependencies.length === 0) {
    return byTaskId;
  }

  const dependencyTaskIds = [
    ...new Set(
      dependencies
        .map((row) => row.depends_on_task_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ),
  ];
  const dependencyCommitmentIds = [
    ...new Set(
      dependencies
        .map((row) => row.depends_on_commitment_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    ),
  ];

  const dependencyTasks = await readRowsById<DependencyTaskRow>(supabase, userId, 'tasks', dependencyTaskIds);
  const dependencyCommitments = await readRowsById<DependencyCommitmentRow>(supabase, userId, 'commitments', dependencyCommitmentIds);

  const taskById = new Map<string, DependencyTaskRow>();
  for (const row of dependencyTasks) {
    taskById.set(row.id, row);
  }

  const commitmentById = new Map<string, DependencyCommitmentRow>();
  for (const row of dependencyCommitments) {
    commitmentById.set(row.id, row);
  }

  for (const row of dependencies) {
    if (!row.resolved_at) {
      continue;
    }

    let summary: RecentlyResolvedTaskDependencySummary | null = null;

    if (row.depends_on_task_id) {
      const target = taskById.get(row.depends_on_task_id);
      summary = {
        id: row.id,
        task_id: row.task_id,
        depends_on_task_id: row.depends_on_task_id,
        depends_on_commitment_id: null,
        type: 'task',
        title: target?.title ?? UNKNOWN_TASK_TITLE,
        status: target?.status ?? UNKNOWN_TASK_STATUS,
        resolved_at: row.resolved_at,
        created_at: row.created_at,
      };
    } else if (row.depends_on_commitment_id) {
      const target = commitmentById.get(row.depends_on_commitment_id);
      summary = {
        id: row.id,
        task_id: row.task_id,
        depends_on_task_id: null,
        depends_on_commitment_id: row.depends_on_commitment_id,
        type: 'commitment',
        title: target?.title ?? UNKNOWN_COMMITMENT_TITLE,
        status: target?.status ?? UNKNOWN_COMMITMENT_STATUS,
        resolved_at: row.resolved_at,
        created_at: row.created_at,
      };
    }

    if (!summary) {
      continue;
    }

    const list = byTaskId.get(row.task_id) || [];
    list.push(summary);
    byTaskId.set(row.task_id, list);
  }

  for (const [taskId, list] of byTaskId.entries()) {
    list.sort((a, b) => Date.parse(b.resolved_at) - Date.parse(a.resolved_at));
    byTaskId.set(taskId, list);
  }

  return byTaskId;
}

export async function fetchTaskDependenciesForTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<TaskDependencySummary[]> {
  const map = await fetchTaskDependencySummaries(supabase, userId, [taskId]);
  return map.get(taskId) || [];
}

export async function fetchDependencyBlockedTaskIds(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[]
): Promise<Set<string>> {
  const blockedIds = new Set<string>();

  if (taskIds.length === 0) {
    return blockedIds;
  }

  const dependencyMap = await fetchTaskDependencySummaries(supabase, userId, taskIds);

  for (const taskId of taskIds) {
    const dependencies = dependencyMap.get(taskId) || [];
    if (dependencies.some((dependency) => dependency.unresolved)) {
      blockedIds.add(taskId);
    }
  }

  return blockedIds;
}
