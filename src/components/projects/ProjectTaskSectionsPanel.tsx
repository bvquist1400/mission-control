"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { TaskGrid, TaskGridLoadingSkeleton } from "@/components/tasks/TaskGrid";
import { sortProjectSections } from "@/lib/project-sections";
import type {
  CommitmentSummary,
  ImplementationSummary,
  ProjectSection,
  TaskStatus,
  TaskWithImplementation,
} from "@/types/database";

interface ProjectTaskSectionsPanelProps {
  projectId: string;
  projectName: string;
  implementationId: string | null;
}

interface SectionDraft {
  name: string;
  sortOrder: string;
}

function mergeTask(current: TaskWithImplementation[], nextTask: TaskWithImplementation): TaskWithImplementation[] {
  const normalizedTask = {
    ...nextTask,
    dependencies: nextTask.dependencies || [],
    dependency_blocked: nextTask.dependency_blocked ?? false,
  };

  const existingIndex = current.findIndex((task) => task.id === normalizedTask.id);
  if (existingIndex === -1) {
    return [normalizedTask, ...current];
  }

  const next = [...current];
  next[existingIndex] = {
    ...next[existingIndex],
    ...normalizedTask,
  };
  return next;
}

async function fetchProjectTasks(projectId: string, includeCompleted: boolean): Promise<TaskWithImplementation[]> {
  const params = new URLSearchParams({
    limit: "500",
    project_id: projectId,
  });

  if (includeCompleted) {
    params.set("include_done", "true");
  }

  const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }

  return response.json();
}

