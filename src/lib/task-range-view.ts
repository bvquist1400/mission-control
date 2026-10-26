/**
 * Multi-day tasks (Baseline task 6f87add5, slice S2): what a task card shows
 * for a task with a start date (style A, "the whole card fills"). Pure: the
 * rules come from `task-range.ts` (S1) and are never re-derived here; this
 * file only turns `taskRangeState` into words, tones and percentages.
 *
 * A task without a range (no start date, or a start on/after the due date)
 * gets `null`, and the card renders exactly as it did before S2.
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

/** Colour family of the chip and the card's left edge. */
export type RangeTone = 'range' | 'today' | 'late' | 'quiet';

export interface RangeStepsView {
  done: number;
  total: number;
  /** "3/5 steps" (compact cards: "3/5"). */
  text: string;
  compactText: string;
  /** "units" when rows are weighted by their unit counts. */
  basis: 'units' | 'rows';
}

export interface RangeCardView {
  kind: TaskRangeKind;
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

function buildNote(state: TaskRangeState, progressPercent: number | null, elapsedShare: number | null): string | null {
  if (state.allStepsDone) return null;
  const workWord = state.progress.basis === 'units' ? 'of the work is' : 'of the steps are';
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
    parts.push(`${steps.done} of ${steps.total} steps done, ${progressPercent}%${unitsNote}.`);
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
  now: Date
): RangeCardView | null {
  const state = taskRangeState(task, checklistRows, now);
  if (!state.range || !state.range.isRange || state.kind === 'closed' || state.kind === 'none') return null;
  const chipText = rangeChipText(state);
  if (!chipText) return null;

  const hasChecklist = state.progress.totalRows > 0;
  const progressPercent = hasChecklist && state.progressFraction !== null ? percent(state.progressFraction) : null;
  const steps: RangeStepsView | null = hasChecklist
    ? {
        done: state.progress.doneRows,
        total: state.progress.totalRows,
        text: `${state.progress.doneRows}/${state.progress.totalRows} steps`,
        compactText: `${state.progress.doneRows}/${state.progress.totalRows}`,
        basis: state.progress.basis === 'units' ? 'units' : 'rows',
      }
    : null;
  const showsElapsed = (state.kind === 'in_range' || state.kind === 'due_today') && state.elapsed !== null && state.elapsed > 0;

  return {
    kind: state.kind,
    chipText,
    tone: toneFor(state.kind),
    fillPercent: progressPercent,
    elapsedPercent: showsElapsed && state.elapsed !== null ? percent(state.elapsed) : null,
    behindPace: state.behindPace,
    steps,
    allStepsDone: state.allStepsDone,
    srText: buildSrText(state, chipText, steps, progressPercent, state.elapsed),
    note: buildNote(state, progressPercent, state.elapsed),
    day: state.day ? { day: state.day.day, of: state.day.of } : null,
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
