// Page-view reporting rule for Vercel Web Analytics.
//
// Analytics must never see a raw URL. Every reported page is a ROUTE PATTERN
// (`/r/task/[id]`, not `/r/task/<uuid>`): ids are collapsed so views group by
// page, and the query string and hash are dropped entirely (they can carry
// filters or tokens). Paths that are not pages (API, OAuth, auth callback,
// well-known, framework internals) are never reported.
//
// Pure and dependency-free so `npm run test:page-views` can run it offline.
// When you add a page under src/app, add it to scripts/test-page-views.mjs;
// the test fails until you do.

// Top-level segments that are never reported (compared case-insensitively).
const NEVER_REPORTED_ROOTS = new Set(['api', 'oauth', 'auth', '.well-known', '_next', '_vercel']);

// Pages whose last segment is a record id: `/<root>/<id>`.
// A static child of the same root (e.g. /projects/templates) wins over the slot.
const ID_PAGE_ROOTS: Record<string, { slot: string; staticChildren: ReadonlySet<string> }> = {
  applications: { slot: '[id]', staticChildren: new Set() },
  implementations: { slot: '[id]', staticChildren: new Set() },
  projects: { slot: '[id]', staticChildren: new Set(['templates']) },
  sprints: { slot: '[id]', staticChildren: new Set() },
  stakeholders: { slot: '[id]', staticChildren: new Set() },
  briefs: { slot: '[code]', staticChildren: new Set() },
};

// /calendar/events/<id>
const CALENDAR_EVENT_PREFIX = ['calendar', 'events'] as const;

// /r/<kind>/<id>: the kinds the reader page understands. Anything else is
// reported as [kind] so a mistyped URL cannot leak text into analytics.
const READER_KINDS = new Set([
  'task',
  'note',
  'application',
  'project',
  'sprint',
  'stakeholder',
  'commitment',
  'email',
  'calendar',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{12,}$/i;
const LONG_TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
const NUMERIC_ID_RE = /^\d{5,}$/;

/** True for a segment that looks like an identifier rather than a page name. */
function looksLikeId(segment: string): boolean {
  return (
    UUID_RE.test(segment) ||
    HEX_ID_RE.test(segment) ||
    LONG_TOKEN_RE.test(segment) ||
    NUMERIC_ID_RE.test(segment) ||
    segment.includes('@')
  );
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function collapseUnknown(segments: string[]): string[] {
  return segments.map((segment) => (looksLikeId(decodeSegment(segment)) ? '[id]' : segment));
}

/**
 * Map a path (query string and hash allowed, ignored) to the route pattern to
 * report, or `null` when the page must not be reported at all.
 */
export function toRoutePattern(path: string): string | null {
  const pathname = String(path ?? '').split('#')[0].split('?')[0];
  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) return '/';

  const root = decodeSegment(segments[0]).toLowerCase();
  if (NEVER_REPORTED_ROOTS.has(root)) return null;

  // /r/<kind>/<id>
  if (root === 'r' && segments.length >= 3) {
    const kind = decodeSegment(segments[1]).toLowerCase();
    const reportedKind = READER_KINDS.has(kind) ? kind : '[kind]';
    return `/r/${[reportedKind, '[id]', ...collapseUnknown(segments.slice(3))].join('/')}`;
  }

  // /calendar/events/<id>
  if (
    root === CALENDAR_EVENT_PREFIX[0] &&
    segments.length >= 3 &&
    decodeSegment(segments[1]).toLowerCase() === CALENDAR_EVENT_PREFIX[1]
  ) {
    return `/calendar/events/${['[id]', ...collapseUnknown(segments.slice(3))].join('/')}`;
  }

  // /<root>/<id> pages (projects, applications, briefs, ...)
  const idPage = ID_PAGE_ROOTS[root];
  if (idPage && segments.length >= 2) {
    const second = decodeSegment(segments[1]).toLowerCase();
    if (!idPage.staticChildren.has(second)) {
      return `/${[root, idPage.slot, ...collapseUnknown(segments.slice(2))].join('/')}`;
    }
  }

  // Static pages and anything unknown: keep page names, collapse id-like pieces.
  return `/${collapseUnknown(segments).join('/')}`;
}

/**
 * Turn the URL the analytics script wants to report into the URL we allow it to
 * report: same scheme + host (Vercel needs them), route pattern instead of the
 * raw path, no query string, no hash, no credentials. `null` drops the event.
 */
export function sanitizeAnalyticsUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const pattern = toRoutePattern(parsed.pathname);
    return pattern === null ? null : `${parsed.protocol}//${parsed.host}${pattern}`;
  }

  return toRoutePattern(url);
}

/** `beforeSend` for @vercel/analytics: rewrite the event url, or drop the event. */
export function beforeSendPageView<E extends { url: string }>(event: E): E | null {
  const url = sanitizeAnalyticsUrl(event.url);
  return url === null ? null : { ...event, url };
}
