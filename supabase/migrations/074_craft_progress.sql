-- Craft S3: rows in progress and "Ripped back" (frogs), plus the S2 review follow-ups F1–F3.
--
-- Additive: two new columns, one new table, four new functions, five functions replaced with the
-- same signatures (CREATE OR REPLACE keeps their grants).
--  * work_session_items.in_progress (new, NOT NULL DEFAULT false): a link that means "worked on
--    in this sitting, not finished": the row is not ticked by it and adds no units; the pace engine
--    gives it the sitting's minutes (its share) with 0 units. A row is never linked as in progress
--    and finished in the same sitting (the primary key is (session_id, checklist_item_id)).
--  * craft_timers.last_done_seconds (new, FR1, nullable): the timer's timed seconds at the sitting's last
--    row ticked by craft_rows, so "Partway through" counts only timed time after the last Row done.
--    FR2: any untick (craft_rows' Undo / toast Undo / Fix count back, craft_frog) sets it back to NULL.
--  * craft_frogs (new): "Ripped back" history, one row per rip-back: the rows, a note and the
--    sittings this rip-back left out of speed (session_ids). Owner RLS and the four rights, like the
--    other craft tables after 072; 071's ownership trigger checks the part.
--  * work_session_create (059, replaced): p_session may carry in_progress_item_ids (rows linked in
--    progress: in the project, unticked, not also in p_item_ids; never ticked by the call).
--  * work_session_update (059, replaced): p_item_ids now replaces the sitting's FINISHED links (an
--    in-progress link on one of them becomes finished; other in-progress links stay), and p_changes
--    may carry in_progress_item_ids, which replaces the in-progress links. Before 074 there are no
--    in-progress links, so every existing caller gets exactly what it got before.
--  * craft_rows (073, replaced): mode 'undo_one' (F2): the Row done toast's Undo, server-side: it
--    unticks exactly p_to_row and refuses with 'stale' when any row after it, below the current row,
--    is ticked (a direct call can no longer untick 59–63 with the toast's body).
--    FR1: Row done (and Fix count ticking forward) stores the timer's timed seconds in
--    craft_timers.last_done_seconds when the timer is on this project (no version bump); FR2: a call
--    that unticks rows (Undo, undo_one, Fix count back) clears it (NULL; no version bump).
--  * craft_save_sitting (new): Log sitting with p_in_progress ("Partway through row N"): the next
--    row after "last full row" is linked in progress. Rows are linked unless another sitting already
--    FINISHED them (an in-progress link elsewhere doesn't stop the finishing sitting linking it).
--    F1: the sitting details name the part the sitting ended on (this part when it saved rows here
--    or is partway through a row here, else the last other part it saved rows on, with that part's
--    rows). F3: the reply names the rows actually saved (craft_sitting_rows).
--  * craft_log_sitting (073, replaced, same 14 arguments): calls craft_save_sitting with
--    p_in_progress false; a quarter (to_quarter > 0) means partway through the next row, so the S2
--    screen's quarter sittings now link that row in progress, as S2's sheet promised.
--  * craft_sitting_rows (new): the rows a sitting saved on a part, the row in progress there, and the
--    rows it saved on other parts.
--  * craft_frog (new): "Ripped back": unticks rows N–M (the last ticked rows of the screen's part, up
--    to the current row), removes every link to them and to the current row (finished or in
--    progress) from every sitting through work_session_update, leaves out of speed the sittings
--    whose linked rows were all ripped and the partly ripped ones the caller picked (reason "ripped
--    back rows N–M"; their minutes stay in daily time and actual_minutes), and records the frog.
--  * craft_remove_blockers (073, replaced): also lists 'frogs' (Remove would lose the history).
--
-- Every write function is SECURITY INVOKER, checks work_sessions_assert_caller(p_user_id) and takes
-- task locks first, in id order (059). craft_frog locks the sittings it changes FOR UPDATE first
-- (work_session_update's own order: session, then tasks), then every task of the project in id
-- order, then the craft project and the parts in id order (craft_part_lock's order for the rest).
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE work_session_items ADD COLUMN in_progress BOOLEAN NOT NULL DEFAULT false;
-- FR1: the timer's timed seconds (banked + the running stretch; time added or taken off with + / − left
-- out) when craft_rows last ticked a row of the timer's project in this sitting (Row done, or Fix count
-- ticking forward); NULL until then, and NULL again after any untick (FR2: craft_rows, craft_frog), when the
-- app falls back to its lower bound. The Partway default counts only timed time after the last Row done,
-- which the timer can't tell apart from its pauses once it has been resumed. A new timer starts NULL.
ALTER TABLE craft_timers ADD COLUMN last_done_seconds INTEGER CHECK (last_done_seconds >= 0);

CREATE TABLE craft_frogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES craft_parts(id) ON DELETE CASCADE,
  from_row INTEGER NOT NULL CHECK (from_row > 0),
  to_row INTEGER NOT NULL CHECK (to_row >= from_row),
  note TEXT CHECK (char_length(note) <= 1000),
  session_ids UUID[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT CHECK (char_length(idempotency_key) BETWEEN 1 AND 190),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_craft_frogs_part ON craft_frogs(part_id, created_at DESC);
CREATE UNIQUE INDEX idx_craft_frogs_user_key ON craft_frogs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE craft_frogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_frogs" ON craft_frogs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_frogs" ON craft_frogs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_frogs" ON craft_frogs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_frogs" ON craft_frogs FOR DELETE USING (auth.uid() = user_id);
REVOKE ALL ON craft_frogs FROM anon, PUBLIC, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_frogs TO authenticated, service_role;
CREATE TRIGGER trg_craft_frogs_ownership BEFORE INSERT OR UPDATE ON craft_frogs FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();

-- ── 059's session writes, replaced (same signatures) ─────────────────────────

-- Insert a session, link its rows and (optionally) tick them, all or nothing.
-- p_session keys: project_id, task_id, session_date, started_at, ended_at,
-- minutes, extra_units, extra_work_type, note, exclude_from_stats,
-- exclude_reason, source, source_ref, and (074) in_progress_item_ids: rows
-- worked on but not finished, linked in progress (unticked, never ticked here,
-- not also in p_item_ids). Ticked rows get completed_at = ended_at (or now()
-- when the session has no end time).
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
  v_progress UUID[] := '{}';
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(COALESCE(p_session, '{}'::jsonb)) AS k(key)
    WHERE k.key NOT IN ('project_id', 'task_id', 'session_date', 'started_at', 'ended_at', 'minutes', 'extra_units',
                        'extra_work_type', 'note', 'exclude_from_stats', 'exclude_reason', 'source', 'source_ref',
                        'in_progress_item_ids')
  ) THEN
    RAISE EXCEPTION 'unknown work session field' USING ERRCODE = '22023';
  END IF;
  IF p_session ? 'in_progress_item_ids' AND jsonb_typeof(p_session->'in_progress_item_ids') <> 'null' THEN
    IF jsonb_typeof(p_session->'in_progress_item_ids') <> 'array' THEN
      RAISE EXCEPTION 'in_progress_item_ids must be an array of checklist item ids' USING ERRCODE = '22023';
    END IF;
    v_progress := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(p_session->'in_progress_item_ids') AS x);
  END IF;
  v := jsonb_populate_record(NULL::work_sessions, p_session - 'in_progress_item_ids');

  -- Lock every task this write touches, in id order, before checking anything.
  PERFORM work_sessions_lock_tasks(
    p_user_id,
    work_sessions_item_tasks(p_user_id, COALESCE(p_item_ids, '{}'::uuid[]) || v_progress)
      || CASE WHEN v.task_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v.task_id] END
  );

  v_bad := work_sessions_out_of_scope_items(p_user_id, v.project_id, COALESCE(p_item_ids, '{}'::uuid[]) || v_progress);
  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'checklist items not in this project: %', array_to_string(v_bad, ', ')
      USING ERRCODE = '23503';
  END IF;
  IF v_progress && COALESCE(p_item_ids, '{}'::uuid[]) THEN
    RAISE EXCEPTION 'a row can''t be both finished and in progress in one sitting' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items WHERE id = ANY (v_progress) AND user_id = p_user_id AND is_done) THEN
    RAISE EXCEPTION 'a row in progress can''t be ticked' USING ERRCODE = '22023';
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
  INSERT INTO work_session_items (session_id, checklist_item_id, user_id, in_progress)
  SELECT v_id, item_id, p_user_id, true FROM unnest(v_progress) AS item_id;

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

