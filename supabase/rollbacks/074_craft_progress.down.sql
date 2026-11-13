-- Removes only 074: craft_frogs (the "Ripped back" history), work_session_items.in_progress,
-- craft_timers.last_done_seconds (FR1; a running timer keeps going, only the Partway hint goes) and the
-- seven new functions (FR3: craft_screen_part, craft_check, craft_pick_part and the 7-argument
-- craft_set_total), and puts back 073's 4-argument craft_set_total (and its grants), craft_timer, craft_rows,
-- craft_log_sitting and craft_remove_blockers and
-- 059's work_session_create and work_session_update exactly as they were written (CREATE OR REPLACE
-- keeps their grants). Roll the app back first: the S3 screen calls craft_save_sitting and craft_frog.
-- In-progress links are deleted (those minutes fall back out of speed, as before 074); sittings a
-- rip-back left out of speed stay left out, with their reason, and ripped rows stay unticked.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION craft_frog(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID[], TEXT);
-- FR3: the check card's and "Work on this part"'s functions, 074's Change total (7 arguments, FR4) and the screen-part
-- rule go; 073's 4-argument craft_set_total (with its grants) and craft_timer are put back as written in 073.
DROP FUNCTION craft_pick_part(UUID, UUID, UUID);
DROP FUNCTION craft_check(UUID, UUID, UUID[]);
DROP FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT);
CREATE FUNCTION craft_set_total(p_user_id UUID, p_part_id UUID, p_total INTEGER, p_expected_total INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_part craft_parts%ROWTYPE;
  v_last RECORD;
  v_word TEXT;
  v_sort INTEGER;
  v_rows INTEGER[];
  v_added INTEGER := 0;
  v_removed INTEGER := 0;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_part_id IS NULL OR p_total IS NULL OR p_expected_total IS NULL THEN
    RAISE EXCEPTION 'part id, total and expected total are required' USING ERRCODE = '22023';
  END IF;
  IF p_total NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'total must be 1 to 2000' USING ERRCODE = '22023';
  END IF;
  v_part := craft_part_lock(p_user_id, p_part_id);
  IF v_part.total_rows <> p_expected_total THEN
    RETURN jsonb_build_object('status', 'stale', 'part_id', p_part_id, 'total', v_part.total_rows);
  END IF;
  IF p_total = v_part.total_rows THEN
    RETURN jsonb_build_object('status', 'ok', 'part_id', p_part_id, 'total', p_total, 'added', 0, 'removed', 0);
  END IF;

  IF p_total > v_part.total_rows THEN
    SELECT i.id, i.task_id, i.text, i.work_type, i.unit_count, i.craft_row INTO v_last FROM task_checklist_items i
      WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id ORDER BY i.craft_row DESC LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'no_rows', 'part_id', p_part_id, 'total', v_part.total_rows);
    END IF;
    v_word := COALESCE((regexp_match(v_last.text, '^(Row|Rnd|Round)[ \t]+[0-9]'))[1], CASE WHEN v_part.row_word = 'round' THEN 'Round' ELSE 'Row' END);
    SELECT COALESCE(max(sort_order), 0) INTO v_sort FROM task_checklist_items WHERE task_id = v_last.task_id AND user_id = p_user_id;
    INSERT INTO task_checklist_items (user_id, task_id, text, is_done, sort_order, unit_count, work_type, craft_part_id, craft_row)
    SELECT p_user_id, v_last.task_id, v_word || ' ' || n, false, v_sort + (n - v_part.total_rows), COALESCE(v_part.stitch_count, v_last.unit_count), v_last.work_type, p_part_id, n
      FROM generate_series(v_part.total_rows + 1, p_total) AS n;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    UPDATE craft_segments SET to_row = p_total
      WHERE id = (SELECT id FROM craft_segments WHERE part_id = p_part_id AND user_id = p_user_id AND to_row >= v_last.craft_row
                  ORDER BY to_row DESC, sort_order DESC, id DESC LIMIT 1);
  ELSE
    SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_rows FROM task_checklist_items
      WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > p_total AND is_done;
    IF cardinality(v_rows) > 0 THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'ticked', 'rows', to_jsonb(v_rows), 'part_id', p_part_id, 'total', v_part.total_rows);
    END IF;
    SELECT COALESCE(array_agg(i.craft_row ORDER BY i.craft_row), '{}') INTO v_rows FROM task_checklist_items i
      WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.craft_row > p_total
        AND EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id);
    IF cardinality(v_rows) > 0 THEN
      RETURN jsonb_build_object('status', 'refused', 'reason', 'in_sitting', 'rows', to_jsonb(v_rows), 'part_id', p_part_id, 'total', v_part.total_rows);
    END IF;
    DELETE FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > p_total;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    PERFORM 1 FROM craft_segments WHERE part_id = p_part_id AND user_id = p_user_id ORDER BY id FOR UPDATE;
    DELETE FROM craft_segments WHERE part_id = p_part_id AND user_id = p_user_id AND from_row > p_total;
    UPDATE craft_segments SET to_row = p_total WHERE part_id = p_part_id AND user_id = p_user_id AND to_row > p_total;
  END IF;
  UPDATE craft_parts SET total_rows = p_total,
    quarter = CASE WHEN v_part.quarter_row > p_total THEN 0 ELSE quarter END,
    quarter_row = CASE WHEN v_part.quarter_row > p_total THEN NULL ELSE quarter_row END
  WHERE id = p_part_id AND user_id = p_user_id;
  RETURN jsonb_build_object('status', 'ok', 'part_id', p_part_id, 'total', p_total, 'previous_total', v_part.total_rows,
    'added', v_added, 'removed', v_removed, 'current_row', craft_current_row(p_user_id, p_part_id, p_total));
