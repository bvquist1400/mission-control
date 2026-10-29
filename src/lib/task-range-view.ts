/**
 * Multi-day tasks (Baseline task 6f87add5, slice S2): what a task card shows
 * for a task with a start date (style A, "the whole card fills"). Pure: the
 * rules come from `task-range.ts` (S1) and are never re-derived here; this
 * file only turns `taskRangeState` into words, tones and percentages.
 *
 * A task without a range (no start date, or a start on/after the due date)
 * gets `null`, and the card renders exactly as it did before S2, except an
 * umbrella (Break into tasks, 066): it always gets a view, with or without
 * dates, so "x/y tasks" and the lit Done button show on every open umbrella.
 */
import {
  rangeChipText,
  taskRangeState,
  type ChecklistRowInput,
  type RangeTaskInput,
  type TaskRangeKind,
  type TaskRangeState,
} from './task-range';
import { getDateOnlyWeekday } from './date-only';
import { etToday } from './task-range';

/** Colour family of the chip and the card's left edge. */
export type RangeTone = 'range' | 'today' | 'late' | 'quiet';

export interface RangeStepsView {
  done: number;
  total: number;
  /** "3/5 steps" (compact cards: "3/5"). */
  text: string;
  compactText: string;
  /** "units" when rows are weighted by their unit counts; "tasks" when they are an umbrella's step tasks (Break into tasks, 066). */
  basis: 'units' | 'rows' | 'tasks';
}

