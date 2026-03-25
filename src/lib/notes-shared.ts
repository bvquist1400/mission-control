import type {
  EstimateSource,
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
  TaskStatus,
  TaskSummary,
  TaskType,
} from '@/types/database';

export const NOTE_TYPES: NoteType[] = [
  'working_note',
  'meeting_note',
  'application_note',
  'decision_note',
  'prep_note',
  'retrospective_note',
];

export const NOTE_STATUSES: NoteStatus[] = ['active', 'archived'];

export const NOTE_LINK_ENTITY_TYPES: NoteLinkEntityType[] = [
  'task',
  'calendar_event',
  'implementation',
  'project',
  'stakeholder',
  'commitment',
  'sprint',
];

export const NOTE_LINK_ROLES: NoteLinkRole[] = [
  'primary_context',
  'meeting_for',
  'related_task',
  'decision_about',
  'prep_for',
  'reference',
];

export const NOTE_TASK_RELATIONSHIP_TYPES: NoteTaskRelationshipType[] = [
  'linked',
  'created_from',
  'discussed_in',
];

export const NOTE_DECISION_STATUSES: NoteDecisionStatus[] = ['active', 'superseded', 'reversed'];

const VALID_TASK_STATUSES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done'];
const VALID_TASK_TYPES: TaskType[] = ['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'];
const VALID_ESTIMATE_SOURCES: EstimateSource[] = ['default', 'llm', 'manual'];

export class NotesServiceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'notes_error') {
    super(message);
    this.name = 'NotesServiceError';
    this.status = status;
    this.code = code;
  }
}

export function isValidNoteType(value: string): value is NoteType {
  return NOTE_TYPES.includes(value as NoteType);
}

export function isValidNoteStatus(value: string): value is NoteStatus {
  return NOTE_STATUSES.includes(value as NoteStatus);
}

export function isValidLinkEntityType(value: string): value is NoteLinkEntityType {
  return NOTE_LINK_ENTITY_TYPES.includes(value as NoteLinkEntityType);
}

export function isValidLinkRole(value: string): value is NoteLinkRole {
  return NOTE_LINK_ROLES.includes(value as NoteLinkRole);
}

export function isValidTaskRelationshipType(value: string): value is NoteTaskRelationshipType {
  return NOTE_TASK_RELATIONSHIP_TYPES.includes(value as NoteTaskRelationshipType);
}

export function isValidDecisionStatus(value: string): value is NoteDecisionStatus {
  return NOTE_DECISION_STATUSES.includes(value as NoteDecisionStatus);
}

export function isValidTaskStatus(value: string): value is TaskStatus {
  return VALID_TASK_STATUSES.includes(value as TaskStatus);
}

export function isValidTaskType(value: string): value is TaskType {
  return VALID_TASK_TYPES.includes(value as TaskType);
}

export function isValidEstimateSource(value: string): value is EstimateSource {
  return VALID_ESTIMATE_SOURCES.includes(value as EstimateSource);
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asIsoTimestampOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  if (Number.isNaN(Date.parse(trimmed))) {
    throw new NotesServiceError('Timestamp must be a valid ISO string', 400, 'invalid_timestamp');
  }

  return trimmed;
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function normalizeTaskSummary(row: Record<string, unknown>): TaskSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskStatus,
    estimated_minutes: Number(row.estimated_minutes ?? 0),
    due_at: typeof row.due_at === 'string' ? row.due_at : null,
    blocker: Boolean(row.blocker),
    priority_score: typeof row.priority_score === 'number' ? row.priority_score : undefined,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  };
}

export function normalizeNoteRow(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title),
    body_markdown: typeof row.body_markdown === 'string' ? row.body_markdown : '',
    note_type: row.note_type as NoteType,
    status: row.status as NoteStatus,
    pinned: Boolean(row.pinned),
    last_reviewed_at: typeof row.last_reviewed_at === 'string' ? row.last_reviewed_at : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function normalizeNoteLinkRow(row: Record<string, unknown>): NoteLink {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    note_id: String(row.note_id),
    entity_type: row.entity_type as NoteLinkEntityType,
    entity_id: String(row.entity_id),
    link_role: row.link_role as NoteLinkRole,
    created_at: String(row.created_at),
  };
}

export function normalizeNoteTaskRow(row: Record<string, unknown>, task: TaskSummary | null): NoteTaskWithTask {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    note_id: String(row.note_id),
    task_id: String(row.task_id),
    relationship_type: row.relationship_type as NoteTaskRelationshipType,
    created_at: String(row.created_at),
    task,
  };
}

export function normalizeNoteDecisionRow(row: Record<string, unknown>): NoteDecision {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    note_id: String(row.note_id),
    title: String(row.title),
    summary: String(row.summary),
    decision_status: row.decision_status as NoteDecisionStatus,
    decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
    decided_by_stakeholder_id:
      typeof row.decided_by_stakeholder_id === 'string' ? row.decided_by_stakeholder_id : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
