import { NextRequest, NextResponse } from 'next/server';
import { buildDayWindows, calculateBusyStats } from '@/lib/calendar';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

interface CalendarTodayRow {
  start_at: string;
  end_at: string;
  title: string;
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
    return new Date().toISOString().slice(0, 10);
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
    const today = getDateInTimeZone(new Date(), DEFAULT_WORKDAY_CONFIG.timezone);
    const range = { rangeStart: today, rangeEnd: today };
    const rangeContext = buildDayWindows(range, DEFAULT_WORKDAY_CONFIG);

    const { data, error } = await supabase
      .from('calendar_events')
      .select('start_at, end_at, title')
      .eq('user_id', userId)
      .gte('end_at', rangeContext.utcRangeStart)
      .lt('start_at', rangeContext.utcRangeEndExclusive)
      .order('start_at', { ascending: true });

    if (error) {
      throw error;
    }

    const rows = (data || []) as CalendarTodayRow[];
    const events = rows.map((row) => ({
      title: row.title,
      start: row.start_at,
      end: row.end_at,
      location: null as string | null,
    }));

    const stats = calculateBusyStats(rows, rangeContext.windows);

    return NextResponse.json({
      events,
      busyMinutes: stats.busyMinutes,
    });
  } catch (error) {
    console.error('Error serving today calendar summary:', error);
    return NextResponse.json({ error: 'Failed to load today calendar summary' }, { status: 500 });
  }
}
