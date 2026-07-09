import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeTaskWithRelationsList,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import {
  fetchTaskDependencySummaries,
  type TaskDependencySummary,
} from '@/lib/task-dependencies';
import type { TaskWithImplementation } from '@/types/database';

/**
 * Shared query layer for the Today page and the `/api/tasks?view=...` branches.
 *
 * These functions are the single source of truth for the Today-related task
 * views. `/api/tasks/route.ts` delegates its `view=top3`, `view=weekly_board`,
 * `view=waiting_summary`, and `view=needs_review_count` branches here, and the
 * server-rendered Today page calls them directly. Behavior must stay identical
 * to the original inline route logic so the MCP and other API clients keep
 * working unchanged.
 */

export type WaitingSummaryTask = TaskWithImplementation & {
  dependencies: TaskDependencySummary[];
  dependency_blocked: boolean;
};

/**
 * Top 3 actionable tasks: Planned/In Progress ordered by priority_score DESC.
 * Mirrors the `view=top3` branch.
 */
export async function queryTopThreeTasks(
  supabase: SupabaseClient,
  userId: string
): Promise<TaskWithImplementation[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_WITH_RELATIONS_SELECT)
    .eq('user_id', userId)
    .in('status', ['Planned', 'In Progress'])
    .order('priority_score', { ascending: false })
    .order('id', { ascending: true })
    .limit(3);

  if (error) {
    throw error;
  }

  return normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>);
}

/**
 * Tasks with a due date on or before `weekEnd`, excluding Done/Parked.
 * Mirrors the `view=weekly_board` branch.
 */
export async function queryWeeklyBoardTasks(
  supabase: SupabaseClient,
  userId: string,
  weekEnd: Date,
  limit = 200
): Promise<TaskWithImplementation[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_WITH_RELATIONS_SELECT)
    .eq('user_id', userId)
    .not('due_at', 'is', null)
    .lte('due_at', weekEnd.toISOString())
    .neq('status', 'Done')
    .neq('status', 'Parked')
    .order('due_at', { ascending: true })
    .order('priority_score', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>);
}

/**
 * Blocked/Waiting tasks enriched with unresolved-dependency summaries.
 * Mirrors the `view=waiting_summary` branch.
 */
export async function queryWaitingSummary(
  supabase: SupabaseClient,
  userId: string,
  limit = 30
): Promise<WaitingSummaryTask[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_WITH_RELATIONS_SELECT)
    .eq('user_id', userId)
    .eq('status', 'Blocked/Waiting')
    .order('priority_score', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  const tasks = normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>);
  const taskIds = tasks.map((task) => task.id);
  const dependencyMap = await fetchTaskDependencySummaries(supabase, userId, taskIds);

  return tasks.map((task) => {
    const dependencies = dependencyMap.get(task.id) || [];
    return {
      ...task,
      dependencies,
      dependency_blocked: dependencies.some((dependency) => dependency.unresolved),
    };
  });
}

/**
 * Count of open tasks flagged needs_review (excluding Done/Parked).
 * Mirrors the `view=needs_review_count` branch.
 */
export async function queryNeedsReviewCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('needs_review', true)
    .neq('status', 'Done')
    .neq('status', 'Parked');

  if (error) {
    throw error;
  }

  return count ?? 0;
}
