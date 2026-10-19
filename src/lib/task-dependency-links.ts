import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FAMCAL_DEPENDENCY_COMMITMENT_TITLE,
  FAMCAL_DEPENDENCY_TASK_TITLE,
  FAMCAL_ELIGIBLE_FIELD,
  FAMCAL_REQUIRED_TAG,
} from '@/lib/famcal-api-key';

/**
 * Dependency visibility (cascade S0). A row in `task_dependencies` with
 * `is_resolved = false` is an active link: `task_id` waits on
 * `depends_on_task_id` (or `depends_on_commitment_id`). Removing a link sets
 * `is_resolved = true`, so only active rows count here.
 *
 * - blocked_by: what this task waits on (tasks or commitments).
 * - blocks: the tasks that wait on this task.
 */

export interface BlockedByLink {
  /** The task_dependencies row id (what remove_task_dependency takes). */
  dependency_id: string;
  type: 'task' | 'commitment';
  /** The linked task's or commitment's id; null when hidden from the caller. */
  id: string | null;
  title: string;
  status: string;
  due_at: string | null;
  /** True while the linked item is not Done. */
  unresolved: boolean;
}

export interface BlocksLink {
  dependency_id: string;
  /** The waiting task's id; null when hidden from the caller. */
  id: string | null;
  title: string;
  /** The waiting task's status; null when hidden from the caller. */
  status: string | null;
  due_at: string | null;
}

export interface TaskDependencyLinks {
  blocked_by: BlockedByLink[];
  blocks: BlocksLink[];
}

export interface DependencyLinkRow {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  created_at?: string | null;
}

export interface LinkedItemRow {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
}

const UNKNOWN_TASK_TITLE = 'Unknown task';
const UNKNOWN_COMMITMENT_TITLE = 'Unknown commitment';

function compareByDueThenTitle(
  a: { due_at: string | null; title: string },
  b: { due_at: string | null; title: string }
): number {
  if (a.due_at !== b.due_at) {
    if (a.due_at === null) return 1;
    if (b.due_at === null) return -1;
    const diff = Date.parse(a.due_at) - Date.parse(b.due_at);
    if (Number.isFinite(diff) && diff !== 0) return diff;
  }
  return a.title.localeCompare(b.title);
}

/**
 * FamCal view of the linked tasks, built from ONE eligibility-filtered read.
 * - `visibleTasks`: rows read with the personal tag AND famcal_eligible in the
 *   same query (fields and eligibility from the same snapshot).
 * - `hiddenTaskStatus`: status only, for forward links whose target was not in
 *   that read; it only decides "Done or not" on the placeholder, as the task
 *   list already does. No other field of a hidden task is ever read.
 */
export interface FamcalLinkedTasks {
  visibleTasks: LinkedItemRow[];
  hiddenTaskStatus: ReadonlyMap<string, string>;
}

/**
 * Pure: builds blocked_by / blocks for one task.
 *
 * `famcal` is null for every caller except the FamCal key, and then every
 * linked task comes from `tasks` in full. For the FamCal key, `tasks` is
 * ignored: only `famcal.visibleTasks` (FamCal-eligible, which that key can
 * already read by id) keep their fields.
 * - blocked_by: any other linked task, and every commitment, is the
 *   placeholder `redactDependencyForFamcal` uses ("Another task" / "A
 *   commitment"): no id, no title, no due date, status only Done vs not. This
 *   matches the list route, which already shows one redacted row per link.
 * - blocks: a hidden task that waits on this one is left out entirely (no
 *   placeholder, no link id), so the number of hidden waiting tasks never shows.
 */
