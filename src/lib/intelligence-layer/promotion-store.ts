import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  IntelligenceArtifactBundle,
  IntelligencePromotionStore,
  PersistedIntelligenceArtifact,
  PersistedIntelligenceArtifactContractLink,
  PersistedIntelligenceArtifactFamilyCoverage,
  PersistedIntelligenceArtifactStatusTransition,
  PersistedIntelligenceContractSnapshot,
  PersistedIntelligencePromotionEvent,
} from "./phase2-types";

const ACTIVE_ARTIFACT_STATUSES = ["open", "accepted"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeContractSnapshotRow(row: Record<string, unknown>): PersistedIntelligenceContractSnapshot {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    contractType: String(row.contract_type) as PersistedIntelligenceContractSnapshot["contractType"],
    canonicalSubjectKey: String(row.canonical_subject_key),
    promotionFamilyKey: String(row.promotion_family_key),
    detectedAt: String(row.detected_at),
    summary: String(row.summary),
    reason: String(row.reason),
    severity: String(row.severity) as PersistedIntelligenceContractSnapshot["severity"],
    confidence: String(row.confidence) as PersistedIntelligenceContractSnapshot["confidence"],
    subjectPayload: asRecord(row.subject_payload),
    metricsPayload: asRecord(row.metrics_payload),
    evidencePayload: Array.isArray(row.evidence_payload)
      ? (row.evidence_payload as PersistedIntelligenceContractSnapshot["evidencePayload"])
      : [],
    provenancePayload: asRecord(row.provenance_payload),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  };
}

function normalizeArtifactRow(row: Record<string, unknown>): PersistedIntelligenceArtifact {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactKind: String(row.artifact_kind) as PersistedIntelligenceArtifact["artifactKind"],
    groupingKey: typeof row.grouping_key === "string" ? row.grouping_key : null,
    subjectKey: String(row.subject_key),
    primaryContractType: String(row.primary_contract_type) as PersistedIntelligenceArtifact["primaryContractType"],
    status: String(row.status) as PersistedIntelligenceArtifact["status"],
    summary: String(row.summary),
    reason: String(row.reason),
    severity: String(row.severity) as PersistedIntelligenceArtifact["severity"],
    confidence: String(row.confidence) as PersistedIntelligenceArtifact["confidence"],
    availableActions: Array.isArray(row.available_actions)
      ? (row.available_actions as PersistedIntelligenceArtifact["availableActions"])
      : [],
    artifactEvidence: Array.isArray(row.artifact_evidence)
      ? (row.artifact_evidence as PersistedIntelligenceArtifact["artifactEvidence"])
      : [],
    reviewPayload: asRecord(row.review_payload),
    contentHash: String(row.content_hash),
    lastEvaluatedAt: String(row.last_evaluated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeCoverageRow(row: Record<string, unknown>): PersistedIntelligenceArtifactFamilyCoverage {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactId: String(row.artifact_id),
    promotionFamilyKey: String(row.promotion_family_key),
    contractType: String(row.contract_type) as PersistedIntelligenceArtifactFamilyCoverage["contractType"],
    canonicalSubjectKey: String(row.canonical_subject_key),
    subjectKey: String(row.subject_key),
    isPrimary: Boolean(row.is_primary),
    createdAt: String(row.created_at),
  };
}

function normalizeContractLinkRow(row: Record<string, unknown>): PersistedIntelligenceArtifactContractLink {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactId: String(row.artifact_id),
    contractSnapshotId: String(row.contract_snapshot_id),
    promotionFamilyKey: String(row.promotion_family_key),
    contractType: String(row.contract_type) as PersistedIntelligenceArtifactContractLink["contractType"],
    linkRole: String(row.link_role) as PersistedIntelligenceArtifactContractLink["linkRole"],
    createdAt: String(row.created_at),
  };
}

