import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft S2 (migration 073): see craftWriteRoute in src/lib/craft/http.ts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "total", (await params).projectId);
}
