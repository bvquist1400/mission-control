-- Rollback for 066_break_task_into_tasks.sql: drops break_task_into_tasks,
-- undo_break_task_into_tasks, the umbrella guard trigger and its function, the
-- indexes, constraints and tasks.parent_task_id.
--
-- ORDER: roll the app back to a build without "Break into tasks" FIRST (an app
-- that selects parent_task_id through the Today embed, or calls these
-- functions, fails against a database without them), then run this.
--
-- Data: the step tasks, their sections/projects, comments and links all STAY as
-- ordinary tasks; only the umbrella link (which task each was broken out of) is
-- lost, so umbrellas go back to counting their checklist rows. Re-running is safe.

BEGIN;

DROP FUNCTION IF EXISTS undo_break_task_into_tasks(UUID, UUID, JSONB);
DROP FUNCTION IF EXISTS break_task_into_tasks(UUID, UUID, JSONB);
DROP TRIGGER IF EXISTS trg_tasks_guard_parent_task ON tasks;
DROP FUNCTION IF EXISTS tasks_guard_parent_task();
DROP INDEX IF EXISTS idx_tasks_parent_task;
DROP INDEX IF EXISTS idx_tasks_user_parent_task;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_parent_task_not_self;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_parent_task_id_fkey;
ALTER TABLE tasks DROP COLUMN IF EXISTS parent_task_id;

COMMIT;

NOTIFY pgrst, 'reload schema';
