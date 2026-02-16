import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient, User } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface AuthenticatedRouteContext {
  supabase: SupabaseClient;
  user: User;
  userId: string;
}

export async function requireAuthenticatedRoute(
  request: NextRequest
): Promise<{ context: AuthenticatedRouteContext | null; response: NextResponse | null }> {
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
      response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
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
