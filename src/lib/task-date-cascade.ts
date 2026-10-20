import type { SupabaseClient } from '@supabase/supabase-js';
import { addDateOnlyDays, getDateOnlyWeekday } from '@/lib/date-only';
import { FAMCAL_ELIGIBLE_FIELD, FAMCAL_REQUIRED_TAG } from '@/lib/famcal-api-key';
import { getHighPriorityStakeholderNames, recalculateTaskPriority } from '@/lib/priority';
import { fetchAllPages } from '@/lib/task-dependency-links';
import type { Task } from '@/types/database';

/**
 * Cascade due dates (Baseline task 6fcad51b, slice S1).
 *
 * When a task's due date moves LATER, the tasks that wait on it (task_dependencies,
 * active links, task → task only) can move too. TypeScript plans the moves here;
 * one Postgres function (migration 061, apply_task_date_cascade) applies them
 * all-or-nothing with a compare-and-set per task and writes one system comment
 * per moved task plus the log Undo will use.
 *
 * Brent's rules (comment cae08d4f, 10/19):
 * - Modes, chosen each time: `same_gap` (default: move the rest by the same number
 *   of working days) or `only_collisions` (move only a task that would now be due
 *   before a task it waits on, to that task's new day). "Just this task" is
 *   `cascade: false`.
 * - Working days are Mon–Fri on the ET date; each task keeps its own ET time of
 *   day. No holidays in v1.
 * - Only later moves cascade; nothing is pulled earlier. Only due_at moves
 *   (follow_up_at never does).
 * - Stop at Done (nothing after a finished step moves). Missed and recurring
 *   tasks (templates and generated instances) never move and also end the walk.
 *   Parked tasks and tasks with no due date never move, but the walk goes through
 *   them to the tasks after them.
 * - Each task is visited once per cascade (cycles and diamonds end), the walk
 *   stops after CASCADE_MAX_DEPTH steps, and more than CASCADE_CONFIRM_THRESHOLD
 *   moves need cascade_confirm (the FamCal key can't confirm: it moves only the
 *   root then and says so in a comment).
 * - Floor: a moved task is never left due before a task it waits on that moved
 *   in this cascade (it goes to the same ET day).
 * - FamCal: only FamCal-eligible tasks are read or moved (the eligibility filter
 *   is in the same query as the fields, and the SQL function re-checks it under
 *   the row lock). A task the key can't see ends the walk and is never named.
 */

export const CASCADE_TIME_ZONE = 'America/New_York';
export const CASCADE_MODES = ['same_gap', 'only_collisions'] as const;
export type CascadeMode = (typeof CASCADE_MODES)[number];
export const DEFAULT_CASCADE_MODE: CascadeMode = 'same_gap';
/** More moves than this need cascade_confirm: true (else 409 with the preview). */
export const CASCADE_CONFIRM_THRESHOLD = 25;
/** Steps away from the edited task the walk goes before it stops. */
export const CASCADE_MAX_DEPTH = 20;
/** Tasks the walk may reach at all; past this the cascade is refused outright. */
export const CASCADE_MAX_TASKS = 500;
export const CASCADE_APPLY_RPC = 'apply_task_date_cascade';
/** S2 (migration 062): Undo and "switch how far" / "try again". */
export const CASCADE_UNDO_RPC = 'undo_task_date_cascade';
export const CASCADE_REPLACE_RPC = 'replace_task_date_cascade';
/** Database errors a cascade call may simply be retried after (it rolled back): a deadlock, or 062's "a task changed project while the locks were taken". */
export const CASCADE_RETRYABLE_CODES: ReadonlyArray<string> = ['40P01', 'MC062'];
/** Errors that mean "Baseline was busy" to the person (lock wait past lock_timeout, a cancelled statement, a deadlock). */
export const CASCADE_BUSY_CODES: ReadonlyArray<string> = ['55P03', '57014', '40P01', 'MC062'];
/** How many times a retryable cascade call is attempted in all. */
export const CASCADE_MAX_ATTEMPTS = 3;
export const CASCADE_MOVABLE_STATUSES: ReadonlyArray<string> = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting'];

// ── ET date math ─────────────────────────────────────────────────────────

