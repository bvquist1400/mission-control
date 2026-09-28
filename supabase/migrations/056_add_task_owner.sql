-- Who holds a task right now, and one plain sentence on where it stands.
-- owner = 'brent' means Brent must act; 'agent' (the default) means an agent
-- (the PM, a builder, Codex…) has it. owner_label names which one ("PM",
-- "Codex"). status_line is the "where this stands" sentence the Portfolio
-- page shows instead of the comment trail.
--
-- Additive only: existing rows become owner = 'agent' with no label or line,
-- and every existing insert keeps working because each column has a default
-- or is nullable. The constant default makes ADD COLUMN a catalog-only change.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN IF NOT EXISTS owner_label TEXT,
  ADD COLUMN IF NOT EXISTS status_line TEXT;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_owner_check,
  DROP CONSTRAINT IF EXISTS tasks_owner_label_check,
  DROP CONSTRAINT IF EXISTS tasks_status_line_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_owner_check
    CHECK (owner IN ('brent', 'agent')),
  ADD CONSTRAINT tasks_owner_label_check
    CHECK (owner_label IS NULL OR (NULLIF(BTRIM(owner_label), '') IS NOT NULL AND char_length(owner_label) <= 40)),
  ADD CONSTRAINT tasks_status_line_check
    CHECK (status_line IS NULL OR (NULLIF(BTRIM(status_line), '') IS NOT NULL AND char_length(status_line) <= 280));

-- "Assigned to you" and the Portfolio hero read open tasks by owner.
CREATE INDEX IF NOT EXISTS idx_tasks_user_owner
  ON tasks(user_id, owner);
