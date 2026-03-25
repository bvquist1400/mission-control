"use client";

import { CreateDecisionFromNoteDialog } from "@/components/notes/CreateDecisionFromNoteDialog";
import { CreateTaskFromNoteDialog } from "@/components/notes/CreateTaskFromNoteDialog";
import { NoteEditorDialog } from "@/components/notes/NoteEditorDialog";
import { NotesPanelShell } from "@/components/notes/NotesPanelShell";
import {
  createImplementationNote,
  createTaskFromExistingNote,
  listImplementationNotes,
} from "@/components/notes/notes-client";
import { useNotesPanelController } from "@/components/notes/useNotesPanelController";
import { ImplementationNoteCard } from "./ImplementationNoteCard";

interface ImplementationNotesPanelProps {
  implementationId: string;
}

function LoadingState() {
  return (
    <div className="mt-4 space-y-3">
      {[1, 2].map((item) => (
        <div key={item} className="animate-pulse rounded-xl border border-stroke bg-panel p-4">
          <div className="h-5 w-40 rounded bg-panel-muted" />
          <div className="mt-3 h-4 w-60 rounded bg-panel-muted" />
          <div className="mt-4 h-16 rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

export function ImplementationNotesPanel({ implementationId }: ImplementationNotesPanelProps) {
  const controller = useNotesPanelController({
    sourceKey: implementationId,
    loadNotes: () => listImplementationNotes(implementationId),
    createNote: (payload) => createImplementationNote(implementationId, payload),
    loadErrorMessage: "Failed to load notes",
    actionErrorMessage: "Failed to update note",
    createTaskFromNote: createTaskFromExistingNote,
  });

  return (
    <>
      <NotesPanelShell
        title="Notes"
        titleAs="h2"
        description="Capture implementation-specific context, prep, decisions, and working notes without leaving this page."
        containerClassName="rounded-card border border-stroke bg-panel p-5 shadow-sm"
        titleClassName="text-sm font-semibold text-foreground"
        contentSpacingClassName="mt-4"
        listClassName="space-y-3"
        stateClassName="rounded-xl border border-dashed border-stroke bg-panel-muted px-4 py-6 text-center"
        archivedCount={controller.archivedCount}
        showArchived={controller.showArchived}
        onToggleArchived={() => controller.setShowArchived((current) => !current)}
        onCreateNote={controller.openCreateNoteEditor}
        error={controller.error}
        loading={controller.loading}
        loadingState={<LoadingState />}
        visibleNoteCount={controller.visibleNotes.length}
        totalNoteCount={controller.notes.length}
        archivedOnlyMessage="Only archived notes are linked to this implementation right now."
        emptyTitle="No notes linked to this implementation yet."
        emptyDescription="Keep implementation-specific context here when it changes execution quality."
        emptyActionLabel="Create the first note"
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
