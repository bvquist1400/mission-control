-- Craft S2: the craft screen's buttons. Row done / Undo / Fix count and the band close
-- (craft_rows), the timer (craft_timer), Log sitting (craft_log_sitting) and Change total
-- rows (craft_set_total), plus the S1C re-check carry-overs on 072's functions.
--
-- Additive: eight new functions, one new nullable column, three 072 functions replaced.
--  * craft_timers.paused_at (new, nullable): when the timer was paused (or "stopped X min
--    ago"). A sitting saved while paused ends there, not when Save was tapped, so its
--    start, end and ET day are the real ones. The only column change in 073.
--  * craft_setup_plan (072, replaced): sections ordered by sort_order, created_at in whole
--    milliseconds, then id, the same explicit order as orderSetupTasks() in
--    src/lib/craft/setup.ts (S1C re-check: two sections with one sort_order made in the
--    same second sorted differently in TypeScript and SQL).
--  * craft_setup_project (072, replaced): takes the project FOR UPDATE right after the
--    advisory lock, before any task lock, and no longer upgrades it later, so a 062 date
--    cascade (project FOR SHARE, then its tasks) waits instead of deadlocking (40P01).
--  * craft_remove_blockers (072, replaced): also lists 'sittings' when a craft sitting
--    detail points at one of the project's parts, so Remove never clears their part.
--
-- Every write function is SECURITY INVOKER, checks work_sessions_assert_caller(p_user_id),
-- and locks the part's task rows first, in id order (work_sessions_lock_tasks, 059's
-- order), then the craft project row, then the part (craft_part_lock): the same order as
-- 072's Remove (tasks, craft project, parts, segments). Log sitting writes the session only
-- through 059's work_session_create, in the same transaction, so the project page's Pace
-- card, get_project_forecast, Portfolio and the nightly re-plan see it like any sitting.
-- Outcomes where nothing was written (a stale count, a timer conflict) are returned as
-- { status: ... }; bad input raises 22023, a missing part or project P0002.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE craft_timers ADD COLUMN paused_at TIMESTAMPTZ;

-- Seconds on a timer at p_now: banked stretches, ± corrections, and the running stretch.
CREATE FUNCTION craft_timer_elapsed(p_banked INTEGER, p_adjust INTEGER, p_running_since TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(0, p_banked + p_adjust
    + CASE WHEN p_running_since IS NULL THEN 0 ELSE GREATEST(0, floor(extract(epoch FROM p_now - p_running_since)))::int END);
$$;

-- The current row (2.1): the part's lowest unticked row, or total + 1 when none is left.
CREATE FUNCTION craft_current_row(p_user_id UUID, p_part_id UUID, p_total INTEGER)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(min(craft_row), p_total + 1) FROM task_checklist_items
  WHERE craft_part_id = p_part_id AND user_id = p_user_id AND NOT is_done AND craft_row <= p_total;
$$;

-- The write lock for one part: its tasks (row items and segments) FOR NO KEY UPDATE in id
-- order, then its craft project FOR NO KEY UPDATE, then the part FOR UPDATE. A row item that
-- moved to an unlocked task meanwhile is a 40001 ("try again"); nothing is written yet.
CREATE FUNCTION craft_part_lock(p_user_id UUID, p_part_id UUID)
RETURNS craft_parts
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_part craft_parts%ROWTYPE;
  v_tasks UUID[];
BEGIN
  SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_tasks FROM (
    SELECT task_id AS x FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id
    UNION
    SELECT task_id FROM craft_segments WHERE part_id = p_part_id AND user_id = p_user_id AND task_id IS NOT NULL
  ) s;
  PERFORM work_sessions_lock_tasks(p_user_id, v_tasks);
  PERFORM 1 FROM craft_projects WHERE project_id = v_part.project_id AND user_id = p_user_id FOR NO KEY UPDATE;
  SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND NOT (task_id = ANY (v_tasks)))
     OR EXISTS (SELECT 1 FROM craft_segments WHERE part_id = p_part_id AND user_id = p_user_id AND task_id IS NOT NULL AND NOT (task_id = ANY (v_tasks))) THEN
    RAISE EXCEPTION 'CRAFT_BUSY: the rows changed while saving; try again' USING ERRCODE = '40001';
  END IF;
  RETURN v_part;
END;
$$;

