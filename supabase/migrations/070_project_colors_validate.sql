-- 070: validate 069's colour CHECKs (Baseline redesign S2 fix round 1, task
-- b13c2e2d; Codex review finding on 069's locks).
--
-- 069 adds implementations.color / projects.color and their CHECKs NOT VALID in
-- a short catalog-only transaction (ACCESS EXCLUSIVE, released at its COMMIT).
-- This file is the second phase: VALIDATE CONSTRAINT scans the existing rows
-- under SHARE UPDATE EXCLUSIVE only, which does not block SELECT, INSERT,
-- UPDATE or DELETE, and it runs in its own transaction (its own file: the
-- Supabase CLI applies each file as one batch, so a separate file is what
-- guarantees a separate transaction whatever runs it).
--
-- Every existing value is NULL (069 does not backfill) or was written through
-- the CHECK since 069, so this cannot fail on data; it only records that fact.
-- lock_timeout keeps a long transaction holding a conflicting lock (another
-- ALTER, a VACUUM FULL) from queueing this one for long: it fails cleanly
-- (55P03), nothing changes, and it can be re-run.
--
-- Re-running is safe: validating an already valid constraint does nothing.
-- Needs 069 first (fails with a plain message otherwise).
--
-- Rollback: supabase/rollbacks/070_project_colors_validate.down.sql (marks the
-- CHECKs NOT VALID again; they keep applying to new rows).

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.implementations'::regclass
      AND conname = 'implementations_color_hex_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_color_hex_check'
  ) THEN
    RAISE EXCEPTION '070 needs 069 (project colours) applied first';
  END IF;
END;
$$;

ALTER TABLE implementations VALIDATE CONSTRAINT implementations_color_hex_check;
ALTER TABLE projects VALIDATE CONSTRAINT projects_color_hex_check;

COMMIT;