END;
$$;
REVOKE ALL ON FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER) TO authenticated, service_role;
CREATE OR REPLACE FUNCTION craft_timer(p_user_id UUID, p_action TEXT, p_project_id UUID, p_part_id UUID DEFAULT NULL,
  p_minutes INTEGER DEFAULT NULL, p_expected_version INTEGER DEFAULT NULL, p_force BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_t craft_timers%ROWTYPE;
  v_found BOOLEAN;
  v_part craft_parts%ROWTYPE;
  v_active UUID;
  v_now TIMESTAMPTZ;
  v_action TEXT := p_action;
  v_elapsed INTEGER;
  v_stop TIMESTAMPTZ;
  v_row INTEGER;
  v_name TEXT;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL OR p_action IS NULL
     OR p_action NOT IN ('start', 'pause', 'resume', 'toggle', 'discard', 'adjust', 'stopped_ago') THEN
    RAISE EXCEPTION 'project id and an action (start, pause, resume, toggle, discard, adjust, stopped_ago) are required' USING ERRCODE = '22023';
  END IF;
  SELECT active_part_id INTO v_active FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PROJECT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_part_id IS NOT NULL THEN
    SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND project_id = p_project_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  SELECT * INTO v_t FROM craft_timers WHERE user_id = p_user_id FOR UPDATE;
  v_found := FOUND;
  v_now := clock_timestamp();

  IF v_action = 'toggle' THEN
    v_action := CASE WHEN NOT v_found OR v_t.project_id <> p_project_id THEN 'start'
      WHEN v_t.running_since IS NOT NULL THEN 'pause' ELSE 'resume' END;
  END IF;
  -- An explicit start on this project's paused timer is a resume.
  IF v_action = 'start' AND v_found AND v_t.project_id = p_project_id THEN
    IF v_t.running_since IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'ok', 'action', v_action, 'server_now', v_now,
        'timer', craft_timer_state(v_t.user_id, v_now));
    END IF;
    v_action := 'resume';
  ELSIF v_action <> 'start' THEN
    -- Changes to an existing timer: it must be this project's, at the version the screen saw.
    IF NOT v_found OR v_t.project_id <> p_project_id THEN
      IF v_action = 'discard' THEN
        RETURN jsonb_build_object('status', 'ok', 'action', v_action, 'server_now', v_now, 'timer', NULL);
      END IF;
      RETURN jsonb_build_object('status', 'none', 'action', v_action, 'server_now', v_now, 'timer', NULL);
    END IF;
    IF p_expected_version IS DISTINCT FROM v_t.version THEN
      RETURN jsonb_build_object('status', 'stale', 'action', v_action, 'server_now', v_now,
        'timer', craft_timer_state(v_t.user_id, v_now));
    END IF;
  END IF;

  IF v_action = 'start' THEN
    IF v_found THEN
      v_elapsed := craft_timer_elapsed(v_t.banked_seconds, v_t.adjust_seconds, v_t.running_since, v_now);
      IF v_elapsed > 0 THEN
        SELECT name INTO v_name FROM projects WHERE id = v_t.project_id AND user_id = p_user_id;
        RETURN jsonb_build_object('status', 'conflict', 'action', v_action, 'server_now', v_now, 'timer', NULL,
          'other', jsonb_build_object('project_id', v_t.project_id, 'project_name', v_name, 'elapsed_seconds', v_elapsed,
            'version', v_t.version, 'running', v_t.running_since IS NOT NULL));
      END IF;
      DELETE FROM craft_timers WHERE user_id = p_user_id;
    END IF;
    IF p_part_id IS NULL THEN
      SELECT * INTO v_part FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id
        ORDER BY (id = v_active) DESC, sort_order, id LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'this project has no craft parts' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_row := craft_current_row(p_user_id, v_part.id, v_part.total_rows);
    INSERT INTO craft_timers (user_id, project_id, part_id, sitting_started_at, running_since, paused_at, banked_seconds,
      adjust_seconds, start_row, start_quarter, version)
    VALUES (p_user_id, p_project_id, v_part.id, v_now, v_now, NULL, 0, 0, LEAST(v_row, v_part.total_rows),
      CASE WHEN v_part.quarters AND v_part.quarter_row = v_row THEN v_part.quarter ELSE 0 END, 1)
    ON CONFLICT (user_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'stale', 'action', v_action, 'server_now', v_now, 'timer', craft_timer_state(p_user_id, v_now));
    END IF;
  ELSIF v_action = 'pause' THEN
    IF v_t.running_since IS NOT NULL THEN
      UPDATE craft_timers SET banked_seconds = banked_seconds + GREATEST(0, floor(extract(epoch FROM v_now - running_since)))::int,
        running_since = NULL, paused_at = v_now, version = version + 1
      WHERE user_id = p_user_id;
    END IF;
  ELSIF v_action = 'resume' THEN
    IF v_t.running_since IS NULL THEN
      IF (v_now AT TIME ZONE 'America/New_York')::date > (v_t.sitting_started_at AT TIME ZONE 'America/New_York')::date AND NOT COALESCE(p_force, false) THEN
        RETURN jsonb_build_object('status', 'new_day', 'action', v_action, 'server_now', v_now,
          'started_on', (v_t.sitting_started_at AT TIME ZONE 'America/New_York')::date, 'timer', craft_timer_state(p_user_id, v_now));
      END IF;
      UPDATE craft_timers SET running_since = v_now, paused_at = NULL, version = version + 1 WHERE user_id = p_user_id;
    END IF;
  ELSIF v_action = 'discard' THEN
    DELETE FROM craft_timers WHERE user_id = p_user_id;
  ELSIF v_action = 'adjust' THEN
    IF p_minutes IS NULL OR p_minutes = 0 OR p_minutes NOT BETWEEN -1440 AND 1440 THEN
      RAISE EXCEPTION 'minutes to add or take off must be a whole number from -1440 to 1440, not 0' USING ERRCODE = '22023';
    END IF;
    IF craft_timer_elapsed(v_t.banked_seconds, v_t.adjust_seconds, v_t.running_since, v_now) + p_minutes * 60 < 0 THEN
      RAISE EXCEPTION 'That takes off more time than the timer shows' USING ERRCODE = '22023';
    END IF;
    UPDATE craft_timers SET adjust_seconds = adjust_seconds + p_minutes * 60, version = version + 1 WHERE user_id = p_user_id;
  ELSIF v_action = 'stopped_ago' THEN
    IF v_t.running_since IS NULL THEN
      RETURN jsonb_build_object('status', 'not_running', 'action', v_action, 'server_now', v_now, 'timer', craft_timer_state(p_user_id, v_now));
    END IF;
    IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND 1440 THEN
      RAISE EXCEPTION 'minutes ago must be a whole number from 1 to 1440' USING ERRCODE = '22023';
    END IF;
    v_stop := v_now - make_interval(mins => p_minutes);
    IF v_stop < v_t.running_since THEN
      RAISE EXCEPTION 'The timer has only run % min since it was last started', floor(extract(epoch FROM v_now - v_t.running_since) / 60)::int
        USING ERRCODE = '22023';
    END IF;
    UPDATE craft_timers SET banked_seconds = banked_seconds + GREATEST(0, floor(extract(epoch FROM v_stop - running_since)))::int,
      running_since = NULL, paused_at = v_stop, version = version + 1
    WHERE user_id = p_user_id;
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'action', v_action, 'server_now', v_now, 'timer', craft_timer_state(p_user_id, v_now));
END;
$$;
DROP FUNCTION craft_screen_part(UUID, UUID);
CREATE OR REPLACE FUNCTION craft_log_sitting(p_user_id UUID, p_part_id UUID, p_use_timer BOOLEAN, p_timer_version INTEGER, p_minutes INTEGER,
  p_date DATE, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_from_row INTEGER, p_to_row INTEGER, p_to_quarter INTEGER,
  p_expected_row INTEGER, p_note TEXT, p_idempotency_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  c_tz CONSTANT TEXT := 'America/New_York';
  v_ref TEXT;
  v_existing RECORD;
  v_part craft_parts%ROWTYPE;
  v_tpart craft_parts%ROWTYPE;
  v_seen_part UUID;
  v_cross BOOLEAN := false;
  v_lock_tasks UUID[];
  v_t craft_timers%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_today DATE;
  v_cur INTEGER;
  v_minutes INTEGER;
  v_raw_minutes INTEGER := NULL;
  v_span NUMERIC;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_date DATE;
  v_from INTEGER;
  v_first_new INTEGER;
  v_from_quarter INTEGER := 0;
  v_quarter INTEGER := COALESCE(p_to_quarter, 0);
  v_other UUID[] := '{}';
  v_other_rows JSONB := '[]'::jsonb;
  v_links UUID[];
  v_task UUID;
  v_tasks UUID[];
  v_created JSONB;
  v_session UUID;
  v_ticked INTEGER[];
  v_unticked INTEGER[];
  v_note TEXT := NULLIF(btrim(p_note), '');
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_part_id IS NULL OR p_use_timer IS NULL OR p_to_row IS NULL OR p_expected_row IS NULL THEN
    RAISE EXCEPTION 'part id, use_timer, to row and expected row are required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 190 THEN
    RAISE EXCEPTION 'idempotency key must be 1 to 190 characters' USING ERRCODE = '22023';
  END IF;
  IF v_quarter NOT BETWEEN 0 AND 3 THEN
    RAISE EXCEPTION 'quarter must be 0 to 3' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
    RAISE EXCEPTION 'note must be 2000 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF p_minutes IS NOT NULL AND p_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'A sitting is 1 to 1440 minutes' USING ERRCODE = '22023';
  END IF;
  v_ref := 'client:' || btrim(p_idempotency_key);

  -- Locks. With the timer on another part of this project the sitting reaches that part's rows
  -- too, so every part of the project is locked in the same order as craft_part_lock: all their
  -- tasks in id order (059), the craft project, then the parts in id order.
  SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_use_timer THEN
    SELECT part_id INTO v_seen_part FROM craft_timers WHERE user_id = p_user_id AND project_id = v_part.project_id;
    v_cross := v_seen_part IS NOT NULL AND v_seen_part <> p_part_id;
  END IF;
  IF v_cross THEN
    SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_lock_tasks FROM (
      SELECT i.task_id AS x FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
        WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND i.user_id = p_user_id
      UNION
      SELECT s.task_id FROM craft_segments s JOIN craft_parts cp ON cp.id = s.part_id
        WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND s.user_id = p_user_id AND s.task_id IS NOT NULL
    ) s;
    PERFORM work_sessions_lock_tasks(p_user_id, v_lock_tasks);
    PERFORM 1 FROM craft_projects WHERE project_id = v_part.project_id AND user_id = p_user_id FOR NO KEY UPDATE;
    PERFORM 1 FROM craft_parts WHERE project_id = v_part.project_id AND user_id = p_user_id ORDER BY id FOR UPDATE;
    SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
               WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND i.user_id = p_user_id AND NOT (i.task_id = ANY (v_lock_tasks)))
       OR EXISTS (SELECT 1 FROM craft_segments s JOIN craft_parts cp ON cp.id = s.part_id
               WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND s.user_id = p_user_id AND s.task_id IS NOT NULL
                 AND NOT (s.task_id = ANY (v_lock_tasks))) THEN
      RAISE EXCEPTION 'CRAFT_BUSY: the rows changed while saving; try again' USING ERRCODE = '40001';
    END IF;
  ELSE
    v_part := craft_part_lock(p_user_id, p_part_id);
  END IF;

  SELECT id, project_id INTO v_existing FROM work_sessions WHERE user_id = p_user_id AND source_ref = v_ref;
  IF FOUND THEN
    IF v_existing.project_id <> v_part.project_id THEN
      RAISE EXCEPTION 'This idempotency key was already used for a sitting in another project' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('status', 'duplicate', 'session_id', v_existing.id, 'part_id', p_part_id,
      'current_row', craft_current_row(p_user_id, p_part_id, v_part.total_rows));
  END IF;

  v_cur := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  IF p_expected_row <> v_cur THEN
    RETURN jsonb_build_object('status', 'stale', 'part_id', p_part_id, 'current_row', v_cur);
  END IF;
  v_now := clock_timestamp();
  v_today := (v_now AT TIME ZONE c_tz)::date;

  IF p_use_timer THEN
    SELECT * INTO v_t FROM craft_timers WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND OR v_t.project_id <> v_part.project_id THEN
      RETURN jsonb_build_object('status', 'no_timer', 'part_id', p_part_id, 'current_row', v_cur);
    END IF;
    -- A changed version, or a timer that moved to another part since the locks were chosen.
    IF p_timer_version IS DISTINCT FROM v_t.version OR v_t.part_id IS DISTINCT FROM v_seen_part THEN
      RETURN jsonb_build_object('status', 'stale_timer', 'part_id', p_part_id, 'current_row', v_cur,
        'timer', craft_timer_state(p_user_id, v_now));
    END IF;
    v_raw_minutes := round(craft_timer_elapsed(v_t.banked_seconds, 0, v_t.running_since, v_now) / 60.0)::int;
    v_minutes := COALESCE(p_minutes, round(craft_timer_elapsed(v_t.banked_seconds, v_t.adjust_seconds, v_t.running_since, v_now) / 60.0)::int);
    v_end := CASE WHEN v_t.running_since IS NOT NULL THEN v_now ELSE COALESCE(v_t.paused_at, v_now) END;
    v_start := v_t.sitting_started_at - make_interval(secs => GREATEST(0, v_t.adjust_seconds));
    IF v_end <= v_start THEN v_end := v_start + interval '1 minute'; END IF;
    IF v_cross THEN
      SELECT * INTO v_tpart FROM craft_parts WHERE id = v_t.part_id AND user_id = p_user_id AND project_id = v_part.project_id;
      v_cross := FOUND;
    END IF;
    IF v_cross THEN
      -- The timer's part: its rows from the start row, ticked, in no sitting.
      SELECT COALESCE(array_agg(i.id ORDER BY i.craft_row), '{}') INTO v_other FROM task_checklist_items i
        WHERE i.craft_part_id = v_tpart.id AND i.user_id = p_user_id AND i.is_done AND i.craft_row >= v_t.start_row
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id);
      -- The parts between it and this one: rows ticked since the sitting started, in no sitting.
      v_other := v_other || COALESCE((SELECT array_agg(i.id ORDER BY cp.sort_order, cp.id, i.craft_row)
        FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
        WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND i.user_id = p_user_id AND i.is_done
          AND (cp.sort_order, cp.id) > (v_tpart.sort_order, v_tpart.id) AND (cp.sort_order, cp.id) < (v_part.sort_order, v_part.id)
          AND i.completed_at >= v_t.sitting_started_at
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id)), '{}');
      SELECT COALESCE(jsonb_agg(jsonb_build_object('part_id', g.part_id, 'rows', g.rows) ORDER BY g.sort_order, g.part_id), '[]'::jsonb)
        INTO v_other_rows FROM (
          SELECT cp.id AS part_id, cp.sort_order, jsonb_agg(i.craft_row ORDER BY i.craft_row) AS rows
          FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
          WHERE i.id = ANY (v_other) GROUP BY cp.id, cp.sort_order) g;
      -- This part: from the row before its first row ticked since the sitting started.
      SELECT min(i.craft_row) INTO v_first_new FROM task_checklist_items i
        WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.is_done AND i.completed_at >= v_t.sitting_started_at
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id);
      v_from := COALESCE(p_from_row, GREATEST(0, LEAST(p_to_row, v_cur - 1, COALESCE(v_first_new, v_cur) - 1)));
      v_from_quarter := 0;
    ELSE
      v_from := COALESCE(p_from_row, GREATEST(0, LEAST(v_t.start_row - 1, p_to_row)));
      v_from_quarter := CASE WHEN p_from_row IS NULL AND v_t.start_row - 1 <= p_to_row THEN v_t.start_quarter ELSE 0 END;
    END IF;
  ELSE
    IF p_minutes IS NULL THEN
      RAISE EXCEPTION 'minutes are required without the timer' USING ERRCODE = '22023';
    END IF;
    IF p_from_row IS NULL THEN
      RAISE EXCEPTION 'from row is required without the timer' USING ERRCODE = '22023';
    END IF;
    v_minutes := p_minutes;
    v_start := p_started_at;
    v_end := p_ended_at;
    v_from := p_from_row;
    IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_end <= v_start THEN
      RAISE EXCEPTION 'end must be after start' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_minutes IS NULL OR v_minutes < 1 THEN
    RAISE EXCEPTION 'A sitting needs at least 1 minute' USING ERRCODE = '22023';
  END IF;
  IF v_minutes > 1440 THEN
    RAISE EXCEPTION 'A sitting is at most 1440 minutes (24 hours); type the minutes you worked' USING ERRCODE = '22023';
  END IF;
  -- Typed minutes vs start–end: the project page's rule (F0). Less is breaks taken off; more
  -- than start–end + 1 can't be right. The start never moves.
  IF p_minutes IS NOT NULL AND v_start IS NOT NULL AND v_end IS NOT NULL THEN
    v_span := extract(epoch FROM v_end - v_start) / 60.0;
    IF p_minutes - v_span > 1 THEN
      RAISE EXCEPTION 'minutes (%) are more than start–end (% min); minutes can be less (breaks taken off) but not more', p_minutes, round(v_span)
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_end IS NOT NULL AND v_end > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'A sitting can''t end in the future' USING ERRCODE = '22023';
  END IF;
  v_date := COALESCE(CASE WHEN v_start IS NOT NULL THEN (v_start AT TIME ZONE c_tz)::date END, p_date, v_today);
  IF p_date IS NOT NULL AND v_start IS NOT NULL AND p_date <> v_date THEN
    RAISE EXCEPTION 'the date must be the start''s ET day (%)', v_date USING ERRCODE = '22023';
  END IF;
  IF v_date > v_today THEN
    RAISE EXCEPTION 'A sitting can''t be dated after today (%)', v_today USING ERRCODE = '22023';
  END IF;
  IF v_from < 0 OR p_to_row < v_from OR p_to_row > v_part.total_rows THEN
    RAISE EXCEPTION 'rows must go from % up to at most %', GREATEST(v_from, 0), v_part.total_rows USING ERRCODE = '22023';
  END IF;
  IF v_quarter > 0 AND (NOT v_part.quarters OR p_to_row >= v_part.total_rows) THEN
    RAISE EXCEPTION 'a part of a row needs a part with quarters and a next row' USING ERRCODE = '22023';
  END IF;

  -- Rows finished in this sitting; linked unless another sitting already has them.
  SELECT COALESCE(array_agg(i.id ORDER BY i.craft_row), '{}') INTO v_links
    FROM task_checklist_items i
   WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.craft_row > v_from AND i.craft_row <= p_to_row
     AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id);
  v_links := v_other || v_links;
  SELECT COALESCE(array_agg(DISTINCT i.task_id), '{}') INTO v_tasks FROM task_checklist_items i WHERE i.id = ANY (v_links);
  IF cardinality(v_tasks) = 1 THEN
    v_task := v_tasks[1];
  ELSIF cardinality(v_tasks) = 0 THEN
    SELECT task_id INTO v_task FROM craft_segments
      WHERE part_id = p_part_id AND user_id = p_user_id AND LEAST(v_cur, v_part.total_rows) BETWEEN from_row AND to_row
      ORDER BY sort_order, from_row, id LIMIT 1;
  END IF;

  v_created := work_session_create(p_user_id, jsonb_build_object(
    'project_id', v_part.project_id, 'task_id', v_task, 'session_date', v_date, 'started_at', v_start, 'ended_at', v_end,
    'minutes', v_minutes, 'note', v_note, 'source', 'manual', 'source_ref', v_ref), v_links, true);
  v_session := (v_created->>'session_id')::uuid;

  WITH u AS (
    UPDATE task_checklist_items SET is_done = true, completed_at = COALESCE(v_end, v_now)
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > v_from AND craft_row <= p_to_row AND NOT is_done
    RETURNING craft_row
  ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_ticked FROM u;
  WITH u AS (
    UPDATE task_checklist_items SET is_done = false
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > p_to_row AND craft_row < v_cur AND is_done
    RETURNING craft_row
  ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_unticked FROM u;

  -- Every linked row: a row of one of this project's parts, the caller's, ticked.
  IF EXISTS (SELECT 1 FROM unnest(v_links) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
                               WHERE i.id = x.id AND i.user_id = p_user_id AND i.is_done
                                 AND cp.user_id = p_user_id AND cp.project_id = v_part.project_id)) THEN
    RAISE EXCEPTION 'a linked row is not a ticked row of this project' USING ERRCODE = '23503';
  END IF;

  INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, from_quarter, to_row, to_quarter, adjust_minutes)
  VALUES (v_session, p_user_id, p_part_id, v_from, v_from_quarter, p_to_row, v_quarter,
    CASE WHEN v_raw_minutes IS NULL THEN 0 ELSE v_minutes - v_raw_minutes END);

  UPDATE craft_parts SET quarter = v_quarter, quarter_row = CASE WHEN v_quarter > 0 THEN p_to_row + 1 END
    WHERE id = p_part_id AND user_id = p_user_id
      AND (quarter IS DISTINCT FROM v_quarter OR quarter_row IS DISTINCT FROM CASE WHEN v_quarter > 0 THEN p_to_row + 1 END);
  UPDATE craft_projects SET active_part_id = p_part_id
    WHERE project_id = v_part.project_id AND user_id = p_user_id AND active_part_id IS DISTINCT FROM p_part_id;
  IF p_use_timer THEN
    DELETE FROM craft_timers WHERE user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'session_id', v_session, 'part_id', p_part_id, 'project_id', v_part.project_id,
    'session_date', v_date, 'minutes', v_minutes, 'started_at', v_start, 'ended_at', v_end, 'task_id', v_task,
    'rows_linked', cardinality(v_links), 'from_row', v_from, 'other_rows', v_other_rows,
    'ticked', to_jsonb(v_ticked), 'unticked', to_jsonb(v_unticked),
    'previous_row', v_cur, 'current_row', craft_current_row(p_user_id, p_part_id, v_part.total_rows));
