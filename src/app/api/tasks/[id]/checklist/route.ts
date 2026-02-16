import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

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

    const results = [];

    for (const item of body.items) {
      const itemId = typeof item.id === 'string' ? item.id : null;
      if (!itemId) {
        continue;
      }

      const updates: Record<string, unknown> = {};
      if ('is_done' in item && typeof item.is_done === 'boolean') updates.is_done = item.is_done;
      if ('text' in item && typeof item.text === 'string') updates.text = item.text.trim();
      if ('sort_order' in item && typeof item.sort_order === 'number') updates.sort_order = item.sort_order;

      if (Object.keys(updates).length === 0) {
        continue;
      }

      const { data, error } = await supabase
        .from('task_checklist_items')
        .update(updates)
        .eq('id', itemId)
        .eq('task_id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (!error && data) {
        results.push(data);
      }
    }

    return NextResponse.json(results);
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
