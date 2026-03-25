"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  DEFAULT_IMPLEMENTATION_NOTE_TYPE,
  NOTE_STATUS_OPTIONS,
  NOTE_TYPE_OPTIONS,
  buildNotePreview,
  formatDecisionStatusLabel,
  formatNoteTypeLabel,
  noteInputClass,
  noteLabelClass,
  noteSelectClass,
  noteTextareaClass,
} from "@/components/notes/note-panel-utils";
import { formatRelativeDate } from "@/components/utils/dates";
import type { CreateNotePayload, NoteType, NoteWithDetails, UpdateNotePayload } from "@/types/database";

type NoteDialogMode = "create" | "edit" | "view";

interface NoteEditorDialogProps {
  open: boolean;
  note: NoteWithDetails | null;
  onClose: () => void;
  onSubmit: (payload: CreateNotePayload | UpdateNotePayload) => Promise<void>;
  defaultNoteType?: NoteType;
  linkingDescription?: string;
  mode?: NoteDialogMode;
  onEditRequest?: ((note: NoteWithDetails) => void) | undefined;
}

function formatTimestamp(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NoteEditorDialog({
  open,
  note,
  onClose,
  onSubmit,
  defaultNoteType = DEFAULT_IMPLEMENTATION_NOTE_TYPE,
  linkingDescription = "This note will be linked to the current implementation as its primary context.",
  mode,
  onEditRequest,
}: NoteEditorDialogProps) {
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [noteType, setNoteType] = useState<NoteType>(defaultNoteType);
  const [pinned, setPinned] = useState(false);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolvedMode: NoteDialogMode = mode ?? (note ? "edit" : "create");
  const isEditing = resolvedMode === "edit";
  const isViewing = resolvedMode === "view";
  const showTaskLinks = note?.task_links.filter((taskLink) => taskLink.task) ?? [];

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
    if (isViewing) {
      return;
    }

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

  if (isViewing && note) {
    return (
      <Modal open={open} onClose={onClose} title="View note" size="wide">
        <div className="space-y-6">
          <section className="rounded-xl border border-stroke bg-panel-muted/40 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-2xl font-semibold text-foreground">{note.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Updated {formatRelativeDate(note.updated_at)}
                  {formatTimestamp(note.updated_at) ? ` • ${formatTimestamp(note.updated_at)}` : ""}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-stroke bg-panel px-3 py-1 text-xs font-semibold text-muted-foreground">
                  {formatNoteTypeLabel(note.note_type)}
                </span>
                {note.pinned ? (
                  <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
                    Pinned
                  </span>
                ) : null}
                <span className="rounded-full border border-stroke bg-panel px-3 py-1 text-xs font-semibold text-muted-foreground">
                  {note.status === "archived" ? "Archived" : "Active"}
                </span>
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
            <article className="rounded-xl border border-stroke bg-panel p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Body</p>
              {note.body_markdown.trim() ? (
                <div className="mt-4 whitespace-pre-wrap text-sm leading-7 text-foreground">{note.body_markdown}</div>
              ) : (
                <p className="mt-4 rounded-xl border border-dashed border-stroke bg-panel-muted/45 px-4 py-5 text-sm text-muted-foreground">
                  {buildNotePreview(note.body_markdown)}
                </p>
              )}
            </article>

            <div className="space-y-4">
              <section className="rounded-xl border border-stroke bg-panel p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</p>
                <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <p>{showTaskLinks.length} linked {showTaskLinks.length === 1 ? "task" : "tasks"}</p>
                  <p>{note.decisions.length} {note.decisions.length === 1 ? "decision" : "decisions"}</p>
                  <p>Created {formatTimestamp(note.created_at) ?? "recently"}</p>
                </div>
              </section>

              {showTaskLinks.length > 0 ? (
                <section className="rounded-xl border border-stroke bg-panel p-5">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked Tasks</h4>
                  <div className="mt-3 space-y-2">
                    {showTaskLinks.map((taskLink) => (
                      <div key={taskLink.id} className="rounded-xl border border-stroke bg-panel-muted px-3 py-3">
                        <p className="text-sm font-medium text-foreground">{taskLink.task?.title}</p>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>{taskLink.task?.status}</span>
                          {taskLink.task?.due_at ? <span>Due {formatRelativeDate(taskLink.task.due_at)}</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {note.decisions.length > 0 ? (
                <section className="rounded-xl border border-stroke bg-panel p-5">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Decisions</h4>
                  <div className="mt-3 space-y-2">
                    {note.decisions.map((decision) => (
                      <div key={decision.id} className="rounded-xl border border-stroke bg-panel-muted px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{decision.title}</p>
                          <span className="rounded-full bg-panel px-2 py-1 text-[11px] text-muted-foreground">
                            {formatDecisionStatusLabel(decision.decision_status)}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{decision.summary}</p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Close
            </button>
            {onEditRequest ? (
              <button
                type="button"
                onClick={() => onEditRequest(note)}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              >
                Edit Note
              </button>
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={isEditing ? "Edit note" : "New note"} size="wide">
      <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
          <div className="space-y-5">
            <label className="block space-y-1">
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

            <label className="block space-y-1">
              <span className={noteLabelClass}>Body</span>
              <textarea
                rows={16}
                value={bodyMarkdown}
                onChange={(event) => setBodyMarkdown(event.target.value)}
                disabled={isSaving}
                placeholder="Capture implementation context, prep, open questions, or working notes..."
                className={noteTextareaClass}
              />
            </label>
          </div>

          <div className="space-y-4">
            <section className="rounded-xl border border-stroke bg-panel-muted/45 p-4">
              <h3 className="text-sm font-semibold text-foreground">Note Settings</h3>
              <div className="mt-4 space-y-4">
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
                    <p className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-muted-foreground">
                      {linkingDescription}
                    </p>
                  </div>
                )}

                <label className="flex items-center justify-between rounded-lg border border-stroke bg-panel px-3 py-3">
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
            </section>

            <section className="rounded-xl border border-stroke bg-panel-muted/45 p-4">
              <h3 className="text-sm font-semibold text-foreground">Preview</h3>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{buildNotePreview(bodyMarkdown, 420)}</p>
            </section>
          </div>
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