END;
$$;
DROP FUNCTION craft_save_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN);
DROP FUNCTION craft_sitting_rows(UUID, UUID, UUID);
CREATE OR REPLACE FUNCTION craft_rows(p_user_id UUID, p_part_id UUID, p_expected_row INTEGER, p_to_row INTEGER, p_mode TEXT, p_segment_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_part craft_parts%ROWTYPE;
  v_seg craft_segments%ROWTYPE;
  v_cur INTEGER;
  v_new INTEGER;
  v_ticked INTEGER[] := '{}';
  v_unticked INTEGER[] := '{}';
  v_check JSONB;
  v_from_status TEXT;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_part_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('done', 'undo', 'fix', 'close') THEN
    RAISE EXCEPTION 'part id and a mode (done, undo, fix, close) are required' USING ERRCODE = '22023';
  END IF;
  IF p_mode <> 'close' AND p_expected_row IS NULL THEN
    RAISE EXCEPTION 'expected row is required' USING ERRCODE = '22023';
  END IF;
  IF p_mode IN ('undo', 'fix') AND p_to_row IS NULL THEN
    RAISE EXCEPTION 'to row is required' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'close' AND p_segment_id IS NULL THEN
    RAISE EXCEPTION 'segment id is required' USING ERRCODE = '22023';
  END IF;

  v_part := craft_part_lock(p_user_id, p_part_id);
  v_cur := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  IF p_expected_row IS NOT NULL AND p_expected_row <> v_cur THEN
    RETURN jsonb_build_object('status', 'stale', 'part_id', p_part_id, 'current_row', v_cur);
  END IF;

  IF p_mode = 'close' THEN
    SELECT * INTO v_seg FROM craft_segments WHERE id = p_segment_id AND part_id = p_part_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CRAFT_SEGMENT_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_seg.close_check OR v_seg.task_id IS NULL THEN
      RAISE EXCEPTION 'this band has no count check' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND NOT is_done
               AND craft_row BETWEEN v_seg.from_row AND v_seg.to_row) THEN
      RETURN jsonb_build_object('status', 'open_rows', 'part_id', p_part_id, 'current_row', v_cur, 'segment_id', v_seg.id);
    END IF;
    v_check := craft_band_check(p_user_id, v_seg.id);
    IF v_check->>'item_id' IS NOT NULL THEN
      UPDATE task_checklist_items SET is_done = true WHERE id = (v_check->>'item_id')::uuid AND user_id = p_user_id AND NOT is_done;
    END IF;
    SELECT status::text INTO v_from_status FROM tasks WHERE id = v_seg.task_id AND user_id = p_user_id;
    UPDATE tasks SET status = 'Done' WHERE id = v_seg.task_id AND user_id = p_user_id AND status <> 'Done';
    RETURN jsonb_build_object('status', 'ok', 'mode', p_mode, 'part_id', p_part_id, 'current_row', v_cur, 'previous_row', v_cur,
      'ticked', '[]'::jsonb, 'unticked', '[]'::jsonb, 'needs_check', NULL, 'closed', jsonb_build_object(
        'segment_id', v_seg.id, 'task_id', v_seg.task_id, 'from_status', v_from_status,
        'count_item_id', v_check->>'item_id', 'count', v_check->'count'));
  END IF;

  IF p_mode = 'done' THEN
    IF v_cur > v_part.total_rows THEN
      RETURN jsonb_build_object('status', 'finished', 'part_id', p_part_id, 'current_row', v_cur);
    END IF;
    UPDATE task_checklist_items SET is_done = true
      WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = v_cur AND NOT is_done;
    v_ticked := ARRAY[v_cur];
    SELECT * INTO v_seg FROM craft_segments
      WHERE part_id = p_part_id AND user_id = p_user_id AND close_check AND v_cur BETWEEN from_row AND to_row
      ORDER BY sort_order, from_row, id LIMIT 1;
    IF FOUND AND v_seg.task_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND NOT is_done
                       AND craft_row BETWEEN v_seg.from_row AND v_seg.to_row) THEN
      v_check := craft_band_check(p_user_id, v_seg.id);
      IF v_check->>'task_status' = 'Done' THEN v_check := NULL; END IF;
    END IF;
  ELSE
    IF p_to_row < 1 OR p_to_row > v_part.total_rows + 1 THEN
      RAISE EXCEPTION 'row % is outside 1 to %', p_to_row, v_part.total_rows + 1 USING ERRCODE = '22023';
    END IF;
    IF p_mode = 'undo' AND p_to_row >= v_cur THEN
      RAISE EXCEPTION 'undo goes back to an earlier row' USING ERRCODE = '22023';
    END IF;
    IF p_to_row > v_cur THEN
      WITH u AS (
        UPDATE task_checklist_items SET is_done = true
        WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row >= v_cur AND craft_row < p_to_row AND NOT is_done
        RETURNING craft_row
      ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_ticked FROM u;
    ELSIF p_to_row < v_cur THEN
      WITH u AS (
        UPDATE task_checklist_items SET is_done = false
        WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row >= p_to_row AND craft_row < v_cur AND is_done
        RETURNING craft_row
      ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_unticked FROM u;
    END IF;
  END IF;

  v_new := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  -- FR1: Undo / Fix count below the timer's start row on this part lowers it, so the rows done
  -- again are in the sitting (Log sitting saves from the timer's start row).
  IF p_mode IN ('undo', 'fix') THEN
    UPDATE craft_timers SET start_row = v_new, start_quarter = 0, version = version + 1
      WHERE user_id = p_user_id AND part_id = p_part_id AND start_row > v_new;
  END IF;
  IF (v_part.quarter <> 0 OR v_part.quarter_row IS NOT NULL) AND v_part.quarter_row IS DISTINCT FROM v_new THEN
    UPDATE craft_parts SET quarter = 0, quarter_row = NULL WHERE id = p_part_id AND user_id = p_user_id;
  END IF;
  UPDATE craft_projects SET active_part_id = p_part_id
    WHERE project_id = v_part.project_id AND user_id = p_user_id AND active_part_id IS DISTINCT FROM p_part_id;
  RETURN jsonb_build_object('status', 'ok', 'mode', p_mode, 'part_id', p_part_id, 'previous_row', v_cur, 'current_row', v_new,
    'ticked', to_jsonb(v_ticked), 'unticked', to_jsonb(v_unticked), 'needs_check', v_check);
END;
$$;
CREATE OR REPLACE FUNCTION craft_remove_blockers(p_user_id UUID, p_project_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM craft_links WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'links' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_instructions c JOIN craft_parts p ON p.id = c.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND c.user_id = p_user_id) THEN 'instructions' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_notes WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'notes' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_yarns WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'yarn' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_timers WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'timer' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id AND NULLIF(btrim(gear), '') IS NOT NULL) THEN 'gear' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id
                      AND (quarters OR quarter <> 0 OR quarter_row IS NOT NULL)) THEN 'quarters' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id AND ridges) THEN 'ridges' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND s.close_check) THEN 'close_checks' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_sitting_details d JOIN craft_parts p ON p.id = d.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND d.user_id = p_user_id) THEN 'sittings' END
  ]::text[], NULL);
