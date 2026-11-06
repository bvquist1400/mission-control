/**
 * The Tasks page (redesign S5; plan row S5, NOTES.md "Tasks rows as cards",
 * mockups d2-schemes.html / d3-olive.html Tasks frames). Pure rules only, so
 * they are tested without a browser (`npm run test:tasks-list`):
 *
 *   - the one filter row (status, app, project, sprint, owner, due, review,
 *     search, sort) read from and written to the URL, so a link reproduces the
 *     view (`parseTaskListFilters`, `taskListHref`);
 *   - which tasks match (`matchesTaskListFilters`), their order, the status
 *     groups and the "Show n more" fold (`groupTaskList`, `taskListOrder`: the
 *     order the cards are drawn in, which the task panel's ↑ / ↓ follow);
 *   - saved views: the built-in ones and the user's own, kept per device in
 *     localStorage (no database table; `readSavedViews`, `addSavedView`);
 *   - bulk edit: the selection (`toggleSelection`, `selectRange`,
 *     `pruneSelection`) and what each change sends and how Undo puts it back
 *     (`bulkEditPlan`);
 *   - the words on a card (`taskCardDue`, `ownerText`).
 */
import { etDate, etToday, isPastDue, rangeOf } from './task-range';
import { addDateOnlyDays } from './today/week-board';
import { dueAtForBoardDay, dueTimeText, stripDateLabel, weekdayOf } from './today/today-board';

// ── Filters and the URL ───────────────────────────────────────────────────

export const TASK_STATUS_ORDER = ['In Progress', 'Blocked/Waiting', 'Planned', 'Backlog', 'Parked', 'Done', 'Missed'] as const;
export type ListTaskStatus = (typeof TASK_STATUS_ORDER)[number];

/** URL words for the statuses ("in-progress"), so links stay readable. */
export const STATUS_SLUGS: Record<ListTaskStatus, string> = {
  'In Progress': 'in-progress',
  'Blocked/Waiting': 'waiting',
  Planned: 'planned',
  Backlog: 'backlog',
  Parked: 'parked',
  Done: 'done',
  Missed: 'missed',
};

/** Group headings and the Status menu (mockup: "In progress", "Planned", "Backlog"). */
export const STATUS_LABELS: Record<ListTaskStatus, string> = {
  'In Progress': 'In progress',
  'Blocked/Waiting': 'Waiting',
  Planned: 'Planned',
  Backlog: 'Backlog',
  Parked: 'Parked',
  Done: 'Done',
  Missed: 'Missed',
};

/** "open" = everything not Done or Missed (the old default list); "all" adds Done. */
export type StatusFilterValue = 'open' | 'all' | ListTaskStatus;
export type DueFilterValue = 'late' | 'today' | 'week' | 'none' | 'dated';
export type SortValue = 'due' | 'priority' | 'estimate' | 'title' | 'updated';
export type ReviewFilterValue = 'needs_review' | 'ready';

export const DUE_LABELS: Record<DueFilterValue, string> = {
  late: 'Late',
  today: 'Due today',
  week: 'Due this week',
  none: 'No date',
  dated: 'Has a date',
};

export const SORT_LABELS: Record<SortValue, string> = {
  due: 'Due date',
  priority: 'Priority',
  estimate: 'Estimate (shortest first)',
  title: 'Title',
  updated: 'Recently changed',
};

/** "none" = not set (the old "Unassigned"); otherwise an id. null = any. */
export interface TaskListFilters {
  status: StatusFilterValue;
  app: string | null;
  project: string | null;
  sprint: string | null;
  /**
   * "me" (Brent must act), "agent" (an agent by name: the cards that show an
   * "Agent: …" chip), "agent:<label>" (one agent), "none" (an agent holds it
   * with no name: the default for new tasks, no chip on the card).
   */
  owner: string | null;
  due: DueFilterValue | null;
  review: ReviewFilterValue | null;
  q: string;
  /** due (default), priority, estimate (shortest first), title, updated. */
  sort: SortValue;
}

