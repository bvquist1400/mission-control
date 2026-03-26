BEGIN;

CREATE TABLE IF NOT EXISTS intelligence_contract_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_type TEXT NOT NULL CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task'
    )
  ),
  canonical_subject_key TEXT NOT NULL,
  promotion_family_key TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  subject_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(subject_payload) = 'object'),
  metrics_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics_payload) = 'object'),
  evidence_payload JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_payload) = 'array'),
  provenance_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance_payload) = 'object'),
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intelligence_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN (
      'single_contract',
      'task_staleness_clarity_group'
    )
  ),
  grouping_key TEXT,
  subject_key TEXT NOT NULL,
  primary_contract_type TEXT NOT NULL CHECK (
    primary_contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'open',
      'accepted',
      'applied',
      'dismissed',
      'expired'
    )
  ),
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  available_actions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(available_actions) = 'array'),
  artifact_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_evidence) = 'array'),
  review_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(review_payload) = 'object'),
  content_hash TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intelligence_artifact_family_coverage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  promotion_family_key TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task'
    )
  ),
  canonical_subject_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_artifact_family_coverage_artifact_family_key UNIQUE (artifact_id, promotion_family_key)
);

CREATE TABLE IF NOT EXISTS intelligence_artifact_contract_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  contract_snapshot_id UUID NOT NULL REFERENCES intelligence_contract_snapshots(id) ON DELETE CASCADE,
  promotion_family_key TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task'
    )
  ),
  link_role TEXT NOT NULL CHECK (link_role IN ('primary', 'grouped', 'update')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_artifact_contract_links_unique UNIQUE (artifact_id, contract_snapshot_id)
);

