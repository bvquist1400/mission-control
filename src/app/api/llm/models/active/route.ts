import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import {
  getModelById,
  listUserModelPreferences,
  preferenceListToMap,
  resolveModelForFeature,
  setUserActiveModel,
  type LlmPreferenceFeature,
} from "@/lib/llm";

interface ActiveModelBody {
  modelId?: string | null;
  feature?: LlmPreferenceFeature;
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const { supabase, userId } = auth.context;

  let body: ActiveModelBody = {};
  try {
    body = (await request.json()) as ActiveModelBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedModelId =
    typeof body.modelId === "string" && body.modelId.trim().length > 0 ? body.modelId.trim() : null;
  const requestedFeature: LlmPreferenceFeature =
    body.feature === "briefing_narrative" ||
    body.feature === "intake_extraction" ||
    body.feature === "global_default"
      ? body.feature
      : "global_default";

  if (requestedModelId) {
    const model = await getModelById(supabase, requestedModelId);
    if (!model || !model.enabled) {
      return NextResponse.json({ error: "Selected model is invalid or disabled" }, { status: 400 });
    }
  }

  const ok = await setUserActiveModel(supabase, userId, requestedModelId, requestedFeature);
  if (!ok) {
    return NextResponse.json({ error: "Failed to update active model" }, { status: 500 });
  }

  const preferences = preferenceListToMap(await listUserModelPreferences(supabase, userId));
  const resolvedBriefing = await resolveModelForFeature(supabase, userId, "briefing_narrative");
  const resolvedExtraction = await resolveModelForFeature(supabase, userId, "intake_extraction");
  const activeModel = preferences.global_default ? await getModelById(supabase, preferences.global_default) : null;

  return NextResponse.json({
    feature: requestedFeature,
    preferences,
    resolved: {
      briefing_narrative: resolvedBriefing,
      intake_extraction: resolvedExtraction,
    },
    activeModelId: activeModel?.id ?? null,
    activeModel,
    usingDefault: !activeModel,
  });
}
