-- Pace tracking, slice 1: work sessions and units.
--
-- A work session is one sitting of real time on a project (optionally on one
-- task), with the checklist rows it covered. Units (stitches, pages…) live on
-- checklist rows (or on a task with no unit-bearing rows), each with a work
-- type, so a forecast can turn minutes into seconds per unit and units left into
-- time left. The forecast itself is computed in code (src/lib/pace.ts); this
-- migration only stores the facts.
--
-- Additive only: every new column is nullable or has a default, so existing
-- rows and every existing insert are unchanged. One new rule on existing data:
-- a task with logged sessions can't change project (trg_tasks_guard_project_move).
-- Rollback contract: the down file keeps tasks.actual_minutes as last rolled up
-- from sessions (the earlier value is not recoverable and is not restored).
-- Nothing outside the new pace routes / MCP tools reads sessions; tasks.actual_minutes (rolled up from
-- sessions below) was already read by the capacity estimate, whose callers all
-- filter out personal tasks.

BEGIN;

-- ── Projects: the unit being counted, and pace settings ─────────────────
-- unit_label NULL = no pace tracking. pace_settings is validated in app code
-- (shape used now: {"size": {"label","current","step","offset","min","unit","work_types"}}).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS unit_label TEXT,
  ADD COLUMN IF NOT EXISTS pace_settings JSONB;

-- ── Tasks: task-level units (used when no checklist row carries units) ───
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS unit_count NUMERIC,
  ADD COLUMN IF NOT EXISTS work_type TEXT,
  -- A swatch / test piece / prototype: its speeds are returned, labelled "sample".
  ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_unit_count_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_unit_count_check CHECK (unit_count IS NULL OR unit_count >= 0);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_work_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_work_type_check
  CHECK (work_type IS NULL OR work_type ~ '^[a-z0-9][a-z0-9-]{0,39}$');

-- ── Checklist rows: units, type override, when it was ticked ─────────────
ALTER TABLE task_checklist_items
  ADD COLUMN IF NOT EXISTS unit_count NUMERIC,
  ADD COLUMN IF NOT EXISTS work_type TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE task_checklist_items DROP CONSTRAINT IF EXISTS task_checklist_items_unit_count_check;
ALTER TABLE task_checklist_items ADD CONSTRAINT task_checklist_items_unit_count_check
  CHECK (unit_count IS NULL OR unit_count >= 0);
ALTER TABLE task_checklist_items DROP CONSTRAINT IF EXISTS task_checklist_items_work_type_check;
ALTER TABLE task_checklist_items ADD CONSTRAINT task_checklist_items_work_type_check
  CHECK (work_type IS NULL OR work_type ~ '^[a-z0-9][a-z0-9-]{0,39}$');

-- Ticking a row stamps completed_at (unless the write supplies one); unticking
-- clears it. Rows ticked before this migration keep completed_at NULL.
CREATE OR REPLACE FUNCTION task_checklist_items_set_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_done THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    ELSE
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_done AND NOT OLD.is_done THEN
    -- "Supplied" = the write set a value different from the stored one.
    IF NEW.completed_at IS NULL OR NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at THEN
      NEW.completed_at := now();
    END IF;
  ELSIF NOT NEW.is_done AND OLD.is_done THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_checklist_items_completed_at ON task_checklist_items;
CREATE TRIGGER trg_task_checklist_items_completed_at
  BEFORE INSERT OR UPDATE OF is_done ON task_checklist_items
  FOR EACH ROW EXECUTE FUNCTION task_checklist_items_set_completed_at();

