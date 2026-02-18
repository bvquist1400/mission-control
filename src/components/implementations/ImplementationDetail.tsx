"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ImplementationDetail as ImplementationDetailType, ImplementationUpdatePayload, StatusUpdate, TaskStatus, TaskSummary } from "@/types/database";
import { PhaseBadge } from "@/components/ui/PhaseBadge";
import { RagBadge } from "@/components/ui/RagBadge";
import { PhaseSelector } from "@/components/ui/PhaseSelector";
import { RagSelector } from "@/components/ui/RagSelector";

interface ImplementationDetailProps {
  id: string;
}

async function fetchImplementation(id: string): Promise<ImplementationDetailType> {
  const response = await fetch(`/api/applications/${id}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch application");
  }
  return response.json();
}

async function fetchStatusUpdates(id: string): Promise<StatusUpdate[]> {
  const response = await fetch(`/api/applications/${id}/copy-update?limit=10`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch status updates");
  }
  return response.json();
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

function formatDate(date: string | null): string {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

function formatDateInput(date: string | null): string {
  if (!date) return "";
  return date.split("T")[0];
}

function formatRelativeTime(date: string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return formatDate(date);
}

export function ImplementationDetail({ id }: ImplementationDetailProps) {
  const [impl, setImpl] = useState<ImplementationDetailType | null>(null);
  const [statusUpdates, setStatusUpdates] = useState<StatusUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [newStatusText, setNewStatusText] = useState("");
  const [addingStatus, setAddingStatus] = useState(false);

  // Inline task creation state
  const [inlineRowActive, setInlineRowActive] = useState(false);
  const [inlineTitle, setInlineTitle] = useState("");
  const [inlineStatus, setInlineStatus] = useState<TaskStatus>("Backlog");
  const [inlineEstimate, setInlineEstimate] = useState<number>(15);
  const [addingTask, setAddingTask] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [implData, updatesData] = await Promise.all([
          fetchImplementation(id),
          fetchStatusUpdates(id),
        ]);
        if (!isMounted) return;
        setImpl(implData);
        setStatusUpdates(updatesData);
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadData();
    return () => { isMounted = false; };
  }, [id]);

  async function updateField(updates: ImplementationUpdatePayload) {
    if (!impl) return;

    const previousImpl = impl;
    setSaving(true);
    setError(null);

    // Optimistic update
    setImpl({ ...impl, ...updates });

    try {
      const response = await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Update failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Update failed");
      }

      const updated = await response.json();
      setImpl((current) => current ? { ...current, ...updated } : current);
    } catch (err) {
      setImpl(previousImpl);
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function addStatusUpdate() {
    if (!impl || !newStatusText.trim()) return;

    setAddingStatus(true);
    setError(null);

    try {
      // Generate copy update which also saves to log
      const response = await fetch(`/api/applications/${id}/copy-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saveToLog: true }),
      });

      if (!response.ok) {
        throw new Error("Failed to save status update");
      }

      // Update status_summary field
      await updateField({ status_summary: newStatusText.trim() });

      // Refresh status updates
      const updatesData = await fetchStatusUpdates(id);
      setStatusUpdates(updatesData);
      setNewStatusText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add status update");
    } finally {
      setAddingStatus(false);
    }
  }

  async function handleCopyUpdate() {
    if (!impl) return;

    try {
      const response = await fetch(`/api/applications/${id}/copy-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saveToLog: true }),
      });

      if (!response.ok) throw new Error("Failed to generate update");

      const data = await response.json();
      await navigator.clipboard.writeText(data.snippet);

      // Refresh status updates
      const updatesData = await fetchStatusUpdates(id);
      setStatusUpdates(updatesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to copy update");
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

    // Optimistic update
    setImpl((current) =>
      current ? { ...current, open_tasks: [...current.open_tasks, tempTask] } : current
    );

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          implementation_id: id,
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

      const newTask = await response.json();

      // Replace temp task with real task from API
      setImpl((current) => {
        if (!current) return current;
        return {
          ...current,
          open_tasks: current.open_tasks.map((t) =>
            t.id === tempId
              ? {
                  id: newTask.id,
                  title: newTask.title,
                  status: newTask.status,
                  estimated_minutes: newTask.estimated_minutes,
                  due_at: newTask.due_at,
                  blocker: newTask.blocker,
                }
              : t
          ),
        };
      });

      setInlineTitle("");
      setInlineStatus("Backlog");
      setInlineEstimate(15);
      setInlineRowActive(false);
    } catch (err) {
      // Revert optimistic update
      setImpl((current) =>
        current ? { ...current, open_tasks: current.open_tasks.filter((t) => t.id !== tempId) } : current
      );
      setInlineError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setAddingTask(false);
    }
  }

  function handleInlineTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      handleInlineTaskAdd();
    }
    if (event.key === "Escape") {
      setInlineRowActive(false);
      setInlineTitle("");
      setInlineError(null);
    }
  }

  if (loading) return <LoadingSkeleton />;

  if (error && !impl) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 p-5 text-center">
        <p className="text-sm text-red-700">{error}</p>
        <Link href="/applications" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
          Back to Applications
        </Link>
      </div>
    );
  }

  if (!impl) return null;

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* Header Section */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground">{impl.name}</h2>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {isEditing ? (
              <>
                <PhaseSelector
                  value={impl.phase}
                  onChange={(phase) => updateField({ phase })}
                  disabled={saving}
                />
                <RagSelector
                  value={impl.rag}
                  onChange={(rag) => updateField({ rag })}
                  disabled={saving}
                />
              </>
            ) : (
              <>
                <PhaseBadge phase={impl.phase} />
                <RagBadge status={impl.rag} />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              {isEditing ? "Done Editing" : "Edit"}
            </button>
            <button
              type="button"
              onClick={handleCopyUpdate}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
            >
              Copy Update
            </button>
          </div>
        </div>

        {/* Detail Cards */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target Date</p>
            {isEditing ? (
              <input
                type="date"
                value={formatDateInput(impl.target_date)}
                onChange={(e) => updateField({ target_date: e.target.value || null })}
                disabled={saving}
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{formatDate(impl.target_date)}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next Milestone</p>
            {isEditing ? (
              <input
                type="text"
                value={impl.next_milestone}
                onChange={(e) => updateField({ next_milestone: e.target.value })}
                disabled={saving}
                placeholder="Enter next milestone..."
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{impl.next_milestone || "Not set"}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Milestone Date</p>
            {isEditing ? (
              <input
                type="date"
                value={formatDateInput(impl.next_milestone_date)}
                onChange={(e) => updateField({ next_milestone_date: e.target.value || null })}
                disabled={saving}
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{formatDate(impl.next_milestone_date)}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open Blockers</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {impl.blockers_count > 0 ? (
                <span className="text-red-400">{impl.blockers_count}</span>
              ) : (
                <span className="text-green-400">None</span>
              )}
            </p>
          </article>
        </div>

        {/* Status Summary */}
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Summary</p>
          {isEditing ? (
            <textarea
              value={impl.status_summary}
              onChange={(e) => updateField({ status_summary: e.target.value })}
              disabled={saving}
              rows={2}
              placeholder="Brief status update for stakeholders..."
              className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{impl.status_summary || "No status summary set."}</p>
          )}
        </div>
      </section>

      {/* Linked Tasks Section */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Open Tasks</h2>
        {impl.open_tasks.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {impl.open_tasks.map((task: TaskSummary) => (
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
          <p className="mt-3 text-sm text-muted-foreground">No open tasks for this application.</p>
        )}

        {/* Inline add row */}
        {inlineRowActive ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-panel-muted px-3 py-2">
            <input
              autoFocus
              value={inlineTitle}
              onChange={(e) => setInlineTitle(e.target.value)}
              onKeyDown={handleInlineTitleKeyDown}
              placeholder="Task title..."
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
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            <span className="text-base leading-none">+</span>
            <span>Add task</span>
          </button>
        )}

        {inlineError && (
          <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400" role="alert">
            {inlineError}
          </p>
        )}

        {impl.recent_done_tasks.length > 0 && (
          <>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recently Completed</h3>
            <ul className="mt-2 space-y-1">
              {impl.recent_done_tasks.map((task: TaskSummary) => (
                <li key={task.id} className="flex items-center justify-between gap-3 rounded px-2 py-1 text-sm text-muted-foreground">
                  <span className="line-through">{task.title}</span>
                  <span className="text-xs">{task.updated_at ? formatRelativeTime(task.updated_at) : ""}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Status Updates Log */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Status Update Log</h2>

        {/* Add new status update */}
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={newStatusText}
            onChange={(e) => setNewStatusText(e.target.value)}
            placeholder="Add a quick status note..."
            disabled={addingStatus}
            className="flex-1 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={addStatusUpdate}
            disabled={addingStatus || !newStatusText.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {addingStatus ? "Adding..." : "Add"}
          </button>
        </div>

        {/* Updates list */}
        {statusUpdates.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {statusUpdates.map((update) => (
              <li key={update.id} className="rounded-lg bg-panel-muted p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium">{update.created_by}</span>
                  <span>{formatRelativeTime(update.created_at)}</span>
                </div>
                <p className="mt-1 text-sm text-foreground">{update.update_text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No status updates yet.</p>
        )}
      </section>
    </div>
  );
}
