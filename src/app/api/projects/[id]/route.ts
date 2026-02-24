import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

// GET /api/projects/[id] - Get a single project with stats
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

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (projectError) {
      if (projectError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      throw projectError;
    }

    const { count: blockersCount } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('project_id', id)
      .eq('blocker', true)
      .neq('status', 'Done');

    const { data: openTasks } = await supabase
      .from('tasks')
      .select('id, title, status, estimated_minutes, due_at, blocker, priority_score')
      .eq('user_id', userId)
      .eq('project_id', id)
      .neq('status', 'Done')
      .order('priority_score', { ascending: false })
      .limit(10);

    let implementation = null;
    if (project.implementation_id) {
      const { data: impl } = await supabase
        .from('implementations')
        .select('id, name, phase, rag, portfolio_rank')
        .eq('id', project.implementation_id)
        .single();
      implementation = impl || null;
    }

    return NextResponse.json({
      ...project,
      blockers_count: blockersCount || 0,
      open_tasks: openTasks || [],
      implementation,
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/projects/[id] - Update a project
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
      'description',
      'implementation_id',
      'phase',
      'rag',
      'target_date',
      'servicenow_spm_id',
      'status_summary',
      'portfolio_rank',
    ];

    if (typeof body.name === 'string' && body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    }

    if (typeof body.name === 'string' && body.name.length > 200) {
      return NextResponse.json({ error: 'name must be 200 characters or fewer' }, { status: 400 });
    }

    if (typeof body.status_summary === 'string' && body.status_summary.length > 2000) {
      return NextResponse.json({ error: 'status_summary must be 2000 characters or fewer' }, { status: 400 });
    }

    if ('portfolio_rank' in body) {
      const value = body.portfolio_rank;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) < 1) {
        return NextResponse.json({ error: 'portfolio_rank must be a positive integer' }, { status: 400 });
      }
    }

    // Validate implementation_id if being changed
    if ('implementation_id' in body && body.implementation_id !== null) {
      const { data: impl } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', body.implementation_id)
        .eq('user_id', userId)
        .single();
      if (!impl) {
        return NextResponse.json({ error: 'Implementation not found' }, { status: 400 });
      }
    }

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!(field in body)) continue;
      const value = body[field];

      if (field === 'name' && typeof value === 'string') {
        updates[field] = value.trim();
      } else if (field === 'portfolio_rank' && typeof value === 'number') {
        updates[field] = Math.max(1, Math.round(value));
      } else if (field === 'servicenow_spm_id' && typeof value === 'string') {
        updates[field] = value.trim() || null;
      } else {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating project:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/projects/[id] - Delete a project
export async function DELETE(
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

    const { error, count } = await supabase
      .from('projects')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;
    if (!count) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
