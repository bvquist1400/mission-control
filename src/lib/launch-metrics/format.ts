/** Words and numbers for the Launch page (pure; New York time for instants). */

import type { AppStoreView, HeadlineWindow } from './page-data';
import type { SourceHealth } from './stale';

export function formatDay(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** "Mon Oct 26" for a calendar day (the chart tooltip and event key). */
export function formatWeekdayDay(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(day);
  return `${weekday} ${formatDay(isoDate)}`;
}

/** "3:05 PM" New York time for an instant (the chart's event key). */
export function formatEtClock(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
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

/** A count, or a dash when it isn't known: a real 0 stays "0". */
export function formatCountOrDash(value: number | null): string {
  return value === null ? '–' : formatCount(value);
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
function familyThrough(label: string, family: { through: string | null; stale: boolean }, empty: string): string {
  if (family.through === null) {
    return empty;
  }
  return `${label} through ${formatDay(family.through)}${family.stale ? ' (out of date)' : ''}`;
}

/** How far Apple's data goes, per report family; null when there is none. */
export function appleDataText(health: SourceHealth | undefined): string | null {
  const data = health?.appleData;
  if (!data || (data.engagement.through === null && data.downloads.through === null)) {
    return null;
  }
  if (data.engagement.through === data.downloads.through) {
    return familyThrough('data', data.downloads, '');
  }
  return [
    familyThrough('downloads', data.downloads, 'no downloads report yet'),
    familyThrough('impressions and page views', data.engagement, 'no impressions or page views report yet'),
  ].join(', ');
}

type HealthLine = { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' };

function appleHealthLine(health: SourceHealth): HealthLine | null {
  const reached = health.lastOkAt ? `last reached Apple ${formatEtTime(health.lastOkAt)}` : null;
  const data = appleDataText(health);
  if (health.state === 'fresh' && data) {
    return { text: `App Store: ${data}; ${reached}`, tone: 'success' };
  }
  if (health.state === 'stale') {
    return { text: `App Store: ${[data ?? 'no data yet', reached].filter(Boolean).join('; ')}`, tone: 'warning' };
  }
  if (health.state === 'waiting') {
    return { text: `App Store: waiting for Apple's first report; ${reached}`, tone: 'neutral' };
  }
  if (health.state === 'failing') {
    return { text: `App Store: ${[`last try failed (${health.lastCode})`, reached, data].filter(Boolean).join('; ')}`, tone: 'danger' };
  }
  return null;
}

export function healthLine(health: SourceHealth): HealthLine {
  const name = sourceName(health.source);
  const apple = health.source === 'apple' ? appleHealthLine(health) : null;
  if (apple) {
    return apple;
  }
  switch (health.state) {
    case 'not_connected':
      return { text: `${name}: not connected yet (the App Store keys aren't set up)`, tone: 'neutral' };
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
    case 'waiting':
      return hasData ? null : { label: 'No data yet', tone: 'neutral' };
    case 'not_connected':
      return { label: 'Not connected yet', tone: 'neutral' };
    default:
      return null;
  }
}

/** "Oct 25–Oct 26", or "Oct 21–Oct 26, 4 of 6 days" when days are missing. */
function windowText(window: HeadlineWindow): string {
  const range = window.since === window.until ? formatDay(window.since) : `${formatDay(window.since)}–${formatDay(window.until)}`;
  return window.days < window.spanDays ? `${range}, ${window.days} of ${window.spanDays} days` : range;
}

function conversionText(view: AppStoreView): string {
  const window = view.conversionWindow;
  if (!window) {
    return `${formatPercent(null)} page view → download (no day both reports cover yet)`;
  }
  const days = `${plural(window.days, 'day', 'days')} both reports cover`;
  if (view.conversion === null) {
    return `${formatPercent(null)} page view → download (no page views on the ${days})`;
  }
  const range = window.since === window.until ? formatDay(window.since) : `${formatDay(window.since)}–${formatDay(window.until)}`;
  return `${formatPercent(view.conversion)} page view → download, ${days} (${range})`;
}

/**
 * The App downloads tile's sub-line. Each report family has its own days, so
 * each number says which days it is from, and a family that has sent nothing
 * shows a dash instead of a 0 it doesn't know.
 */
export function appStoreTileLine(view: AppStoreView): string {
  const parts = [
    view.downloadsWindow ? `First-time, App Store, ${windowText(view.downloadsWindow)} (Apple days)` : "Waiting for Apple's downloads report",
    conversionText(view),
  ];
  const engagement = `${formatCountOrDash(view.impressions)} impressions · ${formatCountOrDash(view.pageViews)} page views`;
  const sameDays =
    view.engagementWindow && view.downloadsWindow && windowText(view.engagementWindow) === windowText(view.downloadsWindow);
  parts.push(view.engagementWindow && !sameDays ? `${engagement}, ${windowText(view.engagementWindow)}` : engagement);
  return parts.join(' · ');
}

function countOrDash(value: number | null, one: string, many: string): string {
  return value === null ? `– ${many}` : plural(value, one, many);
}

/** "1,600 views · 1 upvote · 2 comments"; a missing number is a dash. */
export function redditStats(views: number | null, upvotes: number | null, comments: number | null): string {
  const viewsText = views === null ? 'views –' : plural(views, 'view', 'views');
  return `${viewsText} · ${countOrDash(upvotes, 'upvote', 'upvotes')} · ${countOrDash(comments, 'comment', 'comments')}`;
}
