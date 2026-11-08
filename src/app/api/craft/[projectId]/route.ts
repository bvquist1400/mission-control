import type { NextRequest } from "next/server";
import { craftGet } from "@/lib/craft/http";
export async function GET(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftGet(request, (await params).projectId);
}
