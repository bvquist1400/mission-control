/**
 * Launch metrics (Menu & Market live dashboard, migration 065).
 *
 * Row interfaces are pinned to the generated schema in
 * `src/types/type-assertions.ts`. Everything here is counts or aggregates:
 * no account id, email or name from the Grocery app database is ever held.
 */

import type { Json } from '@/types/supabase.generated';

export type LaunchMetricSource = 'apple' | 'web' | 'app_db' | 'search_console';
export type LaunchMetricVariant = 'standard' | 'detailed' | 'seed';
export type LaunchSnapshotSource = 'app_db' | 'search_console';
export type LaunchRunTrigger = 'cron' | 'manual';
export type LaunchRunKind = 'full' | 'light';
export type LaunchRunStatus = 'running' | 'ok' | 'partial' | 'failed';
export type LaunchMilestoneKind = 'Release' | 'Tracking' | 'Users' | 'Marketing' | 'Feedback' | 'Other';

/** The sources a sync run reports on, in display order. */
export const LAUNCH_SYNC_SOURCES = ['app_db', 'web', 'search_console', 'apple'] as const;
export type LaunchSyncSource = (typeof LAUNCH_SYNC_SOURCES)[number];

export interface LaunchMetricDaily {
  user_id: string;
  metric_date: string;
  source: LaunchMetricSource;
  metric: string;
  dimension: string;
  value: number;
  variant: LaunchMetricVariant | null;
  apple_processing_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface LaunchSourceSnapshot {
  id: string;
  user_id: string;
  source: LaunchSnapshotSource;
  as_of_date: string;
  captured_at: string;
  payload: Json;
  created_at: string;
  updated_at: string;
}

export interface LaunchAppleInstance {
  user_id: string;
  instance_id: string;
  report_name: string;
  granularity: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  processing_date: string;
  segment_count: number;
  rows_parsed: number;
  fetched_at: string;
  created_at: string;
  updated_at: string;
}

export interface LaunchMetricRun {
  id: string;
  user_id: string;
  trigger: LaunchRunTrigger;
  kind: LaunchRunKind;
  started_at: string;
  finished_at: string | null;
  status: LaunchRunStatus;
  sources: Json;
  created_at: string;
  updated_at: string;
}

export interface LaunchRedditPost {
  id: string;
  user_id: string;
  label: string;
  subreddit: string;
  posted_at: string;
  views: number | null;
  upvotes: number | null;
  comments: number | null;
  stats_as_of: string | null;
  created_at: string;
  updated_at: string;
}

export interface LaunchMilestone {
  id: string;
  user_id: string;
  happened_at: string;
  label: string;
  kind: LaunchMilestoneKind;
  created_at: string;
  updated_at: string;
}

export interface LaunchAppStoreManualRead {
  id: string;
  user_id: string;
  read_on: string;
  data_through: string;
  window_label: string;
  impressions: number;
  product_page_views: number;
  first_downloads: number;
  created_at: string;
  updated_at: string;
}

/** One daily metric value as the sync writes it (user_id added at the write). */
export interface DailyMetricInput {
  metric_date: string;
  source: LaunchMetricSource;
  metric: string;
  dimension: string;
  value: number;
  variant?: LaunchMetricVariant | null;
}
