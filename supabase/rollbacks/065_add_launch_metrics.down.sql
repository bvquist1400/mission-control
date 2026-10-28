-- Rolls back 065. Drops the seven launch-metrics tables (and every number,
-- run log row, Reddit post and milestone stored in them) and the Apple
-- latest-wins trigger function. Nothing else in Baseline reads these tables.
-- Roll the app back first: the /launch page and /api/launch-metrics/* read
-- and write them.
--
-- Alert tasks the sync created (tasks with external_source_system
-- 'launch_metrics') are ordinary tasks and are kept.
BEGIN;

DROP TABLE IF EXISTS launch_app_store_manual_reads;
DROP TABLE IF EXISTS launch_milestones;
DROP TABLE IF EXISTS launch_reddit_posts;
DROP TABLE IF EXISTS launch_metric_runs;
DROP TABLE IF EXISTS launch_apple_instances;
DROP TABLE IF EXISTS launch_source_snapshots;
DROP TABLE IF EXISTS launch_metric_daily;
DROP FUNCTION IF EXISTS launch_metric_daily_keep_latest_apple();

NOTIFY pgrst, 'reload schema';

COMMIT;
