import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildCalendarEntityId,
  parseCalendarEntityId,
  type CalendarEventIdentity,
} from '@/lib/calendar-event-identity';
import {
  ensureRelatedTaskEntityLink,
  hydrateNotes,
  requireOwnedEntityId,
  requireOwnedNote,
  requireOwnedStakeholder,
  requireOwnedTaskSummary,
  resolveEntityLink,
} from '@/lib/notes-relations';
import {
  NOTE_DECISION_STATUSES,
  NOTE_LINK_ENTITY_TYPES,
  NOTE_LINK_ROLES,
  NOTE_STATUSES,
  NOTE_TASK_RELATIONSHIP_TYPES,
  NOTE_TYPES,
  NotesServiceError,
  asIsoTimestampOrNull,
  asTrimmedString,
  clampInteger,
  isValidDecisionStatus,
  isValidEstimateSource,
  isValidLinkRole,
  isValidNoteStatus,
  isValidNoteType,
  isValidTaskRelationshipType,
  isValidTaskStatus,
  isValidTaskType,
  normalizeNoteDecisionRow,
  normalizeNoteLinkRow,
  normalizeNoteRow,
  normalizeNoteTaskRow,
  normalizeTaskSummary,
} from '@/lib/notes-shared';
import type {
  CreateMeetingNotePayload,
  CreateNoteDecisionPayload,
  CreateNotePayload,
  CreateTaskFromNotePayload,
  EstimateSource,
  LinkNoteToEntityPayload,
  LinkTaskToNotePayload,
  ListNotesOptions,
  Note,
  NoteDecision,
  NoteDecisionStatus,
  NoteLink,
  NoteLinkEntityType,
  NoteLinkRole,
  NoteStatus,
  NoteTaskRelationshipType,
  NoteTaskWithTask,
  NoteType,
  NoteWithDetails,
  TaskStatus,
  TaskSummary,
  TaskType,
  UpdateNoteDecisionStatusPayload,
  UpdateNotePayload,
} from '@/types/database';

export {
  NOTE_DECISION_STATUSES,
  NOTE_LINK_ENTITY_TYPES,
  NOTE_LINK_ROLES,
  NOTE_STATUSES,
  NOTE_TASK_RELATIONSHIP_TYPES,
  NOTE_TYPES,
  NotesServiceError,
} from '@/lib/notes-shared';

interface CalendarEventRow {
  source: 'local' | 'ical' | 'graph';
  external_event_id: string;
  start_at: string;
  title: string;
}

interface CreateTaskFromNoteResult {
  task: TaskSummary;
  task_link: NoteTaskWithTask;
}

export function buildCalendarNoteEntityId(identity: CalendarEventIdentity): string {
  return buildCalendarEntityId(identity);
}

export function parseCalendarNoteEntityId(entityId: string): CalendarEventIdentity | null {
  return parseCalendarEntityId(entityId);
}

export async function createNote(
  supabase: SupabaseClient,
  userId: string,
  input: CreateNotePayload
): Promise<NoteWithDetails> {
  const title = asTrimmedString(input.title);
  if (!title) {
    throw new NotesServiceError('title is required', 400, 'missing_title');
  }

  const noteType = input.note_type ?? 'working_note';
  if (!isValidNoteType(noteType)) {
    throw new NotesServiceError('note_type is invalid', 400, 'invalid_note_type');
  }

  const status = input.status ?? 'active';
  if (!isValidNoteStatus(status)) {
    throw new NotesServiceError('status is invalid', 400, 'invalid_note_status');
  }

  if (input.pinned !== undefined && typeof input.pinned !== 'boolean') {
    throw new NotesServiceError('pinned must be a boolean', 400, 'invalid_pinned');
  }

  const lastReviewedAt = asIsoTimestampOrNull(input.last_reviewed_at);

  const { data, error } = await supabase
    .from('notes')
    .insert({
      user_id: userId,
      title,
      body_markdown: typeof input.body_markdown === 'string' ? input.body_markdown : '',
      note_type: noteType,
      status,
      pinned: input.pinned ?? false,
      last_reviewed_at: lastReviewedAt ?? null,
    })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return getNoteById(supabase, userId, String((data as Record<string, unknown>).id));
}

