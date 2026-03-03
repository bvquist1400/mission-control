import { NextRequest, NextResponse } from 'next/server';
import { type IntelligenceCommitment, type IntelligenceImplementation, type IntelligenceRiskTask, normalizeCommitmentRows } from '@/lib/briefing/intelligence';
import { computeImplementationHealthScores, persistImplementationHealthSnapshots } from '@/lib/health-scores';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { TaskWithImplementation } from '@/types/database';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function getDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function getStartOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function getEndOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function getAnchorDate(value: string | null): Date | null {
  if (!value) {
    return getStartOfDay(new Date());
  }

  if (!DATE_ONLY_REGEX.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date;
}

function getWeekStart(anchorDate: Date): Date {
  const start = getStartOfDay(anchorDate);
  const dayOfWeek = start.getUTCDay();
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  start.setUTCDate(start.getUTCDate() + offset);
  return start;
}

function daysSince(now: Date, iso: string): number {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS));
}

function buildNextWeekSuggestions(
  shipped: TaskWithImplementation[],
  stalled: TaskWithImplementation[],
  pendingDecisions: TaskWithImplementation[],
  coldCommitments: IntelligenceCommitment[]
): string[] {
  const suggestions: string[] = [];

  const blockedStalled = stalled
    .filter((task) => task.blocker || task.status === 'Blocked/Waiting')
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];

  if (blockedStalled) {
    const staleDays = daysSince(new Date(), blockedStalled.updated_at);
    const implementationName = blockedStalled.implementation?.name || 'An implementation';
    suggestions.push(
      `${implementationName} has a blocked task stalled ${staleDays} days (${blockedStalled.title}) - escalate, reassign, or narrow scope.`
    );
  }

  if (pendingDecisions.length > 0) {
    suggestions.push(
      `${pendingDecisions.length} task${pendingDecisions.length === 1 ? '' : 's'} need your review before they can move.`
    );
  }

  if (coldCommitments.length > 0) {
    const oldest = [...coldCommitments].sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    const stakeholderName = oldest?.stakeholder?.name || 'A stakeholder';
    suggestions.push(
      `${stakeholderName} has ${coldCommitments.length} cold incoming commitment${coldCommitments.length === 1 ? '' : 's'} awaiting follow-up.`
    );
  }

  if (suggestions.length < 3 && stalled.length > 0) {
    const oldestStalled = [...stalled].sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
    if (oldestStalled) {
      const staleDays = daysSince(new Date(), oldestStalled.updated_at);
      suggestions.push(
        `${oldestStalled.title} has not moved in ${staleDays} days - break it down or explicitly park it next week.`
      );
    }
  }

  if (suggestions.length < 3 && shipped.length > 0) {
    const recentShipped = shipped[0];
    suggestions.push(
      `Carry momentum from ${recentShipped.title} by scheduling the next concrete follow-through while context is still fresh.`
    );
  }

  return suggestions.slice(0, 3);
}

// GET /api/briefing/weekly-review - Structured weekly review snapshot
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const anchorDate = getAnchorDate(searchParams.get('date'));

    if (!anchorDate) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const weekStart = getWeekStart(anchorDate);
    const weekEnd = getEndOfDay(anchorDate);
    const weekStartIso = weekStart.toISOString();
    const weekEndIso = weekEnd.toISOString();

    const [taskResult, commitmentResult, implementationResult] = await Promise.all([
      supabase
        .from('tasks')
        .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag)')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false }),
      supabase
        .from('commitments')
        .select(
          'id, title, direction, status, due_at, created_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status, implementation_id)'
        )
        .eq('user_id', userId)
        .eq('status', 'Open'),
      supabase
        .from('implementations')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true }),
    ]);

    if (taskResult.error) {
      throw taskResult.error;
    }

    if (commitmentResult.error) {
      throw commitmentResult.error;
    }

    if (implementationResult.error) {
      throw implementationResult.error;
    }

    const now = new Date();
    const allTasks = (taskResult.data || []) as TaskWithImplementation[];
    const openCommitments = normalizeCommitmentRows((commitmentResult.data || []) as unknown[]) as IntelligenceCommitment[];
    const implementations = (implementationResult.data || []) as IntelligenceImplementation[];

    const shipped = allTasks
      .filter((task) => task.status === 'Done' && task.updated_at >= weekStartIso && task.updated_at <= weekEndIso)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

    const stalled = allTasks
      .filter((task) => task.status !== 'Done' && task.status !== 'Parked')
      .filter((task) => daysSince(now, task.updated_at) >= 7)
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at));

    const pendingDecisions = allTasks
      .filter((task) => task.status !== 'Done' && task.status !== 'Parked' && task.needs_review)
      .sort((left, right) => {
        if (right.priority_score !== left.priority_score) {
          return right.priority_score - left.priority_score;
        }

        return left.updated_at.localeCompare(right.updated_at);
      });

    const coldCommitments = openCommitments
      .filter((commitment) => commitment.direction === 'theirs')
      .filter((commitment) => daysSince(now, commitment.created_at) >= 5)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));

    const { scores: healthScores, snapshots } = computeImplementationHealthScores(
      implementations,
      allTasks as IntelligenceRiskTask[],
      openCommitments,
      now
    );
    await persistImplementationHealthSnapshots(supabase, userId, snapshots);

    return NextResponse.json({
      week: {
        start_date: getDateOnly(weekStart),
        end_date: getDateOnly(anchorDate),
      },
      shipped,
      stalled,
      cold_commitments: coldCommitments,
      pending_decisions: pendingDecisions,
      health_scores: healthScores,
      next_week_suggestions: buildNextWeekSuggestions(shipped, stalled, pendingDecisions, coldCommitments),
    });
  } catch (error) {
    console.error('Error generating weekly review:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
