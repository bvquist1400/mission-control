import { NextRequest, NextResponse } from 'next/server';
import { isPostgrestNotFound } from '@/lib/supabase/errors';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { addFamcalTaskComment, FamcalTaskBusyError, readFamcalTaskComments } from '@/lib/famcal-api-key';
import type { CommentSource } from '@/types/database';

const VALID_SOURCES: CommentSource[] = ['manual', 'system', 'llm'];

function isValidSource(value: string): value is CommentSource {
  return VALID_SOURCES.includes(value as CommentSource);
}

// GET /api/tasks/[id]/comments - Get comments for a task
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

    // The FamCal key reads comments only on tasks tagged `personal`, and the tag
    // check is part of the same query that reads them (one statement, one snapshot).
    if (auth.context.authSource === 'famcal_api_key') {
      const famcalComments = await readFamcalTaskComments(supabase, userId, id);
      if (!famcalComments) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      return NextResponse.json(famcalComments);
    }

    const { data, error } = await supabase
      .from('task_comments')
      .select('*')
      .eq('task_id', id)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching comments:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/comments - Add a comment
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

    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    if (body.content.length > 5000) {
      return NextResponse.json({ error: 'content must be 5000 characters or fewer' }, { status: 400 });
    }

    // Validate source if provided
    let source: CommentSource = 'manual';
    if (typeof body.source === 'string') {
      if (!isValidSource(body.source)) {
        return NextResponse.json(
          { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` },
          { status: 400 }
        );
      }
      source = body.source;
    }

    // The FamCal key comments only on tasks tagged `personal`. One database
    // transaction (migration 060) locks the task, checks the tag and inserts, so
    // a comment can never land on a task that isn't personal at that moment, and
    // a SQL failure inside it leaves nothing behind. A reply lost after the commit
    // is ambiguous: a retry would add a second comment (no idempotency token yet).
    if (auth.context.authSource === 'famcal_api_key') {
      let famcalComment;
      try {
        famcalComment = await addFamcalTaskComment(supabase, userId, id, body.content.trim(), source);
      } catch (error) {
        // Only an eligible task can be busy (the function never waits on an
        // ineligible row), so this never tells a work task apart from a missing one.
        if (error instanceof FamcalTaskBusyError) {
          return NextResponse.json({ error: error.message }, { status: 503 });
        }
        throw error;
      }
      if (!famcalComment) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      return NextResponse.json(famcalComment, { status: 201 });
    }

    // Verify task exists and belongs to user
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

    const { data, error } = await supabase
      .from('task_comments')
      .insert({
        task_id: id,
        user_id: userId,
        content: body.content.trim(),
        source,
      })
      .select()
      .single();

    if (error) {
      // The task was deleted between the check above and the insert (e.g. a
      // "Break into tasks" Undo took the step away while this comment waited):
      // nothing was saved, and the task is gone.
      if ((error as { code?: string }).code === '23503') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating comment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id]/comments - Update a comment
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
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.commentId !== 'string') {
      return NextResponse.json({ error: 'commentId is required' }, { status: 400 });
    }

    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('task_comments')
      .update({ content: body.content.trim() })
      .eq('id', body.commentId)
      .eq('task_id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    if (!data) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error updating comment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/comments - Delete a comment
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
    const commentId = searchParams.get('commentId');

    if (!commentId) {
      return NextResponse.json({ error: 'commentId query param required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('task_comments')
      .delete()
      .eq('id', commentId)
      .eq('task_id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
