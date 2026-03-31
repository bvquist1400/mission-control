import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

const STATUS_UPDATE_AUTHORS = ['Brent', 'Assistant'] as const;
type StatusUpdateAuthor = (typeof STATUS_UPDATE_AUTHORS)[number];

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

// POST /api/applications/[id]/copy-update - Generate and save status update
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
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
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

    const body = (await request.json().catch(() => ({}))) as {
      saveToLog?: boolean;
      note?: string;
      createdBy?: unknown;
      syncStatusSummary?: boolean;
    };
    const saveToLog = body.saveToLog !== false;
    const userNote = typeof body.note === 'string' ? body.note.trim() : '';
    const syncStatusSummary = body.syncStatusSummary === true;

    if (syncStatusSummary && !userNote) {
      return NextResponse.json({ error: 'syncStatusSummary requires note' }, { status: 400 });
    }

    if (syncStatusSummary && userNote.length > 2000) {
      return NextResponse.json({ error: 'status_summary must be 2000 characters or fewer' }, { status: 400 });
    }

    let createdBy: StatusUpdateAuthor = userNote ? 'Brent' : 'Assistant';
    if (body.createdBy !== undefined) {
      if (typeof body.createdBy !== 'string' || !STATUS_UPDATE_AUTHORS.includes(body.createdBy as StatusUpdateAuthor)) {
        return NextResponse.json(
          { error: `createdBy must be one of: ${STATUS_UPDATE_AUTHORS.join(', ')}` },
          { status: 400 }
        );
      }
      createdBy = body.createdBy as StatusUpdateAuthor;
    }

    const blockerTitles = (blockers || []).map((b) => b.title);
    const relatedTaskIds = (blockers || []).map((b) => b.id);
    const snippet = generateStatusSnippet(
      userNote ? { ...implementation, status_summary: userNote } : implementation,
      blockerTitles
    );

    let savedUpdate: Record<string, unknown> | null = null;

    if (saveToLog) {
      const { data: insertedUpdate, error: insertError } = await supabase
        .from('status_updates')
        .insert({
          user_id: userId,
          implementation_id: id,
          update_text: userNote || snippet,
          created_by: createdBy,
          related_task_ids: relatedTaskIds,
        })
        .select('*')
        .single();

      if (insertError) {
        console.error('Error saving status update:', insertError);
        throw insertError;
      }

      savedUpdate = insertedUpdate;
    }

    let statusSummarySync: Record<string, unknown> | null = null;
    if (syncStatusSummary) {
      const { data: syncedImplementation, error: syncError } = await supabase
        .from('implementations')
        .update({ status_summary: userNote })
        .eq('id', id)
        .eq('user_id', userId)
        .select('id, name, status_summary, updated_at')
        .single();

      if (syncError) {
        console.error('Error syncing application status summary:', syncError);
        throw syncError;
      }

      statusSummarySync = syncedImplementation;
    }

    return NextResponse.json({
      snippet,
      saved_update: savedUpdate,
      implementation: {
        id: implementation.id,
        name: implementation.name,
        phase: implementation.phase,
        rag: implementation.rag,
      },
      blockers_count: blockerTitles.length,
      status_summary_sync: statusSummarySync,
    });
  } catch (error) {
    console.error('Error generating copy update:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/applications/[id]/copy-update - Get latest status updates
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
