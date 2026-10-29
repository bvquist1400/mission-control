import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { breakTaskIntoTasks, undoBreakTaskIntoTasks } from '@/lib/break-into-tasks-service';

/**
 * POST /api/tasks/[id]/break — "Break into tasks" (Baseline task d1f7e622).
 * Body `{ destination, steps }` creates the step tasks in one transaction
 * (migration 066); `{ action: "undo", task_ids, section_id, project_id,
 * umbrella_comment_id }` takes them back (the toast's Undo). Not on the FamCal
 * or actions key allowlists (route-auth refuses those keys here).
 */
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
    }

    const action = body && typeof body === 'object' ? (body as Record<string, unknown>).action : undefined;
    if (action === 'undo') {
      const reply = await undoBreakTaskIntoTasks(supabase, userId, id, body);
      return NextResponse.json(reply.body, { status: reply.status });
    }
    if (action !== undefined && action !== 'create') {
      return NextResponse.json({ error: 'action must be "create" or "undo".' }, { status: 400 });
    }
    const createBody = { ...(body as Record<string, unknown>) };
    delete createBody.action;
    const reply = await breakTaskIntoTasks(supabase, userId, id, createBody);
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    console.error('Error breaking task into tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
