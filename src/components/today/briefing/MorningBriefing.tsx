"use client";

import Link from "next/link";
import { CapacityMeter } from "@/components/today/CapacityMeter";
import { CalendarSummary, CalendarStats } from "./CalendarSummary";
import { FocusBlockDisplay } from "./FocusBlockDisplay";
import type { CapacityResult } from "@/types/database";
import type { ApiCalendarEvent, BusyStats } from "@/lib/calendar";
import type { FocusBlock, TaskSummary } from "@/lib/briefing";

interface MorningBriefingProps {
  calendar: {
    events: ApiCalendarEvent[];
    stats: BusyStats;
    focusBlocks: FocusBlock[];
  };
  tasks: {
    planned: TaskSummary[];
    remaining: TaskSummary[];
  };
  capacity: CapacityResult;
}

export function MorningBriefing({ calendar, tasks, capacity }: MorningBriefingProps) {
  // Get top tasks to recommend
  const topTasks = tasks.remaining.slice(0, 4);
  const sundownTasks = tasks.remaining.filter((task) => task.implementation_phase === "Sundown");

  return (
    <div className="space-y-4">
      {/* Calendar and Capacity row */}
      <div className="grid gap-4 md:grid-cols-2">
        <CalendarSummary
          events={calendar.events}
          title="Today's Calendar"
          maxEvents={5}
          showParticipants
          showMeetingContext
        />

        <div className="space-y-4">
          <div className="rounded-lg border border-stroke bg-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Capacity</h3>
              <CapacityMeter capacity={capacity} />
            </div>
            <CalendarStats
              busyMinutes={calendar.stats.busyMinutes}
              blocks={calendar.stats.blocks}
              largestFocusBlock={calendar.stats.largestFocusBlockMinutes}
            />
          </div>
        </div>
      </div>

      {/* Focus blocks */}
      <FocusBlockDisplay blocks={calendar.focusBlocks} title="Available Focus Time" />

      {/* Recommended plan */}
      {topTasks.length > 0 && (
        <div className="rounded-lg border border-stroke bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Recommended Plan</h3>

          {/* Now/Next highlight */}
          {topTasks[0] && (
            <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <p className="mb-1 text-xs font-medium uppercase text-accent">Now / Next</p>
              <Link
                href={`/tasks/${topTasks[0].id}`}
                className="text-base font-medium text-foreground hover:text-accent"
              >
                {topTasks[0].title}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">
                {topTasks[0].estimated_minutes} min
                {topTasks[0].implementation_name && (
                  <span className="ml-2 text-xs">({topTasks[0].implementation_name})</span>
                )}
                {topTasks[0].implementation_phase === "Sundown" && (
                  <span className="ml-2 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                    Sundown
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Then list */}
          {topTasks.length > 1 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Then</p>
              <div className="flex flex-wrap gap-2">
                {topTasks.slice(1).map((task) => (
                  <Link
                    key={task.id}
                    href={`/tasks/${task.id}`}
                    className="rounded-lg border border-stroke bg-panel-muted px-3 py-1.5 text-sm text-foreground hover:border-accent hover:text-accent"
                  >
                    {task.title}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({task.estimated_minutes}m)
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {sundownTasks.length > 0 && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
          <h3 className="mb-2 text-sm font-semibold text-orange-300">Sundown Watch</h3>
          <ul className="space-y-1.5">
            {sundownTasks.slice(0, 4).map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2">
                <Link href={`/tasks/${task.id}`} className="truncate text-sm text-foreground hover:text-accent">
                  {task.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">{task.estimated_minutes}m</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
