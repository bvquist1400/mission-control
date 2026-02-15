import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

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

  // Format phase for display (convert camelCase to readable)
  const phaseDisplay = phase === 'GoLive' ? 'Go-Live' : phase;

  // Format next milestone with date if available
  const milestoneText = next_milestone_date
    ? `${next_milestone} (${next_milestone_date})`
    : next_milestone || 'TBD';

  // Format blockers
  const blockersText =
    blockerTitles.length > 0
      ? blockerTitles.slice(0, 3).join('; ') + (blockerTitles.length > 3 ? '...' : '')
      : 'None';

  // Build the status snippet
  const statusText = status_summary || 'Status update pending.';

  return `${name} — ${phaseDisplay} (${rag}). ${statusText} Next: ${milestoneText}. Blocker(s): ${blockersText}.`;
}

// POST /api/implementations/[id]/copy-update - Generate and save status update
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = getSupabaseClient();

    // Fetch implementation details
    const { data: implementation, error: implError } = await supabase
      .from('implementations')
      .select('*')
      .eq('id', id)
      .single();

    if (implError || !implementation) {
      return NextResponse.json({ error: 'Implementation not found' }, { status: 404 });
    }

    // Fetch open blockers for this implementation
    const { data: blockers, error: blockersError } = await supabase
      .from('tasks')
      .select('title')
      .eq('implementation_id', id)
      .eq('blocker', true)
      .neq('status', 'Done')
      .order('priority_score', { ascending: false })
      .limit(5);

    if (blockersError) {
      console.error('Error fetching blockers:', blockersError);
    }

    const blockerTitles = (blockers || []).map((b) => b.title);

    // Generate the status snippet
    const snippet = generateStatusSnippet(implementation, blockerTitles);

    // Optionally save to status_updates table
    const body = await request.json().catch(() => ({}));
    const saveToLog = body.saveToLog !== false; // Default to true

    if (saveToLog) {
      const { error: insertError } = await supabase.from('status_updates').insert({
        user_id: implementation.user_id,
        implementation_id: id,
        update_text: snippet,
        created_by: 'Assistant',
        related_task_ids: blockers?.map(() => null).filter(Boolean) || [],
      });

      if (insertError) {
        console.error('Error saving status update:', insertError);
        // Don't fail the request, just log the error
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
    const { id } = await params;
    const supabase = getSupabaseClient();

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10', 10);

    const { data, error } = await supabase
      .from('status_updates')
      .select('*')
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
