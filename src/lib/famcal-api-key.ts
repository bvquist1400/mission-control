import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPersonalTag, PERSONAL_TAG } from '@/lib/personal-exclusion';
import type { TaskStatus } from '@/types/database';

/**
 * The FamCal key (`MISSION_CONTROL_FAMCAL_API_KEY`, authSource `famcal_api_key`)
 * lets the FamCal Sunday brief read and lightly update Brent's personal tasks.
 * It can never see or change a task that does not carry the `personal` tag
 * itself (the task's own tags, not its project's), and it reaches only the five
 * route/method pairs below. Work surfaces still exclude `personal` exactly as
 * before; this file only narrows what the FamCal key can do.
 */
export const FAMCAL_REQUIRED_TAG = PERSONAL_TAG;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// Task ids must be UUIDs so static siblings (/api/tasks/parked, /recurring,
// /lookup-external, /parse, /generate-recurring) never match the [id] rules.
export const FAMCAL_ROUTE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; methods: ReadonlyArray<string> }> = [
  { pattern: /^\/api\/tasks$/, methods: ['GET'] },
  { pattern: new RegExp(`^/api/tasks/${UUID}$`), methods: ['GET', 'PATCH'] },
  { pattern: new RegExp(`^/api/tasks/${UUID}/comments$`), methods: ['GET', 'POST'] },
  { pattern: new RegExp(`^/api/tasks/park/${UUID}$`), methods: ['POST'] },
];

export function isFamcalKeyRouteAllowed(method: string, pathname: string): boolean {
  const upperMethod = method.toUpperCase();
  if (upperMethod === 'DELETE') {
    return false;
  }

  return FAMCAL_ROUTE_ALLOWLIST.some(
    (rule) => rule.methods.includes(upperMethod) && rule.pattern.test(pathname)
  );
}

/** Statuses the FamCal key may set: closing a task, or reopening one it closed. */
export const FAMCAL_CLOSED_STATUSES: ReadonlyArray<TaskStatus> = ['Done', 'Parked'];
export const FAMCAL_REOPEN_STATUSES: ReadonlyArray<TaskStatus> = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting'];
export const FAMCAL_PATCH_FIELDS = ['status', 'due_at', 'follow_up_at'] as const;

export type FamcalTaskPatch = Partial<Record<(typeof FAMCAL_PATCH_FIELDS)[number], unknown>>;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Shape check for a FamCal-key PATCH body. Only status, due_at and
 * follow_up_at are accepted; any other field (owner, tags, title, project…)
 * is refused outright rather than silently dropped. Date values are validated
 * afterwards by the route's normal timestamp check.
 */
export function parseFamcalTaskPatch(body: unknown): ParseResult<FamcalTaskPatch> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const disallowed = keys.filter((key) => !(FAMCAL_PATCH_FIELDS as ReadonlyArray<string>).includes(key));
  if (disallowed.length > 0) {
    return {
      ok: false,
      error: `This key can only change ${FAMCAL_PATCH_FIELDS.join(', ')} (not ${disallowed.join(', ')})`,
    };
  }

  if (keys.length === 0) {
    return { ok: false, error: 'No valid fields to update' };
  }

  // Dates can be moved, not cleared: the brief's buttons always send a date.
  for (const field of ['due_at', 'follow_up_at'] as const) {
    if (field in record && (typeof record[field] !== 'string' || (record[field] as string).trim() === '')) {
      return { ok: false, error: `${field} must be a date; this key cannot clear it` };
    }
  }

  if ('status' in record) {
    const status = record.status;
    const allowed = [...FAMCAL_CLOSED_STATUSES, ...FAMCAL_REOPEN_STATUSES] as ReadonlyArray<string>;
    if (typeof status !== 'string' || !allowed.includes(status)) {
      return {
        ok: false,
        error: `This key can only set status to one of: ${allowed.join(', ')}`,
      };
    }
  }

  return { ok: true, value: { ...record } as FamcalTaskPatch };
}

/**
 * Done and Parked are always allowed. An open status is allowed only to undo:
 * the task must currently be Done or Parked (or already in that same status,
 * which is a harmless repeat). Missed is never set by this key.
 */
export function checkFamcalStatusTransition(currentStatus: string, nextStatus: string): string | null {
  if ((FAMCAL_CLOSED_STATUSES as ReadonlyArray<string>).includes(nextStatus)) {
    return null;
  }

  if (!(FAMCAL_REOPEN_STATUSES as ReadonlyArray<string>).includes(nextStatus)) {
    return `This key cannot set status ${nextStatus}`;
  }

  if (currentStatus === nextStatus) {
    return null;
  }

  if ((FAMCAL_CLOSED_STATUSES as ReadonlyArray<string>).includes(currentStatus)) {
    return null;
  }

  return 'This key can only reopen a task that is Done or Parked';
}

