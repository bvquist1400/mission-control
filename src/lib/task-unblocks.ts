import type { SupabaseClient } from '@supabase/supabase-js';
import { getDateOnlyInTimeZone, getDateOnlyWeekday, addDateOnlyDays } from '@/lib/date-only';
import { buildRecurringDueAt } from '@/lib/recurrence';
import type {
  RecentlyResolvedTaskDependencySummary,
  TaskStatus,
  TaskUnblock,
  TaskUnblockClearReason,
} from '@/types/database';

/**
 * "Now unblocked" (Baseline 2f6b39f2, S2; migration 067). The database does the
 * work: when a task or commitment becomes Done, 067's trigger unblocks each task
 * whose remaining links are all Done, sets `tasks.unblocked_at` (the pill) and
 * logs a `task_unblocks` row. This file holds the app side: whether a card shows
 * the pill, the same "until I act" clearing rule for optimistic local edits, the
 * landing-day rule (mirrored from 067 so it is pinned by tests and S3 can say
 * "Keep <date>"), and the intelligence layer's read of recent unblocks.
 *
 * Keep these in step with supabase/migrations/067_task_unblocks.sql.
 */

export const UNBLOCK_TIME_ZONE = 'America/New_York';
export const NOW_UNBLOCKED_LABEL = 'Now unblocked';
/** Reopening a blocker puts the unblock back only within this many days (067 rule 6). */
export const UNBLOCK_UNDO_DAYS = 7;

/** Statuses an unblock touches and the pill shows on (067 rule 2). */
export const UNBLOCK_OPEN_STATUSES: ReadonlyArray<TaskStatus> = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting'];

/** Every reason a pill can clear, in 067's task_unblocks.cleared_reason check order. */
export const UNBLOCK_CLEAR_REASONS: ReadonlyArray<TaskUnblockClearReason> = [
  'started',
  'finished',
  'parked',
  'missed',
  'waiting',
  'redated',
  'reblocked',
  'reopened',
  'brief',
  'manual',
];

type PillTask = { status: TaskStatus; unblocked_at?: string | null };

/** The card shows the green "Now unblocked" pill. */
export function isNowUnblocked(task: PillTask): boolean {
  return Boolean(task.unblocked_at) && UNBLOCK_OPEN_STATUSES.includes(task.status);
}

/**
 * Why a write by anyone but 067's functions clears the pill (Brent 10/30: "Until
 * I act, no limit"), or null when it stays. Same order as 067's task_unblock_pill:
 * a status change to In Progress / Done / Parked / Missed / Blocked/Waiting, then
 * a due-date change. Backlog <-> Planned and every other edit keep it.
 */
export function unblockPillClearReason(
  before: { status: TaskStatus; due_at?: string | null; unblocked_at?: string | null },
  updates: { status?: TaskStatus; due_at?: string | null }
): TaskUnblockClearReason | null {
  if (!before.unblocked_at) return null;
  const status = updates.status;
  if (status !== undefined && status !== before.status) {
    switch (status) {
      case 'In Progress':
        return 'started';
      case 'Done':
        return 'finished';
      case 'Parked':
        return 'parked';
      case 'Missed':
        return 'missed';
      case 'Blocked/Waiting':
        return 'waiting';
      default:
        break;
    }
  }
  if ('due_at' in updates && !sameInstant(updates.due_at ?? null, before.due_at ?? null)) {
    return 'redated';
  }
  return null;
}

/** An optimistic local edit, with the pill cleared when the database will clear it. */
export function withUnblockPillRule<T extends { status: TaskStatus; due_at?: string | null; unblocked_at?: string | null }>(
  task: T,
  updates: Partial<T>
): T {
  const next = { ...task, ...updates };
  if (unblockPillClearReason(task, updates as { status?: TaskStatus; due_at?: string | null })) {
    return { ...next, unblocked_at: null };
  }
  return next;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : a === b;
}

