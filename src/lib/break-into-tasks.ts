/**
 * Break into tasks (Baseline task d1f7e622, mockup 3a320c1c). Pure and
 * browser-safe: the dialog and the server use the same rules.
 *
 * Brent's picks (10/29): the original task stays OPEN as an umbrella whose
 * progress counts the new tasks (done ÷ all), and finished checklist steps are
 * kept as Done tasks dated the day they were ticked. The umbrella never closes
 * on its own: when every step is Done it says "all steps done" and lights its
 * Done button (the multi-day rule, `allStepsDone`).
 *
 * Mockup rules kept here:
 * - Dates: open steps are spread over the counted days left, from today (or the
 *   start date, if later) to the due date; the last one gets the task's due
 *   date. Days are counted like "Day X of Y" (`rangeCalendarFor`: Mon–Fri for
 *   work, every day for personal, Brent 10/22 "weekends only for personal").
 *   Too many steps for the days left: several share a day. A task with no due
 *   date (or one already past) gets today + 1 counted day, + 2, … instead.
 * - Who and status: every step starts with the original's owner. The first
 *   open step starts In Progress when the original is In Progress (else
 *   Planned); the rest Planned ("Blocked by dependency" is how a waiting step
 *   is shown, not a status).
 * - Carried over (server side, under the lock): project, application, sprint,
 *   tags and base priority. Comments and notes stay on the original; each new
 *   task starts with a comment pointing back to it.
 * - Nothing is deleted: the checklist stays on the original for the record.
 * - The button shows only when at least one checklist step is still open.
 */
import { addDateOnlyDays, getDateOnlyWeekday, normalizeDateOnly } from './date-only';
import { buildRecurringDueAt } from './recurrence';
import { calculateFinalPriorityScore, calculatePriorityBoosts } from './priority';
import { etDate, etToday, rangeCalendarFor, RANGE_TIME_ZONE, type ChecklistRowInput, type RangeCalendar } from './task-range';

export const BREAK_MAX_STEPS = 100;
export const BREAK_NAME_MAX = 200;

export type BreakDestinationKind = 'new_section' | 'existing_section' | 'new_project' | 'existing_project';
export type BreakOwner = 'brent' | 'agent';
export type OpenStepStatus = 'In Progress' | 'Planned';

export interface BreakUmbrella {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  start_at: string | null;
  due_at: string | null;
  tags: string[] | null;
  project_id: string | null;
  base_priority: number;
  project?: { id?: string; name?: string; tags?: string[] | null } | null;
}

export interface BreakChecklistRow {
  id: string;
  text: string;
  is_done: boolean;
  sort_order: number;
  completed_at: string | null;
  unit_count: number | null;
  work_type: string | null;
}

/** What the dialog sends (POST /api/tasks/{id}/break). */
export interface BreakRequestStep {
  checklist_item_id: string;
  /** YYYY-MM-DD for an open step (null = no due date). Finished steps use the tick date. */
  due_date: string | null;
  owner: BreakOwner;
  /** Open steps only: wait on the open step before it. */
  waits_on_previous: boolean;
}

export interface BreakRequest {
  destination: {
    kind: BreakDestinationKind;
    /** new_section / existing_project: the new section's name; new_project: the project's name. */
    name?: string | null;
    /** existing_section: null = unsectioned. */
    section_id?: string | null;
    /** existing_project: the project to put the new section in. */
    project_id?: string | null;
  };
  steps: BreakRequestStep[];
}

// ── Small words ─────────────────────────────────────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Thu 10/29". */
export function shortDay(dateOnly: string): string {
  const weekday = getDateOnlyWeekday(dateOnly);
  const md = `${Number(dateOnly.slice(5, 7))}/${Number(dateOnly.slice(8, 10))}`;
  return weekday === null ? md : `${WEEKDAY_NAMES[weekday]} ${md}`;
}

/** The first four words and "…", like the mockup's summary line. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length > 4 ? `${words.slice(0, 4).join(' ')}…` : words.join(' ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The default name of the new section or project: the task's title, cut to fit. */
export function defaultDestinationName(title: string): string {
  return title.trim().slice(0, BREAK_NAME_MAX);
}

// ── When the button shows ───────────────────────────────────────────────────

