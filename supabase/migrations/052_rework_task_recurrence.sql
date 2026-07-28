-- Recurring-task usability and explicit template/instance linkage.
--
-- Frequency remains stored in tasks.recurrence JSONB. Application validation
-- adds "weekday"; no PostgreSQL enum change is required.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurring_template_id UUID,
  ADD COLUMN IF NOT EXISTS is_recurring_template BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS latest_instance_id UUID,
  ADD COLUMN IF NOT EXISTS last_generated_at TIMESTAMPTZ;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurring_template_id_fkey
    FOREIGN KEY (recurring_template_id) REFERENCES tasks(id) ON DELETE SET NULL,
  ADD CONSTRAINT tasks_latest_instance_id_fkey
    FOREIGN KEY (latest_instance_id) REFERENCES tasks(id) ON DELETE SET NULL,
  ADD CONSTRAINT tasks_recurring_template_not_self
    CHECK (recurring_template_id IS NULL OR recurring_template_id <> id),
  ADD CONSTRAINT tasks_template_has_no_parent
    CHECK (NOT is_recurring_template OR recurring_template_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_tasks_user_recurring_templates
  ON tasks(user_id, is_recurring_template)
  WHERE is_recurring_template;

CREATE INDEX IF NOT EXISTS idx_tasks_recurring_template_id
  ON tasks(recurring_template_id)
  WHERE recurring_template_id IS NOT NULL;

-- Existing generated instances already have an authoritative claim row.
UPDATE tasks AS instance
SET recurring_template_id = claim.template_task_id
FROM recurring_instances AS claim
WHERE claim.task_id = instance.id
  AND instance.recurring_template_id IS NULL;

-- Preserve active templates without relying on a status value.
UPDATE tasks
SET is_recurring_template = true
WHERE recurrence IS NOT NULL
  AND recurrence->>'enabled' = 'true'
  AND recurrence->>'template_task_id' = id::text;

-- Expose the latest linked instance and generation timestamp on each template.
UPDATE tasks AS template
SET
  latest_instance_id = (
    SELECT claim.task_id
    FROM recurring_instances AS claim
    WHERE claim.template_task_id = template.id
      AND claim.task_id IS NOT NULL
    ORDER BY claim.scheduled_date DESC, claim.created_at DESC
    LIMIT 1
  ),
  last_generated_at = (
    SELECT claim.created_at
    FROM recurring_instances AS claim
    WHERE claim.template_task_id = template.id
      AND claim.task_id IS NOT NULL
    ORDER BY claim.scheduled_date DESC, claim.created_at DESC
    LIMIT 1
  )
WHERE template.is_recurring_template;

-- Repair old generated instances that were created without a due timestamp.
-- Mission Control currently uses America/New_York as its single configured
-- user timezone; AT TIME ZONE handles EST/EDT for each scheduled date.
UPDATE tasks AS instance
SET due_at = (
  claim.scheduled_date + TIME '23:59:59.999'
) AT TIME ZONE 'America/New_York'
FROM recurring_instances AS claim
WHERE claim.task_id = instance.id
  AND instance.due_at IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
