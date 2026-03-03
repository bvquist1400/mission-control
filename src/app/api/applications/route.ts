import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildRiskRadar,
  type IntelligenceImplementation,
  type IntelligenceRiskTask,
  normalizeCommitmentRows,
} from '@/lib/briefing/intelligence';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42703' || candidate.code === 'PGRST204') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes(columnName.toLowerCase()) && message.includes('column');
}

async function listImplementationsOrdered(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, unknown>[]> {
  const withRank = await supabase
    .from('implementations')
    .select('*')
    .eq('user_id', userId)
    .order('portfolio_rank', { ascending: true })
    .order('name', { ascending: true });

  if (!withRank.error) {
    return withRank.data || [];
  }

  if (!isMissingColumnError(withRank.error, 'portfolio_rank')) {
    throw withRank.error;
  }

  const fallback = await supabase
    .from('implementations')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });

  if (fallback.error) {
    throw fallback.error;
  }

  return (fallback.data || []).map((impl, index) => ({
    ...impl,
    portfolio_rank: index + 1,
  }));
}

async function getNextPortfolioRank(
  supabase: SupabaseClient,
  userId: string
): Promise<number | null> {
  const highestRank = await supabase
    .from('implementations')
    .select('portfolio_rank')
    .eq('user_id', userId)
    .order('portfolio_rank', { ascending: false })
    .limit(1);

  if (highestRank.error) {
    if (isMissingColumnError(highestRank.error, 'portfolio_rank')) {
      return null;
    }
    throw highestRank.error;
  }

  const value = highestRank.data?.[0]?.portfolio_rank;
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Number(value) + 1;
}

// GET /api/applications - List all applications
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const withStats = searchParams.get('with_stats') === 'true';
    const implementations = await listImplementationsOrdered(supabase, userId);

    if (withStats) {
      const [taskResult, commitmentResult] = await Promise.all([
        supabase
          .from('tasks')
          .select('id, title, implementation_id, status, blocker, created_at, updated_at, priority_score')
          .eq('user_id', userId)
          .order('priority_score', { ascending: false })
          .order('id', { ascending: true }),
        supabase
          .from('commitments')
          .select('id, title, direction, status, due_at, created_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status, implementation_id)')
          .eq('user_id', userId)
          .eq('status', 'Open'),
      ]);

      if (taskResult.error) {
        throw taskResult.error;
      }

      if (commitmentResult.error) {
        throw commitmentResult.error;
      }

      const taskRows = (taskResult.data || []) as Array<IntelligenceRiskTask & { priority_score: number }>;
      const commitmentRows = normalizeCommitmentRows((commitmentResult.data || []) as unknown[]);
      const implementationRows = implementations as Array<IntelligenceImplementation & Record<string, unknown>>;
      const riskMap = new Map(
        buildRiskRadar(implementationRows, taskRows, commitmentRows, new Date()).map((item) => [item.implementation_id, item])
      );

      const blockersByImplementation = new Map<string, number>();
      const nextActionByImplementation = new Map<string, { id: string; title: string }>();

      for (const task of taskRows) {
        if (!task.implementation_id || task.status === 'Done') {
          continue;
        }

        if (task.blocker) {
          blockersByImplementation.set(
            task.implementation_id,
            (blockersByImplementation.get(task.implementation_id) || 0) + 1
          );
        }

        if (!nextActionByImplementation.has(task.implementation_id)) {
          nextActionByImplementation.set(task.implementation_id, { id: task.id, title: task.title });
        }
      }

      const enriched = implementationRows.map((impl) => {
        const risk = riskMap.get(impl.id);
        return {
          ...impl,
          blockers_count: blockersByImplementation.get(impl.id) || 0,
          next_action: nextActionByImplementation.get(impl.id) || null,
          risk_level: risk?.risk_level || 'green',
          risk_score: risk?.risk_score || 0,
          risk_signals: risk?.signals || [],
        };
      });

      return NextResponse.json(enriched);
    }

    return NextResponse.json(
      implementations.map((impl) => ({
        id: impl.id,
        name: impl.name,
        phase: impl.phase,
        rag: impl.rag,
        portfolio_rank: impl.portfolio_rank ?? null,
      }))
    );
  } catch (error) {
    console.error('Error fetching implementations:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/applications - Create a new application
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const nextPortfolioRank = await getNextPortfolioRank(supabase, userId);

    const insertPayload: Record<string, unknown> = {
      user_id: userId,
      name: body.name.trim(),
      phase: typeof body.phase === 'string' ? body.phase : 'Intake',
      rag: typeof body.rag === 'string' ? body.rag : 'Green',
      target_date: typeof body.target_date === 'string' ? body.target_date : null,
      status_summary: typeof body.status_summary === 'string' ? body.status_summary : '',
      next_milestone: typeof body.next_milestone === 'string' ? body.next_milestone : '',
      next_milestone_date: typeof body.next_milestone_date === 'string' ? body.next_milestone_date : null,
      stakeholders: toStringArray(body.stakeholders),
      keywords: toStringArray(body.keywords),
    };

    if (nextPortfolioRank !== null) {
      insertPayload.portfolio_rank = nextPortfolioRank;
    }

    const { data, error } = await supabase
      .from('implementations')
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating implementation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