/** "Hidden when pointless": at least one open checklist step, and not already broken out. */
export function canBreakIntoTasks(rows: ReadonlyArray<Pick<BreakChecklistRow, 'is_done'>>, stepCount = 0): boolean {
  return stepCount === 0 && rows.some((row) => !row.is_done);
}

// ── Dates ───────────────────────────────────────────────────────────────────

function isCountedDay(dateOnly: string, calendar: RangeCalendar): boolean {
  if (calendar === 'all_days') return true;
  const weekday = getDateOnlyWeekday(dateOnly);
  return weekday !== null && weekday !== 0 && weekday !== 6;
}

/** Counted days from `from` to `to`, both included (at most 400). */
export function countedDays(from: string, to: string, calendar: RangeCalendar): string[] {
  const days: string[] = [];
  let cursor: string | null = from;
  for (let guard = 0; cursor && cursor <= to && guard < 400; guard += 1) {
    if (isCountedDay(cursor, calendar)) days.push(cursor);
    cursor = addDateOnlyDays(cursor, 1);
  }
  return days;
}

/** The n-th counted day after `from` (n ≥ 1). */
function nthCountedDayAfter(from: string, n: number, calendar: RangeCalendar): string {
  let cursor = from;
  let found = 0;
  for (let guard = 0; guard < 1000 && found < n; guard += 1) {
    cursor = addDateOnlyDays(cursor, 1) ?? cursor;
    if (isCountedDay(cursor, calendar)) found += 1;
  }
  return cursor;
}

export interface ProposedDates {
  /** One YYYY-MM-DD per open step, in order. */
  dates: string[];
  /** "spread": over the task's days left; "next_days": no usable due date, one counted day each from tomorrow. */
  basis: 'spread' | 'next_days';
  /** The days the spread used (for the hint under the table). */
  window: string[];
  dueDate: string | null;
}

/**
 * Proposed due dates for the open steps (see the header). The last open step
 * lands on the task's due date.
 */
export function proposeStepDates(umbrella: Pick<BreakUmbrella, 'start_at' | 'due_at' | 'tags' | 'project'>, openCount: number, now: Date): ProposedDates {
  const calendar = rangeCalendarFor({ tags: umbrella.tags, project: umbrella.project ?? null });
  const today = etToday(now);
  const dueDate = etDate(umbrella.due_at);
  if (openCount <= 0) return { dates: [], basis: 'spread', window: [], dueDate };

  if (dueDate && dueDate >= today) {
    const startDate = etDate(umbrella.start_at);
    const from = startDate && startDate > today && startDate <= dueDate ? startDate : today;
    let window = countedDays(from, dueDate, calendar);
    if (window.length === 0 || window[window.length - 1] !== dueDate) window = [...window, dueDate];
    const n = window.length;
    const dates = Array.from({ length: openCount }, (_, i) => window[Math.max(0, Math.ceil(((i + 1) * n) / openCount) - 1)]);
    return { dates, basis: 'spread', window, dueDate };
  }

  const dates = Array.from({ length: openCount }, (_, i) => nthCountedDayAfter(today, i + 1, calendar));
  return { dates, basis: 'next_days', window: [], dueDate };
}

/** The hint under the steps table. */
export function proposedDatesHint(proposed: ProposedDates, openCount: number): string {
  if (openCount === 0) return 'Every chosen step is already finished, so there are no dates to set.';
  if (proposed.basis === 'next_days') {
    return `This task has no due date ahead, so the ${plural(openCount, 'open step')} get one working day each from tomorrow. Change any date.`;
  }
  const days = proposed.window;
  const named = days.map(shortDay);
  const span =
    named.length === 1
      ? named[0]
      : named.length <= 3
        ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
        : `${named[0]} to ${named[named.length - 1]}`;
  const due = proposed.dueDate ? shortDay(proposed.dueDate) : '';
  return `Proposed dates: the ${plural(openCount, 'open step')} ${openCount === 1 ? 'is' : 'are'} spread over the days left (${span}), and the last one lands on this task's due date, ${due}. Change any date.`;
}

/** A step's due instant: the task's own due_at on its due date, else the end of that ET day. */
export function stepDueAt(dateOnly: string | null, umbrella: Pick<BreakUmbrella, 'due_at'>): string | null {
  if (!dateOnly) return null;
  if (umbrella.due_at && etDate(umbrella.due_at) === dateOnly) return umbrella.due_at;
  return buildRecurringDueAt(dateOnly, RANGE_TIME_ZONE);
}

