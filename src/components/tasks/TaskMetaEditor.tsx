"use client";

import { useState } from "react";
import type { TaskType, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

export const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "Task", label: "Task" },
  { value: "Admin", label: "Admin" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Build", label: "Build" },
];

interface TaskMetaEditorProps {
  task: TaskWithImplementation;
  isSaving: boolean;
  onUpdate: (taskId: string, updates: TaskUpdatePayload) => Promise<void>;
}

export function TaskMetaEditor({ task, isSaving, onUpdate }: TaskMetaEditorProps) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  const [taskTypeDraft, setTaskTypeDraft] = useState<TaskType>(task.task_type);
  const [waitingOnDraft, setWaitingOnDraft] = useState(task.waiting_on ?? "");

  const normalizedTitle = titleDraft.trim();
  const normalizedDescription = descriptionDraft.trim();
  const normalizedWaitingOn = waitingOnDraft.trim();
  const nextWaitingOn = normalizedWaitingOn.length > 0 ? normalizedWaitingOn : null;
  const nextDescription = normalizedDescription.length > 0 ? normalizedDescription : null;

  const hasChanges =
    normalizedTitle !== task.title
    || taskTypeDraft !== task.task_type
    || nextWaitingOn !== task.waiting_on
    || nextDescription !== task.description;
  const canSave = normalizedTitle.length > 0 && hasChanges && !isSaving;

  function saveEdits() {
    if (!canSave) {
      return;
    }

    const updates: TaskUpdatePayload = {};
    if (normalizedTitle !== task.title) {
      updates.title = normalizedTitle;
    }
    if (taskTypeDraft !== task.task_type) {
      updates.task_type = taskTypeDraft;
    }
    if (nextWaitingOn !== task.waiting_on) {
      updates.waiting_on = nextWaitingOn;
    }
    if (nextDescription !== task.description) {
      updates.description = nextDescription;
    }

    if (Object.keys(updates).length > 0) {
      void onUpdate(task.id, updates);
    }
  }

  return (
    <section className="rounded-lg border border-stroke bg-panel p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Details</h4>
        <button
          type="button"
          onClick={saveEdits}
          disabled={!canSave}
          className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save edits"}
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isSaving}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Type</span>
          <select
            value={taskTypeDraft}
            onChange={(event) => setTaskTypeDraft(event.target.value as TaskType)}
            disabled={isSaving}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {TASK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Waiting On</span>
          <input
            value={waitingOnDraft}
            onChange={(event) => setWaitingOnDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isSaving}
            placeholder={task.status === "Blocked/Waiting" ? "Who or what is this waiting on?" : "Optional context"}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      </div>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</span>
        <textarea
          value={descriptionDraft}
          onChange={(event) => setDescriptionDraft(event.target.value)}
          disabled={isSaving}
          rows={4}
          placeholder="Add context, links, and detailed notes for this task..."
          className="w-full resize-y rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>
    </section>
  );
}
