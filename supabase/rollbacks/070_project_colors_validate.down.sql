-- Rollback for 070_project_colors_validate.sql: puts 069's two colour CHECKs
-- back to NOT VALID (the state 069 leaves), by dropping and re-adding each one
-- NOT VALID in one transaction. Catalog-only (no scan); ACCESS EXCLUSIVE is
-- held only for that moment. The CHECKs keep applying to every new or changed
-- row. No data changes.
--
-- Only needed to go back to the state between 069 and 070: 069's own rollback
-- drops the CHECKs whether or not they are validated. Once 069 is rolled back
-- this does nothing. Re-running is safe.
--
-- Busy tables: a table that stays busy past 10s makes this fail cleanly (55P03),
-- nothing changes, and it can simply be re-run.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.implementations'::regclass
      AND conname = 'implementations_color_hex_check'
      AND convalidated
  ) THEN
    ALTER TABLE implementations DROP CONSTRAINT implementations_color_hex_check;
    ALTER TABLE implementations
      ADD CONSTRAINT implementations_color_hex_check
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_color_hex_check'
      AND convalidated
  ) THEN
    ALTER TABLE projects DROP CONSTRAINT projects_color_hex_check;
    ALTER TABLE projects
      ADD CONSTRAINT projects_color_hex_check
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
  END IF;
END;
$$;

COMMIT;
