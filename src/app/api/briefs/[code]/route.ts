import { NextRequest } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { briefsAppUrl, briefsJson, briefsOptions, handleBriefsRouteError, readJsonBody } from "@/lib/briefs/http";
import { actOnBriefItems, getBrief } from "@/lib/briefs/service";
import { parseBriefActions } from "@/lib/briefs/validate";

type RouteContext = { params: Promise<{ code: string }> };

export function OPTIONS(request: NextRequest) {
  return briefsOptions(request);
}

// GET /api/briefs/:code — the stored brief with item states
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const { code } = await params;
    const view = await getBrief(auth.context.supabase, auth.context.userId, code, { appUrl: briefsAppUrl(request) });
    return briefsJson(request, view);
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error loading brief:");
  }
}

// PATCH /api/briefs/:code — { actions: [{ n, action, reason?, note?, choice? }] }
// The page buttons and the act_on_brief_items MCP tool both land here.
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as Response;

    const body = await readJsonBody(request);
    const allowedFields = ["actions"];
    const unknownFields =
      body && typeof body === "object" ? Object.keys(body).filter((key) => !allowedFields.includes(key)) : [];
    if (unknownFields.length) {
      return briefsJson(request, { error: `Unknown field(s): ${unknownFields.join(", ")}` }, { status: 400 });
    }

    const parsed = parseBriefActions((body as { actions?: unknown } | null)?.actions);
    if (!parsed.ok) {
      return briefsJson(request, { error: "Invalid actions", details: parsed.errors }, { status: 400 });
    }

    const { code } = await params;
    const result = await actOnBriefItems(auth.context.supabase, auth.context.userId, code, parsed.value);
    // 409: an item changed under this call (nothing was applied to it); 207: some other entry failed.
    const conflict = result.results.some((entry) => entry.conflict);
    const failed = result.results.some((entry) => !entry.ok);
    return briefsJson(request, result, { status: conflict ? 409 : failed ? 207 : 200 });
  } catch (error) {
    return handleBriefsRouteError(request, error, "Error acting on brief items:");
  }
}
