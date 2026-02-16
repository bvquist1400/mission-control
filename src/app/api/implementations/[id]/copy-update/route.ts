import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

/**
 * Generate Teams-ready status update
 * Format: {App} — {Phase} ({RAG}). {1–2 sentence status}. Next: {next milestone}. Blocker(s): {blockers or None}.
 */
function generateStatusSnippet(
  implementation: {
    name: string;
    phase: string;
    rag: string;
    status_summary: string;
    next_milestone: string;
    next_milestone_date: string | null;
  },
  blockerTitles: string[]
): string {
  const { name, phase, rag, status_summary, next_milestone, next_milestone_date } = implementation;

  const phaseDisplay = phase === 'GoLive' ? 'Go-Live' : phase;

  const milestoneText = next_milestone_date
    ? `${next_milestone} (${next_milestone_date})`
    : next_milestone || 'TBD';

  const blockersText =
    blockerTitles.length > 0
      ? blockerTitles.slice(0, 3).join('; ') + (blockerTitles.length > 3 ? '...' : '')
      : 'None';

  const statusText = status_summary || 'Status update pending.';

  return `${name} — ${phaseDisplay} (${rag}). ${statusText} Next: ${milestoneText}. Blocker(s): ${blockersText}.`;
}

// POST /api/implementations/[id]/copy-update - Generate and save status update
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

    const { data: implementation, error: implError } = await supabase
      .from('implementations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (implError || !implementation) {
      return NextResponse.json({ error: 'Implementation not found' }, { status: 404 });
    }

    const { data: blockers, error: blockersError } = await supabase
      .from('tasks')
      .select('id, title')
      .eq('user_id', userId)
      .eq('implementation_id', id)
      .eq('blocker', true)
      .neq('status', 'Done')
      .order('priority_score', { ascending: false })
      .limit(5);

    if (blockersError) {
      console.error('Error fetching blockers:', blockersError);
    }

    const blockerTitles = (blockers || []).map((b) => b.title);
    const relatedTaskIds = (blockers || []).map((b) => b.id);

    const snippet = generateStatusSnippet(implementation, blockerTitles);

    const body = (await request.json().catch(() => ({}))) as { saveToLog?: boolean };
    const saveToLog = body.saveToLog !== false;

    if (saveToLog) {
      const { error: insertError } = await supabase.from('status_updates').insert({
        user_id: userId,
        implementation_id: id,
        update_text: snippet,
        created_by: 'Assistant',
        related_task_ids: relatedTaskIds,
      });

      if (insertError) {
        console.error('Error saving status update:', insertError);
      }
    }

    return NextResponse.json({
      snippet,
      implementation: {
        id: implementation.id,
        name: implementation.name,
        phase: implementation.phase,
        rag: implementation.rag,
      },
      blockers_count: blockerTitles.length,
    });
  } catch (error) {
    console.error('Error generating copy update:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/implementations/[id]/copy-update - Get latest status updates
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

    const { searchParams } = new URL(request.url);
    const rawLimit = Number.parseInt(searchParams.get('limit') || '10', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;

    const { data, error } = await supabase
      .from('status_updates')
      .select('*')
      .eq('user_id', userId)
      .eq('implementation_id', id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching status updates:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
