-- Rollback for 069_project_colors.sql: drops implementations.color and
-- projects.color with their CHECK constraints (implementations_color_hex_check,
-- projects_color_hex_check), whether or not 070 has validated them, so it
-- works with or without 070 applied (070's rollback is not needed first).
--
-- ORDER: roll the app back to a build without project colours FIRST (an app
-- that writes color fails against a database without the column), then run this.
--
-- Data: every chosen project/application colour is lost; squares go back to the
-- theme defaults. Nothing else changes. Re-running is safe.
--
-- Busy tables: a table that stays busy past 10s makes this fail cleanly (55P03),
-- nothing changes, and it can simply be re-run.

BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE implementations DROP CONSTRAINT IF EXISTS implementations_color_hex_check;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_color_hex_check;
ALTER TABLE implementations DROP COLUMN IF EXISTS color;
ALTER TABLE projects DROP COLUMN IF EXISTS color;

COMMIT;

NOTIFY pgrst, 'reload schema';
