/**
 * The task panel (redesign S3): one task view everywhere, sliding in from the
 * right. Pure rules only, so they're tested without a browser:
 *   - its width per screen, remembered in a cookie the server reads (no jump);
 *   - the `?task=<id>` URL that opens it, so a link or a reload opens the task;
 *   - which task ↑ / ↓ move to, and when the keyboard shortcuts apply.
 * Spec: grocery-design-mockups/baseline-redesign/NOTES.md D2 "Resizable task panel".
 */

/** Screens with their own remembered width. "other" covers Portfolio, projects, apps and record pages. */
export type PanelScreen = "today" | "tasks" | "other";

export const PANEL_SCREENS: readonly PanelScreen[] = ["today", "tasks", "other"];

export const PANEL_COOKIES: Record<PanelScreen, string> = {
  today: "baseline_panel_today",
  tasks: "baseline_panel_tasks",
  other: "baseline_panel_other",
};

/** Default widths: Today 500 px and Tasks 660 px, as in d2-schemes.html. */
export const PANEL_DEFAULT_WIDTH: Record<PanelScreen, number> = {
  today: 500,
  tasks: 660,
  other: 560,
};

export const PANEL_MIN_WIDTH = 360;
/** The panel never takes more than 70% of the window. */
export const PANEL_MAX_FRACTION = 0.7;
/** A sanity cap for a stored width (the server can't see the window; CSS caps it at 70vw). */
export const PANEL_ABSOLUTE_MAX_WIDTH = 2400;
/** `[` and `]` change the width by this much. */
export const PANEL_NUDGE_STEP = 40;
/** Below this window width the panel is a full-screen sheet and the page doesn't reflow. */
export const PANEL_DOCK_MIN_WINDOW = 1024;
/** A year: the width is a device preference, like the theme. */
export const PANEL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type PanelWidths = Record<PanelScreen, number>;

/** Which remembered width a page uses. */
export function panelScreenForPath(pathname: string | null | undefined): PanelScreen {
  const path = (pathname ?? "").split(/[?#]/)[0] || "/";
  if (path === "/" || path === "") return "today";
  if (path === "/backlog" || path.startsWith("/backlog/")) return "tasks";
  return "other";
}

/**
 * A stored width as the server reads it: whole pixels between the minimum and
 * a sanity cap. Anything else (missing, junk, negative, "500px", NaN) is the
 * screen's default, so a bad cookie can never hide or swallow the panel.
 */
export function parsePanelWidth(raw: string | null | undefined, screen: PanelScreen): number {
  const fallback = PANEL_DEFAULT_WIDTH[screen];
  if (typeof raw !== "string") return fallback;
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(PANEL_ABSOLUTE_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value));
}

/** All three widths from a cookie reader (the root layout passes `cookies().get`). */
export function readPanelWidths(get: (name: string) => string | undefined): PanelWidths {
  return {
    today: parsePanelWidth(get(PANEL_COOKIES.today), "today"),
    tasks: parsePanelWidth(get(PANEL_COOKIES.tasks), "tasks"),
    other: parsePanelWidth(get(PANEL_COOKIES.other), "other"),
  };
}

/** The widest the panel may be in this window (never under the minimum). */
export function panelMaxWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return PANEL_ABSOLUTE_MAX_WIDTH;
  // Rounded first: 1440 × 0.7 is 1007.9999… in floating point.
  return Math.max(PANEL_MIN_WIDTH, Math.floor(Math.round(windowWidth * PANEL_MAX_FRACTION * 1000) / 1000));
}

/** A width kept between 360 px and 70% of the window, in whole pixels. */
export function clampPanelWidth(width: number, windowWidth: number): number {
  const value = Number.isFinite(width) ? Math.round(width) : PANEL_MIN_WIDTH;
  return Math.min(panelMaxWidth(windowWidth), Math.max(PANEL_MIN_WIDTH, value));
}

/** `[` makes the panel narrower, `]` wider (like a brush size). */
export function nudgePanelWidth(width: number, key: "[" | "]", windowWidth: number): number {
  return clampPanelWidth(width + (key === "]" ? PANEL_NUDGE_STEP : -PANEL_NUDGE_STEP), windowWidth);
}

/** Width from a drag: the panel's left edge follows the pointer. */
export function widthFromPointer(pointerX: number, windowWidth: number): number {
  return clampPanelWidth(windowWidth - pointerX, windowWidth);
}

