-- Rollback for 068_brief_revisions.sql: drops brief_refresh_content and the
-- brief_revisions table. The content each refresh replaced is lost; briefs keep
-- their current (refreshed) content and items. `content.refreshes` stays in the
-- stored JSON, where the older app ignores it. Roll the app back first: this
-- change's save path calls brief_refresh_content on every mode "refresh" save.
-- Re-running is safe.

BEGIN;

DROP FUNCTION IF EXISTS brief_refresh_content(UUID, UUID, JSONB, TEXT[], JSONB);
DROP TABLE IF EXISTS brief_revisions;

COMMIT;
