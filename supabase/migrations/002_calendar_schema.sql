-- Calendar schema for sanitized event ingestion and delta snapshots

CREATE TABLE calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('local', 'ical', 'graph')),
  external_event_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL,
  organizer_display TEXT,
  with_display JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(with_display) = 'array'),
  body_scrubbed TEXT,
  body_scrubbed_preview TEXT,
  content_hash TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calendar_events_user_start_at ON calendar_events(user_id, start_at);
CREATE UNIQUE INDEX uniq_calendar_events_user_source_external_start
  ON calendar_events(user_id, source, external_event_id, start_at);

CREATE TABLE calendar_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  range_start DATE NOT NULL,
  range_end DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload_min JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(payload_min) = 'array')
);

CREATE INDEX idx_calendar_snapshots_user_range_captured
  ON calendar_snapshots(user_id, range_start, range_end, captured_at DESC);

CREATE TRIGGER trg_calendar_events_updated
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own calendar_events"
  ON calendar_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own calendar_events"
  ON calendar_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own calendar_events"
  ON calendar_events FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own calendar_events"
  ON calendar_events FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own calendar_snapshots"
  ON calendar_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own calendar_snapshots"
  ON calendar_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own calendar_snapshots"
  ON calendar_snapshots FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own calendar_snapshots"
  ON calendar_snapshots FOR DELETE
  USING (auth.uid() = user_id);
