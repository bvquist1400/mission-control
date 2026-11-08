import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { withCorsHeaders } from "@/lib/cors";
import { CraftNotFoundError, loadCraftView } from "@/lib/craft/loader";

export async function craftGet(request: NextRequest, projectId?: string) {
  const json = (body: unknown, status: number) => withCorsHeaders(NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  }), request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    if (projectId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return json({ error: "projectId must be a UUID" }, 400);
    }
    return json(await loadCraftView(auth.context.supabase, auth.context.userId, projectId), 200);
  } catch (error) {
    if (error instanceof CraftNotFoundError || isPostgrestNotFound(error as { code: string } | null)) return json({ error: "Craft project not found" }, 404);
    console.error("Error reading craft project:", error);
    return json({ error: "Internal server error" }, 500);
  }
}
