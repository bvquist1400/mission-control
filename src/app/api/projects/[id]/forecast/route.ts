import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { handlePaceRouteError, paceJson, paceOptions } from "@/lib/work-sessions/http";
import { getProjectForecast } from "@/lib/work-sessions/service";

export function OPTIONS(request: NextRequest) {
  return paceOptions(request);
}

// GET /api/projects/[id]/forecast[?today=YYYY-MM-DD] — the pace forecast (computed, never stored).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const { id } = await params;
    const today = request.nextUrl.searchParams.get("today") ?? undefined;
    const result = await getProjectForecast(auth.context.supabase, auth.context.userId, id, { today });
    return paceJson(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handlePaceRouteError(request, error, "Error computing project forecast:");
  }
}
