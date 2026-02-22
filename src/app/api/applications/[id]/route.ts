import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

// GET /api/applications/[id] - Get a single application with stats
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { data: implementation, error: implError } = await supabase
      .from('implementations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (implError) {
      if (implError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Application not found' }, { status: 404 });
      }
      throw implError;
    }

    const { count: blockersCount } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('implementation_id', id)
      .eq('blocker', true)
      .neq('status', 'Done');

    const { data: openTasks } = await supabase
      .from('tasks')
      .select('id, title, status, estimated_minutes, due_at, blocker, priority_score')
      .eq('user_id', userId)
      .eq('implementation_id', id)
      .neq('status', 'Done')
      .order('priority_score', { ascending: false })
      .limit(10);

    const { data: recentDoneTasks } = await supabase
      .from('tasks')
      .select('id, title, status, estimated_minutes, due_at, blocker, updated_at')
      .eq('user_id', userId)
      .eq('implementation_id', id)
      .eq('status', 'Done')
      .order('updated_at', { ascending: false })
      .limit(5);

    return NextResponse.json({
      ...implementation,
      blockers_count: blockersCount || 0,
      open_tasks: openTasks || [],
      recent_done_tasks: recentDoneTasks || [],
    });
  } catch (error) {
    console.error('Error fetching implementation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/applications/[id] - Update an application
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const allowedFields = [
      'name',
      'phase',
      'rag',
      'target_date',
      'status_summary',
      'next_milestone',
      'next_milestone_date',
      'stakeholders',
      'keywords',
      'priority_weight',
      'priority_note',
      'portfolio_rank',
    ];

    if (typeof body.name === 'string' && body.name.length > 200) {
      return NextResponse.json({ error: 'name must be 200 characters or fewer' }, { status: 400 });
    }

    if (typeof body.status_summary === 'string' && body.status_summary.length > 2000) {
      return NextResponse.json({ error: 'status_summary must be 2000 characters or fewer' }, { status: 400 });
    }

    if ('priority_note' in body && typeof body.priority_note === 'string' && body.priority_note.length > 2000) {
      return NextResponse.json({ error: 'priority_note must be 2000 characters or fewer' }, { status: 400 });
    }

    if ('priority_weight' in body) {
      const value = body.priority_weight;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return NextResponse.json({ error: 'priority_weight must be a number between 0 and 10' }, { status: 400 });
      }
      if (Math.round(value) < 0 || Math.round(value) > 10) {
        return NextResponse.json({ error: 'priority_weight must be between 0 and 10' }, { status: 400 });
      }
    }

    if ('portfolio_rank' in body) {
      const value = body.portfolio_rank;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return NextResponse.json({ error: 'portfolio_rank must be a positive integer' }, { status: 400 });
      }
      if (Math.round(value) < 1) {
        return NextResponse.json({ error: 'portfolio_rank must be a positive integer' }, { status: 400 });
      }
    }

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!(field in body)) {
        continue;
      }

      const value = body[field];
      if (field === 'name' && typeof value === 'string') {
        updates[field] = value.trim();
      } else if (field === 'priority_weight' && typeof value === 'number') {
        updates[field] = Math.max(0, Math.min(10, Math.round(value)));
      } else if (field === 'portfolio_rank' && typeof value === 'number') {
        updates[field] = Math.max(1, Math.round(value));
      } else if ((field === 'stakeholders' || field === 'keywords') && value !== undefined) {
        updates[field] = toStringArray(value);
      } else {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('implementations')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Application not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating implementation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
