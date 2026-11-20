import { NextRequest, NextResponse } from 'next/server';
import { isPostgrestNotFound } from '@/lib/supabase/errors';
import type { Json } from '@/types/supabase.generated';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { normalizeUnitCount, normalizeWorkType } from '@/lib/pace';
import { parseChecklistAdd, parseRowObject } from '@/lib/checklist-input';

const CHECKLIST_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }

    // Craft S4 (E): several rows at one place, { items, after_item_id?, at_start? }, in one 075 call
    // (checklist_insert_items: the rows after them move down; a craft row keeps its link).
    if ('items' in body) {
      const add = parseChecklistAdd(body);
      if (!add.ok) return NextResponse.json({ error: add.error }, { status: 400 });
      const { data: inserted, error: insertError } = await supabase.rpc('checklist_insert_items', {
        p_user_id: userId, p_task_id: id, p_items: add.rows as unknown as Json,
        ...(add.after_item_id ? { p_after_item_id: add.after_item_id } : {}), p_at_start: add.at_start,
      });
      if (insertError) {
        if (insertError.code === 'P0002') {
          return NextResponse.json({ error: /item/.test(insertError.message ?? '') ? 'after_item_id is not on this task' : 'Task not found' }, { status: 404 });
        }
        if (insertError.code === '22023') return NextResponse.json({ error: 'Some rows are not valid; nothing was added' }, { status: 400 });
        if (insertError.code === '55P03' || insertError.code === '40P01') return NextResponse.json({ error: 'The task was busy and nothing was added. Try again.', reason: 'busy' }, { status: 409 });
        throw insertError;
      }
      return NextResponse.json(inserted ?? [], { status: 201 });
    }

    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }
    // S4: one row may carry unit_count / work_type too (same rules as PATCH).
    const extras = parseRowObject({ text: body.text, ...('unit_count' in body ? { unit_count: body.unit_count } : {}), ...('work_type' in body ? { work_type: body.work_type } : {}) }, false);
    if (!extras.ok) return NextResponse.json({ error: extras.error }, { status: 400 });

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
        ...('unit_count' in body ? { unit_count: extras.row.unit_count } : {}),
        ...('work_type' in body ? { work_type: extras.row.work_type } : {}),
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
      if (!CHECKLIST_ITEM_ID.test(itemId)) {
        invalid.push({ index, id: itemId, error: 'id must be a checklist item UUID' });
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
      // S4 (A): deleting a craft row heals its part (075's trigger), which never waits on a busy craft screen.
      if (error.code === '55P03' || error.code === '40P01') {
        return NextResponse.json({ error: 'The craft screen was busy and nothing was deleted. Try again in a moment.', reason: 'busy' }, { status: 409 });
      }
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
