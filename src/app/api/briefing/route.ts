import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDayWindows,
  calculateBusyStats,
  mergeBusyBlocks,
  normalizeRequestedRange,
  parseEventPeople,
  type ApiCalendarEvent,
  type BusyBlock,
  type BusyStats,
} from "@/lib/calendar";
import {
  BriefingMode,
  detectBriefingMode,
  formatETTime,
  getTodayET,
  getTomorrowET,
  calculateFocusBlocks,
  identifyPrepTasks,
  findRolledOverTasks,
  type TaskInput,
  type TaskSummary,
  type BriefingResponse,
  type TodayBriefingData,
} from "@/lib/briefing";
import { calculateCapacity } from "@/lib/capacity";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import type { Task, TaskWithImplementation } from "@/types/database";

function taskToSummary(task: TaskWithImplementation): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    task_type: task.task_type,
    estimated_minutes: task.estimated_minutes,
    priority_score: task.priority_score,
    due_at: task.due_at,
    status: task.status,
    blocker: task.blocker,
    waiting_on: task.waiting_on,
    implementation_name: task.implementation?.name ?? null,
  };
}

interface CalendarEventRow {
  source: CalendarEventSource;
  external_event_id: string;
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[] | null;
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
  content_hash: string;
}

type CalendarEventSource = "local" | "ical" | "graph";

interface CalendarEventContextRow {
  source: CalendarEventSource;
  external_event_id: string;
  meeting_context: string;
}

function buildContextKey(source: CalendarEventSource, externalEventId: string): string {
  return `${source}::${externalEventId}`;
}

function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === "42P01" || candidate.code === "PGRST205") {
    return true;
  }

  const message = `${candidate.message ?? ""} ${candidate.details ?? ""} ${candidate.hint ?? ""}`.toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

async function fetchCalendarData(
  supabase: SupabaseClient,
  userId: string,
  rangeStart: string,
  rangeEnd: string
): Promise<{ events: ApiCalendarEvent[]; busyBlocks: BusyBlock[]; stats: BusyStats }> {
  const range = normalizeRequestedRange(rangeStart, rangeEnd);
  const rangeContext = buildDayWindows(range, DEFAULT_WORKDAY_CONFIG);

  const { data: rows, error } = await supabase
    .from("calendar_events")
    .select(
      "source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day, content_hash"
    )
    .eq("user_id", userId)
    .gte("end_at", rangeContext.utcRangeStart)
    .lt("start_at", rangeContext.utcRangeEndExclusive)
    .order("start_at", { ascending: true });

  if (error) {
    console.error("Calendar fetch error:", error);
    return { events: [], busyBlocks: [], stats: { busyMinutes: 0, blocks: 0, largestFocusBlockMinutes: 0 } };
  }

  const calendarRows = (rows || []) as CalendarEventRow[];
  const contextByEvent = new Map<string, string>();
  const externalEventIds = [...new Set(calendarRows.map((row) => row.external_event_id).filter(Boolean))];

  if (externalEventIds.length > 0) {
    const { data: contextRows, error: contextError } = await supabase
      .from("calendar_event_context")
      .select("source, external_event_id, meeting_context")
      .eq("user_id", userId)
      .in("external_event_id", externalEventIds);

    if (contextError) {
      if (!isMissingRelationError(contextError)) {
        console.error("Calendar context fetch error:", contextError);
      }
    } else {
      for (const row of (contextRows || []) as CalendarEventContextRow[]) {
        const trimmed = row.meeting_context?.trim();
        if (!trimmed) {
          continue;
        }
        contextByEvent.set(buildContextKey(row.source, row.external_event_id), trimmed);
      }
    }
  }

  const events: ApiCalendarEvent[] = calendarRows.map((row) => ({
    start_at: row.start_at,
    end_at: row.end_at,
    title: row.title,
    with_display: parseEventPeople(row.with_display),
    body_scrubbed_preview: row.body_scrubbed_preview,
    is_all_day: row.is_all_day,
    external_event_id: row.external_event_id,
    meeting_context: contextByEvent.get(buildContextKey(row.source, row.external_event_id)) ?? null,
  }));

  const busyBlocks = mergeBusyBlocks(events, rangeContext.windows);
  const stats = calculateBusyStats(events, rangeContext.windows);

  return { events, busyBlocks, stats };
}

