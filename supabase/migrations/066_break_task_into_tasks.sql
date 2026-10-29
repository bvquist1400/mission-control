-- 066: "Break into tasks" (Baseline task d1f7e622, mockup 3a320c1c).
--
-- Brent 10/29: "build "Break into tasks" with the umbrella (original stays open,
-- Today counts the new tasks) and keep finished steps as Done."
--
-- A task's checklist steps become real tasks in one transaction. The original
-- task stays open as an UMBRELLA: its progress (Today's card fill, "4/6 tasks",
-- the lit Done button, the Portfolio credit) is counted from the new tasks.
--
-- 1. tasks.parent_task_id (new, nullable, additive): the umbrella a task was
--    broken out of. FK to tasks(id) ON DELETE SET NULL (deleting the umbrella
--    leaves its steps as ordinary tasks). Guard trigger tasks_guard_parent_task:
--    the parent must be the same user's task and not the task itself, and an
--    UPDATE may only clear the link (never point it somewhere new), so links are
--    only ever made by the function below and no loop can form. Nothing in the
--    app's PATCH allowlist or the MCP tools writes it.
--
--    Why a column and not an existing piece (evaluated first, as asked):
--    - task dependencies (umbrella waits on each step): the umbrella would show
--      "Blocked by dependency", leave Brent's "Assigned to you" list, and every
--      step that slipped would cascade the umbrella's due date; and progress
--      could not tell step links from ordinary links.
--    - external_source_system/id: that pair is the identity of a task in an
--      outside system (054's unique index, TaskAdvisor sync); reusing it would
--      clash and the Today page could not embed it (no foreign key).
--    - the section: the "add to an existing section" choice has no section of
--      its own, and a task without a project has none.
--    And "one transactional create (all-or-nothing)" needs a database function
--    in any case (PostgREST calls are separate transactions), so a migration was
--    needed either way.
--
-- 2. break_task_into_tasks(p_user_id, p_task_id, p_request JSONB): one
--    transaction. Takes 062's lock protocol (task_date_cascade_lock: the per-user
--    advisory lock shared with the dependency loop guard and the cascade, the
--    projects FOR SHARE, then the umbrella FOR NO KEY UPDATE), so it can't
--    deadlock with a cascade or a link add. Then, compare-and-set before any
--    write: the umbrella must still be in the project the app planned against,
--    have the base priority the scores were computed from, not be a recurring
--    template and not have steps already; each chosen checklist row must still
--    be on it with the ticked state the app saw (locked FOR SHARE). Then it
--    creates the destination (a new section with planned dates, or a new
--    project, or uses an existing section/project of the same user), the step
--    tasks (parent_task_id = the umbrella; project, application (046's trigger
--    still wins), sprint, tags and base priority copied from the umbrella as
--    read under the lock; owner, status, due date, priority score and units from
--    the request), one status-history row per task (a finished step's at the
--    time its row was ticked), the "waits on the step before" links between
--    consecutive OPEN steps when asked (061's loop guard still runs), a system
--    comment on each new task and one on the umbrella. The checklist rows are
--    NOT changed or deleted ("Nothing is deleted": they stay for the record).
--    No due date of any existing task changes, so no cascade runs.
--    Any error rolls everything back. Refusals come back as
--    { ok: false, reason } with nothing written.
--
-- 3. undo_break_task_into_tasks(p_user_id, p_task_id, p_request JSONB): the
--    toast's Undo. Same lock protocol; refuses (nothing changes) unless every
--    listed task still exists and is still a step of this umbrella; then
--    deletes them (their comments, links and history go with them), the section
--    or project the break created when nothing else is in it now, and the
--    umbrella's system comment. The checklist was never touched, so there is
--    nothing to restore.
--
-- Both functions: SECURITY INVOKER (RLS applies; a signed-in user may only pass
-- their own id), lock_timeout 5s, EXECUTE for authenticated and service_role
-- only.
--
-- Deploy order: 066 BEFORE the app (the app selects parent_task_id through the
-- Today embed and calls these functions). Rollback:
-- supabase/rollbacks/066_break_task_into_tasks.down.sql (app first).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).

BEGIN;

