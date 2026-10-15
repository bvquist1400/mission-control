-- Rollback for 060_famcal_personal_task_comment.sql: drops the FamCal comment
-- function. No data changes: comments it inserted are ordinary task_comments rows
-- and stay. After this, the FamCal key's comment POST answers 500 (the app code
-- calls the function) until 060 is re-applied or the app is rolled back too.
-- Re-running is safe.

DROP FUNCTION IF EXISTS famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT);

NOTIFY pgrst, 'reload schema';