/** The key sees a task only when the task itself carries the personal tag. */
export function isFamcalVisibleTask(task: { tags?: string[] | null } | null | undefined): boolean {
  return Boolean(task) && hasPersonalTag(task);
}

/** Tags the list query must contain for the FamCal key: always `personal`, plus any extra tag asked for. */
export function famcalListRequiredTags(requestedTag: string | null | undefined): string[] {
  const tag = typeof requestedTag === 'string' ? requestedTag.trim() : '';
  if (!tag || tag === FAMCAL_REQUIRED_TAG) {
    return [FAMCAL_REQUIRED_TAG];
  }
  return [FAMCAL_REQUIRED_TAG, tag];
}

export const FAMCAL_DEPENDENCY_TASK_TITLE = 'Another task';
export const FAMCAL_DEPENDENCY_COMMITMENT_TITLE = 'A commitment';

interface RedactableDependency {
  title: string;
  status: string;
  unresolved: boolean;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
}

/**
 * A personal task can depend on a work task or a stakeholder commitment. The
 * FamCal key keeps the dependency rows (so `dependency_blocked`, `unresolved`
 * and the array shape are unchanged) but nothing about the linked item: no
 * title, no real status, no id. Status only says what `unresolved` already
 * says, in the linked item's own vocabulary: a task is Blocked/Waiting while
 * unresolved, a commitment Open; either is Done once resolved.
 */
export function redactDependencyForFamcal<T extends RedactableDependency>(dependency: T): T {
  const isTask = Boolean(dependency.depends_on_task_id);
  return {
    ...dependency,
    title: isTask ? FAMCAL_DEPENDENCY_TASK_TITLE : FAMCAL_DEPENDENCY_COMMITMENT_TITLE,
    status: dependency.unresolved ? (isTask ? 'Blocked/Waiting' : 'Open') : 'Done',
    depends_on_task_id: null,
    depends_on_commitment_id: null,
  };
}

/**
 * List filters the FamCal key may not use. Each names a work relation
 * (application, sprint, project, section); filtering by one would tell the
 * caller which personal tasks sit in it, so it is refused (400), not ignored.
 */
export const FAMCAL_REFUSED_LIST_PARAMS = ['implementation_id', 'sprint_id', 'project_id', 'section_id'] as const;

/** The first refused list parameter present (even when empty), or null. */
export function famcalRefusedListParam(searchParams: URLSearchParams): string | null {
  if (searchParams.has('view')) {
    return 'view';
  }
  return FAMCAL_REFUSED_LIST_PARAMS.find((name) => searchParams.has(name)) ?? null;
}

/**
 * The task's own columns the FamCal key may read: an explicit allowlist, so a
 * column added later stays hidden until someone adds it here. Left out on
 * purpose: user_id, inbox_item_id (intelligence inbox), recurring_template_id,
 * latest_instance_id and last_generated_at (other task rows), and
 * external_source_system / external_source_id (other systems' ids).
 * implementation_id, sprint_id, project_id and section_id are decided by
 * projectTaskForFamcal below, never copied straight through.
 */
export const FAMCAL_TASK_FIELDS = [
  'id',
  'title',
  'description',
  'status',
  'task_type',
  'tags',
  'due_at',
  'follow_up_at',
  'waiting_on',
  'blocked_reason',
  'blocker',
  'status_line',
  'owner',
  'owner_label',
  'needs_review',
  'pinned',
  'pinned_excerpt',
  'priority_score',
  'base_priority',
  'estimated_minutes',
  'estimate_source',
  'actual_minutes',
  'stakeholder_mentions',
  'source_type',
  'source_url',
  'unit_count',
  'work_type',
  'is_sample',
  'is_recurring_template',
  'recurrence',
  'created_at',
  'updated_at',
] as const;

/** Project fields kept when the task's project is itself tagged `personal`. */
export const FAMCAL_PROJECT_FIELDS = ['id', 'name', 'stage', 'rag', 'tags'] as const;

type Relation = Record<string, unknown>;

function singleRelation(value: unknown): Relation | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === 'object' ? (row as Relation) : null;
}

function pick(source: Relation, fields: ReadonlyArray<string>): Relation {
  const out: Relation = {};
  for (const field of fields) {
    out[field] = field in source ? source[field] : null;
  }
  return out;
}

