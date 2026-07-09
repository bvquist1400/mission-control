import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionIntelligenceArtifactStatus } from "@/lib/intelligence-layer/promotion";
import { SupabaseIntelligencePromotionStore } from "@/lib/intelligence-layer/promotion-store";
import { executeApplyArtifactAction } from "@/lib/intelligence-layer/apply-executors";
import type { IntelligenceArtifactStatus } from "@/lib/intelligence-layer/phase2-types";

export type IntelligenceArtifactRouteAction = "accept" | "dismiss" | "apply";

export function actionToArtifactStatus(action: IntelligenceArtifactRouteAction): IntelligenceArtifactStatus {
  switch (action) {
    case "accept":
      return "accepted";
    case "dismiss":
      return "dismissed";
    case "apply":
      return "applied";
  }
}

function noteForAction(action: IntelligenceArtifactRouteAction): string {
  switch (action) {
    case "accept":
      return "Accepted from the artifact inbox.";
    case "dismiss":
      return "Dismissed from the artifact inbox.";
    case "apply":
      return "Marked handled from the artifact inbox.";
  }
}

export async function performArtifactRouteAction(
  supabase: SupabaseClient,
  userId: string,
  artifactId: string,
  action: IntelligenceArtifactRouteAction
) {
  const store = new SupabaseIntelligencePromotionStore(supabase);

  let executed = false;
  let executorAction: string | null = null;
  let executorReason: string | null = null;

  if (action === "apply") {
    const artifact = await store.getArtifactById(userId, artifactId);
    if (!artifact) {
      throw new Error("Intelligence artifact not found");
    }

    // Only "accepted" artifacts can legally transition to "applied" (see
    // ALLOWED_STATUS_TRANSITIONS in promotion.ts). Skip the executor for any
    // other current status so a doomed transition can't still mutate the task
    // — transitionIntelligenceArtifactStatus below will reject it with a 409.
    if (artifact.status === "accepted") {
      const executionResult = await executeApplyArtifactAction(supabase, userId, artifact);
      executed = executionResult.executed;
      executorAction = executionResult.executorAction;
      executorReason = executionResult.reason;
    }
  }

  const updated = await transitionIntelligenceArtifactStatus(
    store,
    userId,
    artifactId,
    actionToArtifactStatus(action),
    {
      triggeredBy: "user",
      note: noteForAction(action),
      payload: {
        source: "artifact_inbox",
        requestedAction: action,
        executed,
        executor_action: executorAction,
      },
    }
  );

  return { ...updated, executed, executor_action: executorAction, executor_reason: executorReason };
}
