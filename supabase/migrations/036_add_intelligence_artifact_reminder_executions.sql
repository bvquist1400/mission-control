BEGIN;

CREATE TABLE IF NOT EXISTS intelligence_artifact_reminder_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  execution_kind TEXT NOT NULL CHECK (
    execution_kind IN (
      'task_comment_reminder'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'started',
      'completed'
    )
  ),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_comment_id UUID REFERENCES task_comments(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_artifact_reminder_executions_unique UNIQUE (artifact_id, execution_kind)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_artifact_reminder_executions_user_artifact_created
  ON intelligence_artifact_reminder_executions(user_id, artifact_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_intelligence_artifact_reminder_executions_updated
  ON intelligence_artifact_reminder_executions;

CREATE TRIGGER trg_intelligence_artifact_reminder_executions_updated
  BEFORE UPDATE ON intelligence_artifact_reminder_executions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE intelligence_artifact_reminder_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions;
DROP POLICY IF EXISTS "Users can insert own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions;
DROP POLICY IF EXISTS "Users can update own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions;
DROP POLICY IF EXISTS "Users can delete own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions;

CREATE POLICY "Users can view own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own intelligence artifact reminder executions"
  ON intelligence_artifact_reminder_executions FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
