"use client";

import type { LlmRunMeta } from "@/lib/llm";

interface BriefingNarrativeProps {
  narrative: string;
  llm: LlmRunMeta | null;
  loading: boolean;
}

function formatCost(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `$${value.toFixed(6)}`;
}

function formatTokens(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value.toLocaleString();
}

export function BriefingNarrative({ narrative, llm, loading }: BriefingNarrativeProps) {
  if (loading) {
    return (
      <div className="mb-4 animate-pulse rounded-lg border border-stroke bg-panel-muted p-4">
        <div className="h-4 w-full rounded bg-panel/70" />
        <div className="mt-2 h-4 w-5/6 rounded bg-panel/70" />
        <div className="mt-2 h-3 w-2/3 rounded bg-panel/70" />
      </div>
    );
  }

  if (!narrative) {
    return (
      <div className="mb-4 rounded-lg border border-stroke bg-panel-muted/40 p-4">
        <p className="text-sm text-muted-foreground">
          Narrative summary is unavailable right now. The deterministic briefing details are still shown below.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-accent/25 bg-accent/5 p-4">
      <p className="text-sm leading-relaxed text-foreground">{narrative}</p>

      {llm && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Provider: {llm.provider}</span>
          <span>Model: {llm.modelId}</span>
          <span>Source: {llm.source.replace("_", " ")}</span>
          <span>Status: {llm.status}</span>
          <span>Cache: {llm.cacheStatus ?? "miss"}</span>
          <span>Latency: {llm.latencyMs} ms</span>
          <span>Input: {formatTokens(llm.inputTokens)}</span>
          <span>Output: {formatTokens(llm.outputTokens)}</span>
          <span>Cost: {formatCost(llm.estimatedCostUsd)}</span>
          {llm.pricingTier && <span>Tier: {llm.pricingTier}</span>}
          {llm.pricingIsPlaceholder && <span>Pricing: placeholder</span>}
        </div>
      )}
    </div>
  );
}
