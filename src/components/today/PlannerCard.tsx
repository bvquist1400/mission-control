"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type PlannerMode = "today" | "now";

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

interface PlannerWindow {
  minutes?: number;
  source?: string;
}

interface PlannerPlanJson {
  nowNext: PlannerNowNext | null;
  next3: PlannerNextItem[];
  queue: PlannerQueueItem[];
  exceptions: PlannerExceptionItem[];
  windows?: PlannerWindow[];
}

interface PlannerReasonEntry {
  finalScore?: number;
  why?: string[];
  directiveMatched?: boolean;
  directiveMultiplier?: number;
  implementationMultiplier?: number;
  urgencyBoost?: number;
  stakeholderBoost?: number;
  stalenessBoost?: number;
  statusAdjust?: number;
  fitBonus?: number;
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
  mode: PlannerMode;
  source: string;
  plan_json: PlannerPlanJson;
  reasons_json: Record<string, PlannerReasonEntry>;
  note?: string;
  persisted?: {
    saved: boolean;
    planId: string | null;
  };
}

interface PlannerViewState {
  planDate: string;
  source: string;
  status: "proposed" | "applied" | "dismissed" | "unsaved";
  generatedAt: string | null;
  plan: PlannerPlanJson | null;
  reasons: Record<string, PlannerReasonEntry>;
  note: string | null;
}

interface PlannerCardProps {
  replanSignal?: number;
}

const PLANNER_READ_TIMEOUT_MS = 12000;
const PLANNER_REPLAN_TIMEOUT_MS = 20000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Planner request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function whyLines(reasons: Record<string, PlannerReasonEntry>, taskId: string, maxLines = 2): string[] {
  const lines = reasons[taskId]?.why;
  return Array.isArray(lines) ? lines.slice(0, maxLines) : [];
}

function formatTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatModeLabel(mode: string): string {
  switch (mode) {
    case "deep":
      return "Deep";
    case "shallow":
      return "Shallow";
    case "prep":
      return "Prep";
    default:
      return mode;
  }
}

function formatStatusLabel(status: PlannerViewState["status"]): string {
  switch (status) {
    case "proposed":
      return "Proposed";
    case "applied":
      return "Applied";
    case "dismissed":
      return "Dismissed";
    default:
      return "Unsaved";
  }
}

function statusPillClass(status: PlannerViewState["status"]): string {
  switch (status) {
    case "proposed":
      return "bg-accent text-white";
    case "applied":
      return "bg-emerald-500/20 text-emerald-300";
    case "dismissed":
      return "bg-amber-500/20 text-amber-300";
    default:
      return "bg-panel-muted text-muted-foreground";
  }
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function fetchLatestPlan(date: string): Promise<PlannerGetResponse> {
  const response = await fetchWithTimeout(
    `/api/planner/plan?date=${date}`,
    { cache: "no-store" },
    PLANNER_READ_TIMEOUT_MS
  );

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch planner data");
  }

  return response.json();
}

async function replan(date: string, mode: PlannerMode): Promise<PlannerPostResponse> {
  const response = await fetchWithTimeout(
    "/api/planner/plan",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, mode }),
    },
    PLANNER_REPLAN_TIMEOUT_MS
  );

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  const data = (await response.json().catch(() => ({}))) as { error?: string } & PlannerPostResponse;
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to generate plan");
  }

  return data;
}

