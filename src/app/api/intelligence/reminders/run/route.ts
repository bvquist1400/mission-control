import { NextRequest, NextResponse } from "next/server";
import { executeAcceptedReminderArtifactsForUser } from "@/lib/intelligence-layer/reminders";
import { SupabaseIntelligencePromotionStore } from "@/lib/intelligence-layer/promotion-store";
import { SupabaseIntelligenceReminderStore } from "@/lib/intelligence-layer/reminder-store";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import type { AuthenticatedRouteContext } from "@/lib/supabase/route-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { readInternalAuthContext } from "@/lib/supabase/internal-auth";

function hasCronAccess(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;

  return Boolean(cronSecret && bearerToken === cronSecret);
}

function parseLimit(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get("limit");
  if (!raw) {
    return 25;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 25;
  }

  return Math.min(parsed, 100);
}

function configuredReminderUserId(): string | null {
  return process.env.MISSION_CONTROL_USER_ID?.trim() || process.env.DEFAULT_USER_ID?.trim() || null;
}

export async function POST(request: NextRequest) {
  try {
    const limit = parseLimit(request);
    const internalAuth = readInternalAuthContext<AuthenticatedRouteContext>(request);

    if (internalAuth) {
      const result = await executeAcceptedReminderArtifactsForUser(
        new SupabaseIntelligenceReminderStore(internalAuth.supabase),
        new SupabaseIntelligencePromotionStore(internalAuth.supabase),
        internalAuth.userId,
        { limit }
      );

      return NextResponse.json(result);
    }

    if (hasCronAccess(request)) {
      const userId = configuredReminderUserId();
      if (!userId) {
        return NextResponse.json(
          { error: "MISSION_CONTROL_USER_ID or DEFAULT_USER_ID must be configured for cron reminder execution" },
          { status: 503 }
        );
      }

      const supabase = createSupabaseAdminClient();
      const result = await executeAcceptedReminderArtifactsForUser(
        new SupabaseIntelligenceReminderStore(supabase),
        new SupabaseIntelligencePromotionStore(supabase),
        userId,
        { limit }
      );

      return NextResponse.json(result);
    }

    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const result = await executeAcceptedReminderArtifactsForUser(
      new SupabaseIntelligenceReminderStore(supabase),
      new SupabaseIntelligencePromotionStore(supabase),
      userId,
      { limit }
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error running intelligence reminders:", error);
    return NextResponse.json({ error: "Failed to run intelligence reminders" }, { status: 500 });
  }
}
