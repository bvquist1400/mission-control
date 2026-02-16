import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const FALLBACK_USER_ID = '00000000-0000-0000-0000-000000000001';

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

async function resolveUserId(
  supabase: ReturnType<typeof getSupabaseClient>,
  requestedUserId: unknown
): Promise<string | null> {
  if (typeof requestedUserId === 'string' && requestedUserId.trim().length > 0) {
    return requestedUserId.trim();
  }

  if (process.env.DEFAULT_USER_ID) {
    return process.env.DEFAULT_USER_ID;
  }

  const tables = ['tasks', 'implementations', 'inbox_items'] as const;

  for (const table of tables) {
    const { data, error } = await supabase
      .from(table)
      .select('user_id')
      .limit(1);

    if (error) {
      continue;
    }

    const existingUserId = data?.[0]?.user_id;
    if (typeof existingUserId === 'string' && existingUserId.length > 0) {
      return existingUserId;
    }
  }

  return FALLBACK_USER_ID;
}

// GET /api/tasks - List tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const { searchParams } = new URL(request.url);

    // Filter options
    const needsReview = searchParams.get('needs_review');
    const status = searchParams.get('status');
    const implementationId = searchParams.get('implementation_id');
    const dueSoon = searchParams.get('due_soon'); // "true" for tasks due within 48h
    const rawLimit = parseInt(searchParams.get('limit') || '100', 10);
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    let query = supabase
      .from('tasks')
      .select('*, implementation:implementations(id, name)')
      .order('priority_score', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    // Apply filters
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

    // Exclude done tasks by default unless explicitly requested
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
    const supabase = getSupabaseClient();
    const body = await request.json();

    // Validate required fields
    if (!body.title) {
      return NextResponse.json(
        { error: 'title is required' },
        { status: 400 }
      );
    }

    const userId = await resolveUserId(supabase, body.user_id);
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: body.title,
        implementation_id: body.implementation_id || null,
        status: body.status || 'Next',
        task_type: body.task_type || 'Admin',
        priority_score: body.priority_score ?? 50,
        estimated_minutes: body.estimated_minutes ?? 30,
        estimate_source: body.estimate_source || 'default',
        due_at: body.due_at || null,
        needs_review: body.needs_review ?? false,
        blocker: body.blocker ?? false,
        waiting_on: body.waiting_on || null,
        stakeholder_mentions: body.stakeholder_mentions || [],
        source_type: body.source_type || 'Manual',
        source_url: body.source_url || null,
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
