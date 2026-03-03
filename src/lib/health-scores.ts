import type { SupabaseClient } from '@supabase/supabase-js';
import { getColdCommitmentThresholdDays, type IntelligenceCommitment, type IntelligenceRiskTask } from '@/lib/briefing/intelligence';
import type {
  HealthLabel,
  HealthTrend,
  ImplementationHealthScore,
  ImplementationHealthSnapshot,
} from '@/types/database';

interface HealthImplementationInput {
  id: string;
  name: string;
  health_snapshot?: unknown;
}

const STALL_WARNING_MIN_DAYS = 4;
const STALL_WARNING_MAX_DAYS = 7;
const STALL_ELEVATED_MAX_DAYS = 14;

function daysSince(now: Date, iso: string): number {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24)));
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42703' || candidate.code === 'PGRST204') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes(columnName.toLowerCase()) && message.includes('column');
}

function normalizeSnapshot(value: unknown): ImplementationHealthSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const snapshot = value as Record<string, unknown>;

  if (
    typeof snapshot.as_of !== 'string' ||
    typeof snapshot.captured_at !== 'string' ||
    typeof snapshot.health_score !== 'number' ||
    typeof snapshot.blocker_count !== 'number' ||
    typeof snapshot.blocked_waiting_task_count !== 'number' ||
    typeof snapshot.cold_commitments_count !== 'number'
  ) {
    return null;
  }

  const stallDays = snapshot.stall_days;
  if (stallDays !== null && stallDays !== undefined && typeof stallDays !== 'number') {
    return null;
  }

  return {
    as_of: snapshot.as_of,
    captured_at: snapshot.captured_at,
    health_score: Math.max(0, Math.min(100, Math.round(snapshot.health_score))),
    blocker_count: Math.max(0, Math.round(snapshot.blocker_count)),
    blocked_waiting_task_count: Math.max(0, Math.round(snapshot.blocked_waiting_task_count)),
    cold_commitments_count: Math.max(0, Math.round(snapshot.cold_commitments_count)),
    stall_days: stallDays === null || stallDays === undefined ? null : Math.max(0, Math.round(stallDays)),
  };
}

