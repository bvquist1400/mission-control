import type { SupabaseClient } from "@supabase/supabase-js";

export type LlmProvider = "openai" | "anthropic";
export type LlmFeature = "briefing_narrative" | "intake_extraction" | "quick_capture";
export type LlmPreferenceFeature = LlmFeature | "global_default";
export type LlmPricingTier = "standard" | "flex" | "priority";
export type LlmStatus = "success" | "error" | "timeout" | "cache_hit" | "skipped_unconfigured";

export interface LlmModelCatalogRow {
  id: string;
  provider: LlmProvider;
  model_id: string;
  display_name: string;
  input_price_per_1m_usd: number | null;
  output_price_per_1m_usd: number | null;
  pricing_tier: LlmPricingTier | null;
  enabled: boolean;
  pricing_is_placeholder: boolean;
  sort_order: number;
}

export interface ResolvedLlmModel extends LlmModelCatalogRow {
  source: "feature_override" | "global_default" | "default";
}

export interface LlmPreferenceSelection {
  feature: LlmPreferenceFeature;
  modelId: string | null;
}

export interface LlmRunMeta {
  provider: LlmProvider;
  modelId: string;
  source: ResolvedLlmModel["source"];
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  pricingIsPlaceholder: boolean;
  pricingTier: LlmPricingTier | null;
  status: LlmStatus;
  cacheStatus?: "hit" | "miss";
}

export interface LlmProviderMessage {
  role: "user";
  content: string;
}

export interface GenerateLlmTextParams {
  supabase: SupabaseClient;
  userId: string;
  feature: LlmFeature;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  requestFingerprint?: string;
}

export interface GenerateLlmTextResult {
  text: string | null;
  runMeta: LlmRunMeta | null;
}

export interface LlmUsageEventInput {
  userId: string;
  feature: LlmFeature;
  provider: LlmProvider | null;
  modelId: string | null;
  modelCatalogId: string | null;
  modelSource?: ResolvedLlmModel["source"] | null;
  status: LlmStatus;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  pricingIsPlaceholder: boolean | null;
  pricingTier: LlmPricingTier | null;
  cacheStatus?: "hit" | "miss";
  errorCode?: string | null;
  errorMessage?: string | null;
  requestFingerprint?: string | null;
}
