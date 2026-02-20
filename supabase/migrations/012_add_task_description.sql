-- Migration 012: Add description field to tasks
--
-- Stores detailed task context (notes, links, source details) separately
-- from the short task title.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMIT;
