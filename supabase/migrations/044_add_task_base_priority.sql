-- Migration 044: add tasks.base_priority to stop priority-boost compounding
--
-- Problem: priority recalculation used the stored (already-boosted)
-- priority_score as its base and re-added boosts on every status/due_at
-- update, so scores ratcheted toward 100 (or oscillated with the waiting
-- penalty) as a function of edit frequency rather than actual priority.
--
-- Fix: store the un-boosted base separately. priority_score remains the
-- derived, indexed sort column and is always recomputed as
--   clamp(base_priority + boosts(current state), 0, 100).

BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_priority INT NOT NULL DEFAULT 50
  CHECK (base_priority >= 0 AND base_priority <= 100);

-- One-time backfill: adopt the current priority_score as the new base.
-- Historical scores may include compounded boosts; that noise is accepted
-- once here and washes out as tasks are edited going forward. The waiting
-- penalty is backed out for Blocked/Waiting tasks so they don't get
-- double-penalized on their next recalculation.
UPDATE tasks
SET base_priority = LEAST(
  GREATEST(
    priority_score + CASE WHEN status = 'Blocked/Waiting' THEN 20 ELSE 0 END,
    0
  ),
  100
);

COMMIT;
