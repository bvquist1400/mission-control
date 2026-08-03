import type { SupabaseClient } from '@supabase/supabase-js';
import {
  advanceTaskRecurrence,
  buildRecurringDueAt,
  buildRecurringInstanceMetadata,
  coerceTaskRecurrence,
} from '@/lib/recurrence';
import { getDateOnlyInTimeZone } from '@/lib/date-only';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';
import type { EstimateSource, TaskRecurrence, TaskStatus, TaskType } from '@/types/database';
import type { Json } from '@/types/supabase.generated';

export const RECURRING_TASK_GENERATION_POLICY = {
  timezone: DEFAULT_WORKDAY_CONFIG.timezone,
  cron_schedule_utc: '0 4,5 * * *',
  first_due_run_local: '00:00 America/New_York',
  confirmation_run_local: '01:00 during EDT; the prior 04:00 UTC run is 23:00 during EST',
  eager_when_configured_for_today: true,
  catches_up_missed_dates: true,
  auto_mark_missed_is_opt_in: true,
} as const;

const AUTO_MISSABLE_STATUSES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting'];

interface RecurringTaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  implementation_id: string | null;
  project_id: string | null;
  task_type: TaskType;
  priority_score: number;
  base_priority: number;
  estimated_minutes: number;
  estimate_source: EstimateSource;
  needs_review: boolean;
  stakeholder_mentions: string[];
  pinned_excerpt: string | null;
  recurrence: unknown;
}

interface TemplateChecklistItemRow {
  task_id: string;
  text: string;
  sort_order: number;
}

interface CreatedTaskRow {
  id: string;
}

interface ClaimedInstanceRow {
  id: string;
}

interface LatestClaimRow {
  task_id: string | null;
  created_at: string;
}

interface AutoMissableTaskRow {
  id: string;
  status: TaskStatus;
}

export interface GenerateRecurringTasksOptions {
  userId?: string;
  templateTaskId?: string;
  today?: string;
  now?: Date;
}

export interface GenerateRecurringTasksResult {
  run_at: string;
  scheduled_through: string;
  generation_policy: typeof RECURRING_TASK_GENERATION_POLICY;
  processed_templates: number;
  created_tasks: number;
  advanced_templates: number;
  skipped_existing: number;
  skipped_invalid: number;
  auto_missed_tasks: number;
  errors: string[];
}

export async function autoMarkPriorOccurrencesMissed(
  supabase: SupabaseClient,
  template: RecurringTaskRow,
  recurrence: TaskRecurrence,
  today: string,
  transitionedAt: string
): Promise<{ count: number; errors: string[] }> {
  if (!recurrence.auto_mark_missed) {
    return { count: 0, errors: [] };
  }

  const cutoffDueAt = buildRecurringDueAt(today);
  const { data: candidates, error: candidateError } = await supabase
    .from('tasks')
    .select('id, status')
    .eq('user_id', template.user_id)
    .eq('recurring_template_id', template.id)
    .lt('due_at', cutoffDueAt)
    .in('status', AUTO_MISSABLE_STATUSES);

  if (candidateError) {
    return {
      count: 0,
      errors: [`Failed to find prior open instances for ${template.id}: ${candidateError.message}`],
    };
  }

  const rows = (candidates || []) as AutoMissableTaskRow[];
  if (rows.length === 0) {
    return { count: 0, errors: [] };
  }

  const previousStatusById = new Map(rows.map((row) => [row.id, row.status]));
  const { data: updatedRows, error: updateError } = await supabase
    .from('tasks')
    .update({ status: 'Missed' })
    .eq('user_id', template.user_id)
    .eq('recurring_template_id', template.id)
    .in('id', rows.map((row) => row.id))
    .in('status', AUTO_MISSABLE_STATUSES)
    .select('id');

  if (updateError) {
    return {
      count: 0,
      errors: [`Failed to mark prior instances Missed for ${template.id}: ${updateError.message}`],
    };
  }

  const updatedIds = (updatedRows || []).map((row) => row.id);
  if (updatedIds.length === 0) {
    return { count: 0, errors: [] };
  }

  const { error: transitionError } = await supabase
    .from('task_status_transitions')
    .insert(updatedIds.map((taskId) => ({
      user_id: template.user_id,
      task_id: taskId,
      from_status: previousStatusById.get(taskId) ?? null,
      to_status: 'Missed',
      transitioned_at: transitionedAt,
    })));

  return {
    count: updatedIds.length,
    errors: transitionError
      ? [`Marked prior instances Missed for ${template.id}, but failed to record transitions: ${transitionError.message}`]
      : [],
  };
}

