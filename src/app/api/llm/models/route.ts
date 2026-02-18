import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import {
  LLM_PREFERENCE_FEATURES,
  listAllModels,
  listUserModelPreferences,
  preferenceListToMap,
  resolveModelForFeature,
} from "@/lib/llm";

export async function GET(request: NextRequest) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const { supabase, userId } = auth.context;
  const models = await listAllModels(supabase);
  const preferences = preferenceListToMap(await listUserModelPreferences(supabase, userId));
  const resolvedBriefing = await resolveModelForFeature(supabase, userId, "briefing_narrative");
  const resolvedExtraction = await resolveModelForFeature(supabase, userId, "intake_extraction");
  const enabledModels = models.filter((model) => model.enabled);
  const preferenceFeatures = LLM_PREFERENCE_FEATURES;

  return NextResponse.json({
    models,
    enabledModels,
    preferenceFeatures,
    preferences,
    resolved: {
      briefing_narrative: resolvedBriefing,
      intake_extraction: resolvedExtraction,
    },
    activeModelId: preferences.global_default,
    activeModel: models.find((model) => model.id === preferences.global_default) ?? null,
    usingDefault: !preferences.global_default,
  });
}
