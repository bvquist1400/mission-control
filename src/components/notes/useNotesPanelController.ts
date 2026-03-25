"use client";

import { useEffect, useEffectEvent, useState } from "react";
import {
  archiveExistingNote,
  createDecisionFromExistingNote,
  setNoteStatus,
  updateExistingNote,
} from "@/components/notes/notes-client";
import { filterNotesForPanel, sortNotesForPanel } from "@/components/notes/note-panel-utils";
import type {
  CreateNoteDecisionPayload,
  CreateNotePayload,
  CreateTaskFromNotePayload,
  NoteWithDetails,
  UpdateNotePayload,
} from "@/types/database";

type NoteEditorMode = "create" | "edit" | "view";

interface UseNotesPanelControllerOptions {
  sourceKey: string;
  loadNotes: () => Promise<NoteWithDetails[]>;
  createNote: (payload: CreateNotePayload) => Promise<unknown>;
  loadErrorMessage: string;
  actionErrorMessage: string;
  createTaskFromNote?: (noteId: string, payload: CreateTaskFromNotePayload) => Promise<unknown>;
}

export function useNotesPanelController({
  sourceKey,
  loadNotes,
  createNote,
  loadErrorMessage,
  actionErrorMessage,
  createTaskFromNote,
}: UseNotesPanelControllerOptions) {
  const [notes, setNotes] = useState<NoteWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editorNote, setEditorNote] = useState<NoteWithDetails | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<NoteEditorMode>("create");
  const [taskDialogNote, setTaskDialogNote] = useState<NoteWithDetails | null>(null);
  const [decisionDialogNote, setDecisionDialogNote] = useState<NoteWithDetails | null>(null);
  const [actionNoteId, setActionNoteId] = useState<string | null>(null);

  const loadNotesInEffect = useEffectEvent(loadNotes);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const loadedNotes = await loadNotesInEffect();
        if (!isMounted) {
          return;
        }
        setNotes(sortNotesForPanel(loadedNotes));
      } catch (loadError) {
        if (!isMounted) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : loadErrorMessage);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      isMounted = false;
    };
  }, [loadErrorMessage, sourceKey]);

  async function refreshNotes(): Promise<void> {
    const loadedNotes = await loadNotes();
    setNotes(sortNotesForPanel(loadedNotes));
  }

  function openCreateNoteEditor(): void {
    setEditorNote(null);
    setEditorMode("create");
    setEditorOpen(true);
  }

  function openEditNoteEditor(note: NoteWithDetails): void {
    setEditorNote(note);
    setEditorMode("edit");
    setEditorOpen(true);
  }

  function openViewNoteEditor(note: NoteWithDetails): void {
    setEditorNote(note);
    setEditorMode("view");
    setEditorOpen(true);
  }

  function closeEditor(): void {
    setEditorOpen(false);
    setEditorNote(null);
    setEditorMode("create");
  }

  async function submitEditor(payload: CreateNotePayload | UpdateNotePayload): Promise<void> {
    if (editorNote) {
      await updateExistingNote(editorNote.id, payload as UpdateNotePayload);
    } else {
      await createNote(payload as CreateNotePayload);
    }

    await refreshNotes();
  }

  async function togglePin(note: NoteWithDetails): Promise<void> {
    setActionNoteId(note.id);
    setError(null);

    try {
      await updateExistingNote(note.id, { pinned: !note.pinned });
      await refreshNotes();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : actionErrorMessage);
    } finally {
      setActionNoteId(null);
    }
  }

  async function toggleArchived(note: NoteWithDetails): Promise<void> {
    setActionNoteId(note.id);
    setError(null);

    try {
      if (note.status === "archived") {
        await setNoteStatus(note.id, "active");
      } else {
        await archiveExistingNote(note.id);
      }
      await refreshNotes();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : actionErrorMessage);
    } finally {
      setActionNoteId(null);
    }
  }

  function openTaskDialog(note: NoteWithDetails): void {
    setTaskDialogNote(note);
  }

  function closeTaskDialog(): void {
    setTaskDialogNote(null);
  }

  async function submitTask(payload: CreateTaskFromNotePayload): Promise<void> {
    if (!taskDialogNote || !createTaskFromNote) {
      return;
    }

    await createTaskFromNote(taskDialogNote.id, payload);
    await refreshNotes();
  }

  function openDecisionDialog(note: NoteWithDetails): void {
    setDecisionDialogNote(note);
  }

  function closeDecisionDialog(): void {
    setDecisionDialogNote(null);
  }

  async function submitDecision(payload: CreateNoteDecisionPayload): Promise<void> {
    if (!decisionDialogNote) {
      return;
    }

    await createDecisionFromExistingNote(decisionDialogNote.id, payload);
    await refreshNotes();
  }

  return {
    notes,
    visibleNotes: filterNotesForPanel(notes, showArchived),
    archivedCount: notes.filter((note) => note.status === "archived").length,
    loading,
    error,
    showArchived,
    actionNoteId,
    editorNote,
    editorOpen,
    editorMode,
    taskDialogNote,
    decisionDialogNote,
    setShowArchived,
    openCreateNoteEditor,
    openEditNoteEditor,
    openViewNoteEditor,
    closeEditor,
    submitEditor,
    togglePin,
    toggleArchived,
    openTaskDialog,
    closeTaskDialog,
    submitTask,
    openDecisionDialog,
    closeDecisionDialog,
    submitDecision,
  };
}
