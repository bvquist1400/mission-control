import { NextRequest, NextResponse } from 'next/server';
import {
  buildReviewSnapshotTitle,
  isReviewPeriod,
  normalizeDateOnly,
  upsertReviewSnapshot,
} from '@/lib/briefing/review-snapshots';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { ReviewSnapshotPayload } from '@/types/database';

function asTrimmedString(value: unknown, maxLength: number, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }

  return trimmed;
}

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// GET /api/briefing/review-snapshots - List persisted weekly/monthly review snapshots
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const reviewType = searchParams.get('review_type');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const rawLimit = Number.parseInt(searchParams.get('limit') || '20', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;

    if (reviewType && !isReviewPeriod(reviewType)) {
      return NextResponse.json({ error: 'review_type must be weekly or monthly' }, { status: 400 });
    }

    if (from && !normalizeDateOnly(from)) {
      return NextResponse.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    }

    if (to && !normalizeDateOnly(to)) {
      return NextResponse.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
    }

    if (from && to && from > to) {
      return NextResponse.json({ error: 'from must be on or before to' }, { status: 400 });
    }

    let query = supabase
      .from('briefing_review_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('period_end', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (reviewType) {
      query = query.eq('review_type', reviewType);
    }

    if (from) {
      query = query.gte('period_end', from);
    }

    if (to) {
      query = query.lte('period_start', to);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    return NextResponse.json(data || []);
  } catch (error) {
    console.error('Error fetching review snapshots:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/briefing/review-snapshots - Persist a weekly or monthly review snapshot
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Partial<ReviewSnapshotPayload>;

    if (!isReviewPeriod(body.review_type)) {
      return NextResponse.json({ error: 'review_type is required and must be weekly or monthly' }, { status: 400 });
    }

    const periodStart = normalizeDateOnly(body.period_start);
    if (!periodStart) {
      return NextResponse.json({ error: 'period_start must be YYYY-MM-DD' }, { status: 400 });
    }

    const periodEnd = normalizeDateOnly(body.period_end);
    if (!periodEnd) {
      return NextResponse.json({ error: 'period_end must be YYYY-MM-DD' }, { status: 400 });
    }

    if (periodStart > periodEnd) {
      return NextResponse.json({ error: 'period_start must be on or before period_end' }, { status: 400 });
    }

    const anchorDate = body.anchor_date ? normalizeDateOnly(body.anchor_date) : periodEnd;
    if (!anchorDate) {
      return NextResponse.json({ error: 'anchor_date must be YYYY-MM-DD when provided' }, { status: 400 });
    }

    if (anchorDate < periodStart || anchorDate > periodEnd) {
      return NextResponse.json({ error: 'anchor_date must fall within period_start and period_end' }, { status: 400 });
    }

    if (!isObjectPayload(body.payload)) {
      return NextResponse.json({ error: 'payload is required and must be an object' }, { status: 400 });
    }

    let title: string | null = null;
    let summary: string | null = null;
    let source: string | null = null;

    try {
      title = asTrimmedString(body.title, 200, 'title');
      summary = asTrimmedString(body.summary, 4000, 'summary');
      source = asTrimmedString(body.source, 50, 'source');
    } catch (validationError) {
      return NextResponse.json({ error: (validationError as Error).message }, { status: 400 });
    }

    const snapshot = await upsertReviewSnapshot(supabase, {
      userId,
      reviewType: body.review_type,
      anchorDate,
      periodStart,
      periodEnd,
      title: title ?? buildReviewSnapshotTitle(body.review_type, periodStart, periodEnd),
      summary: summary ?? '',
      source: source ?? 'system',
      payload: body.payload,
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('Error saving review snapshot:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
