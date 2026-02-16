import { NextRequest, NextResponse } from 'next/server';
import {
  buildDayWindows,
  buildSnapshotPayload,
  calculateBusyStats,
  computeDeltas,
  enforceCalendarRetention,
  ingestCalendarEvents,
  mergeBusyBlocks,
  normalizeRequestedRange,
  parseEventPeople,
  parseSnapshotPayload,
} from '@/lib/calendar';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const range = normalizeRequestedRange(searchParams.get('rangeStart'), searchParams.get('rangeEnd'));

    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }
    const { supabase, userId } = auth.context;

    await enforceCalendarRetention(supabase, userId);
    const ingestResult = await ingestCalendarEvents(range, userId, supabase);
    await enforceCalendarRetention(supabase, userId);

    const rangeContext = buildDayWindows(range, DEFAULT_WORKDAY_CONFIG);

    const { data: rows, error: rowsError } = await supabase
      .from('calendar_events')
      .select('external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day, content_hash')
      .eq('user_id', userId)
      .gte('end_at', rangeContext.utcRangeStart)
      .lt('start_at', rangeContext.utcRangeEndExclusive)
      .order('start_at', { ascending: true });

    if (rowsError) {
      throw rowsError;
    }

    // Allowed fields contract: never return raw body, URLs, emails, or provider-only sensitive fields.
    const events = (rows || []).map((row) => ({
      start_at: row.start_at,
      end_at: row.end_at,
      title: row.title,
      with_display: parseEventPeople(row.with_display),
      body_scrubbed_preview: row.body_scrubbed_preview,
      is_all_day: row.is_all_day,
      external_event_id: row.external_event_id,
    }));

    const busyBlocks = mergeBusyBlocks(events, rangeContext.windows);
    const stats = calculateBusyStats(events, rangeContext.windows);

    const currentSnapshot = buildSnapshotPayload(
      (rows || []).map((row) => ({
        external_event_id: row.external_event_id,
        start_at: row.start_at,
        end_at: row.end_at,
        content_hash: row.content_hash,
      }))
    );

    const { data: snapshotRows, error: snapshotError } = await supabase
      .from('calendar_snapshots')
      .select('payload_min')
      .eq('user_id', userId)
      .eq('range_start', range.rangeStart)
      .eq('range_end', range.rangeEnd)
      .order('captured_at', { ascending: false })
      .limit(1);

    if (snapshotError) {
      throw snapshotError;
    }

    const previousSnapshot = parseSnapshotPayload(snapshotRows?.[0]?.payload_min);
    const changesSince = computeDeltas(previousSnapshot, currentSnapshot);

    const { error: insertSnapshotError } = await supabase.from('calendar_snapshots').insert({
      user_id: userId,
      range_start: range.rangeStart,
      range_end: range.rangeEnd,
      payload_min: currentSnapshot,
    });

    if (insertSnapshotError) {
      throw insertSnapshotError;
    }

    return NextResponse.json({
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      source: ingestResult.source,
      warning: ingestResult.warnings[0] ?? null,
      warnings: ingestResult.warnings,
      ingest: {
        source: ingestResult.source,
        ingestedCount: ingestResult.ingestedCount,
        warningCount: ingestResult.warnings.length,
      },
      events,
      busyBlocks,
      stats,
      changesSince,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && /range/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Error serving calendar data:', error);
    return NextResponse.json({ error: 'Failed to load calendar data' }, { status: 500 });
  }
}
