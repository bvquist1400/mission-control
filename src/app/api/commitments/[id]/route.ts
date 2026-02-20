import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { CommitmentStatus, CommitmentDirection } from '@/types/database';

const VALID_STATUSES: CommitmentStatus[] = ['Open', 'Done', 'Dropped'];
const VALID_DIRECTIONS: CommitmentDirection[] = ['ours', 'theirs'];

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// PATCH /api/commitments/[id] - Update a commitment
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const updates: Record<string, unknown> = {};

    if ('title' in body) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
      }
      updates.title = body.title.trim();
    }

    if ('direction' in body) {
      const dir = asStringOrNull(body.direction);
      if (dir && !VALID_DIRECTIONS.includes(dir as CommitmentDirection)) {
        return NextResponse.json({ error: `Invalid direction` }, { status: 400 });
      }
      if (dir) updates.direction = dir;
    }

    if ('status' in body) {
      const status = asStringOrNull(body.status);
      if (status && !VALID_STATUSES.includes(status as CommitmentStatus)) {
        return NextResponse.json({ error: `Invalid status` }, { status: 400 });
      }
      if (status) {
        updates.status = status;
        // Auto-set done_at when marking Done
        if (status === 'Done') {
          updates.done_at = new Date().toISOString();
        } else {
          updates.done_at = null;
        }
      }
    }

    if ('due_at' in body) updates.due_at = asStringOrNull(body.due_at);
    if ('notes' in body) updates.notes = asStringOrNull(body.notes);
    if ('task_id' in body) updates.task_id = asStringOrNull(body.task_id);

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('commitments')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*, task:tasks(id, title, status), stakeholder:stakeholders(id, name)')
      .single();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'Commitment not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating commitment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/commitments/[id] - Delete a commitment
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { error } = await supabase
      .from('commitments')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error deleting commitment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
