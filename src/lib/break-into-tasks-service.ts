/**
 * Break into tasks (Baseline task d1f7e622): the server side. One read of the
 * task and its checklist, the pure plan (`planBreak`), then ONE database call
 * (`break_task_into_tasks`, migration 066) that writes everything or nothing.
 * Undo is one call too (`undo_break_task_into_tasks`).
 *
 * Also the umbrella reads used by the task window and `GET /api/tasks/{id}`
 * (MCP `get_task`): `part_of` (the umbrella a task was broken out of) and
 * `step_tasks` (an umbrella's steps).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  breakRefusal,
  parseBreakRequest,
  planBreak,
  stepsDoneText,
  type BreakChecklistRow,
  type BreakUmbrella,
} from './break-into-tasks';
import { CASCADE_BUSY_CODES, withCascadeRetry } from './task-date-cascade';

export interface ServiceReply {
  status: number;
  body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(error: unknown, what: string): ServiceReply {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && CASCADE_BUSY_CODES.includes(code)) {
    return { status: 503, body: { error: 'Baseline is busy with another change to these tasks. Try again in a moment.', reason: 'busy' } };
  }
  if (code === '23505') {
    return { status: 409, body: { error: 'That project already has a section with this name. Pick another name.', reason: 'section_name_taken' } };
  }
  console.error(`[break-into-tasks] ${what} failed:`, error);
  return { status: 500, body: { error: `Could not ${what}. Nothing was changed.`, reason: 'error' } };
}

/** POST /api/tasks/{id}/break with no `action` (or `action: "create"`). */
export async function breakTaskIntoTasks(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  body: unknown,
  now: Date = new Date()
): Promise<ServiceReply> {
  if (!UUID_RE.test(taskId)) return { status: 404, body: { error: 'Task not found.' } };
  const parsed = parseBreakRequest(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .select('id, title, status, owner, start_at, due_at, tags, project_id, base_priority, is_recurring_template, project:projects(id, name, tags)')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle();
  if (taskError) return failure(taskError, 'read the task');
  if (!task) return { status: 404, body: { error: 'Task not found.' } };

  const { data: rows, error: rowsError } = await supabase
    .from('task_checklist_items')
    .select('id, text, is_done, sort_order, completed_at, unit_count, work_type, created_at')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (rowsError) return failure(rowsError, 'read the checklist');

  const project = Array.isArray(task.project) ? task.project[0] ?? null : task.project ?? null;
  const umbrella: BreakUmbrella = {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    start_at: task.start_at,
    due_at: task.due_at,
    tags: task.tags,
    project_id: task.project_id,
    base_priority: Number(task.base_priority ?? 50),
    project,
  };

  // The name the comments use for an existing destination (read-only; the function re-checks it under the lock).
  let destinationLabel: string | null = null;
  const dest = parsed.value.destination;
  if (dest.kind === 'existing_section' && dest.section_id) {
    const { data: section } = await supabase
      .from('project_sections')
      .select('name')
      .eq('id', dest.section_id)
      .eq('user_id', userId)
      .maybeSingle();
    destinationLabel = section?.name ?? null;
  } else if (dest.kind === 'existing_project' && dest.project_id) {
    const { data: target } = await supabase
      .from('projects')
      .select('name')
      .eq('id', dest.project_id)
      .eq('user_id', userId)
      .maybeSingle();
    destinationLabel = target?.name ?? null;
  }

  const plan = planBreak(parsed.value, {
    umbrella,
    rows: (rows ?? []) as BreakChecklistRow[],
    projectName: project?.name ?? null,
    destinationLabel,
    now,
  });
  if (!plan.ok) return { status: 400, body: { error: plan.error } };

  const { data, error } = await withCascadeRetry(() =>
    supabase.rpc('break_task_into_tasks', { p_user_id: userId, p_task_id: taskId, p_request: plan.value })
  );
  if (error) return failure(error, 'break the task into tasks');
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok !== true) {
    const refusal = breakRefusal(String(result.reason ?? ''));
    return { status: refusal.status, body: { error: refusal.error, reason: result.reason ?? 'refused' } };
  }
  return { status: 201, body: result };
}

