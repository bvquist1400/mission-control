-- Menu & Market launch numbers (live dashboard phase 1, Baseline task d51b2848).
--
-- Stores a daily copy of the launch metrics that the /launch page shows, so
-- history keeps growing even when a source only keeps a short window (Apple's
-- daily reports, Search Console's 16 months, Vercel's plan window).
--
-- COUNTS ONLY (Brent 10/27, decision 1): nothing here holds an account id,
-- email, name or any per-person value from the Grocery app database. The app
-- database sends daily totals; this migration has no column that could hold
-- an account. Website and Search Console rows are aggregates as well.
--
-- Additive only: seven new tables, one trigger function, no change to any
-- existing table. Rollback: supabase/rollbacks/065_add_launch_metrics.down.sql
-- (drops the tables and everything stored in them).
--
-- Numbered 065 because 063 (multi-day tasks) and 064 (brief pick-a-date) are
-- reserved by branches that ship first.

BEGIN;

-- ── One row per day per metric (and per breakdown value) ─────────────────
-- source: where the number came from. metric_date: the source's own day
-- (app_db = America/New_York, web = UTC, search_console = Pacific, Apple =
-- Apple's report date). dimension '' = the day's total; otherwise
-- '<kind>:<value>', e.g. 'referrer:www.google.com' or 'placement:site-hero'.
CREATE TABLE IF NOT EXISTS launch_metric_daily (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('apple', 'web', 'app_db', 'search_console')),
  metric TEXT NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{0,59}$'),
  dimension TEXT NOT NULL DEFAULT '' CHECK (char_length(dimension) <= 300),
  value NUMERIC NOT NULL CHECK (value >= 0),
  -- Apple: which report family the row came from. 'seed' (any source) = imported
  -- from the hand-kept CSVs before the live sync existed; a live sync of the
  -- same day overwrites it.
  variant TEXT CHECK (variant IS NULL OR variant IN ('standard', 'detailed', 'seed')),
  -- Apple only: the instance's processing date. A later processing date
  -- replaces an earlier one; an older one never overwrites (trigger below).
  apple_processing_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric_date, source, metric, dimension)
);

CREATE INDEX IF NOT EXISTS idx_launch_metric_daily_source_date
  ON launch_metric_daily(user_id, source, metric_date DESC);

-- Apple's rule: the newest instance for a day wins; never merge two. An
-- upsert (INSERT … ON CONFLICT DO UPDATE) runs BEFORE UPDATE triggers, so a
-- stale instance is dropped here even if app code forgets to check.
CREATE OR REPLACE FUNCTION launch_metric_daily_keep_latest_apple()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.source = 'apple'
     AND OLD.apple_processing_date IS NOT NULL
     AND (NEW.apple_processing_date IS NULL OR NEW.apple_processing_date < OLD.apple_processing_date) THEN
    RETURN NULL; -- keep the newer stored row
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_launch_metric_daily_keep_latest_apple ON launch_metric_daily;
CREATE TRIGGER trg_launch_metric_daily_keep_latest_apple
  BEFORE UPDATE ON launch_metric_daily
  FOR EACH ROW EXECUTE FUNCTION launch_metric_daily_keep_latest_apple();

-- ── Latest validated snapshot per source per day ─────────────────────────
-- app_db: the counts-only summary from the Grocery `launch-metrics` function
-- (validated against an allowlist before it is written). search_console: the
-- aggregated top queries/pages for the window. Last capture of the day wins.
CREATE TABLE IF NOT EXISTS launch_source_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('app_db', 'search_console')),
  as_of_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT launch_source_snapshots_unique_day UNIQUE (user_id, source, as_of_date)
);

-- ── Apple report instances already read (phase 2 idempotency + audit) ────
CREATE TABLE IF NOT EXISTS launch_apple_instances (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL CHECK (char_length(instance_id) BETWEEN 1 AND 200),
  report_name TEXT NOT NULL CHECK (char_length(report_name) BETWEEN 1 AND 200),
  granularity TEXT NOT NULL CHECK (granularity IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  processing_date DATE NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  rows_parsed INTEGER NOT NULL DEFAULT 0 CHECK (rows_parsed >= 0),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, instance_id)
);

