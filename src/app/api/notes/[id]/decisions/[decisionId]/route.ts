import { NextRequest } from 'next/server';
import { updateDecisionStatus } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteDecisionStatus } from '@/types/database';

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; decisionId: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const { id, decisionId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const decision = await updateDecisionStatus(auth.context.supabase, auth.context.userId, decisionId, {
      decision_status:
        typeof body.decision_status === 'string' ? (body.decision_status as NoteDecisionStatus) : 'active',
      decided_at: typeof body.decided_at === 'string' || body.decided_at === null ? body.decided_at : undefined,
      decided_by_stakeholder_id:
        typeof body.decided_by_stakeholder_id === 'string' || body.decided_by_stakeholder_id === null
          ? body.decided_by_stakeholder_id
          : undefined,
    }, id);

    return notesJson(request, decision);
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error updating note decision:');
  }
}
