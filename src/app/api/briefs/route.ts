import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { briefsAppUrl, briefsJson, briefsOptions, handleBriefsRouteError, readJsonBody } from "@/lib/briefs/http";
import { saveBrief } from "@/lib/briefs/service";
import { parseSaveBriefInput } from "@/lib/briefs/validate";

export function OPTIONS(request: NextRequest) {
  return briefsOptions(request);
}

// POST /api/briefs — save a brief (first run creates it; a same-day rerun only appends)
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const parsed = parseSaveBriefInput(await readJsonBody(request));
    if (!parsed.ok) {
      return briefsJson(request, { error: "Invalid brief", details: parsed.errors }, { status: 400 });
    }

    const result = await saveBrief(auth.context.supabase, auth.context.userId, parsed.value, {
      appUrl: briefsAppUrl(request),
    });
    return briefsJson(request, result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error saving brief:");
  }
}