-- Change a session; p_changes holds only the keys to change (a key with null
-- clears that field). A non-null p_item_ids replaces the FINISHED linked rows
-- (074: an in-progress link on one of them becomes finished; the other
-- in-progress links stay; ticks are never undone or made). p_changes may carry
-- in_progress_item_ids (074), which replaces the in-progress links (a row added
-- in progress must be unticked and not finished in this sitting). All or nothing.
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
  v_set_progress BOOLEAN := COALESCE(p_changes, '{}'::jsonb) ? 'in_progress_item_ids';
  v_progress UUID[] := '{}';
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(COALESCE(p_changes, '{}'::jsonb)) AS k(key)
    WHERE k.key NOT IN ('task_id', 'session_date', 'started_at', 'ended_at', 'minutes', 'extra_units', 'extra_work_type',
                        'note', 'exclude_from_stats', 'exclude_reason', 'in_progress_item_ids')
  ) THEN
    RAISE EXCEPTION 'unknown or read-only work session field' USING ERRCODE = '22023';
  END IF;
  IF v_set_progress THEN
    IF jsonb_typeof(p_changes->'in_progress_item_ids') <> 'array' THEN
      RAISE EXCEPTION 'in_progress_item_ids must be an array of checklist item ids' USING ERRCODE = '22023';
    END IF;
    v_progress := ARRAY(SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(p_changes->'in_progress_item_ids') AS x);
  END IF;

  SELECT * INTO cur FROM work_sessions WHERE id = p_session_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  nxt := jsonb_populate_record(cur, COALESCE(p_changes, '{}'::jsonb) - 'in_progress_item_ids');

  -- Lock the old and new task and the replacement rows' tasks, in id order, before any write.
  PERFORM work_sessions_lock_tasks(
    p_user_id,
    work_sessions_item_tasks(p_user_id, COALESCE(p_item_ids, '{}'::uuid[]) || v_progress)
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
    DELETE FROM work_session_items WHERE session_id = p_session_id AND user_id = p_user_id
      AND (NOT in_progress OR checklist_item_id = ANY (p_item_ids));
    INSERT INTO work_session_items (session_id, checklist_item_id, user_id)
    SELECT DISTINCT p_session_id, item_id, p_user_id FROM unnest(p_item_ids) AS item_id;
  END IF;

  IF v_set_progress THEN
    v_bad := work_sessions_out_of_scope_items(p_user_id, cur.project_id, v_progress);
    IF cardinality(v_bad) > 0 THEN
      RAISE EXCEPTION 'checklist items not in this project: %', array_to_string(v_bad, ', ')
        USING ERRCODE = '23503';
    END IF;
    IF EXISTS (SELECT 1 FROM work_session_items WHERE session_id = p_session_id AND user_id = p_user_id AND NOT in_progress
               AND checklist_item_id = ANY (v_progress)) THEN
      RAISE EXCEPTION 'a row can''t be both finished and in progress in one sitting' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM task_checklist_items i WHERE i.id = ANY (v_progress) AND i.user_id = p_user_id AND i.is_done
               AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.session_id = p_session_id AND w.checklist_item_id = i.id AND w.in_progress)) THEN
      RAISE EXCEPTION 'a row added in progress can''t be ticked' USING ERRCODE = '22023';
    END IF;
    DELETE FROM work_session_items WHERE session_id = p_session_id AND user_id = p_user_id AND in_progress;
    INSERT INTO work_session_items (session_id, checklist_item_id, user_id, in_progress)
    SELECT p_session_id, item_id, p_user_id, true FROM unnest(v_progress) AS item_id;
  END IF;

  RETURN jsonb_build_object('session_id', p_session_id, 'project_id', cur.project_id);
