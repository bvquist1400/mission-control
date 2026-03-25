import { NextRequest } from 'next/server';
import { createNote, listNotes } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { NoteLinkEntityType, NoteLinkRole, NoteStatus, NoteType } from '@/types/database';

function parseBooleanParam(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error('pinned must be true or false');
}

function parseNumberParam(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('limit and offset must be integers');
  }

  return parsed;
}

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const { searchParams } = request.nextUrl;
    const pinned = parseBooleanParam(searchParams.get('pinned'));
    const limit = parseNumberParam(searchParams.get('limit'));
    const offset = parseNumberParam(searchParams.get('offset'));

    const notes = await listNotes(auth.context.supabase, auth.context.userId, {
      note_type: (searchParams.get('note_type') ?? undefined) as NoteType | undefined,
      status: (searchParams.get('status') ?? undefined) as NoteStatus | undefined,
      pinned,
      entity_type: (searchParams.get('entity_type') ?? undefined) as NoteLinkEntityType | undefined,
      entity_id: searchParams.get('entity_id') ?? undefined,
      link_role: (searchParams.get('link_role') ?? undefined) as NoteLinkRole | undefined,
      limit,
      offset,
    });

    return notesJson(request, notes);
  } catch (error) {
    if (error instanceof Error && error.message === 'pinned must be true or false') {
      return notesJson(request, { error: error.message }, { status: 400 });
    }

    if (error instanceof Error && error.message === 'limit and offset must be integers') {
      return notesJson(request, { error: error.message }, { status: 400 });
    }

    return handleNotesRouteError(request, error, 'Error listing notes:');
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const body = (await request.json()) as Record<string, unknown>;
    const note = await createNote(auth.context.supabase, auth.context.userId, {
      title: typeof body.title === 'string' ? body.title : '',
      body_markdown: typeof body.body_markdown === 'string' ? body.body_markdown : '',
      note_type: typeof body.note_type === 'string' ? (body.note_type as NoteType) : undefined,
      status: typeof body.status === 'string' ? (body.status as NoteStatus) : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
      last_reviewed_at:
        typeof body.last_reviewed_at === 'string' || body.last_reviewed_at === null
          ? body.last_reviewed_at
          : undefined,
    });

    return notesJson(request, note, { status: 201 });
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error creating note:');
  }
}
