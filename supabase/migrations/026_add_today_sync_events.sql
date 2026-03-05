-- Migration 026: add today sync event log for UI metadata

BEGIN;

CREATE TABLE IF NOT EXISTS today_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  promoted INT NOT NULL DEFAULT 0 CHECK (promoted >= 0),
  demoted INT NOT NULL DEFAULT 0 CHECK (demoted >= 0),
  skipped_pinned INT NOT NULL DEFAULT 0 CHECK (skipped_pinned >= 0),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(task_ids) <= 20)
);

CREATE INDEX IF NOT EXISTS idx_today_sync_events_user_synced
  ON today_sync_events(user_id, synced_at DESC);

CREATE TRIGGER trg_today_sync_events_updated
  BEFORE UPDATE ON today_sync_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE today_sync_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own today_sync_events"
  ON today_sync_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own today_sync_events"
  ON today_sync_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own today_sync_events"
  ON today_sync_events FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own today_sync_events"
  ON today_sync_events FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
