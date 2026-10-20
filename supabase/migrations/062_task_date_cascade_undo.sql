-- 062: cascade due dates, slice S2 (Baseline task 6fcad51b): one lock protocol for
-- every cascade write, Undo, switching how far a cascade went, and retry.
--
-- 1. Lock protocol (fixes the S1 re-check P2). task_date_cascade_lock() is the only
--    way the cascade functions take row locks: the per-user advisory lock (061's
--    key, shared with the loop guard), then the PROJECTS of every task involved
--    FOR SHARE in id order, then the TASKS (the edited task and every other task
--    involved, in ONE id-ordered pass) FOR NO KEY UPDATE (the lock a task UPDATE
--    takes). Project before task is the order a project UPDATE already uses: the
--    UPDATE locks the project row, then 046's trigger (re-pointing the
--    application) updates that project's tasks. 061 locked the edited task first
--    and its project later, so a cascade and a project PATCH could each hold what
--    the other waited for (a deadlock: one of them aborted). With projects first
--    neither can hold a task the other needs while waiting for a project. Against
--    060's comment function (task FOR SHARE, then project FOR SHARE) there is no
--    cycle either: two FOR SHARE locks on a project never wait on each other. The
--    project ids are read before the task locks; if a task moved to another
--    project in between, the function raises MC062 and rolls back (the app retries
--    a bounded number of times; nothing was written).
-- 2. apply_task_date_cascade (061's 11 arguments, unchanged for callers) now takes
--    those locks; its body moved to task_date_cascade_apply_core, which also:
--    - skips a move whose planned path changed (a task between it and the edited
--      task became Done or Missed, recurring, or, for FamCal, hidden, after
--      planning): reason 'path_changed' (S1 re-check L1). The move carries `via`,
--      the tasks on its planned path;
--    - keeps a moved task's current priority when ANY input of its score changed
--      since planning (base priority, status, title, stakeholder mentions), not only
--      the base (S1 re-check L2);
--    - records when it turned a project Green -> Yellow (`rag_set_at`, the
--      project's updated_at) so Undo can tell whether health changed since.
-- 3. undo_task_date_cascade: puts back every task the cascade moved whose due date
--    still equals the date the cascade gave it (a task changed since is kept and
--    listed), with one system comment each and the priority the app computed for
--    the old date (kept when a score input changed since); marks the cascade
--    undone; optionally puts the edited task back too (only while it still has the
--    date the edit set); a project the cascade turned Yellow goes back to Green
--    only when it is still Yellow, nothing else changed on the project since
--    (updated_at), and every task of that project was put back (Brent 10/20).
-- 4. replace_task_date_cascade: "switch how far" and "try again" in ONE
--    transaction: undo the cascade being replaced (if any, dependents only), then
--    apply the new plan (none for "just this task"). The edited task must still
--    have the date the edit set, else nothing changes ('superseded').
-- All of them: SECURITY INVOKER (RLS applies; a signed-in user may only pass their
-- own id), lock_timeout 5s, all or nothing. FamCal can't reach them (its key is
-- limited to its own routes); undo/replace always run with scope 'all'.
-- Also drops the stale 9-argument apply_task_date_cascade an early 061 draft left
-- on some local databases (never on production).
--
-- Rollback: supabase/rollbacks/062_task_date_cascade_undo.down.sql (restores 061's
-- apply function and drops the new columns and functions).

BEGIN;

DROP FUNCTION IF EXISTS apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB);

-- ── Log columns ──────────────────────────────────────────────────────────

ALTER TABLE task_date_cascades
  ADD COLUMN IF NOT EXISTS replaces_cascade_id UUID REFERENCES task_date_cascades(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undone_reason TEXT CHECK (undone_reason IS NULL OR undone_reason IN ('undo', 'replaced'));

ALTER TABLE task_date_cascade_moves
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restore_comment_id UUID REFERENCES task_comments(id) ON DELETE SET NULL;

-- ── 1. Lock protocol ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION task_date_cascade_lock(
  p_user_id UUID,
  p_task_ids UUID[],
  p_scope TEXT,
  p_extra_project_ids UUID[] DEFAULT '{}'
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_projects UUID[];
  v_locked UUID[];
  v_after UUID[];
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot move tasks for another user' USING ERRCODE = '42501';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'famcal') THEN
    RAISE EXCEPTION 'scope must be all or famcal' USING ERRCODE = '22023';
  END IF;

  -- One cascade (or link add) per user at a time.
  PERFORM pg_advisory_xact_lock(task_graph_lock_key(p_user_id));

  -- Projects first (a project UPDATE locks the project, then 046's trigger its tasks).
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_projects
    FROM (
      SELECT t.project_id AS x
        FROM public.tasks t
       WHERE t.user_id = p_user_id
         AND t.id = ANY (COALESCE(p_task_ids, '{}'))
         AND t.project_id IS NOT NULL
         AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)))
      UNION
      SELECT unnest(COALESCE(p_extra_project_ids, '{}'))
    ) s
   WHERE x IS NOT NULL;
  v_projects := COALESCE(v_projects, '{}');

  PERFORM 1
     FROM public.projects p
    WHERE p.user_id = p_user_id
      AND p.id = ANY (v_projects)
    ORDER BY p.id
      FOR SHARE OF p;

  -- Then every task involved, in one id-ordered pass (FamCal: only rows eligible in
  -- this same read, so an ineligible task is never waited on).
  SELECT array_agg(s.id ORDER BY s.id) INTO v_locked
    FROM (
      SELECT t.id
        FROM public.tasks t
       WHERE t.user_id = p_user_id
         AND t.id = ANY (COALESCE(p_task_ids, '{}'))
         AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)))
       ORDER BY t.id
         FOR NO KEY UPDATE OF t
    ) s;
  v_locked := COALESCE(v_locked, '{}');

  -- A task that moved to another project between the two reads: its project isn't
  -- locked. Roll back (nothing written yet) and let the caller try again.
  SELECT array_agg(DISTINCT t.project_id) INTO v_after
    FROM public.tasks t
   WHERE t.id = ANY (v_locked) AND t.project_id IS NOT NULL;
  IF v_after IS NOT NULL AND NOT (v_after <@ v_projects) THEN
    RAISE EXCEPTION 'a task moved to another project while the cascade was starting; try again'
      USING ERRCODE = 'MC062', HINT = 'task_date_cascade_retry';
  END IF;

  RETURN v_locked;
