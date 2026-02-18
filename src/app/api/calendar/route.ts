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

type CalendarEventSource = 'local' | 'ical' | 'graph';

interface CalendarEventRow {
  source: CalendarEventSource;
  external_event_id: string;
  start_at: string;
  end_at: string;
  title: string;
  with_display: unknown;
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
  content_hash: string;
}

interface CalendarEventContextRow {
  source: CalendarEventSource;
  external_event_id: string;
  meeting_context: string;
}

const MAX_MEETING_CONTEXT_CHARS = 8000;

function buildContextKey(source: CalendarEventSource, externalEventId: string): string {
  return `${source}::${externalEventId}`;
}

function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42P01' || candidate.code === 'PGRST205') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes('does not exist') || message.includes('could not find the table');
}

function normalizeMeetingContext(input: unknown): string | null | undefined {
  if (input === null) {
    return null;
  }

  if (typeof input !== 'string') {
    return undefined;
  }

  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}

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
      .select('source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day, content_hash')
      .eq('user_id', userId)
      .gte('end_at', rangeContext.utcRangeStart)
      .lt('start_at', rangeContext.utcRangeEndExclusive)
      .order('start_at', { ascending: true });

    if (rowsError) {
      throw rowsError;
    }

    const calendarRows = (rows || []) as CalendarEventRow[];
    const contextByEvent = new Map<string, string>();
    const externalEventIds = [...new Set(calendarRows.map((row) => row.external_event_id).filter(Boolean))];

    if (externalEventIds.length > 0) {
      const { data: contextRows, error: contextError } = await supabase
        .from('calendar_event_context')
        .select('source, external_event_id, meeting_context')
        .eq('user_id', userId)
        .in('external_event_id', externalEventIds);

      if (contextError) {
        if (!isMissingRelationError(contextError)) {
          throw contextError;
        }
      } else {
        for (const row of (contextRows || []) as CalendarEventContextRow[]) {
          const trimmed = row.meeting_context?.trim();
          if (!trimmed) {
            continue;
          }
          contextByEvent.set(buildContextKey(row.source, row.external_event_id), trimmed);
        }
      }
    }

    // Allowed fields contract: never return raw body, URLs, emails, or provider-only sensitive fields.
    const events = calendarRows.map((row) => ({
      start_at: row.start_at,
      end_at: row.end_at,
      title: row.title,
      with_display: parseEventPeople(row.with_display),
      body_scrubbed_preview: row.body_scrubbed_preview,
      is_all_day: row.is_all_day,
      external_event_id: row.external_event_id,
      meeting_context: contextByEvent.get(buildContextKey(row.source, row.external_event_id)) ?? null,
    }));

    const busyBlocks = mergeBusyBlocks(events, rangeContext.windows);
    const stats = calculateBusyStats(events, rangeContext.windows);

    const currentSnapshot = buildSnapshotPayload(
      calendarRows.map((row) => ({
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

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const externalEventId = typeof body.external_event_id === 'string' ? body.external_event_id.trim() : '';
    const startAt = typeof body.start_at === 'string' ? body.start_at : '';
    const meetingContext = normalizeMeetingContext(body.meeting_context);

    if (!externalEventId || !startAt || Number.isNaN(Date.parse(startAt)) || meetingContext === undefined) {
      return NextResponse.json(
        {
          error:
            'external_event_id, start_at, and meeting_context (string or null) are required',
        },
        { status: 400 }
      );
    }

    if (meetingContext && meetingContext.length > MAX_MEETING_CONTEXT_CHARS) {
      return NextResponse.json(
        { error: `meeting_context may not exceed ${MAX_MEETING_CONTEXT_CHARS} characters` },
        { status: 400 }
      );
    }

    const eventResult = await supabase
      .from('calendar_events')
      .select('source, external_event_id, start_at')
      .eq('user_id', userId)
      .eq('external_event_id', externalEventId)
      .eq('start_at', startAt)
      .maybeSingle();

    if (eventResult.error) {
      throw eventResult.error;
    }

    if (!eventResult.data) {
      return NextResponse.json({ error: 'Calendar event not found' }, { status: 404 });
    }

    const source = eventResult.data.source as CalendarEventSource;

    if (meetingContext === null) {
      const { error: deleteError } = await supabase
        .from('calendar_event_context')
        .delete()
        .eq('user_id', userId)
        .eq('source', source)
        .eq('external_event_id', externalEventId);

      if (deleteError) {
        if (isMissingRelationError(deleteError)) {
          return NextResponse.json(
            { error: 'calendar_event_context table not found. Run latest migrations.' },
            { status: 503 }
          );
        }
        throw deleteError;
      }
    } else {
      const { error: upsertError } = await supabase
        .from('calendar_event_context')
        .upsert(
          {
            user_id: userId,
            source,
            external_event_id: externalEventId,
            meeting_context: meetingContext,
          },
          { onConflict: 'user_id,source,external_event_id' }
        );

      if (upsertError) {
        if (isMissingRelationError(upsertError)) {
          return NextResponse.json(
            { error: 'calendar_event_context table not found. Run latest migrations.' },
            { status: 503 }
          );
        }
        throw upsertError;
      }
    }

    return NextResponse.json({
      external_event_id: externalEventId,
      start_at: startAt,
      meeting_context: meetingContext,
    });
  } catch (error) {
    console.error('Error updating calendar meeting context:', error);
    return NextResponse.json({ error: 'Failed to update meeting context' }, { status: 500 });
  }
}
