import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asDateOnlyOrNull(value: unknown): string | null {
  const normalized = asStringOrNull(value);
  if (!normalized || !DATE_ONLY_REGEX.test(normalized)) {
    return null;
  }

  return normalized;
}

function isValidDateRange(startDate: string, endDate: string): boolean {
  return startDate <= endDate;
}

// GET /api/sprints - List sprints, most recent first
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    const { data, error } = await supabase
      .from('sprints')
      .select('*, focus_implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .eq('user_id', userId)
      .order('start_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    return NextResponse.json(data || []);
  } catch (error) {
    console.error('Error fetching sprints:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/sprints - Create a new sprint
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const startDate = asDateOnlyOrNull(body.start_date);
    const endDate = asDateOnlyOrNull(body.end_date);

    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'start_date and end_date must be valid YYYY-MM-DD strings' }, { status: 400 });
    }

    if (!isValidDateRange(startDate, endDate)) {
      return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 });
    }

    const focusImplementationId = asStringOrNull(body.focus_implementation_id);
    if (focusImplementationId) {
      const { data: implementation, error: implementationError } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', focusImplementationId)
        .eq('user_id', userId)
        .single();

      if (implementationError || !implementation) {
        return NextResponse.json({ error: 'focus_implementation_id is invalid' }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('sprints')
      .insert({
        user_id: userId,
        name: body.name.trim(),
        start_date: startDate,
        end_date: endDate,
        theme: asStringOrNull(body.theme) || '',
        focus_implementation_id: focusImplementationId,
      })
      .select('*, focus_implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating sprint:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
