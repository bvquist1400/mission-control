import type { NextRequest } from "next/server";
import { craftSetupRoute } from "@/lib/craft/http";
type Context = { params: Promise<{ projectId: string }> };
/** The preview: what Create would make, with its fingerprint. Writes nothing. */
export async function GET(request: NextRequest, { params }: Context) {
  return craftSetupRoute(request, "preview", (await params).projectId);
}
/** Create: body { fingerprint, craft, names[] }; refused with 409 when anything changed since the preview. */
export async function POST(request: NextRequest, { params }: Context) {
  return craftSetupRoute(request, "create", (await params).projectId);
}
