import type { SupabaseClient } from '@supabase/supabase-js';
import { FAMCAL_ELIGIBLE_FIELD, FAMCAL_REQUIRED_TAG } from '@/lib/famcal-api-key';
import { getHighPriorityStakeholderNames, recalculateTaskPriority } from '@/lib/priority';
import { DependencyReadIncompleteError } from '@/lib/task-dependency-links';
import {
  buildCascadeReply,
  CASCADE_BUSY_CODES,
  CASCADE_CONFIRM_THRESHOLD,
  CASCADE_MODES,
  CASCADE_REPLACE_RPC,
  CASCADE_UNDO_RPC,
  cascadeTrigger,
  fetchCascadeProjects,
  formatEtDay,
  loadCascadeGraph,
  planTaskDateCascade,
  prepareCascadeApplyMoves,
  projectFlagsForMoves,
  withCascadeRetry,
  type CascadeApplyResult,
  type CascadeGraph,
  type CascadeMode,
  type CascadePlan,
  type CascadeReply,
} from '@/lib/task-date-cascade';
import { validateOptionalTimestamp } from '@/lib/validate';
import type { Task } from '@/types/database';

/**
 * Cascade due dates, slice S2 (Baseline task 6fcad51b): Undo, "switch how far"
 * and "try again" for one date change, over the cascade log (migration 061) and
 * the 062 functions undo_task_date_cascade / replace_task_date_cascade.
 *
 * POST /api/tasks/{id}/date-cascade (the app's toast and MCP undo_date_cascade):
 * - `undo`: puts back every task the cascade moved whose due date still equals
 *   the date it set (a task changed since is kept and listed) and, unless
 *   `restore_root: false`, the edited task's own date (only while it still has
 *   the date the edit set). With a cascade id the dates come from its log row.
 *   Without one (the change moved nothing else, or "just this task" was picked)
 *   `from_due_at` / `to_due_at` say what to restore.
 * - `apply`: re-plans the same date change with `mode` (same_gap,
 *   only_collisions, or none = just this task) and, in one transaction, undoes
 *   the cascade being replaced (when there is one) and applies the new plan, as if
 *   that mode had been chosen first. Also "try again" after a failed cascade (no
 *   log row: `from_due_at` / `to_due_at`). More than 25 moves: 409 with the
 *   preview and nothing changed, unless `confirm: true`.
 * The edited task must still have the date the change set; otherwise nothing
 * changes and the reply is a 409.
 */

export const DATE_CASCADE_ACTIONS = ['undo', 'apply'] as const;
export type DateCascadeAction = (typeof DATE_CASCADE_ACTIONS)[number];
export type DateCascadeModeChoice = CascadeMode | 'none';