export const DEFAULT_TASK_LIST_FILTERS: TaskListFilters = {
  status: 'open',
  app: null,
  project: null,
  sprint: null,
  owner: null,
  due: null,
  review: null,
  q: '',
  sort: 'due',
};

/** The URL parameters the filter row owns (others, like ?task= and ?scope=, are left alone). */
export const FILTER_PARAMS = ['status', 'app', 'project', 'sprint', 'owner', 'due', 'review', 'q', 'sort'] as const;

const MAX_ID_LENGTH = 100;
const MAX_QUERY_LENGTH = 200;

interface ParamReader {
  get(name: string): string | null;
}

function firstParam(params: ParamReader | URLSearchParams | string | null | undefined, key: string): string | null {
  if (!params) return null;
  const reader = typeof params === 'string' ? new URLSearchParams(params.startsWith('?') ? params.slice(1) : params) : params;
  const value = reader.get(key);
  return typeof value === 'string' ? value : null;
}

function parseStatus(raw: string | null): StatusFilterValue {
  if (!raw) return 'open';
  const value = raw.trim().toLowerCase();
  if (value === 'open' || value === '') return 'open';
  if (value === 'all') return 'all';
  for (const status of TASK_STATUS_ORDER) {
    if (value === STATUS_SLUGS[status] || value === status.toLowerCase()) return status;
  }
  // Older words people may have bookmarked.
  if (value === 'blocked' || value === 'blocked-waiting') return 'Blocked/Waiting';
  return 'open';
}

function parseRef(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'all' || value.toLowerCase() === 'any') return null;
  if (value.toLowerCase() === 'none' || value.toLowerCase() === 'unassigned') return 'none';
  return value.length > MAX_ID_LENGTH ? null : value;
}

function parseOwner(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (!value || lower === 'anyone' || lower === 'all') return null;
  if (lower === 'me' || lower === 'brent' || lower === 'you') return 'me';
  if (lower === 'agent' || lower === 'agents') return 'agent';
  if (lower === 'none' || lower === 'nobody' || lower === 'unnamed') return 'none';
  if (lower.startsWith('agent:')) {
    const label = value.slice(6).trim();
    return label && label.length <= 40 ? `agent:${label}` : 'agent';
  }
  return null;
}

