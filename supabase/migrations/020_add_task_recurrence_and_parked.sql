-- Power Planning: recurring task templates and parking-lot status.

ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'Parked' BEFORE 'Done';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence JSONB;
