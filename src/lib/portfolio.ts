import { addDateOnlyDays, getDateOnlyInTimeZone, toUtcDateMs } from "@/lib/date-only";
import { matchesTaskScope, type TaskScope } from "@/lib/personal-exclusion";
import { isDecisionTask } from "@/lib/task-handoff";
import type { TaskOwner, TaskStatus } from "@/types/database";

/**
 * The Portfolio page's model, built in code from plain rows so it can be tested
 * without a database. Everything date-shaped is an ET calendar date
 * (YYYY-MM-DD): a task due 11 PM ET on the 3rd belongs to the 3rd, not the 4th.
 */

export const PORTFOLIO_TIME_ZONE = "America/New_York";

/** Statuses that no longer need anyone. Done counts toward % done; Parked/Missed don't. */
const CLOSED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["Done", "Parked", "Missed"]);

export interface PortfolioTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  owner: TaskOwner;
  owner_label: string | null;
  status_line: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  priority_score: number;
  implementation_id: string | null;
  project_id: string | null;
  section_id: string | null;
  is_recurring_template: boolean;
  tags: string[] | null;
  project: { tags: string[] | null } | null;
  /** Who or what it waits on (free text), shown in "Coming to you later". */
  waiting_on?: string | null;
  blocked_reason?: string | null;
  follow_up_at?: string | null;
}

export interface PortfolioImplementationRow {
  id: string;
  name: string;
  phase: string;
  rag: string;
  status_summary: string | null;
  next_milestone: string | null;
  next_milestone_date: string | null;
  portfolio_rank: number;
}

export interface PortfolioProjectRow {
  id: string;
  name: string;
  implementation_id: string | null;
  stage: string;
  portfolio_rank: number;
  /** The project's target date (YYYY-MM-DD): the purple diamond on the timeline. */
  target_date?: string | null;
}

export interface PortfolioSectionRow {
  id: string;
  project_id: string;
  name: string;
  sort_order: number;
  /** Planned dates (migration 057, YYYY-MM-DD). Timeline only: never due dates or overdue. */
  planned_start?: string | null;
  planned_end?: string | null;
}

export interface PortfolioInput {
  tasks: PortfolioTaskRow[];
  implementations: PortfolioImplementationRow[];
  projects: PortfolioProjectRow[];
  sections: PortfolioSectionRow[];
  /**
   * Unfinished dependencies per task id (the titles of what it waits on). Only
   * Brent's open tasks need it: a task still waiting on another isn't his to act on yet.
   */
  blockers?: Record<string, string[]>;
}

export interface TaskCounts {
  done: number;
  total: number;
  /** Rounded percent done, or null when there are no tasks. Never 100 unless all done, never 0 once any are. */
  pct: number | null;
  open: number;
  /** Brent's open tasks he can act on now (not Blocked/Waiting, no unfinished dependency). */
  brentOpen: number;
  /** Brent's open tasks that are blocked: they come to him later. */
  brentLater: number;
  agentOpen: number;
}

/**
 * How a planned section is doing. "empty" (no tasks yet) and "plan" (starts
 * later) are grey; "done", "ahead" and "ok" are green; "behind" is amber;
 * "late" is red.
 */
export type LaneHealthKind = "empty" | "plan" | "done" | "ok" | "ahead" | "behind" | "late";

export interface LaneHealth {
  kind: LaneHealthKind;
  /** The chip text: "On track", "Late · due 10/2", "Starts 10/5", … */
  label: string;
}

/** A section with planned dates, drawn as a track filled by tasks done ÷ tasks. */
export interface TimelineLane {
  key: string;
  label: string;
  /** The project name, shown when an app has more than one project on the timeline. */
  project: string | null;
  /** "6 of 9 done · 2 in progress", or "Planned" when there are no tasks. */
  sub: string;
  hasBrent: boolean;
  /** The planned window (inclusive ET dates). */
  start: string;
  end: string;
  done: number;
  total: number;
  /** done ÷ total, 0–1 (0 when there are no tasks): the fill. */
  share: number;
  health: LaneHealth;
}

