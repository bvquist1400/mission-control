/** Words and numbers for the Launch page (pure; New York time for instants). */

import type { SourceHealth } from './stale';

export function formatDay(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function formatEtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? '–' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

export function formatPosition(value: number | null): string {
  return value === null ? '–' : value.toFixed(1);
}

export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

const SOURCE_NAMES: Record<string, string> = {
  app_db: 'App sign-ups',
  web: 'Website',
  search_console: 'Google search',
  apple: 'App Store',
};

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

/** One line per source for the footer. */
export function healthLine(health: SourceHealth): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  const name = sourceName(health.source);
  switch (health.state) {
    case 'not_connected':
      return { text: `${name}: not connected yet (comes in phase 2)`, tone: 'neutral' };
    case 'not_configured':
      return { text: `${name}: keys not set up yet`, tone: 'neutral' };
    case 'never':
      return { text: `${name}: no update yet`, tone: 'neutral' };
    case 'fresh':
      return { text: `${name}: updated ${formatEtTime(health.lastOkAt as string)}`, tone: 'success' };
    case 'stale':
      return { text: `${name}: last good update ${formatEtTime(health.lastOkAt as string)} (out of date)`, tone: 'warning' };
    case 'failing':
      return {
        text: `${name}: last try failed (${health.lastCode})${health.lastOkAt ? `, last good update ${formatEtTime(health.lastOkAt)}` : ''}`,
        tone: 'danger',
      };
    default:
      return { text: name, tone: 'neutral' };
  }
}

export type SourceBadge = { label: string; tone: 'neutral' | 'warning' | 'danger' };

/**
 * The small state badge next to a source's tile or section. "No data yet" only
 * when nothing is stored for the source: seeded numbers are data, even before
 * the first live update.
 */
export function sourceBadge(health: SourceHealth | undefined, hasData: boolean): SourceBadge | null {
  if (!health) return null;
  switch (health.state) {
    case 'stale':
      return { label: 'Out of date', tone: 'warning' };
    case 'failing':
      return { label: 'Update failing', tone: 'danger' };
    case 'not_configured':
      return { label: 'Not set up yet', tone: 'neutral' };
    case 'never':
      return hasData ? null : { label: 'No data yet', tone: 'neutral' };
    case 'not_connected':
      return { label: 'Not connected yet', tone: 'neutral' };
    default:
      return null;
  }
}

function countOrDash(value: number | null, one: string, many: string): string {
  return value === null ? `– ${many}` : plural(value, one, many);
}

/** "1,600 views · 1 upvote · 2 comments"; a missing number is a dash. */
export function redditStats(views: number | null, upvotes: number | null, comments: number | null): string {
  const viewsText = views === null ? 'views –' : plural(views, 'view', 'views');
  return `${viewsText} · ${countOrDash(upvotes, 'upvote', 'upvotes')} · ${countOrDash(comments, 'comment', 'comments')}`;
}
