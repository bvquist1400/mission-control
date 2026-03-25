import { NextRequest, NextResponse } from 'next/server';
import { withCorsHeaders } from '@/lib/cors';
import { NotesServiceError } from '@/lib/notes-shared';

export function notesJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

export function notesOptions(request: NextRequest): NextResponse {
  return withCorsHeaders(new NextResponse(null, { status: 204 }), request);
}

export function handleNotesRouteError(
  request: NextRequest,
  error: unknown,
  fallbackMessage: string
): NextResponse {
  if (error instanceof NotesServiceError) {
    return notesJson(request, { error: error.message, code: error.code }, { status: error.status });
  }

  console.error(fallbackMessage, error);
  return notesJson(request, { error: 'Internal server error' }, { status: 500 });
}
