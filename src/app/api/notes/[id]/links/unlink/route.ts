import { NextRequest } from 'next/server';
import { unlinkNoteFromEntity } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteLinkEntityType, NoteLinkRole } from '@/types/database';

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
    const result = await unlinkNoteFromEntity(auth.context.supabase, auth.context.userId, id, {
      entity_type: typeof body.entity_type === 'string' ? (body.entity_type as NoteLinkEntityType) : 'task',
      entity_id: typeof body.entity_id === 'string' ? body.entity_id : '',
      link_role: typeof body.link_role === 'string' ? (body.link_role as NoteLinkRole) : undefined,
    });

    return notesJson(request, result);
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error unlinking note from entity:');
  }
}
