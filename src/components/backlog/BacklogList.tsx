"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "next/navigation";
import { IntelligenceArtifactInbox } from "@/components/backlog/IntelligenceArtifactInbox";
import { TaskListFilterBar } from "@/components/backlog/TaskListFilters";
import { TaskCardList, TaskCardListSkeleton } from "@/components/backlog/TaskCardList";
import { useSprints } from "@/hooks/useSprints";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import type { ImplementationSummary, TaskWithImplementation } from "@/types/database";
import { Button } from "@/components/ui/Button";
import {
  attachRefreshOnReturn,
  backlogNeedsMissed,
  createRefreshGate,
  fetchAllBacklogTaskPages,
  reuseUnchangedRows,
  withMissedRows,
} from "@/lib/backlog/task-loader";
import { filterTasksByScope, normalizeTaskScope } from "@/lib/personal-exclusion";
import {
  BUILT_IN_VIEWS,
  DEFAULT_TASK_LIST_FILTERS,
  filtersNeedDone,
  listClock,
  matchesTaskListFilters,
  parseTaskListFilters,
  statusForLoader,
  taskListHref,
  type TaskListFilters,
} from "@/lib/tasks-list";
import { taskIdFromParams } from "@/lib/task-panel";
import "@/components/backlog/tasks-list.css";
// The cards' Move to… menu (S4) brings no CSS of its own (TaskCardRow stays importable in the offline test).
import "@/components/today/move-to-menu.css";

/** Projects as the filter and bulk edit need them (GET /api/projects returns whole rows). */
export interface ListProject {
  id: string;
  name: string;
  implementation_id?: string | null;
  tags?: string[] | null;
}

