import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { CommitmentStatus } from '@/types/database';

const VALID_STATUSES: CommitmentStatus[] = ['Open', 'Done', 'Dropped'];

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/commitments - List commitments with optional filters
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);

    const statusParam = asStringOrNull(searchParams.get('status'));
    const includeDone = searchParams.get('include_done') === 'true';
    const search = asStringOrNull(searchParams.get('search'));
    const rawLimit = Number.parseInt(searchParams.get('limit') || '300', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 300;

    if (statusParam && !VALID_STATUSES.includes(statusParam as CommitmentStatus)) {
      return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
    }

    let query = supabase
      .from('commitments')
      .select('id, title, status, due_at, stakeholder:stakeholders(id, name)')
      .eq('user_id', userId)
      .order('status', { ascending: true })
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(limit);

    if (statusParam) {
      query = query.eq('status', statusParam);
    } else if (!includeDone) {
      query = query.neq('status', 'Done');
    }

    if (search) {
      query = query.ilike('title', `%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return NextResponse.json(data || []);
  } catch (error) {
    console.error('Error fetching commitments:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
