import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calculatePlannerScore,
  getPlannerConfigFromEnv,
  isExceptionTask,
  type PlannerConfig,
  type PlannerTaskLike,
} from '@/lib/planner';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

type PlannerMode = 'today' | 'now';
type DirectiveStrength = 'nudge' | 'strong' | 'hard';
type DirectiveScopeType = 'implementation' | 'stakeholder' | 'task_type' | 'query';

interface PlannerRequestBody {
  date?: string;
  mode?: PlannerMode;
}

interface TaskRow {
  id: string;
  title: string;
  implementation_id: string | null;
  priority_score: number | null;
  due_at: string | null;
  follow_up_at: string | null;
  waiting_on: string | null;
  blocker: boolean;
  status: string;
  estimated_minutes: number;
  stakeholder_mentions: string[] | null;
  task_type: string | null;
  updated_at: string;
}

interface FocusDirectiveRow {
  id: string;
  text: string;
  scope_type: DirectiveScopeType;
  scope_id: string | null;
  scope_value: string | null;
  strength: DirectiveStrength;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  reason: string | null;
}

interface RankedTask {
  task: TaskRow;
  finalScore: number;
  directiveMatched: boolean;
  score: ReturnType<typeof calculatePlannerScore>;
  implementationMultiplier: number;
  directiveMultiplier: number;
  fitBonus: number;
  exceptionEligible: boolean;
}