END;
$$;

COMMENT ON FUNCTION task_date_cascade_lock(UUID, UUID[], TEXT, UUID[]) IS
  'Cascade lock protocol (062): advisory lock, projects FOR SHARE, then tasks FOR NO KEY UPDATE, all in id order; MC062 when a task changed project meanwhile.';

-- Whether a score input is unchanged since the app computed a new priority_score
-- from it (keys missing from p_planned are not compared).
CREATE OR REPLACE FUNCTION task_date_cascade_score_unchanged(
  p_base_priority INTEGER,
  p_status TEXT,
  p_title TEXT,
  p_mentions TEXT[],
  p_planned JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (NOT (p_planned ? 'base_priority') OR p_base_priority IS NOT DISTINCT FROM (p_planned->>'base_priority')::integer)
     AND (NOT (p_planned ? 'status') OR p_status IS NOT DISTINCT FROM (p_planned->>'status'))
     AND (NOT (p_planned ? 'title') OR p_title IS NOT DISTINCT FROM (p_planned->>'title'))
     AND (NOT (p_planned ? 'stakeholder_mentions')
          OR COALESCE(p_mentions, '{}'::TEXT[]) = ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_planned->'stakeholder_mentions', '[]'::jsonb))));
$$;

-- ── 2. Apply ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION task_date_cascade_apply_core(
  p_user_id UUID,
  p_root_task_id UUID,
  p_root_old_due_at TIMESTAMPTZ,
  p_root_new_due_at TIMESTAMPTZ,
  p_mode TEXT,
  p_delta_workdays INTEGER,
  p_scope TEXT,
  p_source TEXT,
  p_moves JSONB,
  p_root_title TEXT,
  p_root_was_visible BOOLEAN,
  p_replaces_cascade_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_move JSONB;
  v_task_id UUID;
  v_old TIMESTAMPTZ;
  v_new TIMESTAMPTZ;
  v_priority INTEGER;
  v_comment TEXT;
  v_comment_redacted TEXT;
  v_root RECORD;
  v_root_visible BOOLEAN;
  v_cascade_id UUID;
  v_ids UUID[];
  v_via UUID[];
  v_old_priority INTEGER;
  v_updated RECORD;
  v_comment_id UUID;
  v_moved JSONB := '[]'::jsonb;
  v_skipped JSONB := '[]'::jsonb;
  v_flags JSONB := '[]'::jsonb;
  v_count INTEGER := 0;
  v_project RECORD;
  v_rag_before TEXT;
  v_rag_after TEXT;
  v_rag_set_at TIMESTAMPTZ;
  v_name_ok BOOLEAN;
  v_root_title TEXT;
  v_path_ok BOOLEAN;
BEGIN
  -- Caller and arguments.
  IF p_user_id IS NULL OR p_root_task_id IS NULL OR p_root_new_due_at IS NULL THEN
    RAISE EXCEPTION 'user id, root task id and root due date are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot move tasks for another user' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('same_gap', 'only_collisions') THEN
    RAISE EXCEPTION 'mode must be same_gap or only_collisions' USING ERRCODE = '22023';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'famcal') THEN
    RAISE EXCEPTION 'scope must be all or famcal' USING ERRCODE = '22023';
  END IF;
  IF p_delta_workdays IS NULL OR p_delta_workdays < 0 THEN
    RAISE EXCEPTION 'delta_workdays must be 0 or more' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR char_length(p_source) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'source must be 1 to 40 characters' USING ERRCODE = '22023';
  END IF;
  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'moves must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_moves) > 500 THEN
    RAISE EXCEPTION 'too many moves in one cascade' USING ERRCODE = '22023';
  END IF;

  FOR v_move IN SELECT value FROM jsonb_array_elements(p_moves) LOOP
    IF jsonb_typeof(v_move) <> 'object' THEN
      RAISE EXCEPTION 'each move must be an object' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(v_move) AS k(key)
       WHERE k.key NOT IN ('task_id', 'old_due_at', 'new_due_at', 'priority_score', 'base_priority', 'status', 'title',
                           'stakeholder_mentions', 'via', 'comment', 'comment_redacted')
    ) THEN
      RAISE EXCEPTION 'unknown move field' USING ERRCODE = '22023';
    END IF;
    v_task_id := (v_move->>'task_id')::uuid;
    v_old := (v_move->>'old_due_at')::timestamptz;
    v_new := (v_move->>'new_due_at')::timestamptz;
    v_priority := (v_move->>'priority_score')::integer;
    v_comment := v_move->>'comment';
    v_comment_redacted := v_move->>'comment_redacted';
    IF v_task_id IS NULL OR v_old IS NULL OR v_new IS NULL OR v_priority IS NULL THEN
      RAISE EXCEPTION 'each move needs task_id, old_due_at, new_due_at and priority_score' USING ERRCODE = '22023';
    END IF;
    IF v_task_id = p_root_task_id THEN
      RAISE EXCEPTION 'the edited task is not one of its own moves' USING ERRCODE = '22023';
    END IF;
    IF v_new <= v_old THEN
      RAISE EXCEPTION 'a cascade only moves due dates later' USING ERRCODE = '22023';
    END IF;
    IF v_priority < 0 OR v_priority > 100 THEN
      RAISE EXCEPTION 'priority_score must be 0 to 100' USING ERRCODE = '22023';
    END IF;
    IF v_comment IS NULL OR char_length(btrim(v_comment)) NOT BETWEEN 1 AND 5000
       OR v_comment_redacted IS NULL OR char_length(btrim(v_comment_redacted)) NOT BETWEEN 1 AND 5000 THEN
      RAISE EXCEPTION 'each move needs both comment texts (1 to 5000 characters)' USING ERRCODE = '22023';
    END IF;
    IF v_move ? 'via' AND jsonb_typeof(v_move->'via') <> 'array' THEN
      RAISE EXCEPTION 'via must be an array of task ids' USING ERRCODE = '22023';
    END IF;
    IF v_move ? 'stakeholder_mentions' AND jsonb_typeof(v_move->'stakeholder_mentions') <> 'array' THEN
      RAISE EXCEPTION 'stakeholder_mentions must be an array' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'task_id') FROM jsonb_array_elements(p_moves)) <> jsonb_array_length(p_moves) THEN
    RAISE EXCEPTION 'a task appears twice in one cascade' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids
    FROM (
      SELECT (value->>'task_id')::uuid AS x FROM jsonb_array_elements(p_moves)
      UNION
      SELECT (v.value #>> '{}')::uuid FROM jsonb_array_elements(p_moves) m, jsonb_array_elements(COALESCE(m.value->'via', '[]'::jsonb)) v
    ) s;

  -- The lock protocol: projects, then the root + every task to move or walk past.
  PERFORM task_date_cascade_lock(p_user_id, array_append(COALESCE(v_ids, '{}'), p_root_task_id), p_scope);

  -- The root must still carry the date the caller just saved, and still be a
  -- task that cascades (not Done, not recurring).
  SELECT t.id, t.project_id, t.due_at
    INTO v_root
    FROM public.tasks t
   WHERE t.id = p_root_task_id
     AND t.user_id = p_user_id
     AND t.status <> 'Done'
     AND NOT COALESCE(t.is_recurring_template, false)
     AND t.recurring_template_id IS NULL
     AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)));

  IF v_root.id IS NULL OR v_root.due_at IS DISTINCT FROM p_root_new_due_at THEN
    RETURN jsonb_build_object(
      'status', 'superseded', 'cascade_id', NULL,
      'moved', '[]'::jsonb, 'skipped', '[]'::jsonb, 'project_flags', '[]'::jsonb
    );
  END IF;

  IF jsonb_array_length(p_moves) = 0 THEN
    RETURN jsonb_build_object(
      'status', 'nothing_moved', 'cascade_id', NULL,
      'moved', '[]'::jsonb, 'skipped', '[]'::jsonb, 'project_flags', '[]'::jsonb
    );
  END IF;

  -- Root visibility, read under the locks.
  SELECT (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)), t.title
    INTO v_root_visible, v_root_title
    FROM public.tasks t
   WHERE t.id = p_root_task_id AND t.user_id = p_user_id;
  v_root_visible := COALESCE(v_root_visible, false);
  IF p_scope = 'famcal' AND NOT v_root_visible THEN
    RETURN jsonb_build_object(
      'status', 'superseded', 'cascade_id', NULL,
      'moved', '[]'::jsonb, 'skipped', '[]'::jsonb, 'project_flags', '[]'::jsonb
    );
  END IF;
  v_name_ok := COALESCE(p_root_was_visible, false) AND v_root_visible AND v_root_title IS NOT DISTINCT FROM p_root_title;

  INSERT INTO public.task_date_cascades (user_id, root_task_id, root_old_due_at, root_new_due_at, mode, delta_workdays, scope, source, replaces_cascade_id)
  VALUES (p_user_id, p_root_task_id, p_root_old_due_at, p_root_new_due_at, p_mode, p_delta_workdays, p_scope, p_source, p_replaces_cascade_id)
  RETURNING id INTO v_cascade_id;

  FOR v_move IN
    SELECT value FROM jsonb_array_elements(p_moves) ORDER BY (value->>'task_id')::uuid
  LOOP
    v_task_id := (v_move->>'task_id')::uuid;
    v_old := (v_move->>'old_due_at')::timestamptz;
    v_new := (v_move->>'new_due_at')::timestamptz;

    -- The planned path must still hold: every task between this one and the
    -- edited task still exists, is still not Done/Missed/recurring and (FamCal)
    -- still visible.
    v_via := ARRAY(SELECT (v.value #>> '{}')::uuid FROM jsonb_array_elements(COALESCE(v_move->'via', '[]'::jsonb)) v);
    IF cardinality(v_via) > 0 THEN
      SELECT count(*) = cardinality(v_via) INTO v_path_ok
        FROM public.tasks t
       WHERE t.id = ANY (v_via)
         AND t.user_id = p_user_id
         AND t.status NOT IN ('Done', 'Missed')
         AND NOT COALESCE(t.is_recurring_template, false)
         AND t.recurring_template_id IS NULL
         AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)));
      IF NOT v_path_ok THEN
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('task_id', v_task_id, 'reason', 'path_changed'));
        CONTINUE;
      END IF;
    END IF;

    SELECT t.priority_score INTO v_old_priority FROM public.tasks t WHERE t.id = v_task_id AND t.user_id = p_user_id;

    UPDATE public.tasks t
       SET due_at = v_new,
           -- The new score was computed from the row as planned; keep the current
           -- one if any input of the score changed since (a later edit wins).
           priority_score = CASE
             WHEN public.task_date_cascade_score_unchanged(t.base_priority, t.status::text, t.title, t.stakeholder_mentions, v_move)
               THEN (v_move->>'priority_score')::integer
             ELSE t.priority_score
           END
     WHERE t.id = v_task_id
       AND t.user_id = p_user_id
       AND t.due_at = v_old
       AND t.status IN ('Backlog', 'Planned', 'In Progress', 'Blocked/Waiting')
       AND NOT COALESCE(t.is_recurring_template, false)
       AND t.recurring_template_id IS NULL
       AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)))
    RETURNING t.id, t.project_id,
              (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)) AS visible
         INTO v_updated;

    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('task_id', v_task_id, 'reason', 'changed'));
      CONTINUE;
    END IF;

    INSERT INTO public.task_comments (task_id, user_id, content, source)
    VALUES (
      v_task_id,
      p_user_id,
      btrim(CASE WHEN v_updated.visible AND NOT v_name_ok THEN v_move->>'comment_redacted' ELSE v_move->>'comment' END),
      'system'
    )
    RETURNING id INTO v_comment_id;

    INSERT INTO public.task_date_cascade_moves (cascade_id, user_id, task_id, old_due_at, new_due_at, old_priority_score, new_priority_score, comment_id)
    VALUES (v_cascade_id, p_user_id, v_task_id, v_old, v_new, v_old_priority,
            (SELECT t.priority_score FROM public.tasks t WHERE t.id = v_task_id), v_comment_id);

    v_moved := v_moved || jsonb_build_array(jsonb_build_object(
      'task_id', v_task_id, 'old_due_at', v_old, 'new_due_at', v_new, 'project_id', v_updated.project_id
    ));
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM public.task_date_cascades WHERE id = v_cascade_id;
    RETURN jsonb_build_object(
      'status', 'nothing_moved', 'cascade_id', NULL,
      'moved', '[]'::jsonb, 'skipped', v_skipped, 'project_flags', '[]'::jsonb
    );
  END IF;

  -- Projects a moved task now runs past (ET date after target_date).
  FOR v_project IN
    SELECT p.id, p.name, p.target_date,
           COALESCE(p.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AS personal,
           max((m.new_due_at AT TIME ZONE 'America/New_York')::date) AS latest,
           count(*)::integer AS n
      FROM public.task_date_cascade_moves m
      JOIN public.tasks t ON t.id = m.task_id AND t.user_id = p_user_id
      JOIN public.projects p ON p.id = t.project_id AND p.user_id = p_user_id
     WHERE m.cascade_id = v_cascade_id
       AND p.target_date IS NOT NULL
       AND (m.new_due_at AT TIME ZONE 'America/New_York')::date > p.target_date
     GROUP BY p.id, p.name, p.target_date, p.tags
     ORDER BY p.name, p.id
  LOOP
    SELECT p.rag::text INTO v_rag_before FROM public.projects p WHERE p.id = v_project.id AND p.user_id = p_user_id FOR NO KEY UPDATE;
    v_rag_after := v_rag_before;
    v_rag_set_at := NULL;
    IF v_rag_before = 'Green' THEN
      UPDATE public.projects SET rag = 'Yellow' WHERE id = v_project.id AND user_id = p_user_id
      RETURNING updated_at INTO v_rag_set_at;
      v_rag_after := 'Yellow';
    END IF;

    v_flags := v_flags || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'project_id', v_project.id,
      'name', v_project.name,
      'target_date', v_project.target_date,
      'latest_due_date', v_project.latest,
      'tasks_past_target', v_project.n,
      'rag_before', v_rag_before,
      'rag_after', v_rag_after,
      'rag_set_at', v_rag_set_at
    )));

    -- A FamCal-visible root never carries anything about a work project.
    IF NOT (v_root_visible AND NOT v_project.personal) THEN
      INSERT INTO public.task_comments (task_id, user_id, content, source)
      VALUES (
        p_root_task_id,
        p_user_id,
        'Moving this task pushed ' || v_project.n || CASE WHEN v_project.n = 1 THEN ' task' ELSE ' tasks' END
          || ' in "' || v_project.name || '" past the project''s target date ('
          || to_char(v_project.target_date, 'Dy FMMM/FMDD') || '; latest now '
          || to_char(v_project.latest, 'Dy FMMM/FMDD') || ')'
          || CASE WHEN v_rag_before = 'Green' THEN '. The project went from Green to Yellow.' ELSE '.' END,
        'system'
      );
    END IF;
  END LOOP;

  UPDATE public.task_date_cascades SET moved_count = v_count, project_flags = v_flags WHERE id = v_cascade_id;

  RETURN jsonb_build_object(
    'status', 'moved',
    'cascade_id', v_cascade_id,
    'moved', v_moved,
    'skipped', v_skipped,
    'project_flags', v_flags
  );
