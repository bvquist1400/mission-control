import type { ReactNode } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  queryLatestSyncEvent,
  queryNeedsReviewCount,
  queryTodayCalendar,
  queryWaitingSummary,
  queryWeekDoneTasks,
  queryWeeklyBoardTasks,
} from "@/lib/today/queries";
import { WeekBoard } from "@/components/today/sections/WeekBoard";
import type { StripEvent } from "@/components/today/sections/TodayStrip";
import type { TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { addDateOnlyDays, getDateStartInTimeZone, getDisplayedWeekRange } from "@/lib/today/week-board";
import type { TaskScope } from "@/lib/personal-exclusion";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

/** Start (Monday 00:00) and end (Sunday 23:59:59.999) of the current week in ET, as UTC instants. */
function currentWeekBounds(now: Date): { start: Date; end: Date } {
  const { start, end } = getDisplayedWeekRange(now, TIME_ZONE);
  return {
    start: getDateStartInTimeZone(start, TIME_ZONE),
    end: new Date(getDateStartInTimeZone(addDateOnlyDays(end, 1), TIME_ZONE).getTime() - 1),
  };
}

/**
 * Today (redesign S4): the one-line strip and the week board stream together.
 * Reads run in parallel and each one fails on its own (the board shows what loaded).
 */
export async function WeekBoardSection({
  userId,
  mode,
  chips,
  phoneHint = false,
}: {
  userId: string;
  mode: TaskScope;
  chips?: ReactNode;
  /** Today v2: the request came from a phone's browser (Today opens into today's list). */
  phoneHint?: boolean;
}) {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const week = currentWeekBounds(now);

  const [weekBoardRes, waitingRes, needsReviewRes, syncRes, doneRes, calendarRes] = await Promise.allSettled([
    queryWeeklyBoardTasks(supabase, userId, week.end, 200, undefined, mode),
    queryWaitingSummary(supabase, userId, 30, mode),
    queryNeedsReviewCount(supabase, userId, mode),
    queryLatestSyncEvent(supabase, userId),
    queryWeekDoneTasks(supabase, userId, week.start, week.end, mode),
    queryTodayCalendar(supabase, userId, TIME_ZONE),
  ]);

  const hasError =
    weekBoardRes.status === "rejected" ||
    waitingRes.status === "rejected" ||
    needsReviewRes.status === "rejected" ||
    doneRes.status === "rejected";

  const weekBoardTasks: TaskWithImplementation[] = weekBoardRes.status === "fulfilled" ? weekBoardRes.value : [];
  const waitingTasks: TaskWithImplementation[] = waitingRes.status === "fulfilled" ? waitingRes.value : [];
  const doneTasks: TaskWithImplementation[] = doneRes.status === "fulfilled" ? doneRes.value : [];
  const needsReviewCount = needsReviewRes.status === "fulfilled" ? needsReviewRes.value : 0;
  const syncedTaskIds = syncRes.status === "fulfilled" && syncRes.value ? syncRes.value.task_ids : [];
  const meetings: StripEvent[] =
    calendarRes.status === "fulfilled"
      ? calendarRes.value.events
          .filter((event) => typeof event.start === "string" && typeof event.end === "string")
          .map((event) => ({ title: event.title, start: event.start, end: event.end, location: event.location ?? null }))
      : [];

  if (weekBoardRes.status === "rejected") console.error("Failed to load weekly board:", weekBoardRes.reason);
  if (waitingRes.status === "rejected") console.error("Failed to load waiting summary:", waitingRes.reason);
  if (needsReviewRes.status === "rejected") console.error("Failed to load needs-review count:", needsReviewRes.reason);
  if (doneRes.status === "rejected") console.error("Failed to load this week's done tasks:", doneRes.reason);
  if (calendarRes.status === "rejected") console.error("Failed to load today's meetings:", calendarRes.reason);

  return (
    <WeekBoard
      weekBoardTasks={weekBoardTasks}
      waitingTasks={waitingTasks}
      doneTasks={doneTasks}
      needsReviewCount={needsReviewCount}
      syncedTaskIds={syncedTaskIds}
      updatedAt={now.toISOString()}
      hasError={hasError}
      mode={mode}
      meetings={meetings}
      meetingsFailed={calendarRes.status === "rejected"}
      chips={chips}
      phoneHint={phoneHint}
    />
  );
}
