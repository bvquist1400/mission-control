/**
 * The automated work surfaces use this exact, case-sensitive tag as a hard
 * exclusion. Tags are normalized to lowercase at the write boundary.
 */
export const PERSONAL_TAG = "personal";

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

export function excludePersonalTasks<T extends { tags?: string[] | null; project?: unknown }>(tasks: T[]): T[] {
  return tasks.filter((task) => !isPersonalTaskOrProject(task));
}