/** A finished step's date: the ET day its row was ticked (null for rows ticked before 059 kept times). */
export function finishedStepDate(row: Pick<BreakChecklistRow, 'completed_at'>): string | null {
  return etDate(row.completed_at);
}

// ── Status and owner ────────────────────────────────────────────────────────

export function defaultOwner(umbrella: Pick<BreakUmbrella, 'owner'>): BreakOwner {
  return umbrella.owner === 'agent' ? 'agent' : 'brent';
}

/** The first open step follows an In Progress task; the rest start Planned. */
export function openStepStatus(umbrellaStatus: string, openIndex: number): OpenStepStatus {
  return openIndex === 0 && umbrellaStatus === 'In Progress' ? 'In Progress' : 'Planned';
}

/** What the "Starts as" chip says for an open step in the dialog. */
export function startsAsLabel(umbrellaStatus: string, openIndex: number, waits: boolean): string {
  if (openIndex > 0 && waits) return 'Blocked by dependency';
  return openStepStatus(umbrellaStatus, openIndex);
}

// ── The summary line ────────────────────────────────────────────────────────

export interface BreakSummaryInput {
  kind: BreakDestinationKind;
  name: string;
  projectName: string | null;
  /** existing_section: the section's name (null = unsectioned). */
  sectionName?: string | null;
  openCount: number;
  doneCount: number;
}

export function breakSummary(input: BreakSummaryInput): { line: string; umbrellaLine: string; button: string; ready: boolean } {
  const total = input.openCount + input.doneCount;
  const umbrellaLine = 'This task stays open as their umbrella: its progress counts the new tasks, and you close it when they are done. Nothing is deleted.';
  if (total === 0) {
    return { line: 'Nothing selected yet. Tick at least one step.', umbrellaLine, button: 'Break into tasks', ready: false };
  }
  const parts: string[] = [];
  if (input.openCount) parts.push(plural(input.openCount, 'open task'));
  if (input.doneCount) parts.push(plural(input.doneCount, 'done task'));
  const nm = shortName(input.name);
  const project = input.projectName ?? 'the project';
  let target: string;
  switch (input.kind) {
    case 'new_section':
      target = `a new section “${nm}” in ${project}`;
      break;
    case 'existing_section':
      target = input.sectionName ? `the existing section “${input.sectionName}” in ${project}` : `${project}, with no section`;
      break;
    case 'new_project':
      target = `a new project “${nm}”`;
      break;
    case 'existing_project':
      target = `the project “${project}”, as a new section “${nm}”`;
      break;
  }
  return { line: `Creates ${parts.join(' + ')} in ${target}.`, umbrellaLine, button: `Break into ${plural(total, 'task')}`, ready: true };
}

// ── Validating and planning the request (server) ────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINATION_KINDS: ReadonlyArray<BreakDestinationKind> = ['new_section', 'existing_section', 'new_project', 'existing_project'];
const REQUEST_KEYS = new Set(['destination', 'steps']);
const DESTINATION_KEYS = new Set(['kind', 'name', 'section_id', 'project_id']);
const STEP_KEYS = new Set(['checklist_item_id', 'due_date', 'owner', 'waits_on_previous']);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

