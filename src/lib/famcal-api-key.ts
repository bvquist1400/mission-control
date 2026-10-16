import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPersonalTag, PERSONAL_TAG } from '@/lib/personal-exclusion';
import { coerceTaskRecurrence } from '@/lib/recurrence';
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

/**
 * PostgREST computed field (migration 060, `famcal_eligible(tasks)`): the one
 * definition of which tasks the FamCal key may see or change. Every FamCal read
 * and write filters on `famcal_eligible = true` in the same query, so an
 * ineligible task is simply "not found" (404, same body as a missing one).
 *
 * Eligible (Brent, 10/16: "Leave it out of the brief") only when ALL hold:
 * - the task's own tags contain `personal`;
 * - it has no sprint;
 * - EITHER it has no project, no application and no section (a standalone
 *   to-do), OR its project is the same user's and is itself tagged `personal`.
 * isFamcalEligibleRow below mirrors it in code for rows read with their project.
 */
export const FAMCAL_ELIGIBLE_FIELD = 'famcal_eligible';

/** Code mirror of famcal_eligible for a row selected with its `project` relation (defence in depth). */
export function isFamcalEligibleRow(row: Record<string, unknown> | null | undefined): boolean {
  if (!row || !hasPersonalTag(row as { tags?: string[] | null })) {
    return false;
  }
  if (row.sprint_id) {
    return false;
  }
  if (!row.project_id) {
    return !row.implementation_id && !row.section_id;
  }
  const projectValue = Array.isArray(row.project) ? row.project[0] : row.project;
  const project = projectValue && typeof projectValue === 'object' ? (projectValue as Record<string, unknown>) : null;
  return Boolean(project)
    && project!.id === row.project_id
    && hasPersonalTag(project as { tags?: string[] | null });
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
 * The only query parameters GET /api/tasks accepts from the FamCal key: a strict
 * allowlist. Each one filters or pages on the task's own, returned fields. Every
 * other parameter is a 400 whenever it is present, even empty: `view` (views
 * ignore the tag filter), the work-relation filters (implementation_id,
 * sprint_id, project_id, section_id), external_source_system/_id (hidden ids of
 * other systems), scope, and anything added to the route later. A parameter
 * given twice is a 400 too. FamCal S1 sends only `tag` and `limit`.
 */
export const FAMCAL_LIST_PARAMS = [
  'tag',
  'limit',
  'offset',
  'status',
  'owner',
  'needs_review',
  'due_soon',
  'include_done',
  'include_parked',
  'include_missed',
] as const;

/** Why this list query is refused for the FamCal key, or null when it is fine. */
export function famcalListParamError(searchParams: URLSearchParams): string | null {
  const seen = new Set<string>();
  for (const name of searchParams.keys()) {
    if (!(FAMCAL_LIST_PARAMS as ReadonlyArray<string>).includes(name)) {
      return `${name} is not available with this key`;
    }
    if (seen.has(name)) {
      return `${name} may only be given once`;
    }
    seen.add(name);
  }
  return null;
}

/**
 * The task's own columns the FamCal key may read: an explicit allowlist, so a
 * column added later stays hidden until someone adds it here. Left out on
 * purpose: user_id, inbox_item_id (intelligence inbox), recurring_template_id,
 * latest_instance_id and last_generated_at (other task rows), and
 * external_source_system / external_source_id (other systems' ids), and
 * source_url (a link that may point into another system; FamCal doesn't read it).
 * `recurrence` is not copied either: projectRecurrenceForFamcal rebuilds it from
 * FAMCAL_RECURRENCE_FIELDS.
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
  'unit_count',
  'work_type',
  'is_sample',
  'is_recurring_template',
  'created_at',
  'updated_at',
] as const;

/**
 * Recurrence settings the FamCal key may read: scalar scheduling fields only.
 * Never `template_task_id` (a generated occurrence carries its template's id,
 * and the template may be a work task) and never a key added later.
 */
export const FAMCAL_RECURRENCE_FIELDS = ['enabled', 'frequency', 'auto_mark_missed', 'day_of_week', 'day_of_month', 'next_due'] as const;

/** The recurrence JSON reduced to FAMCAL_RECURRENCE_FIELDS, or null when absent or invalid. */
export function projectRecurrenceForFamcal(value: unknown): Record<string, unknown> | null {
  const recurrence = coerceTaskRecurrence(value);
  if (!recurrence) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const field of FAMCAL_RECURRENCE_FIELDS) {
    out[field] = recurrence[field];
  }
  return out;
}

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
    recurrence: projectRecurrenceForFamcal(row.recurrence),
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
 * the task does not exist for this user or is not FamCal-eligible (filtered in
 * the same query), so the caller answers 404 either way and never reveals that
 * a work task exists.
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
    .contains('tags', [FAMCAL_REQUIRED_TAG])
    .eq(FAMCAL_ELIGIBLE_FIELD, true)
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
 * A SQL error inside the function rolls the transaction back, so that 500 leaves
 * no comment. A connection lost after the function committed is ambiguous: the
 * caller gets a 500 although the comment exists, and a retry adds a second one.
 * There is no idempotency token yet (proposed follow-up), so callers should not
 * auto-retry a comment POST.
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
    .eq(FAMCAL_ELIGIBLE_FIELD, true)
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
