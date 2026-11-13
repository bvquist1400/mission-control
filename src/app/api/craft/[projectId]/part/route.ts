import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft S3 FR3 (migration 074): Work on this part, { part_id, expected_part_id } → craft_pick_part. See craftWriteRoute in src/lib/craft/http.ts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "part", (await params).projectId);
}
