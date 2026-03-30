import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import {
  performArtifactRouteAction,
  type IntelligenceArtifactRouteAction,
} from "../transition";

interface StatusActionBody {
  action?: string;
}

function toStatus(action: string) {
  switch (action) {
    case "accept":
      return "accept" as const;
    case "dismiss":
      return "dismiss" as const;
    case "apply":
      return "apply" as const;
    default:
      return null;
  }
}

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
    const body = (await request.json().catch(() => ({}))) as StatusActionBody;
    const action = typeof body.action === "string" ? toStatus(body.action) : null;

    if (!action) {
      return NextResponse.json({ error: "action must be one of: accept, dismiss, apply" }, { status: 400 });
    }

    const updated = await performArtifactRouteAction(
      supabase,
      userId,
      id,
      action as IntelligenceArtifactRouteAction
    );

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update intelligence artifact";
    const status = message === "Intelligence artifact not found"
      ? 404
      : message.startsWith("Invalid intelligence artifact status transition")
        ? 409
        : 500;

    if (status === 500) {
      console.error("Error updating intelligence artifact status:", error);
    }

    return NextResponse.json({ error: message }, { status });
  }
}
