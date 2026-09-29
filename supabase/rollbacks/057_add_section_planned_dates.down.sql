ALTER TABLE project_sections
  DROP CONSTRAINT IF EXISTS project_sections_planned_range_check,
  DROP COLUMN IF EXISTS planned_end,
  DROP COLUMN IF EXISTS planned_start;
