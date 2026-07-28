import { NextRequest, NextResponse } from 'next/server';
import { getDateOnlyInTimeZone } from '@/lib/date-only';
import { RECURRING_TASK_GENERATION_POLICY } from '@/lib/recurring-task-generator';
import {
  normalizeTaskWithRelationsList,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

interface RecurringInstanceRecord {
  scheduled_date: string;
  task: ReturnType<typeof normalizeTaskWithRelationsList>[number];
}

// GET /api/tasks/recurring - Active templates with today's and latest instance.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const implementationId = searchParams.get('implementation_id');
    const projectId = searchParams.get('project_id');
    const today = getDateOnlyInTimeZone(DEFAULT_WORKDAY_CONFIG.timezone);

    let templatesQuery = supabase
      .from('tasks')
      .select(TASK_WITH_RELATIONS_SELECT)
      .eq('user_id', userId)
      .eq('is_recurring_template', true)
      .not('recurrence', 'is', null)
      .order('title', { ascending: true })
      .order('id', { ascending: true });

    if (implementationId) {
      templatesQuery = templatesQuery.eq('implementation_id', implementationId);
    }

    if (projectId) {
      templatesQuery = templatesQuery.eq('project_id', projectId);
    }

    const { data: templateData, error: templateError } = await templatesQuery;
    if (templateError) {
      throw templateError;
    }

    const templates = normalizeTaskWithRelationsList(
      (templateData || []) as Array<Record<string, unknown>>
    );
    if (templates.length === 0) {
      return NextResponse.json({
        as_of_date: today,
        generation_policy: RECURRING_TASK_GENERATION_POLICY,
        recurring_tasks: [],
      });
    }

    const templateIds = templates.map((template) => template.id);
    const { data: instanceData, error: instanceError } = await supabase
      .from('tasks')
      .select(TASK_WITH_RELATIONS_SELECT)
      .eq('user_id', userId)
      .in('recurring_template_id', templateIds)
      .eq('is_recurring_template', false)
      .order('due_at', { ascending: false })
      .order('created_at', { ascending: false });

    if (instanceError) {
      throw instanceError;
    }

    const instancesByTemplateId = new Map<string, RecurringInstanceRecord[]>();
    for (const task of normalizeTaskWithRelationsList(
      (instanceData || []) as Array<Record<string, unknown>>
    )) {
      const templateId = task.recurring_template_id;
      const scheduledDate = task.recurrence?.next_due;
      if (!templateId || !scheduledDate) {
        continue;
      }

      const records = instancesByTemplateId.get(templateId) ?? [];
      records.push({ scheduled_date: scheduledDate, task });
      instancesByTemplateId.set(templateId, records);
    }

    for (const records of instancesByTemplateId.values()) {
      records.sort((left, right) => right.scheduled_date.localeCompare(left.scheduled_date));
    }

    return NextResponse.json({
      as_of_date: today,
      generation_policy: RECURRING_TASK_GENERATION_POLICY,
      recurring_tasks: templates.map((template) => {
        const instanceRecords = instancesByTemplateId.get(template.id) ?? [];
        const latestRecord = instanceRecords[0] ?? null;
        const currentRecord = instanceRecords.find((instance) => instance.scheduled_date === today) ?? null;

        return {
          template,
          current_instance: currentRecord?.task ?? null,
          current_scheduled_date: currentRecord?.scheduled_date ?? null,
          latest_instance: latestRecord?.task ?? null,
          latest_scheduled_date: latestRecord?.scheduled_date ?? null,
        };
      }),
    });
  } catch (error) {
    console.error('Error fetching recurring tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
