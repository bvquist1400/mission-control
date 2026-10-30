-- Rollback for 067_task_unblocks.sql: drops clear_task_unblock, the triggers
-- trg_tasks_unblock_dependents, trg_commitments_unblock_dependents,
-- trg_tasks_unblock_pill, trg_tasks_unblock_pill_insert and
-- trg_task_dependencies_unblock_reblock with their functions
-- (task_unblock_on_status_change, task_unblock_pill, task_unblock_on_link), the
-- helpers task_unblock_due_boost, task_unblock_day_label,
-- task_unblock_landing_date and task_unblock_end_of_day, the task_unblocks table
-- (unblock records) and tasks.unblocked_at.
--
-- ORDER: roll the app back to a build without "Now unblocked" FIRST (an app that
-- reads task_unblocks fails against a database without it), then run this.
--
-- Data: every status, due date, priority, comment and status-history row an
-- unblock or a reopen wrote STAYS as it is (they are ordinary task data); only
-- the pill and the record of what each unblock changed are lost, so a blocker
-- reopened after the rollback no longer puts anything back. Re-running is safe.

BEGIN;

DROP FUNCTION IF EXISTS clear_task_unblock(UUID, UUID, TEXT);
DROP TRIGGER IF EXISTS trg_task_dependencies_unblock_reblock ON task_dependencies;
DROP FUNCTION IF EXISTS task_unblock_on_link();
DROP TRIGGER IF EXISTS trg_tasks_unblock_pill ON tasks;
DROP TRIGGER IF EXISTS trg_tasks_unblock_pill_insert ON tasks;
DROP FUNCTION IF EXISTS task_unblock_pill();
DROP TRIGGER IF EXISTS trg_tasks_unblock_dependents ON tasks;
DROP TRIGGER IF EXISTS trg_commitments_unblock_dependents ON commitments;
DROP FUNCTION IF EXISTS task_unblock_on_status_change();
DROP FUNCTION IF EXISTS task_unblock_end_of_day(DATE);
DROP FUNCTION IF EXISTS task_unblock_landing_date(TIMESTAMPTZ, BOOLEAN);
DROP FUNCTION IF EXISTS task_unblock_day_label(DATE);
DROP FUNCTION IF EXISTS task_unblock_due_boost(TIMESTAMPTZ, TIMESTAMPTZ);
DROP TABLE IF EXISTS task_unblocks;
ALTER TABLE tasks DROP COLUMN IF EXISTS unblocked_at;

COMMIT;

NOTIFY pgrst, 'reload schema';
