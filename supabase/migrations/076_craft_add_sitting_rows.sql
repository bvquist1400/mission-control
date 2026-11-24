-- Craft estimates E3 (Baseline f98e79da, Brent 11/24 "One step, DB update"): add rows to a sitting already
-- logged, in ONE transaction.
--
-- Function only: one new function, craft_add_sitting_rows. No table, column, index, policy, trigger or data
-- change, and no existing function is replaced, so an app without it keeps working exactly as before.
--
-- craft_add_sitting_rows(user, project, session, part, expected_row, from_row, to_row): rows from–to of the part
-- become finished rows of a sitting already logged in this project. In one call it
--  1. locks the sitting FOR UPDATE (work_session_update's and craft_frog's order: the sitting first), then every
--     task of the project FOR NO KEY UPDATE in id order (059's protocol; the sitting's own task is among them),
--     then craft_part_lock (the part's tasks again, already held, then the craft project, then the part), then
--     the picked rows FOR UPDATE in id order;
--  2. refuses (raises, so nothing is written) a stale count, no rows in from–to, a row another sitting finished
--     (a row partway in another sitting is fine, as in craft_save_sitting), and unticked rows before `from` when
--     some of the picked rows must be ticked (Fix count would tick those too). Refusals are SQLSTATE MC076 with
--     the reason as the message and the rows (or the current row) as DETAIL;
--  3. ticks the unticked picked rows (completed_at from the 059 trigger), clears a stored quarter that no longer
--     sits on the current row (as craft_rows does), and links the rows to the sitting through work_session_update
--     (its finished links plus the new ones; p_changes empty, so minutes, date, times, task and the left-out flag
--     never change; a row partway in this sitting becomes finished; its other in-progress links stay).
-- Holding the task locks before reading links means no other session writer (they all lock the rows' tasks first)
-- can finish one of these rows in between. SECURITY INVOKER like every craft write (RLS on), lock_timeout 5s.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION craft_add_sitting_rows(
  p_user_id UUID,
  p_project_id UUID,
  p_session_id UUID,
  p_part_id UUID,
  p_expected_row INTEGER,
  p_from_row INTEGER,
  p_to_row INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_session work_sessions%ROWTYPE;
  v_part craft_parts%ROWTYPE;
  v_cur INTEGER;
  v_new INTEGER;
  v_rows INTEGER[];
  v_other INTEGER[];
  v_unticked INTEGER[];
  v_earlier INTEGER[];
  v_ticked INTEGER[] := '{}';
  v_have UUID[];
  v_add UUID[];
  v_added INTEGER[];
  v_already INTEGER[];
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL OR p_session_id IS NULL OR p_part_id IS NULL OR p_expected_row IS NULL OR p_from_row IS NULL OR p_to_row IS NULL THEN
    RAISE EXCEPTION 'project, sitting, part, expected row and rows from–to are required' USING ERRCODE = '22023';
  END IF;
  IF p_from_row < 1 OR p_to_row < p_from_row OR p_to_row - p_from_row + 1 > 2000 THEN
    RAISE EXCEPTION 'rows must run from 1 up, at most 2000 at a time' USING ERRCODE = '22023';
  END IF;

  -- 1. Locks: the sitting, every task of the project in id order, the part (its tasks, craft project, part), the rows.
  SELECT * INTO v_session FROM work_sessions
    WHERE id = p_session_id AND user_id = p_user_id AND project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_SITTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id AND project_id = p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM work_sessions_lock_tasks(p_user_id, ARRAY(SELECT id FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id));
  v_part := craft_part_lock(p_user_id, p_part_id);
  PERFORM 1 FROM task_checklist_items
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row BETWEEN p_from_row AND p_to_row AND craft_row <= v_part.total_rows
    ORDER BY id FOR UPDATE;

  -- 2. Refusals (each raises: nothing is written).
  v_cur := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  IF v_cur <> p_expected_row THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'MC076', DETAIL = v_cur::text;
  END IF;
  SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_rows FROM task_checklist_items
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row BETWEEN p_from_row AND p_to_row AND craft_row <= v_part.total_rows;
  IF cardinality(v_rows) = 0 THEN
    RAISE EXCEPTION 'no_rows' USING ERRCODE = 'MC076', DETAIL = '';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT i.craft_row ORDER BY i.craft_row), '{}') INTO v_other
    FROM task_checklist_items i JOIN work_session_items w ON w.checklist_item_id = i.id AND w.user_id = p_user_id
    WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.craft_row = ANY (v_rows)
      AND NOT w.in_progress AND w.session_id <> p_session_id;
  IF cardinality(v_other) > 0 THEN
    RAISE EXCEPTION 'in_sitting' USING ERRCODE = 'MC076', DETAIL = array_to_string(v_other, ',');
  END IF;
  SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_unticked FROM task_checklist_items
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = ANY (v_rows) AND NOT is_done;
  IF cardinality(v_unticked) > 0 THEN
    SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_earlier FROM task_checklist_items
      WHERE craft_part_id = p_part_id AND user_id = p_user_id AND NOT is_done AND craft_row < p_from_row AND craft_row <= v_part.total_rows;
    IF cardinality(v_earlier) > 0 THEN
      RAISE EXCEPTION 'earlier' USING ERRCODE = 'MC076', DETAIL = array_to_string(v_earlier, ',');
    END IF;
  END IF;

  -- 3. Tick, then link through the session write path (one transaction with the ticks).
  WITH u AS (
    UPDATE task_checklist_items SET is_done = true
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = ANY (v_unticked) AND NOT is_done
    RETURNING craft_row
  ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_ticked FROM u;
  v_new := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  IF (v_part.quarter <> 0 OR v_part.quarter_row IS NOT NULL) AND v_part.quarter_row IS DISTINCT FROM v_new THEN
    UPDATE craft_parts SET quarter = 0, quarter_row = NULL WHERE id = p_part_id AND user_id = p_user_id;
  END IF;

  SELECT COALESCE(array_agg(checklist_item_id), '{}') INTO v_have FROM work_session_items
    WHERE session_id = p_session_id AND user_id = p_user_id AND NOT in_progress;
  SELECT COALESCE(array_agg(id ORDER BY craft_row), '{}'), COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_add, v_added
    FROM task_checklist_items
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = ANY (v_rows) AND NOT (id = ANY (v_have));
  SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_already FROM task_checklist_items
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = ANY (v_rows) AND id = ANY (v_have);
  IF cardinality(v_add) > 0 THEN
    PERFORM work_session_update(p_user_id, p_session_id, '{}'::jsonb, v_have || v_add);
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'session_id', p_session_id, 'part_id', p_part_id,
    'session_date', v_session.session_date, 'minutes', v_session.minutes, 'current_row', v_new,
    'ticked', to_jsonb(v_ticked), 'added', to_jsonb(v_added), 'already', to_jsonb(v_already));
END;
$$;

REVOKE ALL ON FUNCTION craft_add_sitting_rows(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_add_sitting_rows(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER) TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
