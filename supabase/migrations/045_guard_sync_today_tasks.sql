-- Migration 045: guard sync_today_tasks against status stomping
--
-- The previous version promoted ANY listed task to 'Planned' regardless of
-- current status: it reset In Progress work to Planned, resurrected Done and
-- Parked tasks, and stamped missing due_at values with midnight UTC (≈8pm ET
-- the previous evening, so promoted tasks were born overdue). It also bypassed
-- the task_status_transitions log, leaving holes in status history.
--
-- New behavior:
--   * Only Backlog tasks are promoted to Planned (Planned stays Planned).
--   * In Progress tasks in the list are left untouched (skipped_in_progress).
--   * Done / Parked / Blocked-Waiting tasks in the list are never modified
--     (skipped_ineligible).
--   * Default due_at for promoted tasks is 11:59pm ET on the sync date.
--   * Promotions and demotions are recorded in task_status_transitions.

BEGIN;

-- Return type changes, so the old function must be dropped first.
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
  default_due_at TIMESTAMPTZ;
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

  -- 11:59pm ET on the sync date, expressed as an absolute timestamp.
  default_due_at := (p_today::timestamp + interval '23 hours 59 minutes')
    AT TIME ZONE 'America/New_York';

  SELECT COUNT(*)
  INTO skipped_pinned_count
  FROM tasks
  WHERE user_id = p_user_id
    AND status = 'Planned'
    AND pinned = true
    AND NOT (id = ANY(p_task_ids));

  SELECT COUNT(*)
  INTO skipped_in_progress_count
  FROM tasks
  WHERE user_id = p_user_id
    AND status = 'In Progress'
    AND id = ANY(p_task_ids);

  SELECT COUNT(*)
  INTO skipped_ineligible_count
  FROM tasks
  WHERE user_id = p_user_id
    AND status IN ('Done', 'Parked', 'Blocked/Waiting')
    AND id = ANY(p_task_ids);

  WITH promoted_rows AS (
    UPDATE tasks
    SET status = 'Planned',
        due_at = COALESCE(due_at, default_due_at)
    WHERE user_id = p_user_id
      AND id = ANY(p_task_ids)
      AND status = 'Backlog'
    RETURNING id
  ), promoted_transitions AS (
    INSERT INTO task_status_transitions (user_id, task_id, from_status, to_status)
    SELECT p_user_id, id, 'Backlog', 'Planned' FROM promoted_rows
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
  ), demoted_transitions AS (
    INSERT INTO task_status_transitions (user_id, task_id, from_status, to_status)
    SELECT p_user_id, id, 'Planned', 'Backlog' FROM demoted_rows
  )
  SELECT COUNT(*) INTO demoted_count FROM demoted_rows;

  RETURN QUERY
  SELECT
    promoted_count,
    demoted_count,
    skipped_pinned_count,
    skipped_in_progress_count,
    skipped_ineligible_count,
    now();
END;
$$;

COMMIT;
