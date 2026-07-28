import assert from 'node:assert/strict';
import {
  advanceTaskRecurrence,
  buildClearTaskRecurrenceUpdates,
  buildRecurringDueAt,
  buildRecurringInstanceMetadata,
  normalizeTaskRecurrenceInput,
} from '../src/lib/recurrence.ts';

const templateId = '00000000-0000-4000-8000-000000000001';

function recurrence(frequency, nextDue, extras = {}) {
  return {
    enabled: true,
    frequency,
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

assert.deepEqual(buildClearTaskRecurrenceUpdates(false), {
  recurrence: null,
  is_recurring_template: false,
});
assert.deepEqual(buildClearTaskRecurrenceUpdates(true), {
  recurrence: null,
  is_recurring_template: false,
  status: 'Done',
});

console.log('Task recurrence tests passed.');
