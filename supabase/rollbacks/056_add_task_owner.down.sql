DROP INDEX IF EXISTS idx_tasks_user_owner;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_line_check,
  DROP CONSTRAINT IF EXISTS tasks_owner_label_check,
  DROP CONSTRAINT IF EXISTS tasks_owner_check,
  DROP COLUMN IF EXISTS status_line,
  DROP COLUMN IF EXISTS owner_label,
  DROP COLUMN IF EXISTS owner;