END;
$$;

COMMENT ON FUNCTION task_date_cascade_apply_core(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN, UUID) IS
  'Applies a planned due-date cascade under the 062 lock protocol: root re-check, path + compare-and-set per task, system comments, project flags, log (062).';

-- 061's signature, same arguments and reply; now under the lock protocol.
CREATE OR REPLACE FUNCTION apply_task_date_cascade(
  p_user_id UUID,
  p_root_task_id UUID,
  p_root_old_due_at TIMESTAMPTZ,
  p_root_new_due_at TIMESTAMPTZ,
  p_mode TEXT,
  p_delta_workdays INTEGER,
  p_scope TEXT,
  p_source TEXT,
  p_moves JSONB,
  p_root_title TEXT,
  p_root_was_visible BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
BEGIN
  RETURN public.task_date_cascade_apply_core(
    p_user_id, p_root_task_id, p_root_old_due_at, p_root_new_due_at, p_mode, p_delta_workdays,
    p_scope, p_source, p_moves, p_root_title, p_root_was_visible, NULL
  );
END;
$$;

COMMENT ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) IS
  'Applies a planned due-date cascade in one transaction (061 signature; 062 lock protocol via task_date_cascade_apply_core).';

-- ── 3. Undo ──────────────────────────────────────────────────────────────