export async function updateNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: UpdateNotePayload
): Promise<NoteWithDetails> {
  await requireOwnedNote(supabase, userId, noteId);

  const updates: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = asTrimmedString(input.title);
    if (!title) {
      throw new NotesServiceError('title cannot be empty', 400, 'invalid_title');
    }
    updates.title = title;
  }

  if (input.body_markdown !== undefined) {
    updates.body_markdown = typeof input.body_markdown === 'string' ? input.body_markdown : '';
  }

  if (input.note_type !== undefined) {
    if (!input.note_type || !isValidNoteType(input.note_type)) {
      throw new NotesServiceError('note_type is invalid', 400, 'invalid_note_type');
    }
    updates.note_type = input.note_type;
  }

  if (input.status !== undefined) {
    if (!input.status || !isValidNoteStatus(input.status)) {
      throw new NotesServiceError('status is invalid', 400, 'invalid_note_status');
    }
    updates.status = input.status;
  }

  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') {
      throw new NotesServiceError('pinned must be a boolean', 400, 'invalid_pinned');
    }
    updates.pinned = input.pinned;
  }

  if (input.last_reviewed_at !== undefined) {
    updates.last_reviewed_at = asIsoTimestampOrNull(input.last_reviewed_at) ?? null;
  }

  if (Object.keys(updates).length === 0) {
    throw new NotesServiceError('No valid fields to update', 400, 'no_updates');
  }

  const { error } = await supabase
    .from('notes')
    .update(updates)
    .eq('id', noteId)
    .eq('user_id', userId);

  if (error) {
    throw error;
  }

  return getNoteById(supabase, userId, noteId);
}

export async function archiveNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string
): Promise<NoteWithDetails> {
  return updateNote(supabase, userId, noteId, { status: 'archived' });
}

export async function getNoteById(
  supabase: SupabaseClient,
  userId: string,
  noteId: string
): Promise<NoteWithDetails> {
  const note = await requireOwnedNote(supabase, userId, noteId);
  const [hydrated] = await hydrateNotes(supabase, userId, [note]);
  return hydrated;
}

export async function listNotes(
  supabase: SupabaseClient,
  userId: string,
  options: ListNotesOptions = {}
): Promise<NoteWithDetails[]> {
  if (options.note_type && !isValidNoteType(options.note_type)) {
    throw new NotesServiceError('note_type is invalid', 400, 'invalid_note_type');
  }

  if (options.status && !isValidNoteStatus(options.status)) {
    throw new NotesServiceError('status is invalid', 400, 'invalid_note_status');
  }

  if (options.pinned !== undefined && typeof options.pinned !== 'boolean') {
    throw new NotesServiceError('pinned must be a boolean', 400, 'invalid_pinned');
  }

  if (options.link_role && !isValidLinkRole(options.link_role)) {
    throw new NotesServiceError('link_role is invalid', 400, 'invalid_link_role');
  }

  if (options.link_role && (!options.entity_type || !options.entity_id)) {
    throw new NotesServiceError(
      'link_role filtering requires entity_type and entity_id',
      400,
      'invalid_link_role_filter'
    );
  }

  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? clampInteger(options.limit, 1, 200)
    : 50;
  const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
    ? Math.max(0, Math.round(options.offset))
    : 0;

  let noteIdsForEntity: string[] | null = null;

  if (options.entity_type || options.entity_id) {
    if (!options.entity_type || !options.entity_id) {
      throw new NotesServiceError('entity_type and entity_id must be provided together', 400, 'invalid_entity_filter');
    }

    const resolved = await resolveEntityLink(
      supabase,
      userId,
      {
        entity_type: options.entity_type,
        entity_id: options.entity_id,
        link_role: 'reference',
      },
      { validateExists: false }
    );

    const linkRowsResult = options.link_role
      ? await supabase
          .from('note_links')
          .select('note_id')
          .eq('user_id', userId)
          .eq('entity_type', resolved.entity_type)
          .eq('entity_id', resolved.entity_id)
          .eq('link_role', options.link_role)
      : await supabase
          .from('note_links')
          .select('note_id')
          .eq('user_id', userId)
          .eq('entity_type', resolved.entity_type)
          .eq('entity_id', resolved.entity_id);

    const { data: linkRows, error: linkRowsError } = linkRowsResult;

    if (linkRowsError) {
      throw linkRowsError;
    }

    noteIdsForEntity = [...new Set((linkRows || []).map((row) => String(row.note_id)))];
    if (noteIdsForEntity.length === 0) {
      return [];
    }
  }

  let query = supabase
    .from('notes')
    .select('*')
    .eq('user_id', userId)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.note_type) {
    query = query.eq('note_type', options.note_type);
  }

  if (options.status) {
    query = query.eq('status', options.status);
  }

  if (options.pinned !== undefined) {
    query = query.eq('pinned', options.pinned);
  }

  if (noteIdsForEntity) {
    query = query.in('id', noteIdsForEntity);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const notes = ((data || []) as Array<Record<string, unknown>>).map(normalizeNoteRow);
  return hydrateNotes(supabase, userId, notes);
}