/**
 * The ET day a missing or past due date moves to (067 rule 4): the unblock day in
 * ET; for a work task a Saturday or Sunday lands on Monday.
 */
export function unblockLandingDate(now: Date, isPersonal: boolean): string {
  const today = getDateOnlyInTimeZone(UNBLOCK_TIME_ZONE, now);
  if (isPersonal) return today;
  const weekday = getDateOnlyWeekday(today);
  if (weekday === 6) return addDateOnlyDays(today, 2)!;
  if (weekday === 0) return addDateOnlyDays(today, 1)!;
  return today;
}

/**
 * The due date an unblock leaves (Brent 10/30, "Keep the later date"): unchanged
 * when its ET day is on or after the landing day, else the end of the landing day
 * in ET (23:59:59.999, what the brief's Pick a date writes).
 */
export function unblockDueAt(dueAt: string | null, landingDate: string): string | null {
  if (dueAt) {
    const parsed = new Date(dueAt);
    if (Number.isFinite(parsed.getTime()) && getDateOnlyInTimeZone(UNBLOCK_TIME_ZONE, parsed) >= landingDate) {
      return dueAt;
    }
  }
  return buildRecurringDueAt(landingDate, UNBLOCK_TIME_ZONE);
}

/** The pill's hover text. Names nothing but the time (FamCal-safe like the comment). */
export function nowUnblockedTitle(unblockedAt: string | null | undefined, now: Date = new Date()): string {
  const base = 'Everything it waited on is done';
  if (!unblockedAt) return base;
  const at = new Date(unblockedAt);
  if (!Number.isFinite(at.getTime())) return base;
  const day = getDateOnlyInTimeZone(UNBLOCK_TIME_ZONE, at);
  const today = getDateOnlyInTimeZone(UNBLOCK_TIME_ZONE, now);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: UNBLOCK_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(at);
  if (day === today) return `${base} (since ${time})`;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: UNBLOCK_TIME_ZONE, weekday: 'short', month: 'numeric', day: 'numeric' })
    .format(at)
    .replace(',', '');
  return `${base} (since ${date}, ${time})`;
}

// ── Reads ─────────────────────────────────────────────────────────────────

const ID_CHUNK_SIZE = 100;
const UNBLOCK_ROW_SELECT =
  'id, task_id, blocker_type, blocker_task_id, blocker_commitment_id, unblocked_at, created_at, reverted_at';

type RecentUnblockRow = Pick<
  TaskUnblock,
  'id' | 'task_id' | 'blocker_type' | 'blocker_task_id' | 'blocker_commitment_id' | 'unblocked_at' | 'created_at' | 'reverted_at'
>;

/**
 * Recent unblocks (not reverted, unblocked at or after `sinceIso`) as the
 * "recently resolved dependency" summaries the intelligence layer's
 * recently_unblocked detector reads: a finished blocker clears a dependency just
 * like a removed link does. One per unblock, the blocker named by its title
 * (this read is the app's own, never FamCal's).
 */