interface EtParts {
  date: string;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CASCADE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function etPartsOfMs(ms: number): EtParts {
  const values = Object.fromEntries(etFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The ET calendar date (YYYY-MM-DD) of an instant, or null when it isn't a timestamp. */
export function etDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = parseInstant(iso);
  return ms === null ? null : etPartsOfMs(ms).date;
}

function offsetMs(ms: number): number {
  const parts = etPartsOfMs(ms);
  const [year, month, day] = parts.date.split('-').map(Number);
  const represented = Date.UTC(year, month - 1, day, parts.hour, parts.minute, parts.second, parts.millisecond);
  return represented - ms;
}

/**
 * The same ET wall-clock time as `iso`, on the ET date `dateOnly` (DST-correct;
 * a time that doesn't exist that day lands on the nearest real instant).
 */
export function withEtDate(iso: string, dateOnly: string): string {
  const ms = parseInstant(iso);
  if (ms === null) throw new Error(`Invalid timestamp: ${iso}`);
  const parts = etPartsOfMs(ms);
  const [year, month, day] = dateOnly.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let candidate = localAsUtc - offsetMs(localAsUtc);
  candidate = localAsUtc - offsetMs(candidate);
  return new Date(candidate).toISOString();
}

export function isWeekdayDate(dateOnly: string): boolean {
  const weekday = getDateOnlyWeekday(dateOnly);
  return weekday !== null && weekday !== 0 && weekday !== 6;
}

/** Weekdays d with from < d ≤ to (0 when `to` isn't after `from`). Fri→Mon is 1; Sat→Sun is 0. */
export function workdaysBetween(from: string, to: string): number {
  if (!(to > from)) return 0;
  let count = 0;
  let cursor = from;
  // Bounded: dates are a few weeks apart in practice; cap at ~30 years.
  for (let step = 0; step < 11000 && cursor < to; step += 1) {
    const next = addDateOnlyDays(cursor, 1);
    if (!next) break;
    cursor = next;
    if (isWeekdayDate(cursor)) count += 1;
  }
  return count;
}

/** The date `n` working days after `dateOnly` (each step lands on the next Mon–Fri). */
export function addWorkdays(dateOnly: string, n: number): string {
  let cursor = dateOnly;
  for (let added = 0; added < n; ) {
    const next = addDateOnlyDays(cursor, 1);
    if (!next) throw new Error(`Invalid date: ${dateOnly}`);
    cursor = next;
    if (isWeekdayDate(cursor)) added += 1;
  }
  return cursor;
}

/** `iso` moved by `n` working days on its ET date, keeping its ET time of day. */
export function shiftByWorkdays(iso: string, n: number): string {
  const date = etDateOf(iso);
  if (!date) throw new Error(`Invalid timestamp: ${iso}`);
  return n <= 0 ? iso : withEtDate(iso, addWorkdays(date, n));
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Thu 10/22" for an instant's ET date. */
export function formatEtDay(iso: string): string {
  const date = etDateOf(iso);
  if (!date) return iso;
  const weekday = getDateOnlyWeekday(date);
  return `${WEEKDAY_NAMES[weekday ?? 0]} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

// ── Options ──────────────────────────────────────────────────────────────

export interface CascadeOptions {
  /** false = "just this task"; 'preview' = plan only, write nothing. */
  cascade: true | false | 'preview';
  mode: CascadeMode;
  confirm: boolean;
  /**
   * `cascade_quiet: true` (the grid's bulk date set; not offered over MCP): just
   * this task AND no project flag when it lands past its project's target date.
   */
  quiet: boolean;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Reads `cascade`, `cascade_mode` and `cascade_confirm` from a PATCH body. All
 * three are optional; the default is a same-gap cascade. (The FamCal key never
 * sends them: its body allowlist refuses any other key.)
 */
export function parseCascadeOptions(body: Record<string, unknown>): ParseResult<CascadeOptions> {
  const raw = body.cascade;
  let cascade: CascadeOptions['cascade'] = true;
  if (raw !== undefined && raw !== null) {
    if (raw === true || raw === false || raw === 'preview') {
      cascade = raw;
    } else {
      return { ok: false, error: 'cascade must be true, false or "preview"' };
    }
  }

  const rawMode = body.cascade_mode;
  let mode: CascadeMode = DEFAULT_CASCADE_MODE;
  if (rawMode !== undefined && rawMode !== null) {
    if (typeof rawMode !== 'string' || !(CASCADE_MODES as ReadonlyArray<string>).includes(rawMode)) {
      return { ok: false, error: `cascade_mode must be one of: ${CASCADE_MODES.join(', ')}` };
    }
    mode = rawMode as CascadeMode;
  }

  const rawConfirm = body.cascade_confirm;
  if (rawConfirm !== undefined && rawConfirm !== null && typeof rawConfirm !== 'boolean') {
    return { ok: false, error: 'cascade_confirm must be true or false' };
  }

  if (cascade === 'preview' && !('due_at' in body)) {
    return { ok: false, error: 'cascade: "preview" needs a due_at to preview' };
  }

  const rawQuiet = body.cascade_quiet;
  if (rawQuiet !== undefined && rawQuiet !== null && typeof rawQuiet !== 'boolean') {
    return { ok: false, error: 'cascade_quiet must be true or false' };
  }
  const quiet = rawQuiet === true;
  if (quiet && cascade === 'preview') {
    return { ok: false, error: 'cascade_quiet can\'t be combined with cascade: "preview"' };
  }

  return { ok: true, value: { cascade: quiet ? false : cascade, mode, confirm: rawConfirm === true, quiet } };
}

// ── When a cascade runs at all ───────────────────────────────────────────

export type CascadeNotRunReason =
  | 'off'
  | 'no_change'
  | 'cleared'
  | 'earlier'
  | 'same_day'
  | 'no_previous_date'
  | 'done'
  | 'recurring';

interface RootTaskShape {
  status: string;
  due_at: string | null;
  is_recurring_template?: boolean | null;
  recurring_template_id?: string | null;
}

export function isRecurringTask(task: { is_recurring_template?: boolean | null; recurring_template_id?: string | null }): boolean {
  return Boolean(task.is_recurring_template) || Boolean(task.recurring_template_id);
}

/**
 * Whether moving `before` to `after` (the same task, after the PATCH's other
 * changes) should cascade, and the working-day gap when it should.
 */
export function cascadeTrigger(
  before: RootTaskShape,
  after: RootTaskShape,
  mode: CascadeMode
): { run: true; deltaWorkdays: number } | { run: false; reason: CascadeNotRunReason } {
  const oldDue = before.due_at;
  const newDue = after.due_at;
  if (!newDue) return { run: false, reason: 'cleared' };
  if (isRecurringTask(before) || isRecurringTask(after)) return { run: false, reason: 'recurring' };
  if (after.status === 'Done') return { run: false, reason: 'done' };
  const newDate = etDateOf(newDue);
  if (!newDate) return { run: false, reason: 'no_change' };
  if (!oldDue) {
    // A first due date has no gap to repeat; it can still collide.
    return mode === 'only_collisions' ? { run: true, deltaWorkdays: 0 } : { run: false, reason: 'no_previous_date' };
  }
  const oldDate = etDateOf(oldDue);
  if (!oldDate) return { run: false, reason: 'no_previous_date' };
  if (Date.parse(newDue) === Date.parse(oldDue)) return { run: false, reason: 'no_change' };
  if (newDate < oldDate) return { run: false, reason: 'earlier' };
  if (newDate === oldDate) return { run: false, reason: 'same_day' };
  const deltaWorkdays = workdaysBetween(oldDate, newDate);
  if (mode === 'same_gap' && deltaWorkdays === 0) {
    // e.g. Sat → Sun: later on the calendar, but no working day passed. Collisions still can.
    return { run: false, reason: 'same_day' };
  }
  return { run: true, deltaWorkdays };
}

// ── Graph ────────────────────────────────────────────────────────────────

export type CascadeSkipReason = 'done' | 'missed' | 'recurring' | 'parked' | 'no_due_date' | 'not_needed' | 'other_status';
/** Reasons the SQL function adds when it skips a planned move: the task changed, or a task on its planned path did (062). */
export type CascadeApplySkipReason = 'changed' | 'path_changed';

export type CascadeTaskRow = Pick<
  Task,
  'id' | 'title' | 'status' | 'due_at' | 'project_id' | 'is_recurring_template' | 'recurring_template_id'
> &
  Partial<Task>;

export type CascadeNodeKind = 'movable' | 'pass_through' | 'stop';

/** What the walk does with a task it reaches (the edited task itself is never classified). */
export function classifyCascadeTask(task: CascadeTaskRow): { kind: CascadeNodeKind; reason: CascadeSkipReason | null } {
  if (task.status === 'Done') return { kind: 'stop', reason: 'done' };
  if (isRecurringTask(task)) return { kind: 'stop', reason: 'recurring' };
  if (task.status === 'Missed') return { kind: 'stop', reason: 'missed' };
  if (task.status === 'Parked') return { kind: 'pass_through', reason: 'parked' };
  if (!task.due_at || !etDateOf(task.due_at)) return { kind: 'pass_through', reason: 'no_due_date' };
  if (CASCADE_MOVABLE_STATUSES.includes(task.status)) return { kind: 'movable', reason: null };
  return { kind: 'stop', reason: 'other_status' };
}

export interface CascadeEdge {
  /** The task that waits. */
  task_id: string;
  /** The task it waits on. */
  depends_on_task_id: string;
}

export interface CascadeGraph {
  rootId: string;
  /** Every task the walk reached (not the root), with its depth (1 = waits on the root directly). */
  tasks: Map<string, CascadeTaskRow & { depth: number }>;
  /** Active links whose two ends are the root or reached tasks. */
  edges: CascadeEdge[];
  /** Tasks found past CASCADE_MAX_DEPTH (not read, not moved). */
  depthLimited: number;
  /** The walk reached more than CASCADE_MAX_TASKS tasks and stopped. */
  tooLarge: boolean;
}

/**
 * At most this many `via` ids (path tasks, summed over the moves) in one cascade.
 * A plan over it is refused as too large (nothing saved; "just this task" still
 * works) rather than sent without its path checks.
 */
export const CASCADE_MAX_VIA_IDS = 20000;

export interface CascadeMove {
  task_id: string;
  title: string;
  old_due_at: string;
  new_due_at: string;
  depth: number;
  project_id: string | null;
  /** True when the floor (a task it waits on moved further) pushed it past the gap. */
  floor_raised: boolean;
  /**
   * The tasks between this one and the edited task on its planned path(s) (not
   * the edited task). The function skips the move when one of them became Done,
   * Missed or recurring (or, for FamCal, hidden) after planning (062).
   */
  via: string[];
}

export interface CascadeSkip {
  task_id: string;
  title: string;
  reason: CascadeSkipReason;
}

export interface CascadePlan {
  mode: CascadeMode;
  deltaWorkdays: number;
  rootOldDueAt: string | null;
  rootNewDueAt: string;
  moves: CascadeMove[];
  skipped: CascadeSkip[];
  depthLimited: number;
  tooLarge: boolean;
  /** Why it is too large: more than CASCADE_MAX_TASKS tasks, or too many links between them (path ids over CASCADE_MAX_VIA_IDS). */
  tooLargeReason: 'tasks' | 'links' | null;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Pure: the moves for one cascade. Effective ET dates flow along the links:
 * the root's new date; a moved task's new date; a pass-through task (Parked, no
 * date) carries the latest date of the tasks before it. A task that didn't move
 * passes nothing on, so `only_collisions` never "fixes" a gap that was already
 * there before this move. Values only ever rise, so the loop ends; it is also
 * capped at one pass per task.
 */
export function planTaskDateCascade(input: {
  graph: CascadeGraph;
  mode: CascadeMode;
  deltaWorkdays: number;
  rootOldDueAt: string | null;
  rootNewDueAt: string;
}): CascadePlan {
  const { graph, mode, deltaWorkdays } = input;
  const rootDate = etDateOf(input.rootNewDueAt);
  const order = [...graph.tasks.values()].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kinds = new Map(order.map((task) => [task.id, classifyCascadeTask(task)]));

  const prerequisites = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.task_id === graph.rootId || !graph.tasks.has(edge.task_id)) continue;
    if (edge.depends_on_task_id !== graph.rootId) {
      const kind = kinds.get(edge.depends_on_task_id)?.kind;
      if (!kind || kind === 'stop') continue;
    }
    const list = prerequisites.get(edge.task_id) || [];
    if (!list.includes(edge.depends_on_task_id)) list.push(edge.depends_on_task_id);
    prerequisites.set(edge.task_id, list);
  }

  const effective = new Map<string, string | null>([[graph.rootId, rootDate]]);
  const newDue = new Map<string, string>();
  const floorRaised = new Set<string>();

  const floorFor = (taskId: string): string | null => {
    let floor: string | null = null;
    for (const prerequisite of prerequisites.get(taskId) || []) {
      floor = maxDate(floor, effective.get(prerequisite) ?? null);
    }
    return floor;
  };

  for (let pass = 0, changed = true; changed && pass <= order.length + 1; pass += 1) {
    changed = false;
    for (const task of order) {
      const kind = kinds.get(task.id)!.kind;
      if (kind === 'stop') continue;
      const floor = floorFor(task.id);
      let next: string | null;
      if (kind === 'pass_through') {
        next = floor;
      } else {
        const oldDue = task.due_at as string;
        const oldDate = etDateOf(oldDue)!;
        let candidate = mode === 'same_gap' ? shiftByWorkdays(oldDue, deltaWorkdays) : oldDue;
        let raised = false;
        if (floor && etDateOf(candidate)! < floor) {
          candidate = withEtDate(oldDue, floor);
          raised = true;
        }
        // same_gap moves everything it reaches; only_collisions only what landed before its floor.
        const moves = mode === 'same_gap' ? etDateOf(candidate)! > oldDate : raised;
        if (moves) {
          const previous = newDue.get(task.id);
          if (previous !== candidate) {
            newDue.set(task.id, candidate);
            if (raised && mode === 'same_gap') floorRaised.add(task.id);
            changed = true;
          }
          next = etDateOf(candidate);
        } else {
          next = null;
        }
      }
      if ((effective.get(task.id) ?? null) !== next) {
        effective.set(task.id, next);
        changed = true;
      }
    }
  }

  // The tasks each move's date came through: prerequisites that carried a date
  // (effective non-null), transitively, back to the root.
  const viaCache = new Map<string, Set<string>>();
  const viaOf = (taskId: string, stack: Set<string>): Set<string> => {
    const cached = viaCache.get(taskId);
    if (cached) return cached;
    const out = new Set<string>();
    if (stack.has(taskId)) return out;
    stack.add(taskId);
    for (const prerequisite of prerequisites.get(taskId) || []) {
      if (prerequisite === graph.rootId || (effective.get(prerequisite) ?? null) === null) continue;
      out.add(prerequisite);
      for (const id of viaOf(prerequisite, stack)) out.add(id);
    }
    stack.delete(taskId);
    viaCache.set(taskId, out);
    return out;
  };

  const moves: CascadeMove[] = [];
  const skipped: CascadeSkip[] = [];
  for (const task of order) {
    const { kind, reason } = kinds.get(task.id)!;
    const moved = newDue.get(task.id);
    if (kind === 'movable' && moved) {
      moves.push({
        task_id: task.id,
        title: task.title,
        old_due_at: task.due_at as string,
        new_due_at: moved,
        depth: task.depth,
        project_id: task.project_id ?? null,
        floor_raised: floorRaised.has(task.id),
        via: [...viaOf(task.id, new Set())].sort(),
      });
    } else {
      skipped.push({ task_id: task.id, title: task.title, reason: reason ?? 'not_needed' });
    }
  }

  const viaTotal = moves.reduce((sum, move) => sum + move.via.length, 0);
  const tooLargeReason = graph.tooLarge ? 'tasks' : viaTotal > CASCADE_MAX_VIA_IDS ? 'links' : null;
  return {
    mode,
    deltaWorkdays,
    rootOldDueAt: input.rootOldDueAt,
    rootNewDueAt: input.rootNewDueAt,
    moves,
    skipped,
    depthLimited: graph.depthLimited,
    tooLarge: tooLargeReason !== null,
    tooLargeReason,
  };
}

// ── Reading the graph ────────────────────────────────────────────────────

const ID_CHUNK_SIZE = 100;

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

/** FamCal link read: the waiting task joined (inner) so its eligibility filters the links themselves. */
export const FAMCAL_LINK_SELECT = 'id, task_id, depends_on_task_id, waiting:tasks!task_dependencies_blocked_task_id_fkey!inner(id)';

interface PagedQuery {
  contains(column: string, value: unknown[]): PagedQuery;
  eq(column: string, value: unknown): PagedQuery;
  gt(column: string, value: unknown): PagedQuery;
  in(column: string, values: unknown[]): PagedQuery;
  not(column: string, operator: string, value: unknown): PagedQuery;
  order(column: string, options: { ascending: boolean }): PagedQuery;
  limit(count: number): PromiseLike<{ data: Array<{ id: string; task_id: string; depends_on_task_id: string | null }> | null; error: unknown }>;
}

/**
 * Walks "who waits on this" links out from the root, one level at a time, and
 * reads each reached task. With `famcal`, the task read carries the personal
 * tag + famcal_eligible filter in the same query: a task the key can't see is
 * simply not reached (its row never leaves the database) and the walk does not
 * go past it. Every link read is paged to an empty page (fetchAllPages).
 */
export async function loadCascadeGraph(
  supabase: SupabaseClient,
  userId: string,
  rootId: string,
  options: { famcal: boolean; maxDepth?: number; maxTasks?: number }
): Promise<CascadeGraph> {
  const maxDepth = options.maxDepth ?? CASCADE_MAX_DEPTH;
  const maxTasks = options.maxTasks ?? CASCADE_MAX_TASKS;
  const tasks = new Map<string, CascadeTaskRow & { depth: number }>();
  const edges: CascadeEdge[] = [];
  const seenEdges = new Set<string>();
  let frontier = [rootId];
  let depthLimited = 0;
  let tooLarge = false;

  for (let depth = 1; frontier.length > 0; depth += 1) {
    const frontierSet = new Set(frontier);
    const rows: Array<{ id: string; task_id: string; depends_on_task_id: string | null }> = [];
    for (const ids of chunk(frontier, ID_CHUNK_SIZE)) {
      rows.push(
        ...(await fetchAllPages((afterId, limit) => {
          let query = supabase
            .from('task_dependencies')
            .select(options.famcal ? FAMCAL_LINK_SELECT : 'id, task_id, depends_on_task_id')
            .eq('user_id', userId)
            .eq('is_resolved', false)
            .in('depends_on_task_id', ids) as unknown as PagedQuery;
          if (options.famcal) {
            // FamCal: only links whose WAITING task it may see, filtered in the
            // database (inner join), so hidden tasks are never paged, counted
            // toward the limits, or able to change what FamCal observes.
            query = query.contains('waiting.tags', [FAMCAL_REQUIRED_TAG]).eq(`waiting.${FAMCAL_ELIGIBLE_FIELD}`, true);
          }
          if (afterId !== null) query = query.gt('id', afterId);
          return query.order('id', { ascending: true }).limit(limit);
        }))
      );
    }

    const newIds: string[] = [];
    const pendingEdges: CascadeEdge[] = [];
    for (const row of rows) {
      // Only links that really point at this frontier (defence against a loose filter).
      if (!row.depends_on_task_id || !frontierSet.has(row.depends_on_task_id) || !row.task_id) continue;
      if (row.task_id === row.depends_on_task_id) continue;
      pendingEdges.push({ task_id: row.task_id, depends_on_task_id: row.depends_on_task_id });
      if (row.task_id !== rootId && !tasks.has(row.task_id) && !newIds.includes(row.task_id)) newIds.push(row.task_id);
    }

    if (depth > maxDepth) {
      depthLimited = newIds.length;
      // Links back into tasks already reached still count (diamonds, loops).
      for (const edge of pendingEdges) {
        if (edge.task_id === rootId || tasks.has(edge.task_id)) addEdge(edge);
      }
      break;
    }

    if (tasks.size + newIds.length > maxTasks) {
      tooLarge = true;
      break;
    }

    for (const ids of chunk(newIds, ID_CHUNK_SIZE)) {
      let query = supabase.from('tasks').select('*').eq('user_id', userId).in('id', ids);
      if (options.famcal) {
        query = query.contains('tags', [FAMCAL_REQUIRED_TAG]).eq(FAMCAL_ELIGIBLE_FIELD, true);
      }
      const { data, error } = await query;
      if (error) throw error;
      for (const row of (data || []) as CascadeTaskRow[]) {
        if (!ids.includes(row.id)) continue;
        tasks.set(row.id, { ...row, depth });
      }
    }

    for (const edge of pendingEdges) {
      if (edge.task_id === rootId || tasks.has(edge.task_id)) addEdge(edge);
    }

    const next: string[] = [];
    for (const taskId of newIds) {
      const task = tasks.get(taskId);
      if (task && classifyCascadeTask(task).kind !== 'stop') next.push(taskId);
    }
    frontier = next;
  }

  function addEdge(edge: CascadeEdge) {
    const key = `${edge.task_id}>${edge.depends_on_task_id}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  }

  return { rootId, tasks, edges, depthLimited, tooLarge };
}

// ── Comments ─────────────────────────────────────────────────────────────

/** Stands in for the edited task's title on a task FamCal can read when the edited task is not one. */
export const CASCADE_REDACTED_ROOT = 'a task it depends on';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The system comment on a moved task, with the edited task named (`named`) or
 * not (`redacted`). The SQL function picks `redacted` when the moved task is
 * FamCal-eligible and the edited task isn't, so a personal task's comments never
 * carry a work title.
 */
export function buildCascadeMoveComments(input: {
  rootTitle: string;
  rootNewDueAt: string;
  mode: CascadeMode;
  deltaWorkdays: number;
  move: CascadeMove;
}): { named: string; redacted: string } {
  const from = formatEtDay(input.move.old_due_at);
  const to = formatEtDay(input.move.new_due_at);
  const build = (who: string) => {
    if (input.mode === 'same_gap') {
      const extra = input.move.floor_raised ? ', and kept on or after the task it waits on' : '';
      return `Due date moved from ${from} to ${to} because ${who} slipped ${plural(input.deltaWorkdays, 'working day')}${extra}.`;
    }
    return `Due date moved from ${from} to ${to} because ${who} moved to ${formatEtDay(input.rootNewDueAt)} and this task can't be due before a task it waits on.`;
  };
  const title = input.rootTitle.trim() || 'Untitled task';
  // The redacted text says only what changed on this task: no gap, no date of
  // the task it waits on (FamCal may read it while that task is hidden from it).
  return { named: build(`"${title}"`), redacted: `Due date moved from ${from} to ${to} because ${CASCADE_REDACTED_ROOT} moved later.` };
}

// ── Priority for the moved tasks ─────────────────────────────────────────

export async function priorityForMoves(
  supabase: SupabaseClient,
  userId: string,
  graph: CascadeGraph,
  moves: CascadeMove[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (moves.length === 0) return out;
  const names = await getHighPriorityStakeholderNames(supabase, userId);
  for (const move of moves) {
    const task = graph.tasks.get(move.task_id);
    if (!task) continue;
    out.set(
      move.task_id,
      recalculateTaskPriority(
        {
          ...(task as Task),
          stakeholder_mentions: Array.isArray(task.stakeholder_mentions) ? task.stakeholder_mentions : [],
          due_at: move.new_due_at,
        },
        names
      )
    );
  }
  return out;
}

// ── Project target dates (preview only; the SQL function decides for real) ──

export interface CascadeProjectFlag {
  project_id: string;
  name: string;
  target_date: string;
  latest_due_date: string;
  tasks_past_target: number;
  rag_before: string;
  rag_after: string;
  /** The edited task itself is one of tasks_past_target (Brent 10/20: it flags its project too). */
  includes_edited_task?: boolean;
}

/** The edited task, for its own target-date flag (see rootPastTargetCandidate). */
export interface CascadeRootForFlag {
  project_id: string | null;
  new_due_at: string | null;
  old_due_at: string | null;
  status: string;
  is_recurring_template?: boolean | null;
  recurring_template_id?: string | null;
}

/**
 * Whether the edited task itself would count toward its project's target-date
 * flag (Brent 10/20, "Warn in the popup and turn the project Yellow, same as when
 * linked tasks move."): it is open and not recurring, the change moved it later
 * (or gave it its first date), and its new ET date is after the project's target.
 * The 062 function decides for real under its locks; this only says whether to
 * call it when nothing else moves, and fills previews.
 */
export function rootPastTargetCandidate(root: CascadeRootForFlag, targetDate: string | null | undefined): boolean {
  if (!root.project_id || !targetDate || !root.new_due_at) return false;
  if (!CASCADE_MOVABLE_STATUSES.includes(root.status) || isRecurringTask(root)) return false;
  if (root.old_due_at && !(Date.parse(root.new_due_at) > Date.parse(root.old_due_at))) return false;
  const date = etDateOf(root.new_due_at);
  return Boolean(date && date > targetDate);
}

/**
 * Projects a set of moves (and, when given, the edited task itself) would push
 * past their target date (ET date after target_date). RAG goes Green → Yellow;
 * Yellow and Red are left alone. The target date itself and status_summary are
 * never changed.
 */
export function projectFlagsForMoves(
  moves: Array<Pick<CascadeMove, 'project_id' | 'new_due_at'>>,
  projects: Array<{ id: string; name: string; target_date: string | null; rag: string }>,
  root: CascadeRootForFlag | null = null
): CascadeProjectFlag[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const flags = new Map<string, CascadeProjectFlag>();
  const rootCounts = root && root.project_id ? rootPastTargetCandidate(root, byId.get(root.project_id)?.target_date) : false;
  const entries: Array<{ project_id: string | null; new_due_at: string; isRoot: boolean }> = moves.map((move) => ({ project_id: move.project_id, new_due_at: move.new_due_at, isRoot: false }));
  if (rootCounts && root) entries.push({ project_id: root.project_id, new_due_at: root.new_due_at as string, isRoot: true });
  for (const move of entries) {
    if (!move.project_id) continue;
    const project = byId.get(move.project_id);
    if (!project || !project.target_date) continue;
    const date = etDateOf(move.new_due_at);
    if (!date || !(date > project.target_date)) continue;
    const flag = flags.get(project.id) ?? {
      project_id: project.id,
      name: project.name,
      target_date: project.target_date,
      latest_due_date: date,
      tasks_past_target: 0,
      rag_before: project.rag,
      rag_after: project.rag === 'Green' ? 'Yellow' : project.rag,
      includes_edited_task: false,
    };
    if (move.isRoot) flag.includes_edited_task = true;
    flag.tasks_past_target += 1;
    if (date > flag.latest_due_date) flag.latest_due_date = date;
    flags.set(project.id, flag);
  }
  return [...flags.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchCascadeProjects(
  supabase: SupabaseClient,
  userId: string,
  projectIds: string[]
): Promise<Array<{ id: string; name: string; target_date: string | null; rag: string }>> {
  const unique = [...new Set(projectIds.filter(Boolean))];
  const out: Array<{ id: string; name: string; target_date: string | null; rag: string }> = [];
  for (const ids of chunk(unique, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase.from('projects').select('id, name, target_date, rag').eq('user_id', userId).in('id', ids);
    if (error) throw error;
    out.push(...((data || []) as typeof out));
  }
  return out;
}

// ── Apply (migration 061) ────────────────────────────────────────────────

export interface CascadeApplyResult {
  status: 'moved' | 'nothing_moved' | 'superseded';
  cascade_id: string | null;
  /** `title` only on a replayed cascade (`adopted`), whose moves may not all be in this plan. */
  moved: Array<{ task_id: string; old_due_at: string; new_due_at: string; project_id: string | null; title?: string }>;
  skipped: Array<{ task_id: string; reason: string }>;
  project_flags: CascadeProjectFlag[];
  /**
   * 062 fix round 2: another session handled this change (same edited task, same
   * new date) after this PATCH saved it; nothing was written and this is that
   * change's current cascade replayed (or nothing, when it was undone since).
   */
  adopted?: boolean;
}

/** Whether a failed cascade call may be retried as is (it rolled back: deadlock, or 062's MC062). */
export function isRetryableCascadeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CASCADE_RETRYABLE_CODES.includes(code);
}

/**
 * Runs a cascade RPC, retrying a bounded number of times when the database
 * aborted it as a deadlock (40P01) or 062's lock protocol asked for a retry
 * (MC062). Each attempt is its own transaction and rolled back completely, so a
 * retry can never apply anything twice. Other errors are returned at once.
 */
export async function withCascadeRetry<T extends { error: unknown }>(
  call: () => PromiseLike<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? CASCADE_MAX_ATTEMPTS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await call();
  for (let attempt = 1; attempt < attempts && result.error && isRetryableCascadeError(result.error); attempt += 1) {
    console.warn(`Cascade call rolled back (${(result.error as { code?: string }).code}); retrying (attempt ${attempt + 1} of ${attempts}).`);
    await sleep(40 + Math.floor(Math.random() * 120) * attempt);
    result = await call();
  }
  return result;
}

/** The plain reason a failed cascade carries in replies ("busy" or "error"); the database text stays in the server log. */
export function cascadeFailureReason(error: unknown): 'busy' | 'error' {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CASCADE_BUSY_CODES.includes(code) ? 'busy' : 'error';
}

export class CascadeApplyError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'CascadeApplyError';
    this.code = code;
  }
}

export async function applyTaskDateCascade(
  supabase: SupabaseClient,
  input: {
    userId: string;
    rootTaskId: string;
    rootOldDueAt: string | null;
    rootNewDueAt: string;
    mode: CascadeMode;
    deltaWorkdays: number;
    scope: 'all' | 'famcal';
    source: string;
    moves: CascadeApplyMove[];
    /** The edited task's title as saved by this PATCH (the comments name this one). */
    rootTitle: string;
    /** Whether FamCal could read the edited task before this PATCH (read before the save). */
    rootWasVisible: boolean;
    /**
     * When this PATCH saved the edited task's new date (the saved row's
     * `updated_at`). The function replays, instead of logging again, a cascade of
     * the same change that another session logged after this save (062 fix round 2).
     */
    rootSavedAt?: string | null;
  }
): Promise<CascadeApplyResult> {
  const { data, error } = await withCascadeRetry(() => supabase.rpc(CASCADE_APPLY_RPC, {
    p_user_id: input.userId,
    p_root_task_id: input.rootTaskId,
    p_root_old_due_at: input.rootOldDueAt,
    p_root_new_due_at: input.rootNewDueAt,
    p_mode: input.mode,
    p_delta_workdays: input.deltaWorkdays,
    p_scope: input.scope,
    p_source: input.source,
    p_moves: input.moves,
    p_root_title: input.rootTitle,
    p_root_was_visible: input.rootWasVisible,
    p_root_saved_at: input.rootSavedAt ?? null,
  }));
  if (error) {
    const err = error as { message?: string; code?: string };
    throw new CascadeApplyError(err.message || 'The later tasks could not be moved', err.code ?? null);
  }
  const result = (Array.isArray(data) ? data[0] : data) as CascadeApplyResult | null;
  if (!result || typeof result !== 'object' || !Array.isArray(result.moved)) {
    throw new CascadeApplyError('The later tasks could not be moved (unexpected reply)', null);
  }
  return {
    status: result.status,
    cascade_id: result.cascade_id ?? null,
    moved: result.moved,
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    project_flags: Array.isArray(result.project_flags) ? result.project_flags : [],
    ...(result.adopted === true ? { adopted: true } : {}),
  };
}

/** Plain-English one-liner for replies ("Moved 3 later tasks by 2 working days (same gap)."). */
export function describeCascadeOutcome(input: {
  status: string;
  mode: CascadeMode;
  deltaWorkdays: number;
  movedCount: number;
  skippedChanged?: number;
}): string {
  const modeLabel = input.mode === 'same_gap' ? 'same gap' : 'only what would collide';
  switch (input.status) {
    case 'moved': {
      const what = plural(input.movedCount, 'later task');
      const how = input.mode === 'same_gap' ? ` by ${plural(input.deltaWorkdays, 'working day')}` : '';
      const changed = input.skippedChanged ? ` ${plural(input.skippedChanged, 'task')} changed meanwhile and stayed as they were.` : '';
      return `Moved ${what}${how} (${modeLabel}).${changed}`;
    }
    case 'preview':
      return input.movedCount === 0
        ? `Nothing after this task would move (${modeLabel}).`
        : `Would move ${plural(input.movedCount, 'later task')} (${modeLabel}). Nothing was saved.`;
    case 'needs_confirm':
      return `This would also move ${plural(input.movedCount, 'later task')}, more than ${CASCADE_CONFIRM_THRESHOLD}. Nothing was saved. Send it again with cascade_confirm: true, or cascade: false to move only this task.`;
    case 'too_large':
      return `Too many linked tasks to move at once (more than ${CASCADE_MAX_TASKS}). Nothing was saved. Send cascade: false to move only this task.`;
    case 'too_large_links':
      return 'Too many links between the tasks to move them all at once. Nothing was saved. Send cascade: false to move only this task.';
    case 'nothing_to_move':
    case 'nothing_moved':
      return `Nothing after this task needed to move (${modeLabel}).`;
    case 'superseded':
      return 'The due date changed again before the later tasks moved, so they were left as they were.';
    case 'failed':
      return "This task's date was saved, but the later tasks could not be moved. A comment on the task says so; move them by hand or try again.";
    case 'failed_busy':
      return "This task's date was saved, but the later tasks could not be moved because Baseline was busy. A comment on the task says so; try again in a moment.";
    default:
      return '';
  }
}

// ── PATCH glue ───────────────────────────────────────────────────────────

export interface CascadeApplyMove {
  task_id: string;
  old_due_at: string;
  new_due_at: string;
  priority_score: number;
  /** The score inputs the new priority_score was computed from; the function keeps the current score when any of them changed (062). */
  base_priority: number;
  status: string;
  title: string;
  stakeholder_mentions: string[];
  /** Tasks on the planned path (062 skips the move when one became Done/Missed/recurring meanwhile). */
  via?: string[];
  comment: string;
  comment_redacted: string;
}

/** The moves as the SQL function takes them: new priority and both comment texts. */
export async function prepareCascadeApplyMoves(
  supabase: SupabaseClient,
  userId: string,
  input: { rootTitle: string; plan: CascadePlan; graph: CascadeGraph }
): Promise<CascadeApplyMove[]> {
  // Paths are always sent (L1): a plan with too many is refused as too large
  // before it gets here (planTaskDateCascade), never sent without its checks.
  const viaTotal = input.plan.moves.reduce((sum, move) => sum + move.via.length, 0);
  if (viaTotal > CASCADE_MAX_VIA_IDS) {
    throw new CascadeApplyError('Too many links between the tasks to move them at once', null);
  }
  const priorities = await priorityForMoves(supabase, userId, input.graph, input.plan.moves);
  return input.plan.moves.map((move) => {
    const comments = buildCascadeMoveComments({
      rootTitle: input.rootTitle,
      rootNewDueAt: input.plan.rootNewDueAt,
      mode: input.plan.mode,
      deltaWorkdays: input.plan.deltaWorkdays,
      move,
    });
    const task = input.graph.tasks.get(move.task_id);
    return {
      task_id: move.task_id,
      old_due_at: move.old_due_at,
      new_due_at: move.new_due_at,
      priority_score: priorities.get(move.task_id) ?? task?.priority_score ?? 50,
      base_priority: typeof task?.base_priority === 'number' ? task.base_priority : (task?.priority_score ?? 50),
      status: String(task?.status ?? ''),
      title: String(task?.title ?? move.title),
      stakeholder_mentions: Array.isArray(task?.stakeholder_mentions) ? (task.stakeholder_mentions as string[]) : [],
      via: move.via,
      comment: comments.named,
      comment_redacted: comments.redacted,
    };
  });
}

export type CascadeReplyStatus =
  | 'moved'
  | 'nothing_to_move'
  | 'off'
  | 'not_applicable'
  | 'superseded'
  | 'failed'
  | 'preview'
  | 'needs_confirm'
  | 'too_large';

/**
 * The `cascade` object on a PATCH reply (never for the FamCal key, whose reply
 * stays projectTaskForFamcal). Lists every move with its old and new due date,
 * what was left alone and why, and any project now past its target date.
 */
export interface CascadeReply {
  status: CascadeReplyStatus;
  mode: CascadeMode;
  delta_workdays: number;
  /** Not-run reasons (cascadeTrigger), or for `failed` the plain "busy" / "error" (never database text). */
  reason: string | null;
  cascade_id: string | null;
  /** The edited task's due date before and after this change (S2: Undo and "switch how far" use them). */
  root_old_due_at: string | null;
  root_new_due_at: string | null;
  message: string;
  moves: Array<{ task_id: string; title: string; old_due_at: string; new_due_at: string }>;
  skipped: Array<{ task_id: string; title: string; reason: string }>;
  project_flags: CascadeProjectFlag[];
  depth_limited: number;
  /** How many moves the plan had (for `failed`, how many tasks did not move). */
  planned_moves: number;
}

export function buildCascadeReply(input: {
  status: CascadeReplyStatus;
  mode: CascadeMode;
  plan?: CascadePlan | null;
  reason?: string | null;
  applied?: CascadeApplyResult | null;
  projectFlags?: CascadeProjectFlag[];
  /** The edited task's dates when there is no plan (not_applicable, off). */
  root?: { old_due_at: string | null; new_due_at: string | null };
}): CascadeReply {
  const plan = input.plan ?? null;
  const titles = new Map<string, string>();
  for (const move of plan?.moves ?? []) titles.set(move.task_id, move.title);
  for (const skip of plan?.skipped ?? []) titles.set(skip.task_id, skip.title);

  let moves: CascadeReply['moves'];
  let skipped: CascadeReply['skipped'] = (plan?.skipped ?? []).map((skip) => ({ ...skip }));
  if (input.applied) {
    // In the plan's order (nearest first), not the function's lock order.
    const rank = new Map((plan?.moves ?? []).map((move, index) => [move.task_id, index]));
    const ordered = [...input.applied.moved].sort((a, b) => (rank.get(a.task_id) ?? 1e9) - (rank.get(b.task_id) ?? 1e9));
    moves = ordered.map((move) => ({
      task_id: move.task_id,
      title: titles.get(move.task_id) ?? move.title ?? '',
      old_due_at: move.old_due_at,
      new_due_at: move.new_due_at,
    }));
    skipped = [
      ...skipped,
      ...input.applied.skipped.map((skip) => ({ task_id: skip.task_id, title: titles.get(skip.task_id) ?? '', reason: skip.reason })),
    ];
  } else if (input.status === 'preview' || input.status === 'needs_confirm' || input.status === 'too_large') {
    moves = (plan?.moves ?? []).map((move) => ({
      task_id: move.task_id,
      title: move.title,
      old_due_at: move.old_due_at,
      new_due_at: move.new_due_at,
    }));
  } else {
    moves = [];
  }

  const deltaWorkdays = plan?.deltaWorkdays ?? 0;
  const status = input.status;
  const movedCount = status === 'moved' ? moves.length : (plan?.moves.length ?? 0);
  return {
    status,
    mode: input.mode,
    delta_workdays: deltaWorkdays,
    reason: input.reason ?? (status === 'too_large' && plan?.tooLargeReason === 'links' ? 'links' : null),
    cascade_id: input.applied?.cascade_id ?? null,
    root_old_due_at: plan ? plan.rootOldDueAt : (input.root?.old_due_at ?? null),
    root_new_due_at: plan ? plan.rootNewDueAt : (input.root?.new_due_at ?? null),
    message: describeCascadeOutcome({
      status: status === 'moved' && moves.length === 0 ? 'nothing_moved'
        : status === 'failed' && input.reason === 'busy' ? 'failed_busy'
        : status === 'too_large' && plan?.tooLargeReason === 'links' ? 'too_large_links'
        : status,
      mode: input.mode,
      deltaWorkdays,
      movedCount,
      skippedChanged: input.applied?.skipped.length ?? 0,
    }) || describeNotApplicable(input.reason ?? null),
    moves,
    skipped,
    project_flags: (input.applied ? input.applied.project_flags : (input.projectFlags ?? [])).map(publicProjectFlag),
    depth_limited: plan?.depthLimited ?? 0,
    planned_moves: plan?.moves.length ?? 0,
  };
}

/** A project flag as replies show it (062's internal `rag_set_at` stays in the log). */
export function publicProjectFlag(flag: CascadeProjectFlag): CascadeProjectFlag {
  return {
    project_id: flag.project_id,
    name: flag.name,
    target_date: flag.target_date,
    latest_due_date: flag.latest_due_date,
    tasks_past_target: flag.tasks_past_target,
    rag_before: flag.rag_before,
    rag_after: flag.rag_after,
    includes_edited_task: flag.includes_edited_task === true,
  };
}

function describeNotApplicable(reason: string | null): string {
  switch (reason) {
    case 'off':
      return 'Only this task moved (cascade: false).';
    case 'earlier':
      return 'The date moved earlier, so nothing after it moved.';
    case 'same_day':
      return 'The date stayed on the same working day, so nothing after it moved.';
    case 'cleared':
      return 'The due date was cleared, so nothing after it moved.';
    case 'no_previous_date':
      return 'The task had no due date before, so there is no gap to repeat (only_collisions can still move what collides).';
    case 'done':
      return 'The task is Done, so nothing after it moved.';
    case 'recurring':
      return 'Recurring tasks never move the tasks after them.';
    case 'no_change':
      return 'The due date did not change.';
    default:
      return '';
  }
}

/** Comment on the edited task when the later tasks were not moved (the known two-statement seam, or FamCal's limits). */
export function cascadeRootNotice(kind: 'failed' | 'too_many' | 'too_large' | 'unreadable'): string {
  switch (kind) {
    case 'too_many':
      return `This task's due date moved, but the tasks after it were not moved: more than ${CASCADE_CONFIRM_THRESHOLD} would have moved. Move them in Baseline if they should follow.`;
    case 'too_large':
      return `This task's due date moved, but the tasks after it were not moved: too many linked tasks (more than ${CASCADE_MAX_TASKS}). Move them in Baseline if they should follow.`;
    case 'unreadable':
      return "This task's due date moved, but the tasks after it were not moved: their links couldn't be read. Move them by hand, or move this task's date again.";
    default:
      return "This task's due date moved, but the tasks after it could not be moved. Move them by hand, or move this task's date again.";
  }
}
