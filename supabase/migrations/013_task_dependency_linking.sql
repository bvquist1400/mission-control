-- Task Dependency Linking v1
-- Expands task_dependencies to support dependencies on tasks or commitments.

BEGIN;

ALTER TABLE task_dependencies
  RENAME COLUMN blocked_task_id TO task_id;

ALTER TABLE task_dependencies
  RENAME COLUMN blocker_task_id TO depends_on_task_id;

ALTER TABLE task_dependencies
  ALTER COLUMN depends_on_task_id DROP NOT NULL;

ALTER TABLE task_dependencies
  ADD COLUMN depends_on_commitment_id UUID REFERENCES commitments(id) ON DELETE CASCADE;

ALTER TABLE task_dependencies
  DROP CONSTRAINT IF EXISTS no_self_dependency;

ALTER TABLE task_dependencies
  DROP CONSTRAINT IF EXISTS unique_dependency;

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_one_target
  CHECK (((depends_on_task_id IS NOT NULL)::integer + (depends_on_commitment_id IS NOT NULL)::integer) = 1);

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_no_self_task
  CHECK (depends_on_task_id IS NULL OR depends_on_task_id <> task_id);

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_unique_task_dependency
  UNIQUE (task_id, depends_on_task_id);

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_unique_commitment_dependency
  UNIQUE (task_id, depends_on_commitment_id);

DROP INDEX IF EXISTS idx_task_dependencies_blocked;
DROP INDEX IF EXISTS idx_task_dependencies_blocker;

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_task
  ON task_dependencies(depends_on_task_id)
  WHERE depends_on_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on_commitment
  ON task_dependencies(depends_on_commitment_id)
  WHERE depends_on_commitment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION get_blocking_tasks(p_task_id UUID)
RETURNS TABLE (
  dependency_id UUID,
  task_id UUID,
  title TEXT,
  status task_status,
  blocker BOOLEAN,
  implementation_id UUID,
  implementation_name TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    d.id AS dependency_id,
    t.id AS task_id,
    t.title,
    t.status,
    t.blocker,
    t.implementation_id,
    i.name AS implementation_name
  FROM task_dependencies d
  JOIN tasks t ON t.id = d.depends_on_task_id
  LEFT JOIN implementations i ON i.id = t.implementation_id
  WHERE d.task_id = p_task_id
    AND d.depends_on_task_id IS NOT NULL
  ORDER BY t.priority_score DESC;
$$;

CREATE OR REPLACE FUNCTION get_blocked_by_tasks(p_task_id UUID)
RETURNS TABLE (
  dependency_id UUID,
  task_id UUID,
  title TEXT,
  status task_status,
  blocker BOOLEAN,
  implementation_id UUID,
  implementation_name TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    d.id AS dependency_id,
    t.id AS task_id,
    t.title,
    t.status,
    t.blocker,
    t.implementation_id,
    i.name AS implementation_name
  FROM task_dependencies d
  JOIN tasks t ON t.id = d.task_id
  LEFT JOIN implementations i ON i.id = t.implementation_id
  WHERE d.depends_on_task_id = p_task_id
  ORDER BY t.priority_score DESC;
$$;

COMMIT;
