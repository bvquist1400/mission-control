'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';

interface CalendarEvent {
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[];
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
  external_event_id: string;
}

interface BusyBlock {
  start_at: string;
  end_at: string;
}

interface CalendarResponse {
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
  source: 'local' | 'ical' | 'none';
  warning: string | null;
  warnings: string[];
  ingest: {
    source: 'local' | 'ical' | 'none';
    ingestedCount: number;
    warningCount: number;
  };
  events: CalendarEvent[];
  busyBlocks: BusyBlock[];
  stats: {
    busyMinutes: number;
    blocks: number;
    largestFocusBlockMinutes: number;
  };
  changesSince: {
    added: Array<{ external_event_id: string; start_at: string; end_at: string }>;
    removed: Array<{ external_event_id: string; start_at: string; end_at: string }>;
    changed: Array<{
      external_event_id: string;
      previous_start_at: string;
      previous_end_at: string;
      start_at: string;
      end_at: string;
      timeChanged: boolean;
      contentChanged: boolean;
    }>;
  };
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatMinutes(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateString(date);
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
  const [authRequired, setAuthRequired] = useState(false);
  const [daysAhead, setDaysAhead] = useState(7);
  const [data, setData] = useState<CalendarResponse | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadCalendar() {
      setLoading(true);
      setError(null);
      setAuthRequired(false);

      const today = toDateString(new Date());
      const rangeStart = today;
      const rangeEnd = addDays(today, daysAhead);

      try {
        const response = await fetch(`/api/calendar?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`, { cache: 'no-store' });

        if (response.status === 401) {
          if (isMounted) {
            setAuthRequired(true);
            setData(null);
          }
          return;
        }

        if (!response.ok) {
          const failure = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(failure?.error ?? 'Failed to fetch calendar');
        }

        const payload = (await response.json()) as CalendarResponse;
        if (isMounted) {
          setData(payload);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load calendar');
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
  }, [daysAhead]);

  const subtitle = useMemo(() => {
    if (authRequired) {
      return 'Sign in to load your private calendar events.';
    }

    if (!data) {
      return 'Secure, sanitized calendar context for daily briefs.';
    }

    return `Showing ${data.events.length} events from ${data.rangeStart} to ${data.rangeEnd}.`;
  }, [authRequired, data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description={subtitle}
        actions={
          <button
            type="button"
            onClick={() => setDaysAhead((current) => (current === 7 ? 14 : 7))}
            className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            {daysAhead === 7 ? 'Show 14 Days' : 'Show 7 Days'}
          </button>
        }
      />

      {authRequired ? (
        <section className="rounded-card border border-stroke bg-panel p-6">
          <p className="text-base font-semibold text-foreground">Authentication required</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Calendar access requires a signed-in Supabase session.
          </p>
          <Link
            href="/login?next=%2Fcalendar"
            className="mt-4 inline-flex rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Sign in with magic link
          </Link>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {data?.warning ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
          {data.warning}
        </p>
      ) : null}

      {loading ? <LoadingSkeleton /> : null}

      {!loading && data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-4">
            <article className="rounded-card border border-stroke bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Busy time</p>
              <p className="mt-2 text-xl font-semibold text-foreground">{formatMinutes(data.stats.busyMinutes)}</p>
            </article>
            <article className="rounded-card border border-stroke bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Busy blocks</p>
              <p className="mt-2 text-xl font-semibold text-foreground">{data.stats.blocks}</p>
            </article>
            <article className="rounded-card border border-stroke bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Largest focus block</p>
              <p className="mt-2 text-xl font-semibold text-foreground">{formatMinutes(data.stats.largestFocusBlockMinutes)}</p>
            </article>
            <article className="rounded-card border border-stroke bg-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ingested events</p>
              <p className="mt-2 text-xl font-semibold text-foreground">{data.ingest.ingestedCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Source {data.ingest.source.toUpperCase()}
                {data.ingest.warningCount > 0 ? ` • ${data.ingest.warningCount} warning(s)` : ''}
              </p>
            </article>
          </section>

          <section className="rounded-card border border-stroke bg-panel p-4 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">Delta since previous snapshot</p>
            <p className="mt-1 text-xs">Source: {data.source.toUpperCase()}</p>
            <p className="mt-1">
              Added: <span className="font-semibold text-foreground">{data.changesSince.added.length}</span> | Removed:{' '}
              <span className="font-semibold text-foreground">{data.changesSince.removed.length}</span> | Changed:{' '}
              <span className="font-semibold text-foreground">{data.changesSince.changed.length}</span>
            </p>
            <p className="mt-1 text-xs">Last refreshed {formatDateTime(data.generatedAt)}.</p>
          </section>

          {data.events.length === 0 ? (
            <div className="rounded-card border border-stroke bg-panel p-8 text-center">
              <p className="text-lg font-semibold text-foreground">No events in range</p>
              <p className="mt-2 text-sm text-muted-foreground">Try a broader range or verify your calendar source settings.</p>
            </div>
          ) : (
            <section className="overflow-hidden rounded-card border border-stroke bg-panel">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_2fr] gap-3 border-b border-stroke px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Event</span>
                <span>With</span>
                <span>Time</span>
                <span>Agenda Preview</span>
              </div>

              <ul className="divide-y divide-stroke">
                {data.events.map((event) => (
                  <li key={`${event.external_event_id}-${event.start_at}`} className="grid grid-cols-[1.5fr_1fr_1fr_2fr] gap-3 px-4 py-3 text-sm">
                    <div>
                      <p className="font-semibold text-foreground">{event.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{event.is_all_day ? 'All day' : 'Timed event'}</p>
                    </div>

                    <span className="text-muted-foreground">{event.with_display.length > 0 ? event.with_display.join(', ') : '—'}</span>

                    <span className="text-muted-foreground">
                      {formatDateTime(event.start_at)} - {formatDateTime(event.end_at)}
                    </span>

                    <span className="text-muted-foreground">{event.body_scrubbed_preview ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
