import type {
  WorkIntelligenceConfidence,
  WorkIntelligenceFreshness,
  WorkIntelligenceFreshnessSource,
  WorkIntelligenceMetadata,
  WorkIntelligenceSupportingSignal,
} from "./types";

export interface WorkIntelligenceFreshnessSourceInput {
  source: string;
  label?: string;
  latestAt?: string | null;
  staleAfterHours?: number;
  required?: boolean;
  allowMissing?: boolean;
  note?: string | null;
}

export interface BuildCanonicalMetadataInput<TRawSignals = Record<string, unknown>> {
  generatedAt: string;
  freshnessSources: Array<WorkIntelligenceFreshnessSource | WorkIntelligenceFreshnessSourceInput>;
  caveats?: Array<string | null | undefined>;
  supportingSignals?: WorkIntelligenceSupportingSignal[];
  includeRawSignals?: boolean;
  rawSignals?: TRawSignals;
  confidence?: WorkIntelligenceConfidence;
}

function safeIso(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}

export function buildFreshnessSource(
  generatedAt: string,
  input: WorkIntelligenceFreshnessSourceInput
): WorkIntelligenceFreshnessSource {
  const latestAt = safeIso(input.latestAt);
  const generatedMs = Date.parse(generatedAt);
  const latestMs = latestAt ? Date.parse(latestAt) : Number.NaN;
  const ageHours =
    latestAt && Number.isFinite(generatedMs) && Number.isFinite(latestMs)
      ? Math.max(0, Math.round((((generatedMs - latestMs) / (60 * 60 * 1000)) * 10)) / 10)
      : null;
  const required = Boolean(input.required);
  const missing = latestAt === null ? !Boolean(input.allowMissing) : false;
  const staleAfterHours = Math.max(0, input.staleAfterHours ?? 72);
  const stale = latestAt !== null ? Boolean(ageHours !== null && ageHours > staleAfterHours) : missing && required;

  return {
    source: input.source,
    label: input.label,
    latestAt,
    ageHours,
    stale,
    missing,
    required,
    note: input.note ?? null,
  };
}

export function buildFreshness(
  generatedAt: string,
  sources: Array<WorkIntelligenceFreshnessSource | WorkIntelligenceFreshnessSourceInput>
): WorkIntelligenceFreshness {
  const normalizedSources = sources.map((source) =>
    "ageHours" in source ? source : buildFreshnessSource(generatedAt, source)
  );

  const hasRequiredGap = normalizedSources.some((source) => source.required && (source.missing || source.stale));
  const hasAnyGap = normalizedSources.some((source) => source.missing || source.stale);

  return {
    evaluatedAt: generatedAt,
    overall: hasRequiredGap ? "stale" : hasAnyGap ? "mixed" : "fresh",
    sources: normalizedSources,
  };
}

export function deriveMetadataConfidence(
  freshness: WorkIntelligenceFreshness,
  caveats: string[],
  explicitConfidence?: WorkIntelligenceConfidence
): WorkIntelligenceConfidence {
  if (explicitConfidence) {
    return explicitConfidence;
  }

  const requiredGap = freshness.sources.some((source) => source.required && (source.missing || source.stale));
  if (requiredGap) {
    return "low";
  }

  if (freshness.sources.some((source) => source.missing || source.stale) || caveats.length > 0) {
    return caveats.length >= 2 ? "low" : "medium";
  }

  return "high";
}

export function buildCanonicalMetadata<TRawSignals = Record<string, unknown>>(
  input: BuildCanonicalMetadataInput<TRawSignals>
): WorkIntelligenceMetadata<TRawSignals> {
  const freshness = buildFreshness(input.generatedAt, input.freshnessSources);
  const caveats = uniqueStrings(input.caveats ?? []);
  const supportingSignals = (input.supportingSignals ?? []).filter((signal) => {
    const summary = signal.summary.trim();
    return summary.length > 0;
  });

  const metadata: WorkIntelligenceMetadata<TRawSignals> = {
    confidence: deriveMetadataConfidence(freshness, caveats, input.confidence),
    freshness,
    caveats,
    supportingSignals,
    generatedAt: input.generatedAt,
  };

  if (input.includeRawSignals && input.rawSignals) {
    metadata.rawSignals = input.rawSignals;
  }

  return metadata;
}
