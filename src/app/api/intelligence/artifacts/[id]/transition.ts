import type { SupabaseClient } from "@supabase/supabase-js";
import { transitionIntelligenceArtifactStatus } from "@/lib/intelligence-layer/promotion";
import { SupabaseIntelligencePromotionStore } from "@/lib/intelligence-layer/promotion-store";
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
  return transitionIntelligenceArtifactStatus(
    new SupabaseIntelligencePromotionStore(supabase),
    userId,
    artifactId,
    actionToArtifactStatus(action),
    {
      triggeredBy: "user",
      note: noteForAction(action),
      payload: {
        source: "artifact_inbox",
        requestedAction: action,
      },
    }
  );
}
