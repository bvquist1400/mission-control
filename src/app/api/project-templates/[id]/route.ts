import { NextRequest, NextResponse } from 'next/server';
import { parseTemplateWriteBody, type TemplateWriteBody } from '@/lib/project-template-write';
import { fetchTemplateDetailForUser } from '@/lib/project-templates';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

export async function GET(
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

    const templateDetail = await fetchTemplateDetailForUser(supabase, userId, id);
    if (!templateDetail) {
      return NextResponse.json({ error: 'Project template not found' }, { status: 404 });
    }

    return NextResponse.json(templateDetail);
  } catch (error) {
    console.error('Error fetching project template detail:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(
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
    const body = (await request.json()) as TemplateWriteBody;
    const parsed = parseTemplateWriteBody(body);

    const { data, error } = await supabase.rpc('upsert_project_template', {
      p_user_id: userId,
      p_template_id: id,
      p_name: parsed.name,
      p_description: parsed.description,
      p_default_stage: parsed.defaultStage,
      p_default_rag: parsed.defaultRag,
      p_default_status_summary: parsed.defaultStatusSummary,
      p_is_active: parsed.isActive,
      p_sections: parsed.sections,
      p_tasks: parsed.tasks,
    });

    if (error) {
      const message = error.message || 'Failed to update project template';
      const normalized = message.toLowerCase();
      if (normalized.includes('project template not found')) {
        return NextResponse.json({ error: 'Project template not found' }, { status: 404 });
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row?.template_id) {
      return NextResponse.json({ error: 'Failed to update project template' }, { status: 500 });
    }

    return NextResponse.json({
      template_id: row.template_id,
      section_count: Number(row.section_count ?? 0),
      task_count: Number(row.task_count ?? 0),
      checklist_item_count: Number(row.checklist_item_count ?? 0),
    });
  } catch (error) {
    if (error instanceof Error && error.message) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error updating project template:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
