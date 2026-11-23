import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { withCorsHeaders } from "@/lib/cors";
import { getCraftPace } from "@/lib/craft/pace-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Craft estimates (E2): every craft project's estimate in rows, or one with `?project_id=`. Read-only. */
export async function GET(request: NextRequest) {
  const json = (body: unknown, status: number) => withCorsHeaders(NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }), request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const params = request.nextUrl.searchParams;
    const unknown = [...params.keys()].filter((key) => key !== "project_id");
    if (unknown.length > 0 || params.getAll("project_id").length > 1) return json({ error: "Only one project_id may be given" }, 400);
    const projectId = params.get("project_id");
    if (projectId !== null && !UUID.test(projectId)) return json({ error: "project_id must be a UUID" }, 400);
    return json(await getCraftPace(auth.context.supabase, auth.context.userId, projectId ? projectId.toLowerCase() : null), 200);
  } catch (error) {
    console.error("Error reading craft pace:", error);
    return json({ error: "Internal server error" }, 500);
  }
}