END;
$$;

-- ── 073's craft_rows, replaced: mode 'undo_one' (F2) ─────────────────────────

-- Row done / Undo / Fix count / band close for one part. Guarded by the expected current row
-- (the screen's), so a double tap or a second screen can't count twice:
--  * done: ticks the current row. When that finishes every row of a close_check segment
--    whose task isn't Done, returns needs_check (the screen asks "Count is 195?").
--  * undo: p_to_row < current; unticks the rows from p_to_row up to the current row.
--  * undo_one (074, the Row done toast's Undo): unticks exactly row p_to_row; 'stale' unless it is
--    the last row before the current row (no row after it, below the current row, ticked).
--  * fix:  p_to_row = the row to be on; ticks or unticks only between the old and new row.
--    Undo or fix below the start row of the caller's timer on this part lowers that start row
--    (and bumps the timer's version), so the rows done again belong to the timed sitting.
--  * close (p_segment_id): every row of the band ticked → ticks its count item and sets the
--    band task to Done (returns from_status so the route can record the transition).
-- Links are never changed here: an unticked row keeps its sittings (Fix count leaves speed alone).
-- A stored quarter is cleared once its row is no longer the current row; the part becomes
-- the project's active part. Returns { status: 'ok' | 'stale' | 'finished' | 'open_rows', ... }.
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
  IF p_part_id IS NULL OR p_mode IS NULL OR p_mode NOT IN ('done', 'undo', 'undo_one', 'fix', 'close') THEN
    RAISE EXCEPTION 'part id and a mode (done, undo, undo_one, fix, close) are required' USING ERRCODE = '22023';
  END IF;
  IF p_mode <> 'close' AND p_expected_row IS NULL THEN
    RAISE EXCEPTION 'expected row is required' USING ERRCODE = '22023';
  END IF;
  IF p_mode IN ('undo', 'undo_one', 'fix') AND p_to_row IS NULL THEN
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
    IF p_mode IN ('undo', 'undo_one') AND p_to_row >= v_cur THEN
      RAISE EXCEPTION 'undo goes back to an earlier row' USING ERRCODE = '22023';
    END IF;
    -- F2: the toast's Undo names one row. Any row after it (below the current row) means rows were
    -- ticked since (chat, the task panel, another screen): nothing is unticked.
    IF p_mode = 'undo_one' AND (
         NOT EXISTS (SELECT 1 FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = p_to_row)
         OR EXISTS (SELECT 1 FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id
                    AND craft_row > p_to_row AND craft_row < v_cur)) THEN
      RETURN jsonb_build_object('status', 'stale', 'part_id', p_part_id, 'current_row', v_cur);
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
  -- 074 FR1: a row ticked here (Row done, or Fix count forward) marks the timed seconds of the sitting's
  -- last Row done on this project's timer, for the Partway default. Not a version change.
  IF cardinality(v_ticked) > 0 THEN
    UPDATE craft_timers SET last_done_seconds = craft_timer_elapsed(banked_seconds, 0, running_since, clock_timestamp())
      WHERE user_id = p_user_id AND project_id = v_part.project_id;
  END IF;
  -- FR2: a row unticked here (Undo, the toast's Undo, Fix count back) may be the Row done the stored seconds
  -- belong to, so they are cleared: the app falls back to its lower bound from the last Row done left.
  IF cardinality(v_unticked) > 0 THEN
    UPDATE craft_timers SET last_done_seconds = NULL
      WHERE user_id = p_user_id AND project_id = v_part.project_id AND last_done_seconds IS NOT NULL;
  END IF;
  -- FR1: Undo / Fix count below the timer's start row on this part lowers it, so the rows done
  -- again are in the sitting (Log sitting saves from the timer's start row).
  IF p_mode IN ('undo', 'undo_one', 'fix') THEN
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

-- ── Log sitting with a row in progress ───────────────────────────────────────

-- The rows a sitting saved on p_part_id (finished links), the row in progress there, and the rows it
-- saved on the project's other parts: what the Log sitting confirmation shows (F3).
CREATE FUNCTION craft_sitting_rows(p_user_id UUID, p_session_id UUID, p_part_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'saved_rows', COALESCE((SELECT jsonb_agg(i.craft_row ORDER BY i.craft_row) FROM work_session_items w
        JOIN task_checklist_items i ON i.id = w.checklist_item_id
        WHERE w.session_id = p_session_id AND w.user_id = p_user_id AND NOT w.in_progress AND i.craft_part_id = p_part_id), '[]'::jsonb),
    'in_progress_row', (SELECT min(i.craft_row) FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id
        WHERE w.session_id = p_session_id AND w.user_id = p_user_id AND w.in_progress AND i.craft_part_id = p_part_id),
    'other_rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('part_id', g.part_id, 'rows', g.rows) ORDER BY g.sort_order, g.part_id) FROM (
        SELECT cp.id AS part_id, cp.sort_order, jsonb_agg(i.craft_row ORDER BY i.craft_row) AS rows
        FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id JOIN craft_parts cp ON cp.id = i.craft_part_id
        WHERE w.session_id = p_session_id AND w.user_id = p_user_id AND NOT w.in_progress AND cp.id <> p_part_id
        GROUP BY cp.id, cp.sort_order) g), '[]'::jsonb));
$$;

-- Log sitting: one transaction. The sitting saves the rows actually finished while it ran, per
-- part. On the part being saved (p_part_id, the screen's part) the rows are (from, p_to_row]:
-- p_from_row when given; else, with the timer on this part, its start row − 1 (never past
-- p_to_row); with the timer on an EARLIER part of this project (that part was finished during
-- the sitting and the screen moved on), the row before the first row of this part ticked since
-- the sitting started (else the current row − 1, never past p_to_row). Those rows are ticked;
-- the ones not already FINISHED in another sitting are linked (074: a link in progress elsewhere
-- doesn't count); rows after p_to_row up to the current row are unticked (the ± on "Last full
-- row"). With the timer on another part, the sitting ALSO links that part's rows from the timer's
-- start row that are ticked and finished in no sitting, and the rows of the parts between it and
-- this part ticked since the sitting started and finished in no sitting.
-- 074, p_in_progress ("Partway through row N", or any quarter > 0): the next row of this part after
-- p_to_row is linked IN PROGRESS (worked on, not finished: not ticked, no units); it must exist and
-- not be ticked once the rows after "last full row" are unticked.
-- Every linked row must be one of this project's part rows, owned by the caller and ticked
-- (else 23503, nothing saved). The session is written by 059's work_session_create
-- (p_mark_done true, source 'manual', source_ref 'client:' || p_idempotency_key, as POST
-- /api/work-sessions does), task_id = the one task of the linked rows and the row in progress, else
-- the current row's band task when nothing is linked, else NULL (across two tasks). Then craft_sitting_details:
-- F1, the part the sitting ended on: this part when it saved rows here or is partway through a
-- row here (from/to as above, in_progress_row), else the last other part it saved rows on (from =
-- the row before its first, to = its last); then the part's quarter (p_to_quarter of the next
-- row), the active part, and the timer is cleared. Nothing that returns early or raises clears the
-- timer. The reply carries craft_sitting_rows (F3: the rows actually saved).
-- Minutes: with p_use_timer they default to the timer's (rounded), start = the sitting's start
-- moved back by any time added on the timer with + (its "forgot to start" fix), end = now or
-- when it was paused. Typed minutes follow the project page's rule (F0): less than start–end
-- is fine (breaks), more than start–end + 1 is refused with F0's words; the start never moves.
-- A key already used returns { status: 'duplicate' } for this project (409 elsewhere).
CREATE FUNCTION craft_save_sitting(p_user_id UUID, p_part_id UUID, p_use_timer BOOLEAN, p_timer_version INTEGER, p_minutes INTEGER,
  p_date DATE, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_from_row INTEGER, p_to_row INTEGER, p_to_quarter INTEGER,
  p_expected_row INTEGER, p_note TEXT, p_idempotency_key TEXT, p_in_progress BOOLEAN)
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
  v_partway BOOLEAN;
  v_ip RECORD;
  v_ip_id UUID;
  v_ip_row INTEGER;
  v_other UUID[] := '{}';
  v_other_rows JSONB := '[]'::jsonb;
  v_mine UUID[];
  v_links UUID[];
  v_task UUID;
  v_tasks UUID[];
  v_created JSONB;
  v_session UUID;
  v_ticked INTEGER[];
  v_unticked INTEGER[];
  v_detail_part UUID;
  v_detail_from INTEGER;
  v_detail_to INTEGER;
  v_last_other JSONB;
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
  v_partway := COALESCE(p_in_progress, false) OR v_quarter > 0;
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
      'current_row', craft_current_row(p_user_id, p_part_id, v_part.total_rows))
      || craft_sitting_rows(p_user_id, v_existing.id, p_part_id);
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
      -- The timer's part: its rows from the start row, ticked, finished in no sitting.
      SELECT COALESCE(array_agg(i.id ORDER BY i.craft_row), '{}') INTO v_other FROM task_checklist_items i
        WHERE i.craft_part_id = v_tpart.id AND i.user_id = p_user_id AND i.is_done AND i.craft_row >= v_t.start_row
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND NOT w.in_progress);
      -- The parts between it and this one: rows ticked since the sitting started, finished in no sitting.
      v_other := v_other || COALESCE((SELECT array_agg(i.id ORDER BY cp.sort_order, cp.id, i.craft_row)
        FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
        WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id AND i.user_id = p_user_id AND i.is_done
          AND (cp.sort_order, cp.id) > (v_tpart.sort_order, v_tpart.id) AND (cp.sort_order, cp.id) < (v_part.sort_order, v_part.id)
          AND i.completed_at >= v_t.sitting_started_at
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND NOT w.in_progress)), '{}');
      SELECT COALESCE(jsonb_agg(jsonb_build_object('part_id', g.part_id, 'rows', g.rows) ORDER BY g.sort_order, g.part_id), '[]'::jsonb)
        INTO v_other_rows FROM (
          SELECT cp.id AS part_id, cp.sort_order, jsonb_agg(i.craft_row ORDER BY i.craft_row) AS rows
          FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
          WHERE i.id = ANY (v_other) GROUP BY cp.id, cp.sort_order) g;
      -- This part: from the row before its first row ticked since the sitting started.
      SELECT min(i.craft_row) INTO v_first_new FROM task_checklist_items i
        WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.is_done AND i.completed_at >= v_t.sitting_started_at
          AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND NOT w.in_progress);
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
  -- The row being worked: the next row of this part after "last full row".
  IF v_partway THEN
    SELECT i.id, i.craft_row, i.is_done INTO v_ip FROM task_checklist_items i
      WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.craft_row > p_to_row AND i.craft_row <= v_part.total_rows
      ORDER BY i.craft_row LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'There is no % after % to be partway through', v_part.row_word, p_to_row USING ERRCODE = '22023';
    END IF;
    -- Rows after "last full row" below the current row are unticked below; one at or past it stays as it is.
    IF v_ip.is_done AND v_ip.craft_row >= v_cur THEN
      RAISE EXCEPTION '% % is already ticked, so the sitting can''t be partway through it', initcap(v_part.row_word), v_ip.craft_row USING ERRCODE = '22023';
    END IF;
    v_ip_id := v_ip.id;
    v_ip_row := v_ip.craft_row;
  END IF;

  -- Rows finished in this sitting; linked unless another sitting already FINISHED them.
  SELECT COALESCE(array_agg(i.id ORDER BY i.craft_row), '{}') INTO v_mine
    FROM task_checklist_items i
   WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND i.craft_row > v_from AND i.craft_row <= p_to_row
     AND NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = i.id AND NOT w.in_progress);
  v_links := v_other || v_mine;
  -- FR1: the row in progress counts too (worked on in this sitting): finish scarf row 100 (task A) and
  -- stop partway into row 101 (task B) = two tasks = no task, 059's multi-task rule; only row 101 = task B.
  SELECT COALESCE(array_agg(DISTINCT i.task_id), '{}') INTO v_tasks FROM task_checklist_items i
    WHERE i.id = ANY (v_links || CASE WHEN v_ip_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_ip_id] END);
  IF cardinality(v_tasks) = 1 THEN
    v_task := v_tasks[1];
  ELSIF cardinality(v_tasks) = 0 THEN
    SELECT task_id INTO v_task FROM craft_segments
      WHERE part_id = p_part_id AND user_id = p_user_id AND LEAST(v_cur, v_part.total_rows) BETWEEN from_row AND to_row
      ORDER BY sort_order, from_row, id LIMIT 1;
  END IF;

  -- "Last full row" lower than the taps: those rows are unticked first, so the row in progress is
  -- unticked when it is linked.
  WITH u AS (
    UPDATE task_checklist_items SET is_done = false
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > p_to_row AND craft_row < v_cur AND is_done
    RETURNING craft_row
  ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_unticked FROM u;

  v_created := work_session_create(p_user_id, jsonb_build_object(
    'project_id', v_part.project_id, 'task_id', v_task, 'session_date', v_date, 'started_at', v_start, 'ended_at', v_end,
    'minutes', v_minutes, 'note', v_note, 'source', 'manual', 'source_ref', v_ref,
    'in_progress_item_ids', CASE WHEN v_ip_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_ip_id) END), v_links, true);
  v_session := (v_created->>'session_id')::uuid;

  WITH u AS (
    UPDATE task_checklist_items SET is_done = true, completed_at = COALESCE(v_end, v_now)
    WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row > v_from AND craft_row <= p_to_row AND NOT is_done
    RETURNING craft_row
  ) SELECT COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_ticked FROM u;

  -- Every linked row: a row of one of this project's parts, the caller's, ticked.
  IF EXISTS (SELECT 1 FROM unnest(v_links) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM task_checklist_items i JOIN craft_parts cp ON cp.id = i.craft_part_id
                               WHERE i.id = x.id AND i.user_id = p_user_id AND i.is_done
                                 AND cp.user_id = p_user_id AND cp.project_id = v_part.project_id)) THEN
    RAISE EXCEPTION 'a linked row is not a ticked row of this project' USING ERRCODE = '23503';
  END IF;

  -- F1: the details name the part the sitting ended on.
  v_detail_part := p_part_id;
  v_detail_from := v_from;
  v_detail_to := p_to_row;
  IF cardinality(v_mine) = 0 AND v_ip_id IS NULL AND jsonb_array_length(v_other_rows) > 0 THEN
    v_last_other := v_other_rows -> (jsonb_array_length(v_other_rows) - 1);
    v_detail_part := (v_last_other->>'part_id')::uuid;
    SELECT min(r::int) - 1, max(r::int) INTO v_detail_from, v_detail_to FROM jsonb_array_elements_text(v_last_other->'rows') AS r;
    v_from_quarter := 0;
  END IF;
  INSERT INTO craft_sitting_details (session_id, user_id, part_id, from_row, from_quarter, to_row, to_quarter, in_progress_row, adjust_minutes)
  VALUES (v_session, p_user_id, v_detail_part, v_detail_from, v_from_quarter, v_detail_to,
    CASE WHEN v_detail_part = p_part_id THEN v_quarter ELSE 0 END,
    CASE WHEN v_detail_part = p_part_id THEN v_ip_row END,
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
    'rows_linked', cardinality(v_links), 'from_row', v_from,
    'ticked', to_jsonb(v_ticked), 'unticked', to_jsonb(v_unticked),
    'previous_row', v_cur, 'current_row', craft_current_row(p_user_id, p_part_id, v_part.total_rows))
    || craft_sitting_rows(p_user_id, v_session, p_part_id);
