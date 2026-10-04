import { addDateOnlyDays, getDateOnlyInTimeZone, toUtcDateMs } from "@/lib/date-only";
import {
  hasPersonalTag,
  isHobbyTaskOrProject,
  matchesTaskScope,
  type TaskScope,
} from "@/lib/personal-exclusion";
import { isDecisionTask } from "@/lib/task-handoff";
import type { PaceForecast } from "@/lib/pace";
import { buildPaceLine, formatMonthYear, type PaceChip } from "@/lib/pace-view";
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
  /** Project tags: a `personal` project with no application gets its own lane. */
  tags?: string[] | null;
  /** Pace tracking (migration 059): what the project counts, e.g. "stitches". Only these projects get a pace line. */
  unit_label?: string | null;
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

/** A task's checklist: items ticked and items in all. */
export interface ChecklistProgress {
  done: number;
  total: number;
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
  /**
   * Checklist items per task id (ticked / all), for tasks that have any. They only
   * give a task that is not Done partial credit toward the percent and the timeline
   * fill; a missing entry means no checklist (so no partial credit).
   */
  checklist?: Record<string, ChecklistProgress>;
  /**
   * Pace forecasts by project id, for projects with a `unit_label` (src/lib/pace.ts). They add a pace line,
   * time-based chips for lanes with stitch work left, the projected-finish marker and overrun tails, and
   * they set the project's health once it has enough counted sittings. They never change counts or percentages.
   */
  pace?: Record<string, PaceForecast>;
}

export interface TaskCounts {
  /** Whole tasks that are Done. The "6 of 9 done" counts stay whole tasks. */
  done: number;
  total: number;
  /**
   * Task credit behind `pct`: each Done task is 1, every other task is its ticked share of its
   * checklist (3 of 14 items is 0.21), and a task with no checklist is 0. So 0 ≤ done ≤ credit ≤ total.
   */
  credit: number;
  /**
   * Rounded percent done (credit ÷ tasks), or null when there are no tasks. Never 100 unless every
   * task is Done, never 0 once there is any progress, partial included.
   */
  pct: number | null;
  open: number;
  /**
   * Brent's open tasks he can act on now (not Blocked/Waiting, no unfinished dependency).
   * Hobby tasks are in neither this nor `brentLater`: they count as open, nothing more.
   */
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
  /** "6 of 9 done · 2 in progress", "0 of 4 done + partial" when ticked checklist items add to the fill, or "Planned" when there are no tasks. */
  sub: string;
  hasBrent: boolean;
  /** The planned window (inclusive ET dates). */
  start: string;
  end: string;
  /** Whole tasks that are Done. */
  done: number;
  total: number;
  /** Task credit: Done tasks plus the ticked share of every other task's checklist (see `taskCredit`). */
  credit: number;
  /** credit ÷ total, 0–1 (0 when there are no tasks): the fill. */
  share: number;
  health: LaneHealth;
  /** Set when the chip comes from the pace forecast (time basis) instead of the row count. */
  pace: LanePace | null;
}

/** Overrun tail, in percent of the chart: from the lane's planned end to its projected end. */
export interface LaneTail {
  left: number;
  width: number;
  /** The projected end is past the chart's right edge, so the tail stops there with an arrow. */
  cut: boolean;
}

export interface LanePace {
  /** ET date the lane is projected to finish at the current pace; null with no pace at all. */
  projectedEnd: string | null;
  /** Null when the lane is projected to finish on time. */
  tail: LaneTail | null;
}

/** The projected-finish tag on the axis: at its date, or pinned to the right edge with an arrow. */
export interface TimelineProjected {
  date: string;
  /** "Projected Nov 15", or "Projected Sep 2027 →" past the edge. */
  label: string;
  /** 0–100; 100 when it is off the edge. */
  left: number;
  offEdge: boolean;
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
  /** Task credit behind the fill: Done tasks plus partly ticked checklists. */
  credit: number;
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
  /** The projected-finish tag from the pace forecast; the window never stretches to hold it. */
  projected: TimelineProjected | null;
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
  /** An application id, or `project:<id>` for a personal project without an application (never collides). */
  id: string;
  /** "app" lanes are applications; "project" lanes are personal projects with no application. */
  kind: "app" | "project";
  name: string;
  phase: string;
  counts: TaskCounts;
  stand: string | null;
  next: string | null;
  agentLabels: string[];
  timeline: Timeline;
  /** The strip under the status line, for a lane whose project counts units; null otherwise. */
  pace: PortfolioPaceLine | null;
}

