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

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

function getEtDateOnly(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
}

/** Offset (timezone - UTC) in ms at the given instant, for TIME_ZONE. */
function getTimeZoneOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour === "24" ? "0" : map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - date.getTime();
}

/**
 * End of the current work week — Saturday 23:59:59.999 in ET, expressed as a
 * UTC instant. Matches the boundary the legacy client sent to
 * `/api/tasks?view=weekly_board`.
 */
function getEndOfWeekDate(now: Date): Date {
  const todayEt = getEtDateOnly(now); // YYYY-MM-DD
  const [year, month, day] = todayEt.split("-").map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  const saturday = new Date(Date.UTC(year, month - 1, day + (6 - dow)));
  const naiveEndUtc = Date.UTC(
    saturday.getUTCFullYear(),
    saturday.getUTCMonth(),
    saturday.getUTCDate(),
    23,
    59,
    59,
    999
  );
  const offset = getTimeZoneOffsetMs(new Date(naiveEndUtc));
  return new Date(naiveEndUtc - offset);
}

export async function WeekBoardSection({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const weekEnd = getEndOfWeekDate(now);

  const [weekBoardRes, waitingRes, needsReviewRes, syncRes] = await Promise.allSettled([
    queryWeeklyBoardTasks(supabase, userId, weekEnd, 200),
    queryWaitingSummary(supabase, userId, 30),
    queryNeedsReviewCount(supabase, userId),
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
    />
  );
}