export async function generateRecurringTasks(
  supabase: SupabaseClient,
  options: GenerateRecurringTasksOptions = {}
): Promise<GenerateRecurringTasksResult> {
  const runAt = options.now ?? new Date();
  const today = options.today ?? getDateOnlyInTimeZone(DEFAULT_WORKDAY_CONFIG.timezone, runAt);
  let templatesQuery = supabase
    .from('tasks')
    .select(
      'id, user_id, title, description, implementation_id, project_id, task_type, priority_score, base_priority, estimated_minutes, estimate_source, needs_review, stakeholder_mentions, pinned_excerpt, recurrence'
    )
    .eq('is_recurring_template', true)
    .not('recurrence', 'is', null)
    .order('user_id', { ascending: true })
    .order('created_at', { ascending: true });

  if (options.userId) {
    templatesQuery = templatesQuery.eq('user_id', options.userId);
  }

  if (options.templateTaskId) {
    templatesQuery = templatesQuery.eq('id', options.templateTaskId);
  }

  const { data, error } = await templatesQuery;
  if (error) {
    throw error;
  }

  const templates: Array<RecurringTaskRow & { normalizedRecurrence: TaskRecurrence }> = [];
  let skippedInvalid = 0;

  for (const row of (data || []) as RecurringTaskRow[]) {
    const recurrence = coerceTaskRecurrence(row.recurrence);
    if (!recurrence?.enabled || recurrence.template_task_id !== row.id) {
      skippedInvalid += 1;
      continue;
    }

    templates.push({ ...row, normalizedRecurrence: recurrence });
  }

  const checklistItemsByTemplateId = new Map<string, TemplateChecklistItemRow[]>();
  if (templates.length > 0) {
    const { data: checklistData, error: checklistError } = await supabase
      .from('task_checklist_items')
      .select('task_id, text, sort_order')
      .in('task_id', templates.map((template) => template.id))
      .order('sort_order', { ascending: true });

    if (checklistError) {
      throw checklistError;
    }

    for (const checklistItem of (checklistData || []) as TemplateChecklistItemRow[]) {
      const items = checklistItemsByTemplateId.get(checklistItem.task_id) ?? [];
      items.push(checklistItem);
      checklistItemsByTemplateId.set(checklistItem.task_id, items);
    }
  }

  let createdTasks = 0;
  let advancedTemplates = 0;
  let skippedExisting = 0;
  let autoMissedTasks = 0;
  const errors: string[] = [];

  for (const template of templates) {
    let recurrence = template.normalizedRecurrence;
    let templateChanged = false;

    // Backfill missed dates in order. The claim table's unique constraint is
    // the authority that prevents duplicate generation across overlapping runs.
    while (recurrence.next_due <= today) {
      const scheduledDate = recurrence.next_due;
      const { data: claimedInstance, error: claimError } = await supabase
        .from('recurring_instances')
        .upsert(
          {
            user_id: template.user_id,
            template_task_id: template.id,
            scheduled_date: scheduledDate,
          },
          { onConflict: 'template_task_id,scheduled_date', ignoreDuplicates: true }
        )
        .select('id');

      if (claimError) {
        errors.push(`Failed to claim ${template.id} for ${scheduledDate}: ${claimError.message}`);
        break;
      }

      const claim = (claimedInstance || [])[0] as ClaimedInstanceRow | undefined;
      if (!claim) {
        skippedExisting += 1;
        recurrence = advanceTaskRecurrence(recurrence);
        templateChanged = true;
        continue;
      }

      const instanceMetadata = buildRecurringInstanceMetadata(template.id, recurrence, scheduledDate);
      const { data: createdTask, error: insertError } = await supabase
        .from('tasks')
        .insert({
          user_id: template.user_id,
          title: template.title,
          description: template.description,
          implementation_id: template.implementation_id,
          project_id: template.project_id,
          section_id: null,
          sprint_id: null,
          status: 'Backlog',
          task_type: template.task_type,
          priority_score: template.priority_score,
          base_priority: template.base_priority ?? template.priority_score,
          estimated_minutes: template.estimated_minutes,
          estimate_source: template.estimate_source,
          needs_review: template.needs_review,
          blocker: false,
          waiting_on: null,
          follow_up_at: null,
          stakeholder_mentions: template.stakeholder_mentions,
          source_type: 'Recurring',
          source_url: null,
          pinned_excerpt: template.pinned_excerpt,
          pinned: false,
          ...instanceMetadata,
          recurrence: instanceMetadata.recurrence as unknown as Json,
        })
        .select('id')
        .single();

      if (insertError) {
        errors.push(`Failed to generate ${template.id} for ${scheduledDate}: ${insertError.message}`);
        await supabase.from('recurring_instances').delete().eq('id', claim.id);
        break;
      }

      const createdTaskId = (createdTask as CreatedTaskRow).id;
      const templateChecklistItems = checklistItemsByTemplateId.get(template.id) ?? [];
      if (templateChecklistItems.length > 0) {
        const { error: checklistInsertError } = await supabase.from('task_checklist_items').insert(
          templateChecklistItems.map((checklistItem) => ({
            user_id: template.user_id,
            task_id: createdTaskId,
            text: checklistItem.text,
            is_done: false,
            sort_order: checklistItem.sort_order,
          }))
        );

        if (checklistInsertError) {
          const { error: rollbackError } = await supabase
            .from('tasks')
            .delete()
            .eq('id', createdTaskId)
            .eq('user_id', template.user_id);

          if (rollbackError) {
            errors.push(
              `Failed to rollback ${template.id} for ${scheduledDate} after checklist copy error: ${rollbackError.message}`
            );
          }

          await supabase.from('recurring_instances').delete().eq('id', claim.id);
          errors.push(`Failed to clone checklist for ${template.id} on ${scheduledDate}: ${checklistInsertError.message}`);
          break;
        }
      }

      const { error: claimUpdateError } = await supabase
        .from('recurring_instances')
        .update({ task_id: createdTaskId })
        .eq('id', claim.id);

      if (claimUpdateError) {
        errors.push(
          `Failed to link claim to task ${createdTaskId} for ${template.id} on ${scheduledDate}: ${claimUpdateError.message}`
        );
      }

      createdTasks += 1;
      recurrence = advanceTaskRecurrence(recurrence);
      templateChanged = true;
    }

    const autoMissResult = await autoMarkPriorOccurrencesMissed(
      supabase,
      template,
      recurrence,
      today,
      runAt.toISOString()
    );
    autoMissedTasks += autoMissResult.count;
    errors.push(...autoMissResult.errors);

    if (!templateChanged) {
      continue;
    }

    const { data: latestClaim, error: latestClaimError } = await supabase
      .from('recurring_instances')
      .select('task_id, created_at')
      .eq('user_id', template.user_id)
      .eq('template_task_id', template.id)
      .not('task_id', 'is', null)
      .order('scheduled_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestClaimError) {
      errors.push(`Failed to read latest instance for ${template.id}: ${latestClaimError.message}`);
    }

    const latest = latestClaim as LatestClaimRow | null;
    const { error: updateError } = await supabase
      .from('tasks')
      .update({
        recurrence: recurrence as unknown as Json,
        ...(latest?.task_id
          ? {
              latest_instance_id: latest.task_id,
              last_generated_at: latest.created_at,
            }
          : {}),
      })
      .eq('id', template.id)
      .eq('user_id', template.user_id);

    if (updateError) {
      errors.push(`Failed to advance template ${template.id}: ${updateError.message}`);
      continue;
    }

    advancedTemplates += 1;
  }

  return {
    run_at: runAt.toISOString(),
    scheduled_through: today,
    generation_policy: RECURRING_TASK_GENERATION_POLICY,
    processed_templates: templates.length,
    created_tasks: createdTasks,
    advanced_templates: advancedTemplates,
    skipped_existing: skippedExisting,
    skipped_invalid: skippedInvalid,
    auto_missed_tasks: autoMissedTasks,
    errors,
  };
}
