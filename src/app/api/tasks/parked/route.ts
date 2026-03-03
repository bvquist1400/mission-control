import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { fetchTaskDependencySummaries } from '@/lib/task-dependencies';

// GET /api/tasks/parked - List parked tasks
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const implementationId = searchParams.get('implementation_id');
    const projectId = searchParams.get('project_id');
    const rawLimit = Number.parseInt(searchParams.get('limit') || '100', 10);
    const rawOffset = Number.parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    let query = supabase
      .from('tasks')
      .select('*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date)')
      .eq('user_id', userId)
      .eq('status', 'Parked')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (implementationId) {
      query = query.eq('implementation_id', implementationId);
    }

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const tasks = data || [];
    const taskIds = tasks.map((task) => task.id);
    const dependencyMap = await fetchTaskDependencySummaries(supabase, userId, taskIds);

    return NextResponse.json(
      tasks.map((task) => {
        const dependencies = dependencyMap.get(task.id) || [];
        return {
          ...task,
          dependencies,
          dependency_blocked: dependencies.some((dependency) => dependency.unresolved),
        };
      })
    );
  } catch (error) {
    console.error('Error fetching parked tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
