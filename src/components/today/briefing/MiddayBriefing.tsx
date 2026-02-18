"use client";

import Link from "next/link";
import { TaskProgressBar } from "./TaskProgressBar";
import { CalendarSummary } from "./CalendarSummary";
import { FocusBlockInline } from "./FocusBlockDisplay";
import type { ApiCalendarEvent } from "@/lib/calendar";
import type { FocusBlock, TaskSummary } from "@/lib/briefing";

interface MiddayBriefingProps {
  calendar: {
    events: ApiCalendarEvent[];
    focusBlocks: FocusBlock[];
  };
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
}

export function MiddayBriefing({ calendar, tasks, progress }: MiddayBriefingProps) {
  // Filter to only upcoming events (not past)
  const now = new Date();
  const upcomingEvents = calendar.events.filter(
    (e) => new Date(e.start_at) > now
  );

  // Next task recommendation
  const nextTask = tasks.remaining[0];

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <TaskProgressBar
        completedCount={progress.completedCount}
        totalCount={progress.totalCount}
        completedMinutes={progress.completedMinutes}
        remainingMinutes={progress.remainingMinutes}
        percentComplete={progress.percentComplete}
      />

      {/* Remaining tasks and upcoming meetings */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Remaining tasks */}
        <div className="rounded-lg border border-stroke bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Remaining Today
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({tasks.remaining.length} tasks)
            </span>
          </h3>

          {tasks.remaining.length === 0 ? (
            <p className="text-sm text-green-400">All tasks completed!</p>
          ) : (
            <ul className="space-y-2">
              {tasks.remaining.slice(0, 5).map((task) => (
                <li key={task.id} className="flex items-center gap-2">
                  <span className="text-muted-foreground">&#9744;</span>
                  <Link
                    href={`/tasks/${task.id}`}
                    className="flex-1 truncate text-sm text-foreground hover:text-accent"
                  >
                    {task.title}
                  </Link>
                  <span className="flex-shrink-0 text-xs text-muted-foreground">
                    {task.estimated_minutes}m
                  </span>
                </li>
              ))}
              {tasks.remaining.length > 5 && (
                <li className="text-xs text-muted-foreground">
                  +{tasks.remaining.length - 5} more
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Upcoming meetings */}
        <CalendarSummary
          events={upcomingEvents}
          title="Upcoming"
          maxEvents={4}
          showMeetingContext
        />
      </div>

      {/* Focus time and recommendation */}
      <div className="rounded-lg border border-stroke bg-panel p-4">
        <div className="flex items-center justify-between">
          <FocusBlockInline blocks={calendar.focusBlocks} />

          {nextTask && (
            <div className="text-right">
              <span className="text-xs text-muted-foreground">Next: </span>
              <Link
                href={`/tasks/${nextTask.id}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                {nextTask.title}
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Completed tasks (collapsed) */}
      {tasks.completed.length > 0 && (
        <details className="rounded-lg border border-green-500/20 bg-green-500/5">
          <summary className="cursor-pointer px-4 py-2 text-sm text-green-400">
            {tasks.completed.length} tasks completed ({progress.completedMinutes} min)
          </summary>
          <ul className="space-y-1 px-4 pb-3">
            {tasks.completed.map((task) => (
              <li key={task.id} className="flex items-center gap-2 text-sm">
                <span className="text-green-400">&#10003;</span>
                <span className="truncate text-muted-foreground line-through">
                  {task.title}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
