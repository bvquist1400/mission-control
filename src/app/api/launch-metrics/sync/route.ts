import { NextRequest, NextResponse } from 'next/server';
import { withCorsHeaders } from '@/lib/cors';
import { hasCronAccess, isLaunchOwner, isSameOriginWrite } from '@/lib/launch-metrics/route-guards';
import { createSupabaseLaunchStore } from '@/lib/launch-metrics/store';
import { MANUAL_COOLDOWN_MS, readLaunchEnv, runLaunchSync } from '@/lib/launch-metrics/sync';
import { errorCode } from '@/lib/launch-metrics/http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { LaunchRunKind, LaunchRunTrigger } from '@/lib/launch-metrics/types';

export const dynamic = 'force-dynamic';

function reply(request: NextRequest, body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return withCorsHeaders(response, request);
}

async function run(request: NextRequest, trigger: LaunchRunTrigger, kind: LaunchRunKind): Promise<NextResponse> {
  const userId = process.env.MISSION_CONTROL_USER_ID?.trim();
  if (!userId) {
    return reply(request, { error: 'not_configured' }, 503);
  }
  try {
    const store = createSupabaseLaunchStore(createSupabaseAdminClient(), userId);
    if (trigger === 'manual') {
      const recent = await store.recentRuns(1);
      const latest = recent[0];
      if (latest && Date.now() - Date.parse(latest.started_at) < MANUAL_COOLDOWN_MS) {
        return reply(request, { error: 'too_soon', retry_after_seconds: 60 }, 429);
      }
    }
    const result = await runLaunchSync(
      { store, env: readLaunchEnv(process.env), fetchImpl: fetch, now: () => new Date() },
      { trigger, kind }
    );
    if (result.status === 'busy') {
      return reply(request, { error: 'busy' }, 409);
    }
    // Codes only: never a response body, header or key.
    return reply(request, { run_id: result.run_id, status: result.status, sources: result.sources });
  } catch (error) {
    return reply(request, { error: errorCode(error) }, 500);
  }
}

/** Vercel cron: full by default, `?kind=light` for the hourly run. */
export async function GET(request: NextRequest) {
  if (!hasCronAccess(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return reply(request, { error: 'Unauthorized' }, 401);
  }
  const kind: LaunchRunKind = request.nextUrl.searchParams.get('kind') === 'light' ? 'light' : 'full';
  return run(request, 'cron', kind);
}

/** "Refresh now" on the Launch page: Brent's browser session only. */
export async function POST(request: NextRequest) {
  if (!isSameOriginWrite(request.headers.get('origin'), request.headers.get('host'))) {
    return reply(request, { error: 'Forbidden' }, 403);
  }
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response ?? reply(request, { error: 'Authentication required' }, 401);
  }
  if (auth.context.authSource !== 'session' || !isLaunchOwner(auth.context.userId, process.env.MISSION_CONTROL_USER_ID)) {
    return reply(request, { error: 'Forbidden' }, 403);
  }
  return run(request, 'manual', 'full');
}