export function PlannerCard({ replanSignal = 0 }: PlannerCardProps) {
  const dateInEt = useMemo(() => getDateInTimeZone("America/New_York"), []);
  const [selectedDate, setSelectedDate] = useState(dateInEt);
  const [mode, setMode] = useState<PlannerMode>("today");
  const [state, setState] = useState<PlannerViewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);
  const processedReplanSignal = useRef(0);
  const latestLoadOperationId = useRef(0);
  const latestReplanOperationId = useRef(0);

  const loadPlan = useCallback(async (targetDate: string, initialLoad: boolean) => {
    const operationId = ++latestLoadOperationId.current;
    if (initialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);

    try {
      const data = await fetchLatestPlan(targetDate);
      if (operationId !== latestLoadOperationId.current) return;

      setState({
        planDate: data.planDate,
        source: data.plan?.source ?? data.source,
        status: data.plan?.status ?? "unsaved",
        generatedAt: data.plan?.created_at ?? null,
        plan: data.plan?.plan_json ?? null,
        reasons: data.plan?.reasons_json ?? {},
        note: data.note ?? null,
      });
    } catch (loadError) {
      if (operationId !== latestLoadOperationId.current) return;
      setError(toErrorMessage(loadError, "Failed to load planner"));
    } finally {
      if (operationId === latestLoadOperationId.current) {
        if (initialLoad) {
          setLoading(false);
        } else {
          setRefreshing(false);
        }
      }
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    await loadPlan(selectedDate, false);
  }, [loadPlan, selectedDate]);

  const handleReplan = useCallback(
    async (explicitDate?: string, explicitMode?: PlannerMode) => {
      const planDate = explicitDate ?? selectedDate;
      const replanMode = explicitMode ?? mode;
      const operationId = ++latestReplanOperationId.current;
      setReplanning(true);
      setError(null);

      try {
        const data = await replan(planDate, replanMode);
        if (operationId !== latestReplanOperationId.current) return;

        setState({
          planDate: data.planDate,
          source: data.source,
          status: data.persisted?.saved ? "proposed" : "unsaved",
          generatedAt: new Date().toISOString(),
          plan: data.plan_json,
          reasons: data.reasons_json,
          note: data.note ?? null,
        });
      } catch (replanError) {
        if (operationId !== latestReplanOperationId.current) return;
        setError(toErrorMessage(replanError, "Failed to replan"));
      } finally {
        if (operationId === latestReplanOperationId.current) {
          setReplanning(false);
        }
      }
    },
    [mode, selectedDate]
  );

  useEffect(() => {
    const initialLoad = !hasLoadedOnce.current;
    hasLoadedOnce.current = true;
    void loadPlan(selectedDate, initialLoad);
  }, [loadPlan, selectedDate]);

  useEffect(() => {
    if (replanSignal <= 0 || processedReplanSignal.current === replanSignal) {
      return;
    }

    processedReplanSignal.current = replanSignal;
    void handleReplan();
  }, [handleReplan, replanSignal]);

  const queuePreview = state?.plan?.queue.slice(0, 8) ?? [];
  const nextThree = state?.plan?.next3 ?? [];
  const exceptions = state?.plan?.exceptions ?? [];
  const windows = state?.plan?.windows ?? [];
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
          <h2 className="text-lg font-semibold text-foreground">Plans</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Directive-aware recommendations for now, next, and exceptions (v1.2 UI).
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{state?.planDate ? `Plan date ${state.planDate}` : `Plan date ${selectedDate}`}</span>
            <span>·</span>
            <span>{state?.source ?? "planner_v1.1"}</span>
            <span>·</span>
            <span className={`rounded-full px-2 py-0.5 font-semibold ${statusPillClass(state?.status ?? "unsaved")}`}>
              {formatStatusLabel(state?.status ?? "unsaved")}
            </span>
            {formatTimestamp(state?.generatedAt ?? null) ? (
              <>
                <span>·</span>
                <span>Generated {formatTimestamp(state?.generatedAt ?? null)}</span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              disabled={loading || refreshing || replanning}
              className="rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <label className="space-y-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Mode</span>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as PlannerMode)}
              disabled={loading || refreshing || replanning}
              className="rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="today">Today</option>
              <option value="now">Now</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing || replanning}
            className="rounded-lg border border-stroke px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>

          <button
            type="button"
            onClick={() => void handleReplan()}
            disabled={loading || refreshing || replanning}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {replanning ? "Replanning..." : "Replan"}
          </button>
        </div>
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
        <p className="mt-4 text-sm text-muted-foreground">No saved plan for this date. Click Replan to generate one.</p>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
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
                  {nowNext.suggestedMinutes} min · {formatModeLabel(nowNext.mode)}
                </p>
                {typeof reasons[nowNext.taskId]?.finalScore === "number" ? (
                  <p className="text-xs text-muted-foreground">Score {reasons[nowNext.taskId]?.finalScore?.toFixed(1)}</p>
                ) : null}
                {whyLines(reasons, nowNext.taskId, 3).length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {whyLines(reasons, nowNext.taskId, 3).map((line) => (
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
                    <p>
                      <Link className="font-medium text-foreground hover:underline" href={`/backlog#task-${item.taskId}`}>
                        {taskLabel(item.taskId, item.title)}
                      </Link>
                    </p>
                    {whyLines(reasons, item.taskId, 1).length > 0 ? (
                      <p className="text-xs text-muted-foreground">{whyLines(reasons, item.taskId, 1)[0]}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-4">
            <h3 className="text-sm font-semibold text-foreground">Queue (Top 8)</h3>
            {queuePreview.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No queued tasks.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {queuePreview.map((item) => {
                  const reason = reasons[item.taskId];
                  return (
                    <li key={item.taskId}>
                      <div className="flex items-center justify-between gap-3">
                        <Link className="min-w-0 truncate font-medium text-foreground hover:underline" href={`/backlog#task-${item.taskId}`}>
                          {displayTitle(item)}
                        </Link>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          #{item.rank} · {item.score.toFixed(1)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {typeof reason?.directiveMatched === "boolean" ? (
                          <span>{reason.directiveMatched ? "Focus match" : "Outside focus"}</span>
                        ) : null}
                        {whyLines(reasons, item.taskId, 1).length > 0 ? <span>{whyLines(reasons, item.taskId, 1)[0]}</span> : null}
                      </div>
                    </li>
                  );
                })}
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
                      {typeof item.score === "number" ? <span className="ml-2 text-xs text-muted-foreground">{item.score.toFixed(1)}</span> : null}
                    </p>
                    {item.reason ? <p className="text-xs text-muted-foreground">{item.reason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-4 xl:col-span-2">
            <h3 className="text-sm font-semibold text-foreground">Planner Windows</h3>
            {windows.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No window metadata on this plan.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {windows.map((window, index) => (
                  <li
                    key={`${window.source ?? "window"}-${window.minutes ?? "unknown"}-${index}`}
                    className="rounded-full border border-stroke bg-panel px-3 py-1 text-xs text-muted-foreground"
                  >
                    {typeof window.minutes === "number" ? `${window.minutes} min` : "Window"} · {window.source ?? "unknown"}
                  </li>
                ))}
              </ul>
            )}
            {state.note ? <p className="mt-3 text-xs text-muted-foreground">{state.note}</p> : null}
          </article>
        </div>
      )}
    </section>
  );
}