/** Parses the dialog's request body. Any unknown field is refused. */
export function parseBreakRequest(body: unknown): Parsed<BreakRequest> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a JSON object.' };
  const raw = body as Record<string, unknown>;
  const extra = unknownKey(raw, REQUEST_KEYS);
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };

  const dest = raw.destination;
  if (!dest || typeof dest !== 'object' || Array.isArray(dest)) return { ok: false, error: 'destination is required.' };
  const d = dest as Record<string, unknown>;
  const destExtra = unknownKey(d, DESTINATION_KEYS);
  if (destExtra) return { ok: false, error: `Unknown destination field: ${destExtra}` };
  if (!DESTINATION_KINDS.includes(d.kind as BreakDestinationKind)) {
    return { ok: false, error: 'destination.kind must be new_section, existing_section, new_project or existing_project.' };
  }
  const kind = d.kind as BreakDestinationKind;
  let name: string | null = null;
  if (kind === 'new_section' || kind === 'new_project' || kind === 'existing_project') {
    if (typeof d.name !== 'string' || !d.name.trim()) return { ok: false, error: kind === 'new_project' ? 'Give the project a name.' : 'Give the section a name.' };
    name = d.name.trim();
    if (name.length > BREAK_NAME_MAX) return { ok: false, error: `The name can be at most ${BREAK_NAME_MAX} characters.` };
  }
  let sectionId: string | null = null;
  if (kind === 'existing_section' && d.section_id !== undefined && d.section_id !== null && d.section_id !== '') {
    if (typeof d.section_id !== 'string' || !UUID_RE.test(d.section_id)) return { ok: false, error: 'section_id must be a section id or null.' };
    sectionId = d.section_id;
  }
  let projectId: string | null = null;
  if (kind === 'existing_project') {
    if (typeof d.project_id !== 'string' || !UUID_RE.test(d.project_id)) return { ok: false, error: 'Pick a project.' };
    projectId = d.project_id;
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { ok: false, error: 'Pick at least one step.' };
  if (raw.steps.length > BREAK_MAX_STEPS) return { ok: false, error: `At most ${BREAK_MAX_STEPS} steps at a time.` };
  const seen = new Set<string>();
  const steps: BreakRequestStep[] = [];
  for (const item of raw.steps) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: 'Each step must be an object.' };
    const s = item as Record<string, unknown>;
    const stepExtra = unknownKey(s, STEP_KEYS);
    if (stepExtra) return { ok: false, error: `Unknown step field: ${stepExtra}` };
    if (typeof s.checklist_item_id !== 'string' || !UUID_RE.test(s.checklist_item_id)) return { ok: false, error: 'Each step needs its checklist_item_id.' };
    if (seen.has(s.checklist_item_id)) return { ok: false, error: 'A checklist step was sent twice.' };
    seen.add(s.checklist_item_id);
    let dueDate: string | null = null;
    if (s.due_date !== undefined && s.due_date !== null && s.due_date !== '') {
      const normalized = typeof s.due_date === 'string' ? normalizeDateOnly(s.due_date) : null;
      if (!normalized) return { ok: false, error: 'A due date must be a real YYYY-MM-DD date.' };
      dueDate = normalized;
    }
    if (s.owner !== 'brent' && s.owner !== 'agent') return { ok: false, error: 'owner must be brent or agent.' };
    if (s.waits_on_previous !== undefined && typeof s.waits_on_previous !== 'boolean') return { ok: false, error: 'waits_on_previous must be true or false.' };
    steps.push({ checklist_item_id: s.checklist_item_id, due_date: dueDate, owner: s.owner, waits_on_previous: s.waits_on_previous === true });
  }

  return { ok: true, value: { destination: { kind, name, section_id: sectionId, project_id: projectId }, steps } };
}

/** One step as the database function takes it (066's `p_request.steps[]`). */
export interface BreakRpcStep {
  checklist_item_id: string;
  expect_done: boolean;
  title: string;
  status: 'Done' | OpenStepStatus;
  due_at: string | null;
  owner: BreakOwner;
  priority_score: number;
  done_at: string | null;
  unit_count: number | null;
  work_type: string | null;
  waits_on_previous: boolean;
  comment: string;
}

export interface BreakRpcRequest {
  expect_project_id: string | null;
  expect_base_priority: number;
  destination: {
    kind: BreakDestinationKind;
    project_id: string | null;
    section_id: string | null;
    name: string | null;
    planned_start: string | null;
    planned_end: string | null;
    stage: string | null;
  };
  steps: BreakRpcStep[];
  umbrella_comment: string;
}

export interface BreakPlanContext {
  umbrella: BreakUmbrella;
  rows: ReadonlyArray<BreakChecklistRow>;
  /** The umbrella's project name (null without one), for the comments. */
  projectName: string | null;
  /** existing_section: the section's name; existing_project: the project's name. */
  destinationLabel?: string | null;
  now: Date;
}

