-- Migration 009: Add 'quick_capture' to LLM feature CHECK constraints
--
-- The application code (src/app/api/tasks/parse/route.ts, src/lib/llm/catalog.ts)
-- uses 'quick_capture' as a feature name, but the CHECK constraints from migration
-- 007 only allow 'briefing_narrative' and 'intake_extraction'.
--
-- This migration drops the old constraints and recreates them with the additional
-- 'quick_capture' value.

BEGIN;

-- llm_user_preferences: drop old constraint then add updated one
ALTER TABLE llm_user_preferences
  DROP CONSTRAINT IF EXISTS llm_user_preferences_feature_check;

ALTER TABLE llm_user_preferences
  ADD CONSTRAINT llm_user_preferences_feature_check
  CHECK (feature IN ('global_default', 'briefing_narrative', 'intake_extraction', 'quick_capture'));

-- llm_usage_events: drop old constraint then add updated one
ALTER TABLE llm_usage_events
  DROP CONSTRAINT IF EXISTS llm_usage_events_feature_check;

ALTER TABLE llm_usage_events
  ADD CONSTRAINT llm_usage_events_feature_check
  CHECK (feature IN ('briefing_narrative', 'intake_extraction', 'quick_capture'));

COMMIT;
