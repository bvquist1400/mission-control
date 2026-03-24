import { NextRequest, NextResponse } from "next/server";
import { normalizeDateOnly } from "@/lib/date-only";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { workMonthlyReviewRead } from "@/lib/work-intelligence/monthly-review";

// GET /api/briefing/monthly-review - Structured month-to-date review from stored weekly/project snapshots
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

    const result = await workMonthlyReviewRead({
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
    console.error("Error generating monthly review:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
