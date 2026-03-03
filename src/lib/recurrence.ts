import type { TaskRecurrence, TaskRecurrenceFrequency } from '@/types/database';

export const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

export type RecurrenceFrequency = TaskRecurrenceFrequency;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_REGEX.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isFinite(candidate.getTime()) &&
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractDateOnly(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const candidate = value.slice(0, 10);
  return isValidDateOnly(candidate) ? candidate : null;
}

function addDays(value: string, days: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function daysInMonth(year: number, monthZeroIndexed: number): number {
  return new Date(Date.UTC(year, monthZeroIndexed + 1, 0)).getUTCDate();
}

function addMonthsClamped(value: string, months: number, preferredDay: number | null): string {
  const current = parseDateOnly(value);
  let year = current.getUTCFullYear();
  let month = current.getUTCMonth() + months;

  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;

  const day = Math.max(1, Math.min(preferredDay ?? current.getUTCDate(), daysInMonth(year, month)));
  return formatDateOnly(new Date(Date.UTC(year, month, day)));
}

export function coerceTaskRecurrence(value: unknown): TaskRecurrence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const enabled = typeof candidate.enabled === 'boolean' ? candidate.enabled : null;
  const frequency = typeof candidate.frequency === 'string' ? candidate.frequency : null;
  const dayOfWeek = candidate.day_of_week;
  const dayOfMonth = candidate.day_of_month;
  const nextDue = typeof candidate.next_due === 'string' ? candidate.next_due : null;
  const templateTaskId = candidate.template_task_id;

  if (enabled === null || !frequency || !RECURRENCE_FREQUENCIES.includes(frequency as RecurrenceFrequency) || !nextDue) {
    return null;
  }

  if (!isValidDateOnly(nextDue)) {
    return null;
  }

  const normalizedDayOfWeek =
    dayOfWeek === null || dayOfWeek === undefined
      ? null
      : typeof dayOfWeek === 'number' && Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6
        ? dayOfWeek
        : null;
  const normalizedDayOfMonth =
    dayOfMonth === null || dayOfMonth === undefined
      ? null
      : typeof dayOfMonth === 'number' && Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31
        ? dayOfMonth
        : null;

  if ((frequency === 'weekly' || frequency === 'biweekly') && normalizedDayOfWeek === null) {
    return null;
  }

  if (frequency === 'monthly' && normalizedDayOfMonth === null) {
    return null;
  }

  return {
    enabled,
    frequency: frequency as RecurrenceFrequency,
    day_of_week: normalizedDayOfWeek,
    day_of_month: normalizedDayOfMonth,
    next_due: nextDue,
    template_task_id: typeof templateTaskId === 'string' && templateTaskId.trim().length > 0 ? templateTaskId : null,
  };
}

function inferAnchorDate(taskDueAt: string | null, providedNextDue: string | null): string {
  const taskDate = extractDateOnly(taskDueAt);
  if (providedNextDue) {
    return providedNextDue;
  }

  if (taskDate) {
    return taskDate;
  }

  return formatDateOnly(new Date());
}

export function normalizeTaskRecurrenceInput(
  input: unknown,
  taskId: string,
  taskDueAt: string | null
): { recurrence: TaskRecurrence | null; error: string | null } {
  if (input === null) {
    return { recurrence: null, error: null };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { recurrence: null, error: 'recurrence must be an object or null' };
  }

  const body = input as Record<string, unknown>;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  if (!enabled) {
    return { recurrence: null, error: null };
  }

  if (typeof body.frequency !== 'string' || !RECURRENCE_FREQUENCIES.includes(body.frequency as RecurrenceFrequency)) {
    return {
      recurrence: null,
      error: `frequency must be one of: ${RECURRENCE_FREQUENCIES.join(', ')}`,
    };
  }

  const frequency = body.frequency as RecurrenceFrequency;
  const requestedNextDue =
    typeof body.next_due === 'string' && body.next_due.trim().length > 0 ? body.next_due.trim() : null;

  if (requestedNextDue && !isValidDateOnly(requestedNextDue)) {
    return { recurrence: null, error: 'next_due must be YYYY-MM-DD' };
  }

  const anchorDate = inferAnchorDate(taskDueAt, requestedNextDue);
  const anchor = parseDateOnly(anchorDate);
  let dayOfWeek: number | null = null;
  let dayOfMonth: number | null = null;

  if (frequency === 'weekly' || frequency === 'biweekly') {
    if (body.day_of_week !== undefined && body.day_of_week !== null) {
      if (
        typeof body.day_of_week !== 'number' ||
        !Number.isInteger(body.day_of_week) ||
        body.day_of_week < 0 ||
        body.day_of_week > 6
      ) {
        return { recurrence: null, error: 'day_of_week must be an integer from 0-6' };
      }

      dayOfWeek = body.day_of_week;
    } else {
      dayOfWeek = anchor.getUTCDay();
    }
  }

  if (frequency === 'monthly') {
    if (body.day_of_month !== undefined && body.day_of_month !== null) {
      if (
        typeof body.day_of_month !== 'number' ||
        !Number.isInteger(body.day_of_month) ||
        body.day_of_month < 1 ||
        body.day_of_month > 31
      ) {
        return { recurrence: null, error: 'day_of_month must be an integer from 1-31' };
      }

      dayOfMonth = body.day_of_month;
    } else {
      dayOfMonth = anchor.getUTCDate();
    }
  }

  return {
    recurrence: {
      enabled: true,
      frequency,
      day_of_week: dayOfWeek,
      day_of_month: dayOfMonth,
      next_due: anchorDate,
      template_task_id: taskId,
    },
    error: null,
  };
}

export function advanceTaskRecurrence(recurrence: TaskRecurrence): TaskRecurrence {
  let nextDue = recurrence.next_due;

  if (recurrence.frequency === 'daily') {
    nextDue = addDays(recurrence.next_due, 1);
  } else if (recurrence.frequency === 'weekly') {
    nextDue = addDays(recurrence.next_due, 7);
  } else if (recurrence.frequency === 'biweekly') {
    nextDue = addDays(recurrence.next_due, 14);
  } else {
    nextDue = addMonthsClamped(recurrence.next_due, 1, recurrence.day_of_month);
  }

  return {
    ...recurrence,
    next_due: nextDue,
  };
}

export function buildGeneratedTaskRecurrenceMarker(template: TaskRecurrence, scheduledDate: string): TaskRecurrence {
  return {
    ...template,
    enabled: false,
    next_due: scheduledDate,
  };
}

export function buildRecurringDueAt(taskDueAt: string | null, scheduledDate: string): string | null {
  const [year, month, day] = scheduledDate.split('-').map((part) => Number.parseInt(part, 10));

  if (!taskDueAt) {
    return null;
  }

  const sourceDate = new Date(taskDueAt);
  if (!Number.isFinite(sourceDate.getTime())) {
    return null;
  }

  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      sourceDate.getUTCHours(),
      sourceDate.getUTCMinutes(),
      sourceDate.getUTCSeconds(),
      sourceDate.getUTCMilliseconds()
    )
  ).toISOString();
}
