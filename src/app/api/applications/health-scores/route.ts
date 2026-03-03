import { NextRequest, NextResponse } from 'next/server';
import { type IntelligenceCommitment, type IntelligenceImplementation, type IntelligenceRiskTask, normalizeCommitmentRows } from '@/lib/briefing/intelligence';
import { computeImplementationHealthScores, persistImplementationHealthSnapshots } from '@/lib/health-scores';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

// GET /api/applications/health-scores - Compute and return health scores for all applications
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    const [implementationResult, taskResult, commitmentResult] = await Promise.all([
      supabase
        .from('implementations')
        .select('*')
        .eq('user_id', userId)
        .order('name', { ascending: true }),
      supabase
        .from('tasks')
        .select('id, title, implementation_id, status, blocker, created_at, updated_at')
        .eq('user_id', userId),
      supabase
        .from('commitments')
        .select(
          'id, title, direction, status, due_at, created_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status, implementation_id)'
        )
        .eq('user_id', userId)
        .eq('status', 'Open'),
    ]);

    if (implementationResult.error) {
      throw implementationResult.error;
    }

    if (taskResult.error) {
      throw taskResult.error;
    }

    if (commitmentResult.error) {
      throw commitmentResult.error;
    }

    const implementations = (implementationResult.data || []) as IntelligenceImplementation[];
    const tasks = (taskResult.data || []) as IntelligenceRiskTask[];
    const commitments = normalizeCommitmentRows((commitmentResult.data || []) as unknown[]) as IntelligenceCommitment[];

    const { scores, snapshots } = computeImplementationHealthScores(implementations, tasks, commitments, new Date());
    await persistImplementationHealthSnapshots(supabase, userId, snapshots);

    return NextResponse.json(scores);
  } catch (error) {
    console.error('Error computing application health scores:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
