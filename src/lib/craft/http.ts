import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { withCorsHeaders } from "@/lib/cors";
import { CraftNotFoundError, loadCraftView } from "@/lib/craft/loader";
import { CraftSetupRefusal, createCraftSetup, loadCraftSetupPreview, removeCraftProject } from "@/lib/craft/setup-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jsonFor = (request: NextRequest) => (body: unknown, status: number) => withCorsHeaders(NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
}), request);

export async function craftGet(request: NextRequest, projectId?: string) {
  const json = jsonFor(request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    if (projectId !== undefined && !UUID.test(projectId)) {
      return json({ error: "projectId must be a UUID" }, 400);
    }
    return json(await loadCraftView(auth.context.supabase, auth.context.userId, projectId), 200);
  } catch (error) {
    if (error instanceof CraftNotFoundError || isPostgrestNotFound(error as { code: string } | null)) return json({ error: "Craft project not found" }, 404);
    console.error("Error reading craft project:", error);
    return json({ error: "Internal server error" }, 500);
  }
}

type SetupAction = "preview" | "create" | "remove";
const NOT_FOUND = { preview: "Project not found", create: "Project not found", remove: "Craft project not found" } as const;

/** GET /api/craft/setup/[id] (preview), POST same (Create), DELETE /api/craft/[id] (Remove). */
export async function craftSetupRoute(request: NextRequest, action: SetupAction, projectId: string) {
  const json = jsonFor(request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    if (!UUID.test(projectId)) return json({ error: "projectId must be a UUID" }, 400);
    const { supabase, userId } = auth.context;
    if (action === "preview") return json(await loadCraftSetupPreview(supabase, userId, projectId), 200);
    if (action === "remove") return json(await removeCraftProject(supabase, userId, projectId), 200);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    return json(await createCraftSetup(supabase, userId, projectId, body), 201);
  } catch (error) {
    if (error instanceof CraftSetupRefusal) return json({ error: error.message, reason: error.reason, ...(error.stops ? { stops: error.stops } : {}) }, error.status);
    if (isPostgrestNotFound(error as { code: string } | null)) return json({ error: NOT_FOUND[action] }, 404);
    console.error(`Error in craft setup (${action}):`, error);
    return json({ error: "Internal server error" }, 500);
  }
}
