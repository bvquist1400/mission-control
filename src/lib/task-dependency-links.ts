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
 * Pure: builds blocked_by / blocks for one task.
 *
 * `famcalVisibleTaskIds` is null for every caller except the FamCal key. For
 * the FamCal key it is the set of linked task ids that are FamCal-eligible
 * (`famcal_eligible`, migration 060), which that key can already read by id.
 * Every other linked task, and every commitment, is reduced to the same
 * placeholder `redactDependencyForFamcal` uses ("Another task" / "A
 * commitment"): no id, no title, no due date, and a status that only repeats
 * `unresolved` (blocked_by) or nothing at all (blocks).
 */
export function buildTaskDependencyLinks(input: {
  taskId: string;
  outgoing: DependencyLinkRow[];
  incoming: DependencyLinkRow[];
  tasks: LinkedItemRow[];
  commitments: LinkedItemRow[];
  famcalVisibleTaskIds: ReadonlySet<string> | null;
}): TaskDependencyLinks {
  const taskById = new Map(input.tasks.map((row) => [row.id, row]));
  const commitmentById = new Map(input.commitments.map((row) => [row.id, row]));
  const famcal = input.famcalVisibleTaskIds;

  const blockedBy: BlockedByLink[] = [];
  for (const row of input.outgoing) {
    if (row.task_id !== input.taskId) continue;

    if (row.depends_on_task_id) {
      const target = taskById.get(row.depends_on_task_id);
      const status = target?.status ?? 'Blocked/Waiting';
      const unresolved = status !== 'Done';
      if (famcal && !famcal.has(row.depends_on_task_id)) {
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
      blockedBy.push({
        dependency_id: row.id,
        type: 'task',
        id: row.depends_on_task_id,
        title: target?.title ?? UNKNOWN_TASK_TITLE,
        status,
        due_at: target?.due_at ?? null,
        unresolved,
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
    if (famcal && !famcal.has(row.task_id)) {
      blocks.push({
        dependency_id: row.id,
        id: null,
        title: FAMCAL_DEPENDENCY_TASK_TITLE,
        status: null,
        due_at: null,
      });
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

/**
 * Reads blocked_by / blocks for one task. Pass `famcal: true` only for the
 * FamCal key: linked tasks that key can't see come back as placeholders.
 */
export async function fetchTaskDependencyLinks(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  options: { famcal: boolean }
): Promise<TaskDependencyLinks> {
  const [outgoingResult, incomingResult] = await Promise.all([
    supabase
      .from('task_dependencies')
      .select(LINK_ROW_SELECT)
      .eq('user_id', userId)
      .eq('task_id', taskId)
      .eq('is_resolved', false),
    supabase
      .from('task_dependencies')
      .select(LINK_ROW_SELECT)
      .eq('user_id', userId)
      .eq('depends_on_task_id', taskId)
      .eq('is_resolved', false),
  ]);

  if (outgoingResult.error) throw outgoingResult.error;
  if (incomingResult.error) throw incomingResult.error;

  const outgoing = (outgoingResult.data || []) as DependencyLinkRow[];
  const incoming = (incomingResult.data || []) as DependencyLinkRow[];

  const linkedTaskIds = [
    ...new Set([
      ...outgoing.map((row) => row.depends_on_task_id).filter((value): value is string => Boolean(value)),
      ...incoming.map((row) => row.task_id).filter(Boolean),
    ]),
  ];
  const commitmentIds = [
    ...new Set(outgoing.map((row) => row.depends_on_commitment_id).filter((value): value is string => Boolean(value))),
  ];

  const tasks: LinkedItemRow[] = [];
  const famcalVisible = options.famcal ? new Set<string>() : null;
  for (const ids of chunk(linkedTaskIds, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, status, due_at')
      .eq('user_id', userId)
      .in('id', ids);
    if (error) throw error;
    tasks.push(...((data || []) as LinkedItemRow[]));

    if (famcalVisible) {
      // Same filter as every other FamCal read: the personal tag and famcal_eligible.
      const { data: visible, error: visibleError } = await supabase
        .from('tasks')
        .select('id')
        .eq('user_id', userId)
        .in('id', ids)
        .contains('tags', [FAMCAL_REQUIRED_TAG])
        .eq(FAMCAL_ELIGIBLE_FIELD, true);
      if (visibleError) throw visibleError;
      for (const row of (visible || []) as Array<{ id: string }>) {
        famcalVisible.add(row.id);
      }
    }
  }

  const commitments: LinkedItemRow[] = [];
  if (!options.famcal) {
    for (const ids of chunk(commitmentIds, ID_CHUNK_SIZE)) {
      const { data, error } = await supabase
        .from('commitments')
        .select('id, title, status, due_at')
        .eq('user_id', userId)
        .in('id', ids);
      if (error) throw error;
      commitments.push(...((data || []) as LinkedItemRow[]));
    }
  } else {
    // FamCal never sees commitment details, but the placeholder status still
    // says whether the commitment is Done, as the task list does.
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
  }

  return buildTaskDependencyLinks({
    taskId,
    outgoing,
    incoming,
    tasks,
    commitments,
    famcalVisibleTaskIds: famcalVisible,
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

const PROJECT_TASK_PAGE_SIZE = 1000;

/** Reads every active link among a project's tasks (all statuses), paging the task read. */
export async function fetchProjectDependencyLinks(
  supabase: SupabaseClient,
  userId: string,
  projectId: string
): Promise<ProjectDependencyLink[]> {
  const tasks: Array<{ id: string; title: string }> = [];
  for (let from = 0; ; from += PROJECT_TASK_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .order('id', { ascending: true })
      .range(from, from + PROJECT_TASK_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data || []) as Array<{ id: string; title: string }>;
    tasks.push(...page);
    if (page.length < PROJECT_TASK_PAGE_SIZE) break;
  }

  if (tasks.length === 0) {
    return [];
  }

  const rows: DependencyLinkRow[] = [];
  for (const ids of chunk(tasks.map((task) => task.id), ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('task_dependencies')
      .select(LINK_ROW_SELECT)
      .eq('user_id', userId)
      .eq('is_resolved', false)
      .not('depends_on_task_id', 'is', null)
      .in('task_id', ids);
    if (error) throw error;
    rows.push(...((data || []) as DependencyLinkRow[]));
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

/** Loader for findDependencyPath over the user's active task→task links. */
export function makeWaitsOnLoader(supabase: SupabaseClient, userId: string) {
  return async (taskIds: string[]) => {
    const edges: Array<{ task_id: string; depends_on_task_id: string | null }> = [];
    for (const ids of chunk(taskIds, ID_CHUNK_SIZE)) {
      const { data, error } = await supabase
        .from('task_dependencies')
        .select('task_id, depends_on_task_id')
        .eq('user_id', userId)
        .eq('is_resolved', false)
        .not('depends_on_task_id', 'is', null)
        .in('task_id', ids);
      if (error) throw error;
      edges.push(...((data || []) as Array<{ task_id: string; depends_on_task_id: string | null }>));
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
