import type { NextRequest } from "next/server";
import { craftWriteRoute } from "@/lib/craft/http";
/** Craft S2: a note on a row or the project (POST { part_id?, row?, text }), or remove one (DELETE { id }). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "note", (await params).projectId);
}
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  return craftWriteRoute(request, "note_delete", (await params).projectId);
}
