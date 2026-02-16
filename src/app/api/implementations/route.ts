import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

// GET /api/implementations - List all implementations
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const { searchParams } = new URL(request.url);

    const withStats = searchParams.get('with_stats') === 'true';

    if (withStats) {
      // Fetch implementations with blocker counts and next action
      const { data: implementations, error } = await supabase
        .from('implementations')
        .select('*')
        .order('name');

      if (error) throw error;

      // Fetch blocker counts and next actions for each
      const enriched = await Promise.all(
        (implementations || []).map(async (impl) => {
          // Get blocker count
          const { count: blockersCount } = await supabase
            .from('tasks')
            .select('*', { count: 'exact', head: true })
            .eq('implementation_id', impl.id)
            .eq('blocker', true)
            .neq('status', 'Done');

          // Get next action (highest priority open task)
          const { data: nextAction } = await supabase
            .from('tasks')
            .select('id, title')
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

    // Simple list without stats
    const { data, error } = await supabase
      .from('implementations')
      .select('id, name, phase, rag')
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
    const supabase = getSupabaseClient();
    const body = await request.json();

    if (!body.name || !body.user_id) {
      return NextResponse.json(
        { error: 'name and user_id are required' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('implementations')
      .insert({
        user_id: body.user_id,
        name: body.name,
        phase: body.phase || 'Intake',
        rag: body.rag || 'Green',
        target_date: body.target_date || null,
        status_summary: body.status_summary || '',
        next_milestone: body.next_milestone || '',
        next_milestone_date: body.next_milestone_date || null,
        stakeholders: body.stakeholders || [],
        keywords: body.keywords || [],
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
