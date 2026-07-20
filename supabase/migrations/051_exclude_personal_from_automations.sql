-- A project can be marked personal as well as its tasks. Automated work
-- surfaces must treat either tag as an exclusion.
BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_projects_tags_gin ON projects USING GIN (tags);

DROP FUNCTION IF EXISTS sync_today_tasks(UUID, UUID[], DATE);

CREATE FUNCTION sync_today_tasks(
  p_user_id UUID,
  p_task_ids UUID[],
  p_today DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  promoted INT,
  demoted INT,
  skipped_pinned INT,
  skipped_in_progress INT,
  skipped_ineligible INT,
  skipped_personal INT,
  sync_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  promoted_count INT := 0;
  demoted_count INT := 0;
  skipped_pinned_count INT := 0;
  skipped_in_progress_count INT := 0;
  skipped_ineligible_count INT := 0;
  skipped_personal_count INT := 0;
  default_due_at TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;
  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN RAISE EXCEPTION 'task_ids is required and must be a non-empty array'; END IF;
  IF cardinality(p_task_ids) > 20 THEN RAISE EXCEPTION 'task_ids cannot exceed 20 items'; END IF;

  default_due_at := (p_today::timestamp + interval '23 hours 59 minutes') AT TIME ZONE 'America/New_York';

  SELECT COUNT(*) INTO skipped_pinned_count FROM tasks t
  WHERE t.user_id = p_user_id AND t.status = 'Planned' AND t.pinned = true AND NOT (t.id = ANY(p_task_ids));
  SELECT COUNT(*) INTO skipped_in_progress_count FROM tasks t
  WHERE t.user_id = p_user_id AND t.status = 'In Progress' AND t.id = ANY(p_task_ids);
  SELECT COUNT(*) INTO skipped_ineligible_count FROM tasks t
  WHERE t.user_id = p_user_id AND t.status IN ('Done', 'Parked', 'Blocked/Waiting') AND t.id = ANY(p_task_ids);
  SELECT COUNT(*) INTO skipped_personal_count FROM tasks t
  WHERE t.user_id = p_user_id AND t.id = ANY(p_task_ids)
    AND (t.tags @> ARRAY['personal'] OR EXISTS (
      SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.user_id = p_user_id AND p.tags @> ARRAY['personal']
    ));

  WITH promoted_rows AS (
    UPDATE tasks t SET status = 'Planned', due_at = COALESCE(t.due_at, default_due_at)
    WHERE t.user_id = p_user_id AND t.id = ANY(p_task_ids) AND t.status = 'Backlog'
      AND NOT (t.tags @> ARRAY['personal'] OR EXISTS (
        SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.user_id = p_user_id AND p.tags @> ARRAY['personal']
      ))
    RETURNING t.id
  ), promoted_transitions AS (
    INSERT INTO task_status_transitions (user_id, task_id, from_status, to_status)
    SELECT p_user_id, id, 'Backlog', 'Planned' FROM promoted_rows
  ) SELECT COUNT(*) INTO promoted_count FROM promoted_rows;

  WITH demoted_rows AS (
    UPDATE tasks t SET status = 'Backlog'
    WHERE t.user_id = p_user_id AND t.status = 'Planned' AND t.pinned = false AND NOT (t.id = ANY(p_task_ids))
      AND NOT (t.tags @> ARRAY['personal'] OR EXISTS (
        SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.user_id = p_user_id AND p.tags @> ARRAY['personal']
      ))
    RETURNING t.id
  ), demoted_transitions AS (
    INSERT INTO task_status_transitions (user_id, task_id, from_status, to_status)
    SELECT p_user_id, id, 'Planned', 'Backlog' FROM demoted_rows
  ) SELECT COUNT(*) INTO demoted_count FROM demoted_rows;

  RETURN QUERY SELECT promoted_count, demoted_count, skipped_pinned_count, skipped_in_progress_count,
    skipped_ineligible_count, skipped_personal_count, now();
END;
$$;

COMMIT;
