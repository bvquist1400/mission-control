-- Rollback for 063_add_task_start_at.sql: drops the start-date guard trigger, its
-- function and tasks.start_at.
--
-- ORDER: roll the app back to a build without start dates FIRST (an app that
-- selects or writes start_at fails against a database without the column), then
-- run this.
--
-- Data: every task's start date is lost (the due dates, the cascade log, comments
-- and everything else stay as they are). Re-running is safe.

BEGIN;

DROP TRIGGER IF EXISTS trg_tasks_guard_start_at ON tasks;
DROP FUNCTION IF EXISTS tasks_guard_start_at();
ALTER TABLE tasks DROP COLUMN IF EXISTS start_at;

COMMIT;

NOTIFY pgrst, 'reload schema';
