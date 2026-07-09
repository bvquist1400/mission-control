import type { SupabaseClient } from '@supabase/supabase-js';
import { Task } from '@/types/database';

// Priority scoring rules from spec Section 7

// Urgency keywords that boost priority
const URGENCY_KEYWORDS = ['sla', 'urgent', 'asap', 'outage', 'production issue', 'critical', 'emergency'];

interface PriorityBoosts {
  stakeholder: number;
  dueProximity: number;
  urgency: number;
  waitingPenalty: number;
}

// Per-request cache so a single API call doesn't re-fetch the same user's
// high-priority stakeholder list on every task it processes.
const highPriorityStakeholderCache = new WeakMap<SupabaseClient, Map<string, Promise<string[]>>>();

/**
 * Fetch the names of a user's high-priority stakeholders (stakeholders.is_high_priority = true).
 * Cached per supabase client instance + userId for the lifetime of the request.
 */
export async function getHighPriorityStakeholderNames(
  supabase: SupabaseClient,
  userId: string
): Promise<string[]> {
  let userCache = highPriorityStakeholderCache.get(supabase);
  if (!userCache) {
    userCache = new Map();
    highPriorityStakeholderCache.set(supabase, userCache);
  }

  const cached = userCache.get(userId);
  if (cached) {
    return cached;
  }

  const fetchPromise = (async () => {
    const { data, error } = await supabase
      .from('stakeholders')
      .select('name')
      .eq('user_id', userId)
      .eq('is_high_priority', true);

    if (error) {
      throw error;
    }

    return (data || []).map((row) => (row as { name: string }).name);
  })();

  userCache.set(userId, fetchPromise);
  return fetchPromise;
}

/**
 * Calculate stakeholder boost based on mentions
 * If a high-priority stakeholder is mentioned: +20 per match (cap total at 30)
 */
export function calculateStakeholderBoost(
  stakeholderMentions: string[],
  highPriorityStakeholderNames: string[]
): number {
  const normalizedMentions = stakeholderMentions.map((s) => s.toLowerCase());
  const normalizedStakeholders = highPriorityStakeholderNames.map((s) => s.toLowerCase());
  let boost = 0;

  for (const stakeholder of normalizedStakeholders) {
    if (normalizedMentions.some((m) => m.includes(stakeholder))) {
      boost += 20;
    }
  }

  return Math.min(boost, 30); // Cap at 30
}

/**
 * Calculate due proximity boost
 * - Due today: +25
 * - Due within 48h: +15
 * - No due date: +0
 */
export function calculateDueProximityBoost(dueAt: string | null): number {
  if (!dueAt) return 0;

  const now = new Date();
  const dueDate = new Date(dueAt);
  const hoursUntilDue = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursUntilDue <= 24) {
    return 25; // Due today
  } else if (hoursUntilDue <= 48) {
    return 15; // Due within 48h
  }

  return 0;
}

/**
 * Calculate urgency keyword boost
 * If subject/content contains urgency keywords: +25
 */
export function calculateUrgencyBoost(text: string): number {
  const normalizedText = text.toLowerCase();

  for (const keyword of URGENCY_KEYWORDS) {
    if (normalizedText.includes(keyword)) {
      return 25;
    }
  }

  return 0;
}

/**
 * Calculate waiting penalty
 * If task status = Blocked/Waiting: -20
 */
export function calculateWaitingPenalty(status: string): number {
  return status === 'Blocked/Waiting' ? -20 : 0;
}

/**
 * Calculate all priority boosts for a task
 */
export function calculatePriorityBoosts(
  stakeholderMentions: string[],
  dueAt: string | null,
  subjectOrTitle: string,
  status: string,
  highPriorityStakeholderNames: string[]
): PriorityBoosts {
  return {
    stakeholder: calculateStakeholderBoost(stakeholderMentions, highPriorityStakeholderNames),
    dueProximity: calculateDueProximityBoost(dueAt),
    urgency: calculateUrgencyBoost(subjectOrTitle),
    waitingPenalty: calculateWaitingPenalty(status),
  };
}

/**
 * Calculate final priority score with boosts applied
 * Base score comes from LLM extraction or defaults to 50
 * Final score clamped to 0-100
 */
export function calculateFinalPriorityScore(
  baseScore: number,
  boosts: PriorityBoosts
): number {
  const total =
    baseScore +
    boosts.stakeholder +
    boosts.dueProximity +
    boosts.urgency +
    boosts.waitingPenalty;

  return Math.max(0, Math.min(100, total));
}

/**
 * Recalculate priority score for a task
 * Call this when task fields change (due date, status, etc.)
 *
 * The base must be the un-boosted base_priority — never the stored
 * priority_score, which already includes boosts. Feeding priority_score back
 * in compounds boosts on every edit (the pre-migration-044 bug). Rows written
 * before migration 044 fall back to priority_score as an approximation.
 */
export function recalculateTaskPriority(
  task: Task,
  highPriorityStakeholderNames: string[],
  baseScore?: number
): number {
  const base = baseScore ?? task.base_priority ?? task.priority_score;

  const boosts = calculatePriorityBoosts(
    task.stakeholder_mentions,
    task.due_at,
    task.title,
    task.status,
    highPriorityStakeholderNames
  );

  return calculateFinalPriorityScore(base, boosts);
}

/**
 * Get tasks sorted by priority for Today view Top 3
 */
export function getTopPriorityTasks(tasks: Task[], limit: number = 3): Task[] {
  return [...tasks]
    .filter((t) => t.status === 'Planned' || t.status === 'In Progress')
    .sort((a, b) => b.priority_score - a.priority_score)
    .slice(0, limit);
}

/**
 * Get tasks due within specified hours
 */
export function getTasksDueSoon(tasks: Task[], hoursAhead: number = 48): Task[] {
  const now = new Date();
  const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  return tasks
    .filter((t) => {
      if (t.status === 'Done' || t.status === 'Parked' || !t.due_at) return false;
      const dueDate = new Date(t.due_at);
      return dueDate <= cutoff;
    })
    .sort((a, b) => {
      const aDue = new Date(a.due_at!).getTime();
      const bDue = new Date(b.due_at!).getTime();
      return aDue - bDue;
    });
}

/**
 * Get tasks in Blocked/Waiting status
 */
export function getWaitingTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === 'Blocked/Waiting')
    .sort((a, b) => {
      // Sort by follow_up_at if available, otherwise by created_at
      const aDate = a.follow_up_at || a.created_at;
      const bDate = b.follow_up_at || b.created_at;
      return new Date(aDate).getTime() - new Date(bDate).getTime();
    });
}

/**
 * Get tasks needing review
 */
export function getNeedsReviewTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.needs_review && t.status !== 'Done' && t.status !== 'Parked');
}