-- ── Work sessions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- NULL = a sitting that spanned several tasks with no per-task split.
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  session_date DATE NOT NULL, -- ET calendar day
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  -- Half rows / work with no checklist row.
  extra_units NUMERIC CHECK (extra_units IS NULL OR extra_units >= 0),
  extra_work_type TEXT CHECK (extra_work_type IS NULL OR extra_work_type ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 2000),
  -- Excluded sessions still count toward cadence (real time) but never toward speed.
  exclude_from_stats BOOLEAN NOT NULL DEFAULT false,
  exclude_reason TEXT CHECK (exclude_reason IS NULL OR char_length(exclude_reason) <= 200),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'backfill')),
  -- Idempotency key for backfills (e.g. a comment id); unique per user.
  source_ref TEXT CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_sessions_time_order_check
    CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at > started_at)
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_project_date ON work_sessions(project_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_work_sessions_task ON work_sessions(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_user_source_ref
  ON work_sessions(user_id, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_session_items (
  session_id UUID NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  checklist_item_id UUID NOT NULL REFERENCES task_checklist_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, checklist_item_id)
);

CREATE INDEX IF NOT EXISTS idx_work_session_items_item ON work_session_items(checklist_item_id);

-- A session's project (and task, when set) must be the user's own, and the
-- task must be in the session's project. Enforced here as well as in the
-- service, because the service runs with the service-role client on API-key
-- and MCP paths.
CREATE OR REPLACE FUNCTION work_sessions_check_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'work session project % is not owned by the user', NEW.project_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = NEW.task_id AND t.user_id = NEW.user_id AND t.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'work session task % is not in project % for this user', NEW.task_id, NEW.project_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_sessions_ownership ON work_sessions;
CREATE TRIGGER trg_work_sessions_ownership
  BEFORE INSERT OR UPDATE OF user_id, project_id, task_id ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION work_sessions_check_ownership();

-- A linked checklist row must belong to a task in the session's project, and
-- to the same user.
CREATE OR REPLACE FUNCTION work_session_items_check_project()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM work_sessions s
    JOIN task_checklist_items i ON i.id = NEW.checklist_item_id
    JOIN tasks t ON t.id = i.task_id
    WHERE s.id = NEW.session_id
      AND s.user_id = NEW.user_id
      AND i.user_id = NEW.user_id
      AND t.user_id = NEW.user_id
      AND t.project_id = s.project_id
  ) THEN
    RAISE EXCEPTION 'checklist item % is not in the work session''s project', NEW.checklist_item_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_session_items_project ON work_session_items;
CREATE TRIGGER trg_work_session_items_project
  BEFORE INSERT OR UPDATE ON work_session_items
  FOR EACH ROW EXECUTE FUNCTION work_session_items_check_project();

-- tasks.actual_minutes = the sum of its sessions' minutes (NULL once it has
-- none left). Sessions with task_id NULL don't roll up. Only writes when the
-- value changes, so an unrelated session edit doesn't touch the task row.
--
-- Concurrency: the affected task rows are locked first, in id order, and only
-- then summed. Two transactions logging time for the same task serialise on
-- that lock, and because each SUM is a new statement (READ COMMITTED, the
-- PostgREST default) it sees every session committed before the lock was
-- granted, so neither total loses the other's minutes. NO KEY UPDATE doesn't
-- conflict with the KEY SHARE lock a session insert's foreign key check takes.
CREATE OR REPLACE FUNCTION work_sessions_rollup_actual_minutes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected UUID[];
  task_ref UUID;
  total INTEGER;
BEGIN
  SELECT array_agg(DISTINCT ref ORDER BY ref) INTO affected
  FROM (
    SELECT CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.task_id END AS ref
    UNION ALL
    SELECT CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.task_id END
  ) refs
  WHERE ref IS NOT NULL;

  IF affected IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM tasks WHERE id = ANY (affected) ORDER BY id FOR NO KEY UPDATE;

  FOREACH task_ref IN ARRAY affected LOOP
    SELECT SUM(minutes)::INTEGER INTO total FROM work_sessions WHERE task_id = task_ref;
    UPDATE tasks
      SET actual_minutes = total
      WHERE id = task_ref
        AND actual_minutes IS DISTINCT FROM total;
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_sessions_rollup ON work_sessions;
CREATE TRIGGER trg_work_sessions_rollup
  AFTER INSERT OR UPDATE OF task_id, minutes OR DELETE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION work_sessions_rollup_actual_minutes();

DROP TRIGGER IF EXISTS trg_work_sessions_updated ON work_sessions;
CREATE TRIGGER trg_work_sessions_updated
  BEFORE UPDATE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- A task whose sessions or linked rows live in its project can't move to
