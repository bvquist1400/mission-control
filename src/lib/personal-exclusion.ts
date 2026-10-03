/**
 * The automated work surfaces use this exact, case-sensitive tag as a hard
 * exclusion. Tags are normalized to lowercase at the write boundary.
 */
export const PERSONAL_TAG = "personal";
/**
 * A hobby project (or task) still counts toward Portfolio progress and the
 * timeline, but never lands in Brent's "Assigned to you" / "Coming to you later"
 * lists or his open counts: it is something he does for fun, not something
 * anyone is waiting on him for. Same exact, lowercase tag rule as `personal`.
 */
export const HOBBY_TAG = "hobby";
export const TASK_SCOPE_VALUES = ["work", "personal", "all"] as const;

export type TaskScope = (typeof TASK_SCOPE_VALUES)[number];

type TagCarrier = { tags?: string[] | null } | Array<{ tags?: string[] | null }> | null | undefined;

export function hasPersonalTag(item: TagCarrier): boolean {
  if (Array.isArray(item)) {
    return item.some((relation) => hasPersonalTag(relation));
  }
  return Array.isArray(item?.tags) && item.tags.includes(PERSONAL_TAG);
}

export function hasHobbyTag(item: TagCarrier): boolean {
  if (Array.isArray(item)) {
    return item.some((relation) => hasHobbyTag(relation));
  }
  return Array.isArray(item?.tags) && item.tags.includes(HOBBY_TAG);
}

/** The task carries the hobby tag itself, or belongs to a project that does. */
export function isHobbyTaskOrProject(task: { tags?: string[] | null; project?: unknown }): boolean {
  return hasHobbyTag(task) || hasHobbyTag(task.project as TagCarrier);
}

export function isPersonalTaskOrProject(task: { tags?: string[] | null; project?: unknown }): boolean {
  return hasPersonalTag(task) || hasPersonalTag(task.project as TagCarrier);
}

export function normalizeTaskScope(value: unknown, fallback: TaskScope = "all"): TaskScope {
  return typeof value === "string" && TASK_SCOPE_VALUES.includes(value as TaskScope)
    ? value as TaskScope
    : fallback;
}

export function matchesTaskScope(
  task: { tags?: string[] | null; project?: unknown },
  scope: TaskScope
): boolean {
  if (scope === "all") {
    return true;
  }

  const isPersonal = isPersonalTaskOrProject(task);
  return scope === "personal" ? isPersonal : !isPersonal;
}

export function filterTasksByScope<T extends { tags?: string[] | null; project?: unknown }>(
  tasks: T[],
  scope: TaskScope
): T[] {
  return tasks.filter((task) => matchesTaskScope(task, scope));
}

export function setPersonalTag(tags: string[] | null | undefined, personal: boolean): string[] {
  const withoutPersonal = (tags ?? []).filter((tag) => tag !== PERSONAL_TAG);
  return personal ? [...withoutPersonal, PERSONAL_TAG] : withoutPersonal;
}

export function excludePersonalTasks<T extends { tags?: string[] | null; project?: unknown }>(tasks: T[]): T[] {
  return filterTasksByScope(tasks, "work");
}

/** PostgREST returns a to-one relation as an object, but sometimes as a one-item array. */
function relationList(value: unknown): Array<{ tags?: string[] | null; project?: unknown }> {
  if (Array.isArray(value)) return value as Array<{ tags?: string[] | null; project?: unknown }>;
  return value ? [value as { tags?: string[] | null; project?: unknown }] : [];
}

/**
 * Drops commitments whose linked task is personal (its own tag, or its project's).
 * The commitment select must carry `task:tasks(..., tags, project:projects(tags))`.
 * A commitment with no linked task stays: nothing marks it personal.
 */
export function excludePersonalCommitments<T extends { task?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !relationList(row.task).some((task) => isPersonalTaskOrProject(task)));
}

/**
 * Drops project status updates that belong to a personal project.
 * The select must carry `project:projects(..., tags)`.
 */
export function excludePersonalProjectUpdates<T extends { project?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !hasPersonalTag(row.project as TagCarrier));
}
