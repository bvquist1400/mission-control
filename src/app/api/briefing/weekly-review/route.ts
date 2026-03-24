import { NextRequest, NextResponse } from "next/server";
import { normalizeDateOnly } from "@/lib/date-only";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { workWeeklyReviewRead } from "@/lib/work-intelligence/weekly-review";

// GET /api/briefing/weekly-review - Structured weekly review snapshot
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { searchParams } = new URL(request.url);
    const requestedDate = searchParams.get("date");
    const shouldPersist = searchParams.get("persist") === "true";

    if (requestedDate && !normalizeDateOnly(requestedDate)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const result = await workWeeklyReviewRead({
      supabase: auth.context.supabase,
      userId: auth.context.userId,
      date: requestedDate,
      persist: shouldPersist,
    });

    return NextResponse.json({
      ...result.routePayload,
      review: result.review,
      snapshot_persisted: result.snapshotPersisted,
      review_snapshot_id: result.reviewSnapshotId,
    });
  } catch (error) {
    console.error("Error generating weekly review:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
