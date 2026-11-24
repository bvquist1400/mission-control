-- Removes only 076 (craft estimates E3, add rows to a sitting in one transaction): the one function it adds.
-- Roll the app back first: the E3 app calls craft_add_sitting_rows from POST /api/craft/[id]/sitting-rows.
-- Data stays as it is: rows it ticked stay ticked and the rows it linked stay in their sittings.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION craft_add_sitting_rows(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER);
COMMIT;
NOTIFY pgrst, 'reload schema';
