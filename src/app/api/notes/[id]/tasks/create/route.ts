import { NextRequest } from 'next/server';
import { createTaskFromNote } from '@/lib/notes';
import { handleNotesRouteError, notesJson, notesOptions } from '@/lib/notes-http';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { EstimateSource, NoteTaskRelationshipType, TaskStatus, TaskType } from '@/types/database';

export function OPTIONS(request: NextRequest) {
  return notesOptions(request);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as Response;
    }

    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const result = await createTaskFromNote(auth.context.supabase, auth.context.userId, id, {
      title: typeof body.title === 'string' ? body.title : '',
      description:
        typeof body.description === 'string' || body.description === null ? body.description : undefined,
      implementation_id:
        typeof body.implementation_id === 'string' || body.implementation_id === null
          ? body.implementation_id
          : undefined,
      project_id:
        typeof body.project_id === 'string' || body.project_id === null ? body.project_id : undefined,
      sprint_id:
        typeof body.sprint_id === 'string' || body.sprint_id === null ? body.sprint_id : undefined,
      status: typeof body.status === 'string' ? (body.status as TaskStatus) : undefined,
      task_type: typeof body.task_type === 'string' ? (body.task_type as TaskType) : undefined,
      estimated_minutes: typeof body.estimated_minutes === 'number' ? body.estimated_minutes : undefined,
      estimate_source:
        typeof body.estimate_source === 'string' ? (body.estimate_source as EstimateSource) : undefined,
      due_at: typeof body.due_at === 'string' || body.due_at === null ? body.due_at : undefined,
      priority_score: typeof body.priority_score === 'number' ? body.priority_score : undefined,
      blocker: typeof body.blocker === 'boolean' ? body.blocker : undefined,
      needs_review: typeof body.needs_review === 'boolean' ? body.needs_review : undefined,
      waiting_on:
        typeof body.waiting_on === 'string' || body.waiting_on === null ? body.waiting_on : undefined,
      relationship_type:
        typeof body.relationship_type === 'string'
          ? (body.relationship_type as NoteTaskRelationshipType)
          : undefined,
    });

    return notesJson(request, result, { status: 201 });
  } catch (error) {
    return handleNotesRouteError(request, error, 'Error creating task from note:');
  }
}
