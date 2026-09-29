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

export type LaneState = "done" | "prog" | "wait" | "plan";

export interface TimelineLane {
  key: string;
  label: string;
  /** The project name, shown when an app has more than one project on the timeline. */
  project: string | null;
  sub: string;
  hasBrent: boolean;
  state: LaneState;
  start: string;
  end: string;
  /** No planned end and no task due date, so the end is a placeholder. Drawn dashed. */
  estimated: boolean;
  /** The section has planned dates (migration 057): drawn solid from them. */
  planned: boolean;
  overdue: boolean;
  /** The bar runs past the chart's right edge (drawn with an arrow). */
  continues: boolean;
}

export interface Timeline {
  start: string;
  end: string;
  today: string;
  ticks: string[];
  lanes: TimelineLane[];
  /** Lanes that finished before the window starts, left off the chart. */
  hiddenEarlier: number;
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

/** Placeholder length for an open lane with no due date: it runs a week past today. */
const ESTIMATE_DAYS_PAST_TODAY = 7;
/** How far back the chart looks, and the minimum it looks ahead. */
const WINDOW_BACK_DAYS = 56;
const WINDOW_AHEAD_MIN_DAYS = 28;
const WINDOW_AHEAD_MAX_DAYS = 84;

function laneState(tasks: PortfolioTaskRow[]): LaneState {
  if (tasks.length === 0) return "plan";
  const open = tasks.filter(isOpenTask);
  if (open.length === 0) return "done";
  if (open.some((task) => task.status === "In Progress")) return "prog";
  if (open.some((task) => task.status === "Blocked/Waiting")) return "wait";
  if (tasks.some((task) => task.status === "Done")) return "prog";
  return "plan";
}

function validPlannedDate(value: string | null | undefined): string | null {
  return value && toUtcDateMs(value) !== null ? value : null;
}

function buildLane(
  key: string,
  label: string,
  project: string | null,
  tasks: PortfolioTaskRow[],
  today: string,
  plan: { start: string | null; end: string | null } = { start: null, end: null }
): TimelineLane {
  const created = tasks.map((task) => toEtDate(task.created_at)).filter((d): d is string => Boolean(d));
  const dues = tasks.map((task) => toEtDate(task.due_at)).filter((d): d is string => Boolean(d));
  const state = laneState(tasks);
  const open = tasks.filter(isOpenTask);
  const done = tasks.filter((task) => task.status === "Done").length;
  // Overdue comes from task due dates only; a planned end in the past never turns a lane red.
  const latestDue = dues.length ? dues.reduce(maxDate) : null;
  const overdue = state !== "done" && tasks.length > 0 && latestDue !== null && latestDue < today;

  let start = created.length ? created.reduce(minDate) : today;
  let end: string;
  let estimated = false;
  if (state === "done") {
    // Finished: from the first task to the last change (tasks have no completed_at).
    const lastChange = tasks
      .map((task) => toEtDate(task.updated_at))
      .filter((d): d is string => Boolean(d))
      .reduce(maxDate, start);
    end = dues.length ? maxDate(lastChange, dues.reduce(maxDate)) : lastChange;
  } else if (dues.length) {
    end = dues.reduce(maxDate);
  } else {
    estimated = true;
    end = addDays(maxDate(today, start), ESTIMATE_DAYS_PAST_TODAY);
  }
  if (dues.length) start = minDate(start, dues.reduce(minDate));

  // Planned dates (057) replace the estimate for the bar's ends; they never move a due date.
  const planned = Boolean(plan.start || plan.end);
  if (plan.start) start = plan.start;
  if (plan.end) {
    end = plan.end;
    estimated = false;
  } else if (plan.start && estimated) {
    end = addDays(maxDate(today, plan.start), ESTIMATE_DAYS_PAST_TODAY);
  }
  if (end < start) end = start;

  const sub =
    tasks.length === 0
      ? "Planned · no tasks yet"
      : state === "done"
        ? "Done"
        : `${done} of ${tasks.length} done${estimated ? (planned ? " · no planned end" : " · no due date") : ""}`;

  return {
    key,
    label,
    project,
    sub,
    hasBrent: open.some((task) => task.owner === "brent"),
    state,
    start,
    end,
    estimated,
    planned,
    overdue,
    continues: false,
  };
}

/**
 * One lane per project section that has tasks (plus one per project for tasks
 * with no section). Bars run from the first task's creation (or earliest due
 * date) to the latest due date; open lanes with no due dates get a dashed
 * placeholder ending a week after today.
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

  const allLanes = [...groups.entries()]
    .sort(([, a], [, b]) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2].localeCompare(b.order[2]))
    .map(([key, group]) => {
      const projectName = group.projectId ? projectById.get(group.projectId)?.name ?? null : null;
      const isProjectLane = key.startsWith("p:");
      // A project's unsectioned tasks sit beside its sections as "Other tasks".
      const leftovers = isProjectLane && sectionedProjects.has(group.projectId);
      const section = key.startsWith("s:") ? sectionById.get(key.slice(2)) : undefined;
      let plan = { start: validPlannedDate(section?.planned_start), end: validPlannedDate(section?.planned_end) };
      // A bad pair (the database forbids it) falls back to the estimate rather than drawing backwards.
      if (plan.start && plan.end && plan.end < plan.start) plan = { start: null, end: null };
      return buildLane(
        key,
        leftovers ? "Other tasks" : group.label,
        showProject && (!isProjectLane || leftovers) ? projectName : null,
        group.tasks,
        today,
        plan
      );
    });

  const earliest = addDays(today, -WINDOW_BACK_DAYS);
  const lanes = allLanes.filter((lane) => lane.end >= earliest);
  const hiddenEarlier = allLanes.length - lanes.length;

  const firstStart = lanes.length ? lanes.map((lane) => lane.start).reduce(minDate) : today;
  const lastEnd = lanes.length ? lanes.map((lane) => lane.end).reduce(maxDate) : today;
  const start = startOfWeek(maxDate(minDate(firstStart, addDays(today, -7)), earliest));
  const end = minDate(
    maxDate(addDays(lastEnd, 3), addDays(today, WINDOW_AHEAD_MIN_DAYS)),
    addDays(today, WINDOW_AHEAD_MAX_DAYS)
  );

  for (const lane of lanes) lane.continues = lane.end > end;

  const spanDays = Math.max(daysBetween(start, end), 1);
  const step = spanDays <= 84 ? 7 : spanDays <= 168 ? 14 : 28;
  const ticks: string[] = [];
  for (let tick = start; tick <= end; tick = addDays(tick, step)) ticks.push(tick);

  return { start, end, today, ticks, lanes, hiddenEarlier };
}

/** Where a date falls on the timeline, 0–100. */
export function timelinePosition(timeline: Pick<Timeline, "start" | "end">, date: string): number {
  const span = Math.max(daysBetween(timeline.start, timeline.end), 1);
  const at = daysBetween(timeline.start, date);
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
