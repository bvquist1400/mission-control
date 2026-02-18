interface PricingShape {
  input_price_per_1m_usd: number | null;
  output_price_per_1m_usd: number | null;
}

export function calculateEstimatedCostUsd(
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: PricingShape
): number | null {
  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  if (pricing.input_price_per_1m_usd === null || pricing.output_price_per_1m_usd === null) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input_price_per_1m_usd;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_price_per_1m_usd;
  return Number((inputCost + outputCost).toFixed(8));
}
