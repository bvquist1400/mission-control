import { NextRequest, NextResponse } from "next/server";
import { withCorsHeaders } from "@/lib/cors";
import { buildDailyBriefDigest, type DailyBriefMode } from "@/lib/briefing/digest";
import { renderDailyBrief } from "@/lib/briefing/render";
import { normalizeDateOnly } from "@/lib/date-only";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

const VALID_MODES = new Set(["morning", "midday", "eod", "auto"]);

function corsJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

export function OPTIONS(request: NextRequest) {
  return withCorsHeaders(new NextResponse(null, { status: 204 }), request);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") ?? "auto";
    const date = searchParams.get("date");
    const since = searchParams.get("since");

    if (!VALID_MODES.has(mode)) {
      return corsJson(request, { error: "mode must be morning, midday, eod, or auto" }, { status: 400 });
    }

    if (date && !normalizeDateOnly(date)) {
      return corsJson(request, { error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    if (since && Number.isNaN(new Date(since).getTime())) {
      return corsJson(request, { error: "since must be a valid ISO timestamp" }, { status: 400 });
    }

    const digest = await buildDailyBriefDigest({
      supabase: auth.context.supabase,
      userId: auth.context.userId,
      mode: mode as DailyBriefMode,
      date,
      since,
    });

    const payload = await renderDailyBrief(auth.context.supabase, auth.context.userId, digest);
    return corsJson(request, payload);
  } catch (error) {
    console.error("Daily brief render error:", error);
    return corsJson(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
