import { NextRequest, NextResponse } from 'next/server';
import { queryTodayCalendar } from '@/lib/today/queries';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  return `${year}-${month}-${day}`;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const requestedTimeZone = request.nextUrl.searchParams.get('tz');
    const effectiveTimeZone =
      requestedTimeZone && isValidTimeZone(requestedTimeZone)
        ? requestedTimeZone
        : DEFAULT_WORKDAY_CONFIG.timezone;

    const today = getDateInTimeZone(new Date(), effectiveTimeZone);
    const { events, busyMinutes } = await queryTodayCalendar(supabase, userId, effectiveTimeZone);

    return NextResponse.json({
      events,
      busyMinutes,
      date: today,
      timeZone: effectiveTimeZone,
    });
  } catch (error) {
    console.error('Error serving today calendar summary:', error);
    return NextResponse.json({ error: 'Failed to load today calendar summary' }, { status: 500 });
  }
}
