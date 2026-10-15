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
 * says (Blocked/Waiting while unresolved, else Done).
 */
export function redactDependencyForFamcal<T extends RedactableDependency>(dependency: T): T {
  return {
    ...dependency,
    title: dependency.depends_on_task_id ? FAMCAL_DEPENDENCY_TASK_TITLE : FAMCAL_DEPENDENCY_COMMITMENT_TITLE,
    status: dependency.unresolved ? 'Blocked/Waiting' : 'Done',
    depends_on_task_id: null,
    depends_on_commitment_id: null,
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
