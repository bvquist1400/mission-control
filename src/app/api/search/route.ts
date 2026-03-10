import { NextRequest, NextResponse } from 'next/server';
import { searchMissionControlData } from '@/lib/mcp/search';
import { toBrowserSearchResult } from '@/lib/search/browser';
import { withCorsHeaders } from '@/lib/cors';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function jsonResponse(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const query = request.nextUrl.searchParams.get('q')?.trim() || '';
    if (query.length < 2) {
      return jsonResponse(request, { query, results: [] });
    }

    const results = await searchMissionControlData(
      auth.context.supabase,
      auth.context.userId,
      query,
      request.nextUrl.origin
    );

    return jsonResponse(request, {
      query,
      results: results.map(toBrowserSearchResult),
    });
  } catch (error) {
    console.error('Error running universal search:', error);
    return jsonResponse(request, { error: 'Internal server error' }, { status: 500 });
  }
}
