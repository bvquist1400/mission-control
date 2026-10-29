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
--    leaves its steps as ordinary tasks).
--    tasks.source_checklist_item_id (new, nullable, additive): the umbrella's
--    checklist row a step was made from. Deliberately NOT a foreign key: a
--    second tasks ↔ task_checklist_items relationship would make every
--    PostgREST embed `task_checklist_items(...)` from tasks ambiguous (Today,
--    Portfolio, ...). The trigger checks the row at insert; if the row is
--    deleted later the id simply matches nothing. The pace forecast uses it so
--    a converted row and its step count once (the row stays the record of the
--    units; the step's status says whether they are done).
--    Guard trigger tasks_guard_parent_task: both links can only be WRITTEN by
--    break_task_into_tasks (it sets the transaction-local setting
--    mission_control.break_umbrella_id, which no API request can set; a direct
--    insert with a parent is refused), the parent must be the same user's task
--    and not the task itself, the source row must be on that parent, and an
--    UPDATE may only clear a link (never point it somewhere new), so no loop
--    can form. Nothing in the app's PATCH allowlist or the MCP tools writes them.
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
-- 2. task_breaks (new table): the record of what one break created (the step
--    tasks, whether it created the section or project, the umbrella's comment)
--    and a fingerprint of everything Undo would delete. Undo takes only the
--    record's id and derives every deletion from it, never from ids the client
--    sends. Rows are written and removed only inside the two functions (same
--    setting as above); the owner can read them. One per umbrella.
--
--    task_break_fingerprint(...): md5 over the step tasks' rows, every row in
--    every table with a foreign key to tasks that points at a step (comments,
--    dependency links either way, status history, checklist rows, work
--    sessions, note links, nested steps, ... found from pg_constraint, so a
--    table added later is covered too), the note links naming a step, and, when
--    the break created them, the section or project row and every row pointing
--    at it, plus the umbrella's system comment. Undo refuses when it differs
--    from the one stored at creation: any comment, link, edit, status change,
--    new task in the section or project-level history since then.
--
-- 3. break_task_into_tasks(p_user_id, p_task_id, p_request JSONB): one
--    transaction. Takes 062's lock protocol (task_date_cascade_lock: the per-user
--    advisory lock shared with the dependency loop guard and the cascade, the
--    projects FOR SHARE, then the umbrella FOR NO KEY UPDATE), so it can't
--    deadlock with a cascade or a link add. Then, compare-and-set before any
--    write: the umbrella must still be open (not Done, Missed or Parked), in
--    the project the app planned against, have the base priority the scores
--    were computed from, not be a recurring template and not have steps
--    already; each chosen checklist row must still be on it with the ticked
--    state the app saw (locked FOR SHARE). Then it creates the destination (a
--    new section with planned dates, or a new project, or uses an existing
--    section/project of the same user), the step tasks (parent_task_id = the
--    umbrella, source_checklist_item_id = its row; project, application (046's
--    trigger still wins), sprint, tags and base priority copied from the
--    umbrella as read under the lock; owner, status, due date, priority score
--    and units from the request), one status-history row per task. A finished
--    step's history row AND its updated_at are the time its row was ticked
--    (the row's created_at for rows ticked before 059 kept tick times), so the
--    briefs never count an old step as finished today. The "waits on the step
--    before" links between consecutive OPEN steps when asked (061's loop guard
--    still runs), a system comment on each new task and one on the umbrella.
--    Comments never carry a name across the FamCal boundary: each comment
--    names the other side (umbrella title, destination name) only when that
--    side is visible to the same audience, checked with 060's famcal_eligible
--    on the rows as written; otherwise the plain wording is used. The checklist
--    rows are NOT changed or deleted ("Nothing is deleted": they stay for the
--    record). No due date of any existing task changes, so no cascade runs.
--    Any error rolls everything back. Refusals come back as
--    { ok: false, reason } with nothing written.
--
-- 4. undo_break_task_into_tasks(p_user_id, p_task_id, p_request JSONB): the
--    toast's Undo, p_request = { break_id }. Same lock protocol, then the write
--    fence (task_break_lock_for_undo, fix round 2: the steps, the created
--    section/project and every row pointing at them FOR UPDATE, so a comment,
--    link, edit or note link still in flight is waited for and seen, and one
--    that starts later waits and is then refused; new note links are fenced by
--    trg_note_links_lock_target); refuses
--    (nothing changes) unless the record is this umbrella's, every step still
--    exists as its step, and the fingerprint is unchanged; then deletes the
--    steps, the section or project only if the break created it, the
--    umbrella's system comment and the record. The checklist was never
--    touched, so there is nothing to restore.
--
-- The functions: SECURITY INVOKER (RLS applies; a signed-in user may only pass
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
  ADD COLUMN IF NOT EXISTS parent_task_id UUID,
  ADD COLUMN IF NOT EXISTS source_checklist_item_id UUID;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_parent_task_id_fkey;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_parent_task_id_fkey
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- (A local draft of this fix round had a foreign key here; never on production.)
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_source_checklist_item_id_fkey;

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
COMMENT ON COLUMN tasks.source_checklist_item_id IS
  'Break into tasks (066): the umbrella checklist row this step was made from (pace counts the pair once). Written only by break_task_into_tasks; an UPDATE may only clear it. No foreign key (it would make PostgREST embeds of task_checklist_items ambiguous); a deleted row just matches nothing.';

CREATE OR REPLACE FUNCTION tasks_guard_parent_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_task_id IS NULL AND NEW.source_checklist_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_task_id IS NOT DISTINCT FROM OLD.parent_task_id
       AND (NEW.source_checklist_item_id IS NULL OR NEW.source_checklist_item_id IS NOT DISTINCT FROM OLD.source_checklist_item_id)
       AND NEW.user_id = OLD.user_id THEN
      RETURN NEW;
    END IF;
    IF NEW.parent_task_id IS NULL
       AND (NEW.source_checklist_item_id IS NULL OR NEW.source_checklist_item_id IS NOT DISTINCT FROM OLD.source_checklist_item_id)
       AND NEW.user_id = OLD.user_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a task''s umbrella can only be cleared, not changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_parent_task_guard';
  END IF;

  -- INSERT: only break_task_into_tasks makes steps (it sets this for its own transaction).
  IF NEW.parent_task_id IS NULL
     OR current_setting('mission_control.break_umbrella_id', true) IS DISTINCT FROM NEW.parent_task_id::TEXT THEN
    RAISE EXCEPTION 'steps are made only by Break into tasks'
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

  IF NEW.source_checklist_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.task_checklist_items i
     WHERE i.id = NEW.source_checklist_item_id AND i.task_id = NEW.parent_task_id AND i.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'the source checklist row must be on the umbrella task'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_parent_task_guard';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_guard_parent_task ON tasks;
CREATE TRIGGER trg_tasks_guard_parent_task
  BEFORE INSERT OR UPDATE OF parent_task_id, source_checklist_item_id, user_id ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_guard_parent_task();

-- ── 2. The break record ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_breaks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  umbrella_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_ids UUID[] NOT NULL CHECK (cardinality(task_ids) BETWEEN 1 AND 100),
  project_id UUID,
  project_created BOOLEAN NOT NULL DEFAULT false,
  section_id UUID,
  section_created BOOLEAN NOT NULL DEFAULT false,
  umbrella_comment_id UUID,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_breaks_one_per_umbrella UNIQUE (umbrella_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_breaks_user ON task_breaks(user_id);

COMMENT ON TABLE task_breaks IS
  'Break into tasks (066): what one break created, for Undo. Written and removed only by break_task_into_tasks / undo_break_task_into_tasks.';

-- Records are never updated (no UPDATE grant or policy: RLS denies it).
GRANT SELECT, INSERT, DELETE ON task_breaks TO authenticated, service_role;
ALTER TABLE task_breaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own task_breaks" ON task_breaks;
CREATE POLICY "Users can view own task_breaks"
  ON task_breaks FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Break function writes own task_breaks" ON task_breaks;
CREATE POLICY "Break function writes own task_breaks"
  ON task_breaks FOR INSERT
  WITH CHECK (auth.uid() = user_id AND current_setting('mission_control.break_umbrella_id', true) = umbrella_task_id::TEXT);
DROP POLICY IF EXISTS "Break functions delete own task_breaks" ON task_breaks;
CREATE POLICY "Break functions delete own task_breaks"
  ON task_breaks FOR DELETE
  USING (auth.uid() = user_id AND current_setting('mission_control.break_umbrella_id', true) = umbrella_task_id::TEXT);

CREATE OR REPLACE FUNCTION task_break_fingerprint(
  p_user_id UUID,
  p_task_ids UUID[],
  p_project_id UUID,
  p_section_id UUID,
  p_comment_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_parts TEXT[] := '{}';
  v_part TEXT;
  v_ref RECORD;
  v_targets JSONB := jsonb_build_array(
    jsonb_build_object('rel', 'public.tasks', 'ids', to_jsonb(COALESCE(p_task_ids, '{}'::UUID[])))
  );
  v_target JSONB;
  v_ids UUID[];
BEGIN
  IF p_project_id IS NOT NULL THEN
    v_targets := v_targets || jsonb_build_object('rel', 'public.projects', 'ids', to_jsonb(ARRAY[p_project_id]));
  END IF;
  IF p_section_id IS NOT NULL THEN
    v_targets := v_targets || jsonb_build_object('rel', 'public.project_sections', 'ids', to_jsonb(ARRAY[p_section_id]));
  END IF;

  FOR v_target IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    SELECT array_agg(value::UUID ORDER BY value) INTO v_ids FROM jsonb_array_elements_text(v_target -> 'ids');
    v_ids := COALESCE(v_ids, '{}'::UUID[]);

    -- The rows themselves.
    EXECUTE format(
      'SELECT md5(COALESCE(string_agg(x::TEXT, %L ORDER BY x.id), %L)) FROM %s x WHERE x.user_id = $1 AND x.id = ANY ($2)',
      '|', '', (v_target ->> 'rel')
    ) INTO v_part USING p_user_id, v_ids;
    v_parts := v_parts || ((v_target ->> 'rel') || ':' || v_part);

    -- Every row that points at them through a single-column foreign key.
    FOR v_ref IN
      SELECT c.conrelid::regclass AS rel, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.confrelid = (v_target ->> 'rel')::regclass
         AND cardinality(c.conkey) = 1
       ORDER BY c.conrelid::regclass::TEXT, a.attname
    LOOP
      -- A table this caller can't read can't hold its rows either (skip it rather than fail).
      CONTINUE WHEN NOT has_table_privilege(v_ref.rel, 'SELECT');
      EXECUTE format(
        'SELECT md5(COALESCE(string_agg(x::TEXT, %L ORDER BY x::TEXT), %L)) FROM %s x WHERE x.%I = ANY ($1)',
        '|', '', v_ref.rel, v_ref.col
      ) INTO v_part USING v_ids;
      v_parts := v_parts || (v_ref.rel::TEXT || '.' || v_ref.col || ':' || v_part);
    END LOOP;
  END LOOP;

  -- Note links name tasks/projects by text id (no foreign key).
  SELECT md5(COALESCE(string_agg(l::TEXT, '|' ORDER BY l.id), '')) INTO v_part
    FROM public.note_links l
   WHERE l.user_id = p_user_id
     AND ((l.entity_type = 'task' AND l.entity_id = ANY (COALESCE(p_task_ids, '{}'::UUID[])::TEXT[]))
       OR (p_project_id IS NOT NULL AND l.entity_type = 'project' AND l.entity_id = p_project_id::TEXT));
  v_parts := v_parts || ('note_links:' || v_part);

  IF p_comment_id IS NOT NULL THEN
    SELECT md5(COALESCE(string_agg(c::TEXT, '|'), '')) INTO v_part
      FROM public.task_comments c WHERE c.id = p_comment_id AND c.user_id = p_user_id;
    v_parts := v_parts || ('umbrella_comment:' || v_part);
  END IF;

  RETURN md5(array_to_string(v_parts, E'\n'));
END;
$$;

COMMENT ON FUNCTION task_break_fingerprint(UUID, UUID[], UUID, UUID, UUID) IS
  'Break into tasks (066): md5 of the step tasks, every row pointing at them, the created section/project and its rows, and the umbrella comment. Undo refuses when it changed.';

-- The write fence Undo takes before it fingerprints (fix round 2). The
-- fingerprint is a check; this makes it a fence. Locks, in this order:
--   1. the step tasks FOR UPDATE (id order). A FOREIGN KEY insert pointing at a
--      step (a comment, a dependency either way, a status-history row, a work
--      session, ...) holds FOR KEY SHARE on the step until it commits, and
--      KEY SHARE conflicts only with FOR UPDATE: so a write still in flight makes
--      Undo wait until it commits (the fingerprint, a later statement with a new
--      READ COMMITTED snapshot, then sees it and Undo refuses), and a write that
--      starts after this waits for Undo (after Undo's DELETE its foreign key
--      check fails: the write is refused, never saved and then cascade-deleted).
--      062's FOR NO KEY UPDATE, held until now, does not conflict with KEY SHARE.
--   2. the section and the project this break CREATED, FOR UPDATE (a new task or
--      section filed into them is fenced the same way).
--   3. every existing row that points at those through a single-column foreign
--      key (found from pg_constraint, like the fingerprint), FOR UPDATE, so an
--      edit or delete still in flight (e.g. a PATCH of the step's own system
--      comment) is waited for and then seen, rather than overwritten by the
--      cascade. Only tables this caller may UPDATE: rows nobody here can edit
--      need no fence (new rows are fenced by 1 and 2).
--   4. the note links naming a step or the created project, and the umbrella's
--      system comment, FOR UPDATE. NEW note links have no foreign key: the
--      trigger trg_note_links_lock_target (below) takes FOR KEY SHARE on the task
--      or project a link names, so they are fenced by 1 and 2 like a foreign key.
-- Everything else Undo needs (the advisory lock, the projects FOR SHARE, the
-- umbrella and steps FOR NO KEY UPDATE) is already held from 062's protocol, and
-- two Undos never interleave (the advisory lock), so the only waits here are on
-- single-row writers that do not wait on Undo: no new deadlock.
CREATE OR REPLACE FUNCTION task_break_lock_for_undo(
  p_user_id UUID,
  p_task_ids UUID[],
  p_project_id UUID,
  p_section_id UUID,
  p_comment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ref RECORD;
  v_target RECORD;
BEGIN
  PERFORM 1 FROM public.tasks t
   WHERE t.user_id = p_user_id AND t.id = ANY (COALESCE(p_task_ids, '{}'::UUID[]))
   ORDER BY t.id
     FOR UPDATE OF t;
  IF p_section_id IS NOT NULL THEN
    PERFORM 1 FROM public.project_sections s WHERE s.id = p_section_id AND s.user_id = p_user_id FOR UPDATE OF s;
  END IF;
  IF p_project_id IS NOT NULL THEN
    PERFORM 1 FROM public.projects p WHERE p.id = p_project_id AND p.user_id = p_user_id FOR UPDATE OF p;
  END IF;

  FOR v_target IN
    SELECT 'public.tasks'::regclass AS rel, COALESCE(p_task_ids, '{}'::UUID[]) AS ids
    UNION ALL SELECT 'public.project_sections'::regclass, ARRAY[p_section_id] WHERE p_section_id IS NOT NULL
    UNION ALL SELECT 'public.projects'::regclass, ARRAY[p_project_id] WHERE p_project_id IS NOT NULL
  LOOP
    FOR v_ref IN
      SELECT c.conrelid::regclass AS rel, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.confrelid = v_target.rel
         AND cardinality(c.conkey) = 1
       ORDER BY c.conrelid::regclass::TEXT, a.attname
    LOOP
      CONTINUE WHEN NOT has_table_privilege(v_ref.rel, 'SELECT') OR NOT has_table_privilege(v_ref.rel, 'UPDATE');
      EXECUTE format('SELECT 1 FROM %s x WHERE x.%I = ANY ($1) FOR UPDATE OF x', v_ref.rel, v_ref.col)
        USING v_target.ids;
    END LOOP;
  END LOOP;

  PERFORM 1 FROM public.note_links l
   WHERE l.user_id = p_user_id
     AND ((l.entity_type = 'task' AND l.entity_id = ANY (COALESCE(p_task_ids, '{}'::UUID[])::TEXT[]))
       OR (p_project_id IS NOT NULL AND l.entity_type = 'project' AND l.entity_id = p_project_id::TEXT))
     FOR UPDATE OF l;
  IF p_comment_id IS NOT NULL THEN
    PERFORM 1 FROM public.task_comments c WHERE c.id = p_comment_id AND c.user_id = p_user_id FOR UPDATE OF c;
  END IF;
END;
$$;

COMMENT ON FUNCTION task_break_lock_for_undo(UUID, UUID[], UUID, UUID, UUID) IS
  'Break into tasks (066, fix round 2): the write fence Undo takes before task_break_fingerprint, so a comment, link or edit in flight is either seen (Undo refuses) or refused itself; never saved and then cascade-deleted.';

-- Note links name a task or project by text id (no foreign key), so a new link
-- would not wait for Undo's fence on its own. This takes the same FOR KEY SHARE
-- a foreign key check takes on the task or project the link names (only for
-- those two kinds and a uuid-shaped id; other kinds are untouched), and refuses
-- the link, like a foreign key, when that task or project is gone by the time
-- the lock is granted (e.g. Undo deleted it while the link waited).
CREATE OR REPLACE FUNCTION note_links_lock_target()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NEW.entity_type NOT IN ('task', 'project')
     OR NEW.entity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.entity_type IS NOT DISTINCT FROM OLD.entity_type AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id THEN
    RETURN NEW;
  END IF;
  v_id := NEW.entity_id::UUID;
  IF NEW.entity_type = 'task' THEN
    PERFORM 1 FROM public.tasks t WHERE t.id = v_id FOR KEY SHARE OF t;
  ELSE
    PERFORM 1 FROM public.projects p WHERE p.id = v_id FOR KEY SHARE OF p;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the % this note link names no longer exists', NEW.entity_type
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'note_links_target_exists';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_links_lock_target ON note_links;
CREATE TRIGGER trg_note_links_lock_target
  BEFORE INSERT OR UPDATE OF entity_type, entity_id ON note_links
  FOR EACH ROW
  EXECUTE FUNCTION note_links_lock_target();

-- ── 3. The transactional create ───────────────────────────────────────────

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
  v_umbrella_visible BOOLEAN;
  v_step_visible BOOLEAN;
  v_all_same_audience BOOLEAN := true;
  v_fingerprint TEXT;
  v_break_id UUID;
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
  -- A closed task can't grow open steps (it would stay closed and credited as finished).
  IF v_task.status::TEXT IN ('Done', 'Missed', 'Parked') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'task_closed');
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

  -- Every refusal is behind us (section_not_found, section_name_taken, ...): from
  -- here on nothing returns early, so the setting is only ever on while this
  -- function writes its own steps and record, and it is cleared before the one
  -- RETURN below (an error rolls it back with everything else). The guard trigger
  -- and task_breaks' policies check it; no API request can set it.
  PERFORM set_config('mission_control.break_umbrella_id', p_task_id::TEXT, true);

  -- Who may read the umbrella's comments with the FamCal key (060's one definition).
  v_umbrella_visible := COALESCE(public.famcal_eligible(v_task), false);

  -- ── The step tasks, in order ──
  FOR v_step IN SELECT value FROM jsonb_array_elements(v_steps) LOOP
    v_i := v_i + 1;
    v_status := v_step ->> 'status';
    SELECT * INTO v_row FROM public.task_checklist_items i
     WHERE i.id = (v_step ->> 'checklist_item_id')::UUID AND i.task_id = p_task_id AND i.user_id = p_user_id;
    -- A finished step's time is when its row was ticked, read under the lock (rows
    -- ticked before 059 kept tick times fall back to the row's own creation time).
    v_done_at := CASE WHEN v_status = 'Done' THEN COALESCE(v_row.completed_at, v_row.created_at) END;

    INSERT INTO public.tasks (
      user_id, title, status, task_type, owner, due_at,
      project_id, section_id, sprint_id, implementation_id, tags,
      base_priority, priority_score, unit_count, work_type,
      source_type, parent_task_id, source_checklist_item_id, created_at, updated_at
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
      v_row.id,
      -- Distinct, increasing times so the steps list in checklist order
      -- (now() is the same for the whole transaction).
      clock_timestamp(),
      -- A finished step was finished when its row was ticked, not today (briefs
      -- count "done today" from updated_at).
      COALESCE(v_done_at, now())
    )
    RETURNING id INTO v_new_id;
    v_task_ids := v_task_ids || v_new_id;

    INSERT INTO public.task_status_transitions (user_id, task_id, from_status, to_status, transitioned_at)
    VALUES (p_user_id, v_new_id, NULL, v_status, COALESCE(v_done_at, now()));

    -- The step's comment names the umbrella only when the step isn't visible to an
    -- audience the umbrella isn't (the FamCal key reads an eligible task's comments).
    SELECT COALESCE(public.famcal_eligible(t), false) INTO v_step_visible FROM public.tasks t WHERE t.id = v_new_id;
    IF v_step_visible IS DISTINCT FROM v_umbrella_visible THEN
      v_all_same_audience := false;
    END IF;
    IF NULLIF(btrim(COALESCE(v_step ->> 'comment', '')), '') IS NOT NULL THEN
      INSERT INTO public.task_comments (user_id, task_id, content, source)
      VALUES (
        p_user_id,
        v_new_id,
        CASE
          WHEN v_step_visible AND NOT v_umbrella_visible THEN COALESCE(NULLIF(btrim(v_step ->> 'comment_generic'), ''), 'Part of another task: broken out of its checklist.')
          ELSE v_step ->> 'comment'
        END,
        'system'
      );
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

  -- The umbrella's comment names the destination only when every step is visible
  -- to exactly the umbrella's audience.
  IF NULLIF(btrim(COALESCE(p_request ->> 'umbrella_comment', '')), '') IS NOT NULL THEN
    INSERT INTO public.task_comments (user_id, task_id, content, source)
    VALUES (
      p_user_id,
      p_task_id,
      CASE
        WHEN v_all_same_audience THEN p_request ->> 'umbrella_comment'
        ELSE COALESCE(NULLIF(btrim(p_request ->> 'umbrella_comment_generic'), ''), 'Broken into tasks in another project. This task stays open as their umbrella.')
      END,
      'system'
    )
    RETURNING id INTO v_comment_id;
  END IF;

  -- The record Undo works from (a stale one, whose steps are all gone, is replaced).
  DELETE FROM public.task_breaks b WHERE b.umbrella_task_id = p_task_id AND b.user_id = p_user_id;
  v_fingerprint := public.task_break_fingerprint(
    p_user_id,
    v_task_ids,
    CASE WHEN v_project_created THEN v_dest_project_id END,
    CASE WHEN v_section_created THEN v_section_id END,
    v_comment_id
  );
  INSERT INTO public.task_breaks (
    user_id, umbrella_task_id, task_ids, project_id, project_created,
    section_id, section_created, umbrella_comment_id, fingerprint
  )
  VALUES (
    p_user_id, p_task_id, v_task_ids, v_dest_project_id, v_project_created,
    v_section_id, v_section_created, v_comment_id, v_fingerprint
  )
  RETURNING id INTO v_break_id;

  PERFORM set_config('mission_control.break_umbrella_id', '', true);

  RETURN jsonb_build_object(
    'ok', true,
    'break_id', v_break_id,
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
  'Break into tasks (066): one transaction that turns checklist rows into step tasks under an open umbrella (parent_task_id) and records what it made (task_breaks). Refusals return {ok:false, reason}.';

-- ── 4. Undo ───────────────────────────────────────────────────────────────

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
  v_break_id UUID;
  v_break task_breaks%ROWTYPE;
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
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'undo takes only break_id' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k <> 'break_id') THEN
    RAISE EXCEPTION 'undo takes only break_id' USING ERRCODE = '22023';
  END IF;
  v_break_id := NULLIF(p_request ->> 'break_id', '')::UUID;
  IF v_break_id IS NULL THEN
    RAISE EXCEPTION 'break_id is required' USING ERRCODE = '22023';
  END IF;

  -- Everything Undo touches comes from the record, never from the request.
  SELECT * INTO v_break FROM public.task_breaks b
   WHERE b.id = v_break_id AND b.user_id = p_user_id AND b.umbrella_task_id = p_task_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;

  PERFORM public.task_date_cascade_lock(
    p_user_id,
    ARRAY[p_task_id] || v_break.task_ids,
    'all',
    CASE WHEN v_break.project_id IS NULL THEN '{}'::UUID[] ELSE ARRAY[v_break.project_id] END
  );

  -- Re-read under the umbrella's lock (a concurrent Undo of the same break waits, then finds nothing).
  SELECT * INTO v_break FROM public.task_breaks b
   WHERE b.id = v_break_id AND b.user_id = p_user_id AND b.umbrella_task_id = p_task_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;

  SELECT count(*) INTO v_found
    FROM public.tasks t
   WHERE t.user_id = p_user_id AND t.id = ANY (v_break.task_ids) AND t.parent_task_id = p_task_id;
  IF v_found <> cardinality(v_break.task_ids) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;

  -- Fence every writer first (task_break_lock_for_undo: a write in flight is
  -- waited for and seen, a later one waits and is then refused), then check.
  -- The fence relies on READ COMMITTED's fresh snapshot per statement (PostgREST's
  -- default); a stricter isolation level could check against an older snapshot.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Undo runs at READ COMMITTED only' USING ERRCODE = '25001';
  END IF;
  PERFORM public.task_break_lock_for_undo(
    p_user_id,
    v_break.task_ids,
    CASE WHEN v_break.project_created THEN v_break.project_id END,
    CASE WHEN v_break.section_created THEN v_break.section_id END,
    v_break.umbrella_comment_id
  );

  -- Anything added, edited or linked since the break → refuse; nothing is deleted.
  IF public.task_break_fingerprint(
       p_user_id,
       v_break.task_ids,
       CASE WHEN v_break.project_created THEN v_break.project_id END,
       CASE WHEN v_break.section_created THEN v_break.section_id END,
       v_break.umbrella_comment_id
     ) IS DISTINCT FROM v_break.fingerprint THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed');
  END IF;

  PERFORM set_config('mission_control.break_umbrella_id', p_task_id::TEXT, true);

  DELETE FROM public.tasks t
   WHERE t.user_id = p_user_id AND t.id = ANY (v_break.task_ids) AND t.parent_task_id = p_task_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_break.section_created AND v_break.section_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tasks t WHERE t.user_id = p_user_id AND t.section_id = v_break.section_id
  ) THEN
    DELETE FROM public.project_sections s WHERE s.id = v_break.section_id AND s.user_id = p_user_id;
    v_section_deleted := FOUND;
  END IF;

  IF v_break.project_created AND v_break.project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.user_id = p_user_id AND t.project_id = v_break.project_id)
     AND NOT EXISTS (SELECT 1 FROM public.project_sections s WHERE s.user_id = p_user_id AND s.project_id = v_break.project_id) THEN
    DELETE FROM public.projects p WHERE p.id = v_break.project_id AND p.user_id = p_user_id;
    v_project_deleted := FOUND;
  END IF;

  IF v_break.umbrella_comment_id IS NOT NULL THEN
    DELETE FROM public.task_comments c
     WHERE c.id = v_break.umbrella_comment_id AND c.user_id = p_user_id AND c.task_id = p_task_id AND c.source = 'system';
  END IF;

  DELETE FROM public.task_breaks b WHERE b.id = v_break.id AND b.user_id = p_user_id;
  PERFORM set_config('mission_control.break_umbrella_id', '', true);

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_tasks', v_deleted,
    'section_deleted', v_section_deleted,
    'project_deleted', v_project_deleted
  );
END;
$$;

COMMENT ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) IS
  'Undo for break_task_into_tasks (066): takes only the break record''s id; deletes what that break created, and only while nothing about it changed since (task_break_fingerprint).';

REVOKE ALL ON FUNCTION task_break_fingerprint(UUID, UUID[], UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_break_fingerprint(UUID, UUID[], UUID, UUID, UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION task_break_lock_for_undo(UUID, UUID[], UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_break_lock_for_undo(UUID, UUID[], UUID, UUID, UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION break_task_into_tasks(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION break_task_into_tasks(UUID, UUID, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION undo_break_task_into_tasks(UUID, UUID, JSONB) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
