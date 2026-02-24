"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectDetail as ProjectDetailType, ProjectUpdatePayload, TaskStatus, TaskSummary } from "@/types/database";
import { PhaseBadge } from "@/components/ui/PhaseBadge";
import { RagBadge } from "@/components/ui/RagBadge";
import { PhaseSelector } from "@/components/ui/PhaseSelector";
import { RagSelector } from "@/components/ui/RagSelector";

interface ProjectDetailProps {
  id: string;
}

function formatDate(date: string | null): string {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date + "T12:00:00"));
}

function formatDateInput(date: string | null): string {
  if (!date) return "";
  return date.split("T")[0];
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
        <div className="h-7 w-48 rounded bg-panel-muted" />
        <div className="mt-4 flex gap-2">
          <div className="h-6 w-20 rounded bg-panel-muted" />
          <div className="h-6 w-16 rounded bg-panel-muted" />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="rounded-lg bg-panel-muted p-3">
              <div className="h-3 w-20 rounded bg-stroke" />
              <div className="mt-2 h-4 w-32 rounded bg-stroke" />
            </div>
          ))}
        </div>
      </div>
      <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
        <div className="h-4 w-24 rounded bg-panel-muted" />
        <div className="mt-3 space-y-2">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-10 rounded bg-panel-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProjectDetail({ id }: ProjectDetailProps) {
  const [project, setProject] = useState<ProjectDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Inline task creation
  const [inlineRowActive, setInlineRowActive] = useState(false);
  const [inlineTitle, setInlineTitle] = useState("");
  const [inlineStatus, setInlineStatus] = useState<TaskStatus>("Backlog");
  const [inlineEstimate, setInlineEstimate] = useState<number>(15);
  const [addingTask, setAddingTask] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to fetch project");
        const data = await res.json() as ProjectDetailType;
        if (!isMounted) return;
        setProject(data);
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err.message : "Failed to load project");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => { isMounted = false; };
  }, [id]);

  async function updateField(updates: ProjectUpdatePayload) {
    if (!project) return;

    const previous = project;
    setSaving(true);
    setError(null);
    setProject({ ...project, ...updates });

    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Update failed");
      }

      const updated = await res.json() as ProjectDetailType;
      setProject((current) => current ? { ...current, ...updated } : current);
    } catch (err) {
      setProject(previous);
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function handleInlineTaskAdd() {
    const title = inlineTitle.trim();
    if (!title) return;

    setAddingTask(true);
    setInlineError(null);

    const tempId = `temp-${Date.now()}`;
    const tempTask: TaskSummary = {
      id: tempId,
      title,
      status: inlineStatus,
      estimated_minutes: inlineEstimate,
      due_at: null,
      blocker: false,
    };

    setProject((current) =>
      current ? { ...current, open_tasks: [...current.open_tasks, tempTask] } : current
    );

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          project_id: id,
          implementation_id: project?.implementation?.id ?? null,
          status: inlineStatus,
          estimated_minutes: inlineEstimate,
          estimate_source: "manual",
          task_type: "Task",
          source_type: "Manual",
          needs_review: false,
          blocker: false,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const newTask = await res.json();
      setProject((current) => {
        if (!current) return current;
        return {
          ...current,
          open_tasks: current.open_tasks.map((t) =>
            t.id === tempId
              ? { id: newTask.id, title: newTask.title, status: newTask.status, estimated_minutes: newTask.estimated_minutes, due_at: newTask.due_at, blocker: newTask.blocker }
              : t
          ),
        };
      });

      setInlineTitle("");
      setInlineStatus("Backlog");
      setInlineEstimate(15);
      setInlineRowActive(false);
    } catch (err) {
      setProject((current) =>
        current ? { ...current, open_tasks: current.open_tasks.filter((t) => t.id !== tempId) } : current
      );
      setInlineError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setAddingTask(false);
    }
  }

  function handleInlineTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); handleInlineTaskAdd(); }
    if (event.key === "Escape") { setInlineRowActive(false); setInlineTitle(""); setInlineError(null); }
  }

  if (loading) return <LoadingSkeleton />;

  if (error && !project) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 p-5 text-center">
        <p className="text-sm text-red-700">{error}</p>
        <Link href="/projects" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
          Back to Projects
        </Link>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* ── Header Section ── */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {isEditing ? (
              <>
                <PhaseSelector value={project.phase} onChange={(phase) => updateField({ phase })} disabled={saving} />
                <RagSelector value={project.rag} onChange={(rag) => updateField({ rag })} disabled={saving} />
              </>
            ) : (
              <>
                <PhaseBadge phase={project.phase} />
                <RagBadge status={project.rag} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setIsEditing(!isEditing)}
            className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            {isEditing ? "Done Editing" : "Edit"}
          </button>
        </div>

        {/* Detail grid */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</p>
            {project.implementation ? (
              <Link
                href={`/applications/${project.implementation.id}`}
                className="mt-1 block text-sm font-medium text-accent hover:underline"
              >
                {project.implementation.name}
              </Link>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Not linked</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target Date</p>
            {isEditing ? (
              <input
                type="date"
                value={formatDateInput(project.target_date)}
                onChange={(e) => updateField({ target_date: e.target.value || null })}
                disabled={saving}
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{formatDate(project.target_date)}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SPM ID</p>
            {isEditing ? (
              <input
                type="text"
                value={project.servicenow_spm_id ?? ""}
                onChange={(e) => updateField({ servicenow_spm_id: e.target.value || null })}
                disabled={saving}
                placeholder="e.g. SPM-1234"
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">
                {project.servicenow_spm_id || <span className="text-muted-foreground">Not set</span>}
              </p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open Blockers</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {project.blockers_count > 0 ? (
                <span className="text-red-400">{project.blockers_count}</span>
              ) : (
                <span className="text-green-400">None</span>
              )}
            </p>
          </article>
        </div>

        {/* Description */}
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
          {isEditing ? (
            <textarea
              value={project.description ?? ""}
              onChange={(e) => updateField({ description: e.target.value || null })}
              disabled={saving}
              rows={2}
              placeholder="What is this project about?"
              className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.description || "No description set."}</p>
          )}
        </div>

        {/* Status Summary */}
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Summary</p>
          {isEditing ? (
            <textarea
              value={project.status_summary}
              onChange={(e) => updateField({ status_summary: e.target.value })}
              disabled={saving}
              rows={2}
              placeholder="Current status in 1-2 sentences"
              className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.status_summary || "No status summary set."}</p>
          )}
        </div>
      </section>

      {/* ── Open Tasks Section ── */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Open Tasks</h2>

        {project.open_tasks.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {project.open_tasks.map((task: TaskSummary) => (
              <li key={task.id} className="flex items-center justify-between gap-3 rounded-lg bg-panel-muted px-3 py-2">
                <div className="flex items-center gap-2">
                  {task.blocker && (
                    <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                      Blocker
                    </span>
                  )}
                  <span className="text-sm text-foreground">{task.title}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{task.estimated_minutes} min</span>
                  <span className="rounded bg-panel px-1.5 py-0.5 font-medium">{task.status}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No open tasks for this project.</p>
        )}

        {/* Inline add row */}
        {inlineRowActive ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-panel-muted px-3 py-2">
            <input
              autoFocus
              value={inlineTitle}
              onChange={(e) => setInlineTitle(e.target.value)}
              onKeyDown={handleInlineTitleKeyDown}
              placeholder="Task title…"
              disabled={addingTask}
              className="min-w-0 flex-1 rounded border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />

            <select
              value={inlineStatus}
              onChange={(e) => setInlineStatus(e.target.value as TaskStatus)}
              disabled={addingTask}
              className="rounded border border-stroke bg-panel px-2 py-1 text-xs text-foreground outline-none focus:border-accent disabled:opacity-60"
            >
              {(["Backlog", "Planned", "In Progress", "Blocked/Waiting"] as TaskStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <div className="flex gap-1">
              {[5, 15, 30, 60, 90].map((min) => (
                <button
                  key={min}
                  type="button"
                  onClick={() => setInlineEstimate(min)}
                  disabled={addingTask}
                  className={`rounded px-2 py-1 text-xs font-medium transition ${
                    inlineEstimate === min
                      ? "bg-accent text-white"
                      : "border border-stroke bg-panel text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {min}m
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleInlineTaskAdd}
              disabled={addingTask || !inlineTitle.trim()}
              className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {addingTask ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => { setInlineRowActive(false); setInlineTitle(""); setInlineError(null); }}
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
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            <span className="text-base leading-none">+</span>
            <span>Add task</span>
          </button>
        )}

        {inlineError && (
          <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400" role="alert">
            {inlineError}
          </p>
        )}
      </section>
    </div>
  );
}