CREATE TABLE IF NOT EXISTS intelligence_artifact_status_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  from_status TEXT CHECK (
    from_status IN (
      'open',
      'accepted',
      'applied',
      'dismissed',
      'expired'
    )
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN (
      'open',
      'accepted',
      'applied',
      'dismissed',
      'expired'
    )
  ),
  triggered_by TEXT NOT NULL DEFAULT 'system' CHECK (triggered_by IN ('system', 'user')),
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intelligence_promotion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_snapshot_id UUID REFERENCES intelligence_contract_snapshots(id) ON DELETE SET NULL,
  artifact_id UUID REFERENCES intelligence_artifacts(id) ON DELETE SET NULL,
  promotion_family_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'created',
      'updated',
      'noop',
      'grouped_created',
      'grouped_updated',
      'grouped_noop'
    )
  ),
  suppression_reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE intelligence_promotion_events
  ADD COLUMN IF NOT EXISTS suppression_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_intelligence_contract_snapshots_user_family_detected
  ON intelligence_contract_snapshots(user_id, promotion_family_key, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_contract_snapshots_user_subject_detected
  ON intelligence_contract_snapshots(user_id, canonical_subject_key, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifacts_user_status_updated
  ON intelligence_artifacts(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifacts_user_subject_status
  ON intelligence_artifacts(user_id, subject_key, status);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifact_family_coverage_user_family
  ON intelligence_artifact_family_coverage(user_id, promotion_family_key);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifact_family_coverage_user_subject
  ON intelligence_artifact_family_coverage(user_id, subject_key);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifact_contract_links_artifact
  ON intelligence_artifact_contract_links(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifact_status_transitions_artifact
  ON intelligence_artifact_status_transitions(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_promotion_events_user_family
  ON intelligence_promotion_events(user_id, promotion_family_key, created_at DESC);

DROP TRIGGER IF EXISTS trg_intelligence_artifacts_updated ON intelligence_artifacts;

CREATE TRIGGER trg_intelligence_artifacts_updated
  BEFORE UPDATE ON intelligence_artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE intelligence_contract_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_artifact_family_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_artifact_contract_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_artifact_status_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_promotion_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own intelligence contract snapshots" ON intelligence_contract_snapshots;
DROP POLICY IF EXISTS "Users can insert own intelligence contract snapshots" ON intelligence_contract_snapshots;
DROP POLICY IF EXISTS "Users can delete own intelligence contract snapshots" ON intelligence_contract_snapshots;

DROP POLICY IF EXISTS "Users can view own intelligence artifacts" ON intelligence_artifacts;
DROP POLICY IF EXISTS "Users can insert own intelligence artifacts" ON intelligence_artifacts;
DROP POLICY IF EXISTS "Users can update own intelligence artifacts" ON intelligence_artifacts;
DROP POLICY IF EXISTS "Users can delete own intelligence artifacts" ON intelligence_artifacts;

DROP POLICY IF EXISTS "Users can view own intelligence artifact family coverage" ON intelligence_artifact_family_coverage;
DROP POLICY IF EXISTS "Users can insert own intelligence artifact family coverage" ON intelligence_artifact_family_coverage;
DROP POLICY IF EXISTS "Users can update own intelligence artifact family coverage" ON intelligence_artifact_family_coverage;
DROP POLICY IF EXISTS "Users can delete own intelligence artifact family coverage" ON intelligence_artifact_family_coverage;

DROP POLICY IF EXISTS "Users can view own intelligence artifact contract links" ON intelligence_artifact_contract_links;
DROP POLICY IF EXISTS "Users can insert own intelligence artifact contract links" ON intelligence_artifact_contract_links;
DROP POLICY IF EXISTS "Users can update own intelligence artifact contract links" ON intelligence_artifact_contract_links;
DROP POLICY IF EXISTS "Users can delete own intelligence artifact contract links" ON intelligence_artifact_contract_links;

DROP POLICY IF EXISTS "Users can view own intelligence artifact status transitions" ON intelligence_artifact_status_transitions;
DROP POLICY IF EXISTS "Users can insert own intelligence artifact status transitions" ON intelligence_artifact_status_transitions;
DROP POLICY IF EXISTS "Users can update own intelligence artifact status transitions" ON intelligence_artifact_status_transitions;
DROP POLICY IF EXISTS "Users can delete own intelligence artifact status transitions" ON intelligence_artifact_status_transitions;

DROP POLICY IF EXISTS "Users can view own intelligence promotion events" ON intelligence_promotion_events;
DROP POLICY IF EXISTS "Users can insert own intelligence promotion events" ON intelligence_promotion_events;
DROP POLICY IF EXISTS "Users can update own intelligence promotion events" ON intelligence_promotion_events;
DROP POLICY IF EXISTS "Users can delete own intelligence promotion events" ON intelligence_promotion_events;

CREATE POLICY "Users can view own intelligence contract snapshots"
  ON intelligence_contract_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence contract snapshots"
  ON intelligence_contract_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence contract snapshots"
  ON intelligence_contract_snapshots FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own intelligence artifacts"
  ON intelligence_artifacts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence artifacts"
  ON intelligence_artifacts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence artifacts"
  ON intelligence_artifacts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence artifacts"
  ON intelligence_artifacts FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own intelligence artifact family coverage"
  ON intelligence_artifact_family_coverage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence artifact family coverage"
  ON intelligence_artifact_family_coverage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence artifact family coverage"
  ON intelligence_artifact_family_coverage FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence artifact family coverage"
  ON intelligence_artifact_family_coverage FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own intelligence artifact contract links"
  ON intelligence_artifact_contract_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence artifact contract links"
  ON intelligence_artifact_contract_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence artifact contract links"
  ON intelligence_artifact_contract_links FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence artifact contract links"
  ON intelligence_artifact_contract_links FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own intelligence artifact status transitions"
  ON intelligence_artifact_status_transitions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence artifact status transitions"
  ON intelligence_artifact_status_transitions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence artifact status transitions"
  ON intelligence_artifact_status_transitions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence artifact status transitions"
  ON intelligence_artifact_status_transitions FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own intelligence promotion events"
  ON intelligence_promotion_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence promotion events"
  ON intelligence_promotion_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence promotion events"
  ON intelligence_promotion_events FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence promotion events"
  ON intelligence_promotion_events FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