export interface PortfolioPaceLine {
  projectId: string;
  chip: PaceChip;
  text: string;
  separator: boolean;
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
 * Credit for one task toward % done (Brent, 10/3: every task is worth an equal slice, and a
 * task's checklist items split that slice equally). Done is 1, even with items left unticked.
 * Anything else is its ticked share of its checklist (3 of 14 is 3/14), and 0 with no checklist.
 * A fully ticked task that isn't Done yet earns its whole slice here but is still open.
 */
export function taskCredit(
  task: Pick<PortfolioTaskRow, "id" | "status">,
  checklist: PortfolioInput["checklist"] = {}
): number {
  if (task.status === "Done") return 1;
  const items = checklist[task.id];
  if (!items || !Number.isFinite(items.total) || items.total <= 0) return 0;
  return Math.min(Math.max(items.done, 0), items.total) / items.total;
}

/** The credit of a group of tasks: the sum of `taskCredit`. */
export function sumCredit(tasks: Array<Pick<PortfolioTaskRow, "id" | "status">>, checklist: PortfolioInput["checklist"] = {}): number {
  return tasks.reduce((sum, task) => sum + taskCredit(task, checklist), 0);
}

/**
 * Progress ÷ all tasks, as a whole percent. `done` is the number of tasks that are Done; `progress`
 * is the credit (Done tasks plus partly ticked checklists) and defaults to `done`. Rounding never
 * claims 100% unless every task is Done (a fully ticked but open task doesn't finish a row), or 0%
 * once there is any progress, partial included.
 */
export function percentDone(done: number, total: number, progress: number = done): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const safeDone = Math.min(Math.max(done, 0), total);
  const safeProgress = Math.min(Math.max(progress, safeDone), total);
  const pct = Math.round((safeProgress / total) * 100);
  if (safeDone < total && pct === 100) return 99;
  if (safeProgress > 0 && pct === 0) return 1;
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

export function countTasks(
  tasks: PortfolioTaskRow[],
  blockers: PortfolioInput["blockers"] = {},
  checklist: PortfolioInput["checklist"] = {}
): TaskCounts {
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
      else if (isHobbyTaskOrProject(task)) continue;
      else if (isBlockedForBrent(task, blockers)) brentLater += 1;
      else brentOpen += 1;
    }
  }
  const credit = sumCredit(tasks, checklist);
  return { done, total: tasks.length, credit, pct: percentDone(done, tasks.length, credit), open, brentOpen, brentLater, agentOpen };
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
  /**
   * Task credit (Done tasks plus partly ticked checklists), at least `done`. The behind/ahead
   * judgment uses it, so ticking a checklist item moves a lane. Defaults to `done`.
   */
  credit?: number;
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
 *   progress share + 25% < expected → amber "Behind" · progress share ≥ expected + 15% → green "Ahead"
 *   (progress share = credit ÷ tasks: partly ticked checklists count, see `taskCredit`)
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
  const share = Math.min(Math.max(input.credit ?? done, 0), total) / total;
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
  /** Done tasks plus the ticked share of every other task's checklist. */
  credit: number;
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
  /** The project and section it was built from (for the pace overlay). */
  projectId: string | null;
  sectionId: string | null;
}

function summarizeLane(
  key: string,
  label: string,
  project: string | null,
  tasks: PortfolioTaskRow[],
  today: string,
  plan: PlannedWindow,
  checklist: PortfolioInput["checklist"] = {},
  origin: { projectId: string | null; sectionId: string | null } = { projectId: null, sectionId: null }
): LaneSummaryData {
  const open = tasks.filter(isOpenTask);
  const done = tasks.filter((task) => task.status === "Done").length;
  const credit = sumCredit(tasks, checklist);
  const scheduled = Boolean(plan.start && plan.end);
  const start = plan.start ?? today;
  const end = plan.end ?? today;
  return {
    key,
    label,
    project,
    done,
    total: tasks.length,
    credit,
    open: open.length,
    // Hobby tasks are Brent's by default, so they don't light the "You" marker.
    hasBrent: open.some((task) => task.owner === "brent" && !isHobbyTaskOrProject(task)),
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
    health: scheduled ? laneHealth({ done, credit, total: tasks.length, open: open.length, start, end, today }) : null,
    projectId: origin.projectId,
    sectionId: origin.sectionId,
  };
}

/** Ticked checklist items add to the fill beyond the whole tasks done (ignores float dust). */
const PARTIAL_EPSILON = 1e-6;
export function hasPartialCredit(done: number, credit: number): boolean {
  return credit - done > PARTIAL_EPSILON;
}

