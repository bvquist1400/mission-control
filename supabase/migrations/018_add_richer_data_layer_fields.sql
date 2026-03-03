-- Richer data layer fields for stakeholder context and task actuals.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS actual_minutes INT CHECK (actual_minutes IS NULL OR actual_minutes >= 0);

ALTER TABLE stakeholders
  ADD COLUMN IF NOT EXISTS context JSONB;

UPDATE stakeholders
SET context = COALESCE(
  context,
  '{"last_contacted_at":null,"preferred_contact":null,"current_priorities":null,"notes":null}'::jsonb
);

ALTER TABLE stakeholders
  ALTER COLUMN context SET DEFAULT '{"last_contacted_at":null,"preferred_contact":null,"current_priorities":null,"notes":null}'::jsonb,
  ALTER COLUMN context SET NOT NULL;
