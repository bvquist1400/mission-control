import { NextRequest, NextResponse } from 'next/server';
import { isIsoDate, normalizeOptionalText, normalizeOptionalUuid } from '@/lib/project-templates';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface InstantiateRequestBody {
  kickoff_date?: unknown;
  project_name?: unknown;
  implementation_id?: unknown;
}

interface InstantiateRpcRow {
  project_id: string;
  created_sections: number;
  created_tasks: number;
  created_checklist_items: number;
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

    const body = (await request.json()) as InstantiateRequestBody;
    if (typeof body.kickoff_date !== 'string' || !isIsoDate(body.kickoff_date)) {
      return NextResponse.json({ error: 'kickoff_date is required in YYYY-MM-DD format' }, { status: 400 });
    }

    const kickoffDate = body.kickoff_date;
    const projectName = normalizeOptionalText(body.project_name);
    const implementationId = normalizeOptionalUuid(body.implementation_id);

    if (projectName && projectName.length > 200) {
      return NextResponse.json({ error: 'project_name must be 200 characters or fewer' }, { status: 400 });
    }

    const { data, error } = await supabase.rpc('instantiate_project_template', {
      p_user_id: userId,
      p_template_id: id,
      p_kickoff_date: kickoffDate,
      p_project_name: projectName,
      p_implementation_id: implementationId,
    });

    if (error) {
      const message = error.message || 'Failed to instantiate project template';
      const normalized = message.toLowerCase();

      if (normalized.includes('template not found')) {
        return NextResponse.json({ error: 'Project template not found' }, { status: 404 });
      }

      if (normalized.includes('implementation not found')) {
        return NextResponse.json({ error: 'Implementation not found' }, { status: 400 });
      }

      if (normalized.includes('project_name must be 200 characters')) {
        return NextResponse.json({ error: 'project_name must be 200 characters or fewer' }, { status: 400 });
      }

      throw error;
    }

    const row = (Array.isArray(data) ? data[0] : null) as InstantiateRpcRow | null;
    if (!row?.project_id) {
      return NextResponse.json({ error: 'Failed to instantiate project template' }, { status: 500 });
    }

    return NextResponse.json({
      project_id: row.project_id,
      created_sections: Number(row.created_sections ?? 0),
      created_tasks: Number(row.created_tasks ?? 0),
      created_checklist_items: Number(row.created_checklist_items ?? 0),
    }, { status: 201 });
  } catch (error) {
    console.error('Error instantiating project template:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
