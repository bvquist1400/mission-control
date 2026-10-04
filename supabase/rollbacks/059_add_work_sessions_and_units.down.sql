-- Rolls back 059. Drops every session (and its links), the session functions,
-- the triggers and the unit columns.
--
-- Contract (decided in fix round 1, not a bug): tasks.actual_minutes KEEPS the
-- value the session rollup last wrote. The value a task had before its first
-- session is not stored anywhere, so it is not restored; re-applying 059 does
-- not recompute it either. test:pace-db pins this ("rollback after sessions exist").
BEGIN;

DROP TRIGGER IF EXISTS trg_tasks_guard_project_move ON tasks;
DROP FUNCTION IF EXISTS tasks_guard_project_move_with_sessions();
DROP FUNCTION IF EXISTS work_session_create(UUID, JSONB, UUID[], BOOLEAN);
DROP FUNCTION IF EXISTS work_session_update(UUID, UUID, JSONB, UUID[]);
DROP FUNCTION IF EXISTS work_session_delete(UUID, UUID);
DROP FUNCTION IF EXISTS work_sessions_out_of_scope_items(UUID, UUID, UUID[]);
DROP FUNCTION IF EXISTS work_sessions_lock_tasks(UUID, UUID[]);
DROP FUNCTION IF EXISTS work_sessions_item_tasks(UUID, UUID[]);
DROP FUNCTION IF EXISTS work_sessions_assert_caller(UUID);

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
