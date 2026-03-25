import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCalendarEntityId, parseCalendarEntityId } from '@/lib/calendar-event-identity';
import type {
  LinkNoteToEntityPayload,
  Note,
  NoteDecision,
  NoteLink,
  NoteLinkEntityType,
  NoteLinkRole,
  NoteTaskWithTask,
  NoteWithDetails,
  TaskSummary,
} from '@/types/database';
import {
  NotesServiceError,
  asTrimmedString,
  isValidLinkEntityType,
  isValidLinkRole,
  normalizeNoteDecisionRow,
  normalizeNoteLinkRow,
  normalizeNoteRow,
  normalizeNoteTaskRow,
  normalizeTaskSummary,
} from '@/lib/notes-shared';

export interface LinkResolution {
  entity_type: NoteLinkEntityType;
  entity_id: string;
  link_role: NoteLinkRole;
}

interface HydratedNoteRelations {
  linksByNoteId: Map<string, NoteLink[]>;
  taskLinksByNoteId: Map<string, NoteTaskWithTask[]>;
  decisionsByNoteId: Map<string, NoteDecision[]>;
}

export async function requireOwnedNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string
): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new NotesServiceError('Note not found', 404, 'note_not_found');
  }

  return normalizeNoteRow(data as Record<string, unknown>);
}

export async function requireOwnedTaskSummary(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<TaskSummary> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, estimated_minutes, due_at, blocker, priority_score, updated_at')
    .eq('id', taskId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new NotesServiceError('task_id is invalid', 400, 'invalid_task');
  }

  return normalizeTaskSummary(data as Record<string, unknown>);
}

export async function requireOwnedEntityId(
  supabase: SupabaseClient,
  userId: string,
  table: 'implementations' | 'projects' | 'stakeholders' | 'commitments' | 'sprints',
  entityId: string,
  errorMessage: string
): Promise<void> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', entityId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new NotesServiceError(errorMessage, 400, 'invalid_entity');
  }
}

export async function requireOwnedStakeholder(
  supabase: SupabaseClient,
  userId: string,
  stakeholderId: string
): Promise<void> {
  await requireOwnedEntityId(
    supabase,
    userId,
    'stakeholders',
    stakeholderId,
    'decided_by_stakeholder_id is invalid'
  );
}

async function resolveCalendarEventEntityId(
  supabase: SupabaseClient,
  userId: string,
  entityId: string,
  validateExists: boolean
): Promise<string> {
  const identity = parseCalendarEntityId(entityId);
  if (!identity) {
    throw new NotesServiceError(
      'calendar_event entity_id must use the canonical calendar:<encoded> format',
      400,
      'invalid_calendar_entity_id'
    );
  }

  if (Number.isNaN(Date.parse(identity.startAt))) {
    throw new NotesServiceError('calendar_event startAt must be a valid ISO timestamp', 400, 'invalid_calendar_start');
  }

  if (validateExists) {
    const { data, error } = await supabase
      .from('calendar_events')
      .select('source, external_event_id, start_at')
      .eq('user_id', userId)
      .eq('source', identity.source)
      .eq('external_event_id', identity.externalEventId)
      .eq('start_at', identity.startAt)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      throw new NotesServiceError(
        'calendar_event entity_id does not resolve to an existing event',
        400,
        'invalid_calendar_entity'
      );
    }
  }

  return buildCalendarEntityId(identity);
}

