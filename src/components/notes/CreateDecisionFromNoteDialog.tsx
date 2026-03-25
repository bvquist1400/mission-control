"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { localDateInputToEndOfDayIso } from "@/components/utils/dates";
import {
  DECISION_STATUS_OPTIONS,
  noteInputClass,
  noteLabelClass,
  noteSelectClass,
  noteTextareaClass,
} from "@/components/notes/note-panel-utils";
import type { CreateNoteDecisionPayload, NoteDecisionStatus, NoteWithDetails } from "@/types/database";

interface CreateDecisionFromNoteDialogProps {
  open: boolean;
  note: NoteWithDetails | null;
  onClose: () => void;
  onSubmit: (payload: CreateNoteDecisionPayload) => Promise<void>;
}

export function CreateDecisionFromNoteDialog({
  open,
  note,
  onClose,
  onSubmit,
}: CreateDecisionFromNoteDialogProps) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [decisionStatus, setDecisionStatus] = useState<NoteDecisionStatus>("active");
  const [decidedAt, setDecidedAt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !note) {
      return;
    }

    setTitle(note.title);
    setSummary("");
    setDecisionStatus("active");
    setDecidedAt("");
    setError(null);
    setIsSaving(false);
  }, [note, open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setError("Decision title is required");
      return;
    }

    if (!summary.trim()) {
      setError("Decision summary is required");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onSubmit({
        title: title.trim(),
        summary: summary.trim(),
        decision_status: decisionStatus,
        decided_at: decidedAt ? localDateInputToEndOfDayIso(decidedAt) : null,
      });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create decision");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add decision">
      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <label className="block space-y-1">
          <span className={noteLabelClass}>Decision Title</span>
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={isSaving}
            placeholder="What was decided?"
            className={noteInputClass}
          />
        </label>

        <label className="block space-y-1">
          <span className={noteLabelClass}>Summary</span>
          <textarea
            rows={5}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            disabled={isSaving}
            placeholder="Capture the decision in a few crisp sentences."
            className={noteTextareaClass}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={noteLabelClass}>Status</span>
            <select
              value={decisionStatus}
              onChange={(event) => setDecisionStatus(event.target.value as NoteDecisionStatus)}
              disabled={isSaving}
              className={noteSelectClass}
            >
              {DECISION_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className={noteLabelClass}>Decided At</span>
            <input
              type="date"
              value={decidedAt}
              onChange={(event) => setDecidedAt(event.target.value)}
              disabled={isSaving}
              className={noteInputClass}
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
            disabled={isSaving || !title.trim() || !summary.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Add decision"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
