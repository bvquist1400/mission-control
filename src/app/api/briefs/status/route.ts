import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { briefsJson, briefsOptions, handleBriefsRouteError } from "@/lib/briefs/http";
import { normalizeDateOnly } from "@/lib/date-only";
import { todayInBriefTimeZone } from "@/lib/briefs/keys";
import { getBriefStatus } from "@/lib/briefs/service";
import { BRIEF_EDITIONS, type BriefEdition } from "@/lib/briefs/types";

export function OPTIONS(request: NextRequest) {
  return briefsOptions(request);
}

// GET /api/briefs/status?edition=am|eod[&date=YYYY-MM-DD] — read-only: whether that
// day's brief exists, when it was built and last refreshed, and whether a work digest
// note it should cover isn't in it yet (MCP brief_status). Date defaults to today (ET).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const params = request.nextUrl.searchParams;
    const edition = params.get("edition")?.trim().toLowerCase() ?? "";
    if (!(BRIEF_EDITIONS as readonly string[]).includes(edition)) {
      return briefsJson(request, { error: `edition must be one of ${BRIEF_EDITIONS.join(", ")}` }, { status: 400 });
    }
    const rawDate = params.get("date");
    const date = rawDate ? normalizeDateOnly(rawDate) : todayInBriefTimeZone(new Date());
    if (!date) {
      return briefsJson(request, { error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const status = await getBriefStatus(auth.context.supabase, auth.context.userId, edition as BriefEdition, date);
    return briefsJson(request, status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error reading the brief status:");
  }
}
