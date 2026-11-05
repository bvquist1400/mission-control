-- 069: project colours (Baseline redesign S2, task b13c2e2d; plan
-- /Users/owner/dev/baseline-plans/redesign/PLAN.md row S2; spec
-- grocery-design-mockups/baseline-redesign/NOTES.md D2 "Editable project
-- colours" and D3 project colours).
--
-- Each application (implementations) and project may carry its own colour for
-- the small project square shown on cards, rows, lanes and the project and
-- application pages. NULL means "the theme's default for that slot": the app
-- computes it (src/lib/project-colors.ts: the D3 light/dark pair for M&M,
-- FamCal, Baseline, OvenLineup, Home, Move and Work, a fixed pick for any other
-- name), so one stored list serves both themes.
--
-- Stored form: "#RRGGBB" (the API writes upper case). The CHECK only pins the
-- shape; the API and MCP also refuse yellow/gold (kept for "needs you") and a
-- colour that doesn't read on the light paper, and the app ignores a stored
-- value it would refuse (it shows the default instead), so a hand-written SQL
-- value can never paint a square marigold.
--
-- Additive only, NO BACKFILL: two nullable columns with no default, so ADD
-- COLUMN is catalog-only (no table rewrite) and every existing row reads NULL
-- (= its default colour, exactly what the app showed before). Re-running is safe.
--
-- Locks (S2 fix round 1): ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE
-- on each table, held until COMMIT, so this transaction does only catalog work
-- (no scan of existing rows) and commits straight away. The CHECKs are added
-- NOT VALID: they apply to every new or changed row from this commit on. The
-- scan that marks them valid for the existing rows is 070_project_colors_validate.sql,
-- in its OWN transaction, where VALIDATE CONSTRAINT only takes SHARE UPDATE
-- EXCLUSIVE (readers and writers carry on). Validating here, in the same
-- transaction, would scan while still holding ACCESS EXCLUSIVE.
--
-- Rollback: supabase/rollbacks/069_project_colors.down.sql (drops both columns
-- and their checks, validated or not, so it works with or without 070 applied;
-- chosen colours are lost, nothing else changes).
--
-- Deploy order: 069, then 070, BEFORE the app (the app reads the column;
-- without it the colour list falls back to defaults but saves fail). The app
-- works the same before or after 070. Rolling back needs the app rolled back first.
--
-- This number was earlier pencilled in for the grants-revoke migration; that
-- one moves to 071 (070 is the validation step).

BEGIN;

-- Fail cleanly on a busy table instead of queueing behind a long transaction.
SET LOCAL lock_timeout = '10s';

ALTER TABLE implementations
  ADD COLUMN IF NOT EXISTS color TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS color TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.implementations'::regclass
      AND conname = 'implementations_color_hex_check'
  ) THEN
    ALTER TABLE implementations
      ADD CONSTRAINT implementations_color_hex_check
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_color_hex_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_color_hex_check
      CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
  END IF;
END;
$$;

COMMENT ON COLUMN implementations.color IS
  'Project square colour (069), "#RRGGBB". NULL = the theme default for this application (src/lib/project-colors.ts).';
COMMENT ON COLUMN projects.color IS
  'Project square colour (069), "#RRGGBB". NULL = its application''s colour, else the theme default for this project (src/lib/project-colors.ts).';

COMMIT;

NOTIFY pgrst, 'reload schema';
