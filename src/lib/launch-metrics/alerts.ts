/**
 * Decision 6 (Brent 10/27): when a source fails two runs in a row, create ONE
 * Baseline task for Brent; never a second open task for the same source;
 * close it with a note when the source recovers.
 *
 * One task per source, ever: the task carries the external id
 * `launch_metrics` / `source:<name>` (migration 054's unique index), so two
 * runs at once can't both create it. A later outage reopens the same task.
 *
 * Counted as a run for a source: any finished run that tried it. Runs that
 * skipped it (a light run for Search Console and Apple), Apple with no keys
 * (`not_connected`) and sources with no keys set (`not_configured`, shown on
 * the page instead) don't count either way.
 */

import { etDate } from './dates';
import type { AlertTask, LaunchStore, RunRecord } from './store';

export const ALERTED_SOURCES = ['app_db', 'web', 'search_console', 'apple'] as const;
export type AlertedSource = (typeof ALERTED_SOURCES)[number];

/** Codes that are not an attempt (no alert, no recovery). */
export const NEUTRAL_CODES = new Set(['skipped', 'not_connected', 'not_configured']);

export const SOURCE_LABELS: Record<string, string> = {
  app_db: 'app sign-ups',
  web: 'website visits',
  search_console: 'Google search',
  apple: 'App Store',
};

const OPEN_STATUSES = new Set(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting']);

export function plainReason(code: string): string {
  if (code === 'apple_request_stopped') {
    return 'Apple stopped the daily report request because its reports went unread for too long; the Apple setup script has to run again';
  }
  if (code === 'apple_no_request') {
    return 'Apple has no daily report request for the app yet; the Apple setup script has to run';
  }
  if (code === 'apple_bad_key' || code === 'apple_bad_config') {
    return 'the App Store key or one of its settings looks wrong';
  }
  if (code === 'apple_checksum' || code === 'apple_segment_size') {
    return "a report file from Apple didn't match its checksum or size, so nothing from it was saved";
  }
  if (code === 'apple_tsv_header') {
    return "Apple's report columns were not the expected ones, so nothing was saved";
  }
  if (code === 'apple_segment_host') {
    return 'a report file was on an unexpected address, so it was not downloaded';
  }
  if (code === 'apple_reports_missing') {
    return "Apple's report list did not include the expected App Store reports";
  }
  if (code.startsWith('apple_tsv_') || code === 'apple_gzip' || code === 'apple_too_many_rows' || code === 'apple_too_many_pages' || code === 'apple_segment_too_large') {
    return 'the reply was not in the expected shape, so nothing was saved';
  }
  if (code === 'http_401' || code === 'http_403' || code.endsWith('_bad_token')) {
    return 'the key was refused or has expired';
  }
  if (code.startsWith('gsc_token_') || code === 'gsc_bad_key' || code === 'gsc_bad_email') {
    return 'Google refused the service account key';
  }
  if (code === 'http_404' || code.endsWith('_bad_url') || code === 'gsc_bad_site' || code === 'web_bad_config') {
    return 'the address or project setting looks wrong';
  }
  if (code === 'http_429') {
    return 'the service asked us to slow down';
  }
  if (code === 'timeout' || code === 'network' || /^http_5\d\d$/.test(code)) {
    return 'the service did not answer';
  }
  if (code.endsWith('_shape') || code.endsWith('_not_counts') || code === 'bad_json' || code === 'too_large') {
    return 'the reply was not in the expected shape, so nothing was saved';
  }
  if (code === 'db_write' || code === 'db_read') {
    return 'Baseline could not save the numbers';
  }
  return `error code ${code}`;
}

/** The source's attempts, newest first (codes only). */
export function attemptsFor(runs: RunRecord[], source: string): string[] {
  return runs
    .filter((run) => run.finished_at !== null && run.status !== 'running')
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map((run) => run.sources[source])
    .filter((code): code is string => typeof code === 'string' && !NEUTRAL_CODES.has(code));
}

export type AlertDecision =
  | { action: 'none' }
  | { action: 'raise'; code: string; streak: number }
  | { action: 'recover' };

/** Pure: what the latest attempts say for one source. */
export function decideAlert(attempts: string[]): AlertDecision {
  if (attempts.length === 0) {
    return { action: 'none' };
  }
  if (attempts[0] === 'ok') {
    return { action: 'recover' };
  }
  if (attempts.length >= 2 && attempts[1] !== 'ok') {
    let streak = 0;
    while (streak < attempts.length && attempts[streak] !== 'ok') {
      streak += 1;
    }
    return { action: 'raise', code: attempts[0], streak };
  }
  return { action: 'none' };
}

function etStamp(now: Date): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return `${time} ET`;
}