export async function linkNoteToEntity(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: LinkNoteToEntityPayload
): Promise<NoteLink> {
  await requireOwnedNote(supabase, userId, noteId);
  const resolved = await resolveEntityLink(supabase, userId, input, { validateExists: true });

  const existingResult = await supabase
    .from('note_links')
    .select('*')
    .eq('user_id', userId)
    .eq('note_id', noteId)
    .eq('entity_type', resolved.entity_type)
    .eq('entity_id', resolved.entity_id)
    .eq('link_role', resolved.link_role)
    .maybeSingle();

  if (existingResult.error) {
    throw existingResult.error;
  }

  if (existingResult.data) {
    throw new NotesServiceError('Note link already exists', 409, 'duplicate_note_link');
  }

  const insertResult = await supabase
    .from('note_links')
    .insert({
      user_id: userId,
      note_id: noteId,
      entity_type: resolved.entity_type,
      entity_id: resolved.entity_id,
      link_role: resolved.link_role,
    })
    .select('*')
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }

  return normalizeNoteLinkRow(insertResult.data as Record<string, unknown>);
}

export async function unlinkNoteFromEntity(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: LinkNoteToEntityPayload
): Promise<{ removed: true }> {
  await requireOwnedNote(supabase, userId, noteId);
  const resolved = await resolveEntityLink(supabase, userId, input, { validateExists: false });

  const existingResult = await supabase
    .from('note_links')
    .select('id')
    .eq('user_id', userId)
    .eq('note_id', noteId)
    .eq('entity_type', resolved.entity_type)
    .eq('entity_id', resolved.entity_id)
    .eq('link_role', resolved.link_role)
    .maybeSingle();

  if (existingResult.error) {
    throw existingResult.error;
  }

  if (!existingResult.data) {
    throw new NotesServiceError('Note link not found', 404, 'note_link_not_found');
  }

  const deleteResult = await supabase
    .from('note_links')
    .delete()
    .eq('id', String((existingResult.data as Record<string, unknown>).id))
    .eq('user_id', userId);

  if (deleteResult.error) {
    throw deleteResult.error;
  }

  return { removed: true };
}

export async function listNotesForEntity(
  supabase: SupabaseClient,
  userId: string,
  entityType: NoteLinkEntityType,
  entityId: string,
  linkRole?: NoteLinkRole
): Promise<NoteWithDetails[]> {
  return listNotes(supabase, userId, {
    entity_type: entityType,
    entity_id: entityId,
    link_role: linkRole,
  });
}

export async function linkTaskToNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: LinkTaskToNotePayload
): Promise<NoteTaskWithTask> {
  await requireOwnedNote(supabase, userId, noteId);

  const taskId = asTrimmedString(input.task_id);
  if (!taskId) {
    throw new NotesServiceError('task_id is required', 400, 'missing_task_id');
  }

  const relationshipType = input.relationship_type ?? 'linked';
  if (!isValidTaskRelationshipType(relationshipType)) {
    throw new NotesServiceError('relationship_type is invalid', 400, 'invalid_relationship_type');
  }

  const task = await requireOwnedTaskSummary(supabase, userId, taskId);

  const existingResult = await supabase
    .from('note_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('note_id', noteId)
    .eq('task_id', taskId)
    .eq('relationship_type', relationshipType)
    .maybeSingle();

  if (existingResult.error) {
    throw existingResult.error;
  }

  if (existingResult.data) {
    throw new NotesServiceError('Task link already exists for this note', 409, 'duplicate_note_task');
  }

  await ensureRelatedTaskEntityLink(supabase, userId, noteId, taskId);

  const insertResult = await supabase
    .from('note_tasks')
    .insert({
      user_id: userId,
      note_id: noteId,
      task_id: taskId,
      relationship_type: relationshipType,
    })
    .select('*')
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }

  return normalizeNoteTaskRow(insertResult.data as Record<string, unknown>, task);
}