-- Puts back the dependents of one cascade (locks already taken by the caller, or
-- taken here). p_restore: [{task_id, priority_score, base_priority, status, title,
-- stakeholder_mentions}] (the score the app computed for the old date and what it
-- was computed from).
CREATE OR REPLACE FUNCTION task_date_cascade_undo_core(
  p_user_id UUID,
  p_cascade_id UUID,
  p_restore JSONB,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cascade RECORD;
  v_move RECORD;
  v_planned JSONB;
  v_updated RECORD;
  v_comment_id UUID;
  v_restored JSONB := '[]'::jsonb;
  v_kept JSONB := '[]'::jsonb;
  v_projects JSONB := '[]'::jsonb;
  v_flag JSONB;
  v_project RECORD;
  v_ids UUID[];
  v_flag_projects UUID[];
  v_kept_in_project BOOLEAN;
  v_now_due TIMESTAMPTZ;
  v_why TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot move tasks for another user' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('undo', 'replaced') THEN
    RAISE EXCEPTION 'reason must be undo or replaced' USING ERRCODE = '22023';
  END IF;
  IF p_restore IS NOT NULL AND jsonb_typeof(p_restore) <> 'array' THEN
    RAISE EXCEPTION 'restore must be an array' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_cascade FROM public.task_date_cascades c WHERE c.id = p_cascade_id AND c.user_id = p_user_id;
  IF v_cascade.id IS NULL THEN
    RAISE EXCEPTION 'cascade not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT array_agg(m.task_id ORDER BY m.task_id) INTO v_ids FROM public.task_date_cascade_moves m WHERE m.cascade_id = p_cascade_id;
  SELECT array_agg(DISTINCT (f->>'project_id')::uuid) INTO v_flag_projects
    FROM jsonb_array_elements(COALESCE(v_cascade.project_flags, '[]'::jsonb)) f
   WHERE f ? 'project_id';
  PERFORM public.task_date_cascade_lock(p_user_id, array_append(COALESCE(v_ids, '{}'), v_cascade.root_task_id), 'all', COALESCE(v_flag_projects, '{}'));

  -- Re-read under the locks: a concurrent undo may have won.
  SELECT c.* INTO v_cascade FROM public.task_date_cascades c WHERE c.id = p_cascade_id AND c.user_id = p_user_id FOR UPDATE;
  IF v_cascade.undone_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_undone', 'cascade_id', p_cascade_id,
      'restored', '[]'::jsonb, 'kept', '[]'::jsonb, 'projects', '[]'::jsonb);
  END IF;

  FOR v_move IN
    SELECT m.* FROM public.task_date_cascade_moves m WHERE m.cascade_id = p_cascade_id ORDER BY m.task_id
  LOOP
    SELECT r.value INTO v_planned
      FROM jsonb_array_elements(COALESCE(p_restore, '[]'::jsonb)) r
     WHERE r.value->>'task_id' = v_move.task_id::text
     LIMIT 1;

    UPDATE public.tasks t
       SET due_at = v_move.old_due_at,
           priority_score = CASE
             WHEN v_planned IS NOT NULL
              AND (v_planned->>'priority_score') IS NOT NULL
              AND (v_planned->>'priority_score')::integer BETWEEN 0 AND 100
              AND public.task_date_cascade_score_unchanged(t.base_priority, t.status::text, t.title, t.stakeholder_mentions, v_planned)
               THEN (v_planned->>'priority_score')::integer
             ELSE t.priority_score
           END
     WHERE t.id = v_move.task_id
       AND t.user_id = p_user_id
       AND t.due_at = v_move.new_due_at
    RETURNING t.id, t.project_id INTO v_updated;

    IF FOUND THEN
      INSERT INTO public.task_comments (task_id, user_id, content, source)
      VALUES (
        v_move.task_id,
        p_user_id,
        'Due date moved back from ' || to_char(v_move.new_due_at AT TIME ZONE 'America/New_York', 'Dy FMMM/FMDD')
          || ' to ' || to_char(v_move.old_due_at AT TIME ZONE 'America/New_York', 'Dy FMMM/FMDD')
          || ' because the change that moved it was '
          || CASE WHEN p_reason = 'replaced' THEN 'replaced.' ELSE 'undone.' END,
        'system'
      )
      RETURNING id INTO v_comment_id;
      UPDATE public.task_date_cascade_moves SET restored_at = now(), restore_comment_id = v_comment_id WHERE id = v_move.id;
      v_restored := v_restored || jsonb_build_array(jsonb_build_object(
        'task_id', v_move.task_id, 'from_due_at', v_move.new_due_at, 'to_due_at', v_move.old_due_at, 'project_id', v_updated.project_id
      ));
    ELSE
      SELECT t.due_at INTO v_now_due FROM public.tasks t WHERE t.id = v_move.task_id AND t.user_id = p_user_id;
      v_kept := v_kept || jsonb_build_array(jsonb_build_object(
        'task_id', v_move.task_id, 'due_at', v_now_due, 'cascade_due_at', v_move.new_due_at,
        'project_id', (SELECT t.project_id FROM public.tasks t WHERE t.id = v_move.task_id AND t.user_id = p_user_id)
      ));
    END IF;
  END LOOP;

  UPDATE public.task_date_cascades SET undone_at = now(), undone_reason = p_reason WHERE id = p_cascade_id;

  -- Health (Brent 10/20): back to Green only if this cascade turned it Yellow,
  -- nothing changed on the project since, and every task of it was put back.
  FOR v_flag IN SELECT value FROM jsonb_array_elements(COALESCE(v_cascade.project_flags, '[]'::jsonb)) LOOP
    CONTINUE WHEN NOT (v_flag->>'rag_before' = 'Green' AND v_flag->>'rag_after' = 'Yellow');
    SELECT p.id, p.name, p.rag::text AS rag, p.updated_at INTO v_project
      FROM public.projects p WHERE p.id = (v_flag->>'project_id')::uuid AND p.user_id = p_user_id FOR NO KEY UPDATE;
    CONTINUE WHEN v_project.id IS NULL;
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_kept) k WHERE k.value->>'project_id' = v_project.id::text
    ) INTO v_kept_in_project;
    v_why := CASE
      WHEN v_project.rag <> 'Yellow' THEN 'changed_since'
      WHEN NOT (v_flag ? 'rag_set_at') OR v_project.updated_at IS DISTINCT FROM (v_flag->>'rag_set_at')::timestamptz THEN 'changed_since'
      WHEN v_kept_in_project THEN 'tasks_kept'
      ELSE NULL
    END;
    IF v_why IS NULL THEN
      UPDATE public.projects SET rag = 'Green' WHERE id = v_project.id AND user_id = p_user_id;
    END IF;
    v_projects := v_projects || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'project_id', v_project.id, 'name', v_project.name,
      'rag_before', v_project.rag, 'rag_after', CASE WHEN v_why IS NULL THEN 'Green' ELSE v_project.rag END,
      'kept_reason', v_why
    )));
  END LOOP;

  RETURN jsonb_build_object('status', 'undone', 'cascade_id', p_cascade_id,
    'restored', v_restored, 'kept', v_kept, 'projects', v_projects);
