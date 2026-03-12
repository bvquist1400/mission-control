-- Persist project status history plus weekly/monthly review snapshots.

BEGIN;

CREATE TABLE IF NOT EXISTS project_status_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  implementation_id UUID REFERENCES implementations(id) ON DELETE SET NULL,
  captured_for_date DATE NOT NULL DEFAULT CURRENT_DATE,
  summary TEXT NOT NULL,
  rag rag_status,
  changes_today TEXT[] NOT NULL DEFAULT '{}',
  blockers TEXT[] NOT NULL DEFAULT '{}',
  next_step TEXT,
  needs_decision TEXT,
  related_task_ids UUID[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'system',
  model TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_status_updates_payload_object
    CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_project_status_updates_user_date
  ON project_status_updates(user_id, captured_for_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_status_updates_project_date
  ON project_status_updates(project_id, captured_for_date DESC, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_status_updates_user_project_date
  ON project_status_updates(user_id, project_id, captured_for_date);

CREATE TRIGGER trg_project_status_updates_updated
  BEFORE UPDATE ON project_status_updates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_status_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project_status_updates"
  ON project_status_updates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project_status_updates"
  ON project_status_updates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project_status_updates"
  ON project_status_updates FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own project_status_updates"
  ON project_status_updates FOR DELETE
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS briefing_review_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  review_type TEXT NOT NULL CHECK (review_type IN ('weekly', 'monthly')),
  anchor_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'system',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT briefing_review_snapshots_period_valid
    CHECK (period_end >= period_start),
  CONSTRAINT briefing_review_snapshots_anchor_in_range
    CHECK (anchor_date >= period_start AND anchor_date <= period_end),
  CONSTRAINT briefing_review_snapshots_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_briefing_review_snapshots_user_type_period
  ON briefing_review_snapshots(user_id, review_type, period_end DESC, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_briefing_review_snapshots_user_period
  ON briefing_review_snapshots(user_id, review_type, period_start, period_end);

CREATE TRIGGER trg_briefing_review_snapshots_updated
  BEFORE UPDATE ON briefing_review_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE briefing_review_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own briefing_review_snapshots"
  ON briefing_review_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own briefing_review_snapshots"
  ON briefing_review_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own briefing_review_snapshots"
  ON briefing_review_snapshots FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own briefing_review_snapshots"
  ON briefing_review_snapshots FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
