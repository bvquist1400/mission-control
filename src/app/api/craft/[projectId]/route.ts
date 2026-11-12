import type { NextRequest } from "next/server";
import { craftGet, craftSetupRoute } from "@/lib/craft/http";
export async function GET(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftGet(request, (await params).projectId);
}
/** Remove from craft screen: unlinks the rows and removes the craft rows; ticks, units and sittings stay. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftSetupRoute(request, "remove", (await params).projectId);
}
