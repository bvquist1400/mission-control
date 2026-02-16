import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/tasks - List tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const needsReview = searchParams.get('needs_review');
    const status = searchParams.get('status');
    const implementationId = searchParams.get('implementation_id');
    const dueSoon = searchParams.get('due_soon');
    const rawLimit = Number.parseInt(searchParams.get('limit') || '100', 10);
    const rawOffset = Number.parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    let query = supabase
      .from('tasks')
      .select('*, implementation:implementations(id, name)')
      .eq('user_id', userId)
      .order('priority_score', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (needsReview === 'true') {
      query = query.eq('needs_review', true);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (implementationId) {
      query = query.eq('implementation_id', implementationId);
    }

    if (dueSoon === 'true') {
      const now = new Date();
      const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      query = query
        .not('due_at', 'is', null)
        .lte('due_at', in48h.toISOString())
        .neq('status', 'Done');
    }

    if (searchParams.get('include_done') !== 'true') {
      query = query.neq('status', 'Done');
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const implementationId = asStringOrNull(body.implementation_id);
    if (implementationId) {
      const { data: implementation, error: implementationError } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', implementationId)
        .eq('user_id', userId)
        .single();

      if (implementationError || !implementation) {
        return NextResponse.json({ error: 'implementation_id is invalid' }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: body.title.trim(),
        implementation_id: implementationId,
        status: asStringOrNull(body.status) || 'Next',
        task_type: asStringOrNull(body.task_type) || 'Admin',
        priority_score: typeof body.priority_score === 'number' ? body.priority_score : 50,
        estimated_minutes: typeof body.estimated_minutes === 'number' ? body.estimated_minutes : 30,
        estimate_source: asStringOrNull(body.estimate_source) || 'default',
        due_at: asStringOrNull(body.due_at),
        needs_review: typeof body.needs_review === 'boolean' ? body.needs_review : false,
        blocker: typeof body.blocker === 'boolean' ? body.blocker : false,
        waiting_on: asStringOrNull(body.waiting_on),
        stakeholder_mentions: toStringArray(body.stakeholder_mentions),
        source_type: asStringOrNull(body.source_type) || 'Manual',
        source_url: asStringOrNull(body.source_url),
      })
      .select('*, implementation:implementations(id, name)')
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