export interface RangeCardView {
  kind: TaskRangeKind;
  /** A real start → due range (the lane, "Day X of Y"); false for an umbrella card without one. */
  isRange: boolean;
  /** Violet "Mon–Fri · Day 4 of 5", accent "Due today · Day 5 of 5", red "Overdue · Mon–Wed ended Wed", quiet "Starts Wed 10/28". */
  chipText: string;
  tone: RangeTone;
  /** Green fill width, 0–100 (null without a checklist: no fill). */
  fillPercent: number | null;
  /** Dashed "time gone by" mark, 0–100 (null when it isn't shown: before the start, late, or nothing gone yet). */
  elapsedPercent: number | null;
  /** The amber hint (never red, never late). */
  behindPace: boolean;
  steps: RangeStepsView | null;
  /** Every row ticked: the Done button lights up. Brent still presses it. */
  allStepsDone: boolean;
  /** The sentence for screen readers: the fill is never the only signal. */
  srText: string;
  /** The line under the steps when they're open (null when all steps are done: the card shows the Done prompt). */
  note: string | null;
  /** Day X of Y while the range runs (null otherwise). */
  day: { day: number; of: number } | null;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function percent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function toneFor(kind: TaskRangeKind): RangeTone {
  switch (kind) {
    case 'in_range':
      return 'range';
    case 'due_today':
      return 'today';
    case 'late':
      return 'late';
    default:
      return 'quiet';
  }
}

function dueDayName(state: TaskRangeState): string {
  const dueDate = state.range?.dueDate;
  const weekday = dueDate ? getDateOnlyWeekday(dueDate) : null;
  return weekday === null ? 'the due date' : WEEKDAY_NAMES[weekday];
}

function buildNote(state: TaskRangeState, progressPercent: number | null, elapsedShare: number | null, stepsAreTasks = false): string | null {
  if (state.allStepsDone) return null;
  const workWord = stepsAreTasks ? 'of the tasks are' : state.progress.basis === 'units' ? 'of the work is' : 'of the steps are';
  switch (state.kind) {
    case 'late':
      return 'Due date passed. Move the due date or finish the last steps.';
    case 'before_start':
      return `${rangeChipText(state) ?? 'Not started yet'}. Not in today's priorities until then.`;
    case 'in_range':
    case 'due_today': {
      if (!state.day) return null;
      const dayText = `Day ${state.day.day} of ${state.day.of}`;
      if (progressPercent === null) return `${dayText}.`;
      if (state.behindPace && elapsedShare !== null) {
        return `${dayText}: about ${percent(elapsedShare)}% of the time is gone and ${progressPercent}% ${workWord} done. Not late until after ${dueDayName(state)}.`;
      }
      return `${dayText} · ${progressPercent}% done · on pace.`;
    }
    default:
      return null;
  }
}

function buildSrText(state: TaskRangeState, chipText: string, steps: RangeStepsView | null, progressPercent: number | null, elapsedShare: number | null): string {
  const parts: string[] = [];
  parts.push(state.kind === 'late' ? `${chipText}.` : `Multi-day task, ${chipText}.`);
  if (steps && progressPercent !== null) {
    const unitsNote = steps.basis === 'units' ? ', weighted by size' : '';
    parts.push(`${steps.done} of ${steps.total} ${steps.basis === 'tasks' ? 'tasks' : 'steps'} done, ${progressPercent}%${unitsNote}.`);
  }
  if (state.behindPace && elapsedShare !== null) {
    parts.push(`Behind pace: about ${percent(elapsedShare)}% of the time is gone.`);
  }
  if (state.allStepsDone) {
    parts.push('All steps done. The Done button is ready.');
  }
  return parts.join(' ');
}

/**
 * The card view for a task with a start date, or null for every other task
 * (no start, a one-day range, no due date, or closed): those cards stay as
 * they were.
 */
export function buildRangeCardView(
  task: RangeTaskInput,
  checklistRows: ReadonlyArray<ChecklistRowInput>,
  now: Date,
  options: { stepsAreTasks?: boolean } = {}
): RangeCardView | null {
  const stepsAreTasks = options.stepsAreTasks === true;
  const state = taskRangeState(task, checklistRows, now);
  if (state.kind === 'closed') return null;
  const chipText = state.range && state.range.isRange && state.kind !== 'none' ? rangeChipText(state) : null;
  if (!chipText) {
    // An umbrella shows its step tasks whatever its dates (Codex P2-1).
    return stepsAreTasks && state.progress.totalRows > 0 ? buildUmbrellaCardView(state, now) : null;
  }

  const hasChecklist = state.progress.totalRows > 0;
  const progressPercent = hasChecklist && state.progressFraction !== null ? percent(state.progressFraction) : null;
  const steps: RangeStepsView | null = hasChecklist
    ? {
        done: state.progress.doneRows,
        total: state.progress.totalRows,
        text: `${state.progress.doneRows}/${state.progress.totalRows} ${stepsAreTasks ? 'tasks' : 'steps'}`,
        compactText: `${state.progress.doneRows}/${state.progress.totalRows}`,
        basis: stepsAreTasks ? 'tasks' : state.progress.basis === 'units' ? 'units' : 'rows',
      }
    : null;
  const showsElapsed = (state.kind === 'in_range' || state.kind === 'due_today') && state.elapsed !== null && state.elapsed > 0;

  return {
    kind: state.kind,
    isRange: true,
    chipText,
    tone: toneFor(state.kind),
    fillPercent: progressPercent,
    elapsedPercent: showsElapsed && state.elapsed !== null ? percent(state.elapsed) : null,
    behindPace: state.behindPace,
    steps,
    allStepsDone: state.allStepsDone,
    srText: buildSrText(state, chipText, steps, progressPercent, state.elapsed),
    note: buildNote(state, progressPercent, state.elapsed, stepsAreTasks),
    day: state.day ? { day: state.day.day, of: state.day.of } : null,
  };
}

function shortDueDay(dateOnly: string): string {
  const weekday = getDateOnlyWeekday(dateOnly);
  const md = `${Number(dateOnly.slice(5, 7))}/${Number(dateOnly.slice(8, 10))}`;
  return weekday === null ? md : `${WEEKDAY_NAMES[weekday]} ${md}`;
}

/**
 * An open umbrella without a start → due range (no dates, a due date only, or
 * start = due): the "x/y tasks" pill, the green fill and the lit Done button,
 * with the plain due words ("Overdue", "Due today", "Due Fri 10/30") as its chip
 * and no time-gone mark (there is no range to be behind on).
 */
function buildUmbrellaCardView(state: TaskRangeState, now: Date): RangeCardView {
  const progressPercent = state.progressFraction !== null ? percent(state.progressFraction) : 0;
  const dueDate = state.range?.dueDate ?? null;
  const kind: TaskRangeKind = state.kind === 'late' ? 'late' : dueDate && dueDate === etToday(now) ? 'due_today' : state.kind;
  const chipText = kind === 'late' ? 'Overdue' : kind === 'due_today' ? 'Due today' : dueDate ? `Due ${shortDueDay(dueDate)}` : '';
  const tone: RangeTone = kind === 'late' ? 'late' : kind === 'due_today' ? 'today' : 'quiet';
  const { doneRows, totalRows } = state.progress;
  const steps: RangeStepsView = {
    done: doneRows,
    total: totalRows,
    text: `${doneRows}/${totalRows} tasks`,
    compactText: `${doneRows}/${totalRows}`,
    basis: 'tasks',
  };
  const sr: string[] = [chipText ? `Umbrella task, ${chipText}.` : 'Umbrella task.'];
  sr.push(`${doneRows} of ${totalRows} tasks done, ${progressPercent}%.`);
  if (state.allStepsDone) sr.push('All steps done. The Done button is ready.');
  return {
    kind,
    isRange: false,
    chipText,
    tone,
    fillPercent: progressPercent,
    elapsedPercent: null,
    behindPace: false,
    steps,
    allStepsDone: state.allStepsDone,
    srText: sr.join(' '),
    note: state.allStepsDone ? null : kind === 'late' ? 'Due date passed. Move the due date or finish the last tasks.' : null,
    day: null,
  };
}

/** The steps pill's words: "1/5 steps · behind pace", "3/3 steps · all done". */
export function stepsPillText(view: RangeCardView, compact = false): string | null {
  if (!view.steps) return null;
  const base = compact ? view.steps.compactText : view.steps.text;
  if (view.allStepsDone) return `${base} · all done`;
  if (view.behindPace) return `${base} · behind pace`;
  return base;
}
