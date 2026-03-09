"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { formatDateOnly, formatRelativeDate } from "@/components/utils/dates";
import { getSprintWeekRange, isMondayToFridaySprintRange } from "@/lib/date-only";
import type { ImplementationSummary, SprintDetail as SprintDetailType, SprintWithImplementation, TaskStatus } from "@/types/database";

interface SprintDetailProps {
  id: string;
}

interface SprintDraft {
  name: string;
  startDate: string;
  endDate: string;
  theme: string;
  focusImplementationId: string;
}

const STATUS_ORDER: TaskStatus[] = ["Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Done"];

function formatDueDate(value: string | null): string {
  if (!value) {
    return "No due date";
  }

  try {
    return formatRelativeDate(value);
  } catch {
    return "No due date";
  }
}

function statusTone(status: TaskStatus): string {
  switch (status) {
    case "In Progress":
      return "border-sky-500/30 bg-sky-500/10";
    case "Blocked/Waiting":
      return "border-amber-500/30 bg-amber-500/10";
    case "Done":
      return "border-emerald-500/30 bg-emerald-500/10";
    default:
      return "border-stroke bg-panel";
  }
}

function toDraft(sprint: SprintWithImplementation | SprintDetailType): SprintDraft {
  const sprintWeek = isMondayToFridaySprintRange(sprint.start_date, sprint.end_date)
    ? { startDate: sprint.start_date, endDate: sprint.end_date }
    : getSprintWeekRange(sprint.start_date);

  return {
    name: sprint.name,
    startDate: sprintWeek?.startDate ?? sprint.start_date,
    endDate: sprintWeek?.endDate ?? sprint.end_date,
    theme: sprint.theme,
    focusImplementationId: sprint.focus_implementation_id ?? "",
  };
}

