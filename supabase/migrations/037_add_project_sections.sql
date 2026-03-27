-- Project sections: section-like grouping within a project for tasks.

BEGIN;

CREATE TABLE project_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_sections_user_project_order
  ON project_sections(user_id, project_id, sort_order ASC, created_at ASC);

CREATE UNIQUE INDEX idx_project_sections_user_project_name_normalized
  ON project_sections(user_id, project_id, lower(trim(name)));

DROP TRIGGER IF EXISTS trg_project_sections_updated ON project_sections;

CREATE TRIGGER trg_project_sections_updated
  BEFORE UPDATE ON project_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project_sections"
  ON project_sections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project_sections"
  ON project_sections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project_sections"
  ON project_sections FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own project_sections"
  ON project_sections FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES project_sections(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_user_section
  ON tasks(user_id, section_id)
  WHERE section_id IS NOT NULL;

COMMIT;
