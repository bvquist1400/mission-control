import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { handlePaceRouteError, paceJson, paceOptions, readPaceJsonBody } from "@/lib/work-sessions/http";
import { listWorkSessions, logWorkSession } from "@/lib/work-sessions/service";

export function OPTIONS(request: NextRequest) {
  return paceOptions(request);
}

// GET /api/work-sessions?project_id=|task_id=[&since=YYYY-MM-DD] — sessions, newest first, with linked item ids.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const params = request.nextUrl.searchParams;
    const sessions = await listWorkSessions(auth.context.supabase, auth.context.userId, {
      project_id: params.get("project_id"),
      task_id: params.get("task_id"),
      since: params.get("since"),
    });
    return paceJson(request, { sessions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handlePaceRouteError(request, error, "Error listing work sessions:");
  }
}

// POST /api/work-sessions — log one sitting (task_id or project_id; minutes and/or start+end; item_ids and/or rows).
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const result = await logWorkSession(auth.context.supabase, auth.context.userId, await readPaceJsonBody(request));
    return paceJson(request, result, { status: 201 });
  } catch (error) {
    return handlePaceRouteError(request, error, "Error logging work session:");
  }
}
