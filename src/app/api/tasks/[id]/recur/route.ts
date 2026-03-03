import { NextRequest, NextResponse } from 'next/server';
import { coerceTaskRecurrence, normalizeTaskRecurrenceInput } from '@/lib/recurrence';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function isGeneratedRecurringInstance(taskId: string, recurrence: unknown): boolean {
  const normalized = coerceTaskRecurrence(recurrence);
  return normalized !== null && !normalized.enabled && normalized.template_task_id !== null && normalized.template_task_id !== taskId;
}

// POST /api/tasks/[id]/recur - Configure recurrence for a task template
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

    const { data: currentTask, error: currentTaskError } = await supabase
      .from('tasks')
      .select('id, user_id, title, status, due_at, recurrence')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (currentTaskError) {
      if (currentTaskError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      throw currentTaskError;
    }

    if (isGeneratedRecurringInstance(id, currentTask.recurrence)) {
      return NextResponse.json(
        { error: 'Recurring instances cannot be edited. Configure recurrence on the template task.' },
        { status: 400 }
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const recurrenceInput = Object.prototype.hasOwnProperty.call(body, 'recurrence') ? body.recurrence : body;
    const { recurrence, error } = normalizeTaskRecurrenceInput(recurrenceInput, id, currentTask.due_at);

    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }

    const updates: Record<string, unknown> = {
      recurrence,
    };

    if (recurrence !== null && currentTask.status !== 'Done') {
      updates.status = 'Parked';
      updates.sprint_id = null;
    }

    const { data, error: updateError } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date)')
      .single();

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error configuring recurring task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/recur - Remove recurrence from a task template
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

    const { data: currentTask, error: currentTaskError } = await supabase
      .from('tasks')
      .select('id, recurrence')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (currentTaskError) {
      if (currentTaskError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      throw currentTaskError;
    }

    if (isGeneratedRecurringInstance(id, currentTask.recurrence)) {
      return NextResponse.json(
        { error: 'Recurring instances cannot be edited. Configure recurrence on the template task.' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('tasks')
      .update({ recurrence: null })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date)')
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error removing recurring task configuration:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
