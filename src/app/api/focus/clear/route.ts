import { NextRequest, NextResponse } from 'next/server';
import { isMissingRelationError } from '@/lib/focus-directives';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const nowIso = new Date().toISOString();

    const clearResult = await supabase
      .from('focus_directives')
      .update({ is_active: false, ends_at: nowIso })
      .eq('created_by', userId)
      .eq('is_active', true)
      .select('id');

    if (clearResult.error) {
      if (isMissingRelationError(clearResult.error)) {
        return NextResponse.json({
          cleared: 0,
          clearedIds: [],
          note: 'focus_directives table not found',
        });
      }

      throw clearResult.error;
    }

    const clearedRows = clearResult.data || [];
    return NextResponse.json({
      cleared: clearedRows.length,
      clearedIds: clearedRows.map((row) => row.id),
      clearedAt: nowIso,
    });
  } catch (error) {
    console.error('Error clearing focus directives:', error);
    return NextResponse.json({ error: 'Failed to clear focus directives' }, { status: 500 });
  }
}