export interface FamcalTaskView extends Record<string, unknown> {
  id: string;
  project_id: string | null;
  section_id: string | null;
  implementation_id: null;
  sprint_id: null;
  project: Record<string, unknown> | null;
  implementation: null;
  sprint: null;
  section_name: string | null;
}

/**
 * The only shape a task leaves the API in for the FamCal key (list, detail,
 * PATCH and park). Takes the raw row selected with TASK_WITH_RELATIONS_SELECT.
 *
 * - The task's own fields: FAMCAL_TASK_FIELDS only.
 * - Project: kept (id, name, stage, rag, tags) only when the project itself
 *   carries `personal`; otherwise project and project_id are null.
 * - Section: its name and id only when it belongs to that kept personal project.
 * - Application and sprint: always null (they carry no personal tag, so they are
 *   treated as work), and so are implementation_id and sprint_id.
 *
 * The keys are the same for every task, so FamCal sees a stable shape.
 */
export function projectTaskForFamcal(row: Record<string, unknown>): FamcalTaskView {
  const project = singleRelation(row.project);
  const section = singleRelation(row.section);
  const keptProject = project && hasPersonalTag(project as { tags?: string[] | null }) && typeof project.id === 'string'
    ? pick(project, FAMCAL_PROJECT_FIELDS)
    : null;
  const keptSection = keptProject && section && section.project_id === keptProject.id && typeof section.name === 'string'
    ? section
    : null;

  return {
    ...(pick(row, FAMCAL_TASK_FIELDS) as { id: string }),
    project_id: keptProject ? (keptProject.id as string) : null,
    section_id: keptSection && typeof row.section_id === 'string' ? row.section_id : null,
    implementation_id: null,
    sprint_id: null,
    project: keptProject,
    implementation: null,
    sprint: null,
    section_name: keptSection ? (keptSection.name as string) : null,
  };
}

export interface FamcalVisibleTask {
  id: string;
  status: TaskStatus;
  tags: string[] | null;
}

/**
 * Loads the task's id, status and tags for the per-task guard. Returns null when
 * the task does not exist for this user or does not carry the personal tag, so
 * the caller answers 404 either way and never reveals that a work task exists.
 */
export async function fetchFamcalVisibleTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<FamcalVisibleTask | null> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, status, tags')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as FamcalVisibleTask | null;
  if (!row || !isFamcalVisibleTask(row)) {
    return null;
  }

  return row;
}

/** The RPC (migration 060) behind the FamCal key's comment POST. */
export const FAMCAL_ADD_COMMENT_RPC = 'famcal_add_personal_task_comment';

export interface FamcalTaskComment {
  id: string;
  task_id: string;
  user_id: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * Adds a comment to a personal task in one transaction: the function locks the
 * task row (FOR SHARE, so a concurrent retag waits), checks the user and the
 * exact `personal` tag under that lock, and inserts. Returns null (→ 404) when
 * the task is missing, someone else's or not personal; nothing is written then.
 * Any error means the transaction rolled back, so a 500 never leaves a comment.
 */
export async function addFamcalTaskComment(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  content: string,
  source: string
): Promise<FamcalTaskComment | null> {
  const { data, error } = await supabase.rpc(FAMCAL_ADD_COMMENT_RPC, {
    p_user_id: userId,
    p_task_id: taskId,
    p_content: content,
    p_source: source,
  });

  if (error) {
    throw error;
  }

  const rows = (Array.isArray(data) ? data : data ? [data] : []) as FamcalTaskComment[];
  return rows[0] ?? null;
}

/**
 * Reads a personal task's comments, oldest first, in ONE query: the task row
 * (filtered by id, user and the `personal` tag) with its comments embedded.
 * PostgREST runs it as a single SQL statement, so the tag check and the comment
 * read share one snapshot. Returns null (→ 404) when there is no such personal
 * task; a personal task with no comments is an empty array.
 */
export async function readFamcalTaskComments(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<FamcalTaskComment[] | null> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, task_comments(id, task_id, user_id, content, source, created_at, updated_at)')
    .eq('id', taskId)
    .eq('user_id', userId)
    .contains('tags', [FAMCAL_REQUIRED_TAG])
    .eq('task_comments.user_id', userId)
    .order('created_at', { referencedTable: 'task_comments', ascending: true })
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const comments = (data as { task_comments?: FamcalTaskComment[] | null }).task_comments;
  return Array.isArray(comments) ? comments : [];
}
