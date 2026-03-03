-- Split project execution stage from application lifecycle phase.
-- Keeps legacy projects.phase in place temporarily while the app migrates to projects.stage.

BEGIN;

DO $$
BEGIN
  CREATE TYPE project_stage AS ENUM (
    'Proposed',
    'Planned',
    'Ready',
    'In Progress',
    'Blocked',
    'Review',
    'Done',
    'On Hold',
    'Cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS stage project_stage;

UPDATE projects
SET stage = (
  CASE phase
    WHEN 'Intake' THEN 'Proposed'
    WHEN 'Discovery' THEN 'Planned'
    WHEN 'Design' THEN 'Ready'
    WHEN 'Build' THEN 'In Progress'
    WHEN 'Test' THEN 'Review'
    WHEN 'Training' THEN 'Review'
    WHEN 'GoLive' THEN 'Done'
    WHEN 'Hypercare' THEN 'Done'
    WHEN 'Steady State' THEN 'On Hold'
    WHEN 'Sundown' THEN 'Cancelled'
    ELSE 'Planned'
  END
)::project_stage
WHERE stage IS NULL;

ALTER TABLE projects
  ALTER COLUMN stage SET DEFAULT 'Planned'::project_stage;

UPDATE projects
SET stage = 'Planned'::project_stage
WHERE stage IS NULL;

ALTER TABLE projects
  ALTER COLUMN stage SET NOT NULL;

COMMIT;
