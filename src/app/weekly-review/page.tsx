"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { formatDateOnly, formatRelativeDate, localDateString } from "@/components/utils/dates";
import type { ImplementationHealthScore, TaskWithImplementation } from "@/types/database";

interface WeeklyReviewData {
  week: {
    start_date: string;
    end_date: string;
  };
  shipped: TaskWithImplementation[];
  stalled: TaskWithImplementation[];
  pending_decisions: TaskWithImplementation[];
  cold_commitments: Array<{
    id: string;
    title: string;
    created_at: string;
    due_at: string | null;
    stakeholder: { id: string; name: string } | null;
  }>;
  health_scores: ImplementationHealthScore[];
  next_week_suggestions: string[];
}

function healthTone(label: ImplementationHealthScore["health_label"]): string {
  switch (label) {
    case "Healthy":
      return "text-emerald-300";
    case "Watch":
      return "text-amber-300";
    case "At Risk":
      return "text-orange-300";
    default:
      return "text-red-300";
  }
}

function trendLabel(trend: ImplementationHealthScore["trend"]): string {
  switch (trend) {
    case "improving":
      return "Improving";
    case "degrading":
      return "Degrading";
    case "stable":
      return "Stable";
    default:
      return "No prior baseline";
  }
}

function formatTimestamp(value: string): string {
  try {
    return formatRelativeDate(value);
  } catch {
    return "recently";
  }
}

export default function WeeklyReviewPage() {
  const [anchorDate, setAnchorDate] = useState(localDateString());
  const [data, setData] = useState<WeeklyReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadReview() {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ date: anchorDate });
        const response = await fetch(`/api/briefing/weekly-review?${params.toString()}`, { cache: "no-store" });

        if (response.status === 401) {
          throw new Error("Authentication required. Sign in at /login.");
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({ error: "Failed to load weekly review" }));
          throw new Error(typeof payload.error === "string" ? payload.error : "Failed to load weekly review");
        }

        const payload = (await response.json()) as WeeklyReviewData;
        if (isMounted) {
          setData(payload);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load weekly review");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadReview();

    return () => {
      isMounted = false;
    };
  }, [anchorDate]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Weekly Review"
        description="See what shipped, what stalled, where decisions are blocking flow, and what needs explicit attention next week."
        actions={
          <label className="space-y-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Anchor Date</span>
            <input
              type="date"
              value={anchorDate}
              onChange={(event) => setAnchorDate(event.target.value)}
              className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </label>
        }
      />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((item) => (
            <div key={item} className="animate-pulse rounded-card border border-stroke bg-panel p-5">
              <div className="h-5 w-56 rounded bg-panel-muted" />
              <div className="mt-3 h-4 w-full rounded bg-panel-muted" />
            </div>
          ))}
        </div>
      ) : data ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Week Window</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {formatDateOnly(data.week.start_date)} to {formatDateOnly(data.week.end_date)}
              </p>
            </div>
            <div className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Shipped</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{data.shipped.length}</p>
            </div>
            <div className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Stalled</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{data.stalled.length}</p>
            </div>
            <div className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pending Decisions</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">{data.pending_decisions.length}</p>
            </div>
          </section>

          <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Next Week Suggestions</h2>
            {data.next_week_suggestions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No explicit guidance generated for this review window.</p>
            ) : (
              <ol className="mt-3 space-y-2">
                {data.next_week_suggestions.map((suggestion, index) => (
                  <li key={`${suggestion}-${index}`} className="rounded-lg bg-panel-muted px-3 py-2 text-sm text-foreground">
                    {index + 1}. {suggestion}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Shipped This Week</h2>
              {data.shipped.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No tasks were completed in this review window.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {data.shipped.slice(0, 8).map((task) => (
                    <div key={task.id} className="rounded-lg bg-panel-muted px-3 py-2">
                      <p className="text-sm font-medium text-foreground">{task.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {task.implementation?.name || "Unassigned"} · updated {formatTimestamp(task.updated_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Pending Decisions</h2>
              {data.pending_decisions.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No review-blocked work right now.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {data.pending_decisions.slice(0, 8).map((task) => (
                    <div key={task.id} className="rounded-lg bg-panel-muted px-3 py-2">
                      <Link href={`/backlog?expand=${task.id}`} className="text-sm font-medium text-foreground hover:text-accent hover:underline">
                        {task.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {task.implementation?.name || "Unassigned"} · priority {task.priority_score}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Stalled Work</h2>
              {data.stalled.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No stale active work crossed the stall threshold.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {data.stalled.slice(0, 8).map((task) => (
                    <div key={task.id} className="rounded-lg bg-panel-muted px-3 py-2">
                      <Link href={`/backlog?expand=${task.id}`} className="text-sm font-medium text-foreground hover:text-accent hover:underline">
                        {task.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {task.implementation?.name || "Unassigned"} · last moved {formatTimestamp(task.updated_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-foreground">Cold Incoming Commitments</h2>
              {data.cold_commitments.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No cold incoming commitments are aging out.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {data.cold_commitments.slice(0, 8).map((commitment) => (
                    <div key={commitment.id} className="rounded-lg bg-panel-muted px-3 py-2">
                      <p className="text-sm font-medium text-foreground">{commitment.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {commitment.stakeholder?.name || "Unknown stakeholder"} · created {formatTimestamp(commitment.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground">Application Health</h2>
            {data.health_scores.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No application health data is available yet.</p>
            ) : (
              <div className="mt-3 grid gap-3 xl:grid-cols-2">
                {data.health_scores.map((score) => (
                  <div key={score.id} className="rounded-lg bg-panel-muted p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{score.name}</p>
                      <span className={`text-xs font-semibold ${healthTone(score.health_label)}`}>
                        {score.health_label} · {score.health_score}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{trendLabel(score.trend)}</p>
                    {score.signals.length > 0 ? (
                      <p className="mt-2 text-xs text-muted-foreground">{score.signals.join(" · ")}</p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">No risk signals currently detected.</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
