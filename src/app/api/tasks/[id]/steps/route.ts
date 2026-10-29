import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { loadTaskSteps } from '@/lib/break-into-tasks-service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/tasks/[id]/steps — the umbrella links of a task (Break into tasks,
 * migration 066): `part_of` (the task it was broken out of), `step_tasks` and
 * `steps_progress` (when it is an umbrella). Used by the task window.
 */
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
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const { data: task, error } = await supabase
      .from('tasks')
      .select('id, parent_task_id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json(await loadTaskSteps(supabase, userId, id, (task as { parent_task_id: string | null }).parent_task_id));
  } catch (error) {
    console.error('Error loading task steps:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