export function SprintDetail({ id }: SprintDetailProps) {
  const router = useRouter();
  const [sprint, setSprint] = useState<SprintDetailType | null>(null);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [draft, setDraft] = useState<SprintDraft>({
    name: "",
    startDate: "",
    endDate: "",
    theme: "",
    focusImplementationId: "",
  });

  useEffect(() => {
    let isMounted = true;

    async function loadSprint() {
      setLoading(true);
      setError(null);

      try {
        const [response, implementationsResponse] = await Promise.all([
          fetch(`/api/sprints/${id}`, { cache: "no-store" }),
          fetch("/api/applications", { cache: "no-store" }),
        ]);

        if (response.status === 401) {
          throw new Error("Authentication required. Sign in at /login.");
        }

        if (response.status === 404) {
          throw new Error("Sprint not found");
        }

        if (!response.ok) {
          throw new Error("Failed to fetch sprint");
        }

        const data = (await response.json()) as SprintDetailType;
        if (isMounted) {
          setSprint(data);
          setDraft(toDraft(data));
        }

        if (implementationsResponse.ok) {
          const implementationsData = (await implementationsResponse.json()) as ImplementationSummary[];
          if (isMounted) {
            setImplementations(Array.isArray(implementationsData) ? implementationsData : []);
          }
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to fetch sprint");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadSprint();

    return () => {
      isMounted = false;
    };
  }, [id]);

  const populatedStatuses = useMemo(() => {
    if (!sprint) {
      return [];
    }

    return STATUS_ORDER.filter((status) => (sprint.tasks_by_status[status] || []).length > 0);
  }, [sprint]);

  function applySprintWeek(anchorDate: string) {
    const sprintWeek = getSprintWeekRange(anchorDate);
    setDraft((current) => ({
      ...current,
      startDate: sprintWeek?.startDate ?? anchorDate,
      endDate: sprintWeek?.endDate ?? anchorDate,
    }));
  }

  async function handleSave() {
    if (!sprint) {
      return;
    }

    const name = draft.name.trim();
    if (!name) {
      setError("Sprint name is required");
      return;
    }

    if (!draft.startDate || !draft.endDate) {
      setError("Start and end dates are required");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/sprints/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          start_date: draft.startDate,
          end_date: draft.endDate,
          theme: draft.theme.trim() || null,
          focus_implementation_id: draft.focusImplementationId || null,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Failed to update sprint" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to update sprint");
      }

      const updated = (await response.json()) as SprintWithImplementation;
      setSprint((current) => (current ? { ...current, ...updated } : current));
      setDraft(toDraft(updated));
      setIsEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to update sprint");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!sprint || isDeleting) {
      return;
    }

    if (!window.confirm(`Delete sprint "${sprint.name}"? Tasks will remain, but the sprint record will be removed.`)) {
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/sprints/${id}`, { method: "DELETE" });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Failed to delete sprint" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to delete sprint");
      }

      router.push("/sprints");
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete sprint");
      setIsDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
          <div className="h-6 w-56 rounded bg-panel-muted" />
          <div className="mt-3 h-4 w-80 rounded bg-panel-muted" />
        </div>
        <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
          <div className="h-4 w-full rounded bg-panel-muted" />
        </div>
      </div>
    );
  }

  if (!sprint) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 p-5 text-center">
        <p className="text-sm text-red-700">{error || "Sprint not found"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {isEditing ? (
              <div className="space-y-3">
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  disabled={isSaving}
                  className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-base font-semibold text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start</span>
                    <input
                      type="date"
                      value={draft.startDate}
                      onChange={(event) => applySprintWeek(event.target.value)}
                      disabled={isSaving}
                      className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">End</span>
                    <input
                      type="date"
                      value={draft.endDate}
                      onChange={(event) => applySprintWeek(event.target.value)}
                      disabled={isSaving}
                      className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">Pick any date in the target week. Sprint dates snap to Monday through Friday.</p>
              </div>
            ) : (
              <>
                <h2 className="text-xl font-semibold text-foreground">{sprint.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatDateOnly(sprint.start_date)} to {formatDateOnly(sprint.end_date)}
                </p>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(toDraft(sprint));
                    setIsEditing(false);
                    setError(null);
                  }}
                  disabled={isSaving}
                  className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? "Saving..." : "Save Sprint"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(toDraft(sprint));
                  setIsEditing(true);
                  setError(null);
                }}
                className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
              >
                Edit
              </button>
            )}
            <Link
              href={`/backlog?sprint=${sprint.id}`}
              className="inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Open in backlog
            </Link>
            <Link
              href="/sprints"
              className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              All sprints
            </Link>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isDeleting || isSaving}
              className="inline-flex rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-panel-muted p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Theme</p>
            {isEditing ? (
              <input
                value={draft.theme}
                onChange={(event) => setDraft((current) => ({ ...current, theme: event.target.value }))}
                disabled={isSaving}
                placeholder="Optional sprint theme"
                className="mt-2 w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            ) : (
              <p className="mt-1 text-sm text-foreground">{sprint.theme || "Not set"}</p>
            )}
          </div>
          <div className="rounded-lg bg-panel-muted p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Focus App</p>
            {isEditing ? (
              <select
                value={draft.focusImplementationId}
                onChange={(event) => setDraft((current) => ({ ...current, focusImplementationId: event.target.value }))}
                disabled={isSaving}
                className="mt-2 w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Not set</option>
                {implementations.map((implementation) => (
                  <option key={implementation.id} value={implementation.id}>
                    {implementation.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 text-sm text-foreground">{sprint.focus_implementation?.name || "Not set"}</p>
            )}
          </div>
          <div className="rounded-lg bg-panel-muted p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tasks</p>
            <p className="mt-1 text-sm text-foreground">
              {sprint.completed_tasks} of {sprint.total_tasks} done
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Completion</span>
            <span>{sprint.completion_pct}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-panel-muted">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.max(0, Math.min(100, sprint.completion_pct))}%` }}
            />
          </div>
        </div>
      </section>

      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.map((status) => {
            const count = sprint.tasks_by_status[status]?.length || 0;

            return (
              <div key={status} className="rounded-full bg-panel-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                {status}: {count}
              </div>
            );
          })}
        </div>
      </section>

      {populatedStatuses.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
          <p className="text-lg font-medium text-foreground">No tasks in this sprint yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Assign tasks from the backlog to start tracking the sprint.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {populatedStatuses.map((status) => {
            const tasks = sprint.tasks_by_status[status] || [];

            return (
              <section key={status} className={`rounded-card border p-5 shadow-sm ${statusTone(status)}`}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">{status}</h3>
                  <span className="text-xs font-semibold text-muted-foreground">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span>
                </div>

                <div className="mt-4 space-y-3">
                  {tasks.map((task) => (
                    <div key={task.id} className="rounded-lg border border-stroke/70 bg-panel/80 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          {status === "Done" ? (
                            <p className="text-sm font-medium text-foreground">{task.title}</p>
                          ) : (
                            <Link
                              href={`/backlog?sprint=${sprint.id}&expand=${task.id}`}
                              className="text-sm font-medium text-foreground hover:text-accent hover:underline"
                            >
                              {task.title}
                            </Link>
                          )}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {task.estimated_minutes} min
                            {task.due_at ? ` · due ${formatDueDate(task.due_at)}` : ""}
                            {typeof task.priority_score === "number" ? ` · priority ${task.priority_score}` : ""}
                          </p>
                        </div>
                        {task.blocker ? (
                          <span className="rounded bg-red-500/15 px-2 py-1 text-[11px] font-semibold text-red-300">Blocker</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
