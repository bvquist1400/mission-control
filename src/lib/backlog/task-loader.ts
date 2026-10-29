/**
 * How the Backlog loads its tasks (Baseline task 7b92254a, speed check fix 1).
 * Pure: no React, no DOM globals. BacklogList wires it up; the offline test
 * (npm run test:backlog-speed) drives it with fakes.
 *
 * - Missed tasks (unfinished recurring copies kept as history) are only fetched
 *   when the Status filter is "Missed": every other view hides them anyway.
 * - Pages are fetched in parallel waves instead of one after another.
 * - The list refreshes when the tab comes back into view, never on a timer and
 *   never while hidden; a refresh never starts while another load is running.
 * - A refresh that brought back nothing new keeps the old arrays, so React does
 *   not redraw the table.
 */

/** Rows per /api/tasks request (the route caps at 500; smaller pages keep each request's dependency reads short). */
export const BACKLOG_PAGE_SIZE = 200;
/** Requests in flight at once while paging. */
export const BACKLOG_PAGE_WAVE = 4;
/** A return to the tab within this long of the last load finishing doesn't reload again. */
export const BACKLOG_REFRESH_MIN_GAP_MS = 2000;

export type BacklogMissedMode = "exclude" | "include" | "only";

export interface BacklogTaskQuery {
  includeCompleted: boolean;
  missed: BacklogMissedMode;
}

/** Missed rows are only visible under the "Missed" status filter. */
export function backlogNeedsMissed(statusFilter: string): boolean {
  return statusFilter === "Missed";
}

export function backlogTaskPageParams(query: BacklogTaskQuery, offset: number, limit: number): Record<string, string> {
  if (query.missed === "only") {
    // status=Missed: the route skips its "not Missed" filter for an explicit status.
    return { status: "Missed", limit: String(limit), offset: String(offset) };
  }

  return {
    include_done: query.includeCompleted ? "true" : "false",
    include_parked: "true",
    include_missed: query.missed === "include" ? "true" : "false",
    limit: String(limit),
    offset: String(offset),
  };
}

export type FetchTaskPage<T> = (params: Record<string, string>) => Promise<T[]>;

/**
 * Every page for `query`, `wave` requests at a time, in the server's order
 * (priority, then id). Stops at the first short page. A row seen twice (an
 * edit moved it across a page boundary mid-load) is kept once.
 */
export async function fetchAllBacklogTaskPages<T extends { id: string }>(
  fetchPage: FetchTaskPage<T>,
  query: BacklogTaskQuery,
  options: { pageSize?: number; wave?: number } = {}
): Promise<T[]> {
  const pageSize = options.pageSize ?? BACKLOG_PAGE_SIZE;
  const wave = Math.max(1, options.wave ?? BACKLOG_PAGE_WAVE);
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (true) {
    const offsets = Array.from({ length: wave }, (_, index) => offset + index * pageSize);
    const pages = await Promise.all(offsets.map((pageOffset) => fetchPage(backlogTaskPageParams(query, pageOffset, pageSize))));

    for (const page of pages) {
      for (const row of page) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }

      if (page.length < pageSize) {
        return rows;
      }
    }

    offset += wave * pageSize;
  }
}

/** The current list with its Missed rows replaced by `missed` (fetched on demand). */
export function withMissedRows<T extends { id: string; status: string }>(current: T[], missed: T[]): T[] {
  const missedIds = new Set(missed.map((row) => row.id));
  return [...current.filter((row) => row.status !== "Missed" && !missedIds.has(row.id)), ...missed];
}

/**
 * `next`, reusing `previous`'s row objects where a row is unchanged. When every
 * row is unchanged and in the same order, returns `previous` itself, so a
 * state setter bails out and nothing re-renders.
 */
export function reuseUnchangedRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
  const previousById = new Map<string, { row: T; json: string }>();
  for (const row of previous) previousById.set(row.id, { row, json: JSON.stringify(row) });

  let allSame = previous.length === next.length;
  const merged = next.map((row, index) => {
    const before = previousById.get(row.id);
    if (before && before.json === JSON.stringify(row)) {
      if (previous[index] !== before.row) allSame = false;
      return before.row;
    }
    allSame = false;
    return row;
  });

  return allSame ? previous : merged;
}

export type RefreshDecision = "go" | "hidden" | "in_flight" | "too_soon";

/**
 * Tracks every Backlog load (first load, filter loads, refreshes) so a
 * background refresh never overlaps another load and never runs while the tab
 * is hidden.
 */
export function createRefreshGate(options: { isHidden: () => boolean; now?: () => number; minGapMs?: number }) {
  const now = options.now ?? (() => Date.now());
  const minGapMs = options.minGapMs ?? BACKLOG_REFRESH_MIN_GAP_MS;
  let active = 0;
  let lastSettledAt = Number.NEGATIVE_INFINITY;

  return {
    /** Marks `work` as a running load until it settles. */
    track<R>(work: Promise<R>): Promise<R> {
      active += 1;
      return work.finally(() => {
        active -= 1;
        lastSettledAt = now();
      });
    },
    decide(): RefreshDecision {
      if (options.isHidden()) return "hidden";
      if (active > 0) return "in_flight";
      if (now() - lastSettledAt < minGapMs) return "too_soon";
      return "go";
    },
    get inFlight(): boolean {
      return active > 0;
    },
  };
}

interface ListenerTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Calls `onReturn` when the page becomes visible again or the window regains
 * focus (both usually fire together; the gate drops the second). Returns a
 * function that removes the listeners.
 */
export function attachRefreshOnReturn(
  doc: ListenerTarget & { visibilityState: string },
  win: ListenerTarget,
  onReturn: () => void
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === "visible") onReturn();
  };
  const onFocus = () => onReturn();
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onFocus);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onFocus);
  };
}
