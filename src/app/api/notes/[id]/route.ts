import { NextRequest } from 'next/server';
import { getNoteById, updateNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteStatus, NoteType } from '@/types/database';

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const { id } = await params;
    const note = await getNoteById(auth.context.supabase, auth.context.userId, id);
    return notesJson(request, note);
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error fetching note:');
  }
}

export async function PATCH(
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

    const note = await updateNote(auth.context.supabase, auth.context.userId, id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      body_markdown: typeof body.body_markdown === 'string' ? body.body_markdown : undefined,
      note_type: typeof body.note_type === 'string' ? (body.note_type as NoteType) : undefined,
      status: typeof body.status === 'string' ? (body.status as NoteStatus) : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
      last_reviewed_at:
        typeof body.last_reviewed_at === 'string' || body.last_reviewed_at === null
          ? body.last_reviewed_at
          : undefined,
    });

    return notesJson(request, note);
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error updating note:');
  }
}