async function fetchProjectSections(projectId: string): Promise<ProjectSection[]> {
  const response = await fetch(`/api/projects/${projectId}/sections`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch project sections");
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

function normalizeSortOrder(value: string, fallbackValue: number): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function nextSectionSortOrder(sections: ProjectSection[]): number {
  if (sections.length === 0) {
    return 0;
  }

  return Math.max(...sections.map((section) => section.sort_order)) + 1;
}

export function ProjectTaskSectionsPanel({
  projectId,
  projectName,
  implementationId,
}: ProjectTaskSectionsPanelProps) {
  const [tasks, setTasks] = useState<TaskWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [sections, setSections] = useState<ProjectSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [inlineRowActive, setInlineRowActive] = useState(false);
  const [inlineTitle, setInlineTitle] = useState("");
  const [inlineStatus, setInlineStatus] = useState<TaskStatus>("Backlog");
  const [inlineEstimate, setInlineEstimate] = useState<number>(15);
  const [inlineSectionId, setInlineSectionId] = useState("");
  const [addingTask, setAddingTask] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [showCreateSectionForm, setShowCreateSectionForm] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [createSectionDraft, setCreateSectionDraft] = useState<SectionDraft>({ name: "", sortOrder: "0" });
  const [sectionMutationError, setSectionMutationError] = useState<string | null>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionDraft, setEditSectionDraft] = useState<SectionDraft>({ name: "", sortOrder: "0" });
  const [savingSectionId, setSavingSectionId] = useState<string | null>(null);
  const [deletingSectionId, setDeletingSectionId] = useState<string | null>(null);

  const sortedSections = useMemo(() => [...sections].sort(sortProjectSections), [sections]);
  const tasksForProject = useMemo(
    () => tasks.filter((task) => task.project_id === projectId),
    [projectId, tasks]
  );

  const sectionTaskCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasksForProject) {
      if (!task.section_id) {
        continue;
      }

      counts.set(task.section_id, (counts.get(task.section_id) ?? 0) + 1);
    }
    return counts;
  }, [tasksForProject]);

  const sectionGroups = useMemo(
    () =>
      sortedSections.map((section) => ({
        section,
        tasks: tasksForProject.filter((task) => task.section_id === section.id),
      })),
    [sortedSections, tasksForProject]
  );

  const unsectionedTasks = useMemo(
    () => tasksForProject.filter((task) => !task.section_id),
    [tasksForProject]
  );

  const setProjectTasks = useCallback<Dispatch<SetStateAction<TaskWithImplementation[]>>>(
    (nextState) => {
      setTasks((current) => {
        const next = typeof nextState === "function" ? nextState(current) : nextState;
        return next.filter((task) => task.project_id === projectId);
      });
    },
    [projectId]
  );

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [taskData, implementationData, commitmentData, sectionData] = await Promise.all([
          fetchProjectTasks(projectId, includeCompleted),
          fetchImplementations(),
          fetchCommitments(),
          fetchProjectSections(projectId),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData.filter((task) => task.project_id === projectId));
        setImplementations(implementationData);
        setCommitments(commitmentData);
        setSections(sectionData);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load project tasks");
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
  }, [includeCompleted, projectId]);

  useEffect(() => {
    let isMounted = true;

    async function refreshData() {
      try {
        const [taskData, commitmentData, sectionData] = await Promise.all([
          fetchProjectTasks(projectId, includeCompleted),
          fetchCommitments(),
          fetchProjectSections(projectId),
        ]);

        if (!isMounted) {
          return;
        }

        setTasks(taskData.filter((task) => task.project_id === projectId));
        setCommitments(commitmentData);
        setSections(sectionData);
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
  }, [includeCompleted, projectId]);

  useEffect(() => {
    if (!showCreateSectionForm) {
      return;
    }

    setCreateSectionDraft((current) => ({
      name: current.name,
      sortOrder: current.sortOrder || String(nextSectionSortOrder(sortedSections)),
    }));
  }, [showCreateSectionForm, sortedSections]);

  async function handleInlineTaskAdd() {
    const title = inlineTitle.trim();
    if (!title) {
      return;
    }

    setAddingTask(true);
    setInlineError(null);

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          project_id: projectId,
          section_id: inlineSectionId || null,
          implementation_id: implementationId,
          status: inlineStatus,
          estimated_minutes: inlineEstimate,
          estimate_source: "manual",
          task_type: "Task",
          source_type: "Manual",
          needs_review: false,
          blocker: false,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const newTask = (await response.json()) as TaskWithImplementation;
      setProjectTasks((current) => mergeTask(current, newTask));

      setInlineTitle("");
      setInlineStatus("Backlog");
      setInlineEstimate(15);
      setInlineRowActive(false);
    } catch (createError) {
      setInlineError(createError instanceof Error ? createError.message : "Failed to create task");
    } finally {
      setAddingTask(false);
    }
  }

  async function handleCreateSection() {
    const name = createSectionDraft.name.trim();
    if (!name) {
      setSectionMutationError("Section name is required");
      return;
    }

    setCreatingSection(true);
    setSectionMutationError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sort_order: normalizeSortOrder(createSectionDraft.sortOrder, nextSectionSortOrder(sortedSections)),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to create section" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create section");
      }

      const createdSection = (await response.json()) as ProjectSection;
      setSections((current) => [...current, createdSection].sort(sortProjectSections));
      setCreateSectionDraft({
        name: "",
        sortOrder: String(nextSectionSortOrder([...sortedSections, createdSection])),
      });
      setShowCreateSectionForm(false);
    } catch (mutationError) {
      setSectionMutationError(
        mutationError instanceof Error ? mutationError.message : "Failed to create section"
      );
    } finally {
      setCreatingSection(false);
    }
  }

  function beginEditingSection(section: ProjectSection) {
    setEditingSectionId(section.id);
    setEditSectionDraft({
      name: section.name,
      sortOrder: String(section.sort_order),
    });
    setSectionMutationError(null);
  }

  async function handleSaveSection(section: ProjectSection) {
    const name = editSectionDraft.name.trim();
    if (!name) {
      setSectionMutationError("Section name is required");
      return;
    }

    setSavingSectionId(section.id);
    setSectionMutationError(null);

    try {
      const response = await fetch(`/api/sections/${section.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sort_order: normalizeSortOrder(editSectionDraft.sortOrder, section.sort_order),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to update section" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to update section");
      }

      const updatedSection = (await response.json()) as ProjectSection;
      setSections((current) =>
        current
          .map((candidate) => (candidate.id === updatedSection.id ? updatedSection : candidate))
          .sort(sortProjectSections)
      );
      setProjectTasks((current) =>
        current.map((task) =>
          task.section_id === updatedSection.id
            ? { ...task, section_name: updatedSection.name }
            : task
        )
      );
      setEditingSectionId(null);
    } catch (mutationError) {
      setSectionMutationError(
        mutationError instanceof Error ? mutationError.message : "Failed to update section"
      );
    } finally {
      setSavingSectionId(null);
    }
  }

  async function handleDeleteSection(section: ProjectSection) {
    if (deletingSectionId) {
      return;
    }

    const taskCount = sectionTaskCountById.get(section.id) ?? 0;
    const confirmed = window.confirm(
      taskCount > 0
        ? `Delete section "${section.name}"? ${taskCount} task${taskCount === 1 ? "" : "s"} will become unsectioned.`
        : `Delete section "${section.name}"?`
    );

    if (!confirmed) {
      return;
    }

    setDeletingSectionId(section.id);
    setSectionMutationError(null);

    try {
      const response = await fetch(`/api/sections/${section.id}`, { method: "DELETE" });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Failed to delete section" }));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to delete section");
      }

      setSections((current) => current.filter((candidate) => candidate.id !== section.id));
      setProjectTasks((current) =>
        current.map((task) =>
          task.section_id === section.id
            ? { ...task, section_id: null, section_name: null }
            : task
        )
      );
      if (inlineSectionId === section.id) {
        setInlineSectionId("");
      }
      if (editingSectionId === section.id) {
        setEditingSectionId(null);
      }
    } catch (mutationError) {
      setSectionMutationError(
        mutationError instanceof Error ? mutationError.message : "Failed to delete section"
      );
    } finally {
      setDeletingSectionId(null);
    }
  }

  function handleInlineTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleInlineTaskAdd();
    }

    if (event.key === "Escape") {
      setInlineRowActive(false);
      setInlineTitle("");
      setInlineError(null);
    }
  }

  const emptyStateBody = sortedSections.length > 0
    ? "Add a task above or include completed work to see historical items."
    : "Create sections to group project work, or add a task to keep the project flat for now.";

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(event) => setIncludeCompleted(event.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Include completed tasks
        </label>

        <button
          type="button"
          onClick={() => {
            setShowCreateSectionForm((current) => !current);
            setSectionMutationError(null);
            setCreateSectionDraft({
              name: "",
              sortOrder: String(nextSectionSortOrder(sortedSections)),
            });
          }}
          className="rounded border border-stroke bg-panel px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
        >
          {showCreateSectionForm ? "Cancel section" : "Add section"}
        </button>
      </div>

      {showCreateSectionForm ? (
        <div className="rounded-lg border border-stroke bg-panel-muted p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_auto]">
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Section name</span>
              <input
                value={createSectionDraft.name}
                onChange={(event) =>
                  setCreateSectionDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="e.g. Discovery"
                disabled={creatingSection}
                className="w-full rounded border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort order</span>
              <input
                type="number"
                value={createSectionDraft.sortOrder}
                onChange={(event) =>
                  setCreateSectionDraft((current) => ({ ...current, sortOrder: event.target.value }))
                }
                disabled={creatingSection}
                className="w-full rounded border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => void handleCreateSection()}
                disabled={creatingSection}
                className="rounded bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {creatingSection ? "Creating..." : "Create section"}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Sections render in sort order, then creation order. Tasks without a section stay at the end.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {sectionMutationError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {sectionMutationError}
        </p>
      ) : null}

      {inlineRowActive ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-panel-muted px-3 py-2">
          <input
            autoFocus
            value={inlineTitle}
            onChange={(event) => setInlineTitle(event.target.value)}
            onKeyDown={handleInlineTitleKeyDown}
            placeholder="Task title..."
            disabled={addingTask}
            className="min-w-[220px] flex-1 rounded border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />

          <select
            value={inlineSectionId}
            onChange={(event) => setInlineSectionId(event.target.value)}
            disabled={addingTask}
            className="rounded border border-stroke bg-panel px-2 py-1 text-xs text-foreground outline-none focus:border-accent disabled:opacity-60"
          >
            <option value="">{sortedSections.length === 0 ? "Unsectioned" : "No section"}</option>
            {sortedSections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </select>

          <select
            value={inlineStatus}
            onChange={(event) => setInlineStatus(event.target.value as TaskStatus)}
            disabled={addingTask}
            className="rounded border border-stroke bg-panel px-2 py-1 text-xs text-foreground outline-none focus:border-accent disabled:opacity-60"
          >
            {(["Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked"] as TaskStatus[]).map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>

          <div className="flex gap-1">
            {[5, 15, 30, 60, 90].map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setInlineEstimate(minutes)}
                disabled={addingTask}
                className={`rounded px-2 py-1 text-xs font-medium transition ${
                  inlineEstimate === minutes
                    ? "bg-accent text-white"
                    : "border border-stroke bg-panel text-muted-foreground hover:text-foreground"
                }`}
              >
                {minutes}m
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleInlineTaskAdd()}
            disabled={addingTask || !inlineTitle.trim()}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {addingTask ? "Adding..." : "Add"}
          </button>
          <button
            type="button"
            onClick={() => {
              setInlineRowActive(false);
              setInlineTitle("");
              setInlineError(null);
            }}
            disabled={addingTask}
            className="rounded border border-stroke bg-panel px-3 py-1 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setInlineRowActive(true)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
        >
          <span className="text-base leading-none">+</span>
          <span>Add task</span>
        </button>
      )}

      {inlineError ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400" role="alert">
          {inlineError}
        </p>
      ) : null}

      {loading ? (
        <TaskGridLoadingSkeleton />
      ) : sortedSections.length === 0 ? (
        <TaskGrid
          tasks={tasksForProject}
          setTasks={setProjectTasks}
          implementations={implementations}
          commitments={commitments}
          scopeMode="project"
          emptyStateTitle={`No tasks in ${projectName}`}
          emptyStateBody={emptyStateBody}
        />
      ) : (
        <div className="space-y-5">
          {sectionGroups.map(({ section, tasks: sectionTasks }) => {
            const isEditing = editingSectionId === section.id;
            const isSaving = savingSectionId === section.id;
            const isDeleting = deletingSectionId === section.id;

            return (
              <section key={section.id} className="min-w-0 space-y-3 rounded-card border border-stroke bg-panel p-4 shadow-sm">
                {isEditing ? (
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_auto]">
                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Section name</span>
                      <input
                        value={editSectionDraft.name}
                        onChange={(event) =>
                          setEditSectionDraft((current) => ({ ...current, name: event.target.value }))
                        }
                        disabled={isSaving}
                        className="w-full rounded border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort order</span>
                      <input
                        type="number"
                        value={editSectionDraft.sortOrder}
                        onChange={(event) =>
                          setEditSectionDraft((current) => ({ ...current, sortOrder: event.target.value }))
                        }
                        disabled={isSaving}
                        className="w-full rounded border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>

                    <div className="flex items-end gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveSection(section)}
                        disabled={isSaving}
                        className="rounded bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingSectionId(null)}
                        disabled={isSaving}
                        className="rounded border border-stroke bg-panel px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{section.name}</h3>
                        <span className="rounded-full bg-panel-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {sectionTasks.length} task{sectionTasks.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sort order {section.sort_order}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setInlineSectionId(section.id);
                          setInlineRowActive(true);
                          setInlineError(null);
                        }}
                        className="rounded border border-stroke bg-panel px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
                      >
                        New task here
                      </button>
                      <button
                        type="button"
                        onClick={() => beginEditingSection(section)}
                        disabled={Boolean(deletingSectionId)}
                        className="rounded border border-stroke bg-panel px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSection(section)}
                        disabled={isDeleting}
                        className="rounded border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isDeleting ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </div>
                )}

                {sectionTasks.length > 0 ? (
                  <TaskGrid
                    tasks={tasksForProject}
                    visibleTasks={sectionTasks}
                    setTasks={setProjectTasks}
                    implementations={implementations}
                    commitments={commitments}
                    scopeMode="project"
                    emptyStateTitle={`No tasks in ${section.name}`}
                    emptyStateBody="Add a task to start using this section."
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-stroke bg-panel-muted/60 px-4 py-6 text-sm text-muted-foreground">
                    No tasks in this section yet.
                  </div>
                )}
              </section>
            );
          })}

          {unsectionedTasks.length > 0 ? (
            <section className="min-w-0 space-y-3 rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">Unsectioned</h3>
                    <span className="rounded-full bg-panel-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {unsectionedTasks.length} task{unsectionedTasks.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Tasks without a section stay here until they are assigned.
                  </p>
                </div>
              </div>

              <TaskGrid
                tasks={tasksForProject}
                visibleTasks={unsectionedTasks}
                setTasks={setProjectTasks}
                implementations={implementations}
                commitments={commitments}
                scopeMode="project"
                emptyStateTitle="No unsectioned tasks"
                emptyStateBody="Unsectioned work appears here."
              />
            </section>
          ) : null}

          {sectionGroups.length === 0 && tasksForProject.length === 0 ? (
            <div className="rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
              <p className="text-lg font-medium text-foreground">No tasks in {projectName}</p>
              <p className="mt-1 text-sm text-muted-foreground">{emptyStateBody}</p>
            </div>
          ) : null}
        </div>
      )}

      {!loading && sortedSections.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Sections are visible in the project view now. Drag-and-drop moves and richer section layout controls are future work.
        </p>
      ) : null}
    </div>
  );
}
