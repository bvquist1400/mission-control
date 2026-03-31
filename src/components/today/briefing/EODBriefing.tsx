"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarSummary, CalendarStats } from "./CalendarSummary";
import { PrepTaskList, RolledOverList, CompletedList } from "./PrepTaskList";
import type { CapacityResult } from "@/types/database";
import type { ApiCalendarEvent, BusyStats } from "@/lib/calendar";
import type {
  DailyBriefStatusUpdateRecommendation,
  PrepTask,
  TaskSummary,
} from "@/lib/briefing";

interface EODBriefingProps {
  requestedDate: string;
  today: {
    tasks: {
      completed: TaskSummary[];
      remaining: TaskSummary[];
    };
    progress: {
      completedCount: number;
      totalCount: number;
      completedMinutes: number;
      remainingMinutes: number;
      percentComplete: number;
    };
  };
  tomorrow: {
    date: string;
    calendar: {
      events: ApiCalendarEvent[];
      stats: BusyStats;
    };
    prepTasks: PrepTask[];
    rolledOver: TaskSummary[];
    estimatedCapacity: CapacityResult;
  };
  statusUpdateRecommendations: DailyBriefStatusUpdateRecommendation[];
  onStatusUpdateSaved?: () => void;
}

interface StatusUpdateReminderCardProps {
  requestedDate: string;
  recommendation: DailyBriefStatusUpdateRecommendation;
  onSaved?: () => void;
}

