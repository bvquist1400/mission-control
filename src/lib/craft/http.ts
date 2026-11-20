import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { withCorsHeaders } from "@/lib/cors";
import { CraftNotFoundError, loadCraftView } from "@/lib/craft/loader";
import { CraftSetupRefusal, createCraftSetup, loadCraftResetPreview, loadCraftSetupPreview, removeCraftProject, resetCraftProject } from "@/lib/craft/setup-service";
import { CraftWriteError, deleteNote, writeCheck, writeFrog, writeNote, writePart, writeRows, writeSitting, writeTimer, writeTotal } from "@/lib/craft/write-service";

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

type SetupAction = "preview" | "create" | "remove" | "reset_preview" | "reset";
const NOT_FOUND = { preview: "Project not found", create: "Project not found", remove: "Craft project not found", reset_preview: "Project not found", reset: "Project not found" } as const;

/** GET /api/craft/setup/[id] (preview), POST same (Create), DELETE /api/craft/[id] (Remove), GET/POST /api/craft/[id]/reset (S4 Reset). */
export async function craftSetupRoute(request: NextRequest, action: SetupAction, projectId: string) {
  const json = jsonFor(request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    if (!UUID.test(projectId)) return json({ error: "projectId must be a UUID" }, 400);
    const { supabase, userId } = auth.context;
    if (action === "preview") return json(await loadCraftSetupPreview(supabase, userId, projectId), 200);
    if (action === "remove") return json(await removeCraftProject(supabase, userId, projectId), 200);
    if (action === "reset_preview") return json(await loadCraftResetPreview(supabase, userId, projectId), 200);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    if (action === "reset") return json(await resetCraftProject(supabase, userId, projectId, body), 200);
    return json(await createCraftSetup(supabase, userId, projectId, body), 201);
  } catch (error) {
    if (error instanceof CraftSetupRefusal) return json({ error: error.message, reason: error.reason, ...(error.stops ? { stops: error.stops } : {}) }, error.status);
    if (isPostgrestNotFound(error as { code: string } | null)) return json({ error: NOT_FOUND[action] }, 404);
    console.error(`Error in craft setup (${action}):`, error);
    return json({ error: "Internal server error" }, 500);
  }
}

export type CraftWriteKind = "row" | "timer" | "sittings" | "total" | "note" | "note_delete" | "frog" | "check" | "part";
const WRITERS = { row: writeRows, timer: writeTimer, sittings: writeSitting, total: writeTotal, note: writeNote, note_delete: deleteNote, frog: writeFrog, check: writeCheck, part: writePart } as const;

/**
 * S2 writes: POST /api/craft/[id]/row | timer | sittings | total | notes, DELETE /api/craft/[id]/notes; S3: POST /api/craft/[id]/frog; S3 FR3:
 * POST /api/craft/[id]/check (tick checks) and /part (Work on this part). Same auth path as
 * every craft route (the FamCal and Actions keys are refused before any read), user filters inside, PGRST116 → 404 only.
 */
export async function craftWriteRoute(request: NextRequest, kind: CraftWriteKind, projectId: string) {
  const json = jsonFor(request);
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;
    if (!UUID.test(projectId)) return json({ error: "projectId must be a UUID" }, 400);
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const { supabase, userId } = auth.context;
    const reply = await WRITERS[kind](supabase, userId, projectId.toLowerCase(), body);
    const created = ((kind === "sittings" || kind === "frog") && !(reply as { duplicate?: boolean }).duplicate) || kind === "note";
    return json(reply, created ? 201 : 200);
  } catch (error) {
    if (error instanceof CraftWriteError) return json({ error: error.message, reason: error.reason, ...error.extra }, error.status);
    if (isPostgrestNotFound(error as { code: string } | null)) return json({ error: "Craft project or part not found" }, 404);
    console.error(`Error in craft write (${kind}):`, error);
    return json({ error: "Internal server error" }, 500);
  }
}
