import { NextRequest, NextResponse } from 'next/server';
import { isPostgrestNotFound } from '@/lib/supabase/errors';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { normalizeUnitCount, normalizeWorkType } from '@/lib/pace';

// GET /api/tasks/[id]/checklist - Get checklist items for a task
export async function GET(
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

    const { data, error } = await supabase
      .from('task_checklist_items')
      .select('*')
      .eq('task_id', id)
      .eq('user_id', userId)
      .order('sort_order', { ascending: true });

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching checklist:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/checklist - Add a checklist item
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
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (taskError && !isPostgrestNotFound(taskError)) {
      throw taskError;
    }

    if (taskError || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const { data: maxItems, error: maxError } = await supabase
      .from('task_checklist_items')
      .select('sort_order')
      .eq('task_id', id)
      .eq('user_id', userId)
      .order('sort_order', { ascending: false })
      .limit(1);

    if (maxError) {
      throw maxError;
    }

    const nextSortOrder = (maxItems?.[0]?.sort_order ?? -1) + 1;

    const { data, error } = await supabase
      .from('task_checklist_items')
      .insert({
        task_id: id,
        user_id: userId,
        text: body.text.trim(),
        is_done: typeof body.is_done === 'boolean' ? body.is_done : false,
        sort_order: typeof body.sort_order === 'number' ? body.sort_order : nextSortOrder,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating checklist item:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id]/checklist - Update checklist items (bulk)
// Each item needs an id and at least one of is_done, text, sort_order,
// unit_count, work_type. Every item is validated before any is written (an
// invalid item → 400, nothing changes). All written → 200 with the updated
// rows (unchanged contract). Some rows not found / failed → 207
// { updated, failed }; none written → 404/500 { updated: [], failed }.
export async function PATCH(
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
    const body = (await request.json()) as { items?: Array<Record<string, unknown>> };

    if (!body.items || !Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }

    const planned: Array<{ id: string; updates: Record<string, unknown> }> = [];
    const invalid: Array<{ index: number; id: string | null; error: string }> = [];

    body.items.forEach((item, index) => {
      const itemId = item && typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
      if (!itemId) {
        invalid.push({ index, id: null, error: 'id is required' });
        return;
      }

      const updates: Record<string, unknown> = {};
      const errors: string[] = [];
      if ('is_done' in item) {
        if (typeof item.is_done === 'boolean') updates.is_done = item.is_done;
        else errors.push('is_done must be true or false');
      }
      if ('text' in item) {
        if (typeof item.text === 'string' && item.text.trim().length > 0) updates.text = item.text.trim();
        else errors.push('text must be a non-empty string');
      }
      if ('sort_order' in item) {
        if (typeof item.sort_order === 'number' && Number.isFinite(item.sort_order)) updates.sort_order = item.sort_order;
        else errors.push('sort_order must be a number');
      }
      if ('unit_count' in item) {
        const units = normalizeUnitCount(item.unit_count);
        if (units.ok) updates.unit_count = units.value;
        else errors.push(units.error);
      }
      if ('work_type' in item) {
        const workType = normalizeWorkType(item.work_type);
        if (workType.ok) updates.work_type = workType.value;
        else errors.push(workType.error);
      }

      if (errors.length > 0) {
        invalid.push({ index, id: itemId, error: errors.join('; ') });
      } else if (Object.keys(updates).length === 0) {
        invalid.push({ index, id: itemId, error: 'give at least one of is_done, text, sort_order, unit_count, work_type' });
      } else {
        planned.push({ id: itemId, updates });
      }
    });

    if (invalid.length > 0) {
      return NextResponse.json(
        { error: 'Some checklist items are invalid; nothing was changed', failed: invalid },
        { status: 400 }
      );
    }

    const results: Array<Record<string, unknown>> = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const { id: itemId, updates } of planned) {
      const { data, error } = await supabase
        .from('task_checklist_items')
        .update(updates)
        .eq('id', itemId)
        .eq('task_id', id)
        .eq('user_id', userId)
        .select()
        .maybeSingle();

      if (error) {
        console.error('Checklist item update failed:', itemId, error);
        failed.push({ id: itemId, error: error.message || 'update failed' });
      } else if (!data) {
        failed.push({ id: itemId, error: 'not found on this task' });
      } else {
        results.push(data);
      }
    }

    if (failed.length === 0) {
      return NextResponse.json(results);
    }

    const status = results.length > 0 ? 207 : failed.every((entry) => entry.error === 'not found on this task') ? 404 : 500;
    return NextResponse.json({ updated: results, failed }, { status });
  } catch (error) {
    console.error('Error updating checklist items:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/checklist - Delete a checklist item
export async function DELETE(
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
    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('itemId');

    if (!itemId) {
      return NextResponse.json({ error: 'itemId query param required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('task_checklist_items')
      .delete()
      .eq('id', itemId)
      .eq('task_id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Checklist item not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting checklist item:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