$$;
CREATE OR REPLACE FUNCTION work_session_create(
  p_user_id UUID,
  p_session JSONB,
  p_item_ids UUID[] DEFAULT '{}',
  p_mark_done BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v work_sessions%ROWTYPE;
  v_id UUID;
  v_bad UUID[];
  v_marked INTEGER := 0;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(COALESCE(p_session, '{}'::jsonb)) AS k(key)
    WHERE k.key NOT IN ('project_id', 'task_id', 'session_date', 'started_at', 'ended_at', 'minutes', 'extra_units',
                        'extra_work_type', 'note', 'exclude_from_stats', 'exclude_reason', 'source', 'source_ref')
  ) THEN
    RAISE EXCEPTION 'unknown work session field' USING ERRCODE = '22023';
  END IF;
  v := jsonb_populate_record(NULL::work_sessions, p_session);

  -- Lock every task this write touches, in id order, before checking anything.
  PERFORM work_sessions_lock_tasks(
    p_user_id,
    work_sessions_item_tasks(p_user_id, p_item_ids) || CASE WHEN v.task_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v.task_id] END
  );

  v_bad := work_sessions_out_of_scope_items(p_user_id, v.project_id, p_item_ids);
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'checklist items not in this project: %', array_to_string(v_bad, ', ')
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO work_sessions (
    user_id, project_id, task_id, session_date, started_at, ended_at, minutes, extra_units, extra_work_type,
    note, exclude_from_stats, exclude_reason, source, source_ref
  ) VALUES (
    p_user_id, v.project_id, v.task_id, v.session_date, v.started_at, v.ended_at, v.minutes, v.extra_units, v.extra_work_type,
    v.note, COALESCE(v.exclude_from_stats, false), v.exclude_reason, COALESCE(v.source, 'manual'), v.source_ref
  )
  RETURNING id INTO v_id;

  INSERT INTO work_session_items (session_id, checklist_item_id, user_id)
  SELECT DISTINCT v_id, item_id, p_user_id FROM unnest(COALESCE(p_item_ids, '{}'::uuid[])) AS item_id;

  IF p_mark_done THEN
    UPDATE task_checklist_items
      SET is_done = true, completed_at = v.ended_at
      WHERE id = ANY (COALESCE(p_item_ids, '{}'::uuid[]))
        AND user_id = p_user_id
        AND NOT is_done;
    GET DIAGNOSTICS v_marked = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('session_id', v_id, 'marked_done', v_marked);
