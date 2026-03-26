import { NextRequest, NextResponse } from "next/server";
import { readIntelligenceArtifactInbox } from "@/lib/intelligence-layer/inbox";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const payload = await readIntelligenceArtifactInbox(supabase, userId);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("Error reading intelligence artifact inbox:", error);
    return NextResponse.json({ error: "Failed to load intelligence artifact inbox" }, { status: 500 });
  }
}
