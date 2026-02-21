import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommitmentStatus, TaskStatus } from '@/types/database';

export type DependencyType = 'task' | 'commitment';
export type DependencyStatus = TaskStatus | CommitmentStatus;

interface TaskDependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
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
  created_at: string;
}

const UNKNOWN_TASK_TITLE = 'Unknown task';
const UNKNOWN_COMMITMENT_TITLE = 'Unknown commitment';
const UNKNOWN_TASK_STATUS: TaskStatus = 'Blocked/Waiting';
const UNKNOWN_COMMITMENT_STATUS: CommitmentStatus = 'Open';

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
  const { data: dependencyRows, error: dependencyError } = await supabase
    .from('task_dependencies')
    .select('id, task_id, depends_on_task_id, depends_on_commitment_id, created_at')
    .eq('user_id', userId)
    .in('task_id', uniqueTaskIds);

  if (dependencyError) {
    throw dependencyError;
  }

  const dependencies = (dependencyRows || []) as TaskDependencyRow[];
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

  let dependencyTasks: DependencyTaskRow[] = [];
  if (dependencyTaskIds.length > 0) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, status')
      .eq('user_id', userId)
      .in('id', dependencyTaskIds);

    if (error) {
      throw error;
    }

    dependencyTasks = (data || []) as DependencyTaskRow[];
  }

  let dependencyCommitments: DependencyCommitmentRow[] = [];
  if (dependencyCommitmentIds.length > 0) {
    const { data, error } = await supabase
      .from('commitments')
      .select('id, title, status')
      .eq('user_id', userId)
      .in('id', dependencyCommitmentIds);

    if (error) {
      throw error;
    }

    dependencyCommitments = (data || []) as DependencyCommitmentRow[];
  }

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
