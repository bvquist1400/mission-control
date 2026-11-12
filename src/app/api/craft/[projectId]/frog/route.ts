import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft S3 (migration 074): "Ripped back"; see craftWriteRoute in src/lib/craft/http.ts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "frog", (await params).projectId);
}
