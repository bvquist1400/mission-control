"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";

type UsageFeatureFilter = "all" | "briefing_narrative" | "intake_extraction";
type PreferenceFeature = "global_default" | "briefing_narrative" | "intake_extraction";

interface CatalogModel {
  id: string;
  provider: "openai" | "anthropic";
  model_id: string;
  display_name: string;
  enabled: boolean;
  pricing_is_placeholder: boolean;
  input_price_per_1m_usd: number | null;
  output_price_per_1m_usd: number | null;
  pricing_tier: "standard" | "flex" | "priority" | null;
  sort_order: number;
}

interface CatalogModelDraft {
  displayName: string;
  enabled: boolean;
  inputPricePer1mUsd: string;
  outputPricePer1mUsd: string;
  pricingTier: "standard" | "flex" | "priority" | "";
  pricingIsPlaceholder: boolean;
  sortOrder: string;
}

interface ModelsResponse {
  models: CatalogModel[];
  preferences: {
    global_default: string | null;
    briefing_narrative: string | null;
    intake_extraction: string | null;
  };
  resolved: {
    briefing_narrative: (CatalogModel & { source: "feature_override" | "global_default" | "default" }) | null;
    intake_extraction: (CatalogModel & { source: "feature_override" | "global_default" | "default" }) | null;
  };
}

interface UsageResponse {
  from: string;
  to: string;
  feature: UsageFeatureFilter;
  summary: Array<{
    provider: string;
    modelId: string;
    callCount: number;
    successRate: number;
    avgLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalEstimatedCostUsd: number;
    pricingIsPlaceholder: boolean;
  }>;
  events: Array<{
    id: string;
    createdAt: string;
    feature: "briefing_narrative" | "intake_extraction";
    provider: "openai" | "anthropic" | null;
    modelId: string | null;
    modelSource: "feature_override" | "global_default" | "default" | null;
    status: string;
    cacheStatus: "hit" | "miss" | null;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number;
    pricingIsPlaceholder: boolean;
    pricingTier: "standard" | "flex" | "priority" | null;
  }>;
}

function getTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDaysAgoIso(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sourceLabel(source: "feature_override" | "global_default" | "default" | null | undefined): string {
  if (source === "feature_override") return "Feature override";
  if (source === "global_default") return "Global default";
  if (source === "default") return "Hardcoded fallback";
  return "n/a";
}

function toCatalogDraft(model: CatalogModel): CatalogModelDraft {
  return {
    displayName: model.display_name,
    enabled: model.enabled,
    inputPricePer1mUsd:
      model.input_price_per_1m_usd === null ? "" : String(model.input_price_per_1m_usd),
    outputPricePer1mUsd:
      model.output_price_per_1m_usd === null ? "" : String(model.output_price_per_1m_usd),
    pricingTier: model.pricing_tier ?? "",
    pricingIsPlaceholder: model.pricing_is_placeholder,
    sortOrder: String(model.sort_order),
  };
}

function parsePriceInput(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be blank or a non-negative number`);
  }
  return parsed;
}

export default function LlmEvaluationPage() {
  const [fromDate, setFromDate] = useState(getDaysAgoIso(29));
  const [toDate, setToDate] = useState(getTodayIso());
  const [feature, setFeature] = useState<UsageFeatureFilter>("all");
  const [modelsPayload, setModelsPayload] = useState<ModelsResponse | null>(null);
  const [usagePayload, setUsagePayload] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingFeature, setSavingFeature] = useState<PreferenceFeature | null>(null);
  const [catalogDrafts, setCatalogDrafts] = useState<Record<string, CatalogModelDraft>>({});
  const [savingCatalogModelId, setSavingCatalogModelId] = useState<string | null>(null);

  const enabledModels = useMemo(
    () => (modelsPayload?.models || []).filter((model) => model.enabled),
    [modelsPayload]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const usageQuery = new URLSearchParams({
        from: fromDate,
        to: toDate,
        feature,
      });

      const [modelsResponse, usageResponse] = await Promise.all([
        fetch("/api/llm/models", { cache: "no-store" }),
        fetch(`/api/llm/usage?${usageQuery.toString()}`, { cache: "no-store" }),
      ]);

      if (!modelsResponse.ok) {
        throw new Error("Failed to load model catalog");
      }
      if (!usageResponse.ok) {
        throw new Error("Failed to load usage telemetry");
      }

      const modelsData = (await modelsResponse.json()) as ModelsResponse;
      const usageData = (await usageResponse.json()) as UsageResponse;
      setModelsPayload(modelsData);
      setUsagePayload(usageData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [feature, fromDate, toDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const models = modelsPayload?.models || [];
    const nextDrafts: Record<string, CatalogModelDraft> = {};
    for (const model of models) {
      nextDrafts[model.id] = toCatalogDraft(model);
    }
    setCatalogDrafts(nextDrafts);
  }, [modelsPayload]);

  const updatePreference = useCallback(
    async (preferenceFeature: PreferenceFeature, modelId: string | null) => {
      setSavingFeature(preferenceFeature);
      setError(null);

      try {
        const response = await fetch("/api/llm/models/active", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feature: preferenceFeature, modelId }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || "Failed to update preference");
        }

        await loadData();
      } catch (updateError) {
        setError(updateError instanceof Error ? updateError.message : "Failed to update preference");
      } finally {
        setSavingFeature(null);
      }
    },
    [loadData]
  );

  const preferenceValue = (featureName: PreferenceFeature): string => {
    if (!modelsPayload) {
      return "__none__";
    }
    return modelsPayload.preferences[featureName] || "__none__";
  };

  const updateCatalogDraft = (modelId: string, updates: Partial<CatalogModelDraft>) => {
    setCatalogDrafts((prev) => {
      const current = prev[modelId];
      if (!current) {
        return prev;
      }
      return {
        ...prev,
        [modelId]: {
          ...current,
          ...updates,
        },
      };
    });
  };

  const saveCatalogModel = useCallback(
    async (modelId: string) => {
      const draft = catalogDrafts[modelId];
      if (!draft) {
        return;
      }

      const parsedSortOrder = Number(draft.sortOrder.trim());
      if (!Number.isInteger(parsedSortOrder)) {
        setError("Sort order must be an integer");
        return;
      }

      let inputPrice: number | null;
      let outputPrice: number | null;
      try {
        inputPrice = parsePriceInput(draft.inputPricePer1mUsd, "Input price");
        outputPrice = parsePriceInput(draft.outputPricePer1mUsd, "Output price");
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : "Invalid pricing values");
        return;
      }

      setSavingCatalogModelId(modelId);
      setError(null);

      try {
        const response = await fetch(`/api/llm/models/catalog/${modelId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: draft.displayName.trim(),
            enabled: draft.enabled,
            inputPricePer1mUsd: inputPrice,
            outputPricePer1mUsd: outputPrice,
            pricingTier: draft.pricingTier === "" ? null : draft.pricingTier,
            pricingIsPlaceholder: draft.pricingIsPlaceholder,
            sortOrder: parsedSortOrder,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || "Failed to update model catalog row");
        }

        await loadData();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Failed to update model catalog row");
      } finally {
        setSavingCatalogModelId(null);
      }
    },
    [catalogDrafts, loadData]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="LLM Evaluation"
        description="Compare model performance, reliability, token usage, and estimated cost for briefing narrative and extraction calls."
        actions={
          <button
            onClick={() => loadData()}
            className="rounded-lg border border-stroke px-3 py-1.5 text-sm text-muted-foreground hover:border-accent hover:text-accent"
          >
            Refresh
          </button>
        }
      />

      <section className="rounded-lg border border-stroke bg-panel p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Model Routing</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Global default</p>
            <select
              value={preferenceValue("global_default")}
              onChange={(event) => {
                const value = event.target.value;
                void updatePreference("global_default", value === "__none__" ? null : value);
              }}
              disabled={savingFeature !== null}
              className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
            >
              <option value="__none__">Hardcoded fallback chain</option>
              {enabledModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-xs uppercase text-muted-foreground">Narrative override</p>
            <select
              value={preferenceValue("briefing_narrative")}
              onChange={(event) => {
                const value = event.target.value;
                void updatePreference("briefing_narrative", value === "__none__" ? null : value);
              }}
              disabled={savingFeature !== null}
              className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
            >
              <option value="__none__">Inherit global default</option>
              {enabledModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Resolved: {modelsPayload?.resolved.briefing_narrative?.display_name || "Hardcoded fallback"} ({sourceLabel(modelsPayload?.resolved.briefing_narrative?.source)})
            </p>
          </div>

          <div>
            <p className="text-xs uppercase text-muted-foreground">Extraction override</p>
            <select
              value={preferenceValue("intake_extraction")}
              onChange={(event) => {
                const value = event.target.value;
                void updatePreference("intake_extraction", value === "__none__" ? null : value);
              }}
              disabled={savingFeature !== null}
              className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
            >
              <option value="__none__">Inherit global default</option>
              {enabledModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Resolved: {modelsPayload?.resolved.intake_extraction?.display_name || "Hardcoded fallback"} ({sourceLabel(modelsPayload?.resolved.intake_extraction?.source)})
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-stroke bg-panel p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Catalog Editor</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Update names, enabled choices, pricing, and tier values. Save each row after editing.
        </p>
        {!modelsPayload || modelsPayload.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No catalog models found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-stroke text-left text-xs uppercase text-muted-foreground">
                  <th className="px-2 py-2">Provider</th>
                  <th className="px-2 py-2">Model ID</th>
                  <th className="px-2 py-2">Display name</th>
                  <th className="px-2 py-2">Enabled</th>
                  <th className="px-2 py-2">Input $/1M</th>
                  <th className="px-2 py-2">Output $/1M</th>
                  <th className="px-2 py-2">Tier</th>
                  <th className="px-2 py-2">Placeholder</th>
                  <th className="px-2 py-2">Sort</th>
                  <th className="px-2 py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {modelsPayload.models.map((model) => {
                  const draft = catalogDrafts[model.id] ?? toCatalogDraft(model);
                  const isSaving = savingCatalogModelId === model.id;
                  return (
                    <tr key={model.id} className="border-b border-stroke/70">
                      <td className="px-2 py-2 text-foreground">{model.provider}</td>
                      <td className="px-2 py-2 text-foreground">{model.model_id}</td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={draft.displayName}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, { displayName: event.target.value })
                          }
                          disabled={isSaving}
                          className="w-56 rounded border border-stroke bg-panel-muted px-2 py-1 text-xs text-foreground"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, { enabled: event.target.checked })
                          }
                          disabled={isSaving}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={draft.inputPricePer1mUsd}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, {
                              inputPricePer1mUsd: event.target.value,
                            })
                          }
                          disabled={isSaving}
                          placeholder="null"
                          className="w-24 rounded border border-stroke bg-panel-muted px-2 py-1 text-xs text-foreground"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={draft.outputPricePer1mUsd}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, {
                              outputPricePer1mUsd: event.target.value,
                            })
                          }
                          disabled={isSaving}
                          placeholder="null"
                          className="w-24 rounded border border-stroke bg-panel-muted px-2 py-1 text-xs text-foreground"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={draft.pricingTier}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, {
                              pricingTier: event.target.value as CatalogModelDraft["pricingTier"],
                            })
                          }
                          disabled={isSaving}
                          className="rounded border border-stroke bg-panel-muted px-2 py-1 text-xs text-foreground"
                        >
                          <option value="">None</option>
                          <option value="standard">Standard</option>
                          <option value="flex">Flex</option>
                          <option value="priority">Priority</option>
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={draft.pricingIsPlaceholder}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, {
                              pricingIsPlaceholder: event.target.checked,
                            })
                          }
                          disabled={isSaving}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={draft.sortOrder}
                          onChange={(event) =>
                            updateCatalogDraft(model.id, {
                              sortOrder: event.target.value,
                            })
                          }
                          disabled={isSaving}
                          className="w-16 rounded border border-stroke bg-panel-muted px-2 py-1 text-xs text-foreground"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <button
                          onClick={() => void saveCatalogModel(model.id)}
                          disabled={isSaving}
                          className="rounded border border-stroke px-2 py-1 text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {isSaving ? "Saving..." : "Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid gap-3 rounded-lg border border-stroke bg-panel p-4 md:grid-cols-4">
        <div>
          <p className="text-xs uppercase text-muted-foreground">From</p>
          <input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
            className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
          />
        </div>
        <div>
          <p className="text-xs uppercase text-muted-foreground">To</p>
          <input
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
          />
        </div>
        <div>
          <p className="text-xs uppercase text-muted-foreground">Feature</p>
          <select
            value={feature}
            onChange={(event) => setFeature(event.target.value as UsageFeatureFilter)}
            className="mt-1 w-full rounded border border-stroke bg-panel-muted px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="briefing_narrative">Briefing narrative</option>
            <option value="intake_extraction">Intake extraction</option>
          </select>
        </div>
        <div>
          <p className="text-xs uppercase text-muted-foreground">OpenAI pricing tier</p>
          <p className="mt-2 text-sm font-medium text-foreground">Standard (estimates)</p>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-stroke bg-panel p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Model Summary</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : !usagePayload || usagePayload.summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage events in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-stroke text-left text-xs uppercase text-muted-foreground">
                  <th className="px-2 py-2">Provider</th>
                  <th className="px-2 py-2">Model</th>
                  <th className="px-2 py-2">Calls</th>
                  <th className="px-2 py-2">Success</th>
                  <th className="px-2 py-2">Avg Latency</th>
                  <th className="px-2 py-2">Input Tokens</th>
                  <th className="px-2 py-2">Output Tokens</th>
                  <th className="px-2 py-2">Est Cost</th>
                  <th className="px-2 py-2">Pricing</th>
                </tr>
              </thead>
              <tbody>
                {usagePayload.summary.map((row) => (
                  <tr key={`${row.provider}:${row.modelId}`} className="border-b border-stroke/70">
                    <td className="px-2 py-2 text-foreground">{row.provider}</td>
                    <td className="px-2 py-2 text-foreground">{row.modelId}</td>
                    <td className="px-2 py-2">{row.callCount}</td>
                    <td className="px-2 py-2">{row.successRate}%</td>
                    <td className="px-2 py-2">{row.avgLatencyMs} ms</td>
                    <td className="px-2 py-2">{row.totalInputTokens.toLocaleString()}</td>
                    <td className="px-2 py-2">{row.totalOutputTokens.toLocaleString()}</td>
                    <td className="px-2 py-2">{formatCurrency(row.totalEstimatedCostUsd)}</td>
                    <td className="px-2 py-2">{row.pricingIsPlaceholder ? "Placeholder" : "Configured"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-stroke bg-panel p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Recent Events</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : !usagePayload || usagePayload.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events in this range.</p>
        ) : (
          <div className="max-h-[480px] overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-stroke text-left text-xs uppercase text-muted-foreground">
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">Feature</th>
                  <th className="px-2 py-2">Provider</th>
                  <th className="px-2 py-2">Model</th>
                  <th className="px-2 py-2">Source</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Latency</th>
                  <th className="px-2 py-2">Tokens</th>
                  <th className="px-2 py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usagePayload.events.map((event) => (
                  <tr key={event.id} className="border-b border-stroke/70">
                    <td className="px-2 py-2">{formatTimestamp(event.createdAt)}</td>
                    <td className="px-2 py-2">{event.feature}</td>
                    <td className="px-2 py-2">{event.provider ?? "n/a"}</td>
                    <td className="px-2 py-2">{event.modelId ?? "n/a"}</td>
                    <td className="px-2 py-2">{sourceLabel(event.modelSource)}</td>
                    <td className="px-2 py-2">
                      {event.status}
                      {event.cacheStatus ? ` (${event.cacheStatus})` : ""}
                    </td>
                    <td className="px-2 py-2">{event.latencyMs} ms</td>
                    <td className="px-2 py-2">
                      {(event.inputTokens || 0).toLocaleString()} / {(event.outputTokens || 0).toLocaleString()}
                    </td>
                    <td className="px-2 py-2">
                      {formatCurrency(event.estimatedCostUsd)}
                      {event.pricingTier ? ` (${event.pricingTier})` : ""}
                      {event.pricingIsPlaceholder ? "*" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
