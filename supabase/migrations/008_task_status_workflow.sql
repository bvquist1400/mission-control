-- Migration 008: Update task status workflow
--
-- Renames status enum values:
--   Next       -> Backlog
--   Scheduled  -> Planned
--   Waiting    -> Blocked/Waiting
-- Adds new value: In Progress (between Planned and Blocked/Waiting)
-- Sets default status to Backlog
--
-- After this migration the valid task_status values are:
--   Backlog, Planned, In Progress, Blocked/Waiting, Done
-- The old values (Next, Scheduled, Waiting) no longer exist.

BEGIN;

-- Step 1: Rename enum values (idempotent — skips if already renamed)
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

-- Step 2: Add the new In Progress value
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'In Progress' AFTER 'Planned';

-- Step 3: Migrate any existing rows that might still reference old labels.
-- After RENAME VALUE the rows are already updated at the enum level, but if
-- any rows were inserted with string literals that somehow bypassed the enum
-- (e.g. via raw SQL or a text column), catch them here.
UPDATE tasks SET status = 'Backlog'       WHERE status::text = 'Next';
UPDATE tasks SET status = 'Planned'       WHERE status::text = 'Scheduled';
UPDATE tasks SET status = 'Blocked/Waiting' WHERE status::text = 'Waiting';

-- Step 4: Set new default
ALTER TABLE tasks
  ALTER COLUMN status SET DEFAULT 'Backlog';

COMMIT;
