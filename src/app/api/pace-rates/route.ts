import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { handlePaceRouteError, paceJson, paceOptions } from "@/lib/work-sessions/http";
import { getPaceRates } from "@/lib/work-sessions/service";

export function OPTIONS(request: NextRequest) {
  return paceOptions(request);
}

// GET /api/pace-rates?unit_label=stitches[&work_type=sc] — measured speeds across projects with that unit.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const params = request.nextUrl.searchParams;
    const result = await getPaceRates(auth.context.supabase, auth.context.userId, {
      unit_label: params.get("unit_label"),
      work_type: params.get("work_type"),
    });
    return paceJson(request, result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handlePaceRouteError(request, error, "Error reading pace rates:");
  }
}
