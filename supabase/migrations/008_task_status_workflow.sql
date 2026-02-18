-- Update task status workflow:
-- Backlog, Planned, In Progress, Blocked/Waiting, Done

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'task_status' AND e.enumlabel = 'Next'
  ) THEN
    ALTER TYPE task_status RENAME VALUE 'Next' TO 'Backlog';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'task_status' AND e.enumlabel = 'Scheduled'
  ) THEN
    ALTER TYPE task_status RENAME VALUE 'Scheduled' TO 'Planned';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'task_status' AND e.enumlabel = 'Waiting'
  ) THEN
    ALTER TYPE task_status RENAME VALUE 'Waiting' TO 'Blocked/Waiting';
  END IF;
END $$;

ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'In Progress' AFTER 'Planned';

ALTER TABLE tasks
  ALTER COLUMN status SET DEFAULT 'Backlog';
