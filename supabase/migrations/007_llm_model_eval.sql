-- LLM model catalog, per-user model preferences, and usage telemetry.
-- Supports provider/model experimentation and cost comparison.

CREATE TABLE IF NOT EXISTS llm_model_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  input_price_per_1m_usd NUMERIC CHECK (input_price_per_1m_usd IS NULL OR input_price_per_1m_usd >= 0),
  output_price_per_1m_usd NUMERIC CHECK (output_price_per_1m_usd IS NULL OR output_price_per_1m_usd >= 0),
  pricing_tier TEXT CHECK (pricing_tier IS NULL OR pricing_tier IN ('standard', 'flex', 'priority')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  pricing_is_placeholder BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_llm_model_catalog_provider_model UNIQUE (provider, model_id)
);

CREATE TABLE IF NOT EXISTS llm_user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN ('global_default', 'briefing_narrative', 'intake_extraction')),
  active_model_id UUID REFERENCES llm_model_catalog(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_llm_user_preferences_user_feature UNIQUE (user_id, feature)
);

CREATE TABLE IF NOT EXISTS llm_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL CHECK (feature IN ('briefing_narrative', 'intake_extraction')),
  provider TEXT CHECK (provider IN ('openai', 'anthropic')),
  model_id TEXT,
  model_catalog_id UUID REFERENCES llm_model_catalog(id) ON DELETE SET NULL,
  model_source TEXT CHECK (model_source IN ('feature_override', 'global_default', 'default')),
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cache_hit', 'skipped_unconfigured')),
  latency_ms INT NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  input_tokens INT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  estimated_cost_usd NUMERIC CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  pricing_is_placeholder BOOLEAN,
  pricing_tier TEXT CHECK (pricing_tier IS NULL OR pricing_tier IN ('standard', 'flex', 'priority')),
  cache_status TEXT CHECK (cache_status IN ('hit', 'miss')),
  error_code TEXT,
  error_message TEXT,
  request_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backwards-compatibility upgrades for earlier drafts.
ALTER TABLE llm_model_catalog
  ADD COLUMN IF NOT EXISTS pricing_tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_model_catalog_pricing_tier_check'
      AND conrelid = 'llm_model_catalog'::regclass
  ) THEN
    ALTER TABLE llm_model_catalog
      ADD CONSTRAINT llm_model_catalog_pricing_tier_check
      CHECK (pricing_tier IS NULL OR pricing_tier IN ('standard', 'flex', 'priority'));
  END IF;
END;
$$;

ALTER TABLE llm_user_preferences
  ADD COLUMN IF NOT EXISTS feature TEXT,
  ADD COLUMN IF NOT EXISTS active_model_id UUID REFERENCES llm_model_catalog(id) ON DELETE SET NULL;

UPDATE llm_user_preferences
SET feature = 'global_default'
WHERE feature IS NULL
   OR feature NOT IN ('global_default', 'briefing_narrative', 'intake_extraction');

ALTER TABLE llm_user_preferences
  ALTER COLUMN feature SET DEFAULT 'global_default';

ALTER TABLE llm_user_preferences
  ALTER COLUMN feature SET NOT NULL;

ALTER TABLE llm_user_preferences
  DROP CONSTRAINT IF EXISTS uniq_llm_user_preferences_user;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_user_preferences_feature_check'
      AND conrelid = 'llm_user_preferences'::regclass
  ) THEN
    ALTER TABLE llm_user_preferences
      ADD CONSTRAINT llm_user_preferences_feature_check
      CHECK (feature IN ('global_default', 'briefing_narrative', 'intake_extraction'));
  END IF;
END;
$$;

ALTER TABLE llm_usage_events
  ADD COLUMN IF NOT EXISTS feature TEXT,
  ADD COLUMN IF NOT EXISTS model_source TEXT,
  ADD COLUMN IF NOT EXISTS pricing_tier TEXT;

UPDATE llm_usage_events
SET feature = 'briefing_narrative'
WHERE feature IS NULL
   OR feature NOT IN ('briefing_narrative', 'intake_extraction');

ALTER TABLE llm_usage_events
  ALTER COLUMN feature SET DEFAULT 'briefing_narrative';

