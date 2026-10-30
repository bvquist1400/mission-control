/**
 * The dependency picker's task list (Baseline task 2cf52bf2, Brent 10/30).
 * The task window opens from many pages and each passes only the tasks it
 * knows (Today: Today's tasks; the task page and the planner: just the opened
 * task), so "+ Add dependency" said "No matching tasks available" for a task on
 * another page. The picker now loads all open tasks itself, once per window,
 * and offers them with the ones passed in. Pure and browser-safe.
 */
import type { TaskWithImplementation } from '@/types/database';

/** GET /api/tasks caps `limit` at 500. */
export const PICKER_PAGE_SIZE = 500;
/** A guard, not a real limit: 20 pages is 10,000 open tasks. */
const PICKER_MAX_PAGES = 20;

const CLOSED_STATUSES = new Set(['Done', 'Parked', 'Missed']);

type FetchLike = (input: string, init?: { cache?: RequestCache; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Every open task (not Done, Parked or Missed), a page at a time. GET
 * /api/tasks leaves those three out by default and covers work and personal.
 */
export async function fetchOpenTasksForPicker(fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<TaskWithImplementation[]> {
  const tasks: TaskWithImplementation[] = [];
  for (let page = 0; page < PICKER_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: String(PICKER_PAGE_SIZE), offset: String(page * PICKER_PAGE_SIZE) });
    const response = await fetchImpl(`/api/tasks?${params.toString()}`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Failed to load tasks');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Failed to load tasks');
    tasks.push(...(rows as TaskWithImplementation[]));
    if (rows.length < PICKER_PAGE_SIZE) break;
  }
  return tasks;
}

export interface DependencyCandidateInput {
  /** The task being edited (never offered). */
  taskId: string;
  /** What the page passed in (its copies win: they carry edits made on the page). */
  passed: ReadonlyArray<TaskWithImplementation>;
  /** The open tasks the picker loaded (null until loaded). */
  loaded: ReadonlyArray<TaskWithImplementation> | null;
  /** Tasks this one already waits on. */
  linkedIds: ReadonlySet<string>;
  search: string;
}

/** The tasks the picker offers: open, not this task, not already linked, matching the search; highest priority first. */
export function dependencyTaskCandidates(input: DependencyCandidateInput): TaskWithImplementation[] {
  const byId = new Map<string, TaskWithImplementation>();
  for (const task of input.passed) byId.set(task.id, task);
  for (const task of input.loaded ?? []) if (!byId.has(task.id)) byId.set(task.id, task);
  const search = input.search.trim().toLowerCase();
  return [...byId.values()]
    .filter((task) => task.id !== input.taskId)
    .filter((task) => !input.linkedIds.has(task.id))
    .filter((task) => !CLOSED_STATUSES.has(task.status))
    .filter((task) => !search || `${task.title} ${task.implementation?.name || ''}`.toLowerCase().includes(search))
    .sort((a, b) => b.priority_score - a.priority_score);
}

/** The line under the picker's list, or null when there's nothing to say. */
export function pickerHint(type: 'task' | 'commitment', state: { loading: boolean; failed: boolean; count: number }): string | null {
  if (type === 'task' && state.loading) return 'Loading tasks…';
  if (type === 'task' && state.failed) {
    return state.count === 0 ? 'Couldn’t load your open tasks. Close this and try again.' : 'Couldn’t load all your open tasks, so some may be missing.';
  }
  return state.count === 0 ? `No matching ${type}s available.` : null;
}
