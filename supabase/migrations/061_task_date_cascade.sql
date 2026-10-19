-- 061: cascade due dates (Baseline task 6fcad51b, slice S1) + a database loop guard
-- for task dependencies (S0 follow-up P2-4).
--
-- 1. Loop guard. A BEFORE INSERT/UPDATE trigger on task_dependencies refuses an
--    active task -> task link that would close a loop ("A waits on B" while B
--    already reaches A over the same user's active links), with SQLSTATE MC061.
--    It first takes a per-user transaction advisory lock (task_graph_lock_key), so
--    two adds for the same user run one after the other: the second one's check is
--    a new statement (READ COMMITTED), so it sees the first one once that commits.
--    That closes the race the app-side check (findDependencyPath) can't: two
--    opposite adds at the same moment, or a link inserted behind the app's paging
--    cursor. Self links stay refused by task_dependencies_no_self_task (013).
--    Existing loops in the data are left alone (the cascade planner visits each
--    task once, so they can't spin it).
--
-- 2. Cascade log: task_date_cascades (one row per cascade that moved anything:
--    the edited task's old/new due date, mode, working-day gap, scope, who sent it,
--    project flags, undone_at) and task_date_cascade_moves (each moved task's
--    old/new due date and priority, and its system comment). Undo (S2) restores
--    only tasks whose due date still equals new_due_at; no further schema change
--    is needed for it.
--
-- 3. apply_task_date_cascade(...): applies a plan made in TypeScript
--    (src/lib/task-date-cascade.ts) in ONE transaction, all or nothing:
--    - takes the same per-user advisory lock (cascades and link adds serialize);
--    - re-checks that the edited ("root") task still has the due date the caller
--      just saved and is still not Done or recurring; otherwise nothing moves
--      (status "superseded"). (The API's own root UPDATE is a compare-and-set on
--      the date the plan was made from, so two overlapping edits can't stack.);
--    - locks the tasks to move in id order (FOR UPDATE; with scope 'famcal' only
--      rows that are FamCal-eligible in that same read, so an ineligible task is
--      never waited on or written), then the root's and the targets' PROJECTS
--      FOR SHARE in id order (060's order: task, then project), and reads root
--      eligibility again under those locks, so a project re-tag either committed
--      first or waits;
--    - per task, a compare-and-set: due_at must still equal the planned old date,
--      the task must still be open (Backlog/Planned/In Progress/Blocked/Waiting)
--      and not recurring, and with scope 'famcal' still personal + eligible. A
--      task that changed meanwhile is skipped and reported, never overwritten;
--    - writes one source='system' comment per moved task. The caller sends two
--      texts; on a FamCal-eligible moved task the function uses the redacted one
--      ("... because a task it depends on moved later.", no title, date or gap)
--      unless the root was FamCal-visible when planned (p_root_was_visible) AND
--      under the locks now AND its title still equals p_root_title (the title
--      the named text carries), so a personal task's comments never name a work
--      task, including one renamed and re-tagged in the same edit;
--    - keeps a moved task's current priority_score when its base_priority changed
--      since planning (the move carries the base the new score came from);
--    - projects whose target date a moved task now passes (ET date after
--      target_date): RAG Green -> Yellow (Yellow and Red untouched; target_date and
--      status_summary never written), one system comment on the root (none at all
--      when the root is FamCal-visible and the project is not personal: nothing of
--      a work project reaches FamCal), and a project_flags entry in the reply;
--    - returns { status, cascade_id, moved[], skipped[], project_flags[] }.
--    Waits are bounded by lock_timeout 5s (55P03). SECURITY INVOKER: a signed-in
--    user may only pass their own id (RLS applies); the API's machine keys call it
--    on the service-role client scoped by p_user_id.
--
-- famcal_eligible(tasks) (060) is now also executable by `authenticated`: the
-- function above calls it under the app session. It only evaluates the caller's
-- own rows (RLS), so this exposes nothing new.
--
-- Rollback: supabase/rollbacks/061_task_date_cascade.down.sql.

BEGIN;

-- ── 1. Loop guard ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION task_graph_lock_key(p_user_id UUID)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT hashtextextended('baseline.task_graph:' || p_user_id::text, 61);
$$;

COMMENT ON FUNCTION task_graph_lock_key(UUID) IS
  'Per-user advisory lock key (061) shared by the task_dependencies loop guard and apply_task_date_cascade.';

CREATE OR REPLACE FUNCTION task_dependencies_guard_loop()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_loop BOOLEAN;
BEGIN
  IF NEW.is_resolved OR NEW.depends_on_task_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- An active link that stays the same link (e.g. a touch of another column) is fine.
  IF TG_OP = 'UPDATE'
     AND NOT OLD.is_resolved
     AND OLD.user_id = NEW.user_id
     AND OLD.task_id = NEW.task_id
     AND OLD.depends_on_task_id IS NOT DISTINCT FROM NEW.depends_on_task_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(task_graph_lock_key(NEW.user_id));

  -- New statement after the lock: under READ COMMITTED it sees every link
  -- committed before the lock was granted. UNION (not UNION ALL) ends the walk on
  -- loops already in the data.
  WITH RECURSIVE reach(task_id) AS (
    SELECT NEW.depends_on_task_id
    UNION
    SELECT d.depends_on_task_id
      FROM reach r
      JOIN public.task_dependencies d ON d.task_id = r.task_id
     WHERE d.user_id = NEW.user_id
       AND d.is_resolved = false
       AND d.depends_on_task_id IS NOT NULL
       AND d.id <> NEW.id
  )
  SELECT EXISTS (SELECT 1 FROM reach WHERE reach.task_id = NEW.task_id) INTO v_loop;

  IF v_loop THEN
    RAISE EXCEPTION 'That link would make a loop: the other task already waits on this one, directly or through other tasks'
      USING ERRCODE = 'MC061', HINT = 'task_dependency_loop';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION task_dependencies_guard_loop() IS
  'Refuses an active task->task link that would close a loop (061, SQLSTATE MC061), serialized per user.';

DROP TRIGGER IF EXISTS trg_task_dependencies_guard_loop ON task_dependencies;
CREATE TRIGGER trg_task_dependencies_guard_loop
  BEFORE INSERT OR UPDATE OF is_resolved, task_id, depends_on_task_id, user_id ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION task_dependencies_guard_loop();

-- ── 2. Cascade log ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_date_cascades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  root_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  root_old_due_at TIMESTAMPTZ,
  root_new_due_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('same_gap', 'only_collisions')),
  delta_workdays INTEGER NOT NULL CHECK (delta_workdays >= 0),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'famcal')),
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 40),
  moved_count INTEGER NOT NULL DEFAULT 0 CHECK (moved_count >= 0),
  project_flags JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(project_flags) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_date_cascades_user_created ON task_date_cascades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_date_cascades_root ON task_date_cascades(root_task_id);

