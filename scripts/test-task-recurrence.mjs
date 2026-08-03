import assert from 'node:assert/strict';
import {
  advanceTaskRecurrence,
  buildClearTaskRecurrenceUpdates,
  buildRecurringDueAt,
  buildRecurringInstanceMetadata,
  normalizeTaskRecurrenceInput,
} from '../src/lib/recurrence.ts';
import { autoMarkPriorOccurrencesMissed } from '../src/lib/recurring-task-generator.ts';

const templateId = '00000000-0000-4000-8000-000000000001';

function recurrence(frequency, nextDue, extras = {}) {
  return {
    enabled: true,
    frequency,
    auto_mark_missed: false,
    day_of_week: null,
    day_of_month: null,
    next_due: nextDue,
    template_task_id: templateId,
    ...extras,
  };
}

assert.equal(advanceTaskRecurrence(recurrence('daily', '2026-07-28')).next_due, '2026-07-29');
assert.equal(
  advanceTaskRecurrence(recurrence('weekly', '2026-07-28', { day_of_week: 2 })).next_due,
  '2026-08-04'
);

assert.equal(advanceTaskRecurrence(recurrence('weekday', '2026-07-31')).next_due, '2026-08-03');
assert.equal(advanceTaskRecurrence(recurrence('weekday', '2026-08-03')).next_due, '2026-08-04');

const normalizedWeekendWeekday = normalizeTaskRecurrenceInput(
  { frequency: 'weekday', next_due: '2026-08-01' },
  templateId,
  null
);
assert.equal(normalizedWeekendWeekday.error, null);
assert.equal(normalizedWeekendWeekday.recurrence?.next_due, '2026-08-03');
assert.equal(normalizedWeekendWeekday.recurrence?.auto_mark_missed, false);

const normalizedAutoMissed = normalizeTaskRecurrenceInput(
  { frequency: 'daily', next_due: '2026-08-03', auto_mark_missed: true },
  templateId,
  null
);
assert.equal(normalizedAutoMissed.error, null);
assert.equal(normalizedAutoMissed.recurrence?.auto_mark_missed, true);

const preservedAutoMissed = normalizeTaskRecurrenceInput(
  { frequency: 'daily', next_due: '2026-08-04' },
  templateId,
  null,
  normalizedAutoMissed.recurrence
);
assert.equal(preservedAutoMissed.error, null);
assert.equal(preservedAutoMissed.recurrence?.auto_mark_missed, true);

const invalidAutoMissed = normalizeTaskRecurrenceInput(
  { frequency: 'daily', auto_mark_missed: 'yes' },
  templateId,
  null
);
assert.equal(invalidAutoMissed.error, 'auto_mark_missed must be a boolean');

assert.equal(buildRecurringDueAt('2026-07-28'), '2026-07-29T03:59:59.999Z');
assert.equal(buildRecurringDueAt('2026-12-15'), '2026-12-16T04:59:59.999Z');

const instanceMetadata = buildRecurringInstanceMetadata(
  templateId,
  recurrence('daily', '2026-07-28'),
  '2026-07-28'
);
assert.equal(instanceMetadata.recurring_template_id, templateId);
assert.equal(instanceMetadata.is_recurring_template, false);
assert.equal(instanceMetadata.due_at, '2026-07-29T03:59:59.999Z');
assert.equal(instanceMetadata.recurrence.enabled, false);
assert.equal(instanceMetadata.recurrence.template_task_id, templateId);
assert.equal(instanceMetadata.recurrence.next_due, '2026-07-28');
assert.equal(instanceMetadata.recurrence.auto_mark_missed, false);

assert.deepEqual(buildClearTaskRecurrenceUpdates(false), {
  recurrence: null,
  is_recurring_template: false,
});
assert.deepEqual(buildClearTaskRecurrenceUpdates(true), {
  recurrence: null,
  is_recurring_template: false,
  status: 'Done',
});

const autoMissQueries = [];
const autoMissTransitions = [];
const autoMissCandidates = [
  { id: 'occurrence-1', status: 'Backlog' },
  { id: 'occurrence-2', status: 'In Progress' },
];
const autoMissSupabase = {
  from(table) {
    const state = { table, operation: 'select', filters: [] };
    const builder = {
      select() {
        if (state.operation === 'update') {
          autoMissQueries.push({ ...state });
          return Promise.resolve({ data: autoMissCandidates.map(({ id }) => ({ id })), error: null });
        }
        return builder;
      },
      update(values) {
        state.operation = 'update';
        state.values = values;
        return builder;
      },
      insert(values) {
        autoMissTransitions.push(...values);
        return Promise.resolve({ error: null });
      },
      eq(column, value) {
        state.filters.push(['eq', column, value]);
        return builder;
      },
      lt(column, value) {
        state.filters.push(['lt', column, value]);
        return builder;
      },
      in(column, value) {
        state.filters.push(['in', column, value]);
        if (state.operation === 'select' && column === 'status') {
          autoMissQueries.push({ ...state });
          return Promise.resolve({ data: autoMissCandidates, error: null });
        }
        return builder;
      },
    };
    return builder;
  },
};

const autoMissResult = await autoMarkPriorOccurrencesMissed(
  autoMissSupabase,
  { id: templateId, user_id: 'user-1' },
  recurrence('daily', '2026-08-04', { auto_mark_missed: true }),
  '2026-08-03',
  '2026-08-03T04:00:00.000Z'
);
assert.deepEqual(autoMissResult, { count: 2, errors: [] });
assert.deepEqual(autoMissQueries[0].filters, [
  ['eq', 'user_id', 'user-1'],
  ['eq', 'recurring_template_id', templateId],
  ['lt', 'due_at', '2026-08-04T03:59:59.999Z'],
  ['in', 'status', ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting']],
]);
assert.equal(autoMissQueries[1].values.status, 'Missed');
assert.deepEqual(autoMissTransitions.map((row) => [row.task_id, row.from_status, row.to_status]), [
  ['occurrence-1', 'Backlog', 'Missed'],
  ['occurrence-2', 'In Progress', 'Missed'],
]);

console.log('Task recurrence tests passed.');
