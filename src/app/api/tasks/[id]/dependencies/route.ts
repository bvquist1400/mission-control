import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

// GET /api/tasks/[id]/dependencies - Get dependencies for a task
// Returns both: tasks blocking this one, and tasks this one blocks
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

    // Get tasks that block this task (this task is blocked BY these)
    const { data: blockedBy, error: blockedByError } = await supabase
      .from('task_dependencies')
      .select(`
        id,
        blocker_task_id,
        blocked_task_id,
        created_at,
        blocker_task:tasks!task_dependencies_blocker_task_id_fkey(
          id, title, status, blocker,
          implementation:implementations(id, name)
        )
      `)
      .eq('blocked_task_id', id)
      .eq('user_id', userId);

    if (blockedByError) {
      throw blockedByError;
    }

    // Get tasks that this task blocks (these are blocked BY this task)
    const { data: blocking, error: blockingError } = await supabase
      .from('task_dependencies')
      .select(`
        id,
        blocker_task_id,
        blocked_task_id,
        created_at,
        blocked_task:tasks!task_dependencies_blocked_task_id_fkey(
          id, title, status, blocker,
          implementation:implementations(id, name)
        )
      `)
      .eq('blocker_task_id', id)
      .eq('user_id', userId);

    if (blockingError) {
      throw blockingError;
    }

    return NextResponse.json({
      blocked_by: blockedBy || [],
      blocking: blocking || [],
    });
  } catch (error) {
    console.error('Error fetching dependencies:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/dependencies - Add a dependency
// This task will be blocked BY the specified blocker_task_id
export async function POST(
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

    if (typeof body.blocker_task_id !== 'string') {
      return NextResponse.json({ error: 'blocker_task_id is required' }, { status: 400 });
    }

    const blockerTaskId = body.blocker_task_id;

    // Prevent self-dependency
    if (blockerTaskId === id) {
      return NextResponse.json({ error: 'A task cannot block itself' }, { status: 400 });
    }

    // Verify both tasks exist and belong to user
    const { data: tasks, error: tasksError } = await supabase
      .from('tasks')
      .select('id')
      .eq('user_id', userId)
      .in('id', [id, blockerTaskId]);

    if (tasksError) {
      throw tasksError;
    }

    if (!tasks || tasks.length !== 2) {
      return NextResponse.json({ error: 'One or both tasks not found' }, { status: 404 });
    }

    // Check for existing dependency
    const { data: existing } = await supabase
      .from('task_dependencies')
      .select('id')
      .eq('blocker_task_id', blockerTaskId)
      .eq('blocked_task_id', id)
      .eq('user_id', userId)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Dependency already exists' }, { status: 409 });
    }

    // Check for circular dependency (would the blocker task be blocked by this task?)
    const { data: circular } = await supabase
      .from('task_dependencies')
      .select('id')
      .eq('blocker_task_id', id)
      .eq('blocked_task_id', blockerTaskId)
      .eq('user_id', userId)
      .single();

    if (circular) {
      return NextResponse.json(
        { error: 'Cannot create circular dependency' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('task_dependencies')
      .insert({
        user_id: userId,
        blocker_task_id: blockerTaskId,
        blocked_task_id: id,
      })
      .select(`
        id,
        blocker_task_id,
        blocked_task_id,
        created_at,
        blocker_task:tasks!task_dependencies_blocker_task_id_fkey(
          id, title, status, blocker,
          implementation:implementations(id, name)
        )
      `)
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating dependency:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/dependencies - Remove a dependency
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
    const { searchParams } = new URL(request.url);
    const dependencyId = searchParams.get('dependencyId');

    if (!dependencyId) {
      return NextResponse.json({ error: 'dependencyId query param required' }, { status: 400 });
    }

    // Verify the dependency involves this task (either as blocker or blocked)
    const { data, error } = await supabase
      .from('task_dependencies')
      .delete()
      .eq('id', dependencyId)
      .eq('user_id', userId)
      .or(`blocker_task_id.eq.${id},blocked_task_id.eq.${id}`)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Dependency not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting dependency:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
