-- Notes layer: linked work context for meetings, implementations, projects, tasks, and decisions.

BEGIN;

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL DEFAULT '',
  note_type TEXT NOT NULL CHECK (
    note_type IN (
      'working_note',
      'meeting_note',
      'application_note',
      'decision_note',
      'prep_note',
      'retrospective_note'
    )
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pinned BOOLEAN NOT NULL DEFAULT false,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS note_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'task',
      'calendar_event',
      'implementation',
      'project',
      'stakeholder',
      'commitment',
      'sprint'
    )
  ),
  entity_id TEXT NOT NULL,
  link_role TEXT NOT NULL DEFAULT 'reference' CHECK (
    link_role IN (
      'primary_context',
      'meeting_for',
      'related_task',
      'decision_about',
      'prep_for',
      'reference'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT note_links_note_entity_role_key UNIQUE (note_id, entity_type, entity_id, link_role)
);

CREATE TABLE IF NOT EXISTS note_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'linked' CHECK (
    relationship_type IN ('linked', 'created_from', 'discussed_in')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT note_tasks_note_task_relationship_key UNIQUE (note_id, task_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS note_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  decision_status TEXT NOT NULL DEFAULT 'active' CHECK (
    decision_status IN ('active', 'superseded', 'reversed')
  ),
  decided_at TIMESTAMPTZ,
  decided_by_stakeholder_id UUID REFERENCES stakeholders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_updated_at
  ON notes(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_user_type_status
  ON notes(user_id, note_type, status);

CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_updated_at
  ON notes(user_id, pinned, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_note_links_note
  ON note_links(note_id);

CREATE INDEX IF NOT EXISTS idx_note_links_user_entity
  ON note_links(user_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_note_links_user_entity_role
  ON note_links(user_id, entity_type, entity_id, link_role);

CREATE INDEX IF NOT EXISTS idx_note_tasks_user_task
  ON note_tasks(user_id, task_id);

CREATE INDEX IF NOT EXISTS idx_note_tasks_user_note
  ON note_tasks(user_id, note_id);

CREATE INDEX IF NOT EXISTS idx_note_decisions_note
  ON note_decisions(note_id);

CREATE INDEX IF NOT EXISTS idx_note_decisions_user_status_updated_at
  ON note_decisions(user_id, decision_status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_notes_updated ON notes;

CREATE TRIGGER trg_notes_updated
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_note_decisions_updated ON note_decisions;

CREATE TRIGGER trg_note_decisions_updated
  BEFORE UPDATE ON note_decisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notes"
  ON notes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notes"
  ON notes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes"
  ON notes FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own notes"
  ON notes FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own note_links"
  ON note_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own note_links"
  ON note_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own note_links"
  ON note_links FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own note_links"
  ON note_links FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own note_tasks"
  ON note_tasks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own note_tasks"
  ON note_tasks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own note_tasks"
  ON note_tasks FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own note_tasks"
  ON note_tasks FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own note_decisions"
  ON note_decisions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own note_decisions"
  ON note_decisions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own note_decisions"
  ON note_decisions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own note_decisions"
  ON note_decisions FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
