import { NextRequest, NextResponse } from 'next/server';
import { getSprintWeekRange, isMondayToFridaySprintRange, resolveSprintWeekRange } from '@/lib/date-only';
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

function asSprintWeekRange(startDate: string, endDate: string) {
  return resolveSprintWeekRange(startDate, endDate);
}

function normalizeSprintWindow<T extends { start_date: string; end_date: string }>(sprint: T): T {
  if (isMondayToFridaySprintRange(sprint.start_date, sprint.end_date)) {
    return sprint;
  }

  const sprintWeek = getSprintWeekRange(sprint.start_date);
  if (!sprintWeek) {
    return sprint;
  }

  return {
    ...sprint,
    start_date: sprintWeek.startDate,
    end_date: sprintWeek.endDate,
  };
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

    return NextResponse.json((data || []).map((sprint) => normalizeSprintWindow(sprint)));
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

    const sprintWeek = asSprintWeekRange(startDate, endDate);
    if (!sprintWeek) {
      return NextResponse.json({ error: 'Sprint dates must resolve to the same Monday-Friday week' }, { status: 400 });
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
        start_date: sprintWeek.startDate,
        end_date: sprintWeek.endDate,
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
