import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { withCorsHeaders } from "@/lib/cors";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

interface SyncTodayBody {
  task_ids?: unknown;
}

interface SyncTodayRpcRow {
  promoted: number | null;
  demoted: number | null;
  skipped_pinned: number | null;
  sync_at: string | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function corsJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

function getDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return new Date().toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function parseTaskIds(value: unknown): { taskIds: string[] | null; error: string | null } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      taskIds: null,
      error: "task_ids is required and must be a non-empty array",
    };
  }

  if (value.length > 20) {
    return {
      taskIds: null,
      error: "task_ids cannot exceed 20 items",
    };
  }

  const uniqueTaskIds: string[] = [];
  const seen = new Set<string>();

  for (const id of value) {
    if (typeof id !== "string" || !UUID_REGEX.test(id)) {
      return {
        taskIds: null,
        error: "task_ids must contain valid UUID strings",
      };
    }

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    uniqueTaskIds.push(id);
  }

  return { taskIds: uniqueTaskIds, error: null };
}

export async function OPTIONS(request: NextRequest) {
  return withCorsHeaders(new NextResponse(null, { status: 204 }), request);
}

export async function POST(request: NextRequest) {
  const providedApiKey = request.headers.get("x-mission-control-key");
  const validApiKey = process.env.MISSION_CONTROL_API_KEY;
  const apiUserId = process.env.MISSION_CONTROL_USER_ID;

  if (!providedApiKey || !validApiKey || providedApiKey !== validApiKey) {
    return corsJson(request, { error: "Unauthorized" }, { status: 401 });
  }

  if (!apiUserId) {
    return corsJson(
      request,
      { error: "Sync failed", detail: "MISSION_CONTROL_USER_ID is not configured" },
      { status: 500 }
    );
  }

  let body: SyncTodayBody = {};
  try {
    body = (await request.json()) as SyncTodayBody;
  } catch {
    body = {};
  }

  const { taskIds, error: taskIdError } = parseTaskIds(body.task_ids);
  if (taskIdError) {
    return corsJson(request, { error: taskIdError }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const todayEt = getDateInTimeZone(DEFAULT_WORKDAY_CONFIG.timezone);

    const { data, error } = await supabase.rpc("sync_today_tasks", {
      p_user_id: apiUserId,
      p_task_ids: taskIds,
      p_today: todayEt,
    });

    if (error) {
      throw error;
    }

    const row = (Array.isArray(data) ? data[0] : null) as SyncTodayRpcRow | null;

    return corsJson(request, {
      promoted: Number(row?.promoted ?? 0),
      demoted: Number(row?.demoted ?? 0),
      skipped_pinned: Number(row?.skipped_pinned ?? 0),
      sync_at: row?.sync_at ?? new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error syncing today tasks:", error);
    return corsJson(
      request,
      {
        error: "Sync failed",
        detail: error instanceof Error ? error.message : "Unknown sync error",
      },
      { status: 500 }
    );
  }
}
