import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient, User } from '@supabase/supabase-js';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { withCorsHeaders } from '@/lib/cors';

export interface AuthenticatedRouteContext {
  supabase: SupabaseClient;
  user: User;
  userId: string;
}

function corsJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

/**
 * Authenticates a route request via either:
 *  1. X-Mission-Control-Key header (API key auth for Claude / external callers)
 *  2. Authorization: Bearer <token> header (Supabase JWT)
 *  3. Supabase session cookie (browser auth)
 */
export async function requireAuthenticatedRoute(
  request: NextRequest
): Promise<{ context: AuthenticatedRouteContext | null; response: NextResponse | null }> {

  // --- API Key Auth ---
  const apiKey = request.headers.get('x-mission-control-key');
  const validApiKey = process.env.MISSION_CONTROL_API_KEY;
  const apiUserId = process.env.MISSION_CONTROL_USER_ID;

  if (apiKey) {
    if (!validApiKey || !apiUserId) {
      return {
        context: null,
        response: corsJson(
          request,
          { error: 'API key auth is not configured on this server' },
          { status: 503 }
        ),
      };
    }

    if (apiKey !== validApiKey) {
      return {
        context: null,
        response: corsJson(request, { error: 'Invalid API key' }, { status: 401 }),
      };
    }

    const supabase = createSupabaseAdminClient();

    // Fetch the actual user object so the context shape is consistent
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(apiUserId);

    if (userError || !userData?.user) {
      return {
        context: null,
        response: corsJson(
          request,
          { error: 'API key user not found — check MISSION_CONTROL_USER_ID env var' },
          { status: 401 }
        ),
      };
    }

    return {
      context: {
        supabase,
        user: userData.user,
        userId: apiUserId,
      },
      response: null,
    };
  }

  // --- Standard Supabase Auth (Bearer token or cookie) ---
  const supabase = await createSupabaseServerClient();

  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const {
    data: { user },
    error,
  } = bearerToken ? await supabase.auth.getUser(bearerToken) : await supabase.auth.getUser();

  if (error || !user) {
    return {
      context: null,
      response: corsJson(request, { error: 'Authentication required' }, { status: 401 }),
    };
  }

  return {
    context: {
      supabase,
      user,
      userId: user.id,
    },
    response: null,
  };
}