export function buildTaskDependencyLinks(input: {
  taskId: string;
  outgoing: DependencyLinkRow[];
  incoming: DependencyLinkRow[];
  tasks: LinkedItemRow[];
  commitments: LinkedItemRow[];
  famcal: FamcalLinkedTasks | null;
}): TaskDependencyLinks {
  const famcal = input.famcal;
  const taskById = new Map((famcal ? famcal.visibleTasks : input.tasks).map((row) => [row.id, row]));
  const commitmentById = new Map(input.commitments.map((row) => [row.id, row]));

  const blockedBy: BlockedByLink[] = [];
  for (const row of input.outgoing) {
    if (row.task_id !== input.taskId) continue;

    if (row.depends_on_task_id) {
      const target = taskById.get(row.depends_on_task_id);
      if (famcal && !target) {
        const hiddenStatus = famcal.hiddenTaskStatus.get(row.depends_on_task_id) ?? 'Blocked/Waiting';
        const unresolved = hiddenStatus !== 'Done';
        blockedBy.push({
          dependency_id: row.id,
          type: 'task',
          id: null,
          title: FAMCAL_DEPENDENCY_TASK_TITLE,
          status: unresolved ? 'Blocked/Waiting' : 'Done',
          due_at: null,
          unresolved,
        });
        continue;
      }
      const status = target?.status ?? 'Blocked/Waiting';
      blockedBy.push({
        dependency_id: row.id,
        type: 'task',
        id: row.depends_on_task_id,
        title: target?.title ?? UNKNOWN_TASK_TITLE,
        status,
        due_at: target?.due_at ?? null,
        unresolved: status !== 'Done',
      });
    } else if (row.depends_on_commitment_id) {
      const target = commitmentById.get(row.depends_on_commitment_id);
      const status = target?.status ?? 'Open';
      const unresolved = status !== 'Done';
      if (famcal) {
        blockedBy.push({
          dependency_id: row.id,
          type: 'commitment',
          id: null,
          title: FAMCAL_DEPENDENCY_COMMITMENT_TITLE,
          status: unresolved ? 'Open' : 'Done',
          due_at: null,
          unresolved,
        });
        continue;
      }
      blockedBy.push({
        dependency_id: row.id,
        type: 'commitment',
        id: row.depends_on_commitment_id,
        title: target?.title ?? UNKNOWN_COMMITMENT_TITLE,
        status,
        due_at: target?.due_at ?? null,
        unresolved,
      });
    }
  }

  const blocks: BlocksLink[] = [];
  for (const row of input.incoming) {
    if (row.depends_on_task_id !== input.taskId) continue;
    const waiting = taskById.get(row.task_id);
    if (famcal && !waiting) {
      // Hidden from FamCal: leave it out, so not even the count shows.
      continue;
    }
    blocks.push({
      dependency_id: row.id,
      id: row.task_id,
      title: waiting?.title ?? UNKNOWN_TASK_TITLE,
      status: waiting?.status ?? null,
      due_at: waiting?.due_at ?? null,
    });
  }

  blockedBy.sort((a, b) => {
    if (a.unresolved !== b.unresolved) return a.unresolved ? -1 : 1;
    return compareByDueThenTitle(a, b);
  });
  blocks.sort(compareByDueThenTitle);

  return { blocked_by: blockedBy, blocks };
}

const LINK_ROW_SELECT = 'id, task_id, depends_on_task_id, depends_on_commitment_id, created_at';
const ID_CHUNK_SIZE = 100;

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

// ── Complete reads ────────────────────────────────────────────────────────

/**
 * A read that could not be proven complete (the server returned rows out of
 * the requested order, or the page limit ran out). Callers answer 503 ("try
 * again") instead of acting on a partial list.
 */
export class DependencyReadIncompleteError extends Error {
  constructor() {
    super("Couldn't read all the links between tasks. Try again.");
    this.name = 'DependencyReadIncompleteError';
  }
}

export const DEPENDENCY_PAGE_SIZE = 1000;
const DEPENDENCY_MAX_PAGES = 10000;

type PageResult<T> = { data: T[] | null; error: unknown };

