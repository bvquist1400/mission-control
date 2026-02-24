-- Projects Layer
-- Adds a projects table as a first-class layer between implementations and tasks.
-- Tasks gain an optional project_id FK.

BEGIN;

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  implementation_id UUID REFERENCES implementations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  phase impl_phase NOT NULL DEFAULT 'Intake',
  rag rag_status NOT NULL DEFAULT 'Green',
  target_date DATE,
  servicenow_spm_id TEXT,
  status_summary TEXT NOT NULL DEFAULT '',
  portfolio_rank INT NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_projects_user ON projects(user_id);
CREATE INDEX idx_projects_user_impl ON projects(user_id, implementation_id);
CREATE INDEX idx_projects_rank ON projects(user_id, portfolio_rank ASC);

-- updated_at trigger (reuse existing set_updated_at function)
CREATE TRIGGER trg_projects_updated
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own projects"
  ON projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON projects FOR DELETE
  USING (auth.uid() = user_id);

-- Add project_id to tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL;

COMMIT;
