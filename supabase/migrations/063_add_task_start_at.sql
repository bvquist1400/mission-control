-- 063: multi-day tasks, slice S1 (Baseline task 6f87add5). A task may have an
-- optional START date as well as its due date; the due date is the end of the
-- range ("Mon -> Fri"). Brent 10/26: "i should be able to manually modify a task
-- and have a start and end date".
--
-- What reads it: the pure rules in src/lib/task-range.ts (in range = not late,
-- "Day X of Y", progress, behind pace). A task is late only once its due date has
-- passed; the start date never makes a task late, never changes its priority and
-- never moves anything.
--
-- Additive only: one nullable column with no default, so existing rows and every
-- existing insert are unchanged, and ADD COLUMN is catalog-only (no rewrite, no
-- backfill).
--
-- Rule: start_at <= due_at when both are set. It is a trigger, not a CHECK
-- constraint, on purpose. A CHECK would hold for EVERY write, including the
-- cascade functions of 061/062, which only ever move due_at: the cascade moves a
-- date LATER (the range just gets longer, start <= due still holds), but Undo and
-- "switch how far" put a due date back EARLIER. If Brent set a start date on a
-- moved task between the cascade and the Undo, a CHECK would abort the whole Undo
-- (every task in it, in one transaction). So the database refuses only writes that
-- SET or CHANGE start_at (INSERT, or an UPDATE whose start_at differs from the old
-- one) to a value after due_at; a write that only moves due_at is never refused
-- here. The API also refuses a PATCH that would leave start after due (moving the
-- due date before the start included), with a plain error. When a due-only write
-- (Undo, direct SQL, the FamCal key) does leave start after due, the rules treat
-- the task as a one-day task on its due date (task-range.ts: rangeOf).
--
-- No change to 061/062's SQL: the cascade still moves only due_at, never start_at.
--
-- Errcode 23514 (check_violation), so callers can map it like a CHECK; the API
-- maps it to 400 "The start date can't be after the due date."
--
-- Rollback: supabase/rollbacks/063_add_task_start_at.down.sql (drops the trigger,
-- its function and the column; start dates are lost, nothing else changes).

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;

COMMENT ON COLUMN tasks.start_at IS
  'Optional start of a multi-day task (063). The due date is the end. Never makes a task late; set or changed only to a value <= due_at (trigger tasks_guard_start_at).';

CREATE OR REPLACE FUNCTION tasks_guard_start_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.start_at IS NULL OR NEW.due_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only a write that sets or changes the start date is checked (see the header):
  -- a due-only move (the cascade, its Undo) never fails here.
  IF TG_OP = 'UPDATE' AND NEW.start_at IS NOT DISTINCT FROM OLD.start_at THEN
    RETURN NEW;
  END IF;

  IF NEW.start_at > NEW.due_at THEN
    RAISE EXCEPTION 'start_at must be on or before due_at'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'tasks_start_at_before_due_at',
            HINT = 'The start date can''t be after the due date.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_guard_start_at ON tasks;
CREATE TRIGGER trg_tasks_guard_start_at
  BEFORE INSERT OR UPDATE OF start_at ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_guard_start_at();

COMMIT;

NOTIFY pgrst, 'reload schema';