/** The filters a URL asks for. Anything unknown falls back to the default, never throws. */
export function parseTaskListFilters(params: ParamReader | URLSearchParams | string | null | undefined): TaskListFilters {
  const due = firstParam(params, 'due')?.trim().toLowerCase() ?? '';
  const sort = firstParam(params, 'sort')?.trim().toLowerCase() ?? '';
  const review = firstParam(params, 'review')?.trim().toLowerCase() ?? '';
  const q = (firstParam(params, 'q') ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
  return {
    status: parseStatus(firstParam(params, 'status')),
    app: parseRef(firstParam(params, 'app')),
    project: parseRef(firstParam(params, 'project')),
    sprint: parseRef(firstParam(params, 'sprint')),
    owner: parseOwner(firstParam(params, 'owner')),
    due: (Object.keys(DUE_LABELS) as DueFilterValue[]).includes(due as DueFilterValue) ? (due as DueFilterValue) : null,
    review: review === 'needs_review' || review === 'ready' ? review : null,
    q,
    sort: (Object.keys(SORT_LABELS) as SortValue[]).includes(sort as SortValue) ? (sort as SortValue) : 'due',
  };
}

/** The filter part of a query string, defaults left out, in a fixed order (so equal views compare equal). */
export function filtersQuery(filters: TaskListFilters, options: { includeSort?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (filters.status !== 'open') params.set('status', filters.status === 'all' ? 'all' : STATUS_SLUGS[filters.status]);
  if (filters.app) params.set('app', filters.app);
  if (filters.project) params.set('project', filters.project);
  if (filters.sprint) params.set('sprint', filters.sprint);
  if (filters.owner) params.set('owner', filters.owner);
  if (filters.due) params.set('due', filters.due);
  if (filters.review) params.set('review', filters.review);
  if (filters.q) params.set('q', filters.q);
  if (options.includeSort !== false && filters.sort !== 'due') params.set('sort', filters.sort);
  return params.toString();
}

/**
 * The Tasks page with these filters. Other params already in the URL (the open
 * task, the Work / Personal / All scope) are kept; the filter params are
 * rewritten; the old `expand` link param goes.
 */
export function taskListHref(pathname: string, currentSearch: string, filters: TaskListFilters): string {
  const current = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  const next = new URLSearchParams();
  for (const [key, value] of current) {
    if ((FILTER_PARAMS as readonly string[]).includes(key) || key === 'expand') continue;
    next.append(key, value);
  }
  for (const [key, value] of new URLSearchParams(filtersQuery(filters))) next.set(key, value);
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ''}`;
}

/** How many filters differ from the default (the phone's "Filters (n)" button). Search and sort don't count. */
export function activeFilterCount(filters: TaskListFilters): number {
  let count = 0;
  if (filters.status !== 'open') count += 1;
  for (const key of ['app', 'project', 'sprint', 'owner', 'due', 'review'] as const) if (filters[key]) count += 1;
  return count;
}

/** The list needs Done rows from the server (they aren't loaded by default). */
export function filtersNeedDone(filters: Pick<TaskListFilters, 'status'>): boolean {
  return filters.status === 'all' || filters.status === 'Done';
}

/** The loader's Missed switch (task-loader.ts `backlogNeedsMissed`) gets this status word. */
export function statusForLoader(filters: Pick<TaskListFilters, 'status'>): string {
  return filters.status === 'Missed' ? 'Missed' : 'All';
}

// ── Matching ──────────────────────────────────────────────────────────────

export interface ListTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  due_at: string | null;
  start_at?: string | null;
  implementation_id?: string | null;
  project_id?: string | null;
  sprint_id?: string | null;
  owner?: string | null;
  owner_label?: string | null;
  status_line?: string | null;
  needs_review?: boolean | null;
  priority_score?: number | null;
  estimated_minutes?: number | null;
  updated_at?: string | null;
  tags?: string[] | null;
  project?: unknown;
}

export interface ListClock {
  now: Date;
  /** Today's ET date. */
  today: string;
  /** Sunday of this ET week (weeks start Monday). */
  weekEnd: string;
}

export function listClock(now: Date): ListClock {
  const today = etToday(now);
  const dow = weekdayOf(today);
  const weekStart = addDateOnlyDays(today, dow === 0 ? -6 : 1 - dow);
  return { now, today, weekEnd: addDateOnlyDays(weekStart, 6) };
}

const CLOSED: ReadonlyArray<string> = ['Done', 'Missed'];

function matchesRef(value: string | null | undefined, filter: string | null): boolean {
  if (!filter) return true;
  if (filter === 'none') return !value;
  return value === filter;
}

export function matchesOwner(task: Pick<ListTask, 'owner' | 'owner_label'>, owner: string | null): boolean {
  if (!owner) return true;
  if (owner === 'me') return task.owner === 'brent';
  if (owner === 'agent') return task.owner === 'agent' && Boolean((task.owner_label ?? '').trim());
  if (owner === 'none') return task.owner !== 'brent' && !(task.owner_label ?? '').trim();
  if (owner.startsWith('agent:')) {
    return task.owner === 'agent' && (task.owner_label ?? '').trim().toLowerCase() === owner.slice(6).trim().toLowerCase();
  }
  return true;
}

export function matchesDue(task: Pick<ListTask, 'due_at' | 'status'>, due: DueFilterValue | null, clock: ListClock): boolean {
  if (!due) return true;
  const dueDate = etDate(task.due_at);
  switch (due) {
    case 'none':
      return !dueDate;
    case 'dated':
      return Boolean(dueDate);
    case 'today':
      return dueDate === clock.today;
    case 'week':
      // Due by Sunday, late ones included (what's left this week).
      return Boolean(dueDate) && (dueDate as string) <= clock.weekEnd;
    case 'late':
      return Boolean(dueDate) && !CLOSED.includes(task.status) && task.status !== 'Parked' && isPastDue(task.due_at, clock.now);
    default:
      return true;
  }
}

export function matchesStatus(status: string, filter: StatusFilterValue): boolean {
  if (filter === 'open') return !CLOSED.includes(status);
  if (filter === 'all') return status !== 'Missed';
  return status === filter;
}

export function matchesTaskListFilters(task: ListTask, filters: TaskListFilters, clock: ListClock): boolean {
  if (!matchesStatus(task.status, filters.status)) return false;
  if (!matchesRef(task.implementation_id, filters.app)) return false;
  if (!matchesRef(task.project_id, filters.project)) return false;
  if (!matchesRef(task.sprint_id, filters.sprint)) return false;
  if (!matchesOwner(task, filters.owner)) return false;
  if (!matchesDue(task, filters.due, clock)) return false;
  if (filters.review === 'needs_review' && !task.needs_review) return false;
  if (filters.review === 'ready' && task.needs_review) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const hay = `${task.title}\n${task.description ?? ''}\n${task.status_line ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// ── Order, groups, the fold ───────────────────────────────────────────────

function dueMs(task: Pick<ListTask, 'due_at'>): number | null {
  if (!task.due_at) return null;
  const ms = Date.parse(task.due_at);
  return Number.isFinite(ms) ? ms : null;
}

function byTitleThenId(a: ListTask, b: ListTask): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

export function compareTasks(a: ListTask, b: ListTask, sort: SortValue): number {
  const pa = a.priority_score ?? 0;
  const pb = b.priority_score ?? 0;
  if (sort === 'title') return byTitleThenId(a, b);
  if (sort === 'updated') {
    const ua = a.updated_at ? Date.parse(a.updated_at) : 0;
    const ub = b.updated_at ? Date.parse(b.updated_at) : 0;
    return ub - ua || byTitleThenId(a, b);
  }
  if (sort === 'priority') {
    if (pa !== pb) return pb - pa;
  }
  if (sort === 'estimate') {
    // Shortest first (quick wins); a task without an estimate last; then by due date.
    const ea = typeof a.estimated_minutes === 'number' && a.estimated_minutes > 0 ? a.estimated_minutes : Number.POSITIVE_INFINITY;
    const eb = typeof b.estimated_minutes === 'number' && b.estimated_minutes > 0 ? b.estimated_minutes : Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea < eb ? -1 : 1;
  }
  // Due date: soonest first (late ones on top), undated last.
  const da = dueMs(a);
  const db = dueMs(b);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  if (pa !== pb) return pb - pa;
  return byTitleThenId(a, b);
}

/** Cards shown per group before "Show n more" (a long Backlog stays light). */
export const GROUP_LIMIT = 40;

export interface TaskListGroup<T extends ListTask> {
  status: ListTaskStatus;
  label: string;
  /** Every matching task in the group, in order. */
  tasks: T[];
  /** The ones drawn (the fold applied). */
  shown: T[];
  hidden: number;
}

/**
 * The matching tasks in status groups (In progress, Waiting, Planned, Backlog,
 * Parked, Done, Missed), each sorted, empty groups left out. A group longer
 * than the limit shows the first `limit` until it is expanded.
 */
export function groupTaskList<T extends ListTask>(
  tasks: ReadonlyArray<T>,
  sort: SortValue,
  expanded: ReadonlySet<string> = new Set(),
  limit = GROUP_LIMIT
): TaskListGroup<T>[] {
  const byStatus = new Map<ListTaskStatus, T[]>();
  for (const task of tasks) {
    const status = (TASK_STATUS_ORDER as readonly string[]).includes(task.status) ? (task.status as ListTaskStatus) : 'Backlog';
    const list = byStatus.get(status) ?? [];
    list.push(task);
    byStatus.set(status, list);
  }
  const groups: TaskListGroup<T>[] = [];
  for (const status of TASK_STATUS_ORDER) {
    const list = byStatus.get(status);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => compareTasks(a, b, sort));
    const open = expanded.has(status) || list.length <= limit;
    const shown = open ? list : list.slice(0, limit);
    groups.push({ status, label: STATUS_LABELS[status], tasks: list, shown, hidden: list.length - shown.length });
  }
  return groups;
}

/** The ids in the order the cards are drawn: what ↑ / ↓ in the task panel walk through. */
export function taskListOrder<T extends ListTask>(groups: ReadonlyArray<TaskListGroup<T>>): string[] {
  return groups.flatMap((group) => group.shown.map((task) => task.id));
}

// ── Saved views ───────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  name: string;
  /** The filter query (`filtersQuery` without sort), e.g. "owner=me&due=week". */
  query: string;
  builtIn?: boolean;
}

/** Built in (Brent's words from the mockup): always there, can't be removed. */
export const BUILT_IN_VIEWS: ReadonlyArray<SavedView> = [
  { id: 'this-week', name: 'This week', query: 'due=week', builtIn: true },
  { id: 'mine-now', name: 'Mine now', query: 'owner=me', builtIn: true },
  { id: 'waiting', name: 'Waiting', query: 'status=waiting', builtIn: true },
  { id: 'agents', name: 'Agents', query: 'owner=agent', builtIn: true },
  { id: 'no-date', name: 'No date', query: 'due=none', builtIn: true },
];

/** localStorage key (per device, like the panel width; no database table). */
export const SAVED_VIEWS_KEY = 'baseline_task_views';
export const SAVED_VIEWS_LIMIT = 12;
export const VIEW_NAME_MAX = 32;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A query in the canonical form views are compared in (sort and unknown params dropped). */
export function canonicalViewQuery(query: string): string {
  return filtersQuery(parseTaskListFilters(query), { includeSort: false });
}

/** The user's own views from storage. Junk, a missing key or a blocked storage give []. */
export function readSavedViews(storage: StorageLike | null | undefined): SavedView[] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SAVED_VIEWS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { views?: unknown }).views) ? (parsed as { views: unknown[] }).views : [];
  const out: SavedView[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, query } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof query !== 'string') continue;
    const cleanName = name.replace(/\s+/g, ' ').trim().slice(0, VIEW_NAME_MAX);
    if (!cleanName || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id.slice(0, 40), name: cleanName, query: canonicalViewQuery(query) });
    if (out.length >= SAVED_VIEWS_LIMIT) break;
  }
  return out;
}