export async function createTaskFromNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: CreateTaskFromNotePayload
): Promise<CreateTaskFromNoteResult> {
  await requireOwnedNote(supabase, userId, noteId);

  const title = asTrimmedString(input.title);
  if (!title) {
    throw new NotesServiceError('title is required', 400, 'missing_task_title');
  }

  const status = input.status ?? 'Backlog';
  if (!isValidTaskStatus(status)) {
    throw new NotesServiceError('status is invalid', 400, 'invalid_task_status');
  }

  const taskType = input.task_type ?? 'Admin';
  if (!isValidTaskType(taskType)) {
    throw new NotesServiceError('task_type is invalid', 400, 'invalid_task_type');
  }

  const estimateSource = input.estimate_source ?? 'default';
  if (!isValidEstimateSource(estimateSource)) {
    throw new NotesServiceError('estimate_source is invalid', 400, 'invalid_estimate_source');
  }

  const dueAt = asIsoTimestampOrNull(input.due_at);
  const implementationId = asTrimmedString(input.implementation_id);
  const projectId = asTrimmedString(input.project_id);
  const sprintId = asTrimmedString(input.sprint_id);

  if (implementationId) {
    await requireOwnedEntityId(supabase, userId, 'implementations', implementationId, 'implementation_id is invalid');
  }

  if (projectId) {
    await requireOwnedEntityId(supabase, userId, 'projects', projectId, 'project_id is invalid');
  }

  if (sprintId) {
    await requireOwnedEntityId(supabase, userId, 'sprints', sprintId, 'sprint_id is invalid');
  }

  const relationshipType = input.relationship_type ?? 'created_from';
  if (!isValidTaskRelationshipType(relationshipType)) {
    throw new NotesServiceError('relationship_type is invalid', 400, 'invalid_relationship_type');
  }

  const insertResult = await supabase
    .from('tasks')
    .insert({
      user_id: userId,
      title,
      description: asTrimmedString(input.description) ?? null,
      implementation_id: implementationId,
      project_id: projectId,
      // V1 intentionally leaves note-created tasks unsectioned.
      section_id: null,
      sprint_id: sprintId,
      status,
      task_type: taskType,
      priority_score:
        typeof input.priority_score === 'number' && Number.isFinite(input.priority_score)
          ? clampInteger(input.priority_score, 0, 100)
          : 50,
      estimated_minutes:
        typeof input.estimated_minutes === 'number' && Number.isFinite(input.estimated_minutes)
          ? clampInteger(input.estimated_minutes, 1, 480)
          : 30,
      estimate_source: estimateSource,
      due_at: dueAt ?? null,
      needs_review: input.needs_review === true,
      blocker: input.blocker === true,
      waiting_on: asTrimmedString(input.waiting_on) ?? null,
      stakeholder_mentions: [],
      tags: [],
      source_type: 'Manual',
      source_url: null,
      pinned_excerpt: null,
    })
    .select('id, title, status, estimated_minutes, due_at, blocker, priority_score, updated_at')
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }

  const task = normalizeTaskSummary(insertResult.data as Record<string, unknown>);
  const taskLink = await linkTaskToNote(supabase, userId, noteId, {
    task_id: task.id,
    relationship_type: relationshipType,
  });

  return {
    task,
    task_link: taskLink,
  };
}

export async function createDecisionFromNote(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  input: CreateNoteDecisionPayload
): Promise<NoteDecision> {
  await requireOwnedNote(supabase, userId, noteId);

  const title = asTrimmedString(input.title);
  if (!title) {
    throw new NotesServiceError('title is required', 400, 'missing_decision_title');
  }

  const summary = asTrimmedString(input.summary);
  if (!summary) {
    throw new NotesServiceError('summary is required', 400, 'missing_decision_summary');
  }

  const decisionStatus = input.decision_status ?? 'active';
  if (!isValidDecisionStatus(decisionStatus)) {
    throw new NotesServiceError('decision_status is invalid', 400, 'invalid_decision_status');
  }

  const decidedAt = asIsoTimestampOrNull(input.decided_at);
  const decidedByStakeholderId = asTrimmedString(input.decided_by_stakeholder_id);

  if (decidedByStakeholderId) {
    await requireOwnedStakeholder(supabase, userId, decidedByStakeholderId);
  }

  const insertResult = await supabase
    .from('note_decisions')
    .insert({
      user_id: userId,
      note_id: noteId,
      title,
      summary,
      decision_status: decisionStatus,
      decided_at: decidedAt ?? null,
      decided_by_stakeholder_id: decidedByStakeholderId ?? null,
    })
    .select('*')
    .single();

  if (insertResult.error) {
    throw insertResult.error;
  }

  return normalizeNoteDecisionRow(insertResult.data as Record<string, unknown>);
}