export async function fetchRecentUnblockDependencySummaries(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[],
  sinceIso: string
): Promise<Map<string, RecentlyResolvedTaskDependencySummary[]>> {
  const byTaskId = new Map<string, RecentlyResolvedTaskDependencySummary[]>();
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return byTaskId;

  const rows: RecentUnblockRow[] = [];
  for (let index = 0; index < unique.length; index += ID_CHUNK_SIZE) {
    const chunk = unique.slice(index, index + ID_CHUNK_SIZE);
    const { data, error } = await supabase
      .from('task_unblocks')
      .select(UNBLOCK_ROW_SELECT)
      .eq('user_id', userId)
      .in('task_id', chunk)
      .is('reverted_at', null)
      .gte('unblocked_at', sinceIso)
      .order('unblocked_at', { ascending: false })
      .limit(1000);
    if (error) throw error;
    rows.push(...((data || []) as RecentUnblockRow[]));
  }
  if (rows.length === 0) return byTaskId;

  const blockerTaskIds = [...new Set(rows.map((row) => row.blocker_task_id).filter((id): id is string => Boolean(id)))];
  const blockerCommitmentIds = [
    ...new Set(rows.map((row) => row.blocker_commitment_id).filter((id): id is string => Boolean(id))),
  ];
  const titles = new Map<string, { title: string; status: string }>();
  for (const [table, ids] of [['tasks', blockerTaskIds], ['commitments', blockerCommitmentIds]] as const) {
    for (let index = 0; index < ids.length; index += ID_CHUNK_SIZE) {
      const { data, error } = await supabase
        .from(table)
        .select('id, title, status')
        .eq('user_id', userId)
        .in('id', ids.slice(index, index + ID_CHUNK_SIZE));
      if (error) throw error;
      for (const row of (data || []) as Array<{ id: string; title: string; status: string }>) {
        titles.set(row.id, { title: row.title, status: row.status });
      }
    }
  }

  for (const row of rows) {
    const isTask = row.blocker_type === 'task';
    const blockerId = isTask ? row.blocker_task_id : row.blocker_commitment_id;
    const blocker = blockerId ? titles.get(blockerId) : undefined;
    const summary = {
      id: row.id,
      task_id: row.task_id,
      depends_on_task_id: isTask ? row.blocker_task_id : null,
      depends_on_commitment_id: isTask ? null : row.blocker_commitment_id,
      type: row.blocker_type,
      title: blocker?.title ?? (isTask ? 'A finished task' : 'A finished commitment'),
      status: (blocker?.status ?? 'Done') as RecentlyResolvedTaskDependencySummary['status'],
      resolved_at: row.unblocked_at,
      created_at: row.created_at,
    } satisfies RecentlyResolvedTaskDependencySummary;
    const list = byTaskId.get(row.task_id) ?? [];
    list.push(summary);
    byTaskId.set(row.task_id, list);
  }
  return byTaskId;
}

// ── Retry ─────────────────────────────────────────────────────────────────

/** task_unblock_run_retries' reply (067). `gave_up` is S3's "stuck" count. */
export type UnblockRetryRun = {
  ok: boolean;
  applied: number;
  skipped: number;
  failed: number;
  gave_up: number;
};

/**
 * Works through the waiting tasks the Done and reopen triggers could not process
 * (067, task_unblock_retries). The 15-minute calendar sync cron calls this with
 * its service-role client. Never throws: the sync's own result stands whatever
 * happens here, and an unfinished record simply stays for the next run. Logs
 * counts and a code only.
 */
export async function runUnblockRetries(supabase: SupabaseClient, userId: string): Promise<UnblockRetryRun | null> {
  try {
    const { data, error } = await supabase.rpc('task_unblock_run_retries', { p_user_id: userId });
    if (error) {
      console.warn('Now unblocked retry failed', { code: error.code });
      return null;
    }
    const run = data as UnblockRetryRun;
    if (run.applied + run.skipped + run.failed + run.gave_up > 0) {
      console.info('Now unblocked retry', {
        applied: run.applied,
        skipped: run.skipped,
        failed: run.failed,
        gaveUp: run.gave_up,
      });
    }
    return run;
  } catch {
    console.warn('Now unblocked retry failed');
    return null;
  }
}

/** Merges two per-task lists of resolved-dependency summaries, newest first. */
export function mergeResolvedDependencyMaps(
  a: Map<string, RecentlyResolvedTaskDependencySummary[]>,
  b: Map<string, RecentlyResolvedTaskDependencySummary[]>
): Map<string, RecentlyResolvedTaskDependencySummary[]> {
  const out = new Map<string, RecentlyResolvedTaskDependencySummary[]>();
  for (const source of [a, b]) {
    for (const [taskId, list] of source) {
      out.set(taskId, [...(out.get(taskId) ?? []), ...list]);
    }
  }
  for (const [taskId, list] of out) {
    out.set(taskId, list.sort((x, y) => Date.parse(y.resolved_at) - Date.parse(x.resolved_at)));
  }
  return out;
}