/** Saves the list; false when the storage refused (private window, full, blocked). */
export function writeSavedViews(storage: StorageLike | null | undefined, views: ReadonlyArray<SavedView>): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SAVED_VIEWS_KEY, JSON.stringify({ v: 1, views: views.map(({ id, name, query }) => ({ id, name, query })) }));
    return true;
  } catch {
    return false;
  }
}

export type AddViewResult =
  | { ok: true; views: SavedView[]; view: SavedView; replaced: boolean }
  | { ok: false; error: string };

/**
 * Adds the current filters as a view. Same name (any case) replaces that view;
 * nothing to save (the default list), an empty name or a full list is refused.
 */
export function addSavedView(views: ReadonlyArray<SavedView>, name: string, filters: TaskListFilters, makeId: () => string): AddViewResult {
  const cleanName = name.replace(/\s+/g, ' ').trim();
  if (!cleanName) return { ok: false, error: 'Give the view a name.' };
  if (cleanName.length > VIEW_NAME_MAX) return { ok: false, error: `Keep the name to ${VIEW_NAME_MAX} characters.` };
  const query = filtersQuery(filters, { includeSort: false });
  if (!query) return { ok: false, error: 'Set a filter first: the plain list is already there.' };
  if (BUILT_IN_VIEWS.some((view) => view.name.toLowerCase() === cleanName.toLowerCase())) {
    return { ok: false, error: `“${cleanName}” is a built-in view; pick another name.` };
  }
  const existing = views.find((view) => view.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) {
    const view = { ...existing, name: cleanName, query };
    return { ok: true, views: views.map((item) => (item.id === existing.id ? view : item)), view, replaced: true };
  }
  if (views.length >= SAVED_VIEWS_LIMIT) return { ok: false, error: `You can keep ${SAVED_VIEWS_LIMIT} views; remove one first.` };
  const view: SavedView = { id: makeId(), name: cleanName, query };
  return { ok: true, views: [...views, view], view, replaced: false };
}

