/**
 * The automated work surfaces use this exact, case-sensitive tag as a hard
 * exclusion. Tags are normalized to lowercase at the write boundary.
 */
export const PERSONAL_TAG = "personal";
export const TASK_SCOPE_VALUES = ["work", "personal", "all"] as const;

export type TaskScope = (typeof TASK_SCOPE_VALUES)[number];

type TagCarrier = { tags?: string[] | null } | Array<{ tags?: string[] | null }> | null | undefined;

export function hasPersonalTag(item: TagCarrier): boolean {
  if (Array.isArray(item)) {
    return item.some((relation) => hasPersonalTag(relation));
  }
  return Array.isArray(item?.tags) && item.tags.includes(PERSONAL_TAG);
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
