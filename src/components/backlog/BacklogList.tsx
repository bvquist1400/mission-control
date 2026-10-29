"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "next/navigation";
import { IntelligenceArtifactInbox } from "@/components/backlog/IntelligenceArtifactInbox";
import { useSprints } from "@/hooks/useSprints";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { TaskGrid, TaskGridLoadingSkeleton } from "@/components/tasks/TaskGrid";
import type {
  CommitmentSummary,
  ImplementationSummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";
import { Input, Select } from "@/components/ui/Field";
import { cardClasses } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  attachRefreshOnReturn,
  backlogNeedsMissed,
  createRefreshGate,
  fetchAllBacklogTaskPages,
  reuseUnchangedRows,
  withMissedRows,
} from "@/lib/backlog/task-loader";

type StatusFilter = "All" | TaskStatus;
type ReviewFilter = "All" | "Needs review" | "Ready";
type ImplementationFilter = "All" | "Unassigned" | string;
type ProjectFilter = "All" | "Unassigned" | string;
type SprintFilter = "All" | "Unassigned" | string;

const STATUS_FILTER_OPTIONS: StatusFilter[] = ["All", "Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Missed", "Done"];
const REVIEW_FILTER_OPTIONS: ReviewFilter[] = ["All", "Needs review", "Ready"];

function reviewFilterFromParam(value: string | null): ReviewFilter {
  if (value === "needs_review") {
    return "Needs review";
  }

  if (value === "ready") {
    return "Ready";
  }

  return "All";
}

