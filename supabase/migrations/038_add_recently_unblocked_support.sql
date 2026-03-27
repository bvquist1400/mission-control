BEGIN;

CREATE TABLE task_status_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_status_transitions_task_id ON task_status_transitions(task_id);
CREATE INDEX idx_task_status_transitions_transitioned_at ON task_status_transitions(transitioned_at);
CREATE INDEX idx_task_status_transitions_user_task_transitioned_at
  ON task_status_transitions(user_id, task_id, transitioned_at DESC);

ALTER TABLE task_status_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own task status transitions" ON task_status_transitions;
DROP POLICY IF EXISTS "Users can insert own task status transitions" ON task_status_transitions;
DROP POLICY IF EXISTS "Users can delete own task status transitions" ON task_status_transitions;

CREATE POLICY "Users can view own task status transitions"
  ON task_status_transitions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own task status transitions"
  ON task_status_transitions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own task status transitions"
  ON task_status_transitions FOR DELETE
  USING (auth.uid() = user_id);

ALTER TABLE task_dependencies
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_resolved BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE task_dependencies
  DROP CONSTRAINT IF EXISTS task_dependencies_unique_task_dependency;

ALTER TABLE task_dependencies
  DROP CONSTRAINT IF EXISTS task_dependencies_unique_commitment_dependency;

CREATE UNIQUE INDEX idx_task_dependencies_unique_active_task_dependency
  ON task_dependencies(task_id, depends_on_task_id)
  WHERE depends_on_task_id IS NOT NULL AND is_resolved = false;

CREATE UNIQUE INDEX idx_task_dependencies_unique_active_commitment_dependency
  ON task_dependencies(task_id, depends_on_commitment_id)
  WHERE depends_on_commitment_id IS NOT NULL AND is_resolved = false;

CREATE INDEX idx_task_dependencies_task_resolved_at
  ON task_dependencies(task_id, resolved_at DESC)
  WHERE is_resolved = true;

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
    AND COALESCE(d.is_resolved, false) = false
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
    AND COALESCE(d.is_resolved, false) = false
  ORDER BY t.priority_score DESC;
$$;

ALTER TABLE intelligence_contract_snapshots
  DROP CONSTRAINT IF EXISTS intelligence_contract_snapshots_contract_type_check;

ALTER TABLE intelligence_contract_snapshots
  ADD CONSTRAINT intelligence_contract_snapshots_contract_type_check CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task',
      'recently_unblocked'
    )
  );

ALTER TABLE intelligence_artifacts
  DROP CONSTRAINT IF EXISTS intelligence_artifacts_primary_contract_type_check;

ALTER TABLE intelligence_artifacts
  ADD CONSTRAINT intelligence_artifacts_primary_contract_type_check CHECK (
    primary_contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task',
      'recently_unblocked'
    )
  );

ALTER TABLE intelligence_artifact_family_coverage
  DROP CONSTRAINT IF EXISTS intelligence_artifact_family_coverage_contract_type_check;

ALTER TABLE intelligence_artifact_family_coverage
  ADD CONSTRAINT intelligence_artifact_family_coverage_contract_type_check CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task',
      'recently_unblocked'
    )
  );

ALTER TABLE intelligence_artifact_contract_links
  DROP CONSTRAINT IF EXISTS intelligence_artifact_contract_links_contract_type_check;

ALTER TABLE intelligence_artifact_contract_links
  ADD CONSTRAINT intelligence_artifact_contract_links_contract_type_check CHECK (
    contract_type IN (
      'follow_up_risk',
      'blocked_waiting_stale',
      'stale_task',
      'ambiguous_task',
      'recently_unblocked'
    )
  );

COMMIT;
