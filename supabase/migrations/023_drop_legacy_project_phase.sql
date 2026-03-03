-- Remove legacy project lifecycle phase after project stage rollout.

ALTER TABLE projects
  DROP COLUMN IF EXISTS phase;
