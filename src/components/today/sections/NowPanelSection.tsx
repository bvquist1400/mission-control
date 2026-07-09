import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  queryLatestSyncEvent,
  queryTodayCalendar,
  queryTopThreeTasks,
  type LatestSyncSummary,
  type TodayCalendarEvent,
} from "@/lib/today/queries";
import { NowPanel, type NowPanelMeeting } from "@/components/today/sections/NowPanel";
import type { TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

function getEtDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
}

function pickNextMeeting(events: TodayCalendarEvent[], nowMs: number): NowPanelMeeting | null {
  const upcoming = events
    .filter((event) => {
      const endMs = Date.parse(event.end);
      return Number.isFinite(endMs) && endMs > nowMs;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const next = upcoming[0];
  if (!next) {
    return null;
  }
  return { title: next.title, start: next.start, end: next.end, location: next.location };
}

function buildSyncNote(sync: LatestSyncSummary | null, now: Date): string {
  if (!sync) {
    return "Not synced today.";
  }

  const syncedDate = new Date(sync.synced_at);
  if (Number.isNaN(syncedDate.getTime()) || getEtDay(syncedDate) !== getEtDay(now)) {
    return "Not synced today.";
  }

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(syncedDate);

  return `Synced today at ${time} · ${sync.promoted} promoted`;
}

export async function NowPanelSection({ userId }: { userId: string }) {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const nowMs = now.getTime();

  let topTasks: TaskWithImplementation[] = [];
  try {
    topTasks = await queryTopThreeTasks(supabase, userId);
  } catch (error) {
    console.error("Failed to load top tasks:", error);
  }

  let nextMeeting: NowPanelMeeting | null = null;
  try {
    const { events } = await queryTodayCalendar(supabase, userId, TIME_ZONE);
    nextMeeting = pickNextMeeting(events, nowMs);
  } catch (error) {
    console.error("Failed to load next meeting:", error);
  }

  let syncNote = "Not synced today.";
  try {
    const sync = await queryLatestSyncEvent(supabase, userId);
    syncNote = buildSyncNote(sync, now);
  } catch (error) {
    console.error("Failed to load sync summary:", error);
  }

  return <NowPanel topTasks={topTasks} nextMeeting={nextMeeting} syncNote={syncNote} />;
}
