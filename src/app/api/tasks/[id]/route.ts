import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { recalculateTaskPriority } from '@/lib/priority';

// Create Supabase client with service role for API routes
function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

// GET /api/tasks/[id] - Get a single task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('tasks')
      .select('*, implementation:implementations(id, name)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const supabase = getSupabaseClient();

    // Allowed fields for update
    const allowedFields = [
      'title',
      'implementation_id',
      'status',
      'task_type',
      'estimated_minutes',
      'estimate_source',
      'due_at',
      'needs_review',
      'blocker',
      'waiting_on',
      'follow_up_at',
      'pinned_excerpt',
    ];

    // Filter to only allowed fields
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (field in body) {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // If status, due_at, or stakeholder_mentions changed, recalculate priority
    const needsPriorityRecalc =
      'status' in updates || 'due_at' in updates;

    if (needsPriorityRecalc) {
      // Fetch current task to get all fields needed for priority calc
      const { data: currentTask, error: fetchError } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      // Merge updates with current task and recalculate
      const mergedTask = { ...currentTask, ...updates };
      updates.priority_score = recalculateTaskPriority(mergedTask);
    }

    // If estimate changed manually, update source
    if ('estimated_minutes' in updates && !('estimate_source' in updates)) {
      updates.estimate_source = 'manual';
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select('*, implementation:implementations(id, name)')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = getSupabaseClient();

    const { error } = await supabase.from('tasks').delete().eq('id', id);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