export function alertTexts(source: string, code: string, now: Date) {
  const label = SOURCE_LABELS[source] ?? source;
  const reason = plainReason(code);
  const statusLine = `The ${label} numbers on the Launch page failed twice in a row: ${reason}. The runbook says what to check.`.slice(0, 280);
  return {
    title: `Launch numbers: ${label} stopped updating`,
    statusLine,
    description: [
      `The Launch page could not update the ${label} numbers on two runs in a row (last tried ${etStamp(now)}).`,
      `Why: ${reason} (code ${code}).`,
      'What to do: open the Launch page in Baseline, look at "Last update" at the bottom, then follow docs/runbooks/launch-metrics.md for this source (key rotation, token expiry, Search Console access, Apple request stopped).',
      'This task closes itself with a note when the numbers update again. Only one task is ever open per source.',
    ].join('\n\n'),
    openComment: `Opened automatically: the ${label} update failed on two runs in a row (${etStamp(now)}): ${reason} (code ${code}).`,
    reopenComment: `Failing again since ${etStamp(now)}: ${reason} (code ${code}). Reopened this task instead of creating a new one.`,
    recoverComment: `Recovered: the ${label} numbers updated again at ${etStamp(now)}. Closed automatically.`,
    recoverStatusLine: `Recovered ${etDate(now)}: the ${label} numbers are updating again.`,
  };
}

export interface AlertOutcome {
  source: AlertedSource;
  action: 'none' | 'created' | 'already_open' | 'reopened' | 'left_closed' | 'resolved' | 'error';
}

async function raise(store: LaunchStore, source: AlertedSource, code: string, streak: number, now: Date, projectId: string | null): Promise<AlertOutcome['action']> {
  const texts = alertTexts(source, code, now);
  const externalId = `source:${source}`;
  let task: AlertTask | null = await store.findAlertTask(externalId);
  if (!task) {
    task = await store.createAlertTask({
      title: texts.title,
      description: texts.description,
      status_line: texts.statusLine,
      external_source_id: externalId,
      project_id: projectId,
    });
    if (!task) {
      return 'already_open'; // another run created it a moment ago
    }
    await store.addTaskComment(task.id, texts.openComment);
    return 'created';
  }
  if (OPEN_STATUSES.has(task.status)) {
    return 'already_open';
  }
  // Closed (by recovery or by hand). Reopen only as the streak crosses two, so
  // a task Brent closes during a long outage stays closed until the next one.
  if (streak !== 2) {
    return 'left_closed';
  }
  await store.updateAlertTask(task.id, { status: 'Planned', owner: 'brent', owner_label: null, status_line: texts.statusLine });
  await store.addTaskComment(task.id, texts.reopenComment);
  return 'reopened';
}

async function recover(store: LaunchStore, source: AlertedSource, now: Date): Promise<AlertOutcome['action']> {
  const task = await store.findAlertTask(`source:${source}`);
  if (!task || !OPEN_STATUSES.has(task.status)) {
    return 'none';
  }
  const texts = alertTexts(source, 'ok', now);
  await store.updateAlertTask(task.id, { status: 'Done', owner: 'agent', owner_label: null, status_line: texts.recoverStatusLine });
  await store.addTaskComment(task.id, texts.recoverComment);
  return 'resolved';
}

/** Applies decision 6 for every alerted source. A failure here never fails the run. */
export async function evaluateAlerts(
  store: LaunchStore,
  runs: RunRecord[],
  now: Date,
  projectId: string | null
): Promise<AlertOutcome[]> {
  const outcomes: AlertOutcome[] = [];
  for (const source of ALERTED_SOURCES) {
    const decision = decideAlert(attemptsFor(runs, source));
    try {
      if (decision.action === 'raise') {
        outcomes.push({ source, action: await raise(store, source, decision.code, decision.streak, now, projectId) });
      } else if (decision.action === 'recover') {
        outcomes.push({ source, action: await recover(store, source, now) });
      } else {
        outcomes.push({ source, action: 'none' });
      }
    } catch {
      outcomes.push({ source, action: 'error' });
    }
  }
  return outcomes;
}
