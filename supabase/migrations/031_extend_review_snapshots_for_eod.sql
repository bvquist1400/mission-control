BEGIN;

ALTER TABLE briefing_review_snapshots
  DROP CONSTRAINT IF EXISTS briefing_review_snapshots_review_type_check;

ALTER TABLE briefing_review_snapshots
  ADD CONSTRAINT briefing_review_snapshots_review_type_check
  CHECK (review_type IN ('eod', 'weekly', 'monthly'));

COMMIT;
