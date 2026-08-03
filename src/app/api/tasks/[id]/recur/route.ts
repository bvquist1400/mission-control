import { NextRequest, NextResponse } from 'next/server';
import {
  buildClearTaskRecurrenceUpdates,
  coerceTaskRecurrence,
  normalizeTaskRecurrenceInput,
} from '@/lib/recurrence';
import { generateRecurringTasks } from '@/lib/recurring-task-generator';
import {
  normalizeTaskWithRelations,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import { queueTaskStatusTransition } from '@/lib/task-status-transitions';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function isGeneratedRecurringInstance(
  taskId: string,
  recurrence: unknown,
  recurringTemplateId: string | null
): boolean {
  if (recurringTemplateId && recurringTemplateId !== taskId) {
    return true;
  }

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
      .select('id, user_id, title, status, due_at, recurrence, recurring_template_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (currentTaskError) {
      if (currentTaskError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      throw currentTaskError;
    }

    if (isGeneratedRecurringInstance(id, currentTask.recurrence, currentTask.recurring_template_id)) {
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
    const { recurrence, error } = normalizeTaskRecurrenceInput(
      recurrenceInput,
      id,
      currentTask.due_at,
      currentTask.recurrence
    );

    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }

    const updates: Record<string, unknown> = {
      recurrence,
      is_recurring_template: recurrence !== null,
      recurring_template_id: null,
    };

    if (recurrence !== null && currentTask.status !== 'Done') {
      updates.status = 'Parked';
      updates.sprint_id = null;
    }

    const { error: updateError } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)

    if (updateError) {
      throw updateError;
    }

    if (typeof updates.status === 'string' && currentTask.status !== updates.status) {
      queueTaskStatusTransition(supabase, {
        userId,
        taskId: id,
        fromStatus: currentTask.status,
        toStatus: updates.status as typeof currentTask.status,
      });
    }

    const generationResult = recurrence !== null
      ? await generateRecurringTasks(supabase, { userId, templateTaskId: id })
      : null;

    const { data: refreshedTask, error: refreshedTaskError } = await supabase
      .from('tasks')
      .select(TASK_WITH_RELATIONS_SELECT)
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (refreshedTaskError) {
      throw refreshedTaskError;
    }

    return NextResponse.json({
      ...normalizeTaskWithRelations(refreshedTask as Record<string, unknown>),
      recurrence_generation: generationResult,
    });
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
      .select('id, status, recurrence, recurring_template_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (currentTaskError) {
      if (currentTaskError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      throw currentTaskError;
    }

    if (isGeneratedRecurringInstance(id, currentTask.recurrence, currentTask.recurring_template_id)) {
      return NextResponse.json(
        { error: 'Recurring instances cannot be edited. Configure recurrence on the template task.' },
        { status: 400 }
      );
    }

    const markDoneFromQuery = request.nextUrl.searchParams.get('mark_done') === 'true';
    let markDoneFromBody = false;
    try {
      const body = (await request.json()) as Record<string, unknown>;
      markDoneFromBody = body.mark_done === true;
    } catch {
      // DELETE bodies are optional; query-string callers remain supported.
    }
    const markDone = markDoneFromQuery || markDoneFromBody;
    const updates = buildClearTaskRecurrenceUpdates(markDone);

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select(TASK_WITH_RELATIONS_SELECT)
      .single();

    if (error) {
      throw error;
    }

    if (markDone && currentTask.status !== 'Done') {
      queueTaskStatusTransition(supabase, {
        userId,
        taskId: id,
        fromStatus: currentTask.status,
        toStatus: 'Done',
      });
    }

    return NextResponse.json(normalizeTaskWithRelations(data as Record<string, unknown>));
  } catch (error) {
    console.error('Error removing recurring task configuration:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
