import { NextRequest, NextResponse } from 'next/server';
import {
  buildReviewSnapshotTitle,
  buildWeeklyReviewSummary,
  upsertReviewSnapshot,
} from '@/lib/briefing/review-snapshots';
import { type IntelligenceCommitment, type IntelligenceImplementation, type IntelligenceRiskTask, normalizeCommitmentRows } from '@/lib/briefing/intelligence';
import { computeImplementationHealthScores, persistImplementationHealthSnapshots } from '@/lib/health-scores';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { RagStatus, TaskWithImplementation } from '@/types/database';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  project:
    | { id: string; name: string; stage?: string; rag?: RagStatus }
    | Array<{ id: string; name: string; stage?: string; rag?: RagStatus }>
    | null;
  implementation:
    | { id: string; name: string; phase?: string; rag?: RagStatus; portfolio_rank?: number }
    | Array<{ id: string; name: string; phase?: string; rag?: RagStatus; portfolio_rank?: number }>
    | null;
}

interface WeeklyProjectRollup {
  project_id: string;
  project_name: string;
  project_stage: string | null;
  implementation_name: string | null;
  updates_count: number;
  first_update_date: string;
  latest_update_date: string;
  first_rag: RagStatus | null;
  latest_rag: RagStatus | null;
  trend: 'improving' | 'stable' | 'worsening' | 'new' | 'unknown';
  latest_summary: string;
  latest_next_step: string | null;
  latest_needs_decision: string | null;
  notable_changes: string[];
  notable_blockers: string[];
}

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

function getSingleRelation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function getRagSeverity(value: RagStatus | null | undefined): number {
  switch (value) {
    case 'Green':
      return 0;
    case 'Yellow':
      return 1;
    case 'Red':
      return 2;
    default:
      return -1;
  }
}

