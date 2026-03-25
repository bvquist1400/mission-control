"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  DEFAULT_IMPLEMENTATION_NOTE_TYPE,
  NOTE_STATUS_OPTIONS,
  NOTE_TYPE_OPTIONS,
  noteInputClass,
  noteLabelClass,
  noteSelectClass,
  noteTextareaClass,
} from "@/components/notes/note-panel-utils";
import type { CreateNotePayload, NoteType, NoteWithDetails, UpdateNotePayload } from "@/types/database";

interface NoteEditorDialogProps {
  open: boolean;
  note: NoteWithDetails | null;
  onClose: () => void;
  onSubmit: (payload: CreateNotePayload | UpdateNotePayload) => Promise<void>;
  defaultNoteType?: NoteType;
  linkingDescription?: string;
}

export function NoteEditorDialog({
  open,
  note,
  onClose,
  onSubmit,
  defaultNoteType = DEFAULT_IMPLEMENTATION_NOTE_TYPE,
  linkingDescription = "This note will be linked to the current implementation as its primary context.",
}: NoteEditorDialogProps) {
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [noteType, setNoteType] = useState<NoteType>(defaultNoteType);
  const [pinned, setPinned] = useState(false);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!note;

  useEffect(() => {
    if (!open) {
      return;
    }

    setTitle(note?.title ?? "");
    setBodyMarkdown(note?.body_markdown ?? "");
    setNoteType(note?.note_type ?? defaultNoteType);
    setPinned(note?.pinned ?? false);
    setStatus(note?.status ?? "active");
    setError(null);
    setIsSaving(false);
  }, [defaultNoteType, note, open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setError("Note title is required");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onSubmit({
        title: title.trim(),
        body_markdown: bodyMarkdown.trim(),
        note_type: noteType,
        pinned,
        ...(isEditing ? { status } : {}),
      });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save note");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEditing ? "Edit note" : "New note"}>
      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={noteLabelClass}>Title</span>
            <input
              autoFocus
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isSaving}
              placeholder="What context should this preserve?"
              className={noteInputClass}
            />
          </label>

          <label className="space-y-1">
            <span className={noteLabelClass}>Note Type</span>
            <select
              value={noteType}
              onChange={(event) => setNoteType(event.target.value as NoteType)}
              disabled={isSaving}
              className={noteSelectClass}
            >
              {NOTE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block space-y-1">
          <span className={noteLabelClass}>Body</span>
          <textarea
            rows={8}
            value={bodyMarkdown}
            onChange={(event) => setBodyMarkdown(event.target.value)}
            disabled={isSaving}
            placeholder="Capture implementation context, prep, open questions, or working notes..."
            className={noteTextareaClass}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          {isEditing ? (
            <label className="space-y-1">
              <span className={noteLabelClass}>Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as "active" | "archived")}
                disabled={isSaving}
                className={noteSelectClass}
              >
                {NOTE_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="space-y-1">
              <span className={noteLabelClass}>Linking</span>
              <p className="rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-muted-foreground">
                {linkingDescription}
              </p>
            </div>
          )}

          <label className="flex items-center justify-between rounded-lg border border-stroke bg-panel-muted px-3 py-3">
            <span>
              <span className={noteLabelClass}>Pinned</span>
              <p className="mt-1 text-sm text-muted-foreground">Keep this note at the top of the panel.</p>
            </span>
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
              disabled={isSaving}
              className="h-4 w-4 rounded border-stroke text-accent focus:ring-accent/30"
            />
          </label>
        </div>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving || !title.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : isEditing ? "Save changes" : "Create note"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