-- The band-close check for a segment: its task, the count item on that task (the first
-- plain checklist item whose text starts "Count", unticked first, by sort order) and the
-- number to confirm: the first number in that item's text ("Count the last row: 195
-- stitches" → 195), else the part's stitch count. NULL for a segment without a task.
CREATE FUNCTION craft_band_check(p_user_id UUID, p_segment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_seg craft_segments%ROWTYPE;
  v_task RECORD;
  v_item RECORD;
  v_stitches INTEGER;
  v_count BIGINT;
BEGIN
  SELECT * INTO v_seg FROM craft_segments WHERE id = p_segment_id AND user_id = p_user_id;
  IF NOT FOUND OR v_seg.task_id IS NULL THEN RETURN NULL; END IF;
  SELECT id, status::text AS status, title INTO v_task FROM tasks WHERE id = v_seg.task_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stitch_count INTO v_stitches FROM craft_parts WHERE id = v_seg.part_id AND user_id = p_user_id;
  SELECT id, text, is_done INTO v_item FROM task_checklist_items
    WHERE task_id = v_seg.task_id AND user_id = p_user_id AND craft_part_id IS NULL AND text ~* '^[[:space:]]*count'
    ORDER BY is_done, sort_order, id LIMIT 1;
  IF FOUND THEN
    v_count := NULLIF(replace((regexp_match(v_item.text, '([0-9][0-9,]*)'))[1], ',', ''), '')::bigint;
  END IF;
  RETURN jsonb_build_object(
    'segment_id', v_seg.id, 'name', v_seg.name, 'from_row', v_seg.from_row, 'to_row', v_seg.to_row,
    'task_id', v_task.id, 'task_status', v_task.status,
    'item_id', v_item.id, 'item_text', v_item.text, 'item_done', COALESCE(v_item.is_done, false),
    'count', COALESCE(v_count, v_stitches),
    'count_source', CASE WHEN v_count IS NOT NULL THEN 'item' WHEN v_stitches IS NOT NULL THEN 'part' END);
END;
$$;

-- Row done / Undo / Fix count / band close for one part. Guarded by the expected current row
-- (the screen's), so a double tap or a second screen can't count twice:
--  * done: ticks the current row. When that finishes every row of a close_check segment
--    whose task isn't Done, returns needs_check (the screen asks "Count is 195?").
--  * undo: p_to_row < current; unticks the rows from p_to_row up to the current row.
--  * fix:  p_to_row = the row to be on; ticks or unticks only between the old and new row.
--    Undo or fix below the start row of the caller's timer on this part lowers that start row
--    (and bumps the timer's version), so the rows done again belong to the timed sitting.
--  * close (p_segment_id): every row of the band ticked → ticks its count item and sets the
--    band task to Done (returns from_status so the route can record the transition).
-- A stored quarter is cleared once its row is no longer the current row; the part becomes
-- the project's active part. Returns { status: 'ok' | 'stale' | 'finished' | 'open_rows', ... }.
CREATE FUNCTION craft_rows(p_user_id UUID, p_part_id UUID, p_expected_row INTEGER, p_to_row INTEGER, p_mode TEXT, p_segment_id UUID DEFAULT NULL)
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

-- The caller's timer as JSON at p_now (NULL when there is none).
CREATE FUNCTION craft_timer_state(p_user_id UUID, p_now TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object('project_id', t.project_id, 'part_id', t.part_id, 'sitting_started_at', t.sitting_started_at,
    'running_since', t.running_since, 'paused_at', t.paused_at, 'banked_seconds', t.banked_seconds,
    'adjust_seconds', t.adjust_seconds, 'start_row', t.start_row, 'start_quarter', t.start_quarter, 'version', t.version,
    'elapsed_seconds', craft_timer_elapsed(t.banked_seconds, t.adjust_seconds, t.running_since, p_now))
  FROM craft_timers t WHERE t.user_id = p_user_id;
$$;

-- The craft timer: one per user (071). Elapsed = banked + adjust + (now − running_since).
-- Actions: start, pause, resume, toggle, discard, adjust (±p_minutes), stopped_ago (pause as
-- of p_minutes ago). Every change bumps version; a change to an existing timer must send
-- the version it saw (p_expected_version), else { status: 'stale', timer }. Starting while
-- another project's timer holds time returns { status: 'conflict', other: ... } and changes
-- nothing. Resuming on a later ET day than the sitting started returns { status: 'new_day' }
-- unless p_force (keep it as one sitting). Returns { status, action, timer, server_now }.
CREATE FUNCTION craft_timer(p_user_id UUID, p_action TEXT, p_project_id UUID, p_part_id UUID DEFAULT NULL,
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

-- Log sitting: one transaction. The sitting saves the rows actually finished while it ran, per
-- part. On the part being saved (p_part_id, the screen's part) the rows are (from, p_to_row]:
-- p_from_row when given; else, with the timer on this part, its start row − 1 (never past
-- p_to_row); with the timer on an EARLIER part of this project (that part was finished during
-- the sitting and the screen moved on), the row before the first row of this part ticked since
-- the sitting started (else the current row − 1, never past p_to_row). Those rows are ticked;
-- the ones not already in another sitting are linked; rows after p_to_row up to the current row
-- are unticked (the ± on "Last full row"). With the timer on another part, the sitting ALSO
-- links that part's rows from the timer's start row that are ticked and in no sitting, and the
-- rows of the parts between it and this part ticked since the sitting started and in no
-- sitting: never a zero-row sitting for this part while another part's rows are dropped.
-- Every linked row must be one of this project's part rows, owned by the caller and ticked
-- (else 23503, nothing saved). The session is written by 059's work_session_create
-- (p_mark_done true, source 'manual', source_ref 'client:' || p_idempotency_key, as POST
-- /api/work-sessions does), task_id = the one task of the linked rows, else the current row's
-- band task when nothing is linked, else NULL (across two tasks). Then craft_sitting_details
-- (this part; for a sitting across parts its from_row is this part's), the part's quarter
-- (p_to_quarter of the next row), the active part, and the timer is cleared. Nothing that
-- returns early or raises clears the timer.
-- Minutes: with p_use_timer they default to the timer's (rounded), start = the sitting's start
-- moved back by any time added on the timer with + (its "forgot to start" fix), end = now or
-- when it was paused. Typed minutes follow the project page's rule (F0): less than start–end
-- is fine (breaks), more than start–end + 1 is refused with F0's words; the start never moves.
-- A key already used returns { status: 'duplicate' } for this project (409 elsewhere).
CREATE FUNCTION craft_log_sitting(p_user_id UUID, p_part_id UUID, p_use_timer BOOLEAN, p_timer_version INTEGER, p_minutes INTEGER,
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

-- Change total rows/rounds (the scarf's tape-measure ending). More: "Row N" / "Rnd N" /
-- "Round N" items (the word of the part's last row item; else the part's row word) are
-- added at the end of that row's task, with the part's stitch count as unit_count (a part
-- with no stitch count, whose count changes: the last row's unit_count) and the last row's
-- work type; the segment ending at the old total is extended. Fewer: only
-- trailing rows that are unticked and in no sitting are removed (else { status:
-- 'refused', reason: 'ticked' | 'in_sitting', rows }); segments past the new total are
-- removed and the one across it is cut. Guarded by the total the screen showed.
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

-- ── 072's functions, replaced (S1C re-check carry-overs). 073's rollback puts the 072
-- bodies back. CREATE OR REPLACE keeps their 072 grants.

-- d. One explicit section order on both sides: sort_order, created_at in whole milliseconds
--    (NULL first), id.
CREATE OR REPLACE FUNCTION craft_setup_plan(p_user_id UUID, p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  -- JavaScript's \s (and String.prototype.trim), written out so both sides use one class.
  c_ws CONSTANT TEXT := '[\t\n\v\f\r    -     　﻿]';
  c_label CONSTANT TEXT := '^((Row|Rnd|Round)[ \t]+([0-9]+))(?![0-9A-Za-z_])';
  v_range TEXT;
  t RECORD;
  v_stops TEXT[] := '{}';
  v_parts JSONB := '[]';
  v_cur JSONB;
  v_section UUID;
  v_units NUMERIC[];
  v_nulls BOOLEAN;
  v_undone BOOLEAN;
  v_active INTEGER;
  v_word TEXT;
  v_unit NUMERIC;
BEGIN
  v_range := '^(?:' || c_ws || '*(?:[-‐‑‒–—―−~/&,+]|(?:to|through|thru|and)(?![0-9A-Za-z_]))' || c_ws || '*[0-9]|\.[0-9])';
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN v_stops := v_stops || 'on_craft_screen'::text; END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND i.craft_part_id IS NOT NULL) THEN
    v_stops := v_stops || 'linked'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
               CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND NOT k.is_sample AND r.m IS NOT NULL
               AND ((r.m)[3]::numeric = 0 OR (r.m)[3]::numeric > 1000000 OR substr(i.text, char_length((r.m)[1]) + 1) ~* v_range)) THEN
    v_stops := v_stops || 'bad_number'::text;
  END IF;

  FOR t IN
    WITH sec AS (
      SELECT id, row_number() OVER (ORDER BY sort_order, floor(extract(epoch FROM created_at) * 1000) NULLS FIRST, id) AS rank
      FROM project_sections WHERE project_id = p_project_id AND user_id = p_user_id
    ), tk AS (
      SELECT k.id, k.section_id, s.rank, floor(extract(epoch FROM k.created_at) * 1000) AS ms
      FROM tasks k LEFT JOIN sec s ON s.id = k.section_id
      WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample
    ), it AS (
      SELECT i.task_id, i.id, i.is_done, i.unit_count, (r.m)[2] AS word, (r.m)[3]::numeric AS num
      FROM task_checklist_items i CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
      WHERE i.user_id = p_user_id AND i.task_id IN (SELECT id FROM tk) AND r.m IS NOT NULL
        AND (r.m)[3]::numeric BETWEEN 1 AND 1000000 AND substr(i.text, char_length((r.m)[1]) + 1) !~* v_range
    )
    SELECT tk.id, tk.section_id, count(DISTINCT (it.word = 'Row')) AS words, bool_and(it.word = 'Row') AS is_row,
      min(it.num) AS lo, max(it.num) AS hi, count(*) AS n, count(DISTINCT it.num) AS n_distinct,
      bool_or(NOT it.is_done) AS undone, array_agg(it.unit_count ORDER BY it.num, it.id) AS units,
      jsonb_agg(jsonb_build_object('item_id', it.id, 'row', it.num) ORDER BY it.num, it.id) AS rows
    FROM tk JOIN it ON it.task_id = tk.id
    GROUP BY tk.id, tk.section_id, tk.rank, tk.ms
    ORDER BY tk.rank IS NULL, tk.rank, tk.ms, tk.id
  LOOP
    IF t.words > 1 THEN v_stops := v_stops || 'mixed_words'::text; CONTINUE; END IF;
    IF t.n <> t.n_distinct THEN v_stops := v_stops || 'repeat'::text; END IF;
    v_word := CASE WHEN t.is_row THEN 'row' ELSE 'round' END;
    IF v_cur IS NOT NULL AND v_section IS NOT DISTINCT FROM t.section_id AND v_cur->>'row_word' = v_word
       AND t.lo = (v_cur->>'total_rows')::numeric + 1 THEN
      v_cur := jsonb_set(jsonb_set(jsonb_set(v_cur,
        '{segments}', (v_cur->'segments') || jsonb_build_object('task_id', t.id, 'from_row', t.lo, 'to_row', t.hi)),
        '{rows}', (v_cur->'rows') || t.rows),
        '{total_rows}', to_jsonb(GREATEST((v_cur->>'total_rows')::numeric, t.hi)));
      v_units := v_units || t.units;
      v_undone := v_undone OR t.undone;
    ELSE
      IF v_cur IS NOT NULL THEN
        v_nulls := array_position(v_units, NULL) IS NOT NULL;
        SELECT CASE WHEN count(DISTINCT u) = 1 THEN min(u) END INTO v_unit FROM unnest(v_units) u;
        v_parts := v_parts || jsonb_set(v_cur, '{stitch_count}', CASE WHEN NOT v_nulls AND v_unit IS NOT NULL AND v_unit > 0 AND v_unit <= 2147483647
          AND v_unit = trunc(v_unit) THEN to_jsonb(v_unit::int) ELSE 'null'::jsonb END);
        IF v_undone AND v_active IS NULL THEN v_active := jsonb_array_length(v_parts) - 1; END IF;
      END IF;
      v_cur := jsonb_build_object('row_word', v_word, 'total_rows', t.hi, 'stitch_count', NULL,
        'segments', jsonb_build_array(jsonb_build_object('task_id', t.id, 'from_row', t.lo, 'to_row', t.hi)), 'rows', t.rows);
      v_section := t.section_id;
      v_units := t.units;
      v_undone := t.undone;
    END IF;
  END LOOP;
  IF v_cur IS NOT NULL THEN
    v_nulls := array_position(v_units, NULL) IS NOT NULL;
    SELECT CASE WHEN count(DISTINCT u) = 1 THEN min(u) END INTO v_unit FROM unnest(v_units) u;
    v_parts := v_parts || jsonb_set(v_cur, '{stitch_count}', CASE WHEN NOT v_nulls AND v_unit IS NOT NULL AND v_unit > 0 AND v_unit <= 2147483647
      AND v_unit = trunc(v_unit) THEN to_jsonb(v_unit::int) ELSE 'null'::jsonb END);
    IF v_undone AND v_active IS NULL THEN v_active := jsonb_array_length(v_parts) - 1; END IF;
  END IF;
  IF jsonb_array_length(v_parts) = 0 THEN v_stops := v_stops || 'no_rows'::text; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_parts) p WHERE (p->>'total_rows')::numeric > 2000) THEN v_stops := v_stops || 'too_many_rows'::text; END IF;
  RETURN jsonb_build_object('stops', to_jsonb(v_stops), 'active_part_index', to_jsonb(v_active), 'parts', v_parts);
END;
$$;

-- b. The project FOR UPDATE at the start (after the advisory lock), never upgraded later.
CREATE OR REPLACE FUNCTION craft_setup_project(p_user_id UUID, p_project_id UUID, p_plan JSONB, p_fingerprint TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_trim CONSTANT TEXT := E'\t\n\x0b\f\r                  　﻿';
  c_label CONSTANT TEXT := '^(Row|Rnd|Round)[ \t]+[0-9]+(?![0-9A-Za-z_])';
  v_part JSONB;
  v_names TEXT[] := '{}';
  v_name TEXT;
  v_plan JSONB;
  v_given JSONB;
  v_tasks UUID[];
  v_part_id UUID;
  v_part_ids UUID[] := '{}';
  v_index INTEGER := 0;
  v_count INTEGER;
  v_rows INTEGER := 0;
  v_segments INTEGER := 0;
  v_active INTEGER;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'project id and fingerprint are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_plan) k WHERE k NOT IN ('craft', 'active_part_index', 'parts'))
     OR jsonb_typeof(p_plan->'craft') IS DISTINCT FROM 'string' OR p_plan->>'craft' NOT IN ('knit', 'crochet', 'other')
     OR jsonb_typeof(p_plan->'parts') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_plan->'parts') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'craft setup plan is not valid' USING ERRCODE = '22023';
  END IF;
  FOR v_part IN SELECT value FROM jsonb_array_elements(p_plan->'parts') LOOP
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_part) k WHERE k NOT IN ('name', 'row_word', 'total_rows', 'stitch_count', 'sort_order', 'segments', 'rows'))
       OR jsonb_typeof(v_part->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_part->'segments') IS DISTINCT FROM 'array' OR jsonb_typeof(v_part->'rows') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'segments') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'rows') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object') THEN
      RAISE EXCEPTION 'craft setup part is not valid' USING ERRCODE = '22023';
    END IF;
    v_name := btrim(v_part->>'name', c_trim);
    IF v_name = '' OR char_length(v_name) > 80 OR v_name ~ '[\x01-\x1f\x7f]' THEN
      RAISE EXCEPTION 'craft setup part name is not valid' USING ERRCODE = '22023';
    END IF;
    v_names := v_names || v_name;
  END LOOP;

  -- 073: the advisory lock, then the project FOR UPDATE, before any task lock (no later
  -- upgrade): a 062 date cascade (project FOR SHARE, then its tasks) waits here instead of
  -- deadlocking. craft_setup_lock takes the advisory lock again (it stacks) and its FOR SHARE
  -- is already covered.
  PERFORM pg_advisory_xact_lock(hashtextextended('craft_setup|' || p_project_id::text, 0));
  PERFORM 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_EXISTS: this project is already on the craft screen' USING ERRCODE = '23505';
  END IF;
  IF craft_setup_fingerprint(p_user_id, p_project_id) IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed since the preview' USING ERRCODE = 'MC072';
  END IF;

  v_plan := craft_setup_plan(p_user_id, p_project_id);
  IF jsonb_array_length(v_plan->'stops') > 0 THEN
    RAISE EXCEPTION 'CRAFT_SETUP_STOP: %', v_plan->>'stops' USING ERRCODE = '22023';
  END IF;
  v_given := jsonb_build_object(
    'active_part_index', COALESCE(p_plan->'active_part_index', 'null'::jsonb),
    'parts', (SELECT jsonb_agg(jsonb_build_object(
        'row_word', COALESCE(p.value->'row_word', 'null'::jsonb), 'total_rows', COALESCE(p.value->'total_rows', 'null'::jsonb),
        'stitch_count', COALESCE(p.value->'stitch_count', 'null'::jsonb),
        'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id', COALESCE(s.value->'task_id', 'null'::jsonb), 'from_row', COALESCE(s.value->'from_row', 'null'::jsonb),
            'to_row', COALESCE(s.value->'to_row', 'null'::jsonb)) ORDER BY s.ordinality) FROM jsonb_array_elements(p.value->'segments') WITH ORDINALITY s), '[]'::jsonb),
        'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id', COALESCE(r.value->'item_id', 'null'::jsonb), 'row', COALESCE(r.value->'row', 'null'::jsonb))
            ORDER BY r.ordinality) FROM jsonb_array_elements(p.value->'rows') WITH ORDINALITY r), '[]'::jsonb)
      ) ORDER BY p.ordinality) FROM jsonb_array_elements(p_plan->'parts') WITH ORDINALITY p));
  IF v_given IS DISTINCT FROM jsonb_build_object('active_part_index', v_plan->'active_part_index', 'parts', v_plan->'parts') THEN
    RAISE EXCEPTION 'CRAFT_SETUP_PLAN: the plan does not match the project' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_tasks FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id;

  INSERT INTO craft_projects (project_id, user_id, craft) VALUES (p_project_id, p_user_id, p_plan->>'craft');
  FOR v_part IN SELECT value FROM jsonb_array_elements(v_plan->'parts') LOOP
    v_index := v_index + 1;
    INSERT INTO craft_parts (user_id, project_id, name, sort_order, total_rows, row_word, stitch_count)
    VALUES (p_user_id, p_project_id, v_names[v_index], v_index - 1, (v_part->>'total_rows')::int, v_part->>'row_word', (v_part->>'stitch_count')::int)
    RETURNING id INTO v_part_id;
    v_part_ids := v_part_ids || v_part_id;
    INSERT INTO craft_segments (user_id, part_id, task_id, name, from_row, to_row, sort_order)
    SELECT p_user_id, v_part_id, k.id, rtrim(left(btrim(k.title, c_trim), 80), c_trim), (s.value->>'from_row')::int, (s.value->>'to_row')::int, s.ordinality - 1
    FROM jsonb_array_elements(v_part->'segments') WITH ORDINALITY s JOIN tasks k ON k.id = (s.value->>'task_id')::uuid;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_segments := v_segments + v_count;
    UPDATE task_checklist_items i SET craft_part_id = v_part_id, craft_row = (r.value->>'row')::int
    FROM jsonb_array_elements(v_part->'rows') r
    WHERE i.id = (r.value->>'item_id')::uuid AND i.user_id = p_user_id AND i.craft_part_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> jsonb_array_length(v_part->'rows') THEN
      RAISE EXCEPTION 'craft setup rows are not valid' USING ERRCODE = '22023';
    END IF;
    v_rows := v_rows + v_count;
  END LOOP;
  IF jsonb_typeof(v_plan->'active_part_index') = 'number' THEN
    v_active := (v_plan->>'active_part_index')::int;
    UPDATE craft_projects SET active_part_id = v_part_ids[v_active + 1] WHERE project_id = p_project_id AND user_id = p_user_id;
  END IF;

  -- Belt and braces after the writes: the same tasks, and no numbered item of a non-swatch task left unlinked.
  IF (SELECT array_agg(id ORDER BY id) FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id) IS DISTINCT FROM v_tasks
     OR EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
                WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample AND i.craft_part_id IS NULL AND i.text ~ c_label) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed while setting up' USING ERRCODE = 'MC072';
  END IF;

  RETURN jsonb_build_object('project_id', p_project_id, 'parts', cardinality(v_part_ids), 'segments', v_segments,
    'rows_linked', v_rows, 'active_part_id', CASE WHEN v_active IS NULL THEN NULL ELSE v_part_ids[v_active + 1] END);
END;
$$;

-- a. 'sittings': a craft sitting detail on one of the project's parts (S2 writes them).
--    craft_remove_project refuses (MC72R) while any blocker is listed, so Remove never
--    clears a sitting's part.
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

REVOKE ALL ON FUNCTION craft_timer_elapsed(INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_current_row(UUID, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_part_lock(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_band_check(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_rows(UUID, UUID, INTEGER, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_timer_state(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_timer(UUID, TEXT, UUID, UUID, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_log_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_timer_elapsed(INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_current_row(UUID, UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_part_lock(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_band_check(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_rows(UUID, UUID, INTEGER, INTEGER, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_timer_state(UUID, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_timer(UUID, TEXT, UUID, UUID, INTEGER, INTEGER, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_log_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER) TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
