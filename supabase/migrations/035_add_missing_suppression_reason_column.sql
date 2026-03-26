BEGIN;

ALTER TABLE intelligence_promotion_events
  ADD COLUMN IF NOT EXISTS suppression_reason TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;
