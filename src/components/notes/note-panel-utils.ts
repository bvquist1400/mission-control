import type {
  NoteDecisionStatus,
  NoteLinkRole,
  NoteStatus,
  NoteType,
  NoteWithDetails,
  TaskType,
} from "@/types/database";

export const noteInputClass =
  "w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
export const noteSelectClass =
  "w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
export const noteTextareaClass =
  "w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
export const noteLabelClass = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export const IMPLEMENTATION_NOTE_LINK_ROLE: NoteLinkRole = "primary_context";
export const TASK_NOTE_LINK_ROLE: NoteLinkRole = "primary_context";
export const DEFAULT_IMPLEMENTATION_NOTE_TYPE: NoteType = "application_note";
export const DEFAULT_MEETING_NOTE_TYPE: NoteType = "meeting_note";
export const DEFAULT_TASK_NOTE_TYPE: NoteType = "working_note";

export const NOTE_TYPE_OPTIONS: { value: NoteType; label: string }[] = [
  { value: "application_note", label: "Implementation note" },
  { value: "working_note", label: "Working note" },
  { value: "prep_note", label: "Prep note" },
  { value: "decision_note", label: "Decision note" },
  { value: "retrospective_note", label: "Retrospective note" },
  { value: "meeting_note", label: "Meeting note" },
];

export const NOTE_STATUS_OPTIONS: { value: NoteStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export const DECISION_STATUS_OPTIONS: { value: NoteDecisionStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "superseded", label: "Superseded" },
  { value: "reversed", label: "Reversed" },
];

export const TASK_TYPE_OPTIONS: { value: TaskType; label: string }[] = [
  { value: "Task", label: "Task" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Admin", label: "Admin" },
  { value: "Build", label: "Build" },
];

const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  working_note: "Working note",
  meeting_note: "Meeting note",
  application_note: "Implementation note",
  decision_note: "Decision note",
  prep_note: "Prep note",
  retrospective_note: "Retrospective note",
};

const DECISION_STATUS_LABELS: Record<NoteDecisionStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  reversed: "Reversed",
};

export function formatNoteTypeLabel(noteType: NoteType): string {
  return NOTE_TYPE_LABELS[noteType] ?? noteType;
}

export function formatDecisionStatusLabel(status: NoteDecisionStatus): string {
  return DECISION_STATUS_LABELS[status] ?? status;
}

export function buildNotePreview(bodyMarkdown: string, maxLength = 220): string {
  const normalized = bodyMarkdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[`*_>#]/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "No details yet.";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function sortNotesForPanel(notes: NoteWithDetails[]): NoteWithDetails[] {
  return [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const updatedDelta = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

export function filterNotesForPanel(notes: NoteWithDetails[], showArchived: boolean): NoteWithDetails[] {
  if (showArchived) {
    return notes;
  }

  return notes.filter((note) => note.status !== "archived");
}