function sprintFilterFromParam(value: string | null): SprintFilter {
  if (value === "unassigned") {
    return "Unassigned";
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return "All";
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

async function fetchProjects(): Promise<{ id: string; name: string }[]> {
  const response = await fetch("/api/projects", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch projects");
  }

  return response.json();
}

async function fetchCommitments(): Promise<CommitmentSummary[]> {
  const response = await fetch("/api/commitments?include_done=true", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch commitments");
  }

  return response.json();
}

export function BacklogList() {
  const searchParams = useSearchParams();
  const reviewParam = searchParams.get("review");
  const expandParam = searchParams.get("expand");
  const sprintParam = searchParams.get("sprint");
  const { sprints, loading: sprintsLoading } = useSprints();

  const [tasks, setTasksState] = useState<TaskWithImplementation[]>([]);
  // Whether `tasks` holds the Missed rows (fetched only for the "Missed" filter).
  const [tasksIncludeMissed, setTasksIncludeMissed] = useState(false);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [implementationFilter, setImplementationFilter] = useState<ImplementationFilter>("All");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("All");
  const [sprintFilter, setSprintFilter] = useState<SprintFilter>(() => sprintFilterFromParam(sprintParam));
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>(() => reviewFilterFromParam(reviewParam));
  const isArtifactInboxView = reviewParam === "intelligence";

  // Loads read the current filters through refs, so the listeners never go stale.
  const statusFilterRef = useRef(statusFilter);
  const includeCompletedRef = useRef(includeCompleted);
  const mountedRef = useRef(true);
  // Bumped by every full load: an older load's result is dropped.
  const loadSeqRef = useRef(0);
  // Bumped by every local change (grid edit, new task): a background refresh
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

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    statusFilter !== "All" ||
    implementationFilter !== "All" ||
    projectFilter !== "All" ||
    sprintFilter !== "All" ||
    reviewFilter !== "All";

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("All");
    setImplementationFilter("All");
    setProjectFilter("All");
    setSprintFilter("All");
    setReviewFilter("All");
  }

  const backlogHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("review");
    params.delete("expand");
    const query = params.toString();
    return query ? `/backlog?${query}` : "/backlog";
  }, [searchParams]);

  const artifactInboxHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("review", "intelligence");
    params.delete("expand");
    return `/backlog?${params.toString()}`;
  }, [searchParams]);

  useEffect(() => {
    setReviewFilter(reviewFilterFromParam(reviewParam));
  }, [reviewParam]);

  useEffect(() => {
    setSprintFilter(sprintFilterFromParam(sprintParam));
  }, [sprintParam]);

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
        const [taskData, implementationData, projectData, commitmentData] = await Promise.all([
          fetchAllBacklogTaskPages(fetchTaskPage, {
            includeCompleted,
            missed: includeMissed ? "include" : "exclude",
          }),
          fetchImplementations(),
          fetchProjects(),
          fetchCommitments(),
        ]);

        if (!isCurrent()) {
          return;
        }

        setTasksState(taskData);
        setTasksIncludeMissed(includeMissed);
        setImplementations(implementationData);
        setProjects(projectData);
        setCommitments(commitmentData);
      } catch (loadError) {
        if (!isCurrent()) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load backlog data");
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
        const [taskData, commitmentData] = await Promise.all([
          fetchAllBacklogTaskPages(fetchTaskPage, {
            includeCompleted: includeCompletedRef.current,
            missed: includeMissed ? "include" : "exclude",
          }),
          fetchCommitments(),
        ]);

        if (!mountedRef.current || loadSeqRef.current !== seq) {
          return;
        }

        // Unchanged data keeps the same arrays, so nothing re-renders.
        if (localEditSeqRef.current === editSeq) {
          setTasksState((current) => reuseUnchangedRows(current, taskData));
          setTasksIncludeMissed(includeMissed);
        }
        setCommitments((current) => reuseUnchangedRows(current, commitmentData));
      } catch {
        // Non-blocking refresh.
      }
    }

    return attachRefreshOnReturn(document, window, () => {
      if (refreshGate.decide() === "go") {
        void refreshGate.track(refreshData());
      }
    });
  }, [isArtifactInboxView, refreshGate]);

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [{ ...task, dependencies: [], dependency_blocked: false }, ...current]);
    setError(null);
  }

  const filteredTasks = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();

    return tasks.filter((task) => {
      if (statusFilter === "All" && task.status === "Missed") {
        return false;
      }

      if (
        normalizedSearch
        && !task.title.toLowerCase().includes(normalizedSearch)
        && !(task.description ?? "").toLowerCase().includes(normalizedSearch)
      ) {
        return false;
      }

      if (statusFilter !== "All" && task.status !== statusFilter) {
        return false;
      }

      if (implementationFilter === "Unassigned" && task.implementation_id !== null) {
        return false;
      }

      if (
        implementationFilter !== "All"
        && implementationFilter !== "Unassigned"
        && task.implementation_id !== implementationFilter
      ) {
        return false;
      }

      if (projectFilter === "Unassigned" && task.project_id !== null) {
        return false;
      }

      if (projectFilter !== "All" && projectFilter !== "Unassigned" && task.project_id !== projectFilter) {
        return false;
      }

      if (sprintFilter === "Unassigned" && task.sprint_id !== null) {
        return false;
      }

      if (sprintFilter !== "All" && sprintFilter !== "Unassigned" && task.sprint_id !== sprintFilter) {
        return false;
      }

      if (reviewFilter === "Needs review" && !task.needs_review) {
        return false;
      }

      if (reviewFilter === "Ready" && task.needs_review) {
        return false;
      }

      return true;
    });
  }, [implementationFilter, projectFilter, reviewFilter, searchQuery, sprintFilter, statusFilter, tasks]);

  return (
    <div className="space-y-4">
      <section className={cardClasses({ padding: "sm" })}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Review Surface</h2>
            <p className="text-sm text-muted-foreground">
              Switch between the task backlog and the artifact inbox without mixing artifact state into task-level review flags.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={backlogHref}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                isArtifactInboxView
                  ? "border-stroke bg-panel text-foreground hover:bg-panel-muted"
                  : "border-accent bg-accent text-white hover:opacity-90"
              }`}
            >
              Task Backlog
            </Link>
            <Link
              href={artifactInboxHref}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                isArtifactInboxView
                  ? "border-accent bg-accent text-white hover:opacity-90"
                  : "border-stroke bg-panel text-foreground hover:bg-panel-muted"
              }`}
            >
              Artifact Inbox
            </Link>
          </div>
        </div>
      </section>

      {isArtifactInboxView ? (
        <IntelligenceArtifactInbox />
      ) : (
        <>
          <TaskCreateForm
            implementations={implementations}
            sprints={sprints}
            onTaskCreated={handleTaskCreated}
            defaultNeedsReview={false}
          />

          <section className={cardClasses({ padding: "sm" })}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
              <label className="space-y-1 xl:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search</span>
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search title or description"
                />
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
                <Select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                >
                  {STATUS_FILTER_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
                <Select
                  value={implementationFilter}
                  onChange={(event) => setImplementationFilter(event.target.value as ImplementationFilter)}
                >
                  <option value="All">All</option>
                  <option value="Unassigned">Unassigned</option>
                  {implementations.map((implementation) => (
                    <option key={implementation.id} value={implementation.id}>
                      {implementation.name}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project</span>
                <Select
                  value={projectFilter}
                  onChange={(event) => setProjectFilter(event.target.value as ProjectFilter)}
                >
                  <option value="All">All</option>
                  <option value="Unassigned">Unassigned</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sprint</span>
                <Select
                  value={sprintFilter}
                  onChange={(event) => setSprintFilter(event.target.value as SprintFilter)}
                >
                  <option value="All">All</option>
                  <option value="Unassigned">Unassigned</option>
                  {sprintsLoading && sprints.length === 0 ? <option value="All">Loading...</option> : null}
                  {sprints.map((sprint) => (
                    <option key={sprint.id} value={sprint.id}>
                      {sprint.name}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Review</span>
                <Select
                  value={reviewFilter}
                  onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
                >
                  {REVIEW_FILTER_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <label className="mt-3 inline-flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={includeCompleted}
                onChange={(event) => setIncludeCompleted(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              Include completed tasks
            </label>
          </section>
        </>
      )}

      {error ? (
        <p className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {!isArtifactInboxView ? (
        loading || (awaitingMissed && !error) ? (
          <TaskGridLoadingSkeleton />
        ) : (
          <TaskGrid
            tasks={tasks}
            visibleTasks={filteredTasks}
            setTasks={setTasks}
            implementations={implementations}
            sprints={sprints}
            commitments={commitments}
            scopeMode="global"
            emptyStateTitle={hasActiveFilters ? "No tasks match these filters" : "No tasks yet"}
            emptyStateBody={
              hasActiveFilters
                ? "Nothing in the backlog matches the current filter set."
                : "Add your first task with the New Task button above."
            }
            emptyStateAction={
              hasActiveFilters ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
            initialExpandedTaskId={expandParam}
          />
        )
      ) : null}
    </div>
  );
}