function laneSub(lane: LaneSummaryData): string {
  if (lane.total === 0) return "Planned";
  // "0 of 4 done + partial" keeps the whole-task count honest next to a fill that includes ticked items.
  const partial = hasPartialCredit(lane.done, lane.credit) ? " + partial" : "";
  return `${lane.done} of ${lane.total} done${partial}${lane.inProgress > 0 ? ` · ${lane.inProgress} in progress` : ""}`;
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
 * end), drawn as its planned window and filled by task credit ÷ tasks (Done tasks
 * plus the ticked share of every other task's checklist, `taskCredit`). Finished
 * sections, sections with no planned window (including each project's "Other
 * tasks") and sections whose window ended long ago go in `earlier`, a list under
 * the chart: no more guessed bars. The project's target date is the marker.
 */
export function buildTimeline(
  tasks: PortfolioTaskRow[],
  projects: PortfolioProjectRow[],
  sections: PortfolioSectionRow[],
  today: string,
  checklist: PortfolioInput["checklist"] = {},
  pace: Record<string, PaceForecast> = {}
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
        plan,
        checklist,
        { projectId: group.projectId, sectionId: section?.id ?? null }
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
    credit: lane.credit,
    share: lane.total > 0 ? Math.min(lane.credit / lane.total, 1) : 0,
    health: lane.health!,
    pace: null,
  }));
  // Lanes with stitch work left take their chip from the forecast once the project has enough counted
  // sittings (the section's health_basis is "time"); every other lane keeps the row-count chip.
  const timedProjection = new Map<string, NonNullable<ReturnType<typeof findProjection>>>();
  summaries.filter(onChart).forEach((summary, index) => {
    const projection = findProjection(pace, summary.projectId, summary.sectionId);
    if (!projection) return;
    const lane = lanes[index];
    timedProjection.set(lane.key, projection);
    lane.health = projection.health === "behind" ? { kind: "behind", label: "Behind" } : { kind: "ok", label: "On track" };
    // The "Starts 10/19" chip is replaced, so a lane that hasn't started says so in its sub-line.
    if (lane.start > today) lane.sub = `${lane.sub} · starts ${formatTick(lane.start)}`;
  });
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
    const credit = lanes.reduce((sum, lane) => sum + lane.credit, 0);
    const parts: string[] = [];
    if (targetDate) parts.push(`Target ${formatTick(targetDate)}`);
    if (total > 0) parts.push(`${done} of ${total} tasks done${hasPartialCredit(done, credit) ? " + partial" : ""}`);
    summary = { health: appHealth(lanes), targetDate, line: parts.join(" · "), done, total, credit };
    // The project's health follows its forecast once it has enough counted sittings (on_track or behind).
    const forecasts = [...projectIds].map((id) => (id ? pace[id] : undefined)).filter((forecast): forecast is PaceForecast => Boolean(forecast));
    const decided = forecasts.filter((forecast) => forecast.health === "on_track" || forecast.health === "behind");
    if (decided.length > 0) {
      summary.health = decided.some((forecast) => forecast.health === "behind")
        ? { kind: "behind", label: "Behind" }
        : { kind: "ok", label: "On track" };
    }
  }

  const chartWindow = { start, end };
  // Overrun tails: from each timed lane's planned end to its projected end, cut at the chart's right edge.
  for (const lane of lanes) {
    const projection = timedProjection.get(lane.key);
    if (!projection) continue;
    let tail: LaneTail | null = null;
    if (projection.projected_end && projection.projected_end > lane.end) {
      const left = timelinePosition(chartWindow, lane.end, 1);
      const cut = projection.projected_end > end;
      const right = cut ? 100 : timelinePosition(chartWindow, projection.projected_end, 1);
      tail = { left, width: Math.max(right - left, 0), cut };
    }
    lane.pace = { projectedEnd: projection.projected_end, tail };
  }

  // The projected-finish tag (a paced project's forecast): at its date, or pinned to the edge with an arrow.
  let projected: TimelineProjected | null = null;
  if (lanes.length > 0) {
    const finish = [...projectIds]
      .map((id) => (id ? pace[id]?.projected_finish ?? null : null))
      .find((date): date is string => Boolean(date));
    if (finish) {
      const offEdge = finish > end;
      projected = {
        date: finish,
        label: offEdge ? `Projected ${formatMonthYear(finish)} →` : `Projected ${formatShortDate(finish)}`,
        left: offEdge ? 100 : timelinePosition(chartWindow, finish, 0.5),
        offEdge,
      };
    }
  }

  return { start, end, today, ticks, lanes, earlier, target, projected, summary };
}