export interface DateCascadeRequest {
  action: DateCascadeAction;
  cascadeId: string | null;
  fromDueAt: string | null;
  toDueAt: string | null;
  mode: DateCascadeModeChoice | null;
  confirm: boolean;
  restoreRoot: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_KEYS = ['action', 'cascade_id', 'from_due_at', 'to_due_at', 'mode', 'confirm', 'restore_root'];

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseDateCascadeRequest(body: Record<string, unknown>): ParseResult<DateCascadeRequest> {
  const unknown = Object.keys(body).filter((key) => !REQUEST_KEYS.includes(key));
  if (unknown.length > 0) return { ok: false, error: `Unknown field: ${unknown[0]}` };

  const action = body.action;
  if (typeof action !== 'string' || !(DATE_CASCADE_ACTIONS as ReadonlyArray<string>).includes(action)) {
    return { ok: false, error: 'action must be "undo" or "apply"' };
  }

  let cascadeId: string | null = null;
  if (body.cascade_id !== undefined && body.cascade_id !== null) {
    if (typeof body.cascade_id !== 'string' || !UUID_RE.test(body.cascade_id.trim())) {
      return { ok: false, error: 'cascade_id must be the cascade_id from the date change reply' };
    }
    cascadeId = body.cascade_id.trim();
  }

  const from = validateOptionalTimestamp(body.from_due_at, 'from_due_at');
  if (!from.ok) return { ok: false, error: from.error ?? 'from_due_at is invalid' };
  const to = validateOptionalTimestamp(body.to_due_at, 'to_due_at');
  if (!to.ok) return { ok: false, error: to.error ?? 'to_due_at is invalid' };

  let mode: DateCascadeModeChoice | null = null;
  if (body.mode !== undefined && body.mode !== null) {
    if (typeof body.mode !== 'string' || !([...CASCADE_MODES, 'none'] as ReadonlyArray<string>).includes(body.mode)) {
      return { ok: false, error: 'mode must be "same_gap", "only_collisions" or "none" (just this task)' };
    }
    mode = body.mode as DateCascadeModeChoice;
  }
  if (action === 'apply' && !mode) return { ok: false, error: 'apply needs a mode' };
  if (action === 'undo' && mode) return { ok: false, error: 'undo takes no mode' };

  for (const key of ['confirm', 'restore_root'] as const) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'boolean') {
      return { ok: false, error: `${key} must be true or false` };
    }
  }
  const restoreRoot = body.restore_root !== false;

  if (!cascadeId) {
    // No log row: the caller says which change this is.
    if (!to.value && (action === 'apply' || restoreRoot)) {
      return { ok: false, error: 'Without a cascade_id, give to_due_at (the date the change set) and from_due_at (the date before it)' };
    }
    if (action === 'undo' && !restoreRoot) {
      return { ok: false, error: 'Nothing to undo: give a cascade_id, or leave restore_root on' };
    }
  }

  return {
    ok: true,
    value: {
      action: action as DateCascadeAction,
      cascadeId,
      fromDueAt: from.value,
      toDueAt: to.value,
      mode,
      confirm: body.confirm === true,
      restoreRoot,
    },
  };
}

// ── Replies ──────────────────────────────────────────────────────────────

export interface DateCascadeRestored {
  task_id: string;
  title: string;
  from_due_at: string;
  to_due_at: string;
}

export interface DateCascadeKept {
  task_id: string;
  title: string;
  /** Its due date now (someone changed it since the cascade). */
  due_at: string | null;
  /** The date the cascade had given it. */
  cascade_due_at: string;
}

export interface DateCascadeProjectHealth {
  project_id: string;
  name: string;
  rag_before: string;
  rag_after: string;
  /** Why it stayed: "changed_since" (health or the project changed since) or "tasks_kept". */
  kept_reason: string | null;
}

export interface DateCascadeUndoPart {
  cascade_id: string;
  restored: DateCascadeRestored[];
  kept: DateCascadeKept[];
  projects: DateCascadeProjectHealth[];
}

export interface DateCascadeUndoReply {
  status: 'undone';
  task_id: string;
  title: string;
  /** The dependents put back (null when the change had none to put back). */
  cascade: DateCascadeUndoPart | null;
  root: { restored: boolean; due_at: string | null; restore_due_at: string | null; requested: boolean };
  message: string;
}

export interface DateCascadeApplyReply {
  status: 'replaced';
  task_id: string;
  title: string;
  /** The new state of the change, in the same shape as the PATCH reply's `cascade`. */
  cascade: CascadeReply;
  /** What the replaced cascade put back first (null when there was none). */
  replaced: DateCascadeUndoPart | null;
  message: string;
}

export class DateCascadeHttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DateCascadeHttpError';
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

const NOT_FOUND = "That date change wasn't found for this task.";
const CHANGED_SINCE = "This task's due date changed since, so nothing was changed. Reload it and try again.";
const ALREADY_SWITCHED = 'That change was already undone or switched, so nothing was changed.';
const BUSY = 'Baseline was busy, so nothing was changed. Try again in a moment.';
const FAILED = "Couldn't do that, so nothing was changed. Try again.";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

