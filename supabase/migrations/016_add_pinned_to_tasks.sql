-- Migration 016: add pinned tasks + atomic today sync function

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION sync_today_tasks(
  p_user_id UUID,
  p_task_ids UUID[],
  p_today DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  promoted INT,
  demoted INT,
  skipped_pinned INT,
  sync_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  promoted_count INT := 0;
  demoted_count INT := 0;
  skipped_pinned_count INT := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_task_ids IS NULL OR cardinality(p_task_ids) = 0 THEN
    RAISE EXCEPTION 'task_ids is required and must be a non-empty array';
  END IF;

  IF cardinality(p_task_ids) > 20 THEN
    RAISE EXCEPTION 'task_ids cannot exceed 20 items';
  END IF;

  SELECT COUNT(*)
  INTO skipped_pinned_count
  FROM tasks
  WHERE user_id = p_user_id
    AND status = 'Planned'
    AND pinned = true
    AND NOT (id = ANY(p_task_ids));

  WITH promoted_rows AS (
    UPDATE tasks
    SET status = 'Planned',
        due_at = COALESCE(due_at, p_today::timestamptz)
    WHERE user_id = p_user_id
      AND id = ANY(p_task_ids)
    RETURNING id
  )
  SELECT COUNT(*) INTO promoted_count FROM promoted_rows;

  WITH demoted_rows AS (
    UPDATE tasks
    SET status = 'Backlog'
    WHERE user_id = p_user_id
      AND status = 'Planned'
      AND pinned = false
      AND NOT (id = ANY(p_task_ids))
    RETURNING id
  )
  SELECT COUNT(*) INTO demoted_count FROM demoted_rows;

  RETURN QUERY
  SELECT promoted_count, demoted_count, skipped_pinned_count, now();
END;
$$;

COMMIT;