/**
 * Reads every row of a query with keyset paging on the unique `id`:
 * `runPage(afterId, limit)` must build a fresh query with `order('id')`,
 * `gt('id', afterId)` when afterId is set, and `limit(limit)`. It stops only on
 * an EMPTY page, so a server cap below the page size (PostgREST max_rows) still
 * reads everything, and a row deleted mid-read can't shift later rows out of
 * view (as offset paging would). Rows must come back in strictly increasing id
 * order; anything else, or running out of pages, throws
 * DependencyReadIncompleteError. Never returns a short list.
 */
export async function fetchAllPages<T extends { id: string }>(
  runPage: (afterId: string | null, limit: number) => PromiseLike<PageResult<T>>,
  pageSize: number = DEPENDENCY_PAGE_SIZE,
  maxPages: number = DEPENDENCY_MAX_PAGES
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await runPage(afterId, pageSize);
    if (error) throw error;
    const batch = data || [];
    if (batch.length === 0) {
      return rows;
    }
    for (const row of batch) {
      if (typeof row.id !== 'string' || (afterId !== null && !(row.id > afterId))) {
        throw new DependencyReadIncompleteError();
      }
      afterId = row.id;
      rows.push(row);
    }
  }
  throw new DependencyReadIncompleteError();
}

/** The filter calls readActiveLinks callers chain (a narrow view of the PostgREST builder). */
interface LinkQuery {
  eq(column: string, value: unknown): LinkQuery;
  gt(column: string, value: unknown): LinkQuery;
  in(column: string, values: unknown[]): LinkQuery;
  not(column: string, operator: string, value: unknown): LinkQuery;
  order(column: string, options: { ascending: boolean }): LinkQuery;
  limit(count: number): PromiseLike<PageResult<DependencyLinkRow>>;
}

/** All active links matching the caller's extra filters, read completely. */
function readActiveLinks(
  supabase: SupabaseClient,
  userId: string,
  apply: (query: LinkQuery) => LinkQuery,
  select: string = LINK_ROW_SELECT
): Promise<DependencyLinkRow[]> {
  return fetchAllPages<DependencyLinkRow>((afterId, limit) => {
    let query = apply(
      supabase
        .from('task_dependencies')
        .select(select)
        .eq('user_id', userId)
        .eq('is_resolved', false) as unknown as LinkQuery
    );
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit);
  });
}

/**
 * Reads blocked_by / blocks for one task. Pass `famcal: true` only for the
 * FamCal key: linked tasks that key can't read are placeholders (blocked_by)
 * or left out (blocks), and no field of such a task is ever read.
 */
