import { NextRequest, NextResponse } from "next/server";
import { withCorsHeaders } from "@/lib/cors";
import { WorkSessionServiceError } from "@/lib/work-sessions/service";

export function paceJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

export function paceOptions(request: NextRequest): NextResponse {
  return withCorsHeaders(new NextResponse(null, { status: 204 }), request);
}

export function handlePaceRouteError(request: NextRequest, error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof WorkSessionServiceError) {
    return paceJson(
      request,
      { error: error.message, ...(error.details ? { details: error.details } : {}) },
      { status: error.status }
    );
  }
  // Database CHECK / trigger rejections are the caller's input, not a server fault.
  const code = (error as { code?: string } | null)?.code;
  if (code === "23503" || code === "23514" || code === "22P02") {
    return paceJson(request, { error: (error as { message?: string }).message ?? "Invalid input" }, { status: 400 });
  }
  if (code === "23505") {
    return paceJson(request, { error: "Already exists (duplicate source_ref?)" }, { status: 409 });
  }
  console.error(fallbackMessage, error);
  return paceJson(request, { error: "Internal server error" }, { status: 500 });
}

export async function readPaceJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new WorkSessionServiceError(400, "Body must be valid JSON");
  }
}
