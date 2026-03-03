-- Power Planning foundation: week-level sprints and task assignment.

CREATE TABLE sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  theme TEXT NOT NULL DEFAULT '',
  focus_implementation_id UUID REFERENCES implementations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL;

CREATE INDEX idx_sprints_user_start_date ON sprints(user_id, start_date DESC);
CREATE INDEX idx_sprints_user_focus_impl ON sprints(user_id, focus_implementation_id)
  WHERE focus_implementation_id IS NOT NULL;
CREATE INDEX idx_tasks_user_sprint ON tasks(user_id, sprint_id)
  WHERE sprint_id IS NOT NULL;

CREATE TRIGGER trg_sprints_updated
  BEFORE UPDATE ON sprints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own sprints"
  ON sprints FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sprints"
  ON sprints FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own sprints"
  ON sprints FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own sprints"
  ON sprints FOR DELETE
  USING (auth.uid() = user_id);