/** A database error from the undo/replace call as the plain HTTP error the caller sees (the text itself stays in the server log). */
function rpcFailure(error: { code?: string; message?: string }, what: string): DateCascadeHttpError {
  console.error(`Date cascade ${what} failed:`, error);
  if (error.code && CASCADE_BUSY_CODES.includes(error.code)) return new DateCascadeHttpError(503, BUSY, { reason: 'busy' });
  if (error.code === 'MC063') return new DateCascadeHttpError(409, ALREADY_SWITCHED, { reason: 'stale' });
  return new DateCascadeHttpError(500, FAILED, { reason: 'error' });
}

// ── Reading what's needed ────────────────────────────────────────────────

interface CascadeLogRow {
  id: string;
  root_task_id: string;
  root_old_due_at: string | null;
  root_new_due_at: string;
  mode: CascadeMode;
  undone_at: string | null;
}

interface CascadeLogMove {
  task_id: string;
  old_due_at: string;
  new_due_at: string;
}

async function readRoot(supabase: SupabaseClient, userId: string, taskId: string): Promise<Task> {
  const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new DateCascadeHttpError(404, 'Task not found');
  return data as Task;
}

async function readLog(supabase: SupabaseClient, userId: string, taskId: string, cascadeId: string): Promise<{ row: CascadeLogRow; moves: CascadeLogMove[] }> {
  const { data, error } = await supabase
    .from('task_date_cascades')
    .select('id, root_task_id, root_old_due_at, root_new_due_at, mode, undone_at')
    .eq('id', cascadeId)
    .eq('user_id', userId)
    .eq('root_task_id', taskId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new DateCascadeHttpError(404, NOT_FOUND);
  const { data: moves, error: movesError } = await supabase
    .from('task_date_cascade_moves')
    .select('task_id, old_due_at, new_due_at')
    .eq('cascade_id', cascadeId)
    .eq('user_id', userId)
    .order('task_id', { ascending: true })
    .limit(1000);
  if (movesError) throw movesError;
  return { row: data as CascadeLogRow, moves: (moves || []) as CascadeLogMove[] };
}

/**
 * Without a cascade id: the newest cascade of this task that is not undone and
 * was made for the same date (so a repeated "Try again", or an MCP call that
 * leaves the id out, replaces it instead of moving the tasks a second time).
 */
async function findActiveCascadeId(supabase: SupabaseClient, userId: string, taskId: string, toDueAt: string | null): Promise<string | null> {
  if (!toDueAt) return null;
  const { data, error } = await supabase
    .from('task_date_cascades')
    .select('id, root_new_due_at')
    .eq('user_id', userId)
    .eq('root_task_id', taskId)
    .is('undone_at', null)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const match = ((data || []) as Array<{ id: string; root_new_due_at: string }>).find((row) => sameInstant(row.root_new_due_at, toDueAt));
  return match?.id ?? null;
}

async function readTasks(supabase: SupabaseClient, userId: string, ids: string[]): Promise<Map<string, Task>> {
  const out = new Map<string, Task>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    const { data, error } = await supabase.from('tasks').select('*').eq('user_id', userId).in('id', chunk);
    if (error) throw error;
    for (const row of (data || []) as Task[]) out.set(row.id, row);
  }
  return out;
}