CREATE TABLE IF NOT EXISTS task_date_cascade_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cascade_id UUID NOT NULL REFERENCES task_date_cascades(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_due_at TIMESTAMPTZ NOT NULL,
  new_due_at TIMESTAMPTZ NOT NULL,
  old_priority_score INTEGER,
  new_priority_score INTEGER,
  comment_id UUID REFERENCES task_comments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_date_cascade_moves_later CHECK (new_due_at > old_due_at),
  CONSTRAINT task_date_cascade_moves_once UNIQUE (cascade_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_date_cascade_moves_task ON task_date_cascade_moves(task_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON task_date_cascades, task_date_cascade_moves TO authenticated, service_role;

ALTER TABLE task_date_cascades ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_date_cascade_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own task_date_cascades" ON task_date_cascades;
CREATE POLICY "Users can view own task_date_cascades"
  ON task_date_cascades FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own task_date_cascades" ON task_date_cascades;
CREATE POLICY "Users can insert own task_date_cascades"
  ON task_date_cascades FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own task_date_cascades" ON task_date_cascades;
CREATE POLICY "Users can update own task_date_cascades"
  ON task_date_cascades FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own task_date_cascades" ON task_date_cascades;
CREATE POLICY "Users can delete own task_date_cascades"
  ON task_date_cascades FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own task_date_cascade_moves" ON task_date_cascade_moves;
CREATE POLICY "Users can view own task_date_cascade_moves"
  ON task_date_cascade_moves FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own task_date_cascade_moves" ON task_date_cascade_moves;
CREATE POLICY "Users can insert own task_date_cascade_moves"
  ON task_date_cascade_moves FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own task_date_cascade_moves" ON task_date_cascade_moves;
CREATE POLICY "Users can update own task_date_cascade_moves"
  ON task_date_cascade_moves FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own task_date_cascade_moves" ON task_date_cascade_moves;
CREATE POLICY "Users can delete own task_date_cascade_moves"
  ON task_date_cascade_moves FOR DELETE USING (auth.uid() = user_id);

-- ── 3. Apply function ─────────────────────────────────────────────────────

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

REVOKE ALL ON FUNCTION task_graph_lock_key(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_graph_lock_key(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_task_date_cascade(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION famcal_eligible(tasks) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
