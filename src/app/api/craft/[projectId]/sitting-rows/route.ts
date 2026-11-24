import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft estimates E3 (migration 076, one transaction): add rows to a sitting already logged; see writeSittingRows in src/lib/craft/write-service.ts. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "sitting_rows", (await params).projectId);
}
