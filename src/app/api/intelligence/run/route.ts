import { NextRequest, NextResponse } from "next/server";
import {
  describeScheduledIntelligenceCronWindow,
  executeIntelligencePipeline,
  SupabaseIntelligencePromotionStore,
} from "@/lib/intelligence-layer";
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

function configuredPipelineUserId(): string | null {
  return process.env.MISSION_CONTROL_USER_ID?.trim() || process.env.DEFAULT_USER_ID?.trim() || null;
}

async function runPipeline(
  source: "internal" | "cron" | "authenticated",
  supabase: AuthenticatedRouteContext["supabase"],
  userId: string,
  metadata?: Record<string, unknown>
) {
  const result = await executeIntelligencePipeline(
    supabase,
    new SupabaseIntelligencePromotionStore(supabase),
    userId,
    { enableTaskStalenessClarityGrouping: false }
  );

  console.info("Intelligence pipeline run completed", {
    source,
    userId,
    ...metadata,
    taskContextCount: result.taskContextCount,
    contractCount: result.contractCount,
    promotionEventCount: result.promotionEventCount,
    promotionEventCounts: result.promotionEventCounts,
  });

  return NextResponse.json(metadata ? { ...result, ...metadata } : result);
}

async function handle(request: NextRequest) {
  try {
    const internalAuth = readInternalAuthContext<AuthenticatedRouteContext>(request);
    if (internalAuth) {
      return runPipeline("internal", internalAuth.supabase, internalAuth.userId);
    }

    if (hasCronAccess(request)) {
      const scheduleWindow = describeScheduledIntelligenceCronWindow();
      if (!scheduleWindow.shouldRun) {
        console.info("Intelligence cron trigger skipped", scheduleWindow);
        return NextResponse.json({
          skipped: true,
          runAt: new Date().toISOString(),
          scheduleWindow,
        });
      }

      const userId = configuredPipelineUserId();
      if (!userId) {
        return NextResponse.json(
          { error: "MISSION_CONTROL_USER_ID or DEFAULT_USER_ID must be configured for scheduled intelligence execution" },
          { status: 503 }
        );
      }

      const supabase = createSupabaseAdminClient();
      return runPipeline("cron", supabase, userId, { scheduleWindow });
    }

    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    return runPipeline("authenticated", auth.context.supabase, auth.context.userId);
  } catch (error) {
    console.error("Error running intelligence pipeline:", error);
    return NextResponse.json({ error: "Failed to run intelligence pipeline" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
