import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { briefsJson, briefsOptions, handleBriefsRouteError } from "@/lib/briefs/http";
import { getTodayBriefStatus } from "@/lib/briefs/service";

export function OPTIONS(request: NextRequest) {
  return briefsOptions(request);
}

// GET /api/briefs/today — today's (ET) brief code and open count, or null. Feeds the app-shell button.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const status = await getTodayBriefStatus(auth.context.supabase, auth.context.userId);
    return briefsJson(request, { status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error loading today's brief:");
  }
}
