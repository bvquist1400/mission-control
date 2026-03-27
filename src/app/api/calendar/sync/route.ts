import { NextRequest, NextResponse } from 'next/server';
import { addDateOnlyDays } from '@/lib/date-only';
import { enforceCalendarRetention, ingestCalendarEvents, normalizeRequestedRange, type CalendarRangeInput } from '@/lib/calendar';
import { readInternalAuthContext } from '@/lib/supabase/internal-auth';
import { requireAuthenticatedRoute, type AuthenticatedRouteContext } from '@/lib/supabase/route-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

const DEFAULT_SYNC_DAYS_AHEAD = 30;
const MAX_SYNC_DAYS_AHEAD = 60;

function hasCronAccess(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;

  return Boolean(cronSecret && bearerToken === cronSecret);
}

function configuredCalendarSyncUserId(): string | null {
  return process.env.MISSION_CONTROL_USER_ID?.trim() || process.env.DEFAULT_USER_ID?.trim() || null;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function resolveSyncRange(request: NextRequest): CalendarRangeInput {
  const rangeStart = request.nextUrl.searchParams.get('rangeStart');
  const rangeEnd = request.nextUrl.searchParams.get('rangeEnd');

  if (rangeStart || rangeEnd) {
    return normalizeRequestedRange(rangeStart, rangeEnd);
  }

  const today = getDateInTimeZone(new Date(), DEFAULT_WORKDAY_CONFIG.timezone);
  const daysAhead = Math.min(
    parsePositiveIntEnv('CALENDAR_FUTURE_HORIZON_DAYS', DEFAULT_SYNC_DAYS_AHEAD),
    MAX_SYNC_DAYS_AHEAD
  );
  const defaultRangeEnd = addDateOnlyDays(today, daysAhead) ?? today;

  return normalizeRequestedRange(today, defaultRangeEnd);
}

async function runSync(
  source: 'authenticated' | 'cron' | 'internal',
  supabase: AuthenticatedRouteContext['supabase'],
  userId: string,
  range: CalendarRangeInput
) {
  await enforceCalendarRetention(supabase, userId);
  const ingestResult = await ingestCalendarEvents(range, userId, supabase);
  await enforceCalendarRetention(supabase, userId);

  const payload = {
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    syncAt: new Date().toISOString(),
    ingest: {
      source: ingestResult.source,
      ingestedCount: ingestResult.ingestedCount,
      warningCount: ingestResult.warnings.length,
    },
    warning: ingestResult.warnings[0] ?? null,
    warnings: ingestResult.warnings,
  };

  console.info('Calendar sync completed', {
    source,
    userId,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    ingestSource: ingestResult.source,
    ingestedCount: ingestResult.ingestedCount,
    warningCount: ingestResult.warnings.length,
  });

  return NextResponse.json(payload);
}

async function handle(request: NextRequest) {
  try {
    const range = resolveSyncRange(request);

    const internalAuth = readInternalAuthContext<AuthenticatedRouteContext>(request);
    if (internalAuth) {
      return runSync('internal', internalAuth.supabase, internalAuth.userId, range);
    }

    if (hasCronAccess(request)) {
      const userId = configuredCalendarSyncUserId();
      if (!userId) {
        return NextResponse.json(
          { error: 'MISSION_CONTROL_USER_ID or DEFAULT_USER_ID must be configured for scheduled calendar sync' },
          { status: 503 }
        );
      }

      const supabase = createSupabaseAdminClient();
      return runSync('cron', supabase, userId, range);
    }

    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    return runSync('authenticated', auth.context.supabase, auth.context.userId, range);
  } catch (error) {
    if (error instanceof Error && /range/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Error syncing calendar data:', error);
    return NextResponse.json({ error: 'Failed to sync calendar data' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
