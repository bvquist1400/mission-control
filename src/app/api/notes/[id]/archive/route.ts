import { NextRequest } from 'next/server';
import { archiveNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

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
    const note = await archiveNote(auth.context.supabase, auth.context.userId, id);
    return notesJson(request, note);
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error archiving note:');
  }
}
