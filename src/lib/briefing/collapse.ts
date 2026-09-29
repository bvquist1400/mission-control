/**
 * Helpers for the brief's task lists: collapse identical titles into one entry
 * and say how big a list was before any cap was applied.
 *
 * Why: a list of eight open tasks with the same title (old weekly copies of a
 * deleted recurring task, say) used to show up as eight lines in one brief and,
 * after a top-5 cap, as four lines in the next. A reader saw "four, then eight,
 * so it is duplicating itself". Collapsing the copies into one entry with a
 * count, and always reporting the pre-cap total, means a capped or repeated
 * list can no longer be mistaken for a change in the real number.
 */

export interface TitleGroup<T> {
  /** The first item in list order (list order is already priority/time order). */
  first: T;
  /** Every item in the group, `first` included. */
  members: T[];
}

export interface ListTotals {
  /** Tasks before collapsing and before any cap. */
  tasks: number;
  /** Entries after identical titles were collapsed, before any cap. */
  entries: number;
  /** Entries actually returned. */
  shown: number;
  /** True when entries were dropped by a cap (shown < entries). */
  capped: boolean;
}

/** Lowercase, collapse whitespace, trim. Two titles that differ only in that are "identical". */
export function normalizeTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Group items whose normalized titles are identical, keeping first-seen order.
 * Items with an empty title never group together.
 */
export function groupByIdenticalTitle<T>(items: T[], getTitle: (item: T) => string): Array<TitleGroup<T>> {
  const groups: Array<TitleGroup<T>> = [];
  const byKey = new Map<string, TitleGroup<T>>();

  for (const item of items) {
    const key = normalizeTitleKey(getTitle(item));
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.members.push(item);
      continue;
    }

    const group: TitleGroup<T> = { first: item, members: [item] };
    groups.push(group);
    if (key) {
      byKey.set(key, group);
    }
  }

  return groups;
}

/** Earliest and latest of some ISO timestamps; null when none are usable. */
export function isoRange(values: Array<string | null | undefined>): { from: string; to: string } | null {
  const usable = values.filter((value): value is string => typeof value === "string" && value.length > 0).sort();
  if (usable.length === 0) {
    return null;
  }

  return { from: usable[0], to: usable[usable.length - 1] };
}

export function buildListTotals(tasks: number, entries: number, shown: number): ListTotals {
  return { tasks, entries, shown, capped: shown < entries };
}

/** "8 identical open tasks" for a collapsed entry, "" otherwise. */
export function describeDuplicates(duplicateCount: number | null | undefined): string {
  return duplicateCount && duplicateCount > 1 ? `${duplicateCount} identical open tasks` : "";
}
