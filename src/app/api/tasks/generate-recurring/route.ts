import { NextRequest, NextResponse } from 'next/server';
import {
  advanceTaskRecurrence,
  buildGeneratedTaskRecurrenceMarker,
  buildRecurringDueAt,
  coerceTaskRecurrence,
} from '@/lib/recurrence';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { TaskRecurrence } from '@/types/database';

interface RecurringTaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  implementation_id: string | null;
  project_id: string | null;
  task_type: string;
  priority_score: number;
  estimated_minutes: number;
  estimate_source: string;
  due_at: string | null;
  needs_review: boolean;
  stakeholder_mentions: string[];
  pinned_excerpt: string | null;
  recurrence: unknown;
}

function getTodayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const apiKey = process.env.MISSION_CONTROL_API_KEY;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const providedApiKey = request.headers.get('x-mission-control-key');

  if (cronSecret && bearerToken === cronSecret) {
    return true;
  }

  if (apiKey && providedApiKey === apiKey) {
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
        'id, user_id, title, description, implementation_id, project_id, task_type, priority_score, estimated_minutes, estimate_source, due_at, needs_review, stakeholder_mentions, pinned_excerpt, recurrence'
      )
      .not('recurrence', 'is', null)
      .order('user_id', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    const rows = (data || []) as RecurringTaskRow[];
    const templates: Array<RecurringTaskRow & { normalizedRecurrence: TaskRecurrence }> = [];
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
          const { error: insertError } = await supabase
            .from('tasks')
            .insert({
              user_id: template.user_id,
              title: template.title,
              description: template.description,
              implementation_id: template.implementation_id,
              project_id: template.project_id,
              sprint_id: null,
              status: 'Backlog',
              task_type: template.task_type,
              priority_score: template.priority_score,
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
              recurrence: buildGeneratedTaskRecurrenceMarker(recurrence, recurrence.next_due),
            });

          if (insertError) {
            errors.push(`Failed to generate ${template.id} for ${recurrence.next_due}: ${insertError.message}`);
            break;
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
        .update({ recurrence })
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
