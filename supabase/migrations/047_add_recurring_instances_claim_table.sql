-- Migration 047: race-proof recurring task generation
--
-- generate-recurring detected duplicate instances by scanning existing
-- tasks' recurrence JSONB in memory. Two overlapping runs (Vercel cron +
-- manual MCP trigger) could both pass that check and double-generate an
-- instance for the same template_task_id + scheduled_date. A DB-level
-- unique constraint is the only authority that can't race.

BEGIN;

CREATE TABLE recurring_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  template_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_task_id, scheduled_date)
);

CREATE INDEX idx_recurring_instances_user_template
  ON recurring_instances(user_id, template_task_id);

ALTER TABLE recurring_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own recurring instances"
  ON recurring_instances FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own recurring instances"
  ON recurring_instances FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own recurring instances"
  ON recurring_instances FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own recurring instances"
  ON recurring_instances FOR DELETE
  USING (auth.uid() = user_id);

-- Backfill: one claim row per already-generated instance whose template
-- task still exists (some templates have since been deleted; their
-- instances can't be claimed against a template_task_id FK).
INSERT INTO recurring_instances (user_id, template_task_id, scheduled_date, task_id, created_at)
SELECT
  t.user_id,
  (t.recurrence->>'template_task_id')::uuid,
  (t.recurrence->>'next_due')::date,
  t.id,
  t.created_at
FROM tasks t
WHERE t.recurrence IS NOT NULL
  AND t.recurrence->>'enabled' = 'false'
  AND t.recurrence->>'template_task_id' IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tasks template
    WHERE template.id = (t.recurrence->>'template_task_id')::uuid
  )
ON CONFLICT (template_task_id, scheduled_date) DO NOTHING;

COMMIT;
