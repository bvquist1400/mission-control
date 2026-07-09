import { createSupabaseServerClient } from "@/lib/supabase/server";
import { queryTodayCalendar, type TodayCalendarEvent } from "@/lib/today/queries";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

type MeetingTemporalStatus = "Upcoming" | "In progress" | "Ended";

function getMeetingTemporalStatus(event: TodayCalendarEvent, nowMs: number): MeetingTemporalStatus {
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "Upcoming";
  }

  if (nowMs >= endMs) {
    return "Ended";
  }

  if (nowMs >= startMs) {
    return "In progress";
  }

  return "Upcoming";
}

function formatMeetingTimeRange(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Time unavailable";
  }

  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TIME_ZONE,
    }).format(date);

  return `${format(startDate)} - ${format(endDate)}`;
}

function MeetingStatusBadge({ status }: { status: MeetingTemporalStatus }) {
  if (status === "Ended") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
          <path d="M7.7 13.3 4.4 10l1.2-1.2 2.1 2.1 6.7-6.7L15.6 5l-7.9 8.3Z" />
        </svg>
        Ended
      </span>
    );
  }

  if (status === "In progress") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        In progress
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full border border-stroke bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
      Upcoming
    </span>
  );
}

function MeetingsCard({
  events,
  failed,
}: {
  events: TodayCalendarEvent[];
  failed: boolean;
}) {
  const nowMs = Date.now();
  const sorted = [...events]
    .filter((event) => typeof event.start === "string" && typeof event.end === "string")
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Today&apos;s Meetings</h2>
      </div>
      <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        {failed ? (
          <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Meeting feed refresh failed. Showing available data.
          </p>
        ) : null}
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No meetings on your calendar today.</p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((event, index) => {
              const temporalStatus = getMeetingTemporalStatus(event, nowMs);
              return (
                <li
                  key={`${event.start}-${event.title}-${index}`}
                  className={`rounded-lg p-3 text-sm ${
                    temporalStatus === "Ended" ? "bg-emerald-500/5" : "bg-panel-muted"
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className={`font-medium ${temporalStatus === "Ended" ? "text-muted-foreground" : "text-foreground"}`}>
                        {event.title || "Untitled meeting"}
                      </p>
                      <p className="mt-1 text-muted-foreground">{formatMeetingTimeRange(event.start, event.end)}</p>
                      {event.location ? <p className="mt-1 text-muted-foreground">{event.location}</p> : null}
                    </div>
                    <div className="shrink-0 self-center">
                      <MeetingStatusBadge status={temporalStatus} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </div>
  );
}

export async function MeetingsSection({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();

  try {
    const { events } = await queryTodayCalendar(supabase, userId, TIME_ZONE);
    return <MeetingsCard events={events} failed={false} />;
  } catch (error) {
    console.error("Failed to load today's meetings:", error);
    return <MeetingsCard events={[]} failed />;
  }
}