/** Turns a parsed request into the database call, in checklist order. */
export function planBreak(request: BreakRequest, ctx: BreakPlanContext): Parsed<BreakRpcRequest> {
  const { umbrella, now } = ctx;
  const kind = request.destination.kind;
  if ((kind === 'new_section' || kind === 'existing_section') && !umbrella.project_id) {
    return { ok: false, error: 'This task has no project: choose a new project or an existing project.' };
  }
  if ((kind === 'new_project' || kind === 'existing_project') && umbrella.project_id) {
    return { ok: false, error: 'This task is already in a project: choose a new section or an existing section.' };
  }

  const rowById = new Map(ctx.rows.map((row) => [row.id, row]));
  const chosen: Array<{ row: BreakChecklistRow; step: BreakRequestStep }> = [];
  for (const step of request.steps) {
    const row = rowById.get(step.checklist_item_id);
    if (!row) return { ok: false, error: 'A chosen step is no longer on this task’s checklist. Close the window and try again.' };
    chosen.push({ row, step });
  }
  // Checklist order, whatever order they were sent in.
  const order = new Map(ctx.rows.map((row, index) => [row.id, index]));
  chosen.sort((a, b) => (order.get(a.row.id) ?? 0) - (order.get(b.row.id) ?? 0));

  const total = chosen.length;
  const doneCount = chosen.filter(({ row }) => row.is_done).length;
  const today = etToday(now);
  let openIndex = 0;
  const destinationText = destinationPhrase(kind, request.destination.name ?? null, ctx);
  const steps: BreakRpcStep[] = chosen.map(({ row, step }, index) => {
    const title = row.text.trim() || `Step ${index + 1}`;
    const isDone = row.is_done;
    const status: BreakRpcStep['status'] = isDone ? 'Done' : openStepStatus(umbrella.status, openIndex);
    const dueAt = isDone ? stepDueAt(finishedStepDate(row), { due_at: null }) : stepDueAt(step.due_date, umbrella);
    const priority = calculateFinalPriorityScore(
      umbrella.base_priority,
      calculatePriorityBoosts([], dueAt, title, status, [])
    );
    const waits = !isDone && openIndex > 0 && step.waits_on_previous;
    if (!isDone) openIndex += 1;
    return {
      checklist_item_id: row.id,
      expect_done: isDone,
      title,
      status,
      due_at: dueAt,
      owner: step.owner,
      priority_score: Math.round(priority),
      done_at: isDone ? row.completed_at : null,
      unit_count: row.unit_count,
      work_type: row.work_type,
      waits_on_previous: waits,
      comment: `Part of “${umbrella.title}”: broken out of its checklist on ${shortDay(today)} (step ${index + 1} of ${total}). Comments and notes stay on that task.`,
    };
  });

  const planned = plannedSectionDates(umbrella, steps);
  const newName = request.destination.name ?? null;
  return {
    ok: true,
    value: {
      expect_project_id: umbrella.project_id,
      expect_base_priority: umbrella.base_priority,
      destination: {
        kind,
        project_id: kind === 'existing_project' ? request.destination.project_id ?? null : kind === 'new_project' ? null : umbrella.project_id,
        section_id: kind === 'existing_section' ? request.destination.section_id ?? null : null,
        name: kind === 'existing_section' ? null : newName,
        planned_start: kind === 'new_section' || kind === 'existing_project' ? planned.start : null,
        planned_end: kind === 'new_section' || kind === 'existing_project' ? planned.end : null,
        stage: kind === 'new_project' ? (umbrella.status === 'In Progress' ? 'In Progress' : 'Planned') : null,
      },
      steps,
      umbrella_comment:
        `Broken into ${plural(total, 'task')} in ${destinationText}` +
        (doneCount ? ` (${doneCount} already done)` : '') +
        `. This task stays open as their umbrella: its progress counts them, and it is yours to close when they are done. Its checklist is kept for the record.`,
    },
  };
}

function destinationPhrase(kind: BreakDestinationKind, name: string | null, ctx: BreakPlanContext): string {
  switch (kind) {
    case 'new_section':
      return `the new section “${name ?? ''}”`;
    case 'existing_section':
      return ctx.destinationLabel ? `the section “${ctx.destinationLabel}”` : `${ctx.projectName ?? 'the project'} (no section)`;
    case 'new_project':
      return `the new project “${name ?? ''}”`;
    case 'existing_project':
      return `a new section “${name ?? ''}” in ${ctx.destinationLabel ?? 'the project'}`;
  }
}

/** The new section "carries the task's dates": its start → due, else the steps' first → last date. */
export function plannedSectionDates(
  umbrella: Pick<BreakUmbrella, 'start_at' | 'due_at'>,
  steps: ReadonlyArray<Pick<BreakRpcStep, 'due_at'>>
): { start: string | null; end: string | null } {
  const start = etDate(umbrella.start_at);
  const due = etDate(umbrella.due_at);
  if (start && due && start <= due) return { start, end: due };
  const dates = steps.map((step) => etDate(step.due_at)).filter((value): value is string => Boolean(value)).sort();
  if (dates.length === 0) return { start: null, end: due };
  const first = dates[0];
  const last = dates[dates.length - 1];
  const end = due && due > last ? due : last;
  return { start: first <= end ? first : null, end };
}

