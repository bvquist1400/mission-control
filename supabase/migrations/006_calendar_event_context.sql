-- Persist user-authored planning context for calendar events.
-- Stored separately from ingested events so notes survive re-ingestion.

CREATE TABLE calendar_event_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('local', 'ical', 'graph')),
  external_event_id TEXT NOT NULL,
  meeting_context TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_calendar_event_context_user_source_external
  ON calendar_event_context(user_id, source, external_event_id);

CREATE INDEX idx_calendar_event_context_user_updated_at
  ON calendar_event_context(user_id, updated_at DESC);

CREATE TRIGGER trg_calendar_event_context_updated
  BEFORE UPDATE ON calendar_event_context
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE calendar_event_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own calendar_event_context"
  ON calendar_event_context FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own calendar_event_context"
  ON calendar_event_context FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own calendar_event_context"
  ON calendar_event_context FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own calendar_event_context"
  ON calendar_event_context FOR DELETE
  USING (auth.uid() = user_id);
