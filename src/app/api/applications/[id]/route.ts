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
    ];

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!(field in body)) {
        continue;
      }

      const value = body[field];
      if (field === 'name' && typeof value === 'string') {
        updates[field] = value.trim();
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
