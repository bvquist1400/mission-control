import { NextRequest } from 'next/server';
import { createMeetingNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { CreateMeetingNotePayload } from '@/types/database';

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const body = (await request.json()) as Record<string, unknown>;
    const calendarEvent = body.calendar_event as Record<string, unknown> | undefined;
    const note = await createMeetingNote(auth.context.supabase, auth.context.userId, {
      calendar_event: {
        source:
          typeof calendarEvent?.source === 'string'
            ? (calendarEvent.source as CreateMeetingNotePayload['calendar_event']['source'])
            : 'ical',
        external_event_id:
          typeof calendarEvent?.external_event_id === 'string' ? calendarEvent.external_event_id : '',
        start_at: typeof calendarEvent?.start_at === 'string' ? calendarEvent.start_at : '',
      },
      implementation_id:
        typeof body.implementation_id === 'string' || body.implementation_id === null
          ? body.implementation_id
          : undefined,
      project_id:
        typeof body.project_id === 'string' || body.project_id === null ? body.project_id : undefined,
      body_markdown: typeof body.body_markdown === 'string' ? body.body_markdown : '',
      pinned: body.pinned === true,
    });

    return notesJson(request, note, { status: 201 });
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error creating meeting note:');
  }
}
