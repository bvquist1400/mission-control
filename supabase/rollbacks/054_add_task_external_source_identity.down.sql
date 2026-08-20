DROP INDEX IF EXISTS uq_tasks_user_external_source_id;
DROP INDEX IF EXISTS idx_tasks_user_external_source;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_external_source_id_requires_system,
  DROP COLUMN IF EXISTS external_source_id,
  DROP COLUMN IF EXISTS external_source_system;
