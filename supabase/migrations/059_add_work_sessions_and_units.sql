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
-- rows and every existing insert are unchanged. Nothing outside the new pace
-- routes / MCP tools reads sessions; tasks.actual_minutes (rolled up from
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
CREATE OR REPLACE FUNCTION work_sessions_rollup_actual_minutes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected UUID;
  total INTEGER;
BEGIN
  FOR affected IN
    SELECT DISTINCT task_ref FROM (
      SELECT CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.task_id END AS task_ref
      UNION ALL
      SELECT CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.task_id END
    ) refs
    WHERE task_ref IS NOT NULL
  LOOP
    SELECT SUM(minutes)::INTEGER INTO total FROM work_sessions WHERE task_id = affected;
    UPDATE tasks
      SET actual_minutes = total
      WHERE id = affected
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
