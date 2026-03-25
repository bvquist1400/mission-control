"use client";

import { ImplementationNoteCard } from "@/components/implementations/ImplementationNoteCard";
import { CreateDecisionFromNoteDialog } from "@/components/notes/CreateDecisionFromNoteDialog";
import { NoteEditorDialog } from "@/components/notes/NoteEditorDialog";
import { NotesPanelShell } from "@/components/notes/NotesPanelShell";
import {
  createTaskNote,
  listTaskNotes,
} from "@/components/notes/notes-client";
import { DEFAULT_TASK_NOTE_TYPE } from "@/components/notes/note-panel-utils";
import { useNotesPanelController } from "@/components/notes/useNotesPanelController";

interface TaskNotesPanelProps {
  taskId: string;
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

export function TaskNotesPanel({ taskId }: TaskNotesPanelProps) {
  const controller = useNotesPanelController({
    sourceKey: taskId,
    loadNotes: () => listTaskNotes(taskId),
    createNote: (payload) => createTaskNote(taskId, payload),
    loadErrorMessage: "Failed to load task notes",
    actionErrorMessage: "Failed to update note",
  });

  return (
    <>
      <NotesPanelShell
        title="Task Notes"
        titleAs="h3"
        description="Keep execution-specific context here when it belongs to the task thread itself."
        containerClassName="rounded-xl border border-stroke bg-panel p-4"
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
        archivedOnlyMessage="Only archived notes are linked to this task right now."
        emptyTitle="No notes linked to this task yet."
        emptyDescription="Use this space for working notes, execution details, and decision remnants tied to the task."
      >
        {controller.visibleNotes.map((note) => (
          <ImplementationNoteCard
            key={note.id}
            note={note}
            actionInFlight={controller.actionNoteId === note.id}
            showCreateTaskAction={false}
            onView={controller.openViewNoteEditor}
            onEdit={controller.openEditNoteEditor}
            onTogglePin={controller.togglePin}
            onToggleArchived={controller.toggleArchived}
            onCreateDecision={controller.openDecisionDialog}
          />
        ))}
      </NotesPanelShell>

      <NoteEditorDialog
        open={controller.editorOpen}
        note={controller.editorNote}
        mode={controller.editorMode}
        onEditRequest={controller.openEditNoteEditor}
        defaultNoteType={DEFAULT_TASK_NOTE_TYPE}
        linkingDescription="This note will be linked to the current task as its primary context."
        onClose={controller.closeEditor}
        onSubmit={controller.submitEditor}
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
