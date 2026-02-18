import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import type { LlmFeature, LlmStatus } from "@/lib/llm";

type UsageFeatureFilter = LlmFeature | "all";

interface UsageEventRow {
  id: string;
  feature: LlmFeature;
  provider: "openai" | "anthropic" | null;
  model_id: string | null;
  model_source: "feature_override" | "global_default" | "default" | null;
  status: LlmStatus;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | string | null;
  pricing_is_placeholder: boolean | null;
  pricing_tier: "standard" | "flex" | "priority" | null;
  cache_status: "hit" | "miss" | null;
  created_at: string;
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

function toNumeric(value: number | string | null): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function addDaysIso(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const { supabase, userId } = auth.context;
  const { searchParams } = new URL(request.url);

  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFromDate = new Date(now);
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 29);
  const defaultFrom = defaultFromDate.toISOString().slice(0, 10);

  const from = searchParams.get("from") || defaultFrom;
  const to = searchParams.get("to") || defaultTo;
  const featureRaw = searchParams.get("feature") || "all";
  const featureFilter: UsageFeatureFilter =
    featureRaw === "briefing_narrative" || featureRaw === "intake_extraction" ? featureRaw : "all";

  if (!isValidDateOnly(from) || !isValidDateOnly(to)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD." }, { status: 400 });
  }

  if (from > to) {
    return NextResponse.json({ error: "from must be before or equal to to" }, { status: 400 });
  }

  const toExclusive = addDaysIso(to, 1);

  let query = supabase
    .from("llm_usage_events")
    .select(
      "id, feature, provider, model_id, model_source, status, latency_ms, input_tokens, output_tokens, estimated_cost_usd, pricing_is_placeholder, pricing_tier, cache_status, created_at"
    )
    .eq("user_id", userId)
    .gte("created_at", `${from}T00:00:00.000Z`)
    .lt("created_at", `${toExclusive}T00:00:00.000Z`)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (featureFilter !== "all") {
    query = query.eq("feature", featureFilter);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: "Failed to fetch usage events" }, { status: 500 });
  }

  const events = (data || []) as UsageEventRow[];
  const summaryMap = new Map<
    string,
    {
      provider: string;
      modelId: string;
      feature: UsageFeatureFilter | "mixed";
      callCount: number;
      successCount: number;
      latencyTotal: number;
      latencyCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalEstimatedCostUsd: number;
      pricingIsPlaceholder: boolean;
    }
  >();

  for (const event of events) {
    const provider = event.provider || "unknown";
    const modelId = event.model_id || "unknown";
    const key = `${provider}::${modelId}`;
    const existing = summaryMap.get(key) || {
      provider,
      modelId,
      feature: featureFilter,
      callCount: 0,
      successCount: 0,
      latencyTotal: 0,
      latencyCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
      pricingIsPlaceholder: false,
    };

    existing.callCount += 1;
    if (event.status === "success" || event.status === "cache_hit") {
      existing.successCount += 1;
    }

    existing.latencyTotal += Math.max(0, Math.round(event.latency_ms || 0));
    existing.latencyCount += 1;
    existing.totalInputTokens += Math.max(0, Math.round(event.input_tokens || 0));
    existing.totalOutputTokens += Math.max(0, Math.round(event.output_tokens || 0));
    existing.totalEstimatedCostUsd += toNumeric(event.estimated_cost_usd);
    existing.pricingIsPlaceholder = existing.pricingIsPlaceholder || event.pricing_is_placeholder === true;

    summaryMap.set(key, existing);
  }

  const summary = [...summaryMap.values()]
    .map((item) => ({
      provider: item.provider,
      modelId: item.modelId,
      callCount: item.callCount,
      successRate: item.callCount > 0 ? Number(((item.successCount / item.callCount) * 100).toFixed(1)) : 0,
      avgLatencyMs: item.latencyCount > 0 ? Math.round(item.latencyTotal / item.latencyCount) : 0,
      totalInputTokens: item.totalInputTokens,
      totalOutputTokens: item.totalOutputTokens,
      totalEstimatedCostUsd: Number(item.totalEstimatedCostUsd.toFixed(8)),
      pricingIsPlaceholder: item.pricingIsPlaceholder,
    }))
    .sort((left, right) => right.callCount - left.callCount);

  return NextResponse.json({
    from,
    to,
    feature: featureFilter,
    summary,
    events: events.slice(0, 200).map((event) => ({
      id: event.id,
      createdAt: event.created_at,
      feature: event.feature,
      provider: event.provider,
      modelId: event.model_id,
      modelSource: event.model_source,
      status: event.status,
      cacheStatus: event.cache_status,
      latencyMs: event.latency_ms,
      inputTokens: event.input_tokens,
      outputTokens: event.output_tokens,
      estimatedCostUsd: toNumeric(event.estimated_cost_usd),
      pricingIsPlaceholder: event.pricing_is_placeholder === true,
      pricingTier: event.pricing_tier,
    })),
  });
}
