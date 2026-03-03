import { NextRequest, NextResponse } from 'next/server';
import { recalculateTaskPriority } from '@/lib/priority';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

// POST /api/tasks/park/[id] - Convenience endpoint to move a task into Parked
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

    const priorityScore = recalculateTaskPriority({
      ...currentTask,
      status: 'Parked',
    });

    const { data, error } = await supabase
      .from('tasks')
      .update({
        status: 'Parked',
        priority_score: priorityScore,
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag)')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error parking task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