/** A section kept off the chart: finished, or with no planned window. Listed under the chart. */
export interface EarlierLane {
  key: string;
  label: string;
  project: string | null;
  done: number;
  total: number;
  /** "9 of 12 done", "No tasks yet". */
  text: string;
  /** Brent owns an open task in it. */
  hasBrent: boolean;
  /** Earliest passed task due date (ET) among its open tasks: "overdue since M/D". */
  overdueSince: string | null;
  /** What its open tasks are doing, when any are open. */
  state: "in progress" | "waiting" | null;
}

export interface TimelineTarget {
  /** ET date of the project's target. */
  date: string;
}

/** The app card's chip and line. Counts only the sections drawn on the chart. */
export interface TimelineSummary {
  /** The worst health among drawn sections, as just "Late", "Behind" or "On track"; null when none has started. */
  health: LaneHealth | null;
  targetDate: string | null;
  /** "Target 11/20 · 3 of 20 tasks done". */
  line: string;
  done: number;
  total: number;
}

export interface Timeline {
  start: string;
  end: string;
  today: string;
  ticks: string[];
  /** Sections with planned dates that are unfinished: the chart's rows. */
  lanes: TimelineLane[];
  /** Finished, unscheduled and long-past sections, in chart order. */
  earlier: EarlierLane[];
  /** The target marker, only when its date falls inside the chart window. */
  target: TimelineTarget | null;
  /** null when the app has no target date and no planned section. */
  summary: TimelineSummary | null;
}

export interface AssignedTask {
  id: string;
  title: string;
  app: string | null;
  statusLine: string | null;
  status: TaskStatus;
  due: string | null;
  overdue: boolean;
  /** A decision task: handing it back with no answer gets a warning. */
  decision: boolean;
}

/** A task that will be Brent's, but is blocked for now ("Coming to you later"). */
export interface LaterTask {
  id: string;
  title: string;
  app: string | null;
  statusLine: string | null;
  status: TaskStatus;
  /** waiting_on text, if any. */
  waitingOn: string | null;
  /** Unfinished dependencies' titles. */
  blockedBy: string[];
  /** When an agent looks again (ET date), if set. */
  followUp: string | null;
  due: string | null;
}

export interface PortfolioApp {
  id: string;
  name: string;
  phase: string;
  counts: TaskCounts;
  stand: string | null;
  next: string | null;
  agentLabels: string[];
  timeline: Timeline;
}

export interface PortfolioView {
  scope: TaskScope;
  today: string;
  overall: TaskCounts;
  /** Brent's actionable open tasks: the hero count. */
  brentOpen: number;
  brentLater: number;
  agentOpen: number;
  agentInProgress: number;
  agentLabels: string[];
  assigned: AssignedTask[];
  comingLater: LaterTask[];
  apps: PortfolioApp[];
}

export function isOpenTask(task: Pick<PortfolioTaskRow, "status">): boolean {
  return !CLOSED_STATUSES.has(task.status);
}

/**
 * done ÷ all tasks, as a whole percent. Rounding never claims 100% while
 * something is left, or 0% once something is done.
 */
export function percentDone(done: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const safeDone = Math.min(Math.max(done, 0), total);
  const pct = Math.round((safeDone / total) * 100);
  if (safeDone < total && pct === 100) return 99;
  if (safeDone > 0 && pct === 0) return 1;
  return pct;
}

/**
 * Brent's open task is blocked when it's Blocked/Waiting or still waits on an
 * unfinished dependency. It isn't his to act on yet ("do not assign to me
 * until something is actionable", 9/28), so it leaves "Assigned to you".
 */
export function isBlockedForBrent(
  task: Pick<PortfolioTaskRow, "id" | "status">,
  blockers: PortfolioInput["blockers"] = {}
): boolean {
  return task.status === "Blocked/Waiting" || (blockers[task.id]?.length ?? 0) > 0;
}

