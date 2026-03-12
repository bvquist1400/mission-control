import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewPeriod } from '@/types/database';

export const REVIEW_PERIOD_VALUES = ['weekly', 'monthly'] as const;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface ReviewSnapshotUpsertInput {
  userId: string;
  reviewType: ReviewPeriod;
  anchorDate: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: string;
  source?: string;
  payload: Record<string, unknown>;
}

interface WeeklyReviewPayloadLike {
  shipped?: unknown[];
  stalled?: unknown[];
  pending_decisions?: unknown[];
  cold_commitments?: unknown[];
  project_rollups?: unknown[];
  projects_needing_attention?: unknown[];
  project_decisions?: unknown[];
  next_week_suggestions?: unknown[];
}

export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_REGEX.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeDateOnly(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return isValidDateOnly(trimmed) ? trimmed : null;
}

export function isReviewPeriod(value: unknown): value is ReviewPeriod {
  return typeof value === 'string' && REVIEW_PERIOD_VALUES.includes(value as ReviewPeriod);
}

export function buildReviewSnapshotTitle(reviewType: ReviewPeriod, periodStart: string, periodEnd: string): string {
  const label = reviewType === 'weekly' ? 'Weekly Review' : 'Monthly Review';
  return `${label}: ${periodStart} to ${periodEnd}`;
}

export function buildWeeklyReviewSummary(payload: WeeklyReviewPayloadLike): string {
  const shippedCount = Array.isArray(payload.shipped) ? payload.shipped.length : 0;
  const stalledCount = Array.isArray(payload.stalled) ? payload.stalled.length : 0;
  const pendingCount = Array.isArray(payload.pending_decisions) ? payload.pending_decisions.length : 0;
  const coldCommitmentCount = Array.isArray(payload.cold_commitments) ? payload.cold_commitments.length : 0;
  const projectRollupCount = Array.isArray(payload.project_rollups) ? payload.project_rollups.length : 0;
  const attentionCount = Array.isArray(payload.projects_needing_attention) ? payload.projects_needing_attention.length : 0;
  const projectDecisionCount = Array.isArray(payload.project_decisions) ? payload.project_decisions.length : 0;
  const suggestionCount = Array.isArray(payload.next_week_suggestions) ? payload.next_week_suggestions.length : 0;

  return `${shippedCount} shipped, ${stalledCount} stalled active tasks, ${projectRollupCount} project updates, ${attentionCount} projects needing attention, ${projectDecisionCount} project decisions, ${pendingCount} pending task reviews, ${coldCommitmentCount} cold commitments, ${suggestionCount} next-week suggestions.`;
}

export async function upsertReviewSnapshot(
  supabase: SupabaseClient,
  input: ReviewSnapshotUpsertInput
) {
  const row = {
    user_id: input.userId,
    review_type: input.reviewType,
    anchor_date: input.anchorDate,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    title: input.title,
    summary: input.summary,
    source: input.source?.trim() || 'system',
    payload: input.payload,
  };

  const { data, error } = await supabase
    .from('briefing_review_snapshots')
    .upsert(row, { onConflict: 'user_id,review_type,period_start,period_end' })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return data;
}