END;
$$;
CREATE OR REPLACE FUNCTION work_session_update(
  p_user_id UUID,
  p_session_id UUID,
  p_changes JSONB,
  p_item_ids UUID[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cur work_sessions%ROWTYPE;
  nxt work_sessions%ROWTYPE;
  v_bad UUID[];
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(COALESCE(p_changes, '{}'::jsonb)) AS k(key)
    WHERE k.key NOT IN ('task_id', 'session_date', 'started_at', 'ended_at', 'minutes', 'extra_units', 'extra_work_type',
                        'note', 'exclude_from_stats', 'exclude_reason')
  ) THEN
    RAISE EXCEPTION 'unknown or read-only work session field' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO cur FROM work_sessions WHERE id = p_session_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  nxt := jsonb_populate_record(cur, COALESCE(p_changes, '{}'::jsonb));

  -- Lock the old and new task and the replacement rows' tasks, in id order, before any write.
  PERFORM work_sessions_lock_tasks(
    p_user_id,
    work_sessions_item_tasks(p_user_id, p_item_ids)
      || CASE WHEN cur.task_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[cur.task_id] END
      || CASE WHEN nxt.task_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[nxt.task_id] END
  );

  UPDATE work_sessions SET
    task_id = nxt.task_id,
    session_date = nxt.session_date,
    started_at = nxt.started_at,
    ended_at = nxt.ended_at,
    minutes = nxt.minutes,
    extra_units = nxt.extra_units,
    extra_work_type = nxt.extra_work_type,
    note = nxt.note,
    exclude_from_stats = nxt.exclude_from_stats,
    exclude_reason = nxt.exclude_reason
  WHERE id = p_session_id AND user_id = p_user_id;

  IF p_item_ids IS NOT NULL THEN
    v_bad := work_sessions_out_of_scope_items(p_user_id, cur.project_id, p_item_ids);
    IF cardinality(v_bad) > 0 THEN
      RAISE EXCEPTION 'checklist items not in this project: %', array_to_string(v_bad, ', ')
        USING ERRCODE = '23503';
    END IF;
    DELETE FROM work_session_items WHERE session_id = p_session_id AND user_id = p_user_id;
    INSERT INTO work_session_items (session_id, checklist_item_id, user_id)
    SELECT DISTINCT p_session_id, item_id, p_user_id FROM unnest(p_item_ids) AS item_id;
  END IF;

  RETURN jsonb_build_object('session_id', p_session_id, 'project_id', cur.project_id);
END;
$$;
DROP TABLE craft_frogs;
DELETE FROM work_session_items WHERE in_progress;
ALTER TABLE work_session_items DROP COLUMN in_progress;
ALTER TABLE craft_timers DROP COLUMN last_done_seconds;
COMMIT;
NOTIFY pgrst, 'reload schema';
