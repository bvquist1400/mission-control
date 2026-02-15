import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

// GET /api/tasks/[id]/checklist - Get checklist items for a task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('task_checklist_items')
      .select('*')
      .eq('task_id', id)
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
    const { id } = await params;
    const body = await request.json();
    const supabase = getSupabaseClient();

    // Validate required fields
    if (!body.text || typeof body.text !== 'string') {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    // Get the task to verify it exists and get user_id
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('user_id')
      .eq('id', id)
      .single();

    if (taskError || !task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Get max sort_order for this task
    const { data: maxItem } = await supabase
      .from('task_checklist_items')
      .select('sort_order')
      .eq('task_id', id)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();

    const nextSortOrder = (maxItem?.sort_order ?? -1) + 1;

    const { data, error } = await supabase
      .from('task_checklist_items')
      .insert({
        task_id: id,
        user_id: task.user_id,
        text: body.text,
        is_done: body.is_done ?? false,
        sort_order: body.sort_order ?? nextSortOrder,
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
    const { id } = await params;
    const body = await request.json();
    const supabase = getSupabaseClient();

    // Expect { items: [{ id, is_done?, text?, sort_order? }] }
    if (!body.items || !Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }

    const results = [];

    for (const item of body.items) {
      if (!item.id) continue;

      const updates: Record<string, unknown> = {};
      if ('is_done' in item) updates.is_done = item.is_done;
      if ('text' in item) updates.text = item.text;
      if ('sort_order' in item) updates.sort_order = item.sort_order;

      if (Object.keys(updates).length === 0) continue;

      const { data, error } = await supabase
        .from('task_checklist_items')
        .update(updates)
        .eq('id', item.id)
        .eq('task_id', id) // Ensure item belongs to this task
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
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('itemId');
    const supabase = getSupabaseClient();

    if (!itemId) {
      return NextResponse.json({ error: 'itemId query param required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('task_checklist_items')
      .delete()
      .eq('id', itemId);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting checklist item:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