/** Why the database refused, in plain words, with the HTTP status. */
export function breakRefusal(reason: string): { status: number; error: string } {
  switch (reason) {
    case 'not_found':
      return { status: 404, error: 'Task not found.' };
    case 'already_broken':
      return { status: 409, error: 'This task has already been broken into tasks.' };
    case 'recurring_template':
      return { status: 400, error: 'A repeating task can’t be broken into tasks.' };
    case 'task_changed':
      return { status: 409, error: 'This task changed while the window was open (its project or priority). Close the window and try again.' };
    case 'checklist_changed':
      return { status: 409, error: 'The checklist changed while the window was open (a step was ticked, unticked or removed). Close the window and try again.' };
    case 'section_name_taken':
      return { status: 409, error: 'That project already has a section with this name. Pick another name.' };
    case 'section_not_found':
      return { status: 404, error: 'That section no longer exists.' };
    case 'project_not_found':
      return { status: 404, error: 'That project no longer exists.' };
    case 'changed':
      return { status: 409, error: 'Those tasks changed since, so Undo can’t take them back. Delete them by hand if you need to.' };
    default:
      return { status: 409, error: 'That could not be done. Try again.' };
  }
}

// ── Umbrella progress (Today, the task window, Portfolio) ───────────────────

/** A step task as the umbrella reads it. */
export interface StepTaskStatus {
  status: string;
}

/**
 * The rows an umbrella's progress counts: one per step task (Done = ticked).
 * Every step weighs the same (tasks carry no units here).
 */
export function stepProgressRows(steps: ReadonlyArray<StepTaskStatus>): ChecklistRowInput[] {
  return steps.map((step) => ({ is_done: step.status === 'Done', unit_count: null }));
}

/**
 * What a card's progress counts: the step tasks when the task is an umbrella
 * (Brent 10/29: "Today counts the new tasks"), else its checklist rows.
 */
export function progressRowsFor(task: {
  step_tasks?: ReadonlyArray<StepTaskStatus> | null;
  checklist_rows?: ReadonlyArray<ChecklistRowInput> | null;
}): { rows: ChecklistRowInput[]; source: 'tasks' | 'checklist' } {
  if (task.step_tasks && task.step_tasks.length > 0) return { rows: stepProgressRows(task.step_tasks), source: 'tasks' };
  return { rows: [...(task.checklist_rows ?? [])], source: 'checklist' };
}

/** "4/6 tasks done" for the umbrella; null without steps. */
export function stepsDoneText(steps: ReadonlyArray<StepTaskStatus>): string | null {
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.status === 'Done').length;
  return done === steps.length ? `All ${steps.length} steps done` : `${done}/${steps.length} tasks done`;
}

/**
 * Portfolio credit: an umbrella's "checklist" entry becomes its steps (done /
 * all), so its slice fills as the step tasks get done.
 */
export function withStepProgress<T extends Record<string, { done: number; total: number }>>(
  tasks: ReadonlyArray<{ id: string; status: string; parent_task_id?: string | null }>,
  checklist: T
): Record<string, { done: number; total: number }> {
  const steps = new Map<string, { done: number; total: number }>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const entry = steps.get(task.parent_task_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.status === 'Done') entry.done += 1;
    steps.set(task.parent_task_id, entry);
  }
  if (steps.size === 0) return checklist;
  const next: Record<string, { done: number; total: number }> = { ...checklist };
  for (const [id, entry] of steps) next[id] = entry;
  return next;
}

/**
 * A project section made by a break: every task in it is a step of the same
 * umbrella. Returns that umbrella's id and the section's done/total, else null.
 */
export function sectionUmbrella(
  tasks: ReadonlyArray<{ status: string; parent_task_id?: string | null }>
): { umbrellaId: string; done: number; total: number } | null {
  if (tasks.length === 0) return null;
  const parent = tasks[0].parent_task_id;
  if (!parent || tasks.some((task) => task.parent_task_id !== parent)) return null;
  return { umbrellaId: parent, done: tasks.filter((task) => task.status === 'Done').length, total: tasks.length };
}
