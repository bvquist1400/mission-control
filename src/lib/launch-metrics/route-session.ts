/**
 * Shared guard + replies for the Launch page's own routes (Refresh now aside):
 * Brent's signed-in browser session only, writes from this site only.
 * "Brent's" means the launch owner (MISSION_CONTROL_USER_ID, the same rule as
 * Refresh now); any other session, or no owner configured, gets 403 before
 * the route reads its body or writes anything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withCorsHeaders } from '@/lib/cors';
import { isPostgrestNotFound } from '@/lib/supabase/errors';
import { requireAuthenticatedRoute, type AuthenticatedRouteContext } from '@/lib/supabase/route-auth';
import { isLaunchOwner, isSameOriginWrite } from './route-guards';

export function launchReply(request: NextRequest, body: unknown, status = 200): NextResponse {
  return withCorsHeaders(NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }), request);
}

export async function requireLaunchSession(
  request: NextRequest
): Promise<{ context: AuthenticatedRouteContext; response: null } | { context: null; response: NextResponse }> {
  if (request.method !== 'GET' && !isSameOriginWrite(request.headers.get('origin'), request.headers.get('host'))) {
    return { context: null, response: launchReply(request, { error: 'Forbidden' }, 403) };
  }
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return { context: null, response: auth.response ?? launchReply(request, { error: 'Authentication required' }, 401) };
  }
  if (auth.context.authSource !== 'session' || !isLaunchOwner(auth.context.userId, process.env.MISSION_CONTROL_USER_ID)) {
    return { context: null, response: launchReply(request, { error: 'Forbidden' }, 403) };
  }
  return { context: auth.context, response: null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Database errors become a plain message; PGRST116 → 404, 23505 → 409, else 500. */
export function dbErrorReply(request: NextRequest, error: { code?: string } | null, duplicateMessage: string): NextResponse {
  if (isPostgrestNotFound(error as { code: string })) {
    return launchReply(request, { error: 'Not found' }, 404);
  }
  if (error?.code === '23505') {
    return launchReply(request, { error: duplicateMessage }, 409);
  }
  if (error?.code === '23514') {
    return launchReply(request, { error: 'A value is out of range' }, 400);
  }
  return launchReply(request, { error: 'Could not save' }, 500);
}
