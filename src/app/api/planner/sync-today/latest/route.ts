import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

interface SyncTodayEventRow {
  task_ids: string[] | null;
  promoted: number | null;
  demoted: number | null;
  skipped_pinned: number | null;
  synced_at: string | null;
}

function isMissingSyncEventTable(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = "code" in error ? String(error.code || "") : "";
  const maybeMessage = "message" in error ? String(error.message || "") : "";

  return maybeCode === "42P01" || (maybeMessage.includes("today_sync_events") && maybeMessage.includes("not exist"));
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    const { data, error } = await supabase
      .from("today_sync_events")
      .select("task_ids, promoted, demoted, skipped_pinned, synced_at")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false })
      .limit(1);

    if (error) {
      if (isMissingSyncEventTable(error)) {
        return NextResponse.json({ sync: null });
      }
      throw error;
    }

    const row = (data?.[0] || null) as SyncTodayEventRow | null;
    if (!row) {
      return NextResponse.json({ sync: null });
    }

    return NextResponse.json({
      sync: {
        task_ids: Array.isArray(row.task_ids) ? row.task_ids : [],
        promoted: Number(row.promoted ?? 0),
        demoted: Number(row.demoted ?? 0),
        skipped_pinned: Number(row.skipped_pinned ?? 0),
        synced_at: row.synced_at ?? new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error fetching latest today sync event:", error);
    return NextResponse.json({ error: "Failed to fetch sync metadata" }, { status: 500 });
  }
}
