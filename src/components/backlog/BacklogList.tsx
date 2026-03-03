"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSprints } from "@/hooks/useSprints";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { TaskGrid, TaskGridLoadingSkeleton } from "@/components/tasks/TaskGrid";
import type {
  CommitmentSummary,
  ImplementationSummary,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";

const TASKS_PAGE_SIZE = 200;

type StatusFilter = "All" | TaskStatus;
type ReviewFilter = "All" | "Needs review" | "Ready";
type ImplementationFilter = "All" | "Unassigned" | string;
type ProjectFilter = "All" | "Unassigned" | string;
type SprintFilter = "All" | "Unassigned" | string;

const STATUS_FILTER_OPTIONS: StatusFilter[] = ["All", "Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Done"];
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

async function fetchAllTaskPages(includeCompleted: boolean): Promise<TaskWithImplementation[]> {
  const allTasks: TaskWithImplementation[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchTaskPage({
      include_done: includeCompleted ? "true" : "false",
      include_parked: "true",
      limit: String(TASKS_PAGE_SIZE),
      offset: String(offset),
    });

    allTasks.push(...page);

    if (page.length < TASKS_PAGE_SIZE) {
      break;
    }

    offset += TASKS_PAGE_SIZE;
  }

  return allTasks;
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

  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
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

  useEffect(() => {
    setReviewFilter(reviewFilterFromParam(reviewParam));
  }, [reviewParam]);

  useEffect(() => {
    setSprintFilter(sprintFilterFromParam(sprintParam));
  }, [sprintParam]);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [taskData, implementationData, projectData, commitmentData] = await Promise.all([
          fetchAllTaskPages(includeCompleted),
          fetchImplementations(),
          fetchProjects(),
          fetchCommitments(),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData);
        setImplementations(implementationData);
        setProjects(projectData);
        setCommitments(commitmentData);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load backlog data");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      isMounted = false;
    };
  }, [includeCompleted]);

  useEffect(() => {
    let isMounted = true;

    async function refreshData() {
      try {
        const [taskData, commitmentData] = await Promise.all([
          fetchAllTaskPages(includeCompleted),
          fetchCommitments(),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData);
        setCommitments(commitmentData);
      } catch {
        // Non-blocking refresh.
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshData();
    }, 15000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [includeCompleted]);

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [{ ...task, dependencies: [], dependency_blocked: false }, ...current]);
    setError(null);
  }

  const filteredTasks = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();

    return tasks.filter((task) => {
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
      <TaskCreateForm
        implementations={implementations}
        sprints={sprints}
        onTaskCreated={handleTaskCreated}
        defaultNeedsReview={false}
      />

      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <label className="space-y-1 xl:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search title or description"
              className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {STATUS_FILTER_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
            <select
              value={implementationFilter}
              onChange={(event) => setImplementationFilter(event.target.value as ImplementationFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {implementations.map((implementation) => (
                <option key={implementation.id} value={implementation.id}>
                  {implementation.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project</span>
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value as ProjectFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sprint</span>
            <select
              value={sprintFilter}
              onChange={(event) => setSprintFilter(event.target.value as SprintFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {sprintsLoading && sprints.length === 0 ? <option value="All">Loading...</option> : null}
              {sprints.map((sprint) => (
                <option key={sprint.id} value={sprint.id}>
                  {sprint.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Review</span>
            <select
              value={reviewFilter}
              onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
              className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {REVIEW_FILTER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
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

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <TaskGridLoadingSkeleton />
      ) : (
        <TaskGrid
          tasks={tasks}
          visibleTasks={filteredTasks}
          setTasks={setTasks}
          implementations={implementations}
          commitments={commitments}
          scopeMode="global"
          emptyStateTitle="No matching tasks"
          emptyStateBody="Adjust your filters or add a new task above."
          initialExpandedTaskId={expandParam}
        />
      )}
    </div>
  );
}
