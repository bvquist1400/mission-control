"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface PlannerNowNext {
  taskId: string;
  title?: string;
  suggestedMinutes: number;
  mode: "deep" | "shallow" | "prep" | string;
}

interface PlannerNextItem {
  taskId: string;
  title?: string;
}

interface PlannerQueueItem {
  taskId: string;
  rank: number;
  score: number;
  title?: string;
}

interface PlannerExceptionItem {
  taskId: string;
  score?: number;
  title?: string;
  reason?: string;
}

interface PlannerPlanJson {
  nowNext: PlannerNowNext | null;
  next3: PlannerNextItem[];
  queue: PlannerQueueItem[];
  exceptions: PlannerExceptionItem[];
}

interface PlannerReasonEntry {
  finalScore?: number;
  why?: string[];
}

interface PlannerPlanRecord {
  id: string;
  status: "proposed" | "applied" | "dismissed";
  source: string;
  created_at: string;
  plan_json: PlannerPlanJson;
  reasons_json: Record<string, PlannerReasonEntry>;
}

interface PlannerGetResponse {
  planDate: string;
  source: string;
  plan: PlannerPlanRecord | null;
  note?: string;
}

interface PlannerPostResponse {
  planDate: string;
  source: string;
  plan_json: PlannerPlanJson;
  reasons_json: Record<string, PlannerReasonEntry>;
  persisted?: {
    saved: boolean;
    planId: string | null;
  };
}

interface PlannerViewState {
  planDate: string;
  source: string;
  status: "proposed" | "applied" | "dismissed" | "unsaved";
  plan: PlannerPlanJson | null;
  reasons: Record<string, PlannerReasonEntry>;
}

function getDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return new Date().toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function displayTitle(item: { title?: string; taskId: string }): string {
  return item.title && item.title.trim().length > 0 ? item.title : item.taskId;
}

function whyLines(reasons: Record<string, PlannerReasonEntry>, taskId: string): string[] {
  const lines = reasons[taskId]?.why;
  return Array.isArray(lines) ? lines.slice(0, 2) : [];
}

async function fetchLatestPlan(date: string): Promise<PlannerGetResponse> {
  const response = await fetch(`/api/planner/plan?date=${date}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch planner data");
  }

  return response.json();
}

async function replan(date: string): Promise<PlannerPostResponse> {
  const response = await fetch("/api/planner/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, mode: "today" }),
  });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to generate plan");
  }

  return response.json();
}

export function PlannerCard() {
  const [state, setState] = useState<PlannerViewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateInEt = useMemo(() => getDateInTimeZone("America/New_York"), []);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchLatestPlan(dateInEt);
        if (!isMounted) return;

        setState({
          planDate: data.planDate,
          source: data.plan?.source ?? data.source,
          status: data.plan?.status ?? "unsaved",
          plan: data.plan?.plan_json ?? null,
          reasons: data.plan?.reasons_json ?? {},
        });
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load planner");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [dateInEt]);

  async function handleReplan() {
    const planDate = state?.planDate ?? dateInEt;
    setReplanning(true);
    setError(null);

    try {
      const data = await replan(planDate);
      setState({
        planDate: data.planDate,
        source: data.source,
        status: data.persisted?.saved ? "proposed" : "unsaved",
        plan: data.plan_json,
        reasons: data.reasons_json,
      });
    } catch (replanError) {
      setError(replanError instanceof Error ? replanError.message : "Failed to replan");
    } finally {
      setReplanning(false);
    }
  }

  const queuePreview = state?.plan?.queue.slice(0, 5) ?? [];
  const nextThree = state?.plan?.next3 ?? [];
  const exceptions = state?.plan?.exceptions ?? [];
  const nowNext = state?.plan?.nowNext ?? null;
  const reasons = state?.reasons ?? {};
  const titleByTaskId = useMemo(() => {
    const map = new Map<string, string>();

    for (const item of state?.plan?.queue ?? []) {
      if (item.title && item.title.trim().length > 0) {
        map.set(item.taskId, item.title);
      }
    }

    for (const item of state?.plan?.exceptions ?? []) {
      if (item.title && item.title.trim().length > 0) {
        map.set(item.taskId, item.title);
      }
    }

    return map;
  }, [state?.plan?.exceptions, state?.plan?.queue]);

  function taskLabel(taskId: string, preferredTitle?: string): string {
    if (preferredTitle && preferredTitle.trim().length > 0) {
      return preferredTitle;
    }

    const fromLookup = titleByTaskId.get(taskId);
    if (fromLookup && fromLookup.trim().length > 0) {
      return fromLookup;
    }

    return taskId;
  }

  return (
    <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Planner</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {state?.planDate ? `Plan date ${state.planDate}` : `Plan date ${dateInEt}`} · {state?.source ?? "planner_v1.1"} ·{" "}
            {state?.status ?? "loading"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleReplan()}
          disabled={replanning || loading}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {replanning ? "Replanning..." : "Replan"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[1, 2, 3].map((block) => (
            <div key={block} className="animate-pulse rounded-lg bg-panel-muted p-3">
              <div className="h-3 w-24 rounded bg-stroke" />
              <div className="mt-2 h-4 w-full rounded bg-stroke" />
              <div className="mt-2 h-3 w-3/4 rounded bg-stroke" />
            </div>
          ))}
        </div>
      ) : !state?.plan ? (
        <p className="mt-4 text-sm text-muted-foreground">No saved plan yet. Click Replan to generate one.</p>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <article className="rounded-lg bg-panel-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">Now Next</h3>
            {!nowNext ? (
              <p className="mt-2 text-sm text-muted-foreground">No recommendation yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                <p className="text-sm text-foreground">
                  <Link className="font-semibold hover:underline" href={`/backlog#task-${nowNext.taskId}`}>
                    {taskLabel(nowNext.taskId, nowNext.title)}
                  </Link>
                  {" · "}
                  {nowNext.suggestedMinutes} min · {nowNext.mode}
                </p>
                {whyLines(reasons, nowNext.taskId).length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {whyLines(reasons, nowNext.taskId).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">Next 3</h3>
            {nextThree.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No follow-on tasks.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {nextThree.map((item) => (
                  <li key={item.taskId}>
                    <Link className="font-medium text-foreground hover:underline" href={`/backlog#task-${item.taskId}`}>
                      {taskLabel(item.taskId, item.title)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">Queue (Top 5)</h3>
            {queuePreview.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No queued tasks.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {queuePreview.map((item) => (
                  <li key={item.taskId} className="flex items-center justify-between gap-3">
                    <Link className="min-w-0 truncate font-medium text-foreground hover:underline" href={`/backlog#task-${item.taskId}`}>
                      {displayTitle(item)}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">#{item.rank} · {item.score.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">Exceptions</h3>
            {exceptions.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No exceptions right now.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {exceptions.map((item) => (
                  <li key={item.taskId}>
                    <p className="font-medium text-foreground">
                      <Link className="hover:underline" href={`/backlog#task-${item.taskId}`}>
                        {displayTitle(item)}
                      </Link>
                    </p>
                    {item.reason ? <p className="text-xs text-muted-foreground">{item.reason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