-- another project (or out of it): the stored sessions would point across
-- projects. Delete or move those sessions first. A project being deleted
-- (ON DELETE SET NULL on tasks.project_id) is allowed: its sessions go with it.
CREATE OR REPLACE FUNCTION tasks_guard_project_move_with_sessions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  IF NEW.project_id IS NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM work_sessions WHERE task_id = OLD.id)
     OR EXISTS (
       SELECT 1
       FROM work_session_items wsi
       JOIN task_checklist_items i ON i.id = wsi.checklist_item_id
       WHERE i.task_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'This task has logged work sessions in its project; delete or move those sessions before moving the task to another project'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_guard_project_move ON tasks;
CREATE TRIGGER trg_tasks_guard_project_move
  BEFORE UPDATE OF project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_guard_project_move_with_sessions();

-- ── Session writes: one function per operation, so a failure anywhere (a
-- row out of scope, a lost race, a constraint) leaves the previous state.
-- SECURITY INVOKER: RLS applies to user clients; service-role callers are
-- scoped by p_user_id. The triggers above still run inside each call.

CREATE OR REPLACE FUNCTION work_sessions_assert_caller(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot write work sessions for another user' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Checklist rows that are not the user's or not in a task of the project.
CREATE OR REPLACE FUNCTION work_sessions_out_of_scope_items(p_user_id UUID, p_project_id UUID, p_item_ids UUID[])
RETURNS UUID[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(x.id), '{}'::uuid[])
  FROM unnest(COALESCE(p_item_ids, '{}'::uuid[])) AS x(id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM task_checklist_items i
    JOIN tasks t ON t.id = i.task_id
    WHERE i.id = x.id
      AND i.user_id = p_user_id
      AND t.user_id = p_user_id
      AND t.project_id = p_project_id
  );
$$;

-- Insert a session, link its rows and (optionally) tick them, all or nothing.
-- p_session keys: project_id, task_id, session_date, started_at, ended_at,
-- minutes, extra_units, extra_work_type, note, exclude_from_stats,
-- exclude_reason, source, source_ref. Ticked rows get completed_at = ended_at
-- (or now() when the session has no end time).
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

-- Change a session; p_changes holds only the keys to change (a key with null
-- clears that field). A non-null p_item_ids replaces the linked rows
-- (ticks are never undone). All or nothing.
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

-- Delete a session and its links (rows it ticked stay ticked); the rollup runs.
CREATE OR REPLACE FUNCTION work_session_delete(p_user_id UUID, p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_project UUID;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  DELETE FROM work_sessions WHERE id = p_session_id AND user_id = p_user_id RETURNING project_id INTO v_project;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'work session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object('session_id', p_session_id, 'project_id', v_project);
END;
$$;

REVOKE ALL ON FUNCTION work_sessions_assert_caller(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION work_sessions_out_of_scope_items(UUID, UUID, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION work_session_create(UUID, JSONB, UUID[], BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION work_session_update(UUID, UUID, JSONB, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION work_session_delete(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION work_sessions_assert_caller(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION work_sessions_out_of_scope_items(UUID, UUID, UUID[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION work_session_create(UUID, JSONB, UUID[], BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION work_session_update(UUID, UUID, JSONB, UUID[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION work_session_delete(UUID, UUID) TO authenticated, service_role;

-- Explicit, because newer Supabase projects no longer auto-grant new public
-- tables to the API roles. RLS below still scopes every row to its owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_sessions, work_session_items TO authenticated, service_role;

ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_session_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own work_sessions" ON work_sessions;
CREATE POLICY "Users can view own work_sessions"
  ON work_sessions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own work_sessions" ON work_sessions;
CREATE POLICY "Users can insert own work_sessions"
  ON work_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own work_sessions" ON work_sessions;
CREATE POLICY "Users can update own work_sessions"
  ON work_sessions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own work_sessions" ON work_sessions;
CREATE POLICY "Users can delete own work_sessions"
  ON work_sessions FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own work_session_items" ON work_session_items;
CREATE POLICY "Users can view own work_session_items"
  ON work_session_items FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own work_session_items" ON work_session_items;
CREATE POLICY "Users can insert own work_session_items"
  ON work_session_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own work_session_items" ON work_session_items;
CREATE POLICY "Users can update own work_session_items"
  ON work_session_items FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own work_session_items" ON work_session_items;
CREATE POLICY "Users can delete own work_session_items"
  ON work_session_items FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