const PLANNER_SOURCE = 'planner_v1.1';
const NEXT_WINDOW_MINUTES = 60;
const MAX_QUEUE_ITEMS = 50;
const MAX_EXCEPTIONS = 10;
const HIGH_PRIORITY_STAKEHOLDERS = ['nancy', 'heath'];
const WEIGHT_MULTIPLIER_TABLE = [0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8];
const DIRECTIVE_STRENGTH_MULTIPLIERS: Record<DirectiveStrength, { match: number; nonMatch: number }> = {
  nudge: { match: 1.2, nonMatch: 0.95 },
  strong: { match: 1.6, nonMatch: 0.85 },
  hard: { match: 2.0, nonMatch: 0.7 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  const iso = new Date(parsed).toISOString().slice(0, 10);
  return iso === value;
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42P01' || candidate.code === 'PGRST205') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes('does not exist') || message.includes('could not find the table');
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

function getDirectiveMultiplier(directive: FocusDirectiveRow | null, isMatch: boolean): number {
  if (!directive) {
    return 1;
  }

  const strength = DIRECTIVE_STRENGTH_MULTIPLIERS[directive.strength] ?? DIRECTIVE_STRENGTH_MULTIPLIERS.strong;
  return isMatch ? strength.match : strength.nonMatch;
}

function priorityWeightToMultiplier(priorityWeight: number | null | undefined): number {
  const normalized = clamp(Math.round(Number.isFinite(priorityWeight ?? NaN) ? (priorityWeight as number) : 5), 0, 10);
  return WEIGHT_MULTIPLIER_TABLE[normalized] ?? 1;
}

function calculateStakeholderBoost(stakeholderMentions: string[] | null): number {
  const normalized = (stakeholderMentions || []).map((value) => value.toLowerCase());
  const hasHighPriority = HIGH_PRIORITY_STAKEHOLDERS.some((name) =>
    normalized.some((mention) => mention.includes(name))
  );
  return hasHighPriority ? 10 : 0;
}

function isDirectiveCurrentlyActive(directive: FocusDirectiveRow, nowMs: number): boolean {
  if (!directive.is_active) {
    return false;
  }

  const startsAtMs = parseTimestampMs(directive.starts_at);
  const endsAtMs = parseTimestampMs(directive.ends_at);

  if (startsAtMs !== null && startsAtMs > nowMs) {
    return false;
  }

  if (endsAtMs !== null && endsAtMs <= nowMs) {
    return false;
  }

  return true;
}

function matchesDirective(task: TaskRow, directive: FocusDirectiveRow | null): boolean {
  if (!directive) {
    return false;
  }

  switch (directive.scope_type) {
    case 'implementation':
      return Boolean(directive.scope_id && task.implementation_id === directive.scope_id);
    case 'stakeholder': {
      const scope = directive.scope_value?.trim().toLowerCase();
      if (!scope) {
        return false;
      }

      return (task.stakeholder_mentions || []).some((mention) => mention.toLowerCase().includes(scope));
    }
    case 'task_type': {
      const scope = directive.scope_value?.trim().toLowerCase();
      if (!scope || !task.task_type) {
        return false;
      }

      return task.task_type.toLowerCase() === scope;
    }
    case 'query':
      return false;
    default:
      return false;
  }
}

function toRankedTask(
  task: TaskRow,
  nowMs: number,
  directive: FocusDirectiveRow | null,
  implementationWeights: Map<string, number>,
  plannerConfig: PlannerConfig
): RankedTask {
  const stakeholderBoost = calculateStakeholderBoost(task.stakeholder_mentions);
  const implementationWeight = task.implementation_id ? implementationWeights.get(task.implementation_id) ?? 5 : 5;
  const implementationMultiplier = priorityWeightToMultiplier(implementationWeight);
  const directiveMatched = matchesDirective(task, directive);
  const directiveMultiplier = getDirectiveMultiplier(directive, directiveMatched);

  const minutes = Number.isFinite(task.estimated_minutes) ? task.estimated_minutes : 30;
  const fitBonus = minutes <= NEXT_WINDOW_MINUTES ? 5 : -10;

  const plannerTask: PlannerTaskLike = {
    priority_score: task.priority_score,
    due_at: task.due_at,
    follow_up_at: task.follow_up_at,
    waiting_on: task.waiting_on,
    blocker: task.blocker,
    status: task.status,
    updated_at: task.updated_at,
  };

  const score = calculatePlannerScore(plannerTask, {
    nowMs,
    stakeholderBoost,
    fitBonus,
    implementationMultiplier,
    directiveMultiplier,
  });

  const exceptionEligible = isExceptionTask(plannerTask, nowMs, plannerConfig);

  return {
    task,
    finalScore: Number(score.finalScore.toFixed(2)),
    directiveMatched,
    score,
    implementationMultiplier,
    directiveMultiplier,
    fitBonus,
    exceptionEligible,
  };
}

function buildWhyLines(ranked: RankedTask, directive: FocusDirectiveRow | null): string[] {
  const lines: string[] = [];

  if (directive) {
    lines.push(
      ranked.directiveMatched
        ? `Focus match (${directive.scope_type}, x${ranked.directiveMultiplier.toFixed(2)})`
        : `Outside focus (${directive.scope_type}, x${ranked.directiveMultiplier.toFixed(2)})`
    );
  }

  if (ranked.score.urgencyBoost > 0) {
    lines.push(`Urgency +${ranked.score.urgencyBoost}`);
  }

  if (ranked.score.stakeholderBoost > 0) {
    lines.push(`Stakeholder boost +${ranked.score.stakeholderBoost}`);
  }

  if (ranked.score.stalenessBoost > 0) {
    lines.push(`Staleness boost +${ranked.score.stalenessBoost}`);
  }

  if (ranked.score.statusAdjust !== 0) {
    lines.push(`Status adjustment ${ranked.score.statusAdjust > 0 ? '+' : ''}${ranked.score.statusAdjust}`);
  }

  if (ranked.fitBonus !== 0) {
    lines.push(`Window fit ${ranked.fitBonus > 0 ? '+' : ''}${ranked.fitBonus}`);
  }

  lines.push(`Implementation multiplier x${ranked.implementationMultiplier.toFixed(2)}`);

  return lines;
}

function getTaskSortDueTimestamp(task: TaskRow): number {
  const dueMs = parseTimestampMs(task.due_at);
  return dueMs ?? Number.POSITIVE_INFINITY;
}

async function loadImplementationWeights(
  supabase: SupabaseClient,
  userId: string
): Promise<Map<string, number>> {
  const withWeight = await supabase
    .from('implementations')
    .select('id, priority_weight')
    .eq('user_id', userId);

  if (!withWeight.error) {
    const map = new Map<string, number>();
    for (const row of withWeight.data || []) {
      map.set(row.id, Number.isFinite(row.priority_weight) ? row.priority_weight : 5);
    }
    return map;
  }

  if (!isMissingColumnError(withWeight.error, 'priority_weight')) {
    throw withWeight.error;
  }

  const withoutWeight = await supabase
    .from('implementations')
    .select('id')
    .eq('user_id', userId);

  if (withoutWeight.error) {
    throw withoutWeight.error;
  }

  const map = new Map<string, number>();
  for (const row of withoutWeight.data || []) {
    map.set(row.id, 5);
  }
  return map;
}

async function loadActiveDirective(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number
): Promise<FocusDirectiveRow | null> {
  const result = await supabase
    .from('focus_directives')
    .select('id, text, scope_type, scope_id, scope_value, strength, starts_at, ends_at, is_active, reason')
    .eq('created_by', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);

  if (result.error) {
    if (isMissingRelationError(result.error)) {
      return null;
    }
    throw result.error;
  }

  const directive = (result.data || [])[0] as FocusDirectiveRow | undefined;
  if (!directive) {
    return null;
  }

  return isDirectiveCurrentlyActive(directive, nowMs) ? directive : null;
}

async function savePlanIfTableExists(
  supabase: SupabaseClient,
  userId: string,
  planDate: string,
  payload: {
    inputs_snapshot: Record<string, unknown>;
    plan_json: Record<string, unknown>;
    reasons_json: Record<string, unknown>;
  }
): Promise<{ saved: boolean; planId: string | null }> {
  const insertResult = await supabase
    .from('plans')
    .insert({
      created_by: userId,
      plan_date: planDate,
      source: PLANNER_SOURCE,
      inputs_snapshot: payload.inputs_snapshot,
      plan_json: payload.plan_json,
      reasons_json: payload.reasons_json,
      status: 'proposed',
    })
    .select('id')
    .single();

  if (!insertResult.error) {
    return {
      saved: true,
      planId: insertResult.data?.id ?? null,
    };
  }

  if (isMissingRelationError(insertResult.error)) {
    return {
      saved: false,
      planId: null,
    };
  }

  throw insertResult.error;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get('date');

    if (dateParam && !isValidDateString(dateParam)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    const nowMs = Date.now();
    const planDate = dateParam ?? getDateInTimeZone(new Date(nowMs), DEFAULT_WORKDAY_CONFIG.timezone);

    const latestResult = await supabase
      .from('plans')
      .select('id, created_at, created_by, plan_date, source, inputs_snapshot, plan_json, reasons_json, status, applied_at')
      .eq('created_by', userId)
      .eq('plan_date', planDate)
      .order('created_at', { ascending: false })
      .limit(1);

    if (latestResult.error) {
      if (isMissingRelationError(latestResult.error)) {
        return NextResponse.json({
          planDate,
          source: PLANNER_SOURCE,
          plan: null,
          note: 'plans table not found',
        });
      }

      throw latestResult.error;
    }

    const plan = (latestResult.data || [])[0] ?? null;
    return NextResponse.json({
      planDate,
      source: PLANNER_SOURCE,
      plan,
    });
  } catch (error) {
    console.error('Error fetching latest planner plan:', error);
    return NextResponse.json({ error: 'Failed to fetch plan' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    let body: PlannerRequestBody = {};
    try {
      body = (await request.json()) as PlannerRequestBody;
    } catch {
      body = {};
    }

    if (body.date && !isValidDateString(body.date)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }

    if (body.mode && body.mode !== 'today' && body.mode !== 'now') {
      return NextResponse.json({ error: 'mode must be today or now' }, { status: 400 });
    }

    const mode: PlannerMode = body.mode ?? 'today';
    const nowMs = Date.now();
    const planDate = body.date ?? getDateInTimeZone(new Date(nowMs), DEFAULT_WORKDAY_CONFIG.timezone);
    const plannerConfig = getPlannerConfigFromEnv();

    const tasksResult = await supabase
      .from('tasks')
      .select(
        'id, title, implementation_id, priority_score, due_at, follow_up_at, waiting_on, blocker, status, estimated_minutes, stakeholder_mentions, task_type, updated_at'
      )
      .eq('user_id', userId)
      .neq('status', 'Done')
      .limit(1000);

    if (tasksResult.error) {
      throw tasksResult.error;
    }

    const tasks = (tasksResult.data || []) as TaskRow[];
    const implementationWeights = await loadImplementationWeights(supabase, userId);
    const activeDirective = await loadActiveDirective(supabase, userId, nowMs);

    const rankedTasks = tasks
      .map((task) => toRankedTask(task, nowMs, activeDirective, implementationWeights, plannerConfig))
      .sort((a, b) => {
        if (a.finalScore !== b.finalScore) {
          return b.finalScore - a.finalScore;
        }

        const dueDiff = getTaskSortDueTimestamp(a.task) - getTaskSortDueTimestamp(b.task);
        if (dueDiff !== 0) {
          return dueDiff;
        }

        return a.task.title.localeCompare(b.task.title);
      });

    const fitRanked = rankedTasks.filter((row) => row.task.estimated_minutes <= NEXT_WINDOW_MINUTES);
    const nowNextTask = fitRanked[0] ?? rankedTasks[0] ?? null;
    const next3 = rankedTasks
      .filter((row) => row.task.id !== nowNextTask?.task.id)
      .slice(0, 3);

    const queue = rankedTasks.slice(0, MAX_QUEUE_ITEMS).map((row, index) => ({
      taskId: row.task.id,
      rank: index + 1,
      score: row.finalScore,
      title: row.task.title,
    }));

    const exceptions =
      activeDirective === null
        ? []
        : rankedTasks
            .filter((row) => !row.directiveMatched && row.exceptionEligible)
            .slice(0, MAX_EXCEPTIONS)
            .map((row) => ({
              taskId: row.task.id,
              score: row.finalScore,
              title: row.task.title,
              reason: row.score.followUpDue && row.task.blocker ? 'Blocked and follow-up is due' : 'Due within 24 hours',
            }));

    const reasonsJson: Record<string, unknown> = {};
    for (const row of rankedTasks) {
      reasonsJson[row.task.id] = {
        priorityBlend: row.score.priorityBlend,
        urgencyBoost: row.score.urgencyBoost,
        stakeholderBoost: row.score.stakeholderBoost,
        stalenessBoost: row.score.stalenessBoost,
        statusAdjust: row.score.statusAdjust,
        fitBonus: row.score.fitBonus,
        implementationMultiplier: row.implementationMultiplier,
        directiveMultiplier: row.directiveMultiplier,
        directiveMatched: row.directiveMatched,
        followUpDue: row.score.followUpDue,
        preMultiplierScore: row.score.preMultiplierScore,
        finalScore: row.finalScore,
        why: buildWhyLines(row, activeDirective),
        configSnapshot: {
          source: PLANNER_SOURCE,
          mode,
          nextWindowMinutes: NEXT_WINDOW_MINUTES,
          exceptions: plannerConfig.exceptions,
        },
      };
    }

    const planJson: Record<string, unknown> = {
      nowNext: nowNextTask
        ? {
            taskId: nowNextTask.task.id,
            suggestedMinutes: Math.min(nowNextTask.task.estimated_minutes, NEXT_WINDOW_MINUTES),
            mode:
              nowNextTask.task.estimated_minutes >= 45
                ? 'deep'
                : nowNextTask.task.estimated_minutes >= 20
                  ? 'shallow'
                  : 'prep',
          }
        : null,
      next3: next3.map((row) => ({ taskId: row.task.id })),
      queue,
      exceptions,
      windows: [
        {
          minutes: NEXT_WINDOW_MINUTES,
          source: 'stub',
        },
      ],
    };

    const inputsSnapshot: Record<string, unknown> = {
      generatedAt: new Date(nowMs).toISOString(),
      planDate,
      mode,
      taskCount: tasks.length,
      nextWindowMinutes: NEXT_WINDOW_MINUTES,
      timezone: DEFAULT_WORKDAY_CONFIG.timezone,
      directiveId: activeDirective?.id ?? null,
      directiveStrength: activeDirective?.strength ?? null,
      exceptions: plannerConfig.exceptions,
    };

    const planSave = await savePlanIfTableExists(supabase, userId, planDate, {
      inputs_snapshot: inputsSnapshot,
      plan_json: planJson,
      reasons_json: reasonsJson,
    });

    return NextResponse.json({
      planDate,
      mode,
      source: PLANNER_SOURCE,
      config: plannerConfig,
      directive: activeDirective,
      inputs_snapshot: inputsSnapshot,
      plan_json: planJson,
      reasons_json: reasonsJson,
      persisted: planSave,
    });
  } catch (error) {
    console.error('Error generating planner plan:', error);
    return NextResponse.json({ error: 'Failed to generate plan' }, { status: 500 });
  }
}