export function removeSavedView(views: ReadonlyArray<SavedView>, id: string): SavedView[] {
  return views.filter((view) => view.id !== id);
}

/**
 * The view that is lit (marigold); null for none. The view the user picked
 * wins while the filters are still exactly that view, so a saved view whose
 * filters equal a built-in one ("Mine now test" = "Mine now") lights up when
 * it is the one tapped (Brent 11/6, S5 live check step 4). Otherwise (a link,
 * a reload, filters picked by hand) the first view the filters exactly match.
 */
export function activeViewId(filters: TaskListFilters, views: ReadonlyArray<SavedView>, pickedId: string | null = null): string | null {
  const current = filtersQuery(filters, { includeSort: false });
  if (!current) return null;
  if (pickedId) {
    const picked = views.find((view) => view.id === pickedId);
    if (picked && canonicalViewQuery(picked.query) === current) return picked.id;
  }
  return views.find((view) => canonicalViewQuery(view.query) === current)?.id ?? null;
}

/**
 * Filters for a view (the sort the user picked stays). Picking the LIT view
 * again clears the filters; picking another view with the same filters just
 * lights that one (pass the lit view's id as `activeId`).
 */
export function filtersForView(view: SavedView, current: TaskListFilters, activeId?: string | null): TaskListFilters {
  const viewFilters = parseTaskListFilters(view.query);
  const sameFilters = filtersQuery(current, { includeSort: false }) === canonicalViewQuery(view.query);
  const isLit = activeId === undefined ? sameFilters : activeId === view.id;
  if (sameFilters && isLit) {
    return { ...DEFAULT_TASK_LIST_FILTERS, sort: current.sort };
  }
  return { ...viewFilters, sort: current.sort };
}

