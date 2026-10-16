-- Rollback for 060_famcal_personal_task_comment.sql: drops the FamCal eligibility
-- function and the FamCal comment function. No data changes: comments it inserted
-- are ordinary task_comments rows and stay. After this, every FamCal-key task read
-- and write answers 500 (the app code filters on `famcal_eligible` and calls the
-- comment function) until 060 is re-applied or the app is rolled back too.
-- Re-running is safe.

DROP FUNCTION IF EXISTS famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS famcal_eligible(tasks);

NOTIFY pgrst, 'reload schema';
