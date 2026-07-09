import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeTaskWithRelationsList,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import {
  fetchTaskDependencySummaries,
  type TaskDependencySummary,
} from '@/lib/task-dependencies';
import { buildDayWindows, calculateBusyStats } from '@/lib/calendar';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';
import { calculateSprintProgressMetrics } from '@/lib/today/sprint-progress';
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

export interface TodayCalendarEvent {
  title: string;
  start: string;
  end: string;
  location: string | null;
}

export interface TodayCalendarResult {
  events: TodayCalendarEvent[];
  busyMinutes: number;
}

export interface CurrentSprintChip {
  id: string;
  name: string;
  completedTasks: number;
  totalTasks: number;
  onTrack: boolean;
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  return `${year}-${month}-${day}`;
}

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

/**
 * Today's calendar events plus busy minutes, resolved in the given timezone
 * (defaults to ET). Mirrors the inline logic of `/api/calendar/today`.
 */
export async function queryTodayCalendar(
  supabase: SupabaseClient,
  userId: string,
  timeZone: string = DEFAULT_WORKDAY_CONFIG.timezone
): Promise<TodayCalendarResult> {
  const today = getDateInTimeZone(new Date(), timeZone);
  const rangeContext = buildDayWindows(
    { rangeStart: today, rangeEnd: today },
    { ...DEFAULT_WORKDAY_CONFIG, timezone: timeZone }
  );

  const { data, error } = await supabase
    .from('calendar_events')
    .select('start_at, end_at, title')
    .eq('user_id', userId)
    .gte('end_at', rangeContext.utcRangeStart)
    .lt('start_at', rangeContext.utcRangeEndExclusive)
    .order('start_at', { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data || []) as Array<{ start_at: string; end_at: string; title: string }>;
  const events = rows.map((row) => ({
    title: row.title,
    start: row.start_at,
    end: row.end_at,
    location: null as string | null,
  }));

  const stats = calculateBusyStats(rows, rangeContext.windows);

  return { events, busyMinutes: stats.busyMinutes };
}

/**
 * The sprint containing "today" (in the given timezone), reduced to the fields
 * the Today header chip needs: name, completed/total task counts, and whether
 * it is on track (via `calculateSprintProgressMetrics`). Returns null when no
 * sprint spans today. Matches the current-sprint selection used by the legacy
 * client (`start_date <= today <= end_date`, most recent start wins).
 */
export async function queryCurrentSprintChip(
  supabase: SupabaseClient,
  userId: string,
  timeZone: string = DEFAULT_WORKDAY_CONFIG.timezone,
  holidaySet?: ReadonlySet<string>
): Promise<CurrentSprintChip | null> {
  const todayDate = getDateInTimeZone(new Date(), timeZone);

  const { data: sprints, error: sprintError } = await supabase
    .from('sprints')
    .select('id, name, start_date, end_date')
    .eq('user_id', userId)
    .lte('start_date', todayDate)
    .gte('end_date', todayDate)
    .order('start_date', { ascending: false })
    .limit(1);

  if (sprintError) {
    throw sprintError;
  }

  const sprint = (sprints || [])[0] as
    | { id: string; name: string; start_date: string; end_date: string }
    | undefined;

  if (!sprint) {
    return null;
  }

  const { data: taskRows, error: tasksError } = await supabase
    .from('tasks')
    .select('status')
    .eq('user_id', userId)
    .eq('sprint_id', sprint.id);

  if (tasksError) {
    throw tasksError;
  }

  const rows = (taskRows || []) as Array<{ status: string }>;
  const totalTasks = rows.length;
  const completedTasks = rows.filter((row) => row.status === 'Done').length;

  const metrics = calculateSprintProgressMetrics({
    sprintStartDate: sprint.start_date,
    sprintEndDate: sprint.end_date,
    totalTasks,
    completedTasks,
    todayDate,
    holidaySet,
  });

  return {
    id: sprint.id,
    name: sprint.name,
    completedTasks,
    totalTasks,
    onTrack: metrics.onTrack,
  };
}
