import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { parseTemplateWriteBody, type TemplateWriteBody } from '@/lib/project-template-write';

interface ProjectTemplateRow {
  id: string;
  name: string;
  description: string | null;
  default_stage: string;
  default_rag: string;
  default_status_summary: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ProjectTemplateSectionCountRow {
  template_id: string;
}

interface ProjectTemplateTaskCountRow {
  template_id: string;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    const { data: templates, error: templateError } = await supabase
      .from('project_templates')
      .select('id, name, description, default_stage, default_rag, default_status_summary, is_active, created_at, updated_at')
      .eq('user_id', userId)
      .order('is_active', { ascending: false })
      .order('updated_at', { ascending: false })
      .order('name', { ascending: true });

    if (templateError) {
      throw templateError;
    }

    const templateRows = (templates ?? []) as ProjectTemplateRow[];
    if (templateRows.length === 0) {
      return NextResponse.json([]);
    }

    const templateIds = templateRows.map((template) => template.id);

    const [{ data: sectionRows, error: sectionError }, { data: taskRows, error: taskError }] = await Promise.all([
      supabase
        .from('project_template_sections')
        .select('template_id')
        .eq('user_id', userId)
        .in('template_id', templateIds),
      supabase
        .from('project_template_tasks')
        .select('template_id')
        .eq('user_id', userId)
        .in('template_id', templateIds),
    ]);

    if (sectionError) {
      throw sectionError;
    }
    if (taskError) {
      throw taskError;
    }

    const sectionCounts = new Map<string, number>();
    for (const row of (sectionRows ?? []) as ProjectTemplateSectionCountRow[]) {
      sectionCounts.set(row.template_id, (sectionCounts.get(row.template_id) ?? 0) + 1);
    }

    const taskCounts = new Map<string, number>();
    for (const row of (taskRows ?? []) as ProjectTemplateTaskCountRow[]) {
      taskCounts.set(row.template_id, (taskCounts.get(row.template_id) ?? 0) + 1);
    }

    const response = templateRows.map((template) => ({
      ...template,
      section_count: sectionCounts.get(template.id) ?? 0,
      task_count: taskCounts.get(template.id) ?? 0,
    }));

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching project templates:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as TemplateWriteBody;
    const parsed = parseTemplateWriteBody(body);

    const { data, error } = await supabase.rpc('upsert_project_template', {
      p_user_id: userId,
      p_template_id: null,
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
      const message = error.message || 'Failed to create project template';
      if (message.toLowerCase().includes('template name is required')) {
        return NextResponse.json({ error: 'Template name is required' }, { status: 400 });
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row?.template_id) {
      return NextResponse.json({ error: 'Failed to create project template' }, { status: 500 });
    }

    return NextResponse.json({
      template_id: row.template_id,
      section_count: Number(row.section_count ?? 0),
      task_count: Number(row.task_count ?? 0),
      checklist_item_count: Number(row.checklist_item_count ?? 0),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Error creating project template:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
