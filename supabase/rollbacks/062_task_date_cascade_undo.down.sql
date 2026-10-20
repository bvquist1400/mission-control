-- Rollback for 062_task_date_cascade_undo.sql: drops the undo / replace / lock /
-- current-identity functions and the columns 062 added, and puts back 061's
-- apply_task_date_cascade body (same 11 arguments, 061's lock order) and its grants.
--
-- ORDER (deploy contract): roll the S2 APP back FIRST, then run this. The S2 app
-- sends 062's move fields (status, title, stakeholder_mentions, via) to
-- apply_task_date_cascade on every cascade; 061's body refuses them (22023
-- "unknown move field"), so with this rollback applied under the S2 app EVERY date
-- move that should cascade saves only the edited task, moves nothing else, answers
-- cascade.status "failed" and leaves a "could not be moved" comment on the task;
-- Undo / switch / Try again fail too. Likewise 062 must be live before the S2 app
-- is deployed.
--
-- Data: dates that an Undo or a switch put back stay where they are, and the
-- "moved back" system comments stay (ordinary task_comments rows). The log loses
-- replaces_cascade_id, undone_reason, restored_at and restore_comment_id; undone_at
-- (061) stays, and so do log rows with no moves that only recorded the edited
-- task's own target-date flag (061 never reads them). A project 062 turned Yellow
-- stays Yellow. Re-running is safe.

BEGIN;

