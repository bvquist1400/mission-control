"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MorningBriefing } from "./MorningBriefing";
import { MiddayBriefing } from "./MiddayBriefing";
import { EODBriefing } from "./EODBriefing";
import { BriefingNarrative } from "./BriefingNarrative";
import type { BriefingMode, BriefingNarrativeResponse, BriefingResponse } from "@/lib/briefing";
import type { LlmModelCatalogRow, LlmRunMeta } from "@/lib/llm";

interface DailyBriefingProps {
  replanSignal?: number;
}

interface LlmModelsResponse {
  models: LlmModelCatalogRow[];
  preferences?: {
    global_default: string | null;
    briefing_narrative: string | null;
    intake_extraction: string | null;
  };
  resolved?: {
    briefing_narrative: (LlmModelCatalogRow & { source: string }) | null;
    intake_extraction: (LlmModelCatalogRow & { source: string }) | null;
  };
  activeModelId?: string | null;
}

interface ActiveModelResponse {
  preferences?: {
    global_default: string | null;
    briefing_narrative: string | null;
    intake_extraction: string | null;
  };
  resolved?: {
    briefing_narrative: (LlmModelCatalogRow & { source: string }) | null;
    intake_extraction: (LlmModelCatalogRow & { source: string }) | null;
  };
}

const modeLabels: Record<BriefingMode, string> = {
  morning: "Morning",
  midday: "Midday",
  eod: "EOD",
};

const modeDescriptions: Record<BriefingMode, string> = {
  morning: "Today's plan",
  midday: "Progress check",
  eod: "Tomorrow prep",
};

const NARRATIVE_LAST_AUTO_CYCLE_KEY = "mc:briefing:last-auto-narrative-cycle";
const NARRATIVE_LAST_PAYLOAD_KEY = "mc:briefing:last-narrative-payload";

interface StoredNarrativePayload {
  cycleKey: string;
  narrative: string;
  llm: LlmRunMeta | null;
}

function readStoredNarrative(cycleKey: string): StoredNarrativePayload | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(NARRATIVE_LAST_PAYLOAD_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StoredNarrativePayload>;
    if (
      parsed &&
      typeof parsed.cycleKey === "string" &&
      parsed.cycleKey === cycleKey &&
      typeof parsed.narrative === "string" &&
      parsed.narrative.trim().length > 0
    ) {
      return {
        cycleKey: parsed.cycleKey,
        narrative: parsed.narrative,
        llm: (parsed.llm ?? null) as LlmRunMeta | null,
      };
    }
  } catch {
    // Ignore invalid storage payload.
  }

  return null;
}

function writeStoredNarrative(payload: StoredNarrativePayload): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(NARRATIVE_LAST_PAYLOAD_KEY, JSON.stringify(payload));
  } catch {
    // Ignore localStorage write failures.
  }
}

