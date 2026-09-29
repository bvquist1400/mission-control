-- Planned dates for project sections (Portfolio slice 2): when a section (a
-- release, a batch of pins…) is planned to start and end, drawn solid on the
-- Portfolio timeline. Without them the timeline estimates from task dates and
-- draws the bar dashed.
--
-- Timeline only. Nothing else reads these columns: they never change a task's
-- due date, overdue state, priority, the briefs, Today or the AM/EOD routines.
--
-- Additive only: both columns are nullable with no default, so existing rows
-- and every existing insert are unchanged, and ADD COLUMN is catalog-only.
ALTER TABLE project_sections
  ADD COLUMN IF NOT EXISTS planned_start DATE,
  ADD COLUMN IF NOT EXISTS planned_end DATE;

ALTER TABLE project_sections
  DROP CONSTRAINT IF EXISTS project_sections_planned_range_check;

-- Either date may be set alone; when both are set the end can't be before the start.
ALTER TABLE project_sections
  ADD CONSTRAINT project_sections_planned_range_check
    CHECK (planned_start IS NULL OR planned_end IS NULL OR planned_end >= planned_start);