async function fetchTasks(supabase: SupabaseClient, userId: string): Promise<TaskWithImplementation[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*, implementation:implementations(id, name)")
    .eq("user_id", userId)
    .order("priority_score", { ascending: false });

  if (error) {
    console.error("Tasks fetch error:", error);
    return [];
  }

  return (data || []) as TaskWithImplementation[];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const modeParam = searchParams.get("mode") || "auto";
    const dateParam = searchParams.get("date");

    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }
    const { supabase, userId } = auth.context;

    const now = new Date();
    const todayET = dateParam || getTodayET(now);
    const tomorrowET = getTomorrowET(now);
    const currentTimeET = formatETTime(now);
    const autoDetectedMode = detectBriefingMode(now);
    const mode: BriefingMode = modeParam === "auto" ? autoDetectedMode : (modeParam as BriefingMode);

    // Fetch calendar data for today
    const todayCalendar = await fetchCalendarData(supabase, userId, todayET, todayET);

    // Calculate focus blocks for today
    const todayRange = normalizeRequestedRange(todayET, todayET);
    const todayWindows = buildDayWindows(todayRange, DEFAULT_WORKDAY_CONFIG);
    const nowMs = mode === "morning" ? undefined : now.getTime();
    const focusBlocks = calculateFocusBlocks(todayCalendar.busyBlocks, todayWindows.windows, nowMs);

    // Fetch all tasks
    const allTasks = await fetchTasks(supabase, userId);

    // Calculate today's task breakdown
    const todayStart = `${todayET}T00:00:00`;
    const todayEnd = `${todayET}T23:59:59`;

    const todaysTasks = allTasks.filter((task) => {
      if (task.status === "Done") {
        // Completed today
        return task.updated_at >= todayStart && task.updated_at <= todayEnd;
      }
      // Due today or high priority
      if (task.due_at && task.due_at <= todayEnd) return true;
      if (task.priority_score >= 70 && (task.status === "Planned" || task.status === "In Progress")) return true;
      return false;
    });

    const completedTasks = todaysTasks.filter((t) => t.status === "Done").map(taskToSummary);
    const remainingTasks = todaysTasks.filter((t) => t.status !== "Done").map(taskToSummary);
    const plannedTasks = [...completedTasks, ...remainingTasks];

    // Calculate progress
    const completedMinutes = completedTasks.reduce((sum, t) => sum + t.estimated_minutes, 0);
    const remainingMinutes = remainingTasks.reduce((sum, t) => sum + t.estimated_minutes, 0);
    const totalMinutes = completedMinutes + remainingMinutes;
    const percentComplete = totalMinutes > 0 ? Math.round((completedMinutes / totalMinutes) * 100) : 0;

    // Calculate capacity
    const topTaskIds = new Set(
      allTasks
        .filter((t) => t.status === "Planned" || t.status === "In Progress")
        .slice(0, 3)
        .map((t) => t.id)
    );
    const capacity = calculateCapacity(
      allTasks as Task[],
      topTaskIds,
      todayCalendar.stats.busyMinutes
    );

    const todayData: TodayBriefingData = {
      calendar: {
        events: todayCalendar.events,
        busyBlocks: todayCalendar.busyBlocks,
        stats: todayCalendar.stats,
        focusBlocks,
      },
      tasks: {
        planned: plannedTasks,
        completed: completedTasks,
        remaining: remainingTasks,
      },
      capacity,
      progress: {
        completedCount: completedTasks.length,
        totalCount: plannedTasks.length,
        completedMinutes,
        remainingMinutes,
        percentComplete,
      },
    };

    // Build response
    const response: BriefingResponse = {
      requestedDate: todayET,
      mode,
      autoDetectedMode,
      currentTimeET,
      today: todayData,
    };

    // Add tomorrow data for EOD mode
    if (mode === "eod") {
      const tomorrowCalendar = await fetchCalendarData(supabase, userId, tomorrowET, tomorrowET);

      // Convert tasks to TaskInput format for prep task functions
      const tasksForPrepAnalysis: TaskInput[] = allTasks.map((t) => ({
        ...t,
        implementation: t.implementation ? { name: t.implementation.name } : null,
      }));

      const prepTasks = identifyPrepTasks(
        tasksForPrepAnalysis,
        tomorrowCalendar.events,
        tomorrowET
      );

      const rolledOver = findRolledOverTasks(
        tasksForPrepAnalysis,
        todayET
      );

      // Estimate tomorrow's capacity (no meetings known yet may be incomplete)
      const tomorrowCapacity = calculateCapacity(
        allTasks.filter((t) => t.status !== "Done") as Task[],
        new Set(),
        tomorrowCalendar.stats.busyMinutes
      );

      response.tomorrow = {
        date: tomorrowET,
        calendar: {
          events: tomorrowCalendar.events,
          busyBlocks: tomorrowCalendar.busyBlocks,
          stats: tomorrowCalendar.stats,
        },
        prepTasks,
        rolledOver,
        estimatedCapacity: tomorrowCapacity,
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("Briefing API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