function summarizeProjectTrend(
  first: RagStatus | null | undefined,
  latest: RagStatus | null | undefined,
  updatesCount: number
): WeeklyProjectRollup['trend'] {
  if (updatesCount <= 1) {
    return 'new';
  }

  const firstSeverity = getRagSeverity(first);
  const latestSeverity = getRagSeverity(latest);

  if (firstSeverity < 0 || latestSeverity < 0) {
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

function isOverdue(referenceIso: string, dueAt: string | null): boolean {
  if (!dueAt) {
    return false;
  }

  const dueTimestamp = new Date(dueAt).getTime();
  const referenceTimestamp = new Date(referenceIso).getTime();
  if (!Number.isFinite(dueTimestamp) || !Number.isFinite(referenceTimestamp)) {
    return false;
  }

  return dueTimestamp < referenceTimestamp;
}

function isStalledTask(task: TaskWithImplementation, now: Date, referenceIso: string): boolean {
  if (daysSince(now, task.updated_at) < 7) {
    return false;
  }

  if (task.status === 'Blocked/Waiting' || task.status === 'In Progress') {
    return true;
  }

  return task.status === 'Planned' && isOverdue(referenceIso, task.due_at);
}

function compareAttentionProjects(left: WeeklyProjectRollup, right: WeeklyProjectRollup): number {
  const ragDiff = getRagSeverity(right.latest_rag) - getRagSeverity(left.latest_rag);
  if (ragDiff !== 0) {
    return ragDiff;
  }

  const decisionDiff = Number(Boolean(right.latest_needs_decision)) - Number(Boolean(left.latest_needs_decision));
  if (decisionDiff !== 0) {
    return decisionDiff;
  }

  const blockerDiff = right.notable_blockers.length - left.notable_blockers.length;
  if (blockerDiff !== 0) {
    return blockerDiff;
  }

  return right.latest_update_date.localeCompare(left.latest_update_date) || left.project_name.localeCompare(right.project_name);
}

function buildProjectRollups(projectUpdates: ProjectStatusUpdateRow[]): WeeklyProjectRollup[] {
  const updatesByProject = new Map<string, ProjectStatusUpdateRow[]>();

  for (const update of projectUpdates) {
    const current = updatesByProject.get(update.project_id) ?? [];
    current.push(update);
    updatesByProject.set(update.project_id, current);
  }

  return [...updatesByProject.entries()]
    .map(([projectId, updates]) => {
      const first = updates[0];
      const latest = updates[updates.length - 1];
      const firstProject = getSingleRelation(first.project);
      const latestProject = getSingleRelation(latest.project);
      const latestImplementation = getSingleRelation(latest.implementation);
      const firstRag = first.rag ?? firstProject?.rag ?? null;
      const latestRag = latest.rag ?? latestProject?.rag ?? null;
      const changes = updates.flatMap((update) => update.changes_today || []);
      const blockers = updates.flatMap((update) => update.blockers || []);

      return {
        project_id: projectId,
        project_name: latestProject?.name ?? firstProject?.name ?? 'Unknown project',
        project_stage: latestProject?.stage ?? null,
        implementation_name: latestImplementation?.name ?? null,
        updates_count: updates.length,
        first_update_date: first.captured_for_date,
        latest_update_date: latest.captured_for_date,
        first_rag: firstRag,
        latest_rag: latestRag,
        trend: summarizeProjectTrend(firstRag, latestRag, updates.length),
        latest_summary: latest.summary,
        latest_next_step: latest.next_step,
        latest_needs_decision: latest.needs_decision,
        notable_changes: [...new Set(changes)].slice(0, 5),
        notable_blockers: [...new Set(blockers)].slice(0, 5),
      };
    })
    .sort(compareAttentionProjects);
}

function buildNextWeekSuggestions(
  shipped: TaskWithImplementation[],
  stalled: TaskWithImplementation[],
  pendingDecisions: TaskWithImplementation[],
  coldCommitments: IntelligenceCommitment[],
  projectsNeedingAttention: WeeklyProjectRollup[],
  projectDecisions: WeeklyProjectRollup[]
): string[] {
  const suggestions: string[] = [];

  const pushSuggestion = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized || suggestions.includes(normalized)) {
      return;
    }

    suggestions.push(normalized);
  };

  const topAttentionProject = projectsNeedingAttention[0];
  if (topAttentionProject) {
    if (topAttentionProject.latest_needs_decision) {
      pushSuggestion(`${topAttentionProject.project_name} needs a decision next week: ${topAttentionProject.latest_needs_decision}`);
    } else if (topAttentionProject.latest_next_step) {
      pushSuggestion(`${topAttentionProject.project_name}: ${topAttentionProject.latest_next_step}`);
    } else if (topAttentionProject.notable_blockers[0]) {
      pushSuggestion(`${topAttentionProject.project_name} needs attention: ${topAttentionProject.notable_blockers[0]}`);
    }
  }

  if (projectDecisions.length > 0) {
    pushSuggestion(
      `${projectDecisions[0].project_name} has a pending decision that should be resolved before more work starts.`
    );
  }

  const blockedStalled = stalled
    .filter((task) => task.blocker || task.status === 'Blocked/Waiting')
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];

  if (blockedStalled) {
    const staleDays = daysSince(new Date(), blockedStalled.updated_at);
    const implementationName = blockedStalled.implementation?.name || 'An implementation';
    pushSuggestion(
      `${implementationName} has a blocked task stalled ${staleDays} days (${blockedStalled.title}) - escalate, reassign, or narrow scope.`
    );
  }

  if (pendingDecisions.length > 0) {
    pushSuggestion(
      `${pendingDecisions.length} task${pendingDecisions.length === 1 ? '' : 's'} need your review before they can move.`
    );
  }

  if (coldCommitments.length > 0) {
    const oldest = [...coldCommitments].sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    const stakeholderName = oldest?.stakeholder?.name || 'A stakeholder';
    pushSuggestion(
      `${stakeholderName} has ${coldCommitments.length} cold incoming commitment${coldCommitments.length === 1 ? '' : 's'} awaiting follow-up.`
    );
  }

  if (suggestions.length < 3 && stalled.length > 0) {
    const oldestStalled = [...stalled].sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
    if (oldestStalled) {
      const staleDays = daysSince(new Date(), oldestStalled.updated_at);
      pushSuggestion(
        `${oldestStalled.title} has not moved in ${staleDays} days - break it down or explicitly park it next week.`
      );
    }
  }

  if (suggestions.length < 3 && shipped.length > 0) {
    const recentShipped = shipped[0];
    pushSuggestion(
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
    const shouldPersist = searchParams.get('persist') === 'true';

    if (!anchorDate) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const weekStart = getWeekStart(anchorDate);
    const weekEnd = getEndOfDay(anchorDate);
    const weekStartIso = weekStart.toISOString();
    const weekEndIso = weekEnd.toISOString();

    const [taskResult, commitmentResult, implementationResult, projectStatusResult] = await Promise.all([
      supabase
        .from('tasks')
        .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date)')
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
      supabase
        .from('project_status_updates')
        .select(
          'id, project_id, captured_for_date, summary, rag, changes_today, blockers, next_step, needs_decision, project:projects(id, name, stage, rag), implementation:implementations(id, name, phase, rag, portfolio_rank)'
        )
        .eq('user_id', userId)
        .gte('captured_for_date', getDateOnly(weekStart))
        .lte('captured_for_date', getDateOnly(anchorDate))
        .order('captured_for_date', { ascending: true })
        .order('updated_at', { ascending: true }),
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

    if (projectStatusResult.error) {
      throw projectStatusResult.error;
    }

    const now = new Date();
    const allTasks = (taskResult.data || []) as TaskWithImplementation[];
    const openCommitments = normalizeCommitmentRows((commitmentResult.data || []) as unknown[]) as IntelligenceCommitment[];
    const implementations = (implementationResult.data || []) as IntelligenceImplementation[];
    const projectUpdates = (projectStatusResult.data || []) as ProjectStatusUpdateRow[];

    const shipped = allTasks
      .filter((task) => task.status === 'Done' && task.updated_at >= weekStartIso && task.updated_at <= weekEndIso)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

    const stalled = allTasks
      .filter((task) => isStalledTask(task, now, weekEndIso))
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

    const projectRollups = buildProjectRollups(projectUpdates);
    const projectsNeedingAttention = projectRollups.filter(
      (project) =>
        project.latest_rag === 'Red' ||
        project.latest_rag === 'Yellow' ||
        Boolean(project.latest_needs_decision) ||
        project.notable_blockers.length > 0
    );
    const projectDecisions = projectsNeedingAttention.filter((project) => Boolean(project.latest_needs_decision));

    const responsePayload = {
      week: {
        start_date: getDateOnly(weekStart),
        end_date: getDateOnly(anchorDate),
      },
      shipped,
      stalled,
      cold_commitments: coldCommitments,
      pending_decisions: pendingDecisions,
      project_rollups: projectRollups,
      projects_needing_attention: projectsNeedingAttention,
      project_decisions: projectDecisions,
      health_scores: healthScores,
      next_week_suggestions: buildNextWeekSuggestions(
        shipped,
        stalled,
        pendingDecisions,
        coldCommitments,
        projectsNeedingAttention,
        projectDecisions
      ),
    };

    let reviewSnapshotId: string | null = null;

    if (shouldPersist) {
      const snapshot = await upsertReviewSnapshot(supabase, {
        userId,
        reviewType: 'weekly',
        anchorDate: getDateOnly(anchorDate),
        periodStart: getDateOnly(weekStart),
        periodEnd: getDateOnly(anchorDate),
        title: buildReviewSnapshotTitle('weekly', getDateOnly(weekStart), getDateOnly(anchorDate)),
        summary: buildWeeklyReviewSummary(responsePayload),
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
    console.error('Error generating weekly review:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
