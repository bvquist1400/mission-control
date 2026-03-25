import { NextRequest } from 'next/server';
import { createDecisionFromNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteDecisionStatus } from '@/types/database';

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const decision = await createDecisionFromNote(auth.context.supabase, auth.context.userId, id, {
      title: typeof body.title === 'string' ? body.title : '',
      summary: typeof body.summary === 'string' ? body.summary : '',
      decision_status:
        typeof body.decision_status === 'string' ? (body.decision_status as NoteDecisionStatus) : undefined,
      decided_at: typeof body.decided_at === 'string' || body.decided_at === null ? body.decided_at : undefined,
      decided_by_stakeholder_id:
        typeof body.decided_by_stakeholder_id === 'string' || body.decided_by_stakeholder_id === null
          ? body.decided_by_stakeholder_id
          : undefined,
    });

    return notesJson(request, decision, { status: 201 });
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error creating decision from note:');
  }
}
