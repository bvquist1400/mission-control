import { NextRequest, NextResponse } from 'next/server';
import {
  ProjectSectionServiceError,
  validateTaskSectionAssignment,
} from '@/lib/project-sections';
import { normalizeTaskTag, normalizeTaskTags } from '@/lib/task-tags';
import {
  normalizeTaskWithRelations,
  normalizeTaskWithRelationsList,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import { queueTaskStatusTransition } from '@/lib/task-status-transitions';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { fetchTaskDependencySummaries } from '@/lib/task-dependencies';
import type { TaskStatus, TaskType, EstimateSource } from '@/types/database';

const VALID_STATUSES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done'];
const VALID_TASK_TYPES: TaskType[] = ['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'];
const VALID_ESTIMATE_SOURCES: EstimateSource[] = ['default', 'llm', 'manual'];
function isValidStatus(value: string): value is TaskStatus {
  return VALID_STATUSES.includes(value as TaskStatus);
}

function isValidTaskType(value: string): value is TaskType {
  return VALID_TASK_TYPES.includes(value as TaskType);
}

function isValidEstimateSource(value: string): value is EstimateSource {
  return VALID_ESTIMATE_SOURCES.includes(value as EstimateSource);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/tasks - List tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const needsReview = searchParams.get('needs_review');
    const status = searchParams.get('status');
    const implementationId = searchParams.get('implementation_id');
    const sprintId = searchParams.get('sprint_id');
    const tag = normalizeTaskTag(searchParams.get('tag') ?? '');
    const dueSoon = searchParams.get('due_soon');
    const sectionId = searchParams.get('section_id');
    const includeDone = searchParams.get('include_done') === 'true';
    const includeParked = searchParams.get('include_parked') === 'true';
    const view = searchParams.get('view');
    const rawLimit = Number.parseInt(searchParams.get('limit') || '100', 10);
    const rawOffset = Number.parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    if (view === 'needs_review_count') {
      const { count, error } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('needs_review', true)
        .neq('status', 'Done')
        .neq('status', 'Parked');

      if (error) {
        throw error;
      }

      return NextResponse.json({ count: count ?? 0 });
    }

    if (view === 'top3') {
      const { data, error } = await supabase
        .from('tasks')
        .select(TASK_WITH_RELATIONS_SELECT)
        .eq('user_id', userId)
        .in('status', ['Planned', 'In Progress'])
        .order('priority_score', { ascending: false })
        .order('id', { ascending: true })
        .limit(3);

      if (error) {
        throw error;
      }

      return NextResponse.json(normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>));
    }

    if (view === 'due_soon') {
      const now = new Date();
      const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const dueSoonLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 6;

      const { data: topThreeIdsRows, error: topThreeIdsError } = await supabase
        .from('tasks')
        .select('id')
        .eq('user_id', userId)
        .in('status', ['Planned', 'In Progress'])
        .order('priority_score', { ascending: false })
        .order('id', { ascending: true })
        .limit(3);

      if (topThreeIdsError) {
        throw topThreeIdsError;
      }

      const topThreeIds = new Set((topThreeIdsRows || []).map((row) => row.id));
      const fetchLimit = Math.min(dueSoonLimit + topThreeIds.size, 100);

      const { data, error } = await supabase
        .from('tasks')
        .select(TASK_WITH_RELATIONS_SELECT)
        .eq('user_id', userId)
        .not('due_at', 'is', null)
        .lte('due_at', in48h.toISOString())
        .neq('status', 'Done')
        .neq('status', 'Parked')
        .order('due_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(fetchLimit);

      if (error) {
        throw error;
      }

      const filtered = normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>)
        .filter((task) => !topThreeIds.has(task.id))
        .slice(0, dueSoonLimit);
      return NextResponse.json(filtered);
    }

    if (view === 'waiting_summary') {
      const waitingLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
      const { data, error } = await supabase
        .from('tasks')
        .select('id, title, waiting_on, follow_up_at, priority_score')
        .eq('user_id', userId)
        .eq('status', 'Blocked/Waiting')
        .order('priority_score', { ascending: false })
        .order('id', { ascending: true })
        .limit(waitingLimit);

      if (error) {
        throw error;
      }

      return NextResponse.json((data || []).map((task) => ({
        id: task.id,
        title: task.title,
        waiting_on: task.waiting_on,
        follow_up_at: task.follow_up_at,
      })));
    }

    let query = supabase
      .from('tasks')
      .select(TASK_WITH_RELATIONS_SELECT)
      .eq('user_id', userId)
      .order('priority_score', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (needsReview === 'true') {
      query = query.eq('needs_review', true);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (implementationId) {
      query = query.eq('implementation_id', implementationId);
    }

    if (sprintId) {
      query = query.eq('sprint_id', sprintId);
    }

    if (tag) {
      query = query.contains('tags', [tag]);
    }

    const projectId = searchParams.get('project_id');
    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    if (sectionId) {
      query = query.eq('section_id', sectionId);
    }

    if (dueSoon === 'true') {
      const now = new Date();
      const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      query = query
        .not('due_at', 'is', null)
        .lte('due_at', in48h.toISOString())
        .neq('status', 'Done')
        .neq('status', 'Parked');
    }

    if (!includeDone && status !== 'Done') {
      query = query.neq('status', 'Done');
    }

    if (!includeParked && status !== 'Parked') {
      query = query.neq('status', 'Parked');
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const tasks = normalizeTaskWithRelationsList((data || []) as Array<Record<string, unknown>>);
    const taskIds = tasks.map((task) => task.id);
    const dependencyMap = await fetchTaskDependencySummaries(supabase, userId, taskIds);

    const enrichedTasks = tasks.map((task) => {
      const dependencies = dependencyMap.get(task.id) || [];
      return {
        ...task,
        dependencies,
        dependency_blocked: dependencies.some((dependency) => dependency.unresolved),
      };
    });

    return NextResponse.json(enrichedTasks);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    if (body.title.length > 500) {
      return NextResponse.json({ error: 'title must be 500 characters or fewer' }, { status: 400 });
    }

    if (typeof body.description === 'string' && body.description.length > 8000) {
      return NextResponse.json({ error: 'description must be 8000 characters or fewer' }, { status: 400 });
    }

    if (typeof body.pinned_excerpt === 'string' && body.pinned_excerpt.length > 2000) {
      return NextResponse.json({ error: 'pinned_excerpt must be 2000 characters or fewer' }, { status: 400 });
    }

    // Validate status if provided
    const statusInput = asStringOrNull(body.status);
    let status: TaskStatus = 'Backlog';
    if (statusInput) {
      if (!isValidStatus(statusInput)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
      status = statusInput;
    }

    // Validate task_type if provided
    const taskTypeInput = asStringOrNull(body.task_type);
    let taskType: TaskType = 'Admin';
    if (taskTypeInput) {
      if (!isValidTaskType(taskTypeInput)) {
        return NextResponse.json(
          { error: `Invalid task_type. Must be one of: ${VALID_TASK_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
      taskType = taskTypeInput;
    }

    // Validate estimate_source if provided
    const estimateSourceInput = asStringOrNull(body.estimate_source);
    let estimateSource: EstimateSource = 'default';
    if (estimateSourceInput) {
      if (!isValidEstimateSource(estimateSourceInput)) {
        return NextResponse.json(
          { error: `Invalid estimate_source. Must be one of: ${VALID_ESTIMATE_SOURCES.join(', ')}` },
          { status: 400 }
        );
      }
      estimateSource = estimateSourceInput;
    }

    // Validate and clamp numeric values
    const priorityScore = typeof body.priority_score === 'number'
      ? clampNumber(Math.round(body.priority_score), 0, 100)
      : 50;
    const estimatedMinutes = typeof body.estimated_minutes === 'number'
      ? clampNumber(Math.round(body.estimated_minutes), 1, 480)
      : 30;

    const implementationId = asStringOrNull(body.implementation_id);
    if (implementationId) {
      const { data: implementation, error: implementationError } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', implementationId)
        .eq('user_id', userId)
        .single();

      if (implementationError || !implementation) {
        return NextResponse.json({ error: 'application is invalid (implementation_id)' }, { status: 400 });
      }
    }

    const projectId = asStringOrNull(body.project_id);
    if (projectId) {
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('user_id', userId)
        .single();

      if (projectError || !project) {
        return NextResponse.json({ error: 'project_id is invalid' }, { status: 400 });
      }
    }

    const sectionId = asStringOrNull(body.section_id);
    try {
      await validateTaskSectionAssignment(supabase, userId, {
        project_id: projectId,
        section_id: sectionId,
      });
    } catch (error) {
      if (error instanceof ProjectSectionServiceError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const sprintId = asStringOrNull(body.sprint_id);
    if (sprintId) {
      const { data: sprint, error: sprintError } = await supabase
        .from('sprints')
        .select('id')
        .eq('id', sprintId)
        .eq('user_id', userId)
        .single();

      if (sprintError || !sprint) {
        return NextResponse.json({ error: 'sprint_id is invalid' }, { status: 400 });
      }
    }

    // Validate blocked_by_task_id if provided (for creating with dependency)
    const blockedByTaskId = asStringOrNull(body.blocked_by_task_id);
    if (blockedByTaskId) {
      const { data: blockerTask, error: blockerError } = await supabase
        .from('tasks')
        .select('id')
        .eq('id', blockedByTaskId)
        .eq('user_id', userId)
        .single();

      if (blockerError || !blockerTask) {
        return NextResponse.json({ error: 'blocked_by_task_id is invalid' }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: body.title.trim(),
        description: asStringOrNull(body.description),
        implementation_id: implementationId,
        project_id: projectId,
        section_id: sectionId,
        sprint_id: sprintId,
        status,
        task_type: taskType,
        priority_score: priorityScore,
        estimated_minutes: estimatedMinutes,
        estimate_source: estimateSource,
        due_at: asStringOrNull(body.due_at),
        needs_review: typeof body.needs_review === 'boolean' ? body.needs_review : false,
        blocker: typeof body.blocker === 'boolean' ? body.blocker : false,
        waiting_on: asStringOrNull(body.waiting_on),
        stakeholder_mentions: toStringArray(body.stakeholder_mentions),
        tags: normalizeTaskTags(body.tags),
        source_type: asStringOrNull(body.source_type) || 'Manual',
        source_url: asStringOrNull(body.source_url),
        pinned_excerpt: asStringOrNull(body.pinned_excerpt),
      })
      .select(TASK_WITH_RELATIONS_SELECT)
      .single();

    if (error) {
      throw error;
    }

    // Create dependency if blocked_by_task_id was provided
    if (blockedByTaskId && data) {
      await supabase.from('task_dependencies').insert({
        user_id: userId,
        task_id: data.id,
        depends_on_task_id: blockedByTaskId,
        depends_on_commitment_id: null,
      });
    }

    // Create initial comment if provided (useful for "blocked - reason" workflow)
    const initialComment = asStringOrNull(body.initial_comment);
    if (initialComment && data) {
      await supabase.from('task_comments').insert({
        user_id: userId,
        task_id: data.id,
        content: initialComment,
        source: 'manual',
      });
    }

    // Create initial checklist items if provided (from Quick Capture LLM extraction)
    const initialChecklist = Array.isArray(body.initial_checklist)
      ? (body.initial_checklist as unknown[])
          .filter((item): item is string => typeof item === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (initialChecklist.length > 0 && data) {
      const { error: checklistError } = await supabase
        .from('task_checklist_items')
        .insert(
          initialChecklist.map((text, index) => ({
            user_id: userId,
            task_id: data.id,
            text,
            is_done: false,
            sort_order: index,
          }))
        );

      if (checklistError) {
        console.error('Failed to create initial checklist items:', checklistError);
      }
    }

    if (data) {
      queueTaskStatusTransition(supabase, {
        userId,
        taskId: data.id,
        fromStatus: null,
        toStatus: status,
      });
    }

    return NextResponse.json(normalizeTaskWithRelations(data as Record<string, unknown>), { status: 201 });
  } catch (error) {
    console.error('Error creating task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
