import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { handlePaceRouteError, paceJson, paceOptions } from "@/lib/work-sessions/http";
import { getProjectPace } from "@/lib/work-sessions/service";

export function OPTIONS(request: NextRequest) {
  return paceOptions(request);
}

// GET /api/projects/[id]/pace[?today=YYYY-MM-DD] — what the project page's Pace section shows:
// the forecast, the sittings with their task and rows, and the tasks the "Log a sitting" form offers.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const { id } = await params;
    const today = request.nextUrl.searchParams.get("today") ?? undefined;
    const result = await getProjectPace(auth.context.supabase, auth.context.userId, id, { today });
    return paceJson(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handlePaceRouteError(request, error, "Error loading the project pace panel:");
  }
}
