import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { TaskStatus } from '@/types/database';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TASK_STATUS_ORDER: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done'];

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asDateOnlyOrNull(value: unknown): string | null {
  const normalized = asStringOrNull(value);
  if (!normalized || !DATE_ONLY_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
}

function isValidDateRange(startDate: string, endDate: string): boolean {
  return startDate <= endDate;
}

function createTaskGroups() {
  return TASK_STATUS_ORDER.reduce<Record<TaskStatus, Array<Record<string, unknown>>>>(
    (groups, status) => {
      groups[status] = [];
      return groups;
    },
    {
      Backlog: [],
      Planned: [],
      'In Progress': [],
      'Blocked/Waiting': [],
      Parked: [],
      Done: [],
    }
  );
}

// GET /api/sprints/[id] - Get sprint detail with grouped tasks and completion stats
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

    const { data: sprint, error: sprintError } = await supabase
      .from('sprints')
      .select('*, focus_implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (sprintError) {
      if (sprintError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Sprint not found' }, { status: 404 });
      }
      throw sprintError;
    }

    const { data: tasks, error: tasksError } = await supabase
      .from('tasks')
      .select('id, title, status, estimated_minutes, due_at, blocker, priority_score, updated_at')
      .eq('user_id', userId)
      .eq('sprint_id', id)
      .order('priority_score', { ascending: false })
      .order('updated_at', { ascending: false });

    if (tasksError) {
      throw tasksError;
    }

    const taskGroups = createTaskGroups();
    for (const task of tasks || []) {
      const status = task.status as TaskStatus;
      if (!taskGroups[status]) {
        continue;
      }

      taskGroups[status].push(task);
    }

    const totalTasks = (tasks || []).length;
    const completedTasks = taskGroups.Done.length;
    const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return NextResponse.json({
      ...sprint,
      total_tasks: totalTasks,
      completed_tasks: completedTasks,
      completion_pct: completionPct,
      tasks_by_status: taskGroups,
    });
  } catch (error) {
    console.error('Error fetching sprint:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/sprints/[id] - Update a sprint
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

    const allowedFields = ['name', 'start_date', 'end_date', 'theme', 'focus_implementation_id'];
    const updates: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (!(field in body)) {
        continue;
      }

      if (field === 'name') {
        updates[field] = typeof body.name === 'string' ? body.name.trim() : body.name;
      } else if (field === 'theme') {
        updates[field] = asStringOrNull(body.theme) || '';
      } else if (field === 'focus_implementation_id') {
        updates[field] = asStringOrNull(body.focus_implementation_id);
      } else {
        updates[field] = body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    if ('name' in updates && (typeof updates.name !== 'string' || updates.name.length === 0)) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    }

    if ('start_date' in updates) {
      const startDate = asDateOnlyOrNull(updates.start_date);
      if (!startDate) {
        return NextResponse.json({ error: 'start_date must be a valid YYYY-MM-DD string' }, { status: 400 });
      }
      updates.start_date = startDate;
    }

    if ('end_date' in updates) {
      const endDate = asDateOnlyOrNull(updates.end_date);
      if (!endDate) {
        return NextResponse.json({ error: 'end_date must be a valid YYYY-MM-DD string' }, { status: 400 });
      }
      updates.end_date = endDate;
    }

    const focusImplementationId = updates.focus_implementation_id;
    if (typeof focusImplementationId === 'string') {
      const { data: implementation, error: implementationError } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', focusImplementationId)
        .eq('user_id', userId)
        .single();

      if (implementationError || !implementation) {
        return NextResponse.json({ error: 'focus_implementation_id is invalid' }, { status: 400 });
      }
    }

    if ('start_date' in updates || 'end_date' in updates) {
      const { data: currentSprint, error: currentSprintError } = await supabase
        .from('sprints')
        .select('start_date, end_date')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (currentSprintError) {
        if (currentSprintError.code === 'PGRST116') {
          return NextResponse.json({ error: 'Sprint not found' }, { status: 404 });
        }
        throw currentSprintError;
      }

      const startDate = (updates.start_date as string | undefined) || currentSprint.start_date;
      const endDate = (updates.end_date as string | undefined) || currentSprint.end_date;
      if (!isValidDateRange(startDate, endDate)) {
        return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('sprints')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, focus_implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Sprint not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating sprint:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/sprints/[id] - Delete a sprint
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
      .from('sprints')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Sprint not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting sprint:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
