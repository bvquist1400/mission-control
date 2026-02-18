import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LlmFeature,
  LlmModelCatalogRow,
  LlmPreferenceFeature,
  LlmPreferenceSelection,
  LlmPricingTier,
  ResolvedLlmModel,
} from "./types";

export const LLM_PREFERENCE_FEATURES: LlmPreferenceFeature[] = [
  "global_default",
  "briefing_narrative",
  "intake_extraction",
];

interface LlmModelCatalogDbRow {
  id: string;
  provider: string;
  model_id: string;
  display_name: string;
  input_price_per_1m_usd: number | string | null;
  output_price_per_1m_usd: number | string | null;
  pricing_tier: string | null;
  enabled: boolean;
  pricing_is_placeholder: boolean;
  sort_order: number;
}

interface LlmUserPreferencesDbRow {
  feature: LlmPreferenceFeature;
  active_model_id: string | null;
}

function toNullableNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPricingTier(value: string | null): LlmPricingTier | null {
  if (value === "standard" || value === "flex" || value === "priority") {
    return value;
  }
  return null;
}

function toCatalogRow(row: LlmModelCatalogDbRow): LlmModelCatalogRow {
  return {
    id: row.id,
    provider: row.provider === "anthropic" ? "anthropic" : "openai",
    model_id: row.model_id,
    display_name: row.display_name,
    input_price_per_1m_usd: toNullableNumber(row.input_price_per_1m_usd),
    output_price_per_1m_usd: toNullableNumber(row.output_price_per_1m_usd),
    pricing_tier: toPricingTier(row.pricing_tier),
    enabled: Boolean(row.enabled),
    pricing_is_placeholder: Boolean(row.pricing_is_placeholder),
    sort_order: row.sort_order,
  };
}

export async function listAllModels(supabase: SupabaseClient): Promise<LlmModelCatalogRow[]> {
  const { data, error } = await supabase
    .from("llm_model_catalog")
    .select(
      "id, provider, model_id, display_name, input_price_per_1m_usd, output_price_per_1m_usd, pricing_tier, enabled, pricing_is_placeholder, sort_order"
    )
    .order("sort_order", { ascending: true })
    .order("display_name", { ascending: true });

  if (error) {
    console.error("Failed to list llm_model_catalog:", error);
    return [];
  }

  return ((data || []) as LlmModelCatalogDbRow[]).map(toCatalogRow);
}

export async function listEnabledModels(supabase: SupabaseClient): Promise<LlmModelCatalogRow[]> {
  const rows = await listAllModels(supabase);
  return rows.filter((row) => row.enabled);
}

export async function getModelById(
  supabase: SupabaseClient,
  modelId: string
): Promise<LlmModelCatalogRow | null> {
  const { data, error } = await supabase
    .from("llm_model_catalog")
    .select(
      "id, provider, model_id, display_name, input_price_per_1m_usd, output_price_per_1m_usd, pricing_tier, enabled, pricing_is_placeholder, sort_order"
    )
    .eq("id", modelId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return toCatalogRow(data as LlmModelCatalogDbRow);
}

export async function listUserModelPreferences(
  supabase: SupabaseClient,
  userId: string
): Promise<LlmPreferenceSelection[]> {
  const { data, error } = await supabase
    .from("llm_user_preferences")
    .select("feature, active_model_id")
    .eq("user_id", userId)
    .in("feature", LLM_PREFERENCE_FEATURES);

  if (error) {
    console.error("Failed to fetch llm_user_preferences:", error);
    return [];
  }

  return ((data || []) as LlmUserPreferencesDbRow[]).map((row) => ({
    feature: row.feature,
    modelId: row.active_model_id,
  }));
}

export function preferenceListToMap(
  preferences: LlmPreferenceSelection[]
): Record<LlmPreferenceFeature, string | null> {
  const map: Record<LlmPreferenceFeature, string | null> = {
    global_default: null,
    briefing_narrative: null,
    intake_extraction: null,
  };

  for (const preference of preferences) {
    map[preference.feature] = preference.modelId;
  }

  return map;
}

export async function resolveModelForFeature(
  supabase: SupabaseClient,
  userId: string,
  feature: LlmFeature
): Promise<ResolvedLlmModel | null> {
  const preferences = preferenceListToMap(await listUserModelPreferences(supabase, userId));

  const featureModelId = preferences[feature];
  if (featureModelId) {
    const model = await getModelById(supabase, featureModelId);
    if (model && model.enabled) {
      return { ...model, source: "feature_override" };
    }
  }

  const globalDefaultModelId = preferences.global_default;
  if (globalDefaultModelId) {
    const model = await getModelById(supabase, globalDefaultModelId);
    if (model && model.enabled) {
      return { ...model, source: "global_default" };
    }
  }

  return null;
}

export async function getUserActiveModel(
  supabase: SupabaseClient,
  userId: string,
  feature: LlmFeature = "briefing_narrative"
): Promise<LlmModelCatalogRow | null> {
  const resolved = await resolveModelForFeature(supabase, userId, feature);
  return resolved ? { ...resolved } : null;
}

export async function setUserActiveModel(
  supabase: SupabaseClient,
  userId: string,
  modelId: string | null,
  feature: LlmPreferenceFeature = "global_default"
): Promise<boolean> {
  if (modelId === null) {
    const { error: deleteError } = await supabase
      .from("llm_user_preferences")
      .delete()
      .eq("user_id", userId)
      .eq("feature", feature);

    if (deleteError) {
      console.error("Failed to clear active LLM model preference:", deleteError);
      return false;
    }

    return true;
  }

  const { error } = await supabase.from("llm_user_preferences").upsert(
    {
      user_id: userId,
      feature,
      active_model_id: modelId,
    },
    {
      onConflict: "user_id,feature",
    }
  );

  if (error) {
    console.error("Failed to set active LLM model preference:", error);
    return false;
  }

  return true;
}
