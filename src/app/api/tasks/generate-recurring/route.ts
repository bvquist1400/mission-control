import { NextRequest, NextResponse } from 'next/server';
import {
  advanceTaskRecurrence,
  buildGeneratedTaskRecurrenceMarker,
  buildRecurringDueAt,
  coerceTaskRecurrence,
} from '@/lib/recurrence';
import { getDateOnlyInTimeZone } from '@/lib/date-only';
import { secureCompare } from '@/lib/secure-compare';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readInternalAuthContext } from '@/lib/supabase/internal-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';
import type { EstimateSource, TaskRecurrence, TaskType } from '@/types/database';
import type { Json } from '@/types/supabase.generated';

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
  due_at: string | null;
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

function getTodayDateOnly(): string {
  // "Today" must match the app's ET day boundary (sync-today, briefs), not UTC.
  return getDateOnlyInTimeZone(DEFAULT_WORKDAY_CONFIG.timezone);
}

function isAuthorized(request: NextRequest): boolean {
  if (readInternalAuthContext(request)) {
    return true;
  }

  const cronSecret = process.env.CRON_SECRET;
  const apiKey = process.env.MISSION_CONTROL_API_KEY;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const providedApiKey = request.headers.get('x-mission-control-key');

  if (cronSecret && secureCompare(bearerToken, cronSecret)) {
    return true;
  }

  if (apiKey && secureCompare(providedApiKey, apiKey)) {
    return true;
  }

  return false;
}

async function runGeneration(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const today = getTodayDateOnly();
    const { data, error } = await supabase
      .from('tasks')
      .select(
        'id, user_id, title, description, implementation_id, project_id, task_type, priority_score, base_priority, estimated_minutes, estimate_source, due_at, needs_review, stakeholder_mentions, pinned_excerpt, recurrence'
      )
      .not('recurrence', 'is', null)
      .order('user_id', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    const rows = (data || []) as RecurringTaskRow[];
    const templates: Array<RecurringTaskRow & { normalizedRecurrence: TaskRecurrence }> = [];
    const checklistItemsByTemplateId = new Map<string, TemplateChecklistItemRow[]>();
    const existingInstanceKeys = new Set<string>();
    let skippedInvalid = 0;

    for (const row of rows) {
      const recurrence = coerceTaskRecurrence(row.recurrence);
      if (!recurrence || !recurrence.template_task_id) {
        skippedInvalid += 1;
        continue;
      }

      if (!recurrence.enabled) {
        existingInstanceKeys.add(`${recurrence.template_task_id}:${recurrence.next_due}`);
        continue;
      }

      if (recurrence.template_task_id !== row.id) {
        skippedInvalid += 1;
        continue;
      }

      templates.push({ ...row, normalizedRecurrence: recurrence });
    }

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
        const existingItems = checklistItemsByTemplateId.get(checklistItem.task_id);
        if (existingItems) {
          existingItems.push(checklistItem);
          continue;
        }

        checklistItemsByTemplateId.set(checklistItem.task_id, [checklistItem]);
      }
    }

    let createdTasks = 0;
    let advancedTemplates = 0;
    let skippedExisting = 0;
    const errors: string[] = [];

    for (const template of templates) {
      let recurrence = template.normalizedRecurrence;
      let templateChanged = false;

      // Catch up missed occurrences one at a time so a missed cron run still backfills.
      while (recurrence.next_due <= today) {
        const instanceKey = `${template.id}:${recurrence.next_due}`;

        if (existingInstanceKeys.has(instanceKey)) {
          skippedExisting += 1;
        } else {
          const { data: createdTask, error: insertError } = await supabase
            .from('tasks')
            .insert({
              user_id: template.user_id,
              title: template.title,
              description: template.description,
              implementation_id: template.implementation_id,
              project_id: template.project_id,
              // V1 intentionally leaves automated recurring task instances unsectioned.
              section_id: null,
              sprint_id: null,
              status: 'Backlog',
              task_type: template.task_type,
              priority_score: template.priority_score,
              base_priority: template.base_priority ?? template.priority_score,
              estimated_minutes: template.estimated_minutes,
              estimate_source: template.estimate_source,
              due_at: buildRecurringDueAt(template.due_at, recurrence.next_due),
              needs_review: template.needs_review,
              blocker: false,
              waiting_on: null,
              follow_up_at: null,
              stakeholder_mentions: template.stakeholder_mentions,
              source_type: 'Recurring',
              source_url: null,
              pinned_excerpt: template.pinned_excerpt,
              pinned: false,
              recurrence: buildGeneratedTaskRecurrenceMarker(recurrence, recurrence.next_due) as unknown as Json,
            })
            .select('id')
            .single();

          if (insertError) {
            errors.push(`Failed to generate ${template.id} for ${recurrence.next_due}: ${insertError.message}`);
            break;
          }

          const templateChecklistItems = checklistItemsByTemplateId.get(template.id) || [];
          if (templateChecklistItems.length > 0) {
            const { error: checklistInsertError } = await supabase.from('task_checklist_items').insert(
              templateChecklistItems.map((checklistItem) => ({
                user_id: template.user_id,
                task_id: (createdTask as CreatedTaskRow).id,
                text: checklistItem.text,
                is_done: false,
                sort_order: checklistItem.sort_order,
              }))
            );

            if (checklistInsertError) {
              const { error: rollbackError } = await supabase
                .from('tasks')
                .delete()
                .eq('id', (createdTask as CreatedTaskRow).id)
                .eq('user_id', template.user_id);

              if (rollbackError) {
                errors.push(
                  `Failed to rollback ${template.id} for ${recurrence.next_due} after checklist copy error: ${rollbackError.message}`
                );
              }

              errors.push(
                `Failed to clone checklist for ${template.id} on ${recurrence.next_due}: ${checklistInsertError.message}`
              );
              break;
            }
          }

          existingInstanceKeys.add(instanceKey);
          createdTasks += 1;
        }

        recurrence = advanceTaskRecurrence(recurrence);
        templateChanged = true;
      }

      if (!templateChanged) {
        continue;
      }

      const { error: updateError } = await supabase
        .from('tasks')
        .update({ recurrence: recurrence as unknown as Json })
        .eq('id', template.id)
        .eq('user_id', template.user_id);

      if (updateError) {
        errors.push(`Failed to advance template ${template.id}: ${updateError.message}`);
        continue;
      }

      advancedTemplates += 1;
    }

    return NextResponse.json({
      run_at: new Date().toISOString(),
      processed_templates: templates.length,
      created_tasks: createdTasks,
      advanced_templates: advancedTemplates,
      skipped_existing: skippedExisting,
      skipped_invalid: skippedInvalid,
      errors,
    });
  } catch (error) {
    console.error('Error generating recurring tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/tasks/generate-recurring - Trigger daily recurring task generation
export async function GET(request: NextRequest) {
  return runGeneration(request);
}

// POST /api/tasks/generate-recurring - Manual trigger for the same generator
export async function POST(request: NextRequest) {
  return runGeneration(request);
}
