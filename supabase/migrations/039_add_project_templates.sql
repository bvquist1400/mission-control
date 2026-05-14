-- Project template foundation for reusable project scaffolds.

BEGIN;

CREATE TABLE project_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_stage project_stage NOT NULL DEFAULT 'Planned',
  default_rag rag_status NOT NULL DEFAULT 'Green',
  default_status_summary TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_template_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  template_id UUID NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_template_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  template_id UUID NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
  template_section_id UUID REFERENCES project_template_sections(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  task_type task_type NOT NULL DEFAULT 'Task',
  priority_score INT NOT NULL DEFAULT 50 CHECK (priority_score >= 0 AND priority_score <= 100),
  status task_status NOT NULL DEFAULT 'Backlog',
  relative_due_days INT,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  blocker BOOLEAN NOT NULL DEFAULT false,
  waiting_on TEXT,
  sort_order INT NOT NULL DEFAULT 1000,
  checklist_items TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_templates_user_active_name
  ON project_templates(user_id, is_active, name);

CREATE INDEX idx_project_templates_user_updated
  ON project_templates(user_id, updated_at DESC);

CREATE INDEX idx_project_template_sections_user_template_sort
  ON project_template_sections(user_id, template_id, sort_order ASC);

CREATE INDEX idx_project_template_tasks_user_template_sort
  ON project_template_tasks(user_id, template_id, sort_order ASC);

CREATE INDEX idx_project_template_tasks_section_sort
  ON project_template_tasks(template_section_id, sort_order ASC)
  WHERE template_section_id IS NOT NULL;

CREATE TRIGGER trg_project_templates_updated
  BEFORE UPDATE ON project_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_project_template_sections_updated
  BEFORE UPDATE ON project_template_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_project_template_tasks_updated
  BEFORE UPDATE ON project_template_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_template_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_template_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project templates"
  ON project_templates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project templates"
  ON project_templates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project templates"
  ON project_templates FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own project templates"
  ON project_templates FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own project template sections"
  ON project_template_sections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project template sections"
  ON project_template_sections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project template sections"
  ON project_template_sections FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own project template sections"
  ON project_template_sections FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own project template tasks"
  ON project_template_tasks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own project template tasks"
  ON project_template_tasks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own project template tasks"
  ON project_template_tasks FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own project template tasks"
  ON project_template_tasks FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
