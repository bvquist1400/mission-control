import { createHash } from "crypto";
import { resolveModelForFeature } from "./catalog";
import { calculateEstimatedCostUsd } from "./pricing";
import { recordLlmUsageEvent } from "./usage-log";
import type {
  GenerateLlmTextParams,
  GenerateLlmTextResult,
  LlmFeature,
  LlmProvider,
  ResolvedLlmModel,
} from "./types";

interface ProviderInvokeResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

const DEFAULT_MODEL_CANDIDATES: Record<LlmFeature, ResolvedLlmModel[]> = {
  briefing_narrative: [
    {
      id: "default-anthropic-claude-3-haiku-20240307",
      provider: "anthropic",
      model_id: "claude-3-haiku-20240307",
      display_name: "Anthropic Claude 3 Haiku (Default)",
      input_price_per_1m_usd: null,
      output_price_per_1m_usd: null,
      pricing_tier: null,
      enabled: true,
      pricing_is_placeholder: true,
      sort_order: 0,
      source: "default",
    },
    {
      id: "default-openai-gpt-4o-mini",
      provider: "openai",
      model_id: "gpt-4o-mini",
      display_name: "OpenAI GPT-4o mini (Default)",
      input_price_per_1m_usd: null,
      output_price_per_1m_usd: null,
      pricing_tier: "standard",
      enabled: true,
      pricing_is_placeholder: true,
      sort_order: 1,
      source: "default",
    },
  ],
  intake_extraction: [
    {
      id: "default-openai-gpt-4o-mini",
      provider: "openai",
      model_id: "gpt-4o-mini",
      display_name: "OpenAI GPT-4o mini (Default)",
      input_price_per_1m_usd: null,
      output_price_per_1m_usd: null,
      pricing_tier: "standard",
      enabled: true,
      pricing_is_placeholder: true,
      sort_order: 0,
      source: "default",
    },
    {
      id: "default-anthropic-claude-3-haiku-20240307",
      provider: "anthropic",
      model_id: "claude-3-haiku-20240307",
      display_name: "Anthropic Claude 3 Haiku (Default)",
      input_price_per_1m_usd: null,
      output_price_per_1m_usd: null,
      pricing_tier: null,
      enabled: true,
      pricing_is_placeholder: true,
      sort_order: 1,
      source: "default",
    },
  ],
};