function normalizeStatusTransitionRow(row: Record<string, unknown>): PersistedIntelligenceArtifactStatusTransition {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    artifactId: String(row.artifact_id),
    fromStatus: typeof row.from_status === "string"
      ? (row.from_status as PersistedIntelligenceArtifactStatusTransition["fromStatus"])
      : null,
    toStatus: String(row.to_status) as PersistedIntelligenceArtifactStatusTransition["toStatus"],
    triggeredBy: String(row.triggered_by) as PersistedIntelligenceArtifactStatusTransition["triggeredBy"],
    note: typeof row.note === "string" ? row.note : null,
    payload: asRecord(row.payload),
    createdAt: String(row.created_at),
  };
}

function normalizePromotionEventRow(row: Record<string, unknown>): PersistedIntelligencePromotionEvent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    contractSnapshotId: typeof row.contract_snapshot_id === "string" ? row.contract_snapshot_id : null,
    artifactId: typeof row.artifact_id === "string" ? row.artifact_id : null,
    promotionFamilyKey: String(row.promotion_family_key),
    eventType: String(row.event_type) as PersistedIntelligencePromotionEvent["eventType"],
    suppressionReason: typeof row.suppression_reason === "string" ? row.suppression_reason : null,
    details: asRecord(row.details),
    createdAt: String(row.created_at),
  };
}

async function hydrateBundles(
  supabase: SupabaseClient,
  userId: string,
  artifactRows: PersistedIntelligenceArtifact[]
): Promise<IntelligenceArtifactBundle[]> {
  if (artifactRows.length === 0) {
    return [];
  }

  const artifactIds = artifactRows.map((artifact) => artifact.id);
  const coverageResult = await supabase
    .from("intelligence_artifact_family_coverage")
    .select("*")
    .eq("user_id", userId)
    .in("artifact_id", artifactIds);

  if (coverageResult.error) {
    throw coverageResult.error;
  }

  const coveragesByArtifactId = new Map<string, PersistedIntelligenceArtifactFamilyCoverage[]>();
  for (const row of (coverageResult.data || []) as Array<Record<string, unknown>>) {
    const coverage = normalizeCoverageRow(row);
    const existing = coveragesByArtifactId.get(coverage.artifactId) ?? [];
    existing.push(coverage);
    coveragesByArtifactId.set(coverage.artifactId, existing);
  }

  return artifactRows.map((artifact) => ({
    artifact,
    coverages: (coveragesByArtifactId.get(artifact.id) ?? []).sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }

      return left.promotionFamilyKey.localeCompare(right.promotionFamilyKey);
    }),
  }));
}

