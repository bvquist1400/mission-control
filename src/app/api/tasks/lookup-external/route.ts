import { NextRequest, NextResponse } from 'next/server';
import { formatExternalSourceLookup, normalizeExternalSourceValue } from '@/lib/task-external-source';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

const MAX_EXTERNAL_SOURCE_IDS = 500;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) return auth.response as NextResponse;

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;
    const externalSourceSystem = normalizeExternalSourceValue(body.external_source_system);
    if (!externalSourceSystem) {
      return NextResponse.json({ error: 'external_source_system is required' }, { status: 400 });
    }

    if (!Array.isArray(body.external_source_ids)) {
      return NextResponse.json({ error: 'external_source_ids must be an array of strings' }, { status: 400 });
    }

    if (body.external_source_ids.length === 0 || body.external_source_ids.length > MAX_EXTERNAL_SOURCE_IDS) {
      return NextResponse.json(
        { error: `external_source_ids must contain between 1 and ${MAX_EXTERNAL_SOURCE_IDS} values` },
        { status: 400 }
      );
    }

    const externalSourceIds = body.external_source_ids.map(normalizeExternalSourceValue);
    if (externalSourceIds.some((value) => value === null)) {
      return NextResponse.json({ error: 'external_source_ids must contain non-empty strings' }, { status: 400 });
    }

    const requestedIds = externalSourceIds as string[];
    let query = supabase
      .from('tasks')
      .select('external_source_id, id, title, status, waiting_on, section_id, tags')
      .eq('user_id', userId)
      .eq('external_source_system', externalSourceSystem)
      .in('external_source_id', [...new Set(requestedIds)]);

    const projectId = normalizeExternalSourceValue(body.project_id);
    if (projectId) query = query.eq('project_id', projectId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json(formatExternalSourceLookup(requestedIds, data || []));
  } catch (error) {
    console.error('Error looking up tasks by external ids:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
