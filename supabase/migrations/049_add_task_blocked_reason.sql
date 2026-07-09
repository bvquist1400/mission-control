-- Migration 049: structured blocked_reason + auto follow-up for Blocked/Waiting tasks
--
-- waiting_on is free-text and stays that way (detail field). blocked_reason is a
-- new structured enum so blocked work can be grouped/filtered without parsing
-- prose. Previously zero blocked tasks had follow_up_at set, so blocked work
-- never resurfaced in the planner's follow-up machinery -- a trigger now stamps
-- follow_up_at automatically whenever a task enters Blocked/Waiting.

BEGIN;

CREATE TYPE blocked_reason AS ENUM (
  'prerequisite',
  'need_info',
  'decision',
  'approval',
  'external',
  'other'
);

ALTER TABLE tasks ADD COLUMN blocked_reason blocked_reason;

UPDATE tasks
SET blocked_reason = CASE
  WHEN waiting_on ILIKE 'not ready%' THEN 'prerequisite'::blocked_reason
  WHEN waiting_on ILIKE 'need info%' THEN 'need_info'::blocked_reason
  WHEN waiting_on ILIKE '%approval%' THEN 'approval'::blocked_reason
  WHEN waiting_on ILIKE '%decision%' THEN 'decision'::blocked_reason
  WHEN status = 'Blocked/Waiting' THEN 'other'::blocked_reason
  ELSE NULL
END
WHERE waiting_on IS NOT NULL AND waiting_on != '';

-- Helper: advance a date by n business days (skips Sat/Sun), used by both the
-- trigger below and the one-time backfill of existing blocked tasks.
CREATE FUNCTION add_business_days(start_date DATE, num_days INT)
RETURNS DATE
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  result_date DATE := start_date;
  days_added INT := 0;
BEGIN
  WHILE days_added < num_days LOOP
    result_date := result_date + 1;
    IF EXTRACT(ISODOW FROM result_date) < 6 THEN
      days_added := days_added + 1;
    END IF;
  END LOOP;
  RETURN result_date;
END;
$$;

-- Backfill: existing Blocked/Waiting tasks with no follow_up_at get one set to
-- 5pm ET three business days from today.
UPDATE tasks
SET follow_up_at = (add_business_days(CURRENT_DATE, 3) + TIME '17:00:00') AT TIME ZONE 'America/New_York'
WHERE status = 'Blocked/Waiting' AND follow_up_at IS NULL;

CREATE FUNCTION set_blocked_task_follow_up()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'Blocked/Waiting'
     AND NEW.follow_up_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.follow_up_at := (add_business_days(CURRENT_DATE, 3) + TIME '17:00:00') AT TIME ZONE 'America/New_York';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_blocked_task_follow_up
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_blocked_task_follow_up();

COMMIT;