export class SupabaseIntelligencePromotionStore implements IntelligencePromotionStore {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async createContractSnapshot(
    input: Omit<PersistedIntelligenceContractSnapshot, "id" | "createdAt">
  ): Promise<PersistedIntelligenceContractSnapshot> {
    const { data, error } = await this.supabase
      .from("intelligence_contract_snapshots")
      .insert({
        user_id: input.userId,
        contract_type: input.contractType,
        canonical_subject_key: input.canonicalSubjectKey,
        promotion_family_key: input.promotionFamilyKey,
        detected_at: input.detectedAt,
        summary: input.summary,
        reason: input.reason,
        severity: input.severity,
        confidence: input.confidence,
        subject_payload: input.subjectPayload,
        metrics_payload: input.metricsPayload,
        evidence_payload: input.evidencePayload,
        provenance_payload: input.provenancePayload,
        content_hash: input.contentHash,
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeContractSnapshotRow(data as Record<string, unknown>);
  }

  async listActiveArtifactsByFamily(userId: string, promotionFamilyKey: string): Promise<IntelligenceArtifactBundle[]> {
    const coverageResult = await this.supabase
      .from("intelligence_artifact_family_coverage")
      .select("*")
      .eq("user_id", userId)
      .eq("promotion_family_key", promotionFamilyKey);

    if (coverageResult.error) {
      throw coverageResult.error;
    }

    const coverageRows = (coverageResult.data || []) as Array<Record<string, unknown>>;
    const artifactIds = [...new Set(coverageRows.map((row) => String(row.artifact_id)).filter(Boolean))];
    if (artifactIds.length === 0) {
      return [];
    }

    const artifactResult = await this.supabase
      .from("intelligence_artifacts")
      .select("*")
      .eq("user_id", userId)
      .in("id", artifactIds)
      .in("status", [...ACTIVE_ARTIFACT_STATUSES]);

    if (artifactResult.error) {
      throw artifactResult.error;
    }

    const artifacts = ((artifactResult.data || []) as Array<Record<string, unknown>>).map((row) => normalizeArtifactRow(row));
    return hydrateBundles(this.supabase, userId, artifacts);
  }

  async getLatestUserDismissalTransitionByFamily(
    userId: string,
    promotionFamilyKey: string
  ): Promise<PersistedIntelligenceArtifactStatusTransition | null> {
    const coverageResult = await this.supabase
      .from("intelligence_artifact_family_coverage")
      .select("artifact_id")
      .eq("user_id", userId)
      .eq("promotion_family_key", promotionFamilyKey);

    if (coverageResult.error) {
      throw coverageResult.error;
    }

    const artifactIds = [
      ...new Set(
        ((coverageResult.data || []) as Array<Record<string, unknown>>)
          .map((row) => (typeof row.artifact_id === "string" ? row.artifact_id : null))
          .filter((value): value is string => Boolean(value))
      ),
    ];

    if (artifactIds.length === 0) {
      return null;
    }

    const transitionResult = await this.supabase
      .from("intelligence_artifact_status_transitions")
      .select("*")
      .eq("user_id", userId)
      .eq("to_status", "dismissed")
      .eq("triggered_by", "user")
      .in("artifact_id", artifactIds)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (transitionResult.error) {
      throw transitionResult.error;
    }

    return transitionResult.data
      ? normalizeStatusTransitionRow(transitionResult.data as Record<string, unknown>)
      : null;
  }

  async listActiveArtifactsBySubject(userId: string, subjectKey: string): Promise<IntelligenceArtifactBundle[]> {
    const artifactResult = await this.supabase
      .from("intelligence_artifacts")
      .select("*")
      .eq("user_id", userId)
      .eq("subject_key", subjectKey)
      .in("status", [...ACTIVE_ARTIFACT_STATUSES]);

    if (artifactResult.error) {
      throw artifactResult.error;
    }

    const artifacts = ((artifactResult.data || []) as Array<Record<string, unknown>>).map((row) => normalizeArtifactRow(row));
    return hydrateBundles(this.supabase, userId, artifacts);
  }

  async createArtifact(
    input: Omit<PersistedIntelligenceArtifact, "id" | "createdAt" | "updatedAt">
  ): Promise<PersistedIntelligenceArtifact> {
    const { data, error } = await this.supabase
      .from("intelligence_artifacts")
      .insert({
        user_id: input.userId,
        artifact_kind: input.artifactKind,
        grouping_key: input.groupingKey,
        subject_key: input.subjectKey,
        primary_contract_type: input.primaryContractType,
        status: input.status,
        summary: input.summary,
        reason: input.reason,
        severity: input.severity,
        confidence: input.confidence,
        available_actions: input.availableActions,
        artifact_evidence: input.artifactEvidence,
        review_payload: input.reviewPayload,
        content_hash: input.contentHash,
        last_evaluated_at: input.lastEvaluatedAt,
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeArtifactRow(data as Record<string, unknown>);
  }

  async updateArtifact(
    userId: string,
    artifactId: string,
    updates: Partial<Omit<PersistedIntelligenceArtifact, "id" | "userId" | "createdAt" | "updatedAt">>
  ): Promise<PersistedIntelligenceArtifact> {
    const row: Record<string, unknown> = {};
    if (updates.artifactKind) row.artifact_kind = updates.artifactKind;
    if (updates.groupingKey !== undefined) row.grouping_key = updates.groupingKey;
    if (updates.subjectKey) row.subject_key = updates.subjectKey;
    if (updates.primaryContractType) row.primary_contract_type = updates.primaryContractType;
    if (updates.status) row.status = updates.status;
    if (updates.summary) row.summary = updates.summary;
    if (updates.reason) row.reason = updates.reason;
    if (updates.severity) row.severity = updates.severity;
    if (updates.confidence) row.confidence = updates.confidence;
    if (updates.availableActions) row.available_actions = updates.availableActions;
    if (updates.artifactEvidence) row.artifact_evidence = updates.artifactEvidence;
    if (updates.reviewPayload) row.review_payload = updates.reviewPayload;
    if (updates.contentHash) row.content_hash = updates.contentHash;
    if (updates.lastEvaluatedAt) row.last_evaluated_at = updates.lastEvaluatedAt;

    const { data, error } = await this.supabase
      .from("intelligence_artifacts")
      .update(row)
      .eq("user_id", userId)
      .eq("id", artifactId)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeArtifactRow(data as Record<string, unknown>);
  }

  async getArtifactById(userId: string, artifactId: string): Promise<PersistedIntelligenceArtifact | null> {
    const { data, error } = await this.supabase
      .from("intelligence_artifacts")
      .select("*")
      .eq("user_id", userId)
      .eq("id", artifactId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ? normalizeArtifactRow(data as Record<string, unknown>) : null;
  }

  async upsertArtifactCoverages(
    userId: string,
    artifactId: string,
    coverages: Array<Omit<PersistedIntelligenceArtifactFamilyCoverage, "id" | "userId" | "artifactId" | "createdAt">>
  ): Promise<PersistedIntelligenceArtifactFamilyCoverage[]> {
    if (coverages.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase
      .from("intelligence_artifact_family_coverage")
      .upsert(
        coverages.map((coverage) => ({
          user_id: userId,
          artifact_id: artifactId,
          promotion_family_key: coverage.promotionFamilyKey,
          contract_type: coverage.contractType,
          canonical_subject_key: coverage.canonicalSubjectKey,
          subject_key: coverage.subjectKey,
          is_primary: coverage.isPrimary,
        })),
        { onConflict: "artifact_id,promotion_family_key" }
      )
      .select("*");

    if (error) {
      throw error;
    }

    return ((data || []) as Array<Record<string, unknown>>).map((row) => normalizeCoverageRow(row));
  }

  async insertArtifactContractLinks(
    userId: string,
    artifactId: string,
    links: Array<Omit<PersistedIntelligenceArtifactContractLink, "id" | "userId" | "artifactId" | "createdAt">>
  ): Promise<PersistedIntelligenceArtifactContractLink[]> {
    if (links.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase
      .from("intelligence_artifact_contract_links")
      .upsert(
        links.map((link) => ({
          user_id: userId,
          artifact_id: artifactId,
          contract_snapshot_id: link.contractSnapshotId,
          promotion_family_key: link.promotionFamilyKey,
          contract_type: link.contractType,
          link_role: link.linkRole,
        })),
        { onConflict: "artifact_id,contract_snapshot_id" }
      )
      .select("*");

    if (error) {
      throw error;
    }

    return ((data || []) as Array<Record<string, unknown>>).map((row) => normalizeContractLinkRow(row));
  }

  async insertStatusTransition(
    input: Omit<PersistedIntelligenceArtifactStatusTransition, "id" | "createdAt">
  ): Promise<PersistedIntelligenceArtifactStatusTransition> {
    const { data, error } = await this.supabase
      .from("intelligence_artifact_status_transitions")
      .insert({
        user_id: input.userId,
        artifact_id: input.artifactId,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        triggered_by: input.triggeredBy,
        note: input.note,
        payload: input.payload,
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizeStatusTransitionRow(data as Record<string, unknown>);
  }

  async insertPromotionEvent(
    input: Omit<PersistedIntelligencePromotionEvent, "id" | "createdAt">
  ): Promise<PersistedIntelligencePromotionEvent> {
    const { data, error } = await this.supabase
      .from("intelligence_promotion_events")
      .insert({
        user_id: input.userId,
        contract_snapshot_id: input.contractSnapshotId,
        artifact_id: input.artifactId,
        promotion_family_key: input.promotionFamilyKey,
        event_type: input.eventType,
        suppression_reason: input.suppressionReason,
        details: input.details,
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return normalizePromotionEventRow(data as Record<string, unknown>);
  }
}
