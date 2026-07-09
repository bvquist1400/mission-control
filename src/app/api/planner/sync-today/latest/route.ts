import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { queryLatestSyncEvent } from "@/lib/today/queries";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const sync = await queryLatestSyncEvent(supabase, userId);
    return NextResponse.json({ sync });
  } catch (error) {
    console.error("Error fetching latest today sync event:", error);
    return NextResponse.json({ error: "Failed to fetch sync metadata" }, { status: 500 });
  }
}