/** POST /api/tasks/{id}/break with `action: "undo"`. */
export async function undoBreakTaskIntoTasks(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  body: unknown
): Promise<ServiceReply> {
  if (!UUID_RE.test(taskId)) return { status: 404, body: { error: 'Task not found.' } };
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const allowed = new Set(['action', 'task_ids', 'section_id', 'project_id', 'umbrella_comment_id']);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) return { status: 400, body: { error: `Unknown field: ${extra}` } };
  const taskIds = raw.task_ids;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 100 || !taskIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return { status: 400, body: { error: 'task_ids must list the tasks the break created.' } };
  }
  const optionalId = (value: unknown): string | null | 'bad' =>
    value === undefined || value === null || value === '' ? null : typeof value === 'string' && UUID_RE.test(value) ? value : 'bad';
  const sectionId = optionalId(raw.section_id);
  const projectId = optionalId(raw.project_id);
  const commentId = optionalId(raw.umbrella_comment_id);
  if (sectionId === 'bad' || projectId === 'bad' || commentId === 'bad') {
    return { status: 400, body: { error: 'section_id, project_id and umbrella_comment_id must be ids or null.' } };
  }

  const { data, error } = await withCascadeRetry(() =>
    supabase.rpc('undo_break_task_into_tasks', {
      p_user_id: userId,
      p_task_id: taskId,
      p_request: { task_ids: taskIds, section_id: sectionId, project_id: projectId, umbrella_comment_id: commentId },
    })
  );
  if (error) return failure(error, 'undo the break');
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok !== true) {
    const refusal = breakRefusal(String(result.reason ?? ''));
    return { status: refusal.status, body: { error: refusal.error, reason: result.reason ?? 'refused' } };
  }
  return { status: 200, body: result };
}

export interface StepTaskSummary {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  owner: string | null;
  project_id: string | null;
  section_id: string | null;
}

export interface TaskStepsView {
  /** The umbrella this task was broken out of (null when it wasn't). */
  part_of: { id: string; title: string; status: string } | null;
  /** This task's steps, when it is an umbrella (empty otherwise). */
  step_tasks: StepTaskSummary[];
  /** "4/6 tasks done" / "All 6 steps done", or null without steps. */
  steps_progress: { done: number; total: number; all_done: boolean; text: string } | null;
}

/**
 * The umbrella links of one task, two small reads scoped by user (RLS also
 * applies). `parentTaskId` saves the first read when the caller has it.
 */
export async function loadTaskSteps(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  parentTaskId?: string | null
): Promise<TaskStepsView> {
  let parentId = parentTaskId;
  if (parentId === undefined) {
    const { data, error } = await supabase.from('tasks').select('parent_task_id').eq('id', taskId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    parentId = (data as { parent_task_id?: string | null } | null)?.parent_task_id ?? null;
  }

  const [parentRead, stepsRead] = await Promise.all([
    parentId
      ? supabase.from('tasks').select('id, title, status').eq('id', parentId).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('tasks')
      .select('id, title, status, due_at, owner, project_id, section_id, created_at')
      .eq('user_id', userId)
      .eq('parent_task_id', taskId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(200),
  ]);
  if (parentRead.error) throw parentRead.error;
  if (stepsRead.error) throw stepsRead.error;

  const steps = ((stepsRead.data ?? []) as Array<StepTaskSummary & { created_at?: string }>).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    due_at: row.due_at,
    owner: row.owner,
    project_id: row.project_id,
    section_id: row.section_id,
  }));
  const done = steps.filter((step) => step.status === 'Done').length;
  return {
    part_of: (parentRead.data as TaskStepsView['part_of']) ?? null,
    step_tasks: steps,
    steps_progress: steps.length
      ? { done, total: steps.length, all_done: done === steps.length, text: stepsDoneText(steps) ?? '' }
      : null,
  };
}
