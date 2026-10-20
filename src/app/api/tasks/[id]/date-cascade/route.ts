import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import {
  applyDateChange,
  DateCascadeHttpError,
  parseDateCascadeRequest,
  undoDateChange,
} from '@/lib/task-date-cascade-undo';

// POST /api/tasks/[id]/date-cascade - Undo a date change, switch how far its
// cascade went, or try a failed cascade again (cascade S2; see
// src/lib/task-date-cascade-undo.ts). Not available to the FamCal key.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }
    if (auth.context.authSource === 'famcal_api_key') {
      // Its own allowlist already refuses this path; this is the second guard.
      return NextResponse.json({ error: 'The FamCal API key is not permitted for this route' }, { status: 403 });
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Send a JSON object' }, { status: 400 });
    }

    const parsed = parseDateCascadeRequest(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const reply = parsed.value.action === 'undo'
      ? await undoDateChange(supabase, userId, id, parsed.value)
      : await applyDateChange(supabase, userId, id, parsed.value, auth.context.authSource);
    return NextResponse.json(reply);
  } catch (error) {
    if (error instanceof DateCascadeHttpError) {
      return NextResponse.json(error.body, { status: error.status });
    }
    console.error('Error changing a date cascade:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
