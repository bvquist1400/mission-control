"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDateOnly, localDateString } from "@/components/utils/dates";
import { getSprintWeekRange, isDateOnlyAfter } from "@/lib/date-only";
import type { ImplementationSummary, SprintWithImplementation } from "@/types/database";

interface SprintDraft {
  name: string;
  startDate: string;
  endDate: string;
  theme: string;
  focusImplementationId: string;
}

function createInitialDraft(anchorDate = localDateString()): SprintDraft {
  const sprintWeek = getSprintWeekRange(anchorDate);

  return {
    name: "",
    startDate: sprintWeek?.startDate ?? anchorDate,
    endDate: sprintWeek?.endDate ?? anchorDate,
    theme: "",
    focusImplementationId: "",
  };
}

async function fetchSprints(): Promise<SprintWithImplementation[]> {
  const response = await fetch("/api/sprints", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch sprints");
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

function getSprintState(startDate: string, endDate: string): "Current" | "Upcoming" | "Completed" {
  const today = localDateString();

  if (today < startDate) {
    return "Upcoming";
  }

  if (today > endDate) {
    return "Completed";
  }

  return "Current";
}

function stateClass(state: ReturnType<typeof getSprintState>): string {
  switch (state) {
    case "Current":
      return "bg-emerald-500/15 text-emerald-300";
    case "Upcoming":
      return "bg-sky-500/15 text-sky-300";
    default:
      return "bg-panel-muted text-muted-foreground";
  }
}

export function SprintsList() {
  const [sprints, setSprints] = useState<SprintWithImplementation[]>([]);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<SprintDraft>(() => createInitialDraft());

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const [sprintData, implementationData] = await Promise.all([fetchSprints(), fetchImplementations()]);

        if (!isMounted) {
          return;
        }

        setSprints(sprintData);
        setImplementations(implementationData);
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load sprint data");
        }
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
  }, []);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = draft.name.trim();
    if (!name) {
      setError("Sprint name is required");
      return;
    }

    if (!draft.startDate || !draft.endDate) {
      setError("Start and end dates are required");
      return;
    }

    if (!isDateOnlyAfter(draft.endDate, draft.startDate)) {
      setError("End date must be after start date");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/sprints", {
        method: "POST",
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
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const createdSprint = (await response.json()) as SprintWithImplementation;
      setSprints((current) => [createdSprint, ...current]);
      setDraft(createInitialDraft());
      setIsCreateOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create sprint");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Create Sprint</h2>
            <p className="text-xs text-muted-foreground">Define any sprint date range and optional focus app.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreateOpen((open) => !open)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            {isCreateOpen ? "Close" : "+ New Sprint"}
          </button>
        </div>

        {isCreateOpen ? (
          <form onSubmit={handleCreate} className="mt-4 grid gap-3 border-t border-stroke pt-4 md:grid-cols-2 xl:grid-cols-5">
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Sprint 11: Stakeholder cleanup"
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start</span>
              <input
                type="date"
                value={draft.startDate}
                onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">End</span>
              <input
                type="date"
                value={draft.endDate}
                onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Focus App</span>
              <select
                value={draft.focusImplementationId}
                onChange={(event) => setDraft((current) => ({ ...current, focusImplementationId: event.target.value }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Optional</option>
                {implementations.map((implementation) => (
                  <option key={implementation.id} value={implementation.id}>
                    {implementation.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 md:col-span-2 xl:col-span-4">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Theme</span>
              <input
                value={draft.theme}
                onChange={(event) => setDraft((current) => ({ ...current, theme: event.target.value }))}
                placeholder="Optional sprint theme or rallying goal"
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <p className="text-xs text-muted-foreground md:col-span-2 xl:col-span-4">
              End date must be after the start date.
            </p>

            <div className="flex items-end justify-end gap-2 xl:col-span-1">
              <button
                type="submit"
                disabled={isCreating}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="animate-pulse rounded-card border border-stroke bg-panel p-5">
              <div className="h-5 w-48 rounded bg-panel-muted" />
              <div className="mt-3 h-4 w-64 rounded bg-panel-muted" />
            </div>
          ))}
        </div>
      ) : sprints.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
          <p className="text-lg font-medium text-foreground">No sprints yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Create your first sprint to start planning against a real delivery window.</p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {sprints.map((sprint) => {
            const state = getSprintState(sprint.start_date, sprint.end_date);

            return (
              <article key={sprint.id} className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{sprint.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatDateOnly(sprint.start_date)} to {formatDateOnly(sprint.end_date)}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${stateClass(state)}`}>{state}</span>
                </div>

                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-panel-muted p-3">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Theme</dt>
                    <dd className="mt-1 text-sm text-foreground">{sprint.theme || "Not set"}</dd>
                  </div>
                  <div className="rounded-lg bg-panel-muted p-3">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Focus App</dt>
                    <dd className="mt-1 text-sm text-foreground">{sprint.focus_implementation?.name || "Not set"}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`/sprints/${sprint.id}`}
                    className="inline-flex rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                  >
                    Open sprint
                  </Link>
                  <Link
                    href={`/backlog?sprint=${sprint.id}`}
                    className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
                  >
                    Open in backlog
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
