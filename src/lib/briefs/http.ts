import { NextRequest, NextResponse } from "next/server";
import { withCorsHeaders } from "@/lib/cors";
import { getCanonicalAppUrl } from "@/lib/mcp/config";
import { BriefServiceError } from "@/lib/briefs/service";

export function briefsJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

export function briefsOptions(request: NextRequest): NextResponse {
  return withCorsHeaders(new NextResponse(null, { status: 204 }), request);
}

/** Links in emails and tool results point at the app, not whichever host proxied the call. */
export function briefsAppUrl(request: NextRequest): string {
  return getCanonicalAppUrl(request.nextUrl.origin);
}

export function handleBriefsRouteError(request: NextRequest, error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof BriefServiceError) {
    return briefsJson(
      request,
      { error: error.message, ...(error.details ? { details: error.details } : {}) },
      { status: error.status }
    );
  }

  console.error(fallbackMessage, error);
  return briefsJson(request, { error: "Internal server error" }, { status: 500 });
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BriefServiceError(400, "Body must be valid JSON");
  }
}
