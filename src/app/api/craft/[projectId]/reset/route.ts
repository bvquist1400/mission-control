import type { NextRequest } from "next/server";
import { craftSetupRoute } from "@/lib/craft/http";
type Context = { params: Promise<{ projectId: string }> };
/** Craft S4 (migration 075): what "Reset craft screen" would make and what carries over, with its fingerprint. Writes nothing. */
export async function GET(request: NextRequest, { params }: Context) {
  return craftSetupRoute(request, "reset_preview", (await params).projectId);
}
/** Reset: body { fingerprint, names[] }; one transaction; refused with 409 when anything changed since the preview. */
export async function POST(request: NextRequest, { params }: Context) {
  return craftSetupRoute(request, "reset", (await params).projectId);
}
