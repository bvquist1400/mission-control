import { NextRequest, NextResponse } from "next/server";
import { SupabaseIntelligencePromotionStore } from "@/lib/intelligence-layer/promotion-store";
import { transitionIntelligenceArtifactStatus } from "@/lib/intelligence-layer/promotion";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

interface StatusActionBody {
  action?: string;
}

function toStatus(action: string) {
  switch (action) {
    case "accept":
      return "accepted" as const;
    case "dismiss":
      return "dismissed" as const;
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
    const nextStatus = typeof body.action === "string" ? toStatus(body.action) : null;

    if (!nextStatus) {
      return NextResponse.json({ error: "action must be one of: accept, dismiss" }, { status: 400 });
    }

    const updated = await transitionIntelligenceArtifactStatus(
      new SupabaseIntelligencePromotionStore(supabase),
      userId,
      id,
      nextStatus,
      {
        triggeredBy: "user",
        note: nextStatus === "accepted"
          ? "Accepted from the artifact inbox."
          : "Dismissed from the artifact inbox.",
        payload: {
          source: "artifact_inbox",
          requestedAction: body.action,
        },
      }
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
