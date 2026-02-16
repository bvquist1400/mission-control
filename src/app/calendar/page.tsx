"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";

interface CalendarEvent {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  start_raw: string | null;
  end_raw: string | null;
  source_tag: string;
}

interface CalendarResponse {
  events: CalendarEvent[];
  source_path: string;
  total_events: number;
  displayed_events: number;
  filtered_days_ahead: number | null;
  source: "xml" | "ics";
  ical_url: string | null;
  browse_url: string | null;
  warning: string | null;
  missing_file: boolean;
  message?: string;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4].map((index) => (
        <div key={index} className="animate-pulse rounded-card border border-stroke bg-panel p-4">
          <div className="h-4 w-1/2 rounded bg-panel-muted" />
          <div className="mt-3 h-3 w-1/3 rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

export default function CalendarPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<CalendarResponse | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadCalendar() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/calendar?days=30${showAll ? "&all=true" : ""}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to fetch calendar");
        }

        const payload = (await response.json()) as CalendarResponse;
        if (isMounted) {
          setData(payload);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load calendar");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadCalendar();

    return () => {
      isMounted = false;
    };
  }, [showAll]);

  const subtitle = useMemo(() => {
    if (!data) {
      return "Import and view calendar metadata from an XML file in the repo.";
    }

    if (data.missing_file) {
      return `No file found yet at ${data.source_path}.`;
    }

    if (data.filtered_days_ahead) {
      return `Showing ${data.displayed_events} of ${data.total_events} events within ${data.filtered_days_ahead} days.`;
    }

    return `Showing all ${data.displayed_events} parsed events.`;
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description={subtitle}
        actions={
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            {showAll ? "Show 30 Days" : "Show All"}
          </button>
        }
      />

      <section className="rounded-card border border-stroke bg-panel p-4 text-sm text-muted-foreground">
        <p className="font-semibold text-foreground">Calendar file path</p>
        <p className="mt-1">
          Put your XML at <code className="rounded bg-panel-muted px-1.5 py-0.5 text-xs">data/calendar/work-calendar.xml</code>
        </p>
        {data?.source ? (
          <p className="mt-2 text-xs">
            Source mode: <span className="font-semibold text-foreground">{data.source.toUpperCase()}</span>
          </p>
        ) : null}
        {data?.ical_url ? (
          <p className="mt-2 text-xs">
            ICal URL detected.{" "}
            <a
              href={data.ical_url}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-accent underline underline-offset-2"
            >
              Open feed
            </a>
          </p>
        ) : null}
      </section>

      {data?.warning ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700" role="alert">
          {data.warning}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <LoadingSkeleton /> : null}

      {!loading && data?.missing_file ? (
        <div className="rounded-card border border-dashed border-stroke bg-panel p-8 text-center">
          <p className="text-lg font-semibold text-foreground">No calendar file yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Add your XML file at <code className="rounded bg-panel-muted px-1.5 py-0.5 text-xs">data/calendar/work-calendar.xml</code> and refresh this page.
          </p>
        </div>
      ) : null}

      {!loading && data && !data.missing_file && data.events.length === 0 ? (
        <div className="rounded-card border border-stroke bg-panel p-8 text-center">
          <p className="text-lg font-semibold text-foreground">No events parsed</p>
          <p className="mt-2 text-sm text-muted-foreground">
            The XML file was loaded, but no recognizable event entries were found.
          </p>
        </div>
      ) : null}

      {!loading && data && data.events.length > 0 ? (
        <section className="overflow-hidden rounded-card border border-stroke bg-panel">
          <div className="grid grid-cols-[1.6fr_1.2fr_1.2fr_1fr] gap-3 border-b border-stroke px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Event</span>
            <span>Start</span>
            <span>End</span>
            <span>Location</span>
          </div>

          <ul className="divide-y divide-stroke">
            {data.events.map((event) => (
              <li key={event.id} className="grid grid-cols-[1.6fr_1.2fr_1.2fr_1fr] gap-3 px-4 py-3 text-sm">
                <div>
                  <p className="font-semibold text-foreground">{event.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Source: &lt;{event.source_tag}&gt;</p>
                </div>
                <span className="text-muted-foreground">{formatDateTime(event.start_at ?? event.start_raw)}</span>
                <span className="text-muted-foreground">{formatDateTime(event.end_at ?? event.end_raw)}</span>
                <span className="text-muted-foreground">{event.location ?? "—"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
