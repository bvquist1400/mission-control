"use client";

import { CalendarSummary, CalendarStats } from "./CalendarSummary";
import { PrepTaskList, RolledOverList, CompletedList } from "./PrepTaskList";
import type { CapacityResult } from "@/types/database";
import type { ApiCalendarEvent, BusyStats } from "@/lib/calendar";
import type { PrepTask, TaskSummary } from "@/lib/briefing";

interface EODBriefingProps {
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
}

function formatDateDisplay(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function EODBriefing({ today, tomorrow }: EODBriefingProps) {
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

      {/* Tomorrow section */}
      <div>
        <h3 className="mb-3 text-base font-semibold text-foreground">
          Tomorrow ({formatDateDisplay(tomorrow.date)})
        </h3>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Tomorrow's calendar */}
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

          {/* Prep tasks */}
          <div className="space-y-3">
            <PrepTaskList
              tasks={tomorrow.prepTasks}
              title="Prep Tasks for Tonight"
              maxTasks={5}
            />

            {/* Capacity preview */}
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

      {/* Quick action suggestion */}
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