export async function fetchTaskDependencyLinks(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  options: { famcal: boolean }
): Promise<TaskDependencyLinks> {
  const [outgoing, incoming] = await Promise.all([
    readActiveLinks(supabase, userId, (query) => query.eq('task_id', taskId)),
    readActiveLinks(supabase, userId, (query) => query.eq('depends_on_task_id', taskId)),
  ]);

  const forwardTaskIds = [
    ...new Set(outgoing.map((row) => row.depends_on_task_id).filter((value): value is string => Boolean(value))),
  ];
  const linkedTaskIds = [...new Set([...forwardTaskIds, ...incoming.map((row) => row.task_id).filter(Boolean)])];
  const commitmentIds = [
    ...new Set(outgoing.map((row) => row.depends_on_commitment_id).filter((value): value is string => Boolean(value))),
  ];

  if (!options.famcal) {
    const tasks: LinkedItemRow[] = [];
    for (const ids of chunk(linkedTaskIds, ID_CHUNK_SIZE)) {
      const { data, error } = await supabase
        .from('tasks')
        .select('id, title, status, due_at')
        .eq('user_id', userId)
        .in('id', ids);
      if (error) throw error;
      tasks.push(...((data || []) as LinkedItemRow[]));
    }

    const commitments: LinkedItemRow[] = [];
    for (const ids of chunk(commitmentIds, ID_CHUNK_SIZE)) {
      const { data, error } = await supabase
        .from('commitments')
        .select('id, title, status, due_at')
        .eq('user_id', userId)
        .in('id', ids);
      if (error) throw error;
      commitments.push(...((data || []) as LinkedItemRow[]));
    }

    return buildTaskDependencyLinks({ taskId, outgoing, incoming, tasks, commitments, famcal: null });
  }

  // FamCal: fields and eligibility in ONE query (the same personal tag +
  // famcal_eligible filter as every other FamCal read). Visible ids and
  // visible fields both come from these rows.
  const visibleTasks: LinkedItemRow[] = [];
  for (const ids of chunk(linkedTaskIds, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, status, due_at')
      .eq('user_id', userId)
      .in('id', ids)
      .contains('tags', [FAMCAL_REQUIRED_TAG])
      .eq(FAMCAL_ELIGIBLE_FIELD, true);
    if (error) throw error;
    visibleTasks.push(...((data || []) as LinkedItemRow[]));
  }

  // Hidden prerequisites: status only, for the placeholder's Done-or-not.
  const visibleIds = new Set(visibleTasks.map((row) => row.id));
  const hiddenForwardIds = forwardTaskIds.filter((value) => !visibleIds.has(value));
  const hiddenTaskStatus = new Map<string, string>();
  for (const ids of chunk(hiddenForwardIds, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, status')
      .eq('user_id', userId)
      .in('id', ids);
    if (error) throw error;
    for (const row of (data || []) as Array<{ id: string; status: string }>) {
      hiddenTaskStatus.set(row.id, row.status);
    }
  }

  // FamCal never sees commitment details; status only, as the task list does.
  const commitments: LinkedItemRow[] = [];
  for (const ids of chunk(commitmentIds, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('commitments')
      .select('id, status')
      .eq('user_id', userId)
      .in('id', ids);
    if (error) throw error;
    for (const row of (data || []) as Array<{ id: string; status: string }>) {
      commitments.push({ id: row.id, status: row.status, title: '', due_at: null });
    }
  }

  return buildTaskDependencyLinks({
    taskId,
    outgoing,
    incoming,
    tasks: [],
    commitments,
    famcal: { visibleTasks, hiddenTaskStatus },
  });
}

// ── Project view ──────────────────────────────────────────────────────────

export interface ProjectDependencyLink {
  dependency_id: string;
  /** The task that waits. */
  task_id: string;
  task_title: string;
  /** The task it waits on. */
  depends_on_task_id: string;
  depends_on_title: string;
}

/** Pure: active task→task links whose two ends are both in the given task list. */
export function buildProjectDependencyLinks(
  tasks: Array<{ id: string; title: string }>,
  rows: DependencyLinkRow[]
): ProjectDependencyLink[] {
  const titleById = new Map(tasks.map((task) => [task.id, task.title]));
  const seen = new Set<string>();
  const links: ProjectDependencyLink[] = [];
  for (const row of rows) {
    if (!row.depends_on_task_id || seen.has(row.id)) continue;
    const taskTitle = titleById.get(row.task_id);
    const dependsOnTitle = titleById.get(row.depends_on_task_id);
    if (taskTitle === undefined || dependsOnTitle === undefined) continue;
    seen.add(row.id);
    links.push({
      dependency_id: row.id,
      task_id: row.task_id,
      task_title: taskTitle,
      depends_on_task_id: row.depends_on_task_id,
      depends_on_title: dependsOnTitle,
    });
  }
  links.sort((a, b) => a.depends_on_title.localeCompare(b.depends_on_title) || a.task_title.localeCompare(b.task_title));
  return links;
}

/** Reads every active link among a project's tasks (all statuses); every read is paged to completion. */
export async function fetchProjectDependencyLinks(
  supabase: SupabaseClient,
  userId: string,
  projectId: string
): Promise<ProjectDependencyLink[]> {
  const tasks = await fetchAllPages<{ id: string; title: string }>((afterId, limit) => {
    let query = supabase
      .from('tasks')
      .select('id, title')
      .eq('user_id', userId)
      .eq('project_id', projectId);
    if (afterId !== null) query = query.gt('id', afterId);
    return query.order('id', { ascending: true }).limit(limit) as unknown as PromiseLike<
      PageResult<{ id: string; title: string }>
    >;
  });

  if (tasks.length === 0) {
    return [];
  }

  const rows: DependencyLinkRow[] = [];
  for (const ids of chunk(tasks.map((task) => task.id), ID_CHUNK_SIZE)) {
    rows.push(
      ...(await readActiveLinks(supabase, userId, (query) => query.not('depends_on_task_id', 'is', null).in('task_id', ids)))
    );
  }

  return buildProjectDependencyLinks(tasks, rows);
}

// ── Cycle check ───────────────────────────────────────────────────────────

export class DependencyGraphTooLargeError extends Error {
  constructor() {
    super('Too many linked tasks to check this link for a loop');
    this.name = 'DependencyGraphTooLargeError';
  }
}

export const DEPENDENCY_CYCLE_MAX_TASKS = 5000;

/**
 * Pure graph walk with an injected loader. Starting at `startTaskId`, follows
 * "waits on" links (task_id → depends_on_task_id) and returns the first path
 * that reaches `targetTaskId` as a list of task ids [start, …, target], or null
 * when the target can't be reached. Each task is visited once, so existing
 * loops in the data end the walk instead of spinning.
 *
 * Adding "A waits on B" makes a loop exactly when B already (directly or
 * through other tasks) waits on A, so callers ask for a path from B to A.
 */
export async function findDependencyPath(
  startTaskId: string,
  targetTaskId: string,
  loadWaitsOn: (taskIds: string[]) => Promise<Array<{ task_id: string; depends_on_task_id: string | null }>>,
  maxTasks: number = DEPENDENCY_CYCLE_MAX_TASKS
): Promise<string[] | null> {
  if (startTaskId === targetTaskId) {
    return [startTaskId];
  }

  const parent = new Map<string, string | null>([[startTaskId, null]]);
  let frontier = [startTaskId];

  while (frontier.length > 0) {
    const edges = await loadWaitsOn(frontier);
    const next: string[] = [];
    for (const edge of edges) {
      const to = edge.depends_on_task_id;
      if (!to || !parent.has(edge.task_id) || parent.has(to)) continue;
      parent.set(to, edge.task_id);
      if (to === targetTaskId) {
        const path: string[] = [];
        let cursor: string | null = to;
        while (cursor !== null) {
          path.unshift(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        return path;
      }
      if (parent.size > maxTasks) {
        throw new DependencyGraphTooLargeError();
      }
      next.push(to);
    }
    frontier = next;
  }

  return null;
}

/**
 * Loader for findDependencyPath over the user's active task→task links. Each
 * frontier chunk is read to completion (fetchAllPages); a read that can't be
 * proven complete throws DependencyReadIncompleteError, so the loop check
 * refuses the add rather than answering "no path" from a partial graph.
 */
export function makeWaitsOnLoader(supabase: SupabaseClient, userId: string) {
  return async (taskIds: string[]) => {
    const edges: Array<{ task_id: string; depends_on_task_id: string | null }> = [];
    for (const ids of chunk(taskIds, ID_CHUNK_SIZE)) {
      const rows = await readActiveLinks(
        supabase,
        userId,
        (query) => query.not('depends_on_task_id', 'is', null).in('task_id', ids),
        'id, task_id, depends_on_task_id'
      );
      edges.push(...rows.map((row) => ({ task_id: row.task_id, depends_on_task_id: row.depends_on_task_id })));
    }
    return edges;
  };
}

/** Plain-English refusal for a link that would make a loop. */
export function describeDependencyCycle(input: {
  taskTitle: string;
  dependsOnTitle: string;
  path: string[];
}): string {
  // path runs from the would-be prerequisite back to the waiting task.
  const between = Math.max(0, input.path.length - 2);
  const via = between === 0 ? '' : between === 1 ? ' through 1 other task' : ` through ${between} other tasks`;
  return `That would make a loop: "${input.dependsOnTitle}" already waits on "${input.taskTitle}"${via}. Remove one of those links first.`;
}
