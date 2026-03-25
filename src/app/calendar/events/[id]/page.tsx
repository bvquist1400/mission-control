import { notFound, redirect } from "next/navigation";
import { MeetingDetailView, type MeetingDetailEvent } from "@/components/calendar/MeetingDetailView";
import { decorateCalendarEvent, parseEventPeople } from "@/lib/calendar";
import { buildCalendarEntityId, decodeCalendarEventIdentity } from "@/lib/calendar-event-identity";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface MeetingDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

interface CalendarEventContextRow {
  meeting_context: string;
  updated_at: string;
}

interface NoteLinkRow {
  note_id: string;
}

function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === "42P01" || candidate.code === "PGRST205") {
    return true;
  }

  const message = `${candidate.message ?? ""} ${candidate.details ?? ""} ${candidate.hint ?? ""}`.toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

export default async function CalendarEventDetailPage({ params }: MeetingDetailPageProps) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);
  const identity = decodeCalendarEventIdentity(decodedId);

  if (!identity) {
    notFound();
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/calendar/events/${decodedId}`)}`);
  }

  const { data: event, error: eventError } = await supabase
    .from("calendar_events")
    .select("source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day")
    .eq("user_id", user.id)
    .eq("source", identity.source)
    .eq("external_event_id", identity.externalEventId)
    .eq("start_at", identity.startAt)
    .maybeSingle();

  if (eventError) {
    throw eventError;
  }

  if (!event) {
    notFound();
  }

  let meetingContext: string | null = null;
  let meetingContextUpdatedAt: string | null = null;

  const contextResult = await supabase
    .from("calendar_event_context")
    .select("meeting_context, updated_at")
    .eq("user_id", user.id)
    .eq("source", identity.source)
    .eq("external_event_id", identity.externalEventId)
    .maybeSingle();

  if (contextResult.error) {
    if (!isMissingRelationError(contextResult.error)) {
      throw contextResult.error;
    }
  } else {
    const contextRow = contextResult.data as CalendarEventContextRow | null;
    meetingContext = contextRow?.meeting_context?.trim() || null;
    meetingContextUpdatedAt = contextRow?.updated_at ?? null;
  }

  let noteCount = 0;
  const noteLinksResult = await supabase
    .from("note_links")
    .select("note_id")
    .eq("user_id", user.id)
    .eq("entity_type", "calendar_event")
    .eq("entity_id", buildCalendarEntityId(identity));

  if (noteLinksResult.error) {
    if (!isMissingRelationError(noteLinksResult.error)) {
      throw noteLinksResult.error;
    }
  } else {
    noteCount = new Set((noteLinksResult.data as NoteLinkRow[] | null)?.map((row) => row.note_id) ?? []).size;
  }

  const decoratedEvent = decorateCalendarEvent({
    source: event.source,
    start_at: event.start_at,
    end_at: event.end_at,
    title: event.title,
    with_display: parseEventPeople(event.with_display),
    body_scrubbed_preview: event.body_scrubbed_preview,
    meeting_context: meetingContext,
    note_count: noteCount,
    is_all_day: event.is_all_day,
    external_event_id: event.external_event_id,
  });

  const meetingEvent: MeetingDetailEvent = {
    source: event.source,
    start_at: event.start_at,
    end_at: event.end_at,
    title: event.title,
    with_display: decoratedEvent.with_display,
    body_scrubbed_preview: event.body_scrubbed_preview,
    meeting_context: meetingContext,
    meeting_context_updated_at: meetingContextUpdatedAt,
    note_count: noteCount,
    is_all_day: event.is_all_day,
    external_event_id: event.external_event_id,
    date_et: decoratedEvent.date_et,
    start_time_et: decoratedEvent.start_time_et,
    end_time_et: decoratedEvent.end_time_et,
    time_range_et: decoratedEvent.time_range_et,
    temporal_status: decoratedEvent.temporal_status,
  };

  return <MeetingDetailView event={meetingEvent} />;
}