END;
$$;

COMMENT ON FUNCTION task_date_cascade_undo_core(UUID, UUID, JSONB, TEXT) IS
  'Puts back the tasks one cascade moved, where their due date still equals what it set; health rule; marks the cascade undone (062).';

-- Undo from the app or MCP: the dependents of p_cascade_id (when given and not yet
-- undone) and, with p_restore_root, the edited task itself (only while it still has
-- the date the edit set). With a cascade id the dates come from its log row; without
-- one (a "just this task" change) from p_root_expected_due_at / p_root_restore_due_at.
CREATE OR REPLACE FUNCTION undo_task_date_cascade(
  p_user_id UUID,
  p_root_task_id UUID,
  p_cascade_id UUID,
  p_root_expected_due_at TIMESTAMPTZ,
  p_root_restore_due_at TIMESTAMPTZ,
  p_restore_root BOOLEAN,
  p_root_priority JSONB,
  p_restore JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cascade RECORD;
  v_expected TIMESTAMPTZ;
  v_restore TIMESTAMPTZ;
  v_ids UUID[];
  v_flag_projects UUID[];
  v_undo JSONB := NULL;
  v_root_restored BOOLEAN := false;
  v_root_due TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL OR p_root_task_id IS NULL THEN
    RAISE EXCEPTION 'user id and root task id are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot move tasks for another user' USING ERRCODE = '42501';
  END IF;
  IF p_root_priority IS NOT NULL AND jsonb_typeof(p_root_priority) <> 'object' THEN
    RAISE EXCEPTION 'root priority must be an object' USING ERRCODE = '22023';
  END IF;

  IF p_cascade_id IS NOT NULL THEN
    SELECT c.* INTO v_cascade FROM public.task_date_cascades c
     WHERE c.id = p_cascade_id AND c.user_id = p_user_id AND c.root_task_id = p_root_task_id;
    IF v_cascade.id IS NULL THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    v_expected := v_cascade.root_new_due_at;
    v_restore := v_cascade.root_old_due_at;
    SELECT array_agg(m.task_id) INTO v_ids FROM public.task_date_cascade_moves m WHERE m.cascade_id = p_cascade_id;
    SELECT array_agg(DISTINCT (f->>'project_id')::uuid) INTO v_flag_projects
      FROM jsonb_array_elements(COALESCE(v_cascade.project_flags, '[]'::jsonb)) f WHERE f ? 'project_id';
  ELSE
    IF COALESCE(p_restore_root, false) AND p_root_expected_due_at IS NULL THEN
      RAISE EXCEPTION 'the date the edit set is required' USING ERRCODE = '22023';
    END IF;
    v_expected := p_root_expected_due_at;
    v_restore := p_root_restore_due_at;
  END IF;

  PERFORM public.task_date_cascade_lock(p_user_id, array_append(COALESCE(v_ids, '{}'), p_root_task_id), 'all', COALESCE(v_flag_projects, '{}'));

  IF p_cascade_id IS NOT NULL THEN
    v_undo := public.task_date_cascade_undo_core(p_user_id, p_cascade_id, p_restore, 'undo');
  END IF;

  IF COALESCE(p_restore_root, false) THEN
    UPDATE public.tasks t
       SET due_at = v_restore,
           priority_score = CASE
             WHEN p_root_priority IS NOT NULL
              AND (p_root_priority->>'priority_score') IS NOT NULL
              AND (p_root_priority->>'priority_score')::integer BETWEEN 0 AND 100
              AND public.task_date_cascade_score_unchanged(t.base_priority, t.status::text, t.title, t.stakeholder_mentions, p_root_priority)
               THEN (p_root_priority->>'priority_score')::integer
             ELSE t.priority_score
           END
     WHERE t.id = p_root_task_id
       AND t.user_id = p_user_id
       AND t.due_at IS NOT DISTINCT FROM v_expected
       AND v_expected IS NOT NULL;
    v_root_restored := FOUND;
  END IF;

  SELECT t.due_at INTO v_root_due FROM public.tasks t WHERE t.id = p_root_task_id AND t.user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'undone',
    'cascade', v_undo,
    'root', jsonb_build_object(
      'task_id', p_root_task_id,
      'restored', v_root_restored,
      'due_at', v_root_due,
      'restore_due_at', v_restore,
      'expected_due_at', v_expected
    )
  );