/**
 * The picked view after a tap (null once it clears the filters). The bar keeps
 * it so `activeViewId` can light the view that was tapped.
 */
export function pickedAfterTap(view: SavedView, current: TaskListFilters, activeId: string | null): string | null {
  const next = filtersForView(view, current, activeId);
  return filtersQuery(next, { includeSort: false }) ? view.id : null;
}

// ── Bulk edit ─────────────────────────────────────────────────────────────

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click: everything between the last clicked card and this one (in the
 * drawn order) takes the clicked card's new state.
 */
export function selectRange(order: ReadonlyArray<string>, selected: ReadonlySet<string>, anchorId: string | null, id: string): Set<string> {
  const next = new Set(selected);
  const select = !selected.has(id);
  const from = anchorId ? order.indexOf(anchorId) : -1;
  const to = order.indexOf(id);
  if (from === -1 || to === -1) {
    if (select) next.add(id);
    else next.delete(id);
    return next;
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (const item of order.slice(lo, hi + 1)) {
    if (select) next.add(item);
    else next.delete(item);
  }
  return next;
}

/**
 * Keeps only tasks the list still matches: a filter change never leaves a
 * hidden task selected (a bulk change would otherwise reach rows you can't
 * see). Returns the same set when nothing changed (no re-render).
 */
export function pruneSelection(selected: ReadonlySet<string>, matchingIds: ReadonlyArray<string> | ReadonlySet<string>): ReadonlySet<string> {
  const keep = matchingIds instanceof Set ? matchingIds : new Set(matchingIds as ReadonlyArray<string>);
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (keep.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selected;
}

export type BulkChange =
  | { kind: 'status'; status: ListTaskStatus }
  | { kind: 'owner'; owner: 'brent' | 'agent'; label?: string | null }
  | { kind: 'due'; date: string | null }
  | { kind: 'project'; projectId: string | null; projectName?: string | null }
  | { kind: 'sprint'; sprintId: string | null; sprintName?: string | null };

export interface BulkTask extends ListTask {
  section_id?: string | null;
}

export interface BulkStep {
  taskId: string;
  title: string;
  updates: Record<string, unknown>;
  undo: Record<string, unknown>;
}

export interface BulkPlan {
  steps: BulkStep[];
  /** Selected tasks the change leaves alone, with why. */
  skipped: Array<{ taskId: string; title: string; reason: string }>;
  /** Sent with every PATCH (a date set never moves the tasks that wait on them). */
  requestOptions: { cascade?: false; cascade_quiet?: true };
  /** The toast: "Set 3 tasks to Planned". */
  message: string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * What a bulk change sends to each selected task (the same PATCH /api/tasks/[id]
 * the panel uses) and the values Undo puts back. Tasks already set that way are
 * skipped; a date before a multi-day task's start is skipped (the API refuses
 * it). Dates save as the END of that ET day (`dueAtForBoardDay`, like Today).
 */
export function bulkEditPlan(tasks: ReadonlyArray<BulkTask>, selectedIds: Iterable<string>, change: BulkChange): BulkPlan {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const steps: BulkStep[] = [];
  const skipped: BulkPlan['skipped'] = [];
  let requestOptions: BulkPlan['requestOptions'] = {};
  let message = '';

  for (const id of selectedIds) {
    const task = byId.get(id);
    if (!task) continue;
    switch (change.kind) {
      case 'status': {
        if (task.status === change.status) {
          skipped.push({ taskId: id, title: task.title, reason: `already ${STATUS_LABELS[change.status].toLowerCase()}` });
          break;
        }
        steps.push({ taskId: id, title: task.title, updates: { status: change.status }, undo: { status: task.status } });
        break;
      }
      case 'owner': {
        const label = change.owner === 'agent' ? (change.label ?? '').trim() || null : null;
        const sameLabel = (task.owner_label ?? null) === label;
        if (task.owner === change.owner && (change.owner === 'brent' || sameLabel)) {
          skipped.push({ taskId: id, title: task.title, reason: 'already theirs' });
          break;
        }
        const updates: Record<string, unknown> = { owner: change.owner };
        // "You" clears the agent name (like the panel's Who has it); an agent keeps a label it already had unless one is picked.
        if (change.owner === 'brent') updates.owner_label = null;
        else if (label) updates.owner_label = label;
        steps.push({ taskId: id, title: task.title, updates, undo: { owner: task.owner ?? 'agent', owner_label: task.owner_label ?? null } });
        break;
      }
      case 'due': {
        const nextDue = change.date ? dueAtForBoardDay(change.date) : null;
        requestOptions = { cascade: false, cascade_quiet: true };
        if (etDate(task.due_at) === (change.date ?? null) && (change.date !== null || !task.due_at)) {
          skipped.push({ taskId: id, title: task.title, reason: change.date ? 'already due then' : 'has no date' });
          break;
        }
        const range = rangeOf(task);
        const startDate = range?.isRange ? range.startDate : etDate(task.start_at ?? null);
        if (change.date && startDate && change.date < startDate) {
          skipped.push({ taskId: id, title: task.title, reason: 'starts after that day' });
          break;
        }
        if (!change.date && task.start_at) {
          skipped.push({ taskId: id, title: task.title, reason: 'has a start date (clear it in the panel)' });
          break;
        }
        steps.push({ taskId: id, title: task.title, updates: { due_at: nextDue }, undo: { due_at: task.due_at } });
        break;
      }
      case 'project': {
        if ((task.project_id ?? null) === change.projectId) {
          skipped.push({ taskId: id, title: task.title, reason: 'already in that project' });
          break;
        }
        // The server clears a section from another project and takes the project's application.
        steps.push({
          taskId: id,
          title: task.title,
          updates: { project_id: change.projectId },
          undo: { project_id: task.project_id ?? null, section_id: task.section_id ?? null, implementation_id: task.implementation_id ?? null },
        });
        break;
      }
      case 'sprint': {
        if ((task.sprint_id ?? null) === change.sprintId) {
          skipped.push({ taskId: id, title: task.title, reason: 'already in that sprint' });
          break;
        }
        steps.push({ taskId: id, title: task.title, updates: { sprint_id: change.sprintId }, undo: { sprint_id: task.sprint_id ?? null } });
        break;
      }
    }
  }

  const n = plural(steps.length, 'task');
  switch (change.kind) {
    case 'status':
      message = `Set ${n} to ${STATUS_LABELS[change.status]}`;
      break;
    case 'owner':
      message = change.owner === 'brent' ? `Gave ${n} to you` : `Gave ${n} to ${change.label ? `Agent: ${change.label}` : 'an agent'}`;
      break;
    case 'due':
      message = change.date ? `Moved ${n} to ${stripDateLabel(change.date)}` : `Cleared the date on ${n}`;
      break;
    case 'project':
      message = change.projectId ? `Moved ${n} to ${change.projectName ?? 'the project'}` : `Took ${n} out of their project`;
      break;
    case 'sprint':
      message = change.sprintId ? `Put ${n} in ${change.sprintName ?? 'the sprint'}` : `Took ${n} out of their sprint`;
      break;
  }
  return { steps, skipped, requestOptions, message };
}

// ── Words on a card ───────────────────────────────────────────────────────

/** "You", "Agent: PM", "Agent", or null. */
export function ownerText(task: Pick<ListTask, 'owner' | 'owner_label'>): string | null {
  if (task.owner === 'brent') return 'You';
  if (task.owner === 'agent') return task.owner_label ? `Agent: ${task.owner_label}` : null;
  return null;
}

function dayMonth(dateOnly: string, today: string): string {
  const label = stripDateLabel(dateOnly);
  return dateOnly.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${dateOnly.slice(0, 4)}`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 – 8 Nov", "30 Oct – 2 Nov". */
function spanText(start: string, end: string): string {
  const sm = MONTH_SHORT[Number(start.slice(5, 7)) - 1];
  const em = MONTH_SHORT[Number(end.slice(5, 7)) - 1];
  const sd = Number(start.slice(8, 10));
  const ed = Number(end.slice(8, 10));
  return sm === em && start.slice(0, 4) === end.slice(0, 4) ? `${sd} – ${ed} ${em}` : `${sd} ${sm} – ${ed} ${em}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The due words on the right of a card: "no date", "Today", "Today 5 PM",
 * "Tomorrow", "Thu 5 Nov", "2 days late", a span "2 – 8 Nov" for a multi-day
 * task. `late` draws it in the late colour. Done / Missed / Parked tasks are
 * never late.
 */
export function taskCardDue(task: Pick<ListTask, 'due_at' | 'start_at' | 'status' | 'tags' | 'project'>, clock: ListClock): { text: string; late: boolean } {
  const due = etDate(task.due_at);
  if (!due) return { text: 'no date', late: false };
  const closed = CLOSED.includes(task.status) || task.status === 'Parked';
  if (!closed && isPastDue(task.due_at, clock.now)) {
    const days = daysBetween(due, clock.today);
    if (days <= 0) {
      const time = dueTimeText(task.due_at);
      return { text: time ? `late · ${time}` : 'late', late: true };
    }
    return { text: days === 1 ? '1 day late' : `${days} days late`, late: true };
  }
  const range = rangeOf({ ...task, due_at: task.due_at });
  if (range?.isRange && range.startDate) return { text: spanText(range.startDate, range.dueDate), late: false };
  const time = dueTimeText(task.due_at);
  if (due === clock.today) return { text: time ? `Today ${time}` : 'Today', late: false };
  if (due === addDateOnlyDays(clock.today, 1)) return { text: time ? `Tomorrow ${time}` : 'Tomorrow', late: false };
  return { text: dayMonth(due, clock.today), late: false };
}
