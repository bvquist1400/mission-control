import { buildCalendarEntityId, type CalendarEventIdentity } from "@/lib/calendar-event-identity";
import { IMPLEMENTATION_NOTE_LINK_ROLE, TASK_NOTE_LINK_ROLE } from "@/components/notes/note-panel-utils";
import type {
  CreateNoteDecisionPayload,
  CreateNotePayload,
  CreateTaskFromNotePayload,
  Note,
  NoteDecision,
  NoteLinkEntityType,
  NoteLinkRole,
  NoteStatus,
  NoteTaskWithTask,
  NoteWithDetails,
  UpdateNotePayload,
} from "@/types/database";

interface CreateTaskFromNoteResponse {
  task: NoteTaskWithTask["task"];
  task_link: {
    id: string;
    user_id: string;
    note_id: string;
    task_id: string;
    relationship_type: string;
    created_at: string;
  };
}

export type MeetingNoteEventContext = CalendarEventIdentity;

function buildApiErrorMessage(payload: unknown, fallback: string): string {
  if (
    payload
    && typeof payload === "object"
    && "error" in payload
    && typeof payload.error === "string"
    && payload.error.trim().length > 0
  ) {
    return payload.error;
  }

  return fallback;
}

async function requestJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(buildApiErrorMessage(payload, fallback));
  }

  return payload as T;
}

async function listNotesForEntity(
  entityType: NoteLinkEntityType,
  entityId: string
): Promise<NoteWithDetails[]> {
  const searchParams = new URLSearchParams({
    entity_type: entityType,
    entity_id: entityId,
    limit: "100",
  });

  return requestJson<NoteWithDetails[]>(
    `/api/notes?${searchParams.toString()}`,
    { cache: "no-store" },
    "Failed to load notes"
  );
}

async function createLinkedNote(
  payload: CreateNotePayload,
  link: {
    entityType: NoteLinkEntityType;
    entityId: string;
    linkRole: NoteLinkRole;
  }
): Promise<NoteWithDetails> {
  const note = await requestJson<Note>(
    "/api/notes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "Failed to create note"
  );

  await requestJson(
    `/api/notes/${note.id}/links`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity_type: link.entityType,
        entity_id: link.entityId,
        link_role: link.linkRole,
      }),
    },
    "Failed to link note to entity"
  );

  return getNote(note.id);
}

export async function getNote(noteId: string): Promise<NoteWithDetails> {
  return requestJson<NoteWithDetails>(`/api/notes/${noteId}`, { cache: "no-store" }, "Failed to load note");
}

export async function listImplementationNotes(implementationId: string): Promise<NoteWithDetails[]> {
  return listNotesForEntity("implementation", implementationId);
}

export async function createImplementationNote(
  implementationId: string,
  payload: CreateNotePayload
): Promise<NoteWithDetails> {
  // Implementation-owned notes should link to the implementation as their primary context.
  return createLinkedNote(payload, {
    entityType: "implementation",
    entityId: implementationId,
    linkRole: IMPLEMENTATION_NOTE_LINK_ROLE,
  });
}

export async function listTaskNotes(taskId: string): Promise<NoteWithDetails[]> {
  return listNotesForEntity("task", taskId);
}

export async function createTaskNote(
  taskId: string,
  payload: CreateNotePayload
): Promise<NoteWithDetails> {
  // Task-context notes anchor directly to the task entity; avoid also creating a note_tasks row,
  // which would make the current task show up redundantly as a linked task chip.
  return createLinkedNote(payload, {
    entityType: "task",
    entityId: taskId,
    linkRole: TASK_NOTE_LINK_ROLE,
  });
}

export function buildMeetingNoteEntityId(event: MeetingNoteEventContext): string {
  return buildCalendarEntityId(event);
}

export async function listMeetingNotes(event: MeetingNoteEventContext): Promise<NoteWithDetails[]> {
  return listNotesForEntity("calendar_event", buildMeetingNoteEntityId(event));
}

export async function createMeetingNote(
  event: MeetingNoteEventContext,
  payload: CreateNotePayload
): Promise<NoteWithDetails> {
  return createLinkedNote(payload, {
    entityType: "calendar_event",
    entityId: buildMeetingNoteEntityId(event),
    linkRole: "primary_context",
  });
}

export async function updateExistingNote(noteId: string, payload: UpdateNotePayload): Promise<NoteWithDetails> {
  return requestJson<NoteWithDetails>(
    `/api/notes/${noteId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "Failed to update note"
  );
}

export async function archiveExistingNote(noteId: string): Promise<NoteWithDetails> {
  return requestJson<NoteWithDetails>(
    `/api/notes/${noteId}/archive`,
    { method: "POST" },
    "Failed to archive note"
  );
}

export async function setNoteStatus(noteId: string, status: NoteStatus): Promise<NoteWithDetails> {
  return updateExistingNote(noteId, { status });
}

export async function createTaskFromExistingNote(
  noteId: string,
  payload: CreateTaskFromNotePayload
): Promise<CreateTaskFromNoteResponse> {
  return requestJson<CreateTaskFromNoteResponse>(
    `/api/notes/${noteId}/tasks/create`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "Failed to create task from note"
  );
}

export async function createDecisionFromExistingNote(
  noteId: string,
  payload: CreateNoteDecisionPayload
): Promise<NoteDecision> {
  return requestJson<NoteDecision>(
    `/api/notes/${noteId}/decisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    "Failed to create decision"
  );
}
