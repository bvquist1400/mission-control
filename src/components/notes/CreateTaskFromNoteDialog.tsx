"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { localDateInputToEndOfDayIso } from "@/components/utils/dates";
import {
  TASK_TYPE_OPTIONS,
  noteInputClass,
  noteLabelClass,
  noteSelectClass,
  noteTextareaClass,
} from "@/components/notes/note-panel-utils";
import type { CreateTaskFromNotePayload, NoteWithDetails, TaskType } from "@/types/database";

interface CreateTaskFromNoteDialogProps {
  open: boolean;
  note: NoteWithDetails | null;
  implementationId?: string | null;
  onClose: () => void;
  onSubmit: (payload: CreateTaskFromNotePayload) => Promise<void>;
}

export function CreateTaskFromNoteDialog({
  open,
  note,
  implementationId,
  onClose,
  onSubmit,
}: CreateTaskFromNoteDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("Task");
  const [priorityScore, setPriorityScore] = useState("50");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !note) {
      return;
    }

    setTitle(note.title);
    setDescription("");
    setDueDate("");
    setTaskType("Task");
    setPriorityScore("50");
    setError(null);
    setIsSaving(false);
  }, [note, open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setError("Task title is required");
      return;
    }

    const parsedPriority = priorityScore.trim().length > 0 ? Number.parseInt(priorityScore, 10) : undefined;
    if (parsedPriority !== undefined && (!Number.isFinite(parsedPriority) || parsedPriority < 0 || parsedPriority > 100)) {
      setError("Priority must be between 0 and 100");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        implementation_id: implementationId ?? null,
        status: "Backlog",
        task_type: taskType,
        due_at: dueDate ? localDateInputToEndOfDayIso(dueDate) : null,
        priority_score: parsedPriority,
        relationship_type: "created_from",
      });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create task");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create task from note">
      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <label className="block space-y-1">
          <span className={noteLabelClass}>Task Title</span>
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={isSaving}
            placeholder="Follow-up task title"
            className={noteInputClass}
          />
        </label>

        <label className="block space-y-1">
          <span className={noteLabelClass}>Description</span>
          <textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={isSaving}
            placeholder="Optional task detail or next-step context"
            className={noteTextareaClass}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1">
            <span className={noteLabelClass}>Task Type</span>
            <select
              value={taskType}
              onChange={(event) => setTaskType(event.target.value as TaskType)}
              disabled={isSaving}
              className={noteSelectClass}
            >
              {TASK_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className={noteLabelClass}>Due Date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              disabled={isSaving}
              className={noteInputClass}
            />
          </label>

          <label className="space-y-1">
            <span className={noteLabelClass}>Priority</span>
            <input
              type="number"
              min={0}
              max={100}
              value={priorityScore}
              onChange={(event) => setPriorityScore(event.target.value)}
              disabled={isSaving}
              className={noteInputClass}
            />
          </label>
        </div>

        <p className="rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-muted-foreground">
          {implementationId
            ? (
              <>
                The task will default to this implementation and link back to the note as{" "}
                <span className="font-medium text-foreground">created from</span>.
              </>
            ) : (
              <>
                The task will link back to the note as{" "}
                <span className="font-medium text-foreground">created from</span>.
              </>
            )}
        </p>

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
            {isSaving ? "Creating..." : "Create task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