END;
$$;

COMMENT ON FUNCTION undo_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, JSONB, JSONB) IS
  'Undo of one date change (062): the dependents a cascade moved (where unchanged since) and optionally the edited task, one transaction.';

-- ── 4. Replace (switch how far / try again) ──────────────────────────────

CREATE OR REPLACE FUNCTION replace_task_date_cascade(
  p_user_id UUID,
  p_root_task_id UUID,
  p_replace_cascade_id UUID,
  p_root_old_due_at TIMESTAMPTZ,
  p_root_new_due_at TIMESTAMPTZ,
  p_mode TEXT,
  p_delta_workdays INTEGER,
  p_source TEXT,
  p_moves JSONB,
  p_root_title TEXT,
  p_root_was_visible BOOLEAN,
  p_restore JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cascade RECORD;
  v_ids UUID[];
  v_flag_projects UUID[];
  v_root RECORD;
  v_undo JSONB := NULL;
  v_apply JSONB := NULL;
BEGIN
  IF p_user_id IS NULL OR p_root_task_id IS NULL OR p_root_new_due_at IS NULL THEN
    RAISE EXCEPTION 'user id, root task id and root due date are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot move tasks for another user' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('same_gap', 'only_collisions') THEN
    RAISE EXCEPTION 'mode must be same_gap, only_collisions or null (just this task)' USING ERRCODE = '22023';
  END IF;
  IF p_moves IS NOT NULL AND jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'moves must be an array' USING ERRCODE = '22023';
  END IF;

  IF p_replace_cascade_id IS NOT NULL THEN
    SELECT c.* INTO v_cascade FROM public.task_date_cascades c
     WHERE c.id = p_replace_cascade_id AND c.user_id = p_user_id AND c.root_task_id = p_root_task_id;
    IF v_cascade.id IS NULL THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    SELECT array_agg(m.task_id) INTO v_ids FROM public.task_date_cascade_moves m WHERE m.cascade_id = p_replace_cascade_id;
    SELECT array_agg(DISTINCT (f->>'project_id')::uuid) INTO v_flag_projects
      FROM jsonb_array_elements(COALESCE(v_cascade.project_flags, '[]'::jsonb)) f WHERE f ? 'project_id';
  END IF;

  SELECT array_cat(COALESCE(v_ids, '{}'), COALESCE(array_agg(DISTINCT x), '{}')) INTO v_ids
    FROM (
      SELECT (value->>'task_id')::uuid AS x FROM jsonb_array_elements(COALESCE(p_moves, '[]'::jsonb))
      UNION
      SELECT (v.value #>> '{}')::uuid FROM jsonb_array_elements(COALESCE(p_moves, '[]'::jsonb)) m, jsonb_array_elements(COALESCE(m.value->'via', '[]'::jsonb)) v
    ) s;

  PERFORM public.task_date_cascade_lock(p_user_id, array_append(COALESCE(v_ids, '{}'), p_root_task_id), 'all', COALESCE(v_flag_projects, '{}'));

  IF p_replace_cascade_id IS NOT NULL THEN
    -- Read again under the locks (a concurrent undo or switch may have won).
    SELECT c.* INTO v_cascade FROM public.task_date_cascades c
     WHERE c.id = p_replace_cascade_id AND c.user_id = p_user_id AND c.root_task_id = p_root_task_id;
  END IF;

  -- The edited task must still have the date the edit set (else another edit won).
  SELECT t.id, t.due_at INTO v_root
    FROM public.tasks t
   WHERE t.id = p_root_task_id AND t.user_id = p_user_id
     AND t.status <> 'Done' AND NOT COALESCE(t.is_recurring_template, false) AND t.recurring_template_id IS NULL;
  IF v_root.id IS NULL OR v_root.due_at IS DISTINCT FROM p_root_new_due_at THEN
    RETURN jsonb_build_object('status', 'superseded', 'undo', NULL, 'apply', NULL);
  END IF;

  IF p_replace_cascade_id IS NOT NULL THEN
    IF v_cascade.undone_at IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'stale', 'undo', NULL, 'apply', NULL);
    END IF;
    v_undo := public.task_date_cascade_undo_core(p_user_id, p_replace_cascade_id, p_restore, 'replaced');
    IF v_undo->>'status' <> 'undone' THEN
      -- A concurrent undo won: nothing else changes.
      RAISE EXCEPTION 'the cascade was already undone' USING ERRCODE = 'MC063';
    END IF;
  END IF;

  IF p_mode IS NOT NULL THEN
    v_apply := public.task_date_cascade_apply_core(
      p_user_id, p_root_task_id, p_root_old_due_at, p_root_new_due_at, p_mode, COALESCE(p_delta_workdays, 0),
      'all', p_source, COALESCE(p_moves, '[]'::jsonb), p_root_title, p_root_was_visible, p_replace_cascade_id
    );
  END IF;

  RETURN jsonb_build_object('status', 'replaced', 'undo', v_undo, 'apply', v_apply);
END;
$$;

COMMENT ON FUNCTION replace_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, JSONB, TEXT, BOOLEAN, JSONB) IS
  'Switch how far a cascade went, or try a failed one again (062): undo the replaced cascade and apply the new plan in one transaction.';

-- ── Grants ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION task_date_cascade_lock(UUID, UUID[], TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_date_cascade_lock(UUID, UUID[], TEXT, UUID[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION task_date_cascade_score_unchanged(INTEGER, TEXT, TEXT, TEXT[], JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_date_cascade_score_unchanged(INTEGER, TEXT, TEXT, TEXT[], JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION task_date_cascade_apply_core(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_date_cascade_apply_core(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN, UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO authenticated, service_role;
REVOKE ALL ON FUNCTION task_date_cascade_undo_core(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_date_cascade_undo_core(UUID, UUID, JSONB, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION undo_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION undo_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, JSONB, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION replace_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, JSONB, TEXT, BOOLEAN, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION replace_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, JSONB, TEXT, BOOLEAN, JSONB) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
