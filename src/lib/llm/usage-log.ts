import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmUsageEventInput } from "./types";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
let lastPruneAttemptMs = 0;

async function maybePruneUsageEvents(supabase: SupabaseClient): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastPruneAttemptMs < ONE_DAY_MS) {
    return;
  }

  lastPruneAttemptMs = nowMs;
  const { error } = await supabase.rpc("prune_llm_usage_events");
  if (error) {
    // Best effort only - never block request flow.
    console.error("Failed to prune llm_usage_events:", error);
  }
}

export async function recordLlmUsageEvent(
  supabase: SupabaseClient,
  event: LlmUsageEventInput
): Promise<void> {
  await maybePruneUsageEvents(supabase);

  const { error } = await supabase.from("llm_usage_events").insert({
    user_id: event.userId,
    feature: event.feature,
    provider: event.provider,
    model_id: event.modelId,
    model_catalog_id: event.modelCatalogId,
    model_source: event.modelSource ?? null,
    status: event.status,
    latency_ms: Math.max(0, Math.round(event.latencyMs)),
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    estimated_cost_usd: event.estimatedCostUsd,
    pricing_is_placeholder: event.pricingIsPlaceholder,
    pricing_tier: event.pricingTier,
    cache_status: event.cacheStatus ?? null,
    error_code: event.errorCode ?? null,
    error_message: event.errorMessage ?? null,
    request_fingerprint: event.requestFingerprint ?? null,
  });

  if (error) {
    // Logging should not break product flow.
    console.error("Failed to insert llm_usage_event:", error);
  }
}
