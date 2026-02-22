import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42703' || candidate.code === 'PGRST204') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes(columnName.toLowerCase()) && message.includes('column');
}

async function hasColumn(
  supabase: SupabaseClient,
  userId: string,
  columnName: 'portfolio_rank' | 'priority_weight'
): Promise<boolean> {
  const probe = await supabase
    .from('implementations')
    .select(`id, ${columnName}`)
    .eq('user_id', userId)
    .limit(1);

  if (!probe.error) {
    return true;
  }

  if (isMissingColumnError(probe.error, columnName)) {
    return false;
  }

  throw probe.error;
}

function rankToPriorityWeight(index: number, total: number): number {
  if (total <= 1) {
    return 10;
  }

  const normalized = index / (total - 1);
  return Math.max(0, Math.min(10, Math.round(10 - normalized * 10)));
}

function parseOrderedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const ids: string[] = [];

  for (const raw of value) {
    if (typeof raw !== 'string') {
      return null;
    }

    const id = raw.trim();
    if (!id || seen.has(id)) {
      return null;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

// POST /api/applications/reorder - Persist drag-and-drop ranking order
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as { ordered_ids?: unknown };
    const orderedIds = parseOrderedIds(body.ordered_ids);

    if (!orderedIds) {
      return NextResponse.json(
        { error: 'ordered_ids must be a non-empty array of unique application ids' },
        { status: 400 }
      );
    }

    const { data: implementations, error: listError } = await supabase
      .from('implementations')
      .select('id')
      .eq('user_id', userId);

    if (listError) {
      throw listError;
    }

    const existingIds = (implementations || []).map((row) => row.id);
    if (orderedIds.length !== existingIds.length) {
      return NextResponse.json(
        { error: 'ordered_ids must include every application exactly once' },
        { status: 400 }
      );
    }

    const existingSet = new Set(existingIds);
    for (const id of orderedIds) {
      if (!existingSet.has(id)) {
        return NextResponse.json(
          { error: 'ordered_ids contains an application that does not belong to this user' },
          { status: 400 }
        );
      }
    }

    const supportsPortfolioRank = await hasColumn(supabase, userId, 'portfolio_rank');
    const supportsPriorityWeight = await hasColumn(supabase, userId, 'priority_weight');

    for (let index = 0; index < orderedIds.length; index += 1) {
      const id = orderedIds[index];
      const updates: Record<string, unknown> = {};

      if (supportsPortfolioRank) {
        updates.portfolio_rank = index + 1;
      }

      if (supportsPriorityWeight) {
        updates.priority_weight = rankToPriorityWeight(index, orderedIds.length);
      }

      if (Object.keys(updates).length === 0) {
        continue;
      }

      const { error: updateError } = await supabase
        .from('implementations')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId);

      if (updateError) {
        throw updateError;
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error reordering applications:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
