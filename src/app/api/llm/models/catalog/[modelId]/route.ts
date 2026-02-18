import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

type PricingTier = "standard" | "flex" | "priority";

interface CatalogUpdateBody {
  displayName?: unknown;
  enabled?: unknown;
  pricingIsPlaceholder?: unknown;
  inputPricePer1mUsd?: unknown;
  outputPricePer1mUsd?: unknown;
  pricingTier?: unknown;
  sortOrder?: unknown;
}

const VALID_PRICING_TIERS: PricingTier[] = ["standard", "flex", "priority"];

function parseNullableNonNegativeNumber(
  value: unknown,
  fieldName: string
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${fieldName} must be null or a non-negative number` };
  }
  return { ok: true, value };
}

function createSupabaseServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient(supabaseUrl, serviceRoleKey);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const adminUserId = process.env.LLM_ADMIN_USER_ID || process.env.DEFAULT_USER_ID;
  if (!adminUserId || auth.context.userId !== adminUserId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const serviceClient = createSupabaseServiceClient();
  if (!serviceClient) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required to edit model catalog rows" },
      { status: 500 }
    );
  }

  const { modelId } = await params;
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }

  let body: CatalogUpdateBody = {};
  try {
    body = (await request.json()) as CatalogUpdateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
      return NextResponse.json({ error: "displayName must be a non-empty string" }, { status: 400 });
    }
    updates.display_name = body.displayName.trim();
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    updates.enabled = body.enabled;
  }

  if (body.pricingIsPlaceholder !== undefined) {
    if (typeof body.pricingIsPlaceholder !== "boolean") {
      return NextResponse.json({ error: "pricingIsPlaceholder must be a boolean" }, { status: 400 });
    }
    updates.pricing_is_placeholder = body.pricingIsPlaceholder;
  }

  if (body.pricingTier !== undefined) {
    if (body.pricingTier === null) {
      updates.pricing_tier = null;
    } else if (typeof body.pricingTier === "string" && VALID_PRICING_TIERS.includes(body.pricingTier as PricingTier)) {
      updates.pricing_tier = body.pricingTier;
    } else {
      return NextResponse.json(
        { error: "pricingTier must be one of: standard, flex, priority, or null" },
        { status: 400 }
      );
    }
  }

  if (body.inputPricePer1mUsd !== undefined) {
    const parsedInputPrice = parseNullableNonNegativeNumber(
      body.inputPricePer1mUsd,
      "inputPricePer1mUsd"
    );
    if (!parsedInputPrice.ok) {
      return NextResponse.json({ error: parsedInputPrice.error }, { status: 400 });
    }
    updates.input_price_per_1m_usd = parsedInputPrice.value;
  }

  if (body.outputPricePer1mUsd !== undefined) {
    const parsedOutputPrice = parseNullableNonNegativeNumber(
      body.outputPricePer1mUsd,
      "outputPricePer1mUsd"
    );
    if (!parsedOutputPrice.ok) {
      return NextResponse.json({ error: parsedOutputPrice.error }, { status: 400 });
    }
    updates.output_price_per_1m_usd = parsedOutputPrice.value;
  }

  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder)) {
      return NextResponse.json({ error: "sortOrder must be an integer" }, { status: 400 });
    }
    updates.sort_order = body.sortOrder;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data, error } = await serviceClient
    .from("llm_model_catalog")
    .update(updates)
    .eq("id", trimmedModelId)
    .select(
      "id, provider, model_id, display_name, input_price_per_1m_usd, output_price_per_1m_usd, pricing_tier, enabled, pricing_is_placeholder, sort_order"
    )
    .maybeSingle();

  if (error) {
    console.error("Failed to update llm_model_catalog row:", error);
    return NextResponse.json({ error: "Failed to update model catalog row" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  return NextResponse.json({ model: data });
}
