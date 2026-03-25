"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MeetingNotesPanel } from "@/components/calendar/MeetingNotesPanel";
import { PageHeader } from "@/components/layout/PageHeader";
import type { CalendarTemporalStatus } from "@/lib/calendar";
import type { CalendarEventSource } from "@/lib/calendar-event-identity";

const MAX_MEETING_CONTEXT_CHARS = 8000;

export interface MeetingDetailEvent {
  source: CalendarEventSource;
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[];
  body_scrubbed_preview: string | null;
  meeting_context: string | null;
  meeting_context_updated_at: string | null;
  note_count: number;
  is_all_day: boolean;
  external_event_id: string;
  date_et?: string;
  start_time_et?: string;
  end_time_et?: string;
  time_range_et?: string;
  temporal_status?: CalendarTemporalStatus;
}

interface MeetingDetailViewProps {
  event: MeetingDetailEvent;
}

function formatSourceLabel(source: CalendarEventSource): string {
  switch (source) {
    case "ical":
      return "iCal";
    case "graph":
      return "Microsoft Graph";
    case "local":
    default:
      return "Local";
  }
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatStatusLabel(status?: CalendarTemporalStatus): string {
  switch (status) {
    case "past":
      return "Past Meeting";
    case "in_progress":
      return "Happening Now";
    case "upcoming":
    default:
      return "Upcoming";
  }
}

function statusBadgeClass(status?: CalendarTemporalStatus): string {
  switch (status) {
    case "past":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "in_progress":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    case "upcoming":
    default:
      return "border-sky-500/30 bg-sky-500/10 text-sky-300";
  }
}

export function MeetingDetailView({ event }: MeetingDetailViewProps) {
  const [savedContext, setSavedContext] = useState(event.meeting_context ?? "");
  const [contextDraft, setContextDraft] = useState(event.meeting_context ?? "");
  const [savedAt, setSavedAt] = useState(event.meeting_context_updated_at);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedDraft = contextDraft.trim();
  const trimmedSavedContext = savedContext.trim();
  const isDirty = trimmedDraft !== trimmedSavedContext;
  const detailSubtitle = useMemo(() => {
    const dateLabel = event.date_et ? `${event.date_et}` : formatTimestamp(event.start_at);
    const timeLabel = event.time_range_et ?? `${event.start_time_et ?? ""}`.trim();
    return `${formatStatusLabel(event.temporal_status)} • ${dateLabel}${timeLabel ? ` • ${timeLabel}` : ""}`;
  }, [event.date_et, event.start_at, event.start_time_et, event.temporal_status, event.time_range_et]);

  async function saveMeetingContext(): Promise<void> {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          external_event_id: event.external_event_id,
          start_at: event.start_at,
          meeting_context: trimmedDraft.length > 0 ? trimmedDraft : null,
        }),
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            error?: string;
            meeting_context?: string | null;
          }
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Failed to save meeting context");
      }

      const nextContext = typeof payload?.meeting_context === "string" ? payload.meeting_context : "";
      setSavedContext(nextContext);
      setContextDraft(nextContext);
      setSavedAt(new Date().toISOString());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save meeting context");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={event.title}
        description={detailSubtitle}
        actions={
          <Link
            href="/calendar"
            className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-panel-muted"
          >
            Open Calendar
          </Link>
        }
      />

      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${statusBadgeClass(event.temporal_status)}`}>
            {formatStatusLabel(event.temporal_status)}
          </span>
          <span className="rounded-full border border-stroke bg-panel-muted px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {formatSourceLabel(event.source)}
          </span>
          <span className="rounded-full border border-stroke bg-panel-muted px-3 py-1 text-xs font-semibold text-foreground">
            {event.note_count} {event.note_count === 1 ? "note" : "notes"}
          </span>
          {event.is_all_day ? (
            <span className="rounded-full border border-stroke bg-panel-muted px-3 py-1 text-xs font-semibold text-foreground">
              All day
            </span>
          ) : null}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-stroke bg-panel-muted/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">When</p>
            <p className="mt-2 text-base font-semibold text-foreground">{event.date_et ?? formatTimestamp(event.start_at)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {event.time_range_et ?? `${event.start_time_et ?? formatTimestamp(event.start_at)} - ${event.end_time_et ?? formatTimestamp(event.end_at)}`}
            </p>
          </div>

          <div className="rounded-xl border border-stroke bg-panel-muted/70 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Attendees</p>
            {event.with_display.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {event.with_display.map((person) => (
                  <span key={person} className="rounded-full border border-stroke bg-panel px-3 py-1 text-xs text-foreground">
                    {person}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No attendee names were stored for this meeting.</p>
            )}
          </div>
        </div>

        {event.temporal_status === "past" ? (
          <p className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            This meeting is stored in your retained calendar history and stays searchable with its linked notes.
          </p>
        ) : null}
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <div className="space-y-6">
          <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Meeting Context</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">Prep, goals, and why this meeting matters</h2>
              </div>
              <span className="rounded-full border border-stroke bg-panel-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                {trimmedDraft.length}/{MAX_MEETING_CONTEXT_CHARS}
              </span>
            </div>

            <p className="mt-3 text-sm text-muted-foreground">
              Keep the planning context here so the meeting remains useful when it shows up in search again later.
            </p>

            <textarea
              value={contextDraft}
              onChange={(event) => setContextDraft(event.target.value)}
              placeholder="Capture goals, risks, decision points, prep asks, or the thread you want preserved."
              rows={7}
              maxLength={MAX_MEETING_CONTEXT_CHARS}
              className="mt-4 w-full rounded-xl border border-stroke bg-panel-muted px-3 py-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {savedAt && !isDirty ? `Saved ${formatTimestamp(savedAt)}` : isDirty ? "Unsaved changes" : "No saved meeting context yet"}
              </p>
              <button
                type="button"
                onClick={() => void saveMeetingContext()}
                disabled={isSaving || !isDirty}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? "Saving..." : "Save Context"}
              </button>
            </div>

            {error ? (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            ) : null}
          </article>

          <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Sanitized Invite Details</p>
            <h2 className="mt-2 text-lg font-semibold text-foreground">Meeting body preview</h2>
            {event.body_scrubbed_preview ? (
              <div className="mt-4 rounded-xl border border-stroke bg-panel-muted/70 p-4">
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{event.body_scrubbed_preview}</p>
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-dashed border-stroke bg-panel-muted/45 px-4 py-5 text-sm text-muted-foreground">
                No sanitized invite body was stored for this meeting. Notes and meeting context can still be attached here.
              </p>
            )}
          </article>
        </div>

        <div>
          <MeetingNotesPanel
            event={{
              source: event.source,
              externalEventId: event.external_event_id,
              startAt: event.start_at,
            }}
          />
        </div>
      </section>
    </div>
  );
}
