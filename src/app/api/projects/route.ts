import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_PROJECT_STAGE, PROJECT_STAGE_VALUES, normalizeProjectStage } from '@/lib/project-stage';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface ProjectTaskStats {
  openTaskCount: number;
  completedTaskCount: number;
  totalTaskCount: number;
  blockersCount: number;
}

interface ProjectTaskRow {
  project_id: string | null;
  status: string;
  blocker: boolean | null;
}

function createEmptyProjectTaskStats(): ProjectTaskStats {
  return {
    openTaskCount: 0,
    completedTaskCount: 0,
    totalTaskCount: 0,
    blockersCount: 0,
  };
}

async function getNextPortfolioRank(
  supabase: SupabaseClient,
  userId: string,
  implementationId: string | null
): Promise<number> {
  let query = supabase
    .from('projects')
    .select('portfolio_rank')
    .eq('user_id', userId)
    .order('portfolio_rank', { ascending: false })
    .limit(1);

  if (implementationId) {
    query = query.eq('implementation_id', implementationId);
  }

  const { data } = await query;
  const value = data?.[0]?.portfolio_rank;
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Number(value) + 1;
}

function withNormalizedProjectStage<T extends Record<string, unknown>>(project: T): T & { stage: string } {
  const rest = { ...project } as T & { phase?: unknown };
  delete rest.phase;
  const normalizedStage = normalizeProjectStage(project.stage) ?? DEFAULT_PROJECT_STAGE;
  return {
    ...rest,
    stage: normalizedStage,
  };
}

// GET /api/projects - List projects
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const implementationId = searchParams.get('implementation_id');
    const withStats = searchParams.get('with_stats') === 'true';

    let query = supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('portfolio_rank', { ascending: true })
      .order('name', { ascending: true });

    if (implementationId) {
      query = query.eq('implementation_id', implementationId);
    }

    const { data: projects, error } = await query;
    if (error) throw error;

    if (!withStats) {
      return NextResponse.json((projects || []).map((project) => withNormalizedProjectStage(project)));
    }

    const projectList = projects || [];
    if (projectList.length === 0) {
      return NextResponse.json([]);
    }

    const projectIds = projectList.map((project) => project.id);
    const implementationIds = [...new Set(
      projectList
        .map((project) => project.implementation_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )];

    const [
      { data: taskRows, error: taskError },
      { data: implementationRows, error: implementationError },
    ] = await Promise.all([
      supabase
        .from('tasks')
        .select('project_id, status, blocker')
        .eq('user_id', userId)
        .in('project_id', projectIds),
      implementationIds.length > 0
        ? supabase
            .from('implementations')
            .select('id, name, phase, rag, portfolio_rank')
            .eq('user_id', userId)
            .in('id', implementationIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (taskError) throw taskError;
    if (implementationError) throw implementationError;

    const statsByProject = new Map<string, ProjectTaskStats>(
      projectIds.map((projectId) => [projectId, createEmptyProjectTaskStats()])
    );

    for (const task of (taskRows || []) as ProjectTaskRow[]) {
      if (!task.project_id) {
        continue;
      }

      const stats = statsByProject.get(task.project_id);
      if (!stats) {
        continue;
      }

      const isDone = task.status === 'Done';
      const isParked = task.status === 'Parked';

      if (!isDone) {
        stats.openTaskCount += 1;
      }

      if (!isParked) {
        stats.totalTaskCount += 1;
        if (isDone) {
          stats.completedTaskCount += 1;
        }
      }

      if (task.blocker && !isDone) {
        stats.blockersCount += 1;
      }
    }

    const implementationsById = new Map(
      (implementationRows || []).map((implementation) => [implementation.id, implementation])
    );

    const enriched = projectList.map((project) => {
      const stats = statsByProject.get(project.id) ?? createEmptyProjectTaskStats();

      return {
        ...withNormalizedProjectStage(project),
        open_task_count: stats.openTaskCount,
        completed_task_count: stats.completedTaskCount,
        total_task_count: stats.totalTaskCount,
        blockers_count: stats.blockersCount,
        implementation:
          typeof project.implementation_id === 'string'
            ? implementationsById.get(project.implementation_id) ?? null
            : null,
      };
    });

    return NextResponse.json(enriched);
  } catch (error) {
    console.error('Error fetching projects:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/projects - Create a project
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const implementationId =
      typeof body.implementation_id === 'string' ? body.implementation_id : null;
    const hasStageInput = Object.prototype.hasOwnProperty.call(body, 'stage');
    const normalizedStage = hasStageInput ? normalizeProjectStage(body.stage) : null;

    // Validate implementation belongs to user if provided
    if (implementationId) {
      const { data: impl } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', implementationId)
        .eq('user_id', userId)
        .single();
      if (!impl) {
        return NextResponse.json({ error: 'Implementation not found' }, { status: 400 });
      }
    }

    if (hasStageInput && !normalizedStage) {
      return NextResponse.json(
        { error: `Invalid stage. Must be one of: ${PROJECT_STAGE_VALUES.join(', ')}` },
        { status: 400 }
      );
    }

    const nextRank = await getNextPortfolioRank(supabase, userId, implementationId);

    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      name: body.name.trim(),
      implementation_id: implementationId,
      stage: normalizedStage ?? DEFAULT_PROJECT_STAGE,
      rag: typeof body.rag === 'string' ? body.rag : 'Green',
      target_date: typeof body.target_date === 'string' ? body.target_date : null,
      servicenow_spm_id: typeof body.servicenow_spm_id === 'string' ? body.servicenow_spm_id.trim() || null : null,
      status_summary: typeof body.status_summary === 'string' ? body.status_summary : '',
      description: typeof body.description === 'string' ? body.description || null : null,
      portfolio_rank: typeof body.portfolio_rank === 'number' ? body.portfolio_rank : nextRank,
    };

    const { data, error } = await supabase
      .from('projects')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(withNormalizedProjectStage(data), { status: 201 });
  } catch (error) {
    console.error('Error creating project:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
