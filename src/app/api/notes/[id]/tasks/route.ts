import { NextRequest } from 'next/server';
import { linkTaskToNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteTaskRelationshipType } from '@/types/database';

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
    const taskLink = await linkTaskToNote(auth.context.supabase, auth.context.userId, id, {
      task_id: typeof body.task_id === 'string' ? body.task_id : '',
      relationship_type:
        typeof body.relationship_type === 'string'
          ? (body.relationship_type as NoteTaskRelationshipType)
          : undefined,
    });

    return notesJson(request, taskLink, { status: 201 });
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error linking task to note:');
  }
}
