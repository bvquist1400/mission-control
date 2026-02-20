import { NextRequest, NextResponse } from 'next/server';
import { recalculateTaskPriority } from '@/lib/priority';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { TaskStatus, TaskType } from '@/types/database';

const VALID_STATUSES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Done'];
const VALID_TASK_TYPES: TaskType[] = ['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'];

function isValidStatus(value: string): value is TaskStatus {
  return VALID_STATUSES.includes(value as TaskStatus);
}

function isValidTaskType(value: string): value is TaskType {
  return VALID_TASK_TYPES.includes(value as TaskType);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/tasks/[id] - Get a single task
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

    const { data, error } = await supabase
      .from('tasks')
      .select('*, implementation:implementations(id, name)')
      .eq('id', id)
      .eq('user_id', userId)
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
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const allowedFields = [
      'title',
      'description',
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

    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!(field in body)) {
        continue;
      }

      const value = body[field];
      if (field === 'implementation_id') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'waiting_on') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'description') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'title' && typeof value === 'string') {
        updates[field] = value.trim();
      } else {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    if ('title' in updates && (typeof updates.title !== 'string' || updates.title.length === 0)) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
    }

    if ('description' in updates && typeof updates.description === 'string' && updates.description.length > 8000) {
      return NextResponse.json({ error: 'description must be 8000 characters or fewer' }, { status: 400 });
    }

    if ('status' in updates) {
      const status = updates.status;
      if (typeof status !== 'string' || !isValidStatus(status)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    if ('task_type' in updates) {
      const taskType = updates.task_type;
      if (typeof taskType !== 'string' || !isValidTaskType(taskType)) {
        return NextResponse.json(
          { error: `Invalid task_type. Must be one of: ${VALID_TASK_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    const implementationId = updates.implementation_id;
    if (typeof implementationId === 'string') {
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

    const needsPriorityRecalc = 'status' in updates || 'due_at' in updates;

    if (needsPriorityRecalc) {
      const { data: currentTask, error: fetchError } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
        throw fetchError;
      }

      const mergedTask = { ...currentTask, ...updates };
      updates.priority_score = recalculateTaskPriority(mergedTask);
    }

    if ('estimated_minutes' in updates && !('estimate_source' in updates)) {
      updates.estimate_source = 'manual';
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
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
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