export async function updateDecisionStatus(
  supabase: SupabaseClient,
  userId: string,
  decisionId: string,
  input: UpdateNoteDecisionStatusPayload,
  noteId?: string
): Promise<NoteDecision> {
  const decisionStatus = input.decision_status;
  if (!isValidDecisionStatus(decisionStatus)) {
    throw new NotesServiceError('decision_status is invalid', 400, 'invalid_decision_status');
  }

  let existingQuery = supabase
    .from('note_decisions')
    .select('*')
    .eq('id', decisionId)
    .eq('user_id', userId);

  if (noteId) {
    existingQuery = existingQuery.eq('note_id', noteId);
  }

  const existingResult = await existingQuery.maybeSingle();

  if (existingResult.error) {
    throw existingResult.error;
  }

  if (!existingResult.data) {
    throw new NotesServiceError('Decision not found', 404, 'decision_not_found');
  }

  const decidedAt = asIsoTimestampOrNull(input.decided_at);
  const decidedByStakeholderId = asTrimmedString(input.decided_by_stakeholder_id);

  if (decidedByStakeholderId) {
    await requireOwnedStakeholder(supabase, userId, decidedByStakeholderId);
  }

  let updateQuery = supabase
    .from('note_decisions')
    .update({
      decision_status: decisionStatus,
      decided_at: decidedAt ?? null,
      decided_by_stakeholder_id: decidedByStakeholderId ?? null,
    })
    .eq('id', decisionId)
    .eq('user_id', userId);

  if (noteId) {
    updateQuery = updateQuery.eq('note_id', noteId);
  }

  const updateResult = await updateQuery.select('*').single();

  if (updateResult.error) {
    throw updateResult.error;
  }

  return normalizeNoteDecisionRow(updateResult.data as Record<string, unknown>);
}

export async function createMeetingNote(
  supabase: SupabaseClient,
  userId: string,
  input: CreateMeetingNotePayload
): Promise<NoteWithDetails> {
  const source = input.calendar_event?.source;
  const externalEventId = asTrimmedString(input.calendar_event?.external_event_id);
  const startAt = asTrimmedString(input.calendar_event?.start_at);

  if ((source !== 'local' && source !== 'ical' && source !== 'graph') || !externalEventId || !startAt) {
    throw new NotesServiceError(
      'calendar_event requires source, external_event_id, and start_at',
      400,
      'invalid_calendar_event'
    );
  }

  if (Number.isNaN(Date.parse(startAt))) {
    throw new NotesServiceError('calendar_event.start_at must be a valid ISO timestamp', 400, 'invalid_calendar_start');
  }

  const eventResult = await supabase
    .from('calendar_events')
    .select('source, external_event_id, start_at, title')
    .eq('user_id', userId)
    .eq('source', source)
    .eq('external_event_id', externalEventId)
    .eq('start_at', startAt)
    .maybeSingle();

  if (eventResult.error) {
    throw eventResult.error;
  }

  if (!eventResult.data) {
    throw new NotesServiceError('Calendar event not found', 400, 'calendar_event_not_found');
  }

  const implementationId = asTrimmedString(input.implementation_id);
  const projectId = asTrimmedString(input.project_id);

  if (implementationId) {
    await requireOwnedEntityId(supabase, userId, 'implementations', implementationId, 'implementation_id is invalid');
  }

  if (projectId) {
    await requireOwnedEntityId(supabase, userId, 'projects', projectId, 'project_id is invalid');
  }

  const event = eventResult.data as CalendarEventRow;
  const note = await createNote(supabase, userId, {
    title: asTrimmedString(event.title) ?? 'Meeting',
    body_markdown: typeof input.body_markdown === 'string' ? input.body_markdown : '',
    note_type: 'meeting_note',
    pinned: input.pinned === true,
  });

  await linkNoteToEntity(supabase, userId, note.id, {
    entity_type: 'calendar_event',
    entity_id: buildCalendarEntityId({
      source: event.source,
      externalEventId: event.external_event_id,
      startAt: event.start_at,
    }),
    link_role: 'primary_context',
  });

  if (implementationId) {
    await linkNoteToEntity(supabase, userId, note.id, {
      entity_type: 'implementation',
      entity_id: implementationId,
      link_role: 'meeting_for',
    });
  }

  if (projectId) {
    await linkNoteToEntity(supabase, userId, note.id, {
      entity_type: 'project',
      entity_id: projectId,
      link_role: 'meeting_for',
    });
  }

  return getNoteById(supabase, userId, note.id);
}