/** Whether the FamCal key could read this task right now (one eligibility-filtered read). */
export async function isFamcalVisibleNow(supabase: SupabaseClient, userId: string, taskId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id')
    .eq('id', taskId)
    .eq('user_id', userId)
    .contains('tags', [FAMCAL_REQUIRED_TAG])
    .eq(FAMCAL_ELIGIBLE_FIELD, true)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/** The score a task should have on `dueAt`, plus the inputs it came from (062 keeps the current score when one changed meanwhile). */
function scoreFor(task: Task, dueAt: string | null, names: string[]) {
  return {
    priority_score: recalculateTaskPriority(
      { ...task, stakeholder_mentions: Array.isArray(task.stakeholder_mentions) ? task.stakeholder_mentions : [], due_at: dueAt },
      names
    ),
    base_priority: typeof task.base_priority === 'number' ? task.base_priority : task.priority_score,
    status: String(task.status),
    title: String(task.title),
    stakeholder_mentions: Array.isArray(task.stakeholder_mentions) ? task.stakeholder_mentions : [],
  };
}

async function restoresFor(supabase: SupabaseClient, userId: string, moves: CascadeLogMove[], rows: Map<string, Task>) {
  if (moves.length === 0) return [];
  const names = await getHighPriorityStakeholderNames(supabase, userId);
  return moves
    .filter((move) => rows.has(move.task_id))
    .map((move) => ({ task_id: move.task_id, ...scoreFor(rows.get(move.task_id)!, move.old_due_at, names) }));
}

interface RawUndoPart {
  status: string;
  cascade_id: string;
  restored: Array<{ task_id: string; from_due_at: string; to_due_at: string }>;
  kept: Array<{ task_id: string; due_at: string | null; cascade_due_at: string }>;
  projects: Array<{ project_id: string; name: string; rag_before: string; rag_after: string; kept_reason?: string }>;
}

function undoPart(raw: RawUndoPart | null | undefined, titles: Map<string, string>): DateCascadeUndoPart | null {
  if (!raw || raw.status !== 'undone') return null;
  return {
    cascade_id: raw.cascade_id,
    restored: (raw.restored || []).map((item) => ({ ...item, title: titles.get(item.task_id) ?? '' })),
    kept: (raw.kept || []).map((item) => ({ ...item, title: titles.get(item.task_id) ?? '' })),
    projects: (raw.projects || []).map((item) => ({ ...item, kept_reason: item.kept_reason ?? null })),
  };
}

/** Plain-English summary of an undo, for MCP and logs. */
export function describeUndo(reply: Pick<DateCascadeUndoReply, 'cascade' | 'root' | 'title'>): string {
  const parts: string[] = [];
  const restored = reply.cascade?.restored.length ?? 0;
  const kept = reply.cascade?.kept.length ?? 0;
  if (restored > 0) parts.push(`Put ${plural(restored, 'task')} back on ${restored === 1 ? 'its' : 'their'} old date.`);
  if (kept > 0) parts.push(`Left ${plural(kept, 'task')} alone because ${kept === 1 ? 'it was' : 'they were'} changed since.`);
  if (reply.root.requested) {
    parts.push(reply.root.restored
      ? `"${reply.title}" is back on ${reply.root.due_at ? formatEtDay(reply.root.due_at) : 'no due date'}.`
      : `"${reply.title}" was changed again since, so its date was left as it is.`);
  }
  for (const project of reply.cascade?.projects ?? []) {
    parts.push(project.rag_after === 'Green' && project.rag_before !== 'Green'
      ? `${project.name} is back to Green.`
      : `${project.name} is still ${project.rag_after}.`);
  }
  return parts.join(' ') || 'Nothing needed to be put back.';
}

// ── Undo ─────────────────────────────────────────────────────────────────

export async function undoDateChange(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  request: DateCascadeRequest
): Promise<DateCascadeUndoReply> {
  const root = await readRoot(supabase, userId, taskId);
  const cascadeId = request.cascadeId ?? (await findActiveCascadeId(supabase, userId, taskId, request.toDueAt));
  const log = cascadeId ? await readLog(supabase, userId, taskId, cascadeId) : null;
  const pendingMoves = log && !log.row.undone_at ? log.moves : [];
  const rows = await readTasks(supabase, userId, pendingMoves.map((move) => move.task_id));
  const restore = await restoresFor(supabase, userId, pendingMoves, rows);
  const restoreDue = log ? log.row.root_old_due_at : request.fromDueAt;
  const names = request.restoreRoot ? await getHighPriorityStakeholderNames(supabase, userId) : [];
  const rootPriority = request.restoreRoot ? scoreFor(root, restoreDue, names) : null;

  const { data, error } = await withCascadeRetry(() => supabase.rpc(CASCADE_UNDO_RPC, {
    p_user_id: userId,
    p_root_task_id: taskId,
    p_cascade_id: log ? log.row.id : null,
    p_root_expected_due_at: log ? log.row.root_new_due_at : request.toDueAt,
    p_root_restore_due_at: restoreDue,
    p_restore_root: request.restoreRoot,
    p_root_priority: rootPriority,
    p_restore: restore,
  }));
  if (error) throw rpcFailure(error as { code?: string; message?: string }, 'undo');
  const result = (Array.isArray(data) ? data[0] : data) as {
    status: string;
    cascade: RawUndoPart | null;
    root: { restored: boolean; due_at: string | null; restore_due_at: string | null };
  } | null;
  if (!result || result.status === 'not_found') throw new DateCascadeHttpError(404, NOT_FOUND);

  const titles = new Map<string, string>([...rows.values()].map((row) => [row.id, row.title]));
  const reply: DateCascadeUndoReply = {
    status: 'undone',
    task_id: taskId,
    title: root.title,
    cascade: undoPart(result.cascade, titles),
    root: {
      restored: Boolean(result.root?.restored),
      due_at: result.root?.due_at ?? null,
      restore_due_at: result.root?.restore_due_at ?? restoreDue ?? null,
      requested: request.restoreRoot,
    },
    message: '',
  };
  reply.message = describeUndo(reply);
  return reply;
}

// ── Apply (switch how far / try again) ───────────────────────────────────

/**
 * The graph as it will be once the replaced cascade is put back: a task still
 * on the date that cascade gave it is planned from its old date.
 */
export function overlayRestoredDates(graph: CascadeGraph, moves: CascadeLogMove[]): CascadeGraph {
  if (moves.length === 0) return graph;
  const byTask = new Map(moves.map((move) => [move.task_id, move]));
  const tasks = new Map(graph.tasks);
  for (const [id, task] of tasks) {
    const move = byTask.get(id);
    if (move && sameInstant(task.due_at, move.new_due_at)) tasks.set(id, { ...task, due_at: move.old_due_at });
  }
  return { ...graph, tasks };
}

export async function applyDateChange(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  request: DateCascadeRequest,
  source: string
): Promise<DateCascadeApplyReply> {
  const root = await readRoot(supabase, userId, taskId);
  const cascadeId = request.cascadeId ?? (await findActiveCascadeId(supabase, userId, taskId, request.toDueAt));
  const log = cascadeId ? await readLog(supabase, userId, taskId, cascadeId) : null;
  const fromDueAt = log ? log.row.root_old_due_at : request.fromDueAt;
  const toDueAt = log ? log.row.root_new_due_at : (request.toDueAt as string);
  if (!sameInstant(root.due_at, toDueAt)) throw new DateCascadeHttpError(409, CHANGED_SINCE, { reason: 'changed' });

  const replaceId = log && !log.row.undone_at ? log.row.id : null;
  const undoMoves = replaceId && log ? log.moves : [];
  const choice = request.mode as DateCascadeModeChoice;
  const mode: CascadeMode = choice === 'none' ? (log?.row.mode ?? 'same_gap') : choice;

  let plan: CascadePlan | null = null;
  let graph: CascadeGraph | null = null;
  let notRun: string | null = null;
  if (choice !== 'none') {
    const trigger = cascadeTrigger({ ...root, due_at: fromDueAt }, root, mode);
    if (!trigger.run) {
      notRun = trigger.reason;
    } else {
      try {
        graph = overlayRestoredDates(await loadCascadeGraph(supabase, userId, taskId, { famcal: false }), undoMoves);
      } catch (readError) {
        if (readError instanceof DependencyReadIncompleteError) {
          throw new DateCascadeHttpError(503, "Couldn't read all the tasks that wait on this one, so nothing was changed. Try again.", { reason: 'unreadable' });
        }
        throw readError;
      }
      plan = planTaskDateCascade({ graph, mode, deltaWorkdays: trigger.deltaWorkdays, rootOldDueAt: fromDueAt, rootNewDueAt: toDueAt });
      const overCap = plan.moves.length > CASCADE_CONFIRM_THRESHOLD;
      if (plan.tooLarge || (overCap && !request.confirm)) {
        const projects = await fetchCascadeProjects(supabase, userId, plan.moves.map((move) => move.project_id ?? ''));
        const reply = buildCascadeReply({ status: plan.tooLarge ? 'too_large' : 'needs_confirm', mode, plan, projectFlags: projectFlagsForMoves(plan.moves, projects) });
        throw new DateCascadeHttpError(409, reply.message, { cascade: reply });
      }
    }
  }

  const rows = await readTasks(supabase, userId, undoMoves.map((move) => move.task_id));
  const restore = await restoresFor(supabase, userId, undoMoves, rows);
  const moves = plan && graph && plan.moves.length > 0 ? await prepareCascadeApplyMoves(supabase, userId, { rootTitle: root.title, plan, graph }) : [];
  const applyMode = plan ? mode : null;

  let applied: CascadeApplyResult | null = null;
  let undone: RawUndoPart | null = null;
  if (replaceId || (applyMode && moves.length > 0)) {
    const rootWasVisible = moves.length > 0 ? await isFamcalVisibleNow(supabase, userId, taskId) : false;
    const { data, error } = await withCascadeRetry(() => supabase.rpc(CASCADE_REPLACE_RPC, {
      p_user_id: userId,
      p_root_task_id: taskId,
      p_replace_cascade_id: replaceId,
      p_root_old_due_at: fromDueAt,
      p_root_new_due_at: toDueAt,
      p_mode: applyMode,
      p_delta_workdays: plan?.deltaWorkdays ?? 0,
      p_source: source,
      p_moves: moves,
      p_root_title: root.title,
      p_root_was_visible: rootWasVisible,
      p_restore: restore,
    }));
    if (error) throw rpcFailure(error as { code?: string; message?: string }, 'switch');
    const result = (Array.isArray(data) ? data[0] : data) as { status: string; undo: RawUndoPart | null; apply: CascadeApplyResult | null } | null;
    if (!result || result.status === 'not_found') throw new DateCascadeHttpError(404, NOT_FOUND);
    if (result.status === 'superseded') throw new DateCascadeHttpError(409, CHANGED_SINCE, { reason: 'changed' });
    if (result.status === 'stale') throw new DateCascadeHttpError(409, ALREADY_SWITCHED, { reason: 'stale' });
    undone = result.undo;
    applied = result.apply && Array.isArray(result.apply.moved)
      ? { ...result.apply, skipped: result.apply.skipped ?? [], project_flags: result.apply.project_flags ?? [] }
      : null;
  }

  const rootDates = { old_due_at: fromDueAt, new_due_at: toDueAt };
  let cascade: CascadeReply;
  if (choice === 'none') {
    cascade = buildCascadeReply({ status: 'off', mode, reason: 'off', root: rootDates });
  } else if (!plan) {
    cascade = buildCascadeReply({ status: 'not_applicable', mode, reason: notRun, root: rootDates });
  } else if (applied) {
    cascade = buildCascadeReply({ status: applied.status === 'superseded' ? 'superseded' : 'moved', mode, plan, applied });
  } else {
    cascade = buildCascadeReply({ status: 'nothing_to_move', mode, plan });
  }

  const titles = new Map<string, string>([...rows.values()].map((row) => [row.id, row.title]));
  const replaced = undoPart(undone, titles);
  const what = choice === 'none' ? 'Only this task stays moved.' : cascade.message;
  return {
    status: 'replaced',
    task_id: taskId,
    title: root.title,
    cascade,
    replaced,
    message: replaced ? `${what} The first move was put back first.` : what,
  };
}