-- ── Run log: one row per sync run, per-source result as short codes ──────
-- sources: {"web":"ok","app_db":"http_401","search_console":"skipped",
-- "apple":"not_connected"}. Codes only, never a response body (app code
-- builds them from a fixed list; the CHECK keeps the shape honest).
CREATE TABLE IF NOT EXISTS launch_metric_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  kind TEXT NOT NULL CHECK (kind IN ('full', 'light')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  sources JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sources) = 'object' AND octet_length(sources::text) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_launch_metric_runs_user_started
  ON launch_metric_runs(user_id, started_at DESC);

-- ── Reddit posts (kept by hand on the page) ──────────────────────────────
CREATE TABLE IF NOT EXISTS launch_reddit_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  subreddit TEXT NOT NULL CHECK (subreddit ~ '^r/[A-Za-z0-9_]{2,21}$'),
  posted_at TIMESTAMPTZ NOT NULL,
  views INTEGER CHECK (views IS NULL OR views >= 0),
  upvotes INTEGER CHECK (upvotes IS NULL OR upvotes BETWEEN -1000000 AND 100000000),
  comments INTEGER CHECK (comments IS NULL OR comments >= 0),
  stats_as_of TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT launch_reddit_posts_unique_post UNIQUE (user_id, subreddit, posted_at)
);

-- ── Launch timeline (kept by hand on the page) ───────────────────────────
CREATE TABLE IF NOT EXISTS launch_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  happened_at TIMESTAMPTZ NOT NULL,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('Release', 'Tracking', 'Users', 'Marketing', 'Feedback', 'Other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT launch_milestones_unique_event UNIQUE (user_id, happened_at, label)
);

-- ── App Store numbers read by hand from App Store Connect ───────────────
-- The old dashboard's reads (a window total, not daily). Kept so they stay
-- visible next to the live Apple data once phase 2 lands.
CREATE TABLE IF NOT EXISTS launch_app_store_manual_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_on DATE NOT NULL,
  data_through DATE NOT NULL,
  window_label TEXT NOT NULL CHECK (char_length(btrim(window_label)) BETWEEN 1 AND 80),
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  product_page_views INTEGER NOT NULL CHECK (product_page_views >= 0),
  first_downloads INTEGER NOT NULL CHECK (first_downloads >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT launch_app_store_manual_reads_unique_read UNIQUE (user_id, read_on, window_label)
);

-- ── updated_at triggers ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_launch_metric_daily_updated_at ON launch_metric_daily;
CREATE TRIGGER trg_launch_metric_daily_updated_at BEFORE UPDATE ON launch_metric_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_source_snapshots_updated_at ON launch_source_snapshots;
CREATE TRIGGER trg_launch_source_snapshots_updated_at BEFORE UPDATE ON launch_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_apple_instances_updated_at ON launch_apple_instances;
CREATE TRIGGER trg_launch_apple_instances_updated_at BEFORE UPDATE ON launch_apple_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_metric_runs_updated_at ON launch_metric_runs;
CREATE TRIGGER trg_launch_metric_runs_updated_at BEFORE UPDATE ON launch_metric_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_reddit_posts_updated_at ON launch_reddit_posts;
CREATE TRIGGER trg_launch_reddit_posts_updated_at BEFORE UPDATE ON launch_reddit_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_milestones_updated_at ON launch_milestones;
CREATE TRIGGER trg_launch_milestones_updated_at BEFORE UPDATE ON launch_milestones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_launch_app_store_manual_reads_updated_at ON launch_app_store_manual_reads;
CREATE TRIGGER trg_launch_app_store_manual_reads_updated_at BEFORE UPDATE ON launch_app_store_manual_reads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

REVOKE ALL ON FUNCTION launch_metric_daily_keep_latest_apple() FROM PUBLIC, anon;

-- ── Grants (newer stacks don't auto-grant; see 055) ──────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  launch_metric_daily,
  launch_source_snapshots,
  launch_apple_instances,
  launch_metric_runs,
  launch_reddit_posts,
  launch_milestones,
  launch_app_store_manual_reads
TO authenticated, service_role;

-- ── RLS: the 4-policy pattern on every table ─────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'launch_metric_daily',
    'launch_source_snapshots',
    'launch_apple_instances',
    'launch_metric_runs',
    'launch_reddit_posts',
    'launch_milestones',
    'launch_app_store_manual_reads'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Users can view own ' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING ((select auth.uid()) = user_id)', 'Users can view own ' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Users can insert own ' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK ((select auth.uid()) = user_id)', 'Users can insert own ' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Users can update own ' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id)', 'Users can update own ' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Users can delete own ' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING ((select auth.uid()) = user_id)', 'Users can delete own ' || t, t);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