-- ── 1. The umbrella link ──────────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS parent_task_id UUID;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_parent_task_id_fkey;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_parent_task_id_fkey
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_parent_task_not_self;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_parent_task_not_self
  CHECK (parent_task_id IS NULL OR parent_task_id <> id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_parent_task
  ON tasks(user_id, parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- PostgREST embeds (Today's step_tasks) join on parent_task_id alone.
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task
  ON tasks(parent_task_id)
  WHERE parent_task_id IS NOT NULL;

COMMENT ON COLUMN tasks.parent_task_id IS
  'Break into tasks (066): the umbrella task this step was broken out of. Written only by break_task_into_tasks; an UPDATE may only clear it. ON DELETE SET NULL.';

CREATE OR REPLACE FUNCTION tasks_guard_parent_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id AND NEW.user_id = OLD.user_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a task''s umbrella can only be cleared, not changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_parent_task_guard';
  END IF;

  IF NEW.parent_task_id = NEW.id THEN
    RAISE EXCEPTION 'a task can''t be its own umbrella'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_parent_task_guard';
  END IF;

  -- Same user's task (under RLS another user's row isn't even visible).
  IF NOT EXISTS (
    SELECT 1 FROM public.tasks p WHERE p.id = NEW.parent_task_id AND p.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'the umbrella task must be one of the same user''s tasks'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_parent_task_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_guard_parent_task ON tasks;
CREATE TRIGGER trg_tasks_guard_parent_task
  BEFORE INSERT OR UPDATE OF parent_task_id, user_id ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_guard_parent_task();

-- ── 2. The transactional create ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION break_task_into_tasks(
  p_user_id UUID,
  p_task_id UUID,
  p_request JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_dest JSONB := p_request -> 'destination';
  v_kind TEXT := v_dest ->> 'kind';
  v_steps JSONB := p_request -> 'steps';
  v_task tasks%ROWTYPE;
  v_locked UUID[];
  v_dest_project_id UUID;
  v_section_id UUID;
  v_section_created BOOLEAN := false;
  v_project_created BOOLEAN := false;
  v_name TEXT;
  v_step JSONB;
  v_row task_checklist_items%ROWTYPE;
  v_item_ids UUID[] := '{}';
  v_item_id UUID;
  v_status TEXT;
  v_owner TEXT;
  v_new_id UUID;
  v_task_ids UUID[] := '{}';
  v_dep_ids UUID[] := '{}';
  v_dep_id UUID;
  v_prev_open UUID;
  v_comment_id UUID;
  v_done_at TIMESTAMPTZ;
  v_i INTEGER := 0;
BEGIN
  IF p_user_id IS NULL OR p_task_id IS NULL THEN
    RAISE EXCEPTION 'user id and task id are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot break another user''s task' USING ERRCODE = '42501';
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('new_section', 'existing_section', 'new_project', 'existing_project') THEN
    RAISE EXCEPTION 'destination kind must be new_section, existing_section, new_project or existing_project' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_steps) IS DISTINCT FROM 'array' OR jsonb_array_length(v_steps) = 0 THEN
    RAISE EXCEPTION 'at least one step is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_steps) > 100 THEN
    RAISE EXCEPTION 'at most 100 steps at a time' USING ERRCODE = '22023';
  END IF;

  v_dest_project_id := NULLIF(v_dest ->> 'project_id', '')::UUID;

  -- 062's lock protocol: advisory lock, projects (the umbrella's and the
  -- destination) FOR SHARE, then the umbrella FOR NO KEY UPDATE.
  v_locked := public.task_date_cascade_lock(
    p_user_id,
    ARRAY[p_task_id],
    'all',
    CASE WHEN v_dest_project_id IS NULL THEN '{}'::UUID[] ELSE ARRAY[v_dest_project_id] END
  );
  IF NOT (p_task_id = ANY (v_locked)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_task FROM public.tasks WHERE id = p_task_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_task.is_recurring_template THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recurring_template');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks c WHERE c.user_id = p_user_id AND c.parent_task_id = p_task_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_broken');
  END IF;
  -- Compare-and-set on what the app planned against.
  IF v_task.project_id IS DISTINCT FROM NULLIF(p_request ->> 'expect_project_id', '')::UUID
     OR v_task.base_priority IS DISTINCT FROM (p_request ->> 'expect_base_priority')::INTEGER THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_changed');
  END IF;

  -- Each chosen checklist row: on this task, once, with the ticked state the app saw.
  FOR v_step IN SELECT value FROM jsonb_array_elements(v_steps) LOOP
    v_item_id := NULLIF(v_step ->> 'checklist_item_id', '')::UUID;
    IF v_item_id IS NULL OR v_item_id = ANY (v_item_ids) THEN
      RAISE EXCEPTION 'each step needs its own checklist row' USING ERRCODE = '22023';
    END IF;
    v_item_ids := v_item_ids || v_item_id;
  END LOOP;

  PERFORM 1 FROM public.task_checklist_items i
   WHERE i.id = ANY (v_item_ids) AND i.task_id = p_task_id AND i.user_id = p_user_id
   ORDER BY i.id
     FOR SHARE OF i;

  FOR v_step IN SELECT value FROM jsonb_array_elements(v_steps) LOOP
    SELECT * INTO v_row FROM public.task_checklist_items i
     WHERE i.id = (v_step ->> 'checklist_item_id')::UUID AND i.task_id = p_task_id AND i.user_id = p_user_id;
    IF NOT FOUND OR v_row.is_done IS DISTINCT FROM (v_step ->> 'expect_done')::BOOLEAN THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'checklist_changed');
    END IF;
    v_status := v_step ->> 'status';
    IF v_row.is_done AND v_status IS DISTINCT FROM 'Done' THEN
      RAISE EXCEPTION 'a finished step must start as Done' USING ERRCODE = '22023';
    END IF;
    IF NOT v_row.is_done AND (v_status IS NULL OR v_status NOT IN ('Backlog', 'Planned', 'In Progress', 'Blocked/Waiting')) THEN
      RAISE EXCEPTION 'an open step must start as Backlog, Planned, In Progress or Blocked/Waiting' USING ERRCODE = '22023';
    END IF;
    v_owner := v_step ->> 'owner';
    IF v_owner IS NULL OR v_owner NOT IN ('brent', 'agent') THEN
      RAISE EXCEPTION 'owner must be brent or agent' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(COALESCE(v_step ->> 'title', ''))) = 0 THEN
      RAISE EXCEPTION 'each step needs a title' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- ── Destination ──
  IF v_kind IN ('new_section', 'existing_section') THEN
    -- Only the umbrella's own project.
    IF v_task.project_id IS NULL OR v_dest_project_id IS DISTINCT FROM v_task.project_id THEN
      RAISE EXCEPTION 'a section destination must be in the task''s own project' USING ERRCODE = '22023';
    END IF;
  ELSIF v_kind = 'new_project' THEN
    IF v_task.project_id IS NOT NULL THEN
      RAISE EXCEPTION 'only a task without a project can become a new project' USING ERRCODE = '22023';
    END IF;
  ELSE -- existing_project
    IF v_task.project_id IS NOT NULL THEN
      RAISE EXCEPTION 'only a task without a project can move its steps to another project' USING ERRCODE = '22023';
    END IF;
    IF v_dest_project_id IS NULL THEN
      RAISE EXCEPTION 'pick a project' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_dest_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = v_dest_project_id AND p.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'project_not_found');
  END IF;

  IF v_kind = 'existing_section' THEN
    v_section_id := NULLIF(v_dest ->> 'section_id', '')::UUID;
    IF v_section_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.project_sections s
       WHERE s.id = v_section_id AND s.user_id = p_user_id AND s.project_id = v_dest_project_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'section_not_found');
    END IF;
  ELSIF v_kind IN ('new_section', 'existing_project') THEN
    v_name := btrim(COALESCE(v_dest ->> 'name', ''));
    IF length(v_name) = 0 OR length(v_name) > 200 THEN
      RAISE EXCEPTION 'the section name must be 1 to 200 characters' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.project_sections s
       WHERE s.user_id = p_user_id AND s.project_id = v_dest_project_id AND lower(btrim(s.name)) = lower(v_name)
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'section_name_taken');
    END IF;
    INSERT INTO public.project_sections (user_id, project_id, name, sort_order, planned_start, planned_end)
    VALUES (
      p_user_id,
      v_dest_project_id,
      v_name,
      COALESCE((SELECT max(s.sort_order) + 1 FROM public.project_sections s WHERE s.user_id = p_user_id AND s.project_id = v_dest_project_id), 0),
      NULLIF(v_dest ->> 'planned_start', '')::DATE,
      NULLIF(v_dest ->> 'planned_end', '')::DATE
    )
    RETURNING id INTO v_section_id;
    v_section_created := true;
  ELSE -- new_project
    v_name := btrim(COALESCE(v_dest ->> 'name', ''));
    IF length(v_name) = 0 OR length(v_name) > 200 THEN
      RAISE EXCEPTION 'the project name must be 1 to 200 characters' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.projects (user_id, name, implementation_id, stage, rag, status_summary, tags, portfolio_rank)
    VALUES (
      p_user_id,
      v_name,
      v_task.implementation_id,
      COALESCE(NULLIF(v_dest ->> 'stage', ''), 'Planned')::project_stage,
      'Green',
      '',
      COALESCE(v_task.tags, '{}'::TEXT[]),
      COALESCE((
        SELECT max(p.portfolio_rank) + 1 FROM public.projects p
         WHERE p.user_id = p_user_id
           AND (v_task.implementation_id IS NULL OR p.implementation_id = v_task.implementation_id)
      ), 1)
    )
    RETURNING id INTO v_dest_project_id;
    v_project_created := true;
    v_section_id := NULL;
  END IF;

  -- ── The step tasks, in order ──
  FOR v_step IN SELECT value FROM jsonb_array_elements(v_steps) LOOP
    v_i := v_i + 1;
    v_status := v_step ->> 'status';
    v_done_at := CASE WHEN v_status = 'Done' THEN NULLIF(v_step ->> 'done_at', '')::TIMESTAMPTZ END;

    INSERT INTO public.tasks (
      user_id, title, status, task_type, owner, due_at,
      project_id, section_id, sprint_id, implementation_id, tags,
      base_priority, priority_score, unit_count, work_type,
      source_type, parent_task_id, created_at
    )
    VALUES (
      p_user_id,
      btrim(v_step ->> 'title'),
      v_status::task_status,
      'Task',
      v_step ->> 'owner',
      NULLIF(v_step ->> 'due_at', '')::TIMESTAMPTZ,
      v_dest_project_id,
      v_section_id,
      v_task.sprint_id,
      v_task.implementation_id,
      COALESCE(v_task.tags, '{}'::TEXT[]),
      v_task.base_priority,
      LEAST(100, GREATEST(0, COALESCE((v_step ->> 'priority_score')::INTEGER, v_task.base_priority))),
      NULLIF(v_step ->> 'unit_count', '')::NUMERIC,
      NULLIF(v_step ->> 'work_type', ''),
      'Manual',
      p_task_id,
      -- Distinct, increasing times so the steps list in checklist order
      -- (now() is the same for the whole transaction).
      clock_timestamp()
    )
    RETURNING id INTO v_new_id;
    v_task_ids := v_task_ids || v_new_id;

    INSERT INTO public.task_status_transitions (user_id, task_id, from_status, to_status, transitioned_at)
    VALUES (p_user_id, v_new_id, NULL, v_status, COALESCE(v_done_at, now()));

    IF NULLIF(btrim(COALESCE(v_step ->> 'comment', '')), '') IS NOT NULL THEN
      INSERT INTO public.task_comments (user_id, task_id, content, source)
      VALUES (p_user_id, v_new_id, v_step ->> 'comment', 'system');
    END IF;

    IF v_status <> 'Done' THEN
      IF COALESCE((v_step ->> 'waits_on_previous')::BOOLEAN, false) AND v_prev_open IS NOT NULL THEN
        INSERT INTO public.task_dependencies (user_id, task_id, depends_on_task_id)
        VALUES (p_user_id, v_new_id, v_prev_open)
        RETURNING id INTO v_dep_id;
        v_dep_ids := v_dep_ids || v_dep_id;
      END IF;
      v_prev_open := v_new_id;
    END IF;
  END LOOP;

  IF NULLIF(btrim(COALESCE(p_request ->> 'umbrella_comment', '')), '') IS NOT NULL THEN
    INSERT INTO public.task_comments (user_id, task_id, content, source)
    VALUES (p_user_id, p_task_id, p_request ->> 'umbrella_comment', 'system')
    RETURNING id INTO v_comment_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'task_id', p_task_id,
    'task_ids', to_jsonb(v_task_ids),
    'dependency_ids', to_jsonb(v_dep_ids),
    'project_id', v_dest_project_id,
    'project_created', v_project_created,
    'section_id', v_section_id,
    'section_created', v_section_created,
    'umbrella_comment_id', v_comment_id
  );