END;
$$;

-- 073's Log sitting, same 14 arguments: craft_save_sitting without "Partway through"; a quarter
-- (to_quarter > 0) still means partway through the next row, so it is linked in progress.
CREATE OR REPLACE FUNCTION craft_log_sitting(p_user_id UUID, p_part_id UUID, p_use_timer BOOLEAN, p_timer_version INTEGER, p_minutes INTEGER,
  p_date DATE, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_from_row INTEGER, p_to_row INTEGER, p_to_quarter INTEGER,
  p_expected_row INTEGER, p_note TEXT, p_idempotency_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
BEGIN
  RETURN craft_save_sitting(p_user_id, p_part_id, p_use_timer, p_timer_version, p_minutes, p_date, p_started_at, p_ended_at,
    p_from_row, p_to_row, p_to_quarter, p_expected_row, p_note, p_idempotency_key, false);
END;
$$;

-- ── Ripped back ──────────────────────────────────────────────────────────────

-- "Ripped back" rows p_from_row–p_to_row of the screen's part: p_to_row is the row before the current
-- row (the last ticked rows, contiguous up to the current row), guarded by p_expected_row (the current
-- row the screen showed). Unticks those rows and removes every link to them, and to the current row
-- (worked partway, ripped out with them), finished or in progress, from every sitting through 059's
-- work_session_update (minutes, tasks and actual_minutes untouched). Sittings left with no linked rows
-- and no extra units are all ripped and get exclude_from_stats with reason "ripped back rows N–M";
-- partly ripped sittings are excluded too only when listed in p_exclude_session_ids (each must be one of
-- them); sittings already excluded keep their reason. The sittings this call excluded are recorded in
-- craft_frogs.session_ids. The timer's start row is lowered like Undo; a stale quarter is cleared.
-- A key already used returns { status: 'duplicate' } with that frog. Refusals that write nothing:
-- 'stale' (the count changed), 'other_part' (not the screen's part). Bad input raises 22023.
CREATE FUNCTION craft_frog(p_user_id UUID, p_part_id UUID, p_expected_row INTEGER, p_from_row INTEGER, p_to_row INTEGER,
  p_note TEXT, p_exclude_session_ids UUID[], p_idempotency_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_part craft_parts%ROWTYPE;
  v_key TEXT := btrim(p_idempotency_key);
  v_note TEXT := NULLIF(btrim(p_note), '');
  v_frog craft_frogs%ROWTYPE;
  v_items UUID[];
  v_rows INTEGER[];
  v_cur_item UUID;
  v_ripped UUID[];
  v_sessions UUID[];
  v_locked UUID[];
  v_tasks UUID[];
  v_active UUID;
  v_screen UUID;
  v_cur INTEGER;
  v_new INTEGER;
  v_word TEXT;
  v_reason TEXT;
  s RECORD;
  v_finished UUID[];
  v_progress UUID[];
  v_all UUID[] := '{}';
  v_partly UUID[] := '{}';
  v_excluded UUID[] := '{}';
  v_already UUID[] := '{}';
  v_removed INTEGER := 0;
  v_count INTEGER;
  v_unticked_count INTEGER;
  v_changes JSONB;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_part_id IS NULL OR p_expected_row IS NULL OR p_from_row IS NULL OR p_to_row IS NULL THEN
    RAISE EXCEPTION 'part id, expected row, from row and to row are required' USING ERRCODE = '22023';
  END IF;
  IF v_key IS NULL OR char_length(v_key) NOT BETWEEN 1 AND 190 THEN
    RAISE EXCEPTION 'idempotency key must be 1 to 190 characters' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'note must be 1000 characters or fewer' USING ERRCODE = '22023';
  END IF;
  IF p_from_row < 1 OR p_to_row < p_from_row THEN
    RAISE EXCEPTION 'rows must go from 1 or more up to at least the first row' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Locks: the sittings that link this part's rows from p_from_row on (session rows first, as
  -- work_session_update takes them), then every task of the project in id order (059), then the
  -- craft project and its parts in id order.
  SELECT COALESCE(array_agg(DISTINCT w.session_id), '{}') INTO v_sessions FROM work_session_items w
    JOIN task_checklist_items i ON i.id = w.checklist_item_id
    WHERE i.craft_part_id = p_part_id AND i.user_id = p_user_id AND w.user_id = p_user_id AND i.craft_row >= p_from_row;
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_locked FROM (
    SELECT id FROM work_sessions WHERE id = ANY (v_sessions) AND user_id = p_user_id ORDER BY id FOR UPDATE) x;
  SELECT COALESCE(array_agg(id), '{}') INTO v_tasks FROM tasks WHERE project_id = v_part.project_id AND user_id = p_user_id;
  PERFORM work_sessions_lock_tasks(p_user_id, v_tasks);
  PERFORM 1 FROM craft_projects WHERE project_id = v_part.project_id AND user_id = p_user_id FOR NO KEY UPDATE;
  PERFORM 1 FROM craft_parts WHERE project_id = v_part.project_id AND user_id = p_user_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_part FROM craft_parts WHERE id = p_part_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_PART_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_frog FROM craft_frogs WHERE user_id = p_user_id AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_frog.part_id <> p_part_id THEN
      RAISE EXCEPTION 'This rip-back key was already used for another part' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('status', 'duplicate', 'frog_id', v_frog.id, 'part_id', p_part_id, 'from_row', v_frog.from_row,
      'to_row', v_frog.to_row, 'excluded', to_jsonb(v_frog.session_ids),
      'current_row', craft_current_row(p_user_id, p_part_id, v_part.total_rows));
  END IF;

  v_cur := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  IF p_expected_row <> v_cur THEN
    RETURN jsonb_build_object('status', 'stale', 'part_id', p_part_id, 'current_row', v_cur);
  END IF;
  -- The screen's part, the app's rule (pickActivePart in src/lib/craft.ts): the stored active part while
  -- it is unfinished, else the first unfinished part by sort order, else the stored part (every part
  -- finished), else none. FR1: COALESCE, because cp.id = NULL is NULL, not false, when nothing is stored.
  SELECT active_part_id INTO v_active FROM craft_projects WHERE project_id = v_part.project_id AND user_id = p_user_id;
  SELECT cp.id INTO v_screen FROM craft_parts cp WHERE cp.project_id = v_part.project_id AND cp.user_id = p_user_id
      AND (COALESCE(cp.id = v_active, false) OR craft_current_row(p_user_id, cp.id, cp.total_rows) <= cp.total_rows)
    ORDER BY COALESCE(cp.id = v_active AND craft_current_row(p_user_id, cp.id, cp.total_rows) <= cp.total_rows, false) DESC,
      (craft_current_row(p_user_id, cp.id, cp.total_rows) <= cp.total_rows) DESC, COALESCE(cp.id = v_active, false) DESC, cp.sort_order, cp.id
    LIMIT 1;
  IF v_screen IS DISTINCT FROM p_part_id THEN
    RETURN jsonb_build_object('status', 'other_part', 'part_id', p_part_id, 'screen_part_id', v_screen, 'current_row', v_cur);
  END IF;
  IF p_to_row <> v_cur - 1 THEN
    RAISE EXCEPTION 'Ripped back rows end at the row before the current row (%)', v_cur - 1 USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY craft_row), '{}'), COALESCE(array_agg(craft_row ORDER BY craft_row), '{}') INTO v_items, v_rows
    FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row BETWEEN p_from_row AND p_to_row;
  IF cardinality(v_items) = 0 THEN
    RAISE EXCEPTION 'There are no % from % to %', v_part.row_word || 's', p_from_row, p_to_row USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_cur_item FROM task_checklist_items WHERE craft_part_id = p_part_id AND user_id = p_user_id AND craft_row = v_cur;
  v_ripped := v_items || CASE WHEN v_cur_item IS NULL THEN '{}'::uuid[] ELSE ARRAY[v_cur_item] END;

  -- The sittings touched now (under the locks) must be the ones locked first.
  IF EXISTS (SELECT 1 FROM work_session_items w WHERE w.checklist_item_id = ANY (v_ripped) AND w.user_id = p_user_id
             AND NOT (w.session_id = ANY (v_locked))) THEN
    RAISE EXCEPTION 'CRAFT_BUSY: a sitting changed while saving; try again' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_exclude_session_ids, '{}'::uuid[])) x(id)
             WHERE NOT EXISTS (SELECT 1 FROM work_session_items w WHERE w.session_id = x.id AND w.user_id = p_user_id
                               AND w.checklist_item_id = ANY (v_ripped))) THEN
    RAISE EXCEPTION 'Only sittings with ripped-back rows can be left out here' USING ERRCODE = '22023';
  END IF;

  v_word := CASE WHEN v_part.row_word = 'round' THEN 'round' ELSE 'row' END;
  v_reason := 'ripped back ' || CASE WHEN p_from_row = p_to_row THEN v_word || ' ' || p_from_row
    ELSE v_word || 's ' || p_from_row || '–' || p_to_row END;

  FOR s IN
    SELECT ws.id, ws.exclude_from_stats, ws.extra_units FROM work_sessions ws
    WHERE ws.user_id = p_user_id AND EXISTS (SELECT 1 FROM work_session_items w WHERE w.session_id = ws.id AND w.checklist_item_id = ANY (v_ripped))
    ORDER BY ws.id
  LOOP
    SELECT COALESCE(array_agg(checklist_item_id ORDER BY checklist_item_id) FILTER (WHERE NOT in_progress AND NOT (checklist_item_id = ANY (v_ripped))), '{}'),
           COALESCE(array_agg(checklist_item_id ORDER BY checklist_item_id) FILTER (WHERE in_progress AND NOT (checklist_item_id = ANY (v_ripped))), '{}'),
           count(*) FILTER (WHERE checklist_item_id = ANY (v_ripped))
      INTO v_finished, v_progress, v_count
      FROM work_session_items WHERE session_id = s.id AND user_id = p_user_id;
    v_removed := v_removed + v_count;
    v_changes := jsonb_build_object('in_progress_item_ids', to_jsonb(v_progress));
    IF cardinality(v_finished) = 0 AND cardinality(v_progress) = 0 AND COALESCE(s.extra_units, 0) = 0 THEN
      v_all := v_all || s.id;
    ELSE
      v_partly := v_partly || s.id;
    END IF;
    IF s.exclude_from_stats THEN
      v_already := v_already || s.id;
    ELSIF s.id = ANY (v_all) OR s.id = ANY (COALESCE(p_exclude_session_ids, '{}'::uuid[])) THEN
      v_changes := v_changes || jsonb_build_object('exclude_from_stats', true, 'exclude_reason', v_reason);
      v_excluded := v_excluded || s.id;
    END IF;
    PERFORM work_session_update(p_user_id, s.id, v_changes, v_finished);
  END LOOP;

  UPDATE task_checklist_items SET is_done = false WHERE id = ANY (v_items) AND user_id = p_user_id AND is_done;
  GET DIAGNOSTICS v_unticked_count = ROW_COUNT;
  -- FR2: the ripped rows may hold the Row done the timer's stored seconds belong to: cleared, like craft_rows'
  -- untick (no version bump).
  IF v_unticked_count > 0 THEN
    UPDATE craft_timers SET last_done_seconds = NULL
      WHERE user_id = p_user_id AND project_id = v_part.project_id AND last_done_seconds IS NOT NULL;
  END IF;
  v_new := craft_current_row(p_user_id, p_part_id, v_part.total_rows);
  UPDATE craft_timers SET start_row = v_new, start_quarter = 0, version = version + 1
    WHERE user_id = p_user_id AND part_id = p_part_id AND start_row > v_new;
  IF (v_part.quarter <> 0 OR v_part.quarter_row IS NOT NULL) AND v_part.quarter_row IS DISTINCT FROM v_new THEN
    UPDATE craft_parts SET quarter = 0, quarter_row = NULL WHERE id = p_part_id AND user_id = p_user_id;
  END IF;
  INSERT INTO craft_frogs (user_id, part_id, from_row, to_row, note, session_ids, idempotency_key)
  VALUES (p_user_id, p_part_id, p_from_row, p_to_row, v_note, v_excluded, v_key)
  RETURNING * INTO v_frog;

  RETURN jsonb_build_object('status', 'ok', 'frog_id', v_frog.id, 'part_id', p_part_id, 'from_row', p_from_row, 'to_row', p_to_row,
    'unticked', to_jsonb(v_rows), 'previous_row', v_cur, 'current_row', v_new, 'reason', v_reason,
    'excluded', to_jsonb(v_excluded), 'all_ripped', to_jsonb(v_all), 'partly_ripped', to_jsonb(v_partly),
    'already_excluded', to_jsonb(v_already), 'links_removed', v_removed);
END;
$$;

-- ── 073's craft_remove_blockers, replaced: 'frogs' ───────────────────────────

-- a. 'sittings': a craft sitting detail on one of the project's parts (S2 writes them).
--    craft_remove_project refuses (MC72R) while any blocker is listed, so Remove never
--    clears a sitting's part. 074: 'frogs', the "Ripped back" history (it goes with the parts).
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
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND d.user_id = p_user_id) THEN 'sittings' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_frogs f JOIN craft_parts p ON p.id = f.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND f.user_id = p_user_id) THEN 'frogs' END
  ]::text[], NULL);
$$;

REVOKE ALL ON FUNCTION craft_sitting_rows(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_save_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_frog(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_sitting_rows(UUID, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_save_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_frog(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT, UUID[], TEXT) TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
