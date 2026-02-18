"use client";

import type { ApiCalendarEvent } from "@/lib/calendar";

interface CalendarSummaryProps {
  events: ApiCalendarEvent[];
  title?: string;
  maxEvents?: number;
  showParticipants?: boolean;
  showMeetingContext?: boolean;
  meetingContextMaxChars?: number;
}

function formatEventTime(isoTime: string): string {
  return new Date(isoTime).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Kept for potential future use
// function formatEventTimeRange(start: string, end: string, isAllDay: boolean): string {
//   if (isAllDay) return "All day";
//   return `${formatEventTime(start)} - ${formatEventTime(end)}`;
// }

export function CalendarSummary({
  events,
  title = "Calendar",
  maxEvents = 5,
  showParticipants = false,
  showMeetingContext = false,
  meetingContextMaxChars = 120,
}: CalendarSummaryProps) {
  const displayEvents = events.slice(0, maxEvents);
  const hasMore = events.length > maxEvents;

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-stroke bg-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No meetings scheduled</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-stroke bg-panel p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <ul className="space-y-2">
        {displayEvents.map((event) => (
          <li
            key={`${event.external_event_id}-${event.start_at}`}
            className="flex items-start gap-3"
          >
            <span className="w-24 flex-shrink-0 text-xs font-medium text-muted-foreground">
              {formatEventTime(event.start_at)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {event.title}
              </p>
              {showParticipants && event.with_display.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  with {event.with_display.slice(0, 3).join(", ")}
                  {event.with_display.length > 3 && ` +${event.with_display.length - 3}`}
                </p>
              )}
              {showMeetingContext && event.meeting_context && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Context:{" "}
                  {event.meeting_context.length > meetingContextMaxChars
                    ? `${event.meeting_context.slice(0, meetingContextMaxChars).trimEnd()}...`
                    : event.meeting_context}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {hasMore && (
        <p className="mt-2 text-xs text-muted-foreground">
          +{events.length - maxEvents} more
        </p>
      )}
    </div>
  );
}

interface CalendarStatsProps {
  busyMinutes: number;
  blocks: number;
  largestFocusBlock: number;
}

export function CalendarStats({ busyMinutes, blocks, largestFocusBlock }: CalendarStatsProps) {
  const hours = Math.floor(busyMinutes / 60);
  const mins = busyMinutes % 60;
  const busyDisplay = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <div>
        <span className="text-muted-foreground">Meeting load:</span>{" "}
        <span className="font-medium text-foreground">{busyDisplay}</span>
      </div>
      <div>
        <span className="text-muted-foreground">Blocks:</span>{" "}
        <span className="font-medium text-foreground">{blocks}</span>
      </div>
      <div>
        <span className="text-muted-foreground">Largest gap:</span>{" "}
        <span className="font-medium text-foreground">{largestFocusBlock} min</span>
      </div>
    </div>
  );
}
