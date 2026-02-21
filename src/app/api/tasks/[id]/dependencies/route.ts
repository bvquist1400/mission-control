import { NextRequest, NextResponse } from 'next/server';
import { fetchTaskDependenciesForTask } from '@/lib/task-dependencies';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { CommitmentStatus, TaskStatus } from '@/types/database';

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/tasks/[id]/dependencies - Get dependencies for a task
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

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (taskError || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const dependencies = await fetchTaskDependenciesForTask(supabase, userId, id);

    return NextResponse.json({ dependencies });
  } catch (error) {
    console.error('Error fetching dependencies:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/dependencies - Add a dependency (task or commitment)
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

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (taskError || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const requestedType = asStringOrNull(body.type);
    const dependsOnTaskId = asStringOrNull(body.depends_on_task_id ?? body.blocker_task_id);
    const dependsOnCommitmentId = asStringOrNull(body.depends_on_commitment_id);

    const providedTargetCount = Number(Boolean(dependsOnTaskId)) + Number(Boolean(dependsOnCommitmentId));
    if (providedTargetCount !== 1) {
      return NextResponse.json(
        { error: 'Provide exactly one dependency target: depends_on_task_id or depends_on_commitment_id' },
        { status: 400 }
      );
    }

    let type: 'task' | 'commitment' | null = null;
    if (requestedType === 'task' || requestedType === 'commitment') {
      type = requestedType;
    } else if (dependsOnTaskId) {
      type = 'task';
    } else if (dependsOnCommitmentId) {
      type = 'commitment';
    }

    if (!type) {
      return NextResponse.json({ error: 'type must be task or commitment' }, { status: 400 });
    }

    if (type === 'task' && !dependsOnTaskId) {
      return NextResponse.json({ error: 'depends_on_task_id is required for task dependencies' }, { status: 400 });
    }

    if (type === 'commitment' && !dependsOnCommitmentId) {
      return NextResponse.json(
        { error: 'depends_on_commitment_id is required for commitment dependencies' },
        { status: 400 }
      );
    }

    let targetTitle = '';
    let targetStatus: TaskStatus | CommitmentStatus = 'Done';

    if (type === 'task' && dependsOnTaskId) {
      if (dependsOnTaskId === id) {
        return NextResponse.json({ error: 'A task cannot depend on itself' }, { status: 400 });
      }

      const { data: dependencyTask, error: dependencyTaskError } = await supabase
        .from('tasks')
        .select('id, title, status')
        .eq('id', dependsOnTaskId)
        .eq('user_id', userId)
        .single();

      if (dependencyTaskError || !dependencyTask) {
        return NextResponse.json({ error: 'Dependency task not found' }, { status: 404 });
      }

      targetTitle = dependencyTask.title;
      targetStatus = dependencyTask.status as TaskStatus;
    }

    if (type === 'commitment' && dependsOnCommitmentId) {
      const { data: dependencyCommitment, error: dependencyCommitmentError } = await supabase
        .from('commitments')
        .select('id, title, status')
        .eq('id', dependsOnCommitmentId)
        .eq('user_id', userId)
        .single();

      if (dependencyCommitmentError || !dependencyCommitment) {
        return NextResponse.json({ error: 'Dependency commitment not found' }, { status: 404 });
      }

      targetTitle = dependencyCommitment.title;
      targetStatus = dependencyCommitment.status as CommitmentStatus;
    }

    let existingQuery = supabase
      .from('task_dependencies')
      .select('id')
      .eq('task_id', id)
      .eq('user_id', userId);

    if (type === 'task') {
      existingQuery = existingQuery.eq('depends_on_task_id', dependsOnTaskId).is('depends_on_commitment_id', null);
    } else {
      existingQuery = existingQuery.eq('depends_on_commitment_id', dependsOnCommitmentId).is('depends_on_task_id', null);
    }

    const { data: existing, error: existingError } = await existingQuery.maybeSingle();
    if (existingError) {
      throw existingError;
    }

    if (existing) {
      return NextResponse.json({ error: 'Dependency already exists' }, { status: 409 });
    }

    const { data, error } = await supabase
      .from('task_dependencies')
      .insert({
        user_id: userId,
        task_id: id,
        depends_on_task_id: type === 'task' ? dependsOnTaskId : null,
        depends_on_commitment_id: type === 'commitment' ? dependsOnCommitmentId : null,
      })
      .select('id, task_id, depends_on_task_id, depends_on_commitment_id, created_at')
      .single();

    if (error) {
      throw error;
    }

    const dependencies = await fetchTaskDependenciesForTask(supabase, userId, id);
    const created = dependencies.find((dependency) => dependency.id === data.id);

    if (created) {
      return NextResponse.json(created, { status: 201 });
    }

    return NextResponse.json(
      {
        id: data.id,
        task_id: id,
        depends_on_task_id: type === 'task' ? dependsOnTaskId : null,
        depends_on_commitment_id: type === 'commitment' ? dependsOnCommitmentId : null,
        type,
        title: targetTitle,
        status: targetStatus,
        unresolved: targetStatus !== 'Done',
        created_at: data.created_at,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating dependency:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/dependencies?dependencyId=... - Legacy fallback route
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

    const { data, error } = await supabase
      .from('task_dependencies')
      .delete()
      .eq('id', dependencyId)
      .eq('task_id', id)
      .eq('user_id', userId)
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
