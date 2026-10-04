-- Rolls back 059. Drops every session (and its links) and the unit columns.
-- tasks.actual_minutes keeps whatever the rollup last wrote.
BEGIN;

DROP TABLE IF EXISTS work_session_items;
DROP TABLE IF EXISTS work_sessions;
DROP FUNCTION IF EXISTS work_session_items_check_project();
DROP FUNCTION IF EXISTS work_sessions_check_ownership();
DROP FUNCTION IF EXISTS work_sessions_rollup_actual_minutes();

DROP TRIGGER IF EXISTS trg_task_checklist_items_completed_at ON task_checklist_items;
DROP FUNCTION IF EXISTS task_checklist_items_set_completed_at();

ALTER TABLE task_checklist_items
  DROP CONSTRAINT IF EXISTS task_checklist_items_work_type_check,
  DROP CONSTRAINT IF EXISTS task_checklist_items_unit_count_check,
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS work_type,
  DROP COLUMN IF EXISTS unit_count;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_work_type_check,
  DROP CONSTRAINT IF EXISTS tasks_unit_count_check,
  DROP COLUMN IF EXISTS is_sample,
  DROP COLUMN IF EXISTS work_type,
  DROP COLUMN IF EXISTS unit_count;

ALTER TABLE projects
  DROP COLUMN IF EXISTS pace_settings,
  DROP COLUMN IF EXISTS unit_label;

COMMIT;