export function countTasks(tasks: PortfolioTaskRow[], blockers: PortfolioInput["blockers"] = {}): TaskCounts {
  let done = 0;
  let open = 0;
  let brentOpen = 0;
  let brentLater = 0;
  let agentOpen = 0;
  for (const task of tasks) {
    if (task.status === "Done") done += 1;
    if (isOpenTask(task)) {
      open += 1;
      if (task.owner !== "brent") agentOpen += 1;
      else if (isBlockedForBrent(task, blockers)) brentLater += 1;
      else brentOpen += 1;
    }
  }
  return { done, total: tasks.length, pct: percentDone(done, tasks.length), open, brentOpen, brentLater, agentOpen };
}


export function toEtDate(timestamp: string | null | undefined, timeZone = PORTFOLIO_TIME_ZONE): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return getDateOnlyInTimeZone(timeZone, date);
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function addDays(date: string, days: number): string {
  return addDateOnlyDays(date, days) ?? date;
}

function daysBetween(a: string, b: string): number {
  return Math.round(((toUtcDateMs(b) ?? 0) - (toUtcDateMs(a) ?? 0)) / 86_400_000);
}

/** Monday on or before the date. */
function startOfWeek(date: string): string {
  const ms = toUtcDateMs(date) ?? 0;
  const weekday = new Date(ms).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** How far back the chart looks, and how far ahead it looks (at least / at most). */
const WINDOW_BACK_DAYS = 56;
const WINDOW_AHEAD_MIN_DAYS = 28;
const WINDOW_AHEAD_MAX_DAYS = 84;

/** Behind: the done share trails the expected share by more than this. */
const BEHIND_MARGIN = 0.25;
/** Ahead: the done share beats the expected share by at least this. */
const AHEAD_MARGIN = 0.15;
const EPSILON = 1e-9;

export interface LaneHealthInput {
  done: number;
  total: number;
  /** Tasks still open. Defaults to total − done (Parked and Missed are closed, not done). */
  open?: number;
  /** The planned window, inclusive ET dates. */
  start: string;
  end: string;
  /** Today in ET. */
  today: string;
}

/**
 * Where a planned section stands. Pure; today is an ET date.
 * expected = share of the planned window that has passed (the window counts
 * both end days, and today counts as half a day in), clamped 0–1.
 *   No tasks yet → grey · Done → green · before the start → grey "Starts M/D"
 *   after the end with work open → red "Late · due M/D"
 *   done share + 25% < expected → amber "Behind" · done share ≥ expected + 15% → green "Ahead"
 *   otherwise → green "On track"
 */
export function laneHealth(input: LaneHealthInput): LaneHealth {
  const { done, total, start, end, today } = input;
  const open = input.open ?? Math.max(total - done, 0);
  if (total <= 0) return { kind: "empty", label: "No tasks yet" };
  if (open <= 0) return { kind: "done", label: "Done" };
  if (today < start) return { kind: "plan", label: `Starts ${formatTick(start)}` };
  if (today > end) return { kind: "late", label: `Late · due ${formatTick(end)}` };
  const windowDays = daysBetween(start, end) + 1;
  const expected = Math.min(1, Math.max(0, (daysBetween(start, today) + 0.5) / windowDays));
  const share = Math.min(Math.max(done, 0), total) / total;
  // EPSILON keeps the exact-margin cases (0.55 + 0.15 is 0.7000000000000001) on the right side.
  if (share + BEHIND_MARGIN < expected - EPSILON) return { kind: "behind", label: "Behind" };
  if (share >= expected + AHEAD_MARGIN - EPSILON) return { kind: "ahead", label: "Ahead" };
  return { kind: "ok", label: "On track" };
}

function validPlannedDate(value: string | null | undefined): string | null {
  return value && toUtcDateMs(value) !== null ? value : null;
}

interface PlannedWindow {
  start: string | null;
  end: string | null;
}

interface LaneSummaryData {
  key: string;
  label: string;
  project: string | null;
  done: number;
  total: number;
  open: number;
  hasBrent: boolean;
  inProgress: number;
  overdueSince: string | null;
  state: "in progress" | "waiting" | null;
  /** Both planned dates are set (and in order): the lane can be drawn and judged. */
  scheduled: boolean;
  start: string;
  end: string;
  health: LaneHealth | null;
}

function summarizeLane(
  key: string,
  label: string,
  project: string | null,
  tasks: PortfolioTaskRow[],
  today: string,
  plan: PlannedWindow
): LaneSummaryData {
  const open = tasks.filter(isOpenTask);
  const done = tasks.filter((task) => task.status === "Done").length;
  const scheduled = Boolean(plan.start && plan.end);
  const start = plan.start ?? today;
  const end = plan.end ?? today;
  return {
    key,
    label,
    project,
    done,
    total: tasks.length,
    open: open.length,
    hasBrent: open.some((task) => task.owner === "brent"),
    inProgress: open.filter((task) => task.status === "In Progress").length,
    overdueSince: open
      .map((task) => toEtDate(task.due_at))
      .filter((date): date is string => Boolean(date && date < today))
      .reduce<string | null>((first, date) => (first === null || date < first ? date : first), null),
    state: open.some((task) => task.status === "In Progress")
      ? "in progress"
      : open.some((task) => task.status === "Blocked/Waiting")
        ? "waiting"
        : null,
    scheduled,
    start,
    end,
    health: scheduled ? laneHealth({ done, total: tasks.length, open: open.length, start, end, today }) : null,
  };
}

function laneSub(lane: LaneSummaryData): string {
  if (lane.total === 0) return "Planned";
  return `${lane.done} of ${lane.total} done${lane.inProgress > 0 ? ` · ${lane.inProgress} in progress` : ""}`;
}

function earlierText(lane: LaneSummaryData): string {
  if (lane.total === 0) return "No tasks yet";
  return `${lane.done} of ${lane.total} done${lane.open === 0 && lane.done < lane.total ? " · nothing open" : ""}`;
}

/** Worst first: the app's chip takes the worst colour among the sections drawn on the chart. */
const HEALTH_SEVERITY: Partial<Record<LaneHealthKind, number>> = { late: 3, behind: 2, ok: 1, ahead: 1 };

/**
 * The app chip: Late > Behind > On track among drawn sections that have started.
 * It says only the health word ("Late", never "Late · due 10/2": that is the
 * lane's own label). None started → no chip.
 */
function appHealth(lanes: TimelineLane[]): LaneHealth | null {
  const started = lanes.filter((lane) => HEALTH_SEVERITY[lane.health.kind] !== undefined);
  if (started.length === 0) return null;
  const worst = started.reduce((a, b) =>
    (HEALTH_SEVERITY[b.health.kind] ?? 0) > (HEALTH_SEVERITY[a.health.kind] ?? 0) ? b : a
  ).health.kind;
  if (worst === "late") return { kind: "late", label: "Late" };
  if (worst === "behind") return { kind: "behind", label: "Behind" };
  return { kind: "ok", label: "On track" };
}

/** The project target that matters now: the nearest one still ahead, else the latest one that passed. */
function pickTarget(dates: string[], today: string): string | null {
  const sorted = [...dates].sort();
  return sorted.find((date) => date >= today) ?? sorted[sorted.length - 1] ?? null;
}

/**
 * One chart row per project section that has planned dates (both start and
 * end), drawn as its planned window and filled by tasks done ÷ tasks. Finished
 * sections, sections with no planned window (including each project's "Other
 * tasks") and sections whose window ended long ago go in `earlier`, a list under
 * the chart: no more guessed bars. The project's target date is the marker.
 */
export function buildTimeline(
  tasks: PortfolioTaskRow[],
  projects: PortfolioProjectRow[],
  sections: PortfolioSectionRow[],
  today: string
): Timeline {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const groups = new Map<string, { label: string; projectId: string | null; order: [number, number, string]; tasks: PortfolioTaskRow[] }>();

  for (const task of tasks) {
    const project = task.project_id ? projectById.get(task.project_id) ?? null : null;
    if (project && project.stage === "Cancelled") continue;
    const section = task.section_id ? sectionById.get(task.section_id) ?? null : null;
    let key: string;
    let label: string;
    let order: [number, number, string];
    if (section && project && section.project_id === project.id) {
      key = `s:${section.id}`;
      label = section.name;
      order = [project.portfolio_rank, section.sort_order, section.name];
    } else if (project) {
      key = `p:${project.id}`;
      label = project.name;
      order = [project.portfolio_rank, Number.MAX_SAFE_INTEGER, project.name];
    } else {
      key = "none";
      label = "Not in a project";
      order = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ""];
    }
    const group = groups.get(key) ?? { label, projectId: project?.id ?? null, order, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }

  // A section with planned dates is on the timeline even before it has tasks.
  for (const section of sections) {
    const project = projectById.get(section.project_id);
    if (!project || project.stage === "Cancelled") continue;
    if (!validPlannedDate(section.planned_start) && !validPlannedDate(section.planned_end)) continue;
    const key = `s:${section.id}`;
    if (groups.has(key)) continue;
    groups.set(key, {
      label: section.name,
      projectId: project.id,
      order: [project.portfolio_rank, section.sort_order, section.name],
      tasks: [],
    });
  }

  const projectIds = new Set([...groups.values()].map((group) => group.projectId).filter(Boolean));
  const showProject = projectIds.size > 1;
  const sectionedProjects = new Set(
    [...groups.entries()].filter(([key]) => key.startsWith("s:")).map(([, group]) => group.projectId)
  );

  const summaries = [...groups.entries()]
    .sort(([, a], [, b]) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]))
    .map(([key, group]) => {
      const projectName = group.projectId ? projectById.get(group.projectId)?.name ?? null : null;
      const isProjectLane = key.startsWith("p:");
      // A project's unsectioned tasks sit beside its sections as "Other tasks".
      const leftovers = isProjectLane && sectionedProjects.has(group.projectId);
      const section = key.startsWith("s:") ? sectionById.get(key.slice(2)) : undefined;
      let plan: PlannedWindow = { start: validPlannedDate(section?.planned_start), end: validPlannedDate(section?.planned_end) };
      // A bad pair (the database forbids it) is treated as unscheduled rather than drawn backwards.
      if (plan.start && plan.end && plan.end < plan.start) plan = { start: null, end: null };
      return summarizeLane(
        key,
        leftovers ? "Other tasks" : group.label,
        showProject && (!isProjectLane || leftovers) ? projectName : null,
        group.tasks,
        today,
        plan
      );
    });

  const earliest = addDays(today, -WINDOW_BACK_DAYS);
  // On the chart: planned, unfinished, and not long past. Everything else is listed below it.
  const onChart = (lane: LaneSummaryData) => lane.scheduled && lane.health?.kind !== "done" && lane.end >= earliest;
  const lanes: TimelineLane[] = summaries.filter(onChart).map((lane) => ({
    key: lane.key,
    label: lane.label,
    project: lane.project,
    sub: laneSub(lane),
    hasBrent: lane.hasBrent,
    start: lane.start,
    end: lane.end,
    done: lane.done,
    total: lane.total,
    share: lane.total > 0 ? Math.min(lane.done / lane.total, 1) : 0,
    health: lane.health!,
  }));
  const earlier: EarlierLane[] = summaries
    .filter((lane) => !onChart(lane))
    .map((lane) => ({
      key: lane.key,
      label: lane.label,
      project: lane.project,
      done: lane.done,
      total: lane.total,
      text: earlierText(lane),
      hasBrent: lane.hasBrent,
      overdueSince: lane.overdueSince,
      state: lane.state,
    }));

  // The target: the projects on this timeline that are still going and have a target date.
  const targetDates = [...projectIds]
    .map((id) => (id ? projectById.get(id) : undefined))
    .filter((project): project is PortfolioProjectRow => Boolean(project) && project!.stage !== "Done")
    .map((project) => validPlannedDate(project.target_date))
    .filter((date): date is string => Boolean(date));
  const targetDate = pickTarget(targetDates, today);

  const maxEnd = addDays(today, WINDOW_AHEAD_MAX_DAYS);
  const firstStart = lanes.length ? lanes.map((lane) => lane.start).reduce(minDate) : today;
  let lastEnd = lanes.length ? lanes.map((lane) => lane.end).reduce(maxDate) : today;
  if (targetDate && targetDate <= maxEnd) lastEnd = maxDate(lastEnd, targetDate);
  const start = startOfWeek(maxDate(minDate(firstStart, addDays(today, -7)), earliest));
  const end = minDate(maxDate(addDays(lastEnd, 3), addDays(today, WINDOW_AHEAD_MIN_DAYS)), maxEnd);

  const spanDays = Math.max(daysBetween(start, end), 1);
  const step = spanDays <= 84 ? 7 : spanDays <= 168 ? 14 : 28;
  const ticks: string[] = [];
  for (let tick = start; tick <= end; tick = addDays(tick, step)) ticks.push(tick);

  const target: TimelineTarget | null =
    targetDate && targetDate >= start && targetDate <= end ? { date: targetDate } : null;

  // The chip and the count use only the sections drawn on the chart: sections the chart
  // hides (finished, unscheduled, long past) never change either.
  let summary: TimelineSummary | null = null;
  if (targetDate || lanes.length > 0) {
    const done = lanes.reduce((sum, lane) => sum + lane.done, 0);
    const total = lanes.reduce((sum, lane) => sum + lane.total, 0);
    const parts: string[] = [];
    if (targetDate) parts.push(`Target ${formatTick(targetDate)}`);
    if (total > 0) parts.push(`${done} of ${total} tasks done`);
    summary = { health: appHealth(lanes), targetDate, line: parts.join(" · "), done, total };
  }

  return { start, end, today, ticks, lanes, earlier, target, summary };
}