DROP FUNCTION IF EXISTS replace_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, JSONB, TEXT, BOOLEAN, JSONB);
DROP FUNCTION IF EXISTS undo_task_date_cascade(UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, JSONB, JSONB);
DROP FUNCTION IF EXISTS task_date_cascade_undo_core(UUID, UUID, JSONB, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS task_date_cascade_undo_core(UUID, UUID, JSONB, TEXT);
DROP FUNCTION IF EXISTS task_date_cascade_current(UUID, UUID, TIMESTAMPTZ);

-- 061's apply function, verbatim (it no longer calls the 062 core).
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
  v_name_ok BOOLEAN;
  v_root_title TEXT;
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
       WHERE k.key NOT IN ('task_id', 'old_due_at', 'new_due_at', 'priority_score', 'base_priority', 'comment', 'comment_redacted')
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
  END LOOP;
  IF (SELECT count(DISTINCT value->>'task_id') FROM jsonb_array_elements(p_moves)) <> jsonb_array_length(p_moves) THEN
    RAISE EXCEPTION 'a task appears twice in one cascade' USING ERRCODE = '22023';
  END IF;

  -- One cascade (or link add) per user at a time.
  PERFORM pg_advisory_xact_lock(task_graph_lock_key(p_user_id));

  -- The root must still carry the date the caller just saved, and still be a
  -- task that cascades (not Done, not recurring). Locked FOR SHARE: its tags,
  -- project and title can't change until this commits.
  SELECT t.id, t.project_id, t.due_at
    INTO v_root
    FROM public.tasks t
   WHERE t.id = p_root_task_id
     AND t.user_id = p_user_id
     AND t.status <> 'Done'
     AND NOT COALESCE(t.is_recurring_template, false)
     AND t.recurring_template_id IS NULL
     AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)))
     FOR SHARE OF t;

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

  -- Lock the targets in id order (FamCal: only rows eligible in this same read).
  SELECT array_agg(x ORDER BY x) INTO v_ids
    FROM (SELECT DISTINCT (value->>'task_id')::uuid AS x FROM jsonb_array_elements(p_moves)) s;
  PERFORM 1
     FROM public.tasks t
    WHERE t.id = ANY (v_ids)
      AND t.user_id = p_user_id
      AND (p_scope <> 'famcal' OR (COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[] AND public.famcal_eligible(t)))
    ORDER BY t.id
      FOR UPDATE OF t;

  -- Eligibility also depends on the PROJECT's tags (060 locks the project for
  -- the same reason). Lock the root's and the targets' projects FOR SHARE, in id
  -- order, after the task rows (060's order: task, then project), so a project
  -- re-tag either commits before these reads or waits until this commits.
  PERFORM 1
     FROM public.projects p
    WHERE p.user_id = p_user_id
      AND p.id IN (
        SELECT t.project_id FROM public.tasks t
         WHERE t.user_id = p_user_id
           AND t.project_id IS NOT NULL
           AND (t.id = p_root_task_id OR t.id = ANY (v_ids))
      )
    ORDER BY p.id
      FOR SHARE OF p;

  -- Root visibility, read again under all those locks (a new statement, so it
  -- sees a re-tag that committed while this waited).
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
  -- The edited task may be named on a FamCal-visible task only when FamCal could
  -- read it both when the plan was made and now, and the comment carries the
  -- title it has now (a rename in the same edit can't publish the old title).
  v_name_ok := COALESCE(p_root_was_visible, false) AND v_root_visible AND v_root_title IS NOT DISTINCT FROM p_root_title;

  INSERT INTO public.task_date_cascades (user_id, root_task_id, root_old_due_at, root_new_due_at, mode, delta_workdays, scope, source)
  VALUES (p_user_id, p_root_task_id, p_root_old_due_at, p_root_new_due_at, p_mode, p_delta_workdays, p_scope, p_source)
  RETURNING id INTO v_cascade_id;

  FOR v_move IN
    SELECT value FROM jsonb_array_elements(p_moves) ORDER BY (value->>'task_id')::uuid
  LOOP
    v_task_id := (v_move->>'task_id')::uuid;
    v_old := (v_move->>'old_due_at')::timestamptz;
    v_new := (v_move->>'new_due_at')::timestamptz;

    SELECT t.priority_score INTO v_old_priority FROM public.tasks t WHERE t.id = v_task_id AND t.user_id = p_user_id;

    UPDATE public.tasks t
       SET due_at = v_new,
           -- The new score was computed from the row as planned; keep the current
           -- one if its base priority changed since (a later edit wins).
           priority_score = CASE
             WHEN v_move ? 'base_priority' AND t.base_priority IS DISTINCT FROM (v_move->>'base_priority')::integer
               THEN t.priority_score
             ELSE (v_move->>'priority_score')::integer
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
    SELECT p.rag::text INTO v_rag_before FROM public.projects p WHERE p.id = v_project.id AND p.user_id = p_user_id FOR UPDATE;
    v_rag_after := v_rag_before;
    IF v_rag_before = 'Green' THEN
      UPDATE public.projects SET rag = 'Yellow' WHERE id = v_project.id AND user_id = p_user_id;
      v_rag_after := 'Yellow';
    END IF;

    v_flags := v_flags || jsonb_build_array(jsonb_build_object(
      'project_id', v_project.id,
      'name', v_project.name,
      'target_date', v_project.target_date,
      'latest_due_date', v_project.latest,
      'tasks_past_target', v_project.n,
      'rag_before', v_rag_before,
      'rag_after', v_rag_after
    ));

    -- A FamCal-visible root never carries anything about a work project (no
    -- name, count, dates or RAG); the caller's reply still lists the flag.
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

COMMENT ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) IS
  'Applies a planned due-date cascade in one transaction: root re-check, compare-and-set per task, system comments, project flags, log (061).';

DROP FUNCTION IF EXISTS task_date_cascade_apply_core(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS task_date_cascade_score_unchanged(INTEGER, TEXT, TEXT, TEXT[], JSONB);
DROP FUNCTION IF EXISTS task_date_cascade_lock(UUID, UUID[], TEXT, UUID[]);

REVOKE ALL ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO authenticated, service_role;

ALTER TABLE task_date_cascade_moves
  DROP COLUMN IF EXISTS restore_comment_id,
  DROP COLUMN IF EXISTS restored_at;
ALTER TABLE task_date_cascades
  DROP COLUMN IF EXISTS undone_reason,
  DROP COLUMN IF EXISTS replaces_cascade_id;

COMMIT;

NOTIFY pgrst, 'reload schema';
