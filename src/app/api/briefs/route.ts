import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { briefsAppUrl, briefsJson, briefsOptions, handleBriefsRouteError, readJsonBody } from "@/lib/briefs/http";
import { normalizeDateOnly } from "@/lib/date-only";
import { getLatestBrief, saveBrief } from "@/lib/briefs/service";
import { BRIEF_EDITIONS } from "@/lib/briefs/types";
import { parseSaveBriefInput } from "@/lib/briefs/validate";

export function OPTIONS(request: NextRequest) {
  return briefsOptions(request);
}

// GET /api/briefs?latest=<edition>[&before=YYYY-MM-DD] — the latest brief of an
// edition dated today or earlier (ET), as the same view GET /api/briefs/:code returns.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const params = request.nextUrl.searchParams;
    const edition = params.get("latest")?.trim().toLowerCase() ?? "";
    if (!(BRIEF_EDITIONS as readonly string[]).includes(edition)) {
      return briefsJson(request, { error: `latest must be one of ${BRIEF_EDITIONS.join(", ")}` }, { status: 400 });
    }
    const rawBefore = params.get("before");
    const before = rawBefore ? normalizeDateOnly(rawBefore) : null;
    if (rawBefore && !before) {
      return briefsJson(request, { error: "before must be YYYY-MM-DD" }, { status: 400 });
    }

    const view = await getLatestBrief(auth.context.supabase, auth.context.userId, edition, {
      appUrl: briefsAppUrl(request),
      ...(before ? { before } : {}),
    });
    return briefsJson(request, view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error loading the latest brief:");
  }
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
