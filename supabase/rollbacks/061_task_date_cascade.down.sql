-- Rollback for 061_task_date_cascade.sql: drops the loop guard trigger, the cascade
-- function and the cascade log tables, and takes back `authenticated`'s execute on
-- famcal_eligible (060's original grant: service_role only).
--
-- Data: due dates a cascade moved stay where they are, and the system comments it
-- wrote stay (ordinary task_comments rows). The log of old -> new dates is dropped
-- with its tables, so those cascades can no longer be undone. After this, a PATCH
-- that moves a due date later answers with cascade { status: "failed" } (the app
-- calls the function) until 061 is re-applied or the app is rolled back too.
-- Re-running is safe.

BEGIN;

DROP TRIGGER IF EXISTS trg_task_dependencies_guard_loop ON task_dependencies;
DROP FUNCTION IF EXISTS task_dependencies_guard_loop();
DROP FUNCTION IF EXISTS apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS task_graph_lock_key(UUID);
DROP TABLE IF EXISTS task_date_cascade_moves;
DROP TABLE IF EXISTS task_date_cascades;
DO $$
BEGIN
  IF to_regprocedure('famcal_eligible(tasks)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION famcal_eligible(tasks) FROM authenticated;
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