function getProviderApiKey(provider: LlmProvider): string | null {
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? null;
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

function buildRequestFingerprint(feature: LlmFeature, systemPrompt: string, userPrompt: string): string {
  return createHash("sha256").update(`${feature}\n${systemPrompt}\n${userPrompt}`).digest("hex");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "Unknown LLM error";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message.toLowerCase().includes("timeout");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampTemperature(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampMaxTokens(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(32, Math.min(4000, Math.round(value)));
}

async function invokeOpenAI(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number
): Promise<ProviderInvokeResult> {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${body.slice(0, 280)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";

    if (!text.trim()) {
      throw new Error("OpenAI response did not include text content");
    }

    return {
      text: normalizeText(text),
      inputTokens: typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
      outputTokens: typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null,
      latencyMs: Date.now() - startedAtMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeAnthropic(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  timeoutMs: number
): Promise<ProviderInvokeResult> {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${body.slice(0, 280)}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (data.content || [])
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n");

    if (!text.trim()) {
      throw new Error("Anthropic response did not include text content");
    }

    return {
      text: normalizeText(text),
      inputTokens: typeof data.usage?.input_tokens === "number" ? data.usage.input_tokens : null,
      outputTokens: typeof data.usage?.output_tokens === "number" ? data.usage.output_tokens : null,
      latencyMs: Date.now() - startedAtMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeProviderModel(
  provider: LlmProvider,
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number
): Promise<ProviderInvokeResult> {
  if (provider === "openai") {
    return invokeOpenAI(apiKey, modelId, systemPrompt, userPrompt, temperature, maxTokens, timeoutMs);
  }
  return invokeAnthropic(apiKey, modelId, systemPrompt, userPrompt, maxTokens, timeoutMs);
}

async function resolveCandidateModels(
  supabase: GenerateLlmTextParams["supabase"],
  userId: string,
  feature: LlmFeature
): Promise<ResolvedLlmModel[]> {
  const activeModel = await resolveModelForFeature(supabase, userId, feature);
  if (activeModel) {
    return [
      activeModel,
      ...DEFAULT_MODEL_CANDIDATES[feature].filter(
        (candidate) =>
          !(
            candidate.provider === activeModel.provider &&
            candidate.model_id === activeModel.model_id
          )
      ),
    ];
  }
  return DEFAULT_MODEL_CANDIDATES[feature];
}

export async function generateTextWithLlm(params: GenerateLlmTextParams): Promise<GenerateLlmTextResult> {
  const systemPrompt = params.systemPrompt ?? "";
  const temperature = clampTemperature(params.temperature, 0.2);
  const maxTokens = clampMaxTokens(params.maxTokens, 256);
  const timeoutMs = Math.max(500, Math.min(30000, Math.round(params.timeoutMs ?? 4500)));
  const requestFingerprint =
    params.requestFingerprint ?? buildRequestFingerprint(params.feature, systemPrompt, params.userPrompt);

  const candidates = await resolveCandidateModels(params.supabase, params.userId, params.feature);

  for (const candidate of candidates) {
    const providerApiKey = getProviderApiKey(candidate.provider);
    if (!providerApiKey) {
      await recordLlmUsageEvent(params.supabase, {
        userId: params.userId,
        feature: params.feature,
        provider: candidate.provider,
        modelId: candidate.model_id,
        modelCatalogId: candidate.source === "default" ? null : candidate.id,
        modelSource: candidate.source,
        status: "skipped_unconfigured",
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        pricingIsPlaceholder: candidate.pricing_is_placeholder,
        pricingTier: candidate.pricing_tier,
        requestFingerprint,
      });
      continue;
    }

    const startedAtMs = Date.now();
    try {
      const result = await invokeProviderModel(
        candidate.provider,
        providerApiKey,
        candidate.model_id,
        systemPrompt,
        params.userPrompt,
        temperature,
        maxTokens,
        timeoutMs
      );

      const estimatedCostUsd = calculateEstimatedCostUsd(
        result.inputTokens,
        result.outputTokens,
        {
          input_price_per_1m_usd: candidate.input_price_per_1m_usd,
          output_price_per_1m_usd: candidate.output_price_per_1m_usd,
        }
      );

      await recordLlmUsageEvent(params.supabase, {
        userId: params.userId,
        feature: params.feature,
        provider: candidate.provider,
        modelId: candidate.model_id,
        modelCatalogId: candidate.source === "default" ? null : candidate.id,
        modelSource: candidate.source,
        status: "success",
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd,
        pricingIsPlaceholder: candidate.pricing_is_placeholder,
        pricingTier: candidate.pricing_tier,
        cacheStatus: "miss",
        requestFingerprint,
      });

      return {
        text: result.text,
        runMeta: {
          provider: candidate.provider,
          modelId: candidate.model_id,
          source: candidate.source,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostUsd,
          latencyMs: result.latencyMs,
          pricingIsPlaceholder: candidate.pricing_is_placeholder,
          pricingTier: candidate.pricing_tier,
          status: "success",
          cacheStatus: "miss",
        },
      };
    } catch (error) {
      const status = isTimeoutError(error) ? "timeout" : "error";
      await recordLlmUsageEvent(params.supabase, {
        userId: params.userId,
        feature: params.feature,
        provider: candidate.provider,
        modelId: candidate.model_id,
        modelCatalogId: candidate.source === "default" ? null : candidate.id,
        modelSource: candidate.source,
        status,
        latencyMs: Date.now() - startedAtMs,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        pricingIsPlaceholder: candidate.pricing_is_placeholder,
        pricingTier: candidate.pricing_tier,
        errorCode: status,
        errorMessage: toErrorMessage(error),
        requestFingerprint,
      });

      // Continue through fallback candidates so features remain usable when a preferred model errors.
    }
  }

  return { text: null, runMeta: null };
}
