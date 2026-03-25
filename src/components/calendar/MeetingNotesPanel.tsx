"use client";

import { ImplementationNoteCard } from "@/components/implementations/ImplementationNoteCard";
import { CreateDecisionFromNoteDialog } from "@/components/notes/CreateDecisionFromNoteDialog";
import { CreateTaskFromNoteDialog } from "@/components/notes/CreateTaskFromNoteDialog";
import { NoteEditorDialog } from "@/components/notes/NoteEditorDialog";
import { NotesPanelShell } from "@/components/notes/NotesPanelShell";
import {
  buildMeetingNoteEntityId,
  createMeetingNote,
  createTaskFromExistingNote,
  listMeetingNotes,
  type MeetingNoteEventContext,
} from "@/components/notes/notes-client";
import { DEFAULT_MEETING_NOTE_TYPE } from "@/components/notes/note-panel-utils";
import { useNotesPanelController } from "@/components/notes/useNotesPanelController";

interface MeetingNotesPanelProps {
  event: MeetingNoteEventContext;
  implementationId?: string | null;
}

function LoadingState() {
  return (
    <div className="mt-3 space-y-2">
      {[1, 2].map((item) => (
        <div key={item} className="animate-pulse rounded-lg border border-stroke bg-panel p-3">
          <div className="h-4 w-32 rounded bg-panel-muted" />
          <div className="mt-3 h-12 rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

export function MeetingNotesPanel({ event, implementationId }: MeetingNotesPanelProps) {
  const eventEntityId = buildMeetingNoteEntityId(event);
  const controller = useNotesPanelController({
    sourceKey: eventEntityId,
    loadNotes: () => listMeetingNotes(event),
    createNote: (payload) => createMeetingNote(event, payload),
    loadErrorMessage: "Failed to load meeting notes",
    actionErrorMessage: "Failed to update note",
    createTaskFromNote: createTaskFromExistingNote,
  });

  return (
    <>
      <NotesPanelShell
        title="Meeting Notes"
        titleAs="h4"
        description="Capture prep, discussion context, decisions, and follow-ups attached to this meeting."
        containerClassName="rounded-lg border border-stroke bg-panel px-3 py-3"
        titleClassName="text-sm font-semibold text-foreground"
        contentSpacingClassName="mt-3"
        listClassName="space-y-3"
        stateClassName="rounded-lg border border-dashed border-stroke bg-panel-muted px-4 py-5 text-center"
        archivedCount={controller.archivedCount}
        showArchived={controller.showArchived}
        onToggleArchived={() => controller.setShowArchived((current) => !current)}
        onCreateNote={controller.openCreateNoteEditor}
        error={controller.error}
        loading={controller.loading}
        loadingState={<LoadingState />}
        visibleNoteCount={controller.visibleNotes.length}
        totalNoteCount={controller.notes.length}
        archivedOnlyMessage="Only archived notes are linked to this meeting right now."
        emptyTitle="No notes linked to this meeting yet."
        emptyDescription="Use this space for prep, meeting decisions, and follow-up context."
      >
        {controller.visibleNotes.map((note) => (
          <ImplementationNoteCard
            key={note.id}
            note={note}
            actionInFlight={controller.actionNoteId === note.id}
            onEdit={controller.openEditNoteEditor}
            onTogglePin={controller.togglePin}
            onToggleArchived={controller.toggleArchived}
            onCreateTask={controller.openTaskDialog}
            onCreateDecision={controller.openDecisionDialog}
          />
        ))}
      </NotesPanelShell>

      <NoteEditorDialog
        open={controller.editorOpen}
        note={controller.editorNote}
        defaultNoteType={DEFAULT_MEETING_NOTE_TYPE}
        linkingDescription="This note will be linked to the current meeting as its primary context."
        onClose={controller.closeEditor}
        onSubmit={controller.submitEditor}
      />

      <CreateTaskFromNoteDialog
        open={!!controller.taskDialogNote}
        note={controller.taskDialogNote}
        implementationId={implementationId}
        onClose={controller.closeTaskDialog}
        onSubmit={controller.submitTask}
      />

      <CreateDecisionFromNoteDialog
        open={!!controller.decisionDialogNote}
        note={controller.decisionDialogNote}
        onClose={controller.closeDecisionDialog}
        onSubmit={controller.submitDecision}
      />
    </>
  );
}