END;
$$;

COMMENT ON FUNCTION break_task_into_tasks(UUID, UUID, JSONB) IS
  'Break into tasks (066): one transaction that turns checklist rows into step tasks under an open umbrella (parent_task_id). Refusals return {ok:false, reason}.';

-- ── 3. Undo ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION undo_break_task_into_tasks(
  p_user_id UUID,
  p_task_id UUID,
  p_request JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_task_ids UUID[];
  v_section_id UUID := NULLIF(p_request ->> 'section_id', '')::UUID;
  v_project_id UUID := NULLIF(p_request ->> 'project_id', '')::UUID;
  v_comment_id UUID := NULLIF(p_request ->> 'umbrella_comment_id', '')::UUID;
  v_found INTEGER;
  v_deleted INTEGER := 0;
  v_section_deleted BOOLEAN := false;
  v_project_deleted BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL OR p_task_id IS NULL THEN
    RAISE EXCEPTION 'user id and task id are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot undo another user''s break' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_request -> 'task_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p_request -> 'task_ids') = 0 THEN
    RAISE EXCEPTION 'task_ids is required' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT value::UUID) INTO v_task_ids
    FROM jsonb_array_elements_text(p_request -> 'task_ids');

  PERFORM public.task_date_cascade_lock(
    p_user_id,
    ARRAY[p_task_id] || v_task_ids,
    'all',
    CASE WHEN v_project_id IS NULL THEN '{}'::UUID[] ELSE ARRAY[v_project_id] END
  );

  SELECT count(*) INTO v_found
    FROM public.tasks t
   WHERE t.user_id = p_user_id AND t.id = ANY (v_task_ids) AND t.parent_task_id = p_task_id;
  IF v_found <> cardinality(v_task_ids) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;

  DELETE FROM public.tasks t
   WHERE t.user_id = p_user_id AND t.id = ANY (v_task_ids) AND t.parent_task_id = p_task_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_section_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tasks t WHERE t.user_id = p_user_id AND t.section_id = v_section_id
  ) THEN
    DELETE FROM public.project_sections s WHERE s.id = v_section_id AND s.user_id = p_user_id;
    v_section_deleted := FOUND;
  END IF;

  IF v_project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.user_id = p_user_id AND t.project_id = v_project_id)
     AND NOT EXISTS (SELECT 1 FROM public.project_sections s WHERE s.user_id = p_user_id AND s.project_id = v_project_id) THEN
    DELETE FROM public.projects p WHERE p.id = v_project_id AND p.user_id = p_user_id;
    v_project_deleted := FOUND;
  END IF;

  IF v_comment_id IS NOT NULL THEN
    DELETE FROM public.task_comments c
     WHERE c.id = v_comment_id AND c.user_id = p_user_id AND c.task_id = p_task_id AND c.source = 'system';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_tasks', v_deleted,
    'section_deleted', v_section_deleted,
    'project_deleted', v_project_deleted
  );
END;
$$;

COMMENT ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) IS
  'Undo for break_task_into_tasks (066): deletes the listed step tasks (only while all are still steps of this umbrella), then the created section/project when empty, and the umbrella''s system comment.';

REVOKE ALL ON FUNCTION break_task_into_tasks(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION break_task_into_tasks(UUID, UUID, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
