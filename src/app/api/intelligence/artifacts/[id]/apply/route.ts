import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import { performArtifactRouteAction } from "../transition";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const updated = await performArtifactRouteAction(supabase, userId, id, "apply");
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply intelligence artifact";
    const status = message === "Intelligence artifact not found"
      ? 404
      : message.startsWith("Invalid intelligence artifact status transition")
        ? 409
        : 500;

    if (status === 500) {
      console.error("Error applying intelligence artifact:", error);
    }

    return NextResponse.json({ error: message }, { status });
  }
}
