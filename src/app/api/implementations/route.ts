import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

// GET /api/implementations - List all implementations
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const withStats = searchParams.get('with_stats') === 'true';

    if (withStats) {
      const { data: implementations, error } = await supabase
        .from('implementations')
        .select('*')
        .eq('user_id', userId)
        .order('name');

      if (error) throw error;

      const enriched = await Promise.all(
        (implementations || []).map(async (impl) => {
          const { count: blockersCount } = await supabase
            .from('tasks')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('implementation_id', impl.id)
            .eq('blocker', true)
            .neq('status', 'Done');

          const { data: nextAction } = await supabase
            .from('tasks')
            .select('id, title')
            .eq('user_id', userId)
            .eq('implementation_id', impl.id)
            .neq('status', 'Done')
            .order('priority_score', { ascending: false })
            .limit(1)
            .single();

          return {
            ...impl,
            blockers_count: blockersCount || 0,
            next_action: nextAction || null,
          };
        })
      );

      return NextResponse.json(enriched);
    }

    const { data, error } = await supabase
      .from('implementations')
      .select('id, name, phase, rag')
      .eq('user_id', userId)
      .order('name');

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching implementations:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/implementations - Create a new implementation
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

    const { data, error } = await supabase
      .from('implementations')
      .insert({
        user_id: userId,
        name: body.name.trim(),
        phase: typeof body.phase === 'string' ? body.phase : 'Intake',
        rag: typeof body.rag === 'string' ? body.rag : 'Green',
        target_date: typeof body.target_date === 'string' ? body.target_date : null,
        status_summary: typeof body.status_summary === 'string' ? body.status_summary : '',
        next_milestone: typeof body.next_milestone === 'string' ? body.next_milestone : '',
        next_milestone_date: typeof body.next_milestone_date === 'string' ? body.next_milestone_date : null,
        stakeholders: toStringArray(body.stakeholders),
        keywords: toStringArray(body.keywords),
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating implementation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