/** A section's projection from the forecast, when its chip should follow the forecast (time basis, on_track or behind). */
function findProjection(pace: Record<string, PaceForecast>, projectId: string | null, sectionId: string | null) {
  if (!projectId || !sectionId) return null;
  const projection = pace[projectId]?.sections?.find((entry) => entry.section_id === sectionId);
  if (!projection || projection.health_basis !== "time") return null;
  if (projection.health !== "on_track" && projection.health !== "behind") return null;
  return projection;
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

/** "Personal — Christmas Tree Blanket" → "Christmas Tree Blanket" (the scope toggle already says personal). */
export function projectLaneName(name: string): string {
  const stripped = name.replace(/^\s*personal\s*[—–-]\s*/i, "").trim();
  return stripped || name;
}

/** The newest status line among open tasks. */
function latestStatusLine(open: PortfolioTaskRow[]): string | null {
  return [...open].filter((task) => task.status_line).sort(byMostRecent)[0]?.status_line ?? null;
}

/** Next: the soonest upcoming due date; otherwise the highest priority. */
function nextOpenTask(open: PortfolioTaskRow[], today: string): PortfolioTaskRow | undefined {
  const upcoming = open
    .map((task) => ({ task, due: toEtDate(task.due_at) }))
    .filter((entry): entry is { task: PortfolioTaskRow; due: string } => Boolean(entry.due && entry.due >= today))
    .sort((a, b) => a.due.localeCompare(b.due) || byPriority(a.task, b.task));
  return upcoming[0]?.task ?? [...open].sort(byPriority)[0];
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
  const checklist = input.checklist ?? {};
  // Only projects that count units get pace: a forecast for any other project is ignored.
  const pace: Record<string, PaceForecast> = {};
  for (const project of input.projects) {
    const forecast = input.pace?.[project.id];
    if (project.unit_label && forecast) pace[project.id] = forecast;
  }
  const paceLineFor = (projects: PortfolioProjectRow[]): PortfolioPaceLine | null => {
    const project = projects.find((entry) => pace[entry.id]);
    if (!project) return null;
    return { projectId: project.id, ...buildPaceLine(pace[project.id]) };
  };
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
      const stand = latestStatusLine(open) ?? firstSentence(impl.status_summary);
      const nextTask = nextOpenTask(open, today);
      const next = impl.next_milestone?.trim()
        ? `${impl.next_milestone.trim()}${impl.next_milestone_date ? ` (${formatShortDate(impl.next_milestone_date)})` : ""}`
        : nextTask
          ? nextTask.title
          : null;
      const app: PortfolioApp = {
        id,
        kind: "app",
        name: impl.name,
        phase: impl.phase,
        counts: countTasks(appTasks, blockers, checklist),
        stand,
        next,
        agentLabels: distinctLabels(appTasks),
        timeline: buildTimeline(
          appTasks,
          input.projects.filter((project) => project.implementation_id === id),
          input.sections,
          today,
          checklist,
          pace
        ),
        pace: null,
      };
      return { app, rank: impl.portfolio_rank };
    })
    .sort((a, b) => a.rank - b.rank || a.app.name.localeCompare(b.app.name))
    .map(({ app }) => app);

  // A personal project with no application has no app lane, so it gets one of its own:
  // the same counts, next and section timeline, after the app lanes. Work scope never
  // reaches this (matchesTaskScope already dropped every personal task above).
  const projectLanes: PortfolioApp[] = [];
  const projectLaneTasks: PortfolioTaskRow[] = [];
  if (options.scope !== "work") {
    const laneProjects = input.projects
      .filter(
        (project) =>
          hasPersonalTag(project) &&
          !project.implementation_id &&
          project.stage !== "Cancelled"
      )
      .sort((a, b) => a.portfolio_rank - b.portfolio_rank || a.name.localeCompare(b.name));
    for (const project of laneProjects) {
      // Tasks that already sit in an app lane (their own implementation_id) are never counted twice.
      const laneTasks = tasks.filter(
        (task) =>
          task.project_id === project.id &&
          !(task.implementation_id && implementationById.has(task.implementation_id))
      );
      if (laneTasks.length === 0) continue;
      projectLaneTasks.push(...laneTasks);
      const open = laneTasks.filter(isOpenTask);
      const nextTask = nextOpenTask(open, today);
      projectLanes.push({
        id: `project:${project.id}`,
        kind: "project",
        name: projectLaneName(project.name),
        phase: project.stage,
        counts: countTasks(laneTasks, blockers, checklist),
        stand: latestStatusLine(open),
        next: nextTask ? nextTask.title : null,
        agentLabels: distinctLabels(laneTasks),
        timeline: buildTimeline(
          laneTasks,
          [project],
          input.sections.filter((section) => section.project_id === project.id),
          today,
          checklist,
          pace
        ),
        pace: paceLineFor([project]),
      });
    }
  }

  // The totals count every drawn lane, project lanes included (Brent wants to see personal progress).
  const overall = countTasks([...[...byApp.values()].flat(), ...projectLaneTasks], blockers, checklist);
  const openTasks = tasks.filter(isOpenTask);
  // Hobby tasks count toward lanes and progress, but nobody is waiting on Brent for them.
  const brentTasks = openTasks.filter((task) => task.owner === "brent" && !isHobbyTaskOrProject(task));
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
    apps: [...apps, ...projectLanes],
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
