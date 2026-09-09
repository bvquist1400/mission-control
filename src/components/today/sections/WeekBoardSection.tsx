import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  queryLatestSyncEvent,
  queryNeedsReviewCount,
  queryWaitingSummary,
  queryWeeklyBoardTasks,
} from "@/lib/today/queries";
import { WeekBoard } from "@/components/today/sections/WeekBoard";
import type { TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { addDateOnlyDays, getDateStartInTimeZone, getDisplayedWeekRange } from "@/lib/today/week-board";
import type { TaskScope } from "@/lib/personal-exclusion";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

/**
 * End of the current Monday-Sunday week in ET, expressed as a UTC instant.
 */
function getEndOfWeekDate(now: Date): Date {
  const { end } = getDisplayedWeekRange(now, TIME_ZONE);
  return new Date(getDateStartInTimeZone(addDateOnlyDays(end, 1), TIME_ZONE).getTime() - 1);
}

export async function WeekBoardSection({ userId, mode }: { userId: string; mode: TaskScope }) {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const weekEnd = getEndOfWeekDate(now);

  const [weekBoardRes, waitingRes, needsReviewRes, syncRes] = await Promise.allSettled([
    queryWeeklyBoardTasks(supabase, userId, weekEnd, 200, undefined, mode),
    queryWaitingSummary(supabase, userId, 30, mode),
    queryNeedsReviewCount(supabase, userId, mode),
    queryLatestSyncEvent(supabase, userId),
  ]);

  const hasError =
    weekBoardRes.status === "rejected" ||
    waitingRes.status === "rejected" ||
    needsReviewRes.status === "rejected";

  const weekBoardTasks: TaskWithImplementation[] =
    weekBoardRes.status === "fulfilled" ? weekBoardRes.value : [];
  const waitingTasks: TaskWithImplementation[] =
    waitingRes.status === "fulfilled" ? waitingRes.value : [];
  const needsReviewCount = needsReviewRes.status === "fulfilled" ? needsReviewRes.value : 0;
  const syncedTaskIds =
    syncRes.status === "fulfilled" && syncRes.value ? syncRes.value.task_ids : [];

  if (weekBoardRes.status === "rejected") {
    console.error("Failed to load weekly board:", weekBoardRes.reason);
  }
  if (waitingRes.status === "rejected") {
    console.error("Failed to load waiting summary:", waitingRes.reason);
  }
  if (needsReviewRes.status === "rejected") {
    console.error("Failed to load needs-review count:", needsReviewRes.reason);
  }

  return (
    <WeekBoard
      weekBoardTasks={weekBoardTasks}
      waitingTasks={waitingTasks}
      needsReviewCount={needsReviewCount}
      syncedTaskIds={syncedTaskIds}
      updatedAt={now.toISOString()}
      hasError={hasError}
      mode={mode}
    />
  );
}
