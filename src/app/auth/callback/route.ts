import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function normalizeNextPath(input: string | null): string {
  if (!input || !input.startsWith('/')) {
    return '/';
  }

  return input;
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const nextPath = normalizeNextPath(requestUrl.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(nextPath)}&error=missing_code`, requestUrl.origin));
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      const destination = `/login?next=${encodeURIComponent(nextPath)}&error=${encodeURIComponent(error.message)}`;
      return NextResponse.redirect(new URL(destination, requestUrl.origin));
    }

    return NextResponse.redirect(new URL(nextPath, requestUrl.origin));
  } catch {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(nextPath)}&error=auth_failed`, requestUrl.origin));
  }
}