function formatDateDisplay(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatEtDateTime(value: string | null): string {
  if (!value) {
    return "No current status artifact";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

async function saveStatusUpdateRecommendation(
  requestedDate: string,
  recommendation: DailyBriefStatusUpdateRecommendation,
  note: string
): Promise<void> {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    throw new Error("Status update is required");
  }

  if (recommendation.entity_type === "implementation") {
    const response = await fetch(`/api/applications/${recommendation.entity_id}/copy-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        saveToLog: true,
        note: trimmedNote,
        createdBy: "Assistant",
        syncStatusSummary: true,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({ error: "Failed to save status update" }));
      throw new Error(typeof data.error === "string" ? data.error : "Failed to save status update");
    }

    return;
  }

  const response = await fetch("/api/project-status-updates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: recommendation.entity_id,
      summary: trimmedNote,
      captured_for_date: requestedDate,
      related_task_ids: recommendation.related_tasks.map((task) => task.id),
      source: "briefing_eod",
      sync_project_status_summary: true,
      payload: {
        recommendation_summary: recommendation.summary,
        recommendation_reason: recommendation.reason,
      },
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Failed to save project status update" }));
    throw new Error(typeof data.error === "string" ? data.error : "Failed to save project status update");
  }
}

function StatusUpdateReminderCard({
  requestedDate,
  recommendation,
  onSaved,
}: StatusUpdateReminderCardProps) {
  const [draft, setDraft] = useState(recommendation.summary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(recommendation.summary);
    setError(null);
  }, [recommendation.entity_id, recommendation.latest_movement_at, recommendation.summary]);

  async function handleApprove() {
    setSaving(true);
    setError(null);

    try {
      await saveStatusUpdateRecommendation(requestedDate, recommendation, draft);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save status update");
    } finally {
      setSaving(false);
    }
  }

  const entityHref =
    recommendation.entity_type === "implementation"
      ? `/applications/${recommendation.entity_id}`
      : `/projects/${recommendation.entity_id}`;
  const entityLabel =
    recommendation.entity_type === "implementation" ? "Application" : "Project";

  return (
    <div className="rounded-lg border border-stroke bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-stroke bg-panel-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {entityLabel}
        </span>
        <Link href={entityHref} className="text-sm font-semibold text-foreground hover:text-accent">
          {recommendation.entity_name}
        </Link>
      </div>

      <p className="mt-3 text-sm text-foreground">{recommendation.reason}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Last status artifact: {formatEtDateTime(recommendation.last_status_artifact_at)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Latest movement: {formatEtDateTime(recommendation.latest_movement_at)}
      </p>

      {recommendation.related_tasks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {recommendation.related_tasks.slice(0, 4).map((task) => (
            <Link
              key={task.id}
              href={`/tasks/${task.id}`}
              className="rounded-full border border-stroke bg-panel-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {task.title}
            </Link>
          ))}
        </div>
      )}

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Status Update Draft
      </label>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        disabled={saving}
        className="mt-1 w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Saving will write history and sync the current status summary.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleApprove}
          disabled={saving || !draft.trim()}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving..." : "Approve And Save"}
        </button>
      </div>
    </div>
  );
}

export function EODBriefing({
  requestedDate,
  today,
  tomorrow,
  statusUpdateRecommendations,
  onStatusUpdateSaved,
}: EODBriefingProps) {
  return (
    <div className="space-y-6">
      {/* Today's Review */}
      <div>
        <h3 className="mb-3 text-base font-semibold text-foreground">Today&apos;s Review</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <CompletedList tasks={today.tasks.completed} />
          <RolledOverList tasks={today.tasks.remaining} />
        </div>

        {today.tasks.completed.length === 0 && today.tasks.remaining.length === 0 && (
          <p className="text-sm text-muted-foreground">No tracked tasks for today</p>
        )}
      </div>

      {statusUpdateRecommendations.length > 0 && (
        <div>
          <div className="mb-3">
            <h3 className="text-base font-semibold text-foreground">Status Update Reminders</h3>
            <p className="text-sm text-muted-foreground">
              Review the draft, then approve to write history and sync the latest status.
            </p>
          </div>
          <div className="space-y-4">
            {statusUpdateRecommendations.map((recommendation) => (
              <StatusUpdateReminderCard
                key={`${recommendation.entity_type}:${recommendation.entity_id}:${recommendation.latest_movement_at}`}
                requestedDate={requestedDate}
                recommendation={recommendation}
                onSaved={onStatusUpdateSaved}
              />
            ))}
          </div>
        </div>
      )}

      {/* Tomorrow section */}
      <div>
        <h3 className="mb-3 text-base font-semibold text-foreground">
          Tomorrow ({formatDateDisplay(tomorrow.date)})
        </h3>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <CalendarSummary
              events={tomorrow.calendar.events}
              title="Calendar"
              maxEvents={6}
              showParticipants
              showMeetingContext
            />
            <div className="rounded-lg border border-stroke bg-panel p-3">
              <CalendarStats
                busyMinutes={tomorrow.calendar.stats.busyMinutes}
                blocks={tomorrow.calendar.stats.blocks}
                largestFocusBlock={tomorrow.calendar.stats.largestFocusBlockMinutes}
              />
            </div>
          </div>

          <div className="space-y-3">
            <PrepTaskList
              tasks={tomorrow.prepTasks}
              title="Prep Tasks for Tonight"
              maxTasks={5}
            />

            {tomorrow.calendar.events.length > 0 && (
              <div className="rounded-lg border border-stroke bg-panel p-3">
                <p className="text-sm">
                  <span className="text-muted-foreground">Est. focus time: </span>
                  <span className="font-medium text-foreground">
                    {tomorrow.estimatedCapacity.available_minutes} min
                  </span>
                </p>
                {tomorrow.rolledOver.length > 0 && (
                  <p className="mt-1 text-xs text-yellow-400">
                    {tomorrow.rolledOver.length} tasks rolling over
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {tomorrow.prepTasks.length > 0 && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
          <p className="text-sm">
            <span className="font-medium text-accent">Suggestion:</span>{" "}
            <span className="text-foreground">
              Start with &ldquo;{tomorrow.prepTasks[0].task.title}&rdquo;
              {tomorrow.prepTasks[0].targetMeetingTime && (
                <span className="text-muted-foreground">
                  {" "}to prepare for tomorrow&apos;s meeting
                </span>
              )}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
