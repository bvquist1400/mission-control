import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft S3 FR3 (migration 074): Done on a check card, { item_ids } → craft_check. See craftWriteRoute in src/lib/craft/http.ts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "check", (await params).projectId);
}
