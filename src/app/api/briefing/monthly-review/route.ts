import { NextRequest, NextResponse } from 'next/server';
import {
  buildReviewSnapshotTitle,
  normalizeDateOnly,
  upsertReviewSnapshot,
} from '@/lib/briefing/review-snapshots';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { RagStatus } from '@/types/database';

interface ProjectStatusUpdateRow {
  id: string;
  project_id: string;
  captured_for_date: string;
  summary: string;
  rag: RagStatus | null;
  changes_today: string[];
  blockers: string[];
  next_step: string | null;
  needs_decision: string | null;
  project: { id: string; name: string; stage: string; rag: RagStatus } | Array<{ id: string; name: string; stage: string; rag: RagStatus }> | null;
}

interface ReviewSnapshotRow {
  id: string;
  review_type: string;
  period_start: string;
  period_end: string;
  title: string;
  summary: string;
  source: string;
  payload: Record<string, unknown>;
}

function getTodayETDateOnly(): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function getMonthStart(dateOnly: string): string {
  return `${dateOnly.slice(0, 8)}01`;
}

function getRagSeverity(value: RagStatus | null): number | null {
  switch (value) {
    case 'Green':
      return 0;
    case 'Yellow':
      return 1;
    case 'Red':
      return 2;
    default:
      return null;
  }
}

function summarizeTrend(first: RagStatus | null, latest: RagStatus | null): 'improving' | 'stable' | 'worsening' | 'unknown' {
  const firstSeverity = getRagSeverity(first);
  const latestSeverity = getRagSeverity(latest);

  if (firstSeverity === null || latestSeverity === null) {
    return 'unknown';
  }

  if (latestSeverity < firstSeverity) {
    return 'improving';
  }

  if (latestSeverity > firstSeverity) {
    return 'worsening';
  }

  return 'stable';
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function getProjectRelation(
  value: ProjectStatusUpdateRow['project']
): { id: string; name: string; stage: string; rag: RagStatus } | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

// GET /api/briefing/monthly-review - Structured month-to-date review from stored weekly/project snapshots
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const requestedDate = searchParams.get('date');
    const anchorDate = requestedDate ? normalizeDateOnly(requestedDate) : getTodayETDateOnly();
    const shouldPersist = searchParams.get('persist') === 'true';

    if (!anchorDate) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const monthStart = getMonthStart(anchorDate);

    const [weeklySnapshotResult, projectUpdateResult] = await Promise.all([
      supabase
        .from('briefing_review_snapshots')
        .select('id, review_type, period_start, period_end, title, summary, source, payload')
        .eq('user_id', userId)
        .eq('review_type', 'weekly')
        .gte('period_end', monthStart)
        .lte('period_start', anchorDate)
        .order('period_end', { ascending: true }),
      supabase
        .from('project_status_updates')
        .select('id, project_id, captured_for_date, summary, rag, changes_today, blockers, next_step, needs_decision, project:projects(id, name, stage, rag)')
        .eq('user_id', userId)
        .gte('captured_for_date', monthStart)
        .lte('captured_for_date', anchorDate)
        .order('captured_for_date', { ascending: true })
        .order('updated_at', { ascending: true }),
    ]);

    if (weeklySnapshotResult.error) {
      throw weeklySnapshotResult.error;
    }

    if (projectUpdateResult.error) {
      throw projectUpdateResult.error;
    }

    const weeklySnapshots = (weeklySnapshotResult.data || []) as ReviewSnapshotRow[];
    const projectUpdates = (projectUpdateResult.data || []) as ProjectStatusUpdateRow[];
    const updatesByProject = new Map<string, ProjectStatusUpdateRow[]>();

    for (const update of projectUpdates) {
      const current = updatesByProject.get(update.project_id) ?? [];
      current.push(update);
      updatesByProject.set(update.project_id, current);
    }

    const projectRollups = [...updatesByProject.entries()]
      .map(([projectId, updates]) => {
        const first = updates[0];
        const latest = updates[updates.length - 1];
        const firstProject = getProjectRelation(first.project);
        const latestProject = getProjectRelation(latest.project);
        const firstRag = first.rag ?? firstProject?.rag ?? null;
        const latestRag = latest.rag ?? latestProject?.rag ?? null;
        const changes = updates.flatMap((update) => update.changes_today || []).slice(0, 8);
        const blockers = updates.flatMap((update) => update.blockers || []).slice(0, 8);

        return {
          project_id: projectId,
          project_name: latestProject?.name ?? firstProject?.name ?? 'Unknown project',
          project_stage: latestProject?.stage ?? null,
          updates_count: updates.length,
          first_update_date: first.captured_for_date,
          latest_update_date: latest.captured_for_date,
          first_rag: firstRag,
          latest_rag: latestRag,
          trend: summarizeTrend(firstRag, latestRag),
          blocker_days: updates.filter((update) => (update.blockers || []).length > 0).length,
          decision_days: updates.filter((update) => Boolean(update.needs_decision)).length,
          latest_summary: latest.summary,
          latest_next_step: latest.next_step,
          latest_needs_decision: latest.needs_decision,
          notable_changes: [...new Set(changes)].slice(0, 5),
          notable_blockers: [...new Set(blockers)].slice(0, 5),
        };
      })
      .sort((left, right) => right.updates_count - left.updates_count || left.project_name.localeCompare(right.project_name));

    const totals = {
      weekly_snapshot_count: weeklySnapshots.length,
      project_status_update_count: projectUpdates.length,
      projects_with_updates: projectRollups.length,
      shipped_count: weeklySnapshots.reduce((total, snapshot) => total + getArrayLength(snapshot.payload.shipped), 0),
      stalled_count: weeklySnapshots.reduce((total, snapshot) => total + getArrayLength(snapshot.payload.stalled), 0),
      pending_decision_count: weeklySnapshots.reduce((total, snapshot) => total + getArrayLength(snapshot.payload.pending_decisions), 0),
    };

    const responsePayload = {
      month: {
        start_date: monthStart,
        end_date: anchorDate,
      },
      totals,
      weekly_snapshots: weeklySnapshots,
      project_rollups: projectRollups,
    };

    let reviewSnapshotId: string | null = null;
    if (shouldPersist) {
      const snapshot = await upsertReviewSnapshot(supabase, {
        userId,
        reviewType: 'monthly',
        anchorDate,
        periodStart: monthStart,
        periodEnd: anchorDate,
        title: buildReviewSnapshotTitle('monthly', monthStart, anchorDate),
        summary: `${totals.weekly_snapshot_count} weekly snapshots, ${totals.project_status_update_count} project updates, ${totals.projects_with_updates} active projects in review window.`,
        source: 'system',
        payload: responsePayload as unknown as Record<string, unknown>,
      });
      reviewSnapshotId = snapshot.id;
    }

    return NextResponse.json({
      ...responsePayload,
      snapshot_persisted: shouldPersist,
      review_snapshot_id: reviewSnapshotId,
    });
  } catch (error) {
    console.error('Error generating monthly review:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
