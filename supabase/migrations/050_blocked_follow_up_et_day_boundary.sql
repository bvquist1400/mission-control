-- Migration 050: anchor blocked-task follow-up dates to the ET calendar day
--
-- set_blocked_task_follow_up() (049) used CURRENT_DATE, which is the UTC date
-- on the server. Between 8pm and midnight ET, CURRENT_DATE is already
-- "tomorrow", so a task blocked in the evening got its follow-up one business
-- day later than intended. The app's day boundary is America/New_York
-- everywhere else (sync-today, briefs, recurring generation) — match it.

BEGIN;

CREATE OR REPLACE FUNCTION set_blocked_task_follow_up()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'Blocked/Waiting'
     AND NEW.follow_up_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.follow_up_at := (
      add_business_days((now() AT TIME ZONE 'America/New_York')::date, 3) + TIME '17:00:00'
    ) AT TIME ZONE 'America/New_York';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
