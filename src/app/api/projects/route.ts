import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

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
      return NextResponse.json(projects || []);
    }

    // Enrich with open_task_count and implementation name
    const enriched = await Promise.all(
      (projects || []).map(async (project) => {
        const { count: openTaskCount } = await supabase
          .from('tasks')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('project_id', project.id)
          .neq('status', 'Done');

        let implementation = null;
        if (project.implementation_id) {
          const { data: impl } = await supabase
            .from('implementations')
            .select('id, name, phase, rag, portfolio_rank')
            .eq('id', project.implementation_id)
            .single();
          implementation = impl || null;
        }

        return {
          ...project,
          open_task_count: openTaskCount || 0,
          implementation,
        };
      })
    );

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

    const nextRank = await getNextPortfolioRank(supabase, userId, implementationId);

    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      name: body.name.trim(),
      implementation_id: implementationId,
      phase: typeof body.phase === 'string' ? body.phase : 'Intake',
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

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating project:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