function getTodayDateOnly(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function getStallPenalty(stallDays: number | null): number {
  if (stallDays === null) {
    return 0;
  }

  if (stallDays >= 15) {
    return 30;
  }

  if (stallDays >= 8) {
    return 20;
  }

  if (stallDays >= STALL_WARNING_MIN_DAYS) {
    return 10;
  }

  return 0;
}

function getHealthLabel(healthScore: number): HealthLabel {
  if (healthScore <= 25) {
    return 'Healthy';
  }

  if (healthScore <= 50) {
    return 'Watch';
  }

  if (healthScore <= 75) {
    return 'At Risk';
  }

  return 'Critical';
}

function deriveTrend(previousSnapshot: ImplementationHealthSnapshot | null, currentScore: number): HealthTrend {
  if (!previousSnapshot) {
    return 'unknown';
  }

  if (currentScore === previousSnapshot.health_score) {
    return 'stable';
  }

  return currentScore < previousSnapshot.health_score ? 'improving' : 'degrading';
}

function buildSignals(
  blockerCount: number,
  blockedWaitingCount: number,
  stallDays: number | null,
  coldCommitmentsCount: number
): string[] {
  const signals: string[] = [];

  if (blockerCount > 0) {
    signals.push(`${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`);
  }

  if (blockedWaitingCount > 0) {
    signals.push(`${blockedWaitingCount} Blocked/Waiting task${blockedWaitingCount === 1 ? '' : 's'}`);
  }

  if (stallDays !== null) {
    if (stallDays >= 15) {
      signals.push(`No completed tasks in ${stallDays} days`);
    } else if (stallDays >= 8) {
      signals.push(`No completed tasks in ${stallDays} days`);
    } else if (stallDays >= STALL_WARNING_MIN_DAYS && stallDays <= STALL_WARNING_MAX_DAYS) {
      signals.push(`No completed tasks in ${stallDays} days`);
    }
  }

  if (coldCommitmentsCount > 0) {
    signals.push(`${coldCommitmentsCount} cold incoming commitment${coldCommitmentsCount === 1 ? '' : 's'}`);
  }

  return signals;
}

export function computeImplementationHealthScores(
  implementations: HealthImplementationInput[],
  tasks: IntelligenceRiskTask[],
  commitments: IntelligenceCommitment[],
  now: Date = new Date(),
  coldDays = getColdCommitmentThresholdDays()
): {
  scores: ImplementationHealthScore[];
  snapshots: Map<string, ImplementationHealthSnapshot>;
} {
  const today = getTodayDateOnly(now);
  const coldCommitmentCounts = new Map<string, number>();

  for (const commitment of commitments) {
    if (
      commitment.status !== 'Open' ||
      commitment.direction !== 'theirs' ||
      !commitment.task?.implementation_id ||
      daysSince(now, commitment.created_at) < coldDays
    ) {
      continue;
    }

    const implementationId = commitment.task.implementation_id;
    coldCommitmentCounts.set(implementationId, (coldCommitmentCounts.get(implementationId) || 0) + 1);
  }

  const snapshots = new Map<string, ImplementationHealthSnapshot>();
  const scores = implementations
    .map((implementation) => {
      const implementationTasks = tasks.filter((task) => task.implementation_id === implementation.id);
      const openTasks = implementationTasks.filter((task) => task.status !== 'Done' && task.status !== 'Parked');
      const blockerCount = openTasks.filter((task) => task.blocker).length;
      const blockedWaitingCount = openTasks.filter((task) => task.status === 'Blocked/Waiting').length;
      const mostRecentDoneTask = implementationTasks
        .filter((task) => task.status === 'Done')
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      const hasAnyOpenWork = openTasks.length > 0;
      const stallDays = mostRecentDoneTask
        ? daysSince(now, mostRecentDoneTask.updated_at)
        : hasAnyOpenWork
          ? 15
          : null;
      const coldCommitmentsCount = coldCommitmentCounts.get(implementation.id) || 0;

      const blockerScore = blockerCount * 20;
      const blockedWaitingScore = blockedWaitingCount * 10;
      const stallScore = getStallPenalty(stallDays);
      const coldCommitmentScore = coldCommitmentsCount * 15;
      const healthScore = Math.min(100, blockerScore + blockedWaitingScore + stallScore + coldCommitmentScore);
      const previousSnapshot = normalizeSnapshot(implementation.health_snapshot);
      const trend = deriveTrend(previousSnapshot, healthScore);
      const signals = buildSignals(blockerCount, blockedWaitingCount, stallDays, coldCommitmentsCount);

      const snapshot: ImplementationHealthSnapshot = {
        as_of: today,
        captured_at: now.toISOString(),
        health_score: healthScore,
        blocker_count: blockerCount,
        blocked_waiting_task_count: blockedWaitingCount,
        cold_commitments_count: coldCommitmentsCount,
        stall_days: stallDays,
      };

      snapshots.set(implementation.id, snapshot);

      return {
        id: implementation.id,
        name: implementation.name,
        health_score: healthScore,
        health_label: getHealthLabel(healthScore),
        signals,
        trend,
      };
    })
    .sort((left, right) => {
      if (right.health_score !== left.health_score) {
        return right.health_score - left.health_score;
      }

      return left.name.localeCompare(right.name);
    });

  return { scores, snapshots };
}

export async function persistImplementationHealthSnapshots(
  supabase: SupabaseClient,
  userId: string,
  snapshots: Map<string, ImplementationHealthSnapshot>
): Promise<boolean> {
  for (const [implementationId, snapshot] of snapshots.entries()) {
    const { error } = await supabase
      .from('implementations')
      .update({ health_snapshot: snapshot })
      .eq('id', implementationId)
      .eq('user_id', userId);

    if (!error) {
      continue;
    }

    if (isMissingColumnError(error, 'health_snapshot')) {
      return false;
    }

    throw error;
  }

  return true;
}
