-- Migration 046: enforce Implementation → Project → Task hierarchy
--
-- tasks.implementation_id and tasks.project_id were independent, so a task
-- could claim a different application than its project (or none at all).
-- A July 2026 audit found ~20% of project-assigned tasks inconsistent —
-- mostly tasks with a project but no application link, which made them
-- invisible to per-application rollups (health scores, blocker counts,
-- brief groupings).
--
-- Policy: the project wins.
--   * When a task has a project and that project has an implementation,
--     the task inherits it — always. Caller-supplied implementation_id is
--     overridden.
--   * When the project has no implementation, the task keeps whatever
--     implementation it has (no data is erased).
--   * When a task has no project, its implementation_id is untouched.
--   * When a project is re-pointed at a different implementation, its
--     tasks follow.

BEGIN;

-- ── Task-side trigger: inherit on insert/update ─────────────────────────
CREATE OR REPLACE FUNCTION inherit_task_implementation_from_project()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  project_implementation_id UUID;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT implementation_id INTO project_implementation_id
    FROM projects
    WHERE id = NEW.project_id;

    IF project_implementation_id IS NOT NULL THEN
      NEW.implementation_id := project_implementation_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_inherit_implementation ON tasks;
CREATE TRIGGER trg_tasks_inherit_implementation
  BEFORE INSERT OR UPDATE OF project_id, implementation_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION inherit_task_implementation_from_project();

-- ── Project-side trigger: cascade re-pointed implementations ────────────
CREATE OR REPLACE FUNCTION cascade_project_implementation_to_tasks()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.implementation_id IS NOT NULL
     AND NEW.implementation_id IS DISTINCT FROM OLD.implementation_id THEN
    UPDATE tasks
    SET implementation_id = NEW.implementation_id
    WHERE project_id = NEW.id
      AND implementation_id IS DISTINCT FROM NEW.implementation_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_cascade_implementation ON projects;
CREATE TRIGGER trg_projects_cascade_implementation
  AFTER UPDATE OF implementation_id ON projects
  FOR EACH ROW EXECUTE FUNCTION cascade_project_implementation_to_tasks();

-- ── One-time backfill of existing inconsistent rows ─────────────────────
UPDATE tasks t
SET implementation_id = p.implementation_id
FROM projects p
WHERE t.project_id = p.id
  AND p.implementation_id IS NOT NULL
  AND t.implementation_id IS DISTINCT FROM p.implementation_id;

COMMIT;