export async function resolveEntityLink(
  supabase: SupabaseClient,
  userId: string,
  input: LinkNoteToEntityPayload,
  options: { validateExists: boolean }
): Promise<LinkResolution> {
  if (!isValidLinkEntityType(input.entity_type)) {
    throw new NotesServiceError('entity_type is invalid', 400, 'invalid_entity_type');
  }

  const entityId = asTrimmedString(input.entity_id);
  if (!entityId) {
    throw new NotesServiceError('entity_id is required', 400, 'missing_entity_id');
  }

  const linkRole = input.link_role ?? 'reference';
  if (!isValidLinkRole(linkRole)) {
    throw new NotesServiceError('link_role is invalid', 400, 'invalid_link_role');
  }

  switch (input.entity_type) {
    case 'task':
      if (options.validateExists) {
        await requireOwnedTaskSummary(supabase, userId, entityId);
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'implementation':
      if (options.validateExists) {
        await requireOwnedEntityId(supabase, userId, 'implementations', entityId, 'implementation_id is invalid');
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'project':
      if (options.validateExists) {
        await requireOwnedEntityId(supabase, userId, 'projects', entityId, 'project_id is invalid');
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'stakeholder':
      if (options.validateExists) {
        await requireOwnedEntityId(supabase, userId, 'stakeholders', entityId, 'stakeholder_id is invalid');
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'commitment':
      if (options.validateExists) {
        await requireOwnedEntityId(supabase, userId, 'commitments', entityId, 'commitment_id is invalid');
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'sprint':
      if (options.validateExists) {
        await requireOwnedEntityId(supabase, userId, 'sprints', entityId, 'sprint_id is invalid');
      }
      return { entity_type: input.entity_type, entity_id: entityId, link_role: linkRole };
    case 'calendar_event':
      return {
        entity_type: input.entity_type,
        entity_id: await resolveCalendarEventEntityId(supabase, userId, entityId, options.validateExists),
        link_role: linkRole,
      };
    default:
      throw new NotesServiceError('entity_type is invalid', 400, 'invalid_entity_type');
  }
}

async function hydrateNoteRelations(
  supabase: SupabaseClient,
  userId: string,
  noteIds: string[]
): Promise<HydratedNoteRelations> {
  if (noteIds.length === 0) {
    return {
      linksByNoteId: new Map(),
      taskLinksByNoteId: new Map(),
      decisionsByNoteId: new Map(),
    };
  }

  const [linksResult, taskLinksResult, decisionsResult] = await Promise.all([
    supabase
      .from('note_links')
      .select('*')
      .eq('user_id', userId)
      .in('note_id', noteIds)
      .order('created_at', { ascending: true }),
    supabase
      .from('note_tasks')
      .select('*')
      .eq('user_id', userId)
      .in('note_id', noteIds)
      .order('created_at', { ascending: true }),
    supabase
      .from('note_decisions')
      .select('*')
      .eq('user_id', userId)
      .in('note_id', noteIds)
      .order('updated_at', { ascending: false }),
  ]);

  if (linksResult.error) {
    throw linksResult.error;
  }

  if (taskLinksResult.error) {
    throw taskLinksResult.error;
  }

  if (decisionsResult.error) {
    throw decisionsResult.error;
  }

  const taskRows = (taskLinksResult.data || []) as Array<Record<string, unknown>>;
  const taskIds = [...new Set(taskRows.map((row) => String(row.task_id)).filter(Boolean))];
  const taskMap = new Map<string, TaskSummary>();

  if (taskIds.length > 0) {
    const tasksResult = await supabase
      .from('tasks')
      .select('id, title, status, estimated_minutes, due_at, blocker, priority_score, updated_at')
      .eq('user_id', userId)
      .in('id', taskIds);

    if (tasksResult.error) {
      throw tasksResult.error;
    }

    for (const row of (tasksResult.data || []) as Array<Record<string, unknown>>) {
      const task = normalizeTaskSummary(row);
      taskMap.set(task.id, task);
    }
  }

  const linksByNoteId = new Map<string, NoteLink[]>();
  for (const row of (linksResult.data || []) as Array<Record<string, unknown>>) {
    const link = normalizeNoteLinkRow(row);
    const existing = linksByNoteId.get(link.note_id) ?? [];
    existing.push(link);
    linksByNoteId.set(link.note_id, existing);
  }

  const taskLinksByNoteId = new Map<string, NoteTaskWithTask[]>();
  for (const row of taskRows) {
    const noteId = String(row.note_id);
    const taskLink = normalizeNoteTaskRow(row, taskMap.get(String(row.task_id)) ?? null);
    const existing = taskLinksByNoteId.get(noteId) ?? [];
    existing.push(taskLink);
    taskLinksByNoteId.set(noteId, existing);
  }

  const decisionsByNoteId = new Map<string, NoteDecision[]>();
  for (const row of (decisionsResult.data || []) as Array<Record<string, unknown>>) {
    const decision = normalizeNoteDecisionRow(row);
    const existing = decisionsByNoteId.get(decision.note_id) ?? [];
    existing.push(decision);
    decisionsByNoteId.set(decision.note_id, existing);
  }

  return {
    linksByNoteId,
    taskLinksByNoteId,
    decisionsByNoteId,
  };
}

export async function hydrateNotes(
  supabase: SupabaseClient,
  userId: string,
  notes: Note[]
): Promise<NoteWithDetails[]> {
  const noteIds = notes.map((note) => note.id);
  const { linksByNoteId, taskLinksByNoteId, decisionsByNoteId } = await hydrateNoteRelations(
    supabase,
    userId,
    noteIds
  );

  return notes.map((note) => ({
    ...note,
    links: linksByNoteId.get(note.id) ?? [],
    task_links: taskLinksByNoteId.get(note.id) ?? [],
    decisions: decisionsByNoteId.get(note.id) ?? [],
  }));
}

export async function ensureRelatedTaskEntityLink(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  taskId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('note_links')
    .select('*')
    .eq('user_id', userId)
    .eq('note_id', noteId)
    .eq('entity_type', 'task')
    .eq('entity_id', taskId)
    .eq('link_role', 'related_task')
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data) {
    return;
  }

  const insertResult = await supabase
    .from('note_links')
    .insert({
      user_id: userId,
      note_id: noteId,
      entity_type: 'task',
      entity_id: taskId,
      link_role: 'related_task',
    })
    .select('*')
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }
}
