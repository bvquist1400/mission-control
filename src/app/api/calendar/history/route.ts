import { NextRequest, NextResponse } from 'next/server';
import { decorateCalendarEvent, parseEventPeople } from '@/lib/calendar';
import { buildCalendarEntityId } from '@/lib/calendar-event-identity';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

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
}

interface CalendarEventContextRow {
  source: CalendarEventSource;
  external_event_id: string;
  meeting_context: string;
}

interface NoteLinkCountRow {
  entity_id: string;
  note_id: string;
}

const DEFAULT_DAYS_BACK = 90;
const MIN_DAYS_BACK = 7;
const MAX_DAYS_BACK = 365;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const CANDIDATE_MULTIPLIER = 6;
const IN_FILTER_BATCH_SIZE = 40;

function clampInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

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

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const daysBack = clampInteger(request.nextUrl.searchParams.get('daysBack'), DEFAULT_DAYS_BACK, MIN_DAYS_BACK, MAX_DAYS_BACK);
    const limit = clampInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const candidateLimit = Math.min(MAX_LIMIT * CANDIDATE_MULTIPLIER, limit * CANDIDATE_MULTIPLIER);

    const now = new Date();
    const lookbackStart = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const { data: rows, error: rowsError } = await supabase
      .from('calendar_events')
      .select('source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day')
      .eq('user_id', userId)
      .gte('end_at', lookbackStart.toISOString())
      .lt('end_at', now.toISOString())
      .order('start_at', { ascending: false })
      .limit(candidateLimit);

    if (rowsError) {
      throw rowsError;
    }

    const calendarRows = (rows || []) as CalendarEventRow[];
    const contextByEvent = new Map<string, string>();
    const noteCountByEntityId = new Map<string, number>();
    const externalEventIds = [...new Set(calendarRows.map((row) => row.external_event_id).filter(Boolean))];
    const calendarEntityIds = calendarRows.map((row) =>
      buildCalendarEntityId({
        source: row.source,
        externalEventId: row.external_event_id,
        startAt: row.start_at,
      })
    );

    if (externalEventIds.length > 0) {
      const contextRows: CalendarEventContextRow[] = [];

      for (let index = 0; index < externalEventIds.length; index += IN_FILTER_BATCH_SIZE) {
        const batch = externalEventIds.slice(index, index + IN_FILTER_BATCH_SIZE);
        const { data, error: contextError } = await supabase
          .from('calendar_event_context')
          .select('source, external_event_id, meeting_context')
          .eq('user_id', userId)
          .in('external_event_id', batch);

        if (contextError) {
          if (!isMissingRelationError(contextError)) {
            throw contextError;
          }
          break;
        }

        contextRows.push(...((data || []) as CalendarEventContextRow[]));
      }

      for (const row of contextRows) {
        const meetingContext = row.meeting_context?.trim();
        if (!meetingContext) {
          continue;
        }
        contextByEvent.set(buildContextKey(row.source, row.external_event_id), meetingContext);
      }
    }

    if (calendarEntityIds.length > 0) {
      const noteLinkRows: NoteLinkCountRow[] = [];

      for (let index = 0; index < calendarEntityIds.length; index += IN_FILTER_BATCH_SIZE) {
        const batch = calendarEntityIds.slice(index, index + IN_FILTER_BATCH_SIZE);
        const { data, error: noteLinkError } = await supabase
          .from('note_links')
          .select('entity_id, note_id')
          .eq('user_id', userId)
          .eq('entity_type', 'calendar_event')
          .in('entity_id', batch);

        if (noteLinkError) {
          if (!isMissingRelationError(noteLinkError)) {
            throw noteLinkError;
          }
          break;
        }

        noteLinkRows.push(...((data || []) as NoteLinkCountRow[]));
      }

      const noteIdsByEntity = new Map<string, Set<string>>();

      for (const row of noteLinkRows) {
        const entityId = row.entity_id;
        const noteId = row.note_id;
        if (!entityId || !noteId) {
          continue;
        }

        const noteIds = noteIdsByEntity.get(entityId) ?? new Set<string>();
        noteIds.add(noteId);
        noteIdsByEntity.set(entityId, noteIds);
      }

      for (const [entityId, noteIds] of noteIdsByEntity.entries()) {
        noteCountByEntityId.set(entityId, noteIds.size);
      }
    }

    const events = calendarRows
      .map((row) => {
        const entityId = buildCalendarEntityId({
          source: row.source,
          externalEventId: row.external_event_id,
          startAt: row.start_at,
        });
        const meetingContext = contextByEvent.get(buildContextKey(row.source, row.external_event_id)) ?? null;
        const noteCount = noteCountByEntityId.get(entityId) ?? 0;
        const decoratedEvent = decorateCalendarEvent({
          source: row.source,
          start_at: row.start_at,
          end_at: row.end_at,
          title: row.title,
          with_display: parseEventPeople(row.with_display),
          body_scrubbed_preview: row.body_scrubbed_preview,
          is_all_day: row.is_all_day,
          external_event_id: row.external_event_id,
          meeting_context: meetingContext,
          note_count: noteCount,
        });

        return {
          ...decoratedEvent,
          note_count: noteCount,
          has_meeting_context: Boolean(meetingContext),
          history_reason:
            noteCount > 0 && meetingContext
              ? 'notes_and_context'
              : noteCount > 0
                ? 'notes'
                : 'context',
        };
      })
      .filter((event) => event.note_count > 0 || event.has_meeting_context)
      .slice(0, limit);

    return NextResponse.json({
      daysBack,
      limit,
      generatedAt: now.toISOString(),
      events,
    });
  } catch (error) {
    console.error('Error serving calendar history:', error);
    return NextResponse.json({ error: 'Failed to load calendar history' }, { status: 500 });
  }
}
