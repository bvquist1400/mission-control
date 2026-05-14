import { NextRequest, NextResponse } from 'next/server';
import {
  fetchTemplateDetailForUser,
  isIsoDate,
  normalizeOptionalText,
  normalizeOptionalUuid,
  resolveDueFromKickoff,
  type ProjectTemplateTaskRecord,
} from '@/lib/project-templates';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface PreviewRequestBody {
  kickoff_date?: unknown;
  project_name?: unknown;
  implementation_id?: unknown;
}

interface OrderedTemplateTask extends ProjectTemplateTaskRecord {
  section_name: string | null;
  section_sort_order: number | null;
}

function toOrderedTemplateTasks(
  sectionedTasks: Array<{ section_name: string; section_sort_order: number; task: ProjectTemplateTaskRecord }>,
  unsectionedTasks: ProjectTemplateTaskRecord[]
): OrderedTemplateTask[] {
  const orderedSectioned = sectionedTasks
    .sort((a, b) => {
      if (a.section_sort_order !== b.section_sort_order) {
        return a.section_sort_order - b.section_sort_order;
      }
      if (a.task.sort_order !== b.task.sort_order) {
        return a.task.sort_order - b.task.sort_order;
      }
      return a.task.created_at.localeCompare(b.task.created_at);
    })
    .map(({ section_name, section_sort_order, task }) => ({
      ...task,
      section_name,
      section_sort_order,
    }));

  const orderedUnsectioned = [...unsectionedTasks]
    .sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return a.created_at.localeCompare(b.created_at);
    })
    .map((task) => ({
      ...task,
      section_name: null,
      section_sort_order: null,
    }));

  return [...orderedSectioned, ...orderedUnsectioned];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const body = (await request.json()) as PreviewRequestBody;
    if (typeof body.kickoff_date !== 'string' || !isIsoDate(body.kickoff_date)) {
      return NextResponse.json({ error: 'kickoff_date is required in YYYY-MM-DD format' }, { status: 400 });
    }

    const kickoffDate = body.kickoff_date;
    const projectName = normalizeOptionalText(body.project_name);
    const implementationId = normalizeOptionalUuid(body.implementation_id);

    if (projectName && projectName.length > 200) {
      return NextResponse.json({ error: 'project_name must be 200 characters or fewer' }, { status: 400 });
    }

    const templateDetail = await fetchTemplateDetailForUser(supabase, userId, id);
    if (!templateDetail) {
      return NextResponse.json({ error: 'Project template not found' }, { status: 404 });
    }

    let implementation: { id: string; name: string } | null = null;
    if (implementationId) {
      const { data: impl, error: implError } = await supabase
        .from('implementations')
        .select('id, name')
        .eq('id', implementationId)
        .eq('user_id', userId)
        .maybeSingle();

      if (implError) {
        throw implError;
      }

      if (!impl) {
        return NextResponse.json({ error: 'Implementation not found' }, { status: 400 });
      }

      implementation = { id: impl.id, name: impl.name };
    }

    const sectionedTasks = templateDetail.sections.flatMap((section) =>
      section.tasks.map((task) => ({ section_name: section.name, section_sort_order: section.sort_order, task }))
    );
    const orderedTasks = toOrderedTemplateTasks(sectionedTasks, templateDetail.unsectioned_tasks);

    let checklistItemCount = 0;

    const resolvedTasks = orderedTasks.map((task) => {
      const resolvedDue = resolveDueFromKickoff(kickoffDate, task.relative_due_days);
      const cleanedChecklistItems = (task.checklist_items || [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      checklistItemCount += cleanedChecklistItems.length;

      return {
        ...task,
        checklist_items: cleanedChecklistItems,
        resolved_due_date: resolvedDue.due_date,
        resolved_due_at: resolvedDue.due_at,
      };
    });

    return NextResponse.json({
      template_id: templateDetail.id,
      kickoff_date: kickoffDate,
      project: {
        name: projectName ?? templateDetail.name,
        description: templateDetail.description,
        stage: templateDetail.default_stage,
        rag: templateDetail.default_rag,
        status_summary: templateDetail.default_status_summary,
        implementation,
      },
      sections: templateDetail.sections.map((section) => ({
        id: section.id,
        name: section.name,
        sort_order: section.sort_order,
      })),
      tasks: resolvedTasks,
      summary: {
        section_count: templateDetail.sections.length,
        task_count: resolvedTasks.length,
        checklist_item_count: checklistItemCount,
      },
    });
  } catch (error) {
    console.error('Error previewing project template instantiation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
