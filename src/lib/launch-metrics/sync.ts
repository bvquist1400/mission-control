/**
 * One launch-metrics sync run (plan §3.4, piece 7; Apple added in phase 2).
 *
 * - full (07:30 ET cron, "Refresh now"): app database + website + Search Console + Apple.
 * - light (hourly cron): app database + website only (Search Console and Apple `skipped`).
 * - Apple without any ASC_* value is `not_connected` (never a crash).
 * Each source runs on its own; one failure never stops the others. The run log
 * always gets a row, with one short code per source and nothing else. Decision
 * 6 alerts are evaluated after the run is recorded.
 */

import type { Json } from '@/types/supabase.generated';
import { appDbDailyRows, fetchAppDbSummary, readAppDbConfig, type AppDbConfig } from './app-db';
import { evaluateAlerts, type AlertOutcome } from './alerts';
import { readAppleConfig, syncApple, type AppleConfig } from './apple';
import { etDate } from './dates';
import { errorCode, type FetchLike } from './http';
import { fetchSearchConsoleMetrics, readSearchConsoleConfig, type SearchConsoleConfig } from './search-console';
import type { LaunchStore } from './store';
import type { LaunchRunKind, LaunchRunStatus, LaunchRunTrigger, LaunchSyncSource } from './types';
import { fetchWebMetrics, readVercelAnalyticsConfig, type VercelAnalyticsConfig } from './vercel-analytics';

export interface LaunchEnv {
  appDb: AppDbConfig | null;
  web: VercelAnalyticsConfig | null;
  searchConsole: SearchConsoleConfig | null;
  /** null = no ASC_* value set (not connected); otherwise validated at run time. */
  apple: AppleConfig | null;
  alertProjectId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLaunchEnv(env: Record<string, string | undefined>): LaunchEnv {
  const project = env.LAUNCH_METRICS_ALERT_PROJECT_ID?.trim() ?? '';
  return {
    appDb: readAppDbConfig(env),
    web: readVercelAnalyticsConfig(env),
    searchConsole: readSearchConsoleConfig(env),
    apple: readAppleConfig(env),
    alertProjectId: UUID.test(project) ? project : null,
  };
}

export interface SyncDeps {
  store: LaunchStore;
  env: LaunchEnv;
  fetchImpl: FetchLike;
  now: () => Date;
}

export interface SyncResult {
  status: LaunchRunStatus | 'busy';
  run_id: string | null;
  sources: Record<string, string>;
  alerts: AlertOutcome[];
}

/** A run still marked running and younger than this blocks a new one. */
export const RUN_BUSY_WINDOW_MS = 5 * 60_000;
/** "Refresh now" is refused while any run started in the last minute. */
export const MANUAL_COOLDOWN_MS = 60_000;

export function runStatus(sources: Record<string, string>): LaunchRunStatus {
  const counted = Object.values(sources).filter((code) => code !== 'skipped' && code !== 'not_connected');
  if (counted.length === 0 || counted.every((code) => code === 'ok')) {
    return 'ok';
  }
  return counted.some((code) => code === 'ok') ? 'partial' : 'failed';
}

async function attempt(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return errorCode(error);
  }
}

export async function runLaunchSync(
  deps: SyncDeps,
  options: { trigger: LaunchRunTrigger; kind: LaunchRunKind }
): Promise<SyncResult> {
  const { store, env, fetchImpl } = deps;
  const startedAt = deps.now();

  const recent = await store.recentRuns(5);
  const busy = recent.some(
    (run) => run.status === 'running' && startedAt.getTime() - Date.parse(run.started_at) < RUN_BUSY_WINDOW_MS
  );
  if (busy) {
    return { status: 'busy', run_id: null, sources: {}, alerts: [] };
  }

  const runId = await store.insertRun({ trigger: options.trigger, kind: options.kind, started_at: startedAt.toISOString() });
  const sources: Record<LaunchSyncSource, string> = {
    app_db: 'skipped',
    web: 'skipped',
    search_console: 'skipped',
    apple: 'skipped',
  };

  sources.app_db = env.appDb
    ? await attempt(async () => {
        const now = deps.now();
        const summary = await fetchAppDbSummary(env.appDb as AppDbConfig, fetchImpl, now);
        const asOf = etDate(now);
        await store.upsertDaily(appDbDailyRows(summary, asOf));
        await store.upsertSnapshot('app_db', asOf, now.toISOString(), summary as unknown as Json);
      })
    : 'not_configured';

  sources.web = env.web
    ? await attempt(async () => {
        const today = deps.now().toISOString().slice(0, 10);
        const result = await fetchWebMetrics(env.web as VercelAnalyticsConfig, fetchImpl, today);
        await store.upsertDaily(result.rows);
      })
    : 'not_configured';

  if (options.kind === 'full') {
    sources.search_console = env.searchConsole
      ? await attempt(async () => {
          const now = deps.now();
          const result = await fetchSearchConsoleMetrics(env.searchConsole as SearchConsoleConfig, fetchImpl, now);
          await store.upsertDaily(result.rows);
          await store.upsertSnapshot('search_console', result.topLists.until, now.toISOString(), result.topLists as unknown as Json);
        })
      : 'not_configured';

    // Last: it is the slowest, and it stops starting new report files after
    // its own time budget, so the route finishes inside its 120 seconds.
    sources.apple = env.apple
      ? await attempt(async () => {
          await syncApple(env.apple as AppleConfig, fetchImpl, store, deps.now);
        })
      : 'not_connected';
  }

  const status = runStatus(sources);
  await store.finishRun(runId, { status, sources, finished_at: deps.now().toISOString() });

  let alerts: AlertOutcome[] = [];
  try {
    const runs = await store.recentRuns(50);
    alerts = await evaluateAlerts(store, runs, deps.now(), env.alertProjectId);
  } catch {
    alerts = [];
  }

  return { status, run_id: runId, sources, alerts };
}
