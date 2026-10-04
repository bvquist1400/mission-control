import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { handlePaceRouteError, paceJson, paceOptions, readPaceJsonBody } from "@/lib/work-sessions/http";
import { deleteWorkSession, updateWorkSession } from "@/lib/work-sessions/service";

export function OPTIONS(request: NextRequest) {
  return paceOptions(request);
}

// PATCH /api/work-sessions/[id] — change a session (item_ids/rows replace its linked rows).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const { id } = await params;
    const result = await updateWorkSession(auth.context.supabase, auth.context.userId, id, await readPaceJsonBody(request));
    return paceJson(request, result);
  } catch (error) {
    return handlePaceRouteError(request, error, "Error updating work session:");
  }
}

// DELETE /api/work-sessions/[id] — delete a session; checklist rows it ticked stay ticked.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    const { id } = await params;
    return paceJson(request, await deleteWorkSession(auth.context.supabase, auth.context.userId, id));
  } catch (error) {
    return handlePaceRouteError(request, error, "Error deleting work session:");
  }
}