export function DailyBriefing({ replanSignal }: DailyBriefingProps) {
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<BriefingMode | null>(null);

  const [narrative, setNarrative] = useState<string>("");
  const [narrativeMeta, setNarrativeMeta] = useState<LlmRunMeta | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  const [models, setModels] = useState<LlmModelCatalogRow[]>([]);
  const [narrativeModelId, setNarrativeModelId] = useState<string | null>(null);
  const [resolvedNarrativeModel, setResolvedNarrativeModel] = useState<
    (LlmModelCatalogRow & { source: string }) | null
  >(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const latestBriefingRequestRef = useRef(0);
  const latestNarrativeRequestRef = useRef(0);
  const lastNarrativeCycleKeyRef = useRef<string | null>(null);

  const enabledModels = useMemo(() => models.filter((model) => model.enabled), [models]);
  const selectedModel = useMemo(
    () => enabledModels.find((model) => model.id === narrativeModelId) || null,
    [enabledModels, narrativeModelId]
  );

  const fetchModelState = useCallback(async () => {
    setModelLoading(true);
    setModelError(null);

    try {
      const response = await fetch("/api/llm/models", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Failed to load model catalog");
      }

      const payload = (await response.json()) as LlmModelsResponse;
      setModels(Array.isArray(payload.models) ? payload.models : []);
      setNarrativeModelId(payload.preferences?.briefing_narrative ?? payload.activeModelId ?? null);
      setResolvedNarrativeModel(payload.resolved?.briefing_narrative ?? null);
    } catch (err) {
      setModelError(err instanceof Error ? err.message : "Failed to load model selector");
      setModels([]);
      setNarrativeModelId(null);
      setResolvedNarrativeModel(null);
    } finally {
      setModelLoading(false);
    }
  }, []);

  const fetchNarrative = useCallback(
    async (briefingData: BriefingResponse): Promise<{ attempted: boolean; hasNarrative: boolean }> => {
      const cycleKey = `${briefingData.requestedDate}:${briefingData.mode}`;
      const requestId = ++latestNarrativeRequestRef.current;
      setNarrativeLoading(true);

      try {
        const response = await fetch("/api/briefing/narrative", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ briefing: briefingData }),
        });

        if (!response.ok) {
          throw new Error("Failed to fetch narrative");
        }

        const payload = (await response.json()) as BriefingNarrativeResponse;
        if (requestId !== latestNarrativeRequestRef.current) {
          return { attempted: false, hasNarrative: false };
        }

        const nextNarrative = (payload.narrative || "").trim();
        if (nextNarrative.length > 0) {
          setNarrative(nextNarrative);
          setNarrativeMeta(payload.llm);
          writeStoredNarrative({
            cycleKey,
            narrative: nextNarrative,
            llm: payload.llm,
          });
          return { attempted: true, hasNarrative: true };
        }

        // Keep the currently rendered narrative if provider returned empty output.
        return { attempted: true, hasNarrative: false };
      } catch {
        if (requestId !== latestNarrativeRequestRef.current) {
          return { attempted: false, hasNarrative: false };
        }

        // Non-blocking by design; preserve current narrative on error.
        return { attempted: true, hasNarrative: false };
      } finally {
        if (requestId === latestNarrativeRequestRef.current) {
          setNarrativeLoading(false);
        }
      }
    },
    []
  );

  const maybeGenerateNarrativeForCycle = useCallback(
    (briefingData: BriefingResponse) => {
      if (modeOverride !== null) {
        return;
      }

      const cycleKey = `${briefingData.requestedDate}:${briefingData.mode}`;
      const stored = readStoredNarrative(cycleKey);
      if (!lastNarrativeCycleKeyRef.current && typeof window !== "undefined") {
        lastNarrativeCycleKeyRef.current = window.localStorage.getItem(NARRATIVE_LAST_AUTO_CYCLE_KEY);
      }

      if (lastNarrativeCycleKeyRef.current === cycleKey && stored) {
        return;
      }

      void fetchNarrative(briefingData).then((result) => {
        if (!result.attempted) {
          return;
        }
        lastNarrativeCycleKeyRef.current = cycleKey;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(NARRATIVE_LAST_AUTO_CYCLE_KEY, cycleKey);
        }
      });
    },
    [fetchNarrative, modeOverride]
  );

  const fetchBriefing = useCallback(
    async (mode: BriefingMode | "auto" = "auto") => {
      const requestId = ++latestBriefingRequestRef.current;

      try {
        setLoading(true);
        setError(null);

        const response = await fetch(`/api/briefing?mode=${mode}`, {
          cache: "no-store",
        });

        if (response.status === 401) {
          throw new Error("Authentication required");
        }

        if (!response.ok) {
          throw new Error("Failed to fetch briefing");
        }

        const briefingData = (await response.json()) as BriefingResponse;
        if (requestId !== latestBriefingRequestRef.current) {
          return;
        }

        const cycleKey = `${briefingData.requestedDate}:${briefingData.mode}`;
        const stored = readStoredNarrative(cycleKey);
        setData(briefingData);
        if (stored) {
          setNarrative(stored.narrative);
          setNarrativeMeta(stored.llm);
        } else {
          setNarrative("");
          setNarrativeMeta(null);
        }
        maybeGenerateNarrativeForCycle(briefingData);
      } catch (err) {
        if (requestId !== latestBriefingRequestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        if (requestId === latestBriefingRequestRef.current) {
          setLoading(false);
        }
      }
    },
    [maybeGenerateNarrativeForCycle]
  );

  // Initial load and mode changes
  useEffect(() => {
    fetchBriefing(modeOverride ?? "auto");
  }, [fetchBriefing, replanSignal, modeOverride]);

  useEffect(() => {
    fetchModelState();
  }, [fetchModelState]);

  // Periodic refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      fetchBriefing(modeOverride ?? "auto");
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [fetchBriefing, modeOverride]);

  const handleModeChange = (newMode: BriefingMode | "auto") => {
    if (newMode === "auto") {
      setModeOverride(null);
    } else {
      setModeOverride(newMode);
    }
  };

  const handleRefresh = () => {
    fetchBriefing(modeOverride ?? "auto");
  };

  const handleGenerateNarrative = () => {
    if (!data) {
      return;
    }
    void fetchNarrative(data);
  };

  const handleModelChange = async (nextModelId: string | null) => {
    setModelSaving(true);
    setModelError(null);

    try {
      const response = await fetch("/api/llm/models/active", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: nextModelId, feature: "briefing_narrative" }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Failed to update active model");
      }

      const payload = (await response.json()) as ActiveModelResponse;
      setNarrativeModelId(payload.preferences?.briefing_narrative ?? null);
      setResolvedNarrativeModel(payload.resolved?.briefing_narrative ?? null);
      if (data) {
        void fetchNarrative(data);
      }
    } catch (err) {
      setModelError(err instanceof Error ? err.message : "Failed to update active model");
    } finally {
      setModelSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="rounded-lg border border-stroke bg-panel p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 w-48 rounded bg-panel-muted" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-32 rounded bg-panel-muted" />
            <div className="h-32 rounded bg-panel-muted" />
          </div>
          <div className="h-24 rounded bg-panel-muted" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={handleRefresh}
          className="mt-2 text-sm text-red-400 underline hover:text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const activeMode = modeOverride ?? data.autoDetectedMode;
  const isAutoMode = modeOverride === null;

  return (
    <div className="rounded-lg border border-stroke bg-panel">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b border-stroke px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Daily Briefing</h2>
          <p className="text-sm text-muted-foreground">
            {modeDescriptions[activeMode]} &middot; {data.currentTimeET}
          </p>
          <p className="text-xs text-muted-foreground">
            {selectedModel
              ? `LLM: ${selectedModel.display_name}`
              : resolvedNarrativeModel
                ? `LLM: ${resolvedNarrativeModel.display_name} (${resolvedNarrativeModel.source.replace("_", " ")})`
                : "Using system default model"}
          </p>
          {modelError && <p className="text-xs text-red-400">{modelError}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Mode selector */}
          <div className="flex items-center gap-1 rounded-lg border border-stroke bg-panel-muted p-1">
            <button
              onClick={() => handleModeChange("auto")}
              className={`rounded px-3 py-1 text-xs font-medium transition ${
                isAutoMode
                  ? "bg-accent text-white"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Auto
            </button>
            {(["morning", "midday", "eod"] as BriefingMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => handleModeChange(mode)}
                className={`rounded px-3 py-1 text-xs font-medium transition ${
                  !isAutoMode && activeMode === mode
                    ? "bg-accent text-white"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {modeLabels[mode]}
              </button>
            ))}
          </div>

          {/* Model selector */}
          <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel-muted px-2 py-1 text-xs text-muted-foreground">
            <span>Model</span>
            <select
              value={narrativeModelId ?? "__default__"}
              onChange={(event) => {
                const value = event.target.value;
                void handleModelChange(value === "__default__" ? null : value);
              }}
              disabled={modelSaving || modelLoading || enabledModels.length === 0}
              className="rounded border border-stroke bg-panel px-2 py-1 text-xs text-foreground"
            >
              <option value="__default__">Inherit Global/Default</option>
              {enabledModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}
                </option>
              ))}
            </select>
          </label>

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="rounded-lg border border-stroke p-2 text-muted-foreground transition hover:border-accent hover:text-accent disabled:opacity-50"
            title="Refresh"
          >
            <svg
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>

          <button
            onClick={handleGenerateNarrative}
            disabled={!data || narrativeLoading}
            className="rounded-lg border border-stroke px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-accent hover:text-accent disabled:opacity-50"
            title="Generate narrative summary"
          >
            {narrativeLoading ? "Generating..." : "Generate Summary"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <BriefingNarrative
          narrative={narrative}
          llm={narrativeMeta}
          loading={narrativeLoading}
        />

        {enabledModels.length === 0 && (
          <p className="mb-4 text-xs text-amber-400">
            No enabled catalog models found. Using default provider fallback sequence.
          </p>
        )}

        {activeMode === "morning" && (
          <MorningBriefing
            calendar={data.today.calendar}
            tasks={data.today.tasks}
            capacity={data.today.capacity}
          />
        )}

        {activeMode === "midday" && (
          <MiddayBriefing
            calendar={{
              events: data.today.calendar.events,
              focusBlocks: data.today.calendar.focusBlocks,
            }}
            tasks={data.today.tasks}
            progress={data.today.progress}
          />
        )}

        {activeMode === "eod" && data.tomorrow && (
          <EODBriefing
            today={{
              tasks: data.today.tasks,
              progress: data.today.progress,
            }}
            tomorrow={data.tomorrow}
          />
        )}

        {activeMode === "eod" && !data.tomorrow && (
          <div className="text-center text-muted-foreground">
            <p>Tomorrow&apos;s data not available yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