async function fetchTaskPage(params: Record<string, string>): Promise<TaskWithImplementation[]> {
  const searchParams = new URLSearchParams(params);
  const response = await fetch(`/api/tasks?${searchParams.toString()}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }

  return response.json();
}

async function fetchImplementations(): Promise<ImplementationSummary[]> {
  const response = await fetch("/api/applications", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch applications");
  }

  return response.json();
}

async function fetchProjects(): Promise<ListProject[]> {
  const response = await fetch("/api/projects", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch projects");
  }

  return response.json();
}

/**
 * The Tasks page (redesign S5; plan row S5, NOTES.md "Tasks rows as cards"):
 * one filter row and saved views over card rows grouped by status, the S3
 * task panel on click, bulk edit on the selected cards. The URL holds the
 * filters (`parseTaskListFilters` / `taskListHref` in src/lib/tasks-list.ts),
 * so a link reproduces the view; the top bar's Work / Personal / All writes
 * `?scope`. Loading is unchanged (src/lib/backlog/task-loader.ts).
 */
export function BacklogList() {
  const searchParams = useSearchParams();
  const reviewParam = searchParams.get("review");
  // ?task=<id> (and the old ?expand=<id>) open the app-wide task panel, not a row here (redesign S3).
  // Every filter (status, app, project, ?sprint=, owner, due, review, q, sort) is read from the URL.
  const filters = useMemo(() => parseTaskListFilters(searchParams), [searchParams]);
  const scope = normalizeTaskScope(searchParams.get("scope"), "all");
  const openTaskId = taskIdFromParams(searchParams, "/backlog");
  const { sprints } = useSprints();

  const [tasks, setTasksState] = useState<TaskWithImplementation[]>([]);
  // Whether `tasks` holds the Missed rows (fetched only for the "Missed" filter).
  const [tasksIncludeMissed, setTasksIncludeMissed] = useState(false);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [projects, setProjects] = useState<ListProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Done rows are loaded only when the Status filter asks for them ("All" or "Done").
  const includeCompleted = filtersNeedDone(filters);
  const statusFilter = statusForLoader(filters);
  const isArtifactInboxView = reviewParam === "intelligence";

  // Loads read the current filters through refs, so the listeners never go stale.
  const statusFilterRef = useRef(statusFilter);
  const includeCompletedRef = useRef(includeCompleted);
  const mountedRef = useRef(true);
  // Bumped by every full load: an older load's result is dropped.
  const loadSeqRef = useRef(0);
  // Bumped by every local change (card edit, bulk edit, new task): a background refresh
  // that started before one is dropped rather than overwriting it.
  const localEditSeqRef = useRef(0);
  const [refreshGate] = useState(() =>
    createRefreshGate({ isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden" })
  );

  const setTasks = useCallback<Dispatch<SetStateAction<TaskWithImplementation[]>>>((value) => {
    localEditSeqRef.current += 1;
    setTasksState(value);
  }, []);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
    includeCompletedRef.current = includeCompleted;
  }, [includeCompleted, statusFilter]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Filters live in the URL: replaced in place (no history entry per pick; the open task stays). */
  const setFilters = useCallback((next: TaskListFilters) => {
    const href = taskListHref(window.location.pathname, window.location.search, next);
    window.history.replaceState(null, "", `${href}${window.location.hash}`);
  }, []);

  const clearFilters = useCallback(() => setFilters({ ...DEFAULT_TASK_LIST_FILTERS, sort: filters.sort }), [filters.sort, setFilters]);

  const artifactInboxHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("review", "intelligence");
    params.delete("expand");
    params.delete("task");
    return `/backlog?${params.toString()}`;
  }, [searchParams]);

  useEffect(() => {
    if (isArtifactInboxView) {
      setLoading(false);
      setError(null);
      return;
    }

    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const isCurrent = () => mountedRef.current && loadSeqRef.current === seq;

    async function loadData() {
      setLoading(true);
      setError(null);
      const includeMissed = backlogNeedsMissed(statusFilterRef.current);

      try {
        // Commitments are no longer read here: the task panel loads its own (S3).
        const [taskData, implementationData, projectData] = await Promise.all([
          fetchAllBacklogTaskPages(fetchTaskPage, {
            includeCompleted,
            missed: includeMissed ? "include" : "exclude",
          }),
          fetchImplementations(),
          fetchProjects(),
        ]);

        if (!isCurrent()) {
          return;
        }

        setTasksState(taskData);
        setTasksIncludeMissed(includeMissed);
        setNowMs(Date.now());
        setImplementations(implementationData);
        setProjects(projectData);
      } catch (loadError) {
        if (!isCurrent()) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load tasks");
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    }

    void refreshGate.track(loadData());
  }, [includeCompleted, isArtifactInboxView, refreshGate]);

  // Missed tasks are fetched on demand, when the Status filter asks for them.
  const awaitingMissed = backlogNeedsMissed(statusFilter) && !tasksIncludeMissed;
  useEffect(() => {
    if (isArtifactInboxView || loading || !awaitingMissed) {
      return;
    }

    let cancelled = false;
    const seq = loadSeqRef.current;

    async function loadMissed() {
      try {
        const missed = await fetchAllBacklogTaskPages(fetchTaskPage, { includeCompleted: false, missed: "only" });
        if (cancelled || !mountedRef.current || loadSeqRef.current !== seq) {
          return;
        }
        setTasksState((current) => withMissedRows(current, missed));
        setTasksIncludeMissed(true);
      } catch (loadError) {
        if (cancelled || !mountedRef.current) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "Failed to load missed tasks");
      }
    }

    void refreshGate.track(loadMissed());

    return () => {
      cancelled = true;
    };
  }, [awaitingMissed, isArtifactInboxView, loading, refreshGate]);

  // No timer: the list refreshes when the tab comes back into view (never while
  // hidden, never while another load is running).
  useEffect(() => {
    if (isArtifactInboxView) {
      return;
    }

    async function refreshData() {
      const seq = loadSeqRef.current;
      const editSeq = localEditSeqRef.current;
      const includeMissed = backlogNeedsMissed(statusFilterRef.current);

      try {
        const taskData = await fetchAllBacklogTaskPages(fetchTaskPage, {
          includeCompleted: includeCompletedRef.current,
          missed: includeMissed ? "include" : "exclude",
        });

        if (!mountedRef.current || loadSeqRef.current !== seq) {
          return;
        }

        // Unchanged data keeps the same arrays, so nothing re-renders.
        if (localEditSeqRef.current === editSeq) {
          setTasksState((current) => reuseUnchangedRows(current, taskData));
          setTasksIncludeMissed(includeMissed);
        }
      } catch {
        // Non-blocking refresh.
      }
    }

    return attachRefreshOnReturn(document, window, () => {
      // Late / today / this week follow the clock when you come back to the tab (no timer).
      setNowMs(Date.now());
      if (refreshGate.decide() === "go") {
        void refreshGate.track(refreshData());
      }
    });
  }, [isArtifactInboxView, refreshGate]);

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [{ ...task, dependencies: [], dependency_blocked: false }, ...current]);
    setError(null);
  }

  const clock = useMemo(() => listClock(new Date(nowMs)), [nowMs]);
  // The top bar's Work / Personal / All (default All: the list has always shown everything).
  const scopedTasks = useMemo(() => filterTasksByScope(tasks, scope), [tasks, scope]);
  const matchingTasks = useMemo(
    () => scopedTasks.filter((task) => matchesTaskListFilters(task, filters, clock)),
    [scopedTasks, filters, clock]
  );
  const openCount = useMemo(() => scopedTasks.filter((task) => task.status !== "Done" && task.status !== "Missed").length, [scopedTasks]);
  const ownerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const task of tasks) {
      const label = task.owner === "agent" ? task.owner_label?.trim() : "";
      if (label && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
    }
    return [...labels.values()].sort((a, b) => a.localeCompare(b));
  }, [tasks]);
  const viewCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const view of BUILT_IN_VIEWS) {
      const viewFilters = parseTaskListFilters(view.query);
      counts[view.query] = scopedTasks.filter((task) => matchesTaskListFilters(task, viewFilters, clock)).length;
    }
    return counts;
  }, [scopedTasks, clock]);
  const countFor = useCallback(
    (query: string) => viewCounts[query] ?? scopedTasks.filter((task) => matchesTaskListFilters(task, parseTaskListFilters(query), clock)).length,
    [viewCounts, scopedTasks, clock]
  );

  if (isArtifactInboxView) {
    return (
      <div className="tl">
        <header className="tl-head">
          <h1>Artifact Inbox</h1>
          <Link href={`/backlog${scope === "all" ? "" : `?scope=${scope}`}`} className="tl-switch">
            ← Back to Tasks
          </Link>
        </header>
        <IntelligenceArtifactInbox />
      </div>
    );
  }

  const listReady = !loading && !(awaitingMissed && !error);

  return (
    <div className="tl" data-panel={openTaskId ? "open" : undefined}>
      <header className="tl-head">
        <h1>Tasks</h1>
        <p className="tl-count" aria-live="polite">
          {listReady ? (
            <>
              <b>{matchingTasks.length}</b> match · {openCount} open in all
            </>
          ) : (
            "Loading…"
          )}
        </p>
        <div className="tl-head-right">
          <Link href={artifactInboxHref} className="tl-switch">
            Artifact Inbox
          </Link>
          <Button variant="primary" size="sm" aria-expanded={creating} onClick={() => setCreating((open) => !open)}>
            {creating ? "Close" : "+ New task"}
          </Button>
        </div>
      </header>

      {creating ? (
        <section className="tl-create" aria-label="New task">
          <TaskCreateForm
            implementations={implementations}
            sprints={sprints}
            onTaskCreated={handleTaskCreated}
            defaultNeedsReview={false}
            initiallyOpen
            hideLauncher
            onRequestClose={() => setCreating(false)}
          />
        </section>
      ) : null}

      <TaskListFilterBar
        filters={filters}
        onChange={setFilters}
        onClear={clearFilters}
        implementations={implementations}
        projects={projects}
        sprints={sprints}
        ownerLabels={ownerLabels}
        countFor={countFor}
      />

      {error ? (
        <p className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {listReady ? (
        <TaskCardList
          tasks={tasks}
          matchingTasks={matchingTasks}
          setTasks={setTasks}
          filters={filters}
          clock={clock}
          openTaskId={openTaskId}
          implementations={implementations}
          projects={projects}
          sprints={sprints}
          ownerLabels={ownerLabels}
          emptyAction={
            <Button variant="secondary" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <TaskCardListSkeleton />
      )}
    </div>
  );
}