/**
 * Where a date falls on the timeline, 0–100. `offsetDays` shifts it into the
 * day: 0.5 for "today"/a marker (the middle of the day), 1 for the end of a
 * bar that includes its last day.
 */
export function timelinePosition(timeline: Pick<Timeline, "start" | "end">, date: string, offsetDays = 0): number {
  const span = Math.max(daysBetween(timeline.start, timeline.end), 1);
  const at = daysBetween(timeline.start, date) + offsetDays;
  return Math.min(100, Math.max(0, (at / span) * 100));
}

function firstSentence(text: string | null | undefined, max = 180): string | null {
  if (!text) return null;
  const plain = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const match = /^(.+?[.!?])(\s|$)/.exec(plain);
  const sentence = match ? match[1] : plain;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function byMostRecent(a: PortfolioTaskRow, b: PortfolioTaskRow): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function byPriority(a: PortfolioTaskRow, b: PortfolioTaskRow): number {
  return b.priority_score - a.priority_score || a.title.localeCompare(b.title);
}

function distinctLabels(tasks: PortfolioTaskRow[]): string[] {
  const labels = new Set<string>();
  for (const task of tasks) {
    if (task.owner === "agent" && task.owner_label && isOpenTask(task)) labels.add(task.owner_label);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

export function buildPortfolio(
  input: PortfolioInput,
  options: { scope: TaskScope; now?: Date }
): PortfolioView {
  const today = getDateOnlyInTimeZone(PORTFOLIO_TIME_ZONE, options.now ?? new Date());
  // Recurring templates are generators, not work, so they never count.
  const tasks = input.tasks.filter(
    (task) => !task.is_recurring_template && matchesTaskScope(task, options.scope)
  );
  const implementationById = new Map(input.implementations.map((impl) => [impl.id, impl]));
  const blockers = input.blockers ?? {};
  const appName = (task: PortfolioTaskRow) =>
    task.implementation_id ? implementationById.get(task.implementation_id)?.name ?? null : null;

  const byApp = new Map<string, PortfolioTaskRow[]>();
  for (const task of tasks) {
    if (!task.implementation_id || !implementationById.has(task.implementation_id)) continue;
    const list = byApp.get(task.implementation_id) ?? [];
    list.push(task);
    byApp.set(task.implementation_id, list);
  }

  const apps: PortfolioApp[] = [...byApp.entries()]
    .map(([id, appTasks]) => {
      const impl = implementationById.get(id)!;
      const open = appTasks.filter(isOpenTask);
      const latestLine = [...open].filter((task) => task.status_line).sort(byMostRecent)[0]?.status_line ?? null;
      const stand = latestLine ?? firstSentence(impl.status_summary);
      // Next: the soonest upcoming due date; otherwise the highest priority.
      const upcoming = open
        .map((task) => ({ task, due: toEtDate(task.due_at) }))
        .filter((entry): entry is { task: PortfolioTaskRow; due: string } => Boolean(entry.due && entry.due >= today))
        .sort((a, b) => a.due.localeCompare(b.due) || byPriority(a.task, b.task));
      const nextTask = upcoming[0]?.task ?? [...open].sort(byPriority)[0];
      const next = impl.next_milestone?.trim()
        ? `${impl.next_milestone.trim()}${impl.next_milestone_date ? ` (${formatShortDate(impl.next_milestone_date)})` : ""}`
        : nextTask
          ? nextTask.title
          : null;
      const app: PortfolioApp = {
        id,
        name: impl.name,
        phase: impl.phase,
        counts: countTasks(appTasks, blockers),
        stand,
        next,
        agentLabels: distinctLabels(appTasks),
        timeline: buildTimeline(
          appTasks,
          input.projects.filter((project) => project.implementation_id === id),
          input.sections,
          today
        ),
      };
      return { app, rank: impl.portfolio_rank };
    })
    .sort((a, b) => a.rank - b.rank || a.app.name.localeCompare(b.app.name))
    .map(({ app }) => app);

  const appTasks = [...byApp.values()].flat();
  const overall = countTasks(appTasks, blockers);
  const openTasks = tasks.filter(isOpenTask);
  const brentTasks = openTasks.filter((task) => task.owner === "brent");
  const assigned = brentTasks
    .filter((task) => !isBlockedForBrent(task, blockers))
    .map((task) => {
      const due = toEtDate(task.due_at);
      const item: AssignedTask = {
        id: task.id,
        title: task.title,
        app: appName(task),
        statusLine: task.status_line,
        status: task.status,
        due,
        overdue: Boolean(due && due < today),
        decision: isDecisionTask(task),
      };
      return { item, priority: task.priority_score };
    })
    .sort((a, b) => {
      if (a.item.due && b.item.due) return a.item.due.localeCompare(b.item.due) || b.priority - a.priority;
      if (a.item.due) return -1;
      if (b.item.due) return 1;
      return b.priority - a.priority || a.item.title.localeCompare(b.item.title);
    })
    .map(({ item }) => item);

  // Blocked for now: the soonest follow-up (or due date) first, then the newest change.
  const comingLater = brentTasks
    .filter((task) => isBlockedForBrent(task, blockers))
    .map((task) => {
      const item: LaterTask = {
        id: task.id,
        title: task.title,
        app: appName(task),
        statusLine: task.status_line,
        status: task.status,
        waitingOn: task.waiting_on?.trim() || null,
        blockedBy: blockers[task.id] ?? [],
        followUp: toEtDate(task.follow_up_at),
        due: toEtDate(task.due_at),
      };
      return { item, when: item.followUp ?? item.due, updated: task.updated_at };
    })
    .sort((a, b) => {
      if (a.when && b.when) return a.when.localeCompare(b.when) || b.updated.localeCompare(a.updated);
      if (a.when) return -1;
      if (b.when) return 1;
      return b.updated.localeCompare(a.updated);
    })
    .map(({ item }) => item);

  const agentOpenTasks = openTasks.filter((task) => task.owner === "agent");
  return {
    scope: options.scope,
    today,
    overall,
    brentOpen: assigned.length,
    brentLater: comingLater.length,
    agentOpen: agentOpenTasks.length,
    agentInProgress: agentOpenTasks.filter((task) => task.status === "In Progress").length,
    agentLabels: distinctLabels(openTasks),
    assigned,
    comingLater,
    apps,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "Oct 5". */
export function formatShortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  if (!month || !day) return date;
  return `${MONTHS[month - 1]} ${day}`;
}

/** "2026-10-05" → "10/5" for axis ticks. */
export function formatTick(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}/${day}`;
}