ALTER TABLE llm_usage_events
  ALTER COLUMN feature SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_usage_events_feature_check'
      AND conrelid = 'llm_usage_events'::regclass
  ) THEN
    ALTER TABLE llm_usage_events
      ADD CONSTRAINT llm_usage_events_feature_check
      CHECK (feature IN ('briefing_narrative', 'intake_extraction'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_usage_events_model_source_check'
      AND conrelid = 'llm_usage_events'::regclass
  ) THEN
    ALTER TABLE llm_usage_events
      ADD CONSTRAINT llm_usage_events_model_source_check
      CHECK (model_source IS NULL OR model_source IN ('feature_override', 'global_default', 'default'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_usage_events_pricing_tier_check'
      AND conrelid = 'llm_usage_events'::regclass
  ) THEN
    ALTER TABLE llm_usage_events
      ADD CONSTRAINT llm_usage_events_pricing_tier_check
      CHECK (pricing_tier IS NULL OR pricing_tier IN ('standard', 'flex', 'priority'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_llm_model_catalog_enabled_sort
  ON llm_model_catalog(enabled DESC, sort_order ASC, display_name ASC);

CREATE INDEX IF NOT EXISTS idx_llm_user_preferences_user_feature
  ON llm_user_preferences(user_id, feature);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_llm_user_preferences_user_feature
  ON llm_user_preferences(user_id, feature);

CREATE INDEX IF NOT EXISTS idx_llm_usage_events_user_created_at
  ON llm_usage_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_usage_events_user_feature_created_at
  ON llm_usage_events(user_id, feature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_usage_events_user_provider_model_created_at
  ON llm_usage_events(user_id, provider, model_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_llm_model_catalog_updated ON llm_model_catalog;
CREATE TRIGGER trg_llm_model_catalog_updated
  BEFORE UPDATE ON llm_model_catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_llm_user_preferences_updated ON llm_user_preferences;
CREATE TRIGGER trg_llm_user_preferences_updated
  BEFORE UPDATE ON llm_user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE llm_model_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view llm_model_catalog" ON llm_model_catalog;
CREATE POLICY "Authenticated users can view llm_model_catalog"
  ON llm_model_catalog FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Users can view own llm_user_preferences" ON llm_user_preferences;
CREATE POLICY "Users can view own llm_user_preferences"
  ON llm_user_preferences FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own llm_user_preferences" ON llm_user_preferences;
CREATE POLICY "Users can insert own llm_user_preferences"
  ON llm_user_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own llm_user_preferences" ON llm_user_preferences;
CREATE POLICY "Users can update own llm_user_preferences"
  ON llm_user_preferences FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own llm_user_preferences" ON llm_user_preferences;
CREATE POLICY "Users can delete own llm_user_preferences"
  ON llm_user_preferences FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own llm_usage_events" ON llm_usage_events;
CREATE POLICY "Users can view own llm_usage_events"
  ON llm_usage_events FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own llm_usage_events" ON llm_usage_events;
CREATE POLICY "Users can insert own llm_usage_events"
  ON llm_usage_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own llm_usage_events" ON llm_usage_events;
CREATE POLICY "Users can delete own llm_usage_events"
  ON llm_usage_events FOR DELETE
  USING (auth.uid() = user_id);

-- Remove placeholder rows from earlier drafts.
DELETE FROM llm_model_catalog
WHERE model_id IN (
  'OPENAI_MODEL_A_PLACEHOLDER',
  'OPENAI_MODEL_B_PLACEHOLDER',
  'OPENAI_MODEL_C_PLACEHOLDER',
  'ANTHROPIC_MODEL_A_PLACEHOLDER',
  'ANTHROPIC_MODEL_B_PLACEHOLDER',
  'ANTHROPIC_MODEL_C_PLACEHOLDER'
);

INSERT INTO llm_model_catalog (
  provider,
  model_id,
  display_name,
  input_price_per_1m_usd,
  output_price_per_1m_usd,
  pricing_tier,
  enabled,
  pricing_is_placeholder,
  sort_order
)
VALUES
  ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 1.00, 5.00, NULL, true, false, 10),
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 3.00, 15.00, NULL, true, false, 20),
  ('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', 5.00, 25.00, NULL, false, false, 30),
  ('openai', 'gpt-5-nano', 'GPT-5 nano', 0.05, 0.40, 'standard', true, false, 40),
  ('openai', 'gpt-5-mini', 'GPT-5 mini', 0.25, 2.00, 'standard', true, false, 50),
  ('openai', 'gpt-5', 'GPT-5', 1.25, 10.00, 'standard', false, false, 60)
ON CONFLICT (provider, model_id)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  input_price_per_1m_usd = EXCLUDED.input_price_per_1m_usd,
  output_price_per_1m_usd = EXCLUDED.output_price_per_1m_usd,
  pricing_tier = EXCLUDED.pricing_tier,
  enabled = EXCLUDED.enabled,
  pricing_is_placeholder = EXCLUDED.pricing_is_placeholder,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

CREATE OR REPLACE FUNCTION prune_llm_usage_events(p_max_age INTERVAL DEFAULT INTERVAL '90 days')
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INT := 0;
BEGIN
  DELETE FROM llm_usage_events
  WHERE user_id = auth.uid()
    AND created_at < (now() - p_max_age);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
