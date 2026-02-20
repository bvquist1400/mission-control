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

// POST /api/stakeholders/[id]/commitments - Create commitment for stakeholder
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id: stakeholderId } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    // Verify stakeholder belongs to user
    const { data: stakeholder, error: stakeholderError } = await supabase
      .from('stakeholders')
      .select('id')
      .eq('id', stakeholderId)
      .eq('user_id', userId)
      .single();

    if (stakeholderError || !stakeholder) {
      return NextResponse.json({ error: 'Stakeholder not found' }, { status: 404 });
    }

    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const direction = asStringOrNull(body.direction);
    if (direction && !VALID_DIRECTIONS.includes(direction as CommitmentDirection)) {
      return NextResponse.json(
        { error: `Invalid direction. Must be one of: ${VALID_DIRECTIONS.join(', ')}` },
        { status: 400 }
      );
    }

    const status = asStringOrNull(body.status);
    if (status && !VALID_STATUSES.includes(status as CommitmentStatus)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate task_id if provided
    const taskId = asStringOrNull(body.task_id);
    if (taskId) {
      const { data: task, error: taskError } = await supabase
        .from('tasks')
        .select('id')
        .eq('id', taskId)
        .eq('user_id', userId)
        .single();

      if (taskError || !task) {
        return NextResponse.json({ error: 'task_id is invalid' }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from('commitments')
      .insert({
        user_id: userId,
        stakeholder_id: stakeholderId,
        task_id: taskId,
        title: body.title.trim(),
        direction: (direction as CommitmentDirection) || 'ours',
        status: (status as CommitmentStatus) || 'Open',
        due_at: asStringOrNull(body.due_at),
        notes: asStringOrNull(body.notes),
      })
      .select('*, task:tasks(id, title, status)')
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating commitment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
