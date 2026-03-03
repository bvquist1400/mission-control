-- System Self-Awareness: store the most recent implementation health snapshot.

ALTER TABLE implementations
  ADD COLUMN IF NOT EXISTS health_snapshot JSONB;