/** The Set-Cookie text the browser writes after a resize. */
export function panelCookie(screen: PanelScreen, width: number): string {
  const value = Math.round(Math.min(PANEL_ABSOLUTE_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
  return `${PANEL_COOKIES[screen]}=${value}; Path=/; Max-Age=${PANEL_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** CSS width of the panel: the stored width, never more than 70% of the window. */
export function panelCssWidth(width: number): string {
  return `min(${Math.round(width)}px, ${PANEL_MAX_FRACTION * 100}vw)`;
}

// ── The URL ───────────────────────────────────────────────────────────────

export const TASK_PARAM = "task";
/** The Tasks page's old "expand this row" link (search, the intelligence inbox); it now opens the panel. */
export const LEGACY_EXPAND_PARAM = "expand";

/** Task ids are UUIDs; anything else in the URL is ignored rather than fetched. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

interface ParamReader {
  get(name: string): string | null;
}

/** The task the URL opens: `?task=<id>`, or on the Tasks page the old `?expand=<id>`. */
export function taskIdFromParams(params: ParamReader | null | undefined, pathname?: string | null): string | null {
  if (!params) return null;
  const direct = params.get(TASK_PARAM);
  if (isTaskId(direct)) return direct;
  if (panelScreenForPath(pathname) === "tasks") {
    const legacy = params.get(LEGACY_EXPAND_PARAM);
    if (isTaskId(legacy)) return legacy;
  }
  return null;
}

/**
 * The same page with the panel showing `taskId` (or closed for null). Other
 * query params and the hash stay; `expand` goes, so it can't reopen a closed panel.
 */
export function hrefWithTask(pathname: string, search: string, taskId: string | null, hash = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete(LEGACY_EXPAND_PARAM);
  if (taskId) params.set(TASK_PARAM, taskId);
  else params.delete(TASK_PARAM);
  const query = params.toString();
  return `${pathname || "/"}${query ? `?${query}` : ""}${hash}`;
}

/**
 * The page's own query (everything but the panel's `task` / `expand`), with the
 * params sorted, so two URLs that show the same page compare equal.
 */
export function pageQueryKey(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete(TASK_PARAM);
  params.delete(LEGACY_EXPAND_PARAM);
  return [...params.entries()]
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * How closing the panel leaves the URL (S5 fix round 1). A panel this page
 * pushed steps "back" (Back closed it before, and still does) ONLY while the
 * page's own query is what it was when the panel opened. If the page changed
 * it meanwhile (Tasks filters, search or scope picked with the panel open,
 * written with replaceState onto the panel's entry), stepping back would land
 * on the entry before and throw those choices away: "replace" drops only
 * `task` from the current URL instead. A panel that came from a link (not
 * pushed here) always replaces.
 */
export function panelCloseMode(openSearch: string | null, currentSearch: string, pushed: boolean): "back" | "replace" {
  if (!pushed || openSearch === null) return "replace";
  return pageQueryKey(openSearch) === pageQueryKey(currentSearch) ? "back" : "replace";
}

// ── ↑ / ↓ and the keyboard ────────────────────────────────────────────────

/** Ids in the order shown, each once (a task can show twice, e.g. on Now and on the board). */
export function uniqueIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The order ↑ / ↓ walk: the cards of the list that are shown, in page order.
 * When the open task has no shown copy in its list (Today's Overdue / Waiting
 * rail folded into side tabs while the panel is docked; S4 review F2), the
 * whole list counts, hidden or not, so ↑ / ↓ still walk the queue it came from.
 */
export function listOrder(items: ReadonlyArray<{ id: string; shown: boolean }>, taskId: string): string[] {
  const shown = uniqueIds(items.filter((item) => item.shown).map((item) => item.id));
  if (shown.includes(taskId)) return shown;
  const all = uniqueIds(items.map((item) => item.id));
  return all.includes(taskId) ? all : shown;
}

/** The previous / next task in the list, or null at either end (no wrap) or when it isn't in the list. */
export function neighbourTaskId(order: readonly string[], currentId: string | null, direction: "up" | "down"): string | null {
  if (!currentId) return null;
  const index = order.indexOf(currentId);
  if (index < 0) return null;
  const next = direction === "down" ? index + 1 : index - 1;
  return next >= 0 && next < order.length ? order[next] : null;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** A field has focus: the panel's shortcuts (↑ ↓ [ ]) do nothing then. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as TargetLike;
  if (element.isContentEditable) return true;
  const tag = (element.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element.getAttribute?.("type") ?? "text").toLowerCase();
    // Ticks and buttons aren't fields you type in.
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return element.getAttribute?.("role") === "textbox";
}

export type PanelKeyAction = "close" | "up" | "down" | "narrower" | "wider" | null;

/** What a key press does while the panel is open (null: leave it to the page). */
export function panelKeyAction(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: unknown },
  options: { dialogOpen?: boolean } = {}
): PanelKeyAction {
  if (options.dialogOpen) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  switch (event.key) {
    case "Escape":
      return "close";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "[":
      return "narrower";
    case "]":
      return "wider";
    default:
      return null;
  }
}

// ── "Open full page" and the full page's way back ─────────────────────────
//
// Brent 11/6 (Baseline 2da37187): the full task page's top-left button said
// "← Portfolio" whatever page he came from. "Open full page" now tells the
// page where it was opened (`?from=`), and the page turns that into its back
// link. Only these places, spelled exactly, are understood; the href is built
// here from the value, never taken from the URL, so `from` can't send anyone
// off the site (no open redirect). Anything else goes back to Today.

/** The full page's query parameter naming where it was opened. */
export const FULL_PAGE_FROM_PARAM = "from";

export interface FullPageBackLink {
  label: string;
  href: string;
}

/** Where the full page goes back to when `from` is missing or not understood. */
export const DEFAULT_BACK_LINK: FullPageBackLink = { label: "Today", href: "/" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_PATTERN = /^(20\d\d)-(\d\d)-(\d\d)$/;

/** A real calendar day, years 2000–2099 (Today's `?day=` rule). */
function isRealDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The `from` value for a panel open on this page, or null for a page the full
 * page has no way back to (it then goes back to Today). Today keeps a day list
 * (`?day=`); a project or application page keeps its id. On a record page the
 * page's own valid `from` is passed on, so a step opened there still goes back
 * to where Brent started.
 */
export function fullPageFromFor(pathname: string | null | undefined, search: string | null | undefined): string | null {
  const path = ((pathname ?? "").split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  const params = new URLSearchParams((search ?? "").startsWith("?") ? (search ?? "").slice(1) : search ?? "");
  if (path === "/") {
    const day = params.getAll("day");
    return day.length === 1 && isRealDay(day[0]) ? `today:${day[0]}` : "today";
  }
  if (path === "/backlog") return "tasks";
  if (path === "/portfolio") return "portfolio";
  const record = /^\/(projects|applications)\/([^/]+)$/.exec(path);
  if (record) {
    const id = record[2].toLowerCase();
    if (!UUID_PATTERN.test(id)) return null;
    return `${record[1] === "projects" ? "project" : "application"}:${id}`;
  }
  if (path.startsWith("/r/")) {
    const from = params.getAll(FULL_PAGE_FROM_PARAM);
    return from.length === 1 && backLinkForFrom(from[0]) !== null ? from[0] : null;
  }
  return null;
}

/** The "Open full page" link: `/r/task/<id>`, plus `?from=` when the page is one it can go back to. */
export function fullPageHref(taskId: string, from: string | null): string {
  const base = `/r/task/${encodeURIComponent(taskId)}`;
  return from ? `${base}?${FULL_PAGE_FROM_PARAM}=${encodeURIComponent(from)}` : base;
}

/** The back link one `from` value means, or null when it isn't one of the allowed places. */
function backLinkForFrom(from: string): FullPageBackLink | null {
  if (from === "today") return { label: "Today", href: "/" };
  if (from === "tasks") return { label: "Tasks", href: "/backlog" };
  if (from === "portfolio") return { label: "Portfolio", href: "/portfolio" };
  const [kind, value, ...rest] = from.split(":");
  if (rest.length > 0 || value === undefined) return null;
  if (kind === "today" && isRealDay(value)) return { label: "Today", href: `/?day=${value}` };
  if (kind === "project" && UUID_PATTERN.test(value)) return { label: "Project", href: `/projects/${value}` };
  if (kind === "application" && UUID_PATTERN.test(value)) return { label: "Application", href: `/applications/${value}` };
  return null;
}

/**
 * The full page's top-left link from its `from` search param (as Next hands it
 * over: a string, several, or none). One allowed value gives its place; none,
 * several or anything else gives "← Today".
 */
export function fullPageBackLink(from: string | string[] | null | undefined): FullPageBackLink {
  if (typeof from !== "string") return DEFAULT_BACK_LINK;
  return backLinkForFrom(from) ?? DEFAULT_BACK_LINK;
}

// ── The "Waiting on" section ──────────────────────────────────────────────
//
// Brent 11/6 (Baseline 2da37187): he typed a "waiting on" note and the panel
// showed "Dependencies (0)" and "Blocks (0)". The section is now "Waiting on":
// the task's own note (the All fields "Waiting On" text) and the tasks or
// commitments it is linked to wait on, together. The tasks that wait on this
// one are "Tasks waiting on this", shown only when there are some (or when
// they couldn't be read, so a failed read never looks like "none").

export interface WaitingOnView {
  /** The task's free-text waiting-on note, trimmed; null when there is none. */
  note: string | null;
  /** How many tasks / commitments it is linked to wait on. */
  linkCount: number;
  /** Neither a note nor a link: the section says so in one line. */
  empty: boolean;
  /** "Tasks waiting on this": hidden (none, or not asked for), unreadable, or a list. */
  waitingOnThis: "hidden" | "unreadable" | "list";
}

export function waitingOnView(input: {
  waitingOn: string | null | undefined;
  linkCount: number;
  /** undefined = not shown here; null = couldn't be read; [] = nothing waits on it. */
  blocks: readonly unknown[] | null | undefined;
}): WaitingOnView {
  const note = typeof input.waitingOn === "string" && input.waitingOn.trim() ? input.waitingOn.trim() : null;
  const linkCount = Math.max(0, input.linkCount | 0);
  const waitingOnThis = input.blocks === undefined ? "hidden" : input.blocks === null ? "unreadable" : input.blocks.length > 0 ? "list" : "hidden";
  return { note, linkCount, empty: note === null && linkCount === 0, waitingOnThis };
}
