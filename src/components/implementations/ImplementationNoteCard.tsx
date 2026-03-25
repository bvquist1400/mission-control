"use client";

import { formatRelativeDate } from "@/components/utils/dates";
import {
  buildNotePreview,
  formatDecisionStatusLabel,
  formatNoteTypeLabel,
} from "@/components/notes/note-panel-utils";
import type { NoteWithDetails } from "@/types/database";

interface ImplementationNoteCardProps {
  note: NoteWithDetails;
  actionInFlight: boolean;
  onEdit: (note: NoteWithDetails) => void;
  onTogglePin: (note: NoteWithDetails) => Promise<void>;
  onToggleArchived: (note: NoteWithDetails) => Promise<void>;
  onCreateTask?: (note: NoteWithDetails) => void;
  onCreateDecision: (note: NoteWithDetails) => void;
  showCreateTaskAction?: boolean;
}

function formatUpdatedAt(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "Updated recently";
  }

  return `Updated ${formatRelativeDate(timestamp)}`;
}

function formatTimestamp(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function actionButtonClass(emphasis = false): string {
  return [
    "rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
    emphasis
      ? "bg-accent text-white hover:opacity-90"
      : "border border-stroke bg-panel text-muted-foreground hover:text-foreground",
  ].join(" ");
}

export function ImplementationNoteCard({
  note,
  actionInFlight,
  onEdit,
  onTogglePin,
  onToggleArchived,
  onCreateTask,
  onCreateDecision,
  showCreateTaskAction = true,
}: ImplementationNoteCardProps) {
  const taskCount = note.task_links.length;
  const decisionCount = note.decisions.length;

  return (
    <article
      className={`rounded-xl border p-4 shadow-sm transition ${
        note.pinned
          ? "border-accent/40 bg-panel"
          : "border-stroke bg-panel"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-foreground">{note.title}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-panel-muted px-2 py-1">{formatNoteTypeLabel(note.note_type)}</span>
            {note.pinned && <span className="rounded-full bg-accent/10 px-2 py-1 text-accent">Pinned</span>}
            {note.status === "archived" && (
              <span className="rounded-full bg-slate-200 px-2 py-1 text-slate-700">Archived</span>
            )}
            {taskCount > 0 && (
              <span className="rounded-full bg-panel-muted px-2 py-1">
                {taskCount} {taskCount === 1 ? "task" : "tasks"}
              </span>
            )}
            {decisionCount > 0 && (
              <span className="rounded-full bg-panel-muted px-2 py-1">
                {decisionCount} {decisionCount === 1 ? "decision" : "decisions"}
              </span>
            )}
            <span title={new Date(note.updated_at).toLocaleString()}>{formatUpdatedAt(note.updated_at)}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void onTogglePin(note)}
            disabled={actionInFlight}
            className={actionButtonClass(note.pinned)}
          >
            {note.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            onClick={() => onEdit(note)}
            disabled={actionInFlight}
            className={actionButtonClass()}
          >
            Edit
          </button>
          {showCreateTaskAction && onCreateTask ? (
            <button
              type="button"
              onClick={() => onCreateTask(note)}
              disabled={actionInFlight}
              className={actionButtonClass()}
            >
              Create Task
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onCreateDecision(note)}
            disabled={actionInFlight}
            className={actionButtonClass()}
          >
            Add Decision
          </button>
          <button
            type="button"
            onClick={() => void onToggleArchived(note)}
            disabled={actionInFlight}
            className={actionButtonClass()}
          >
            {note.status === "archived" ? "Restore" : "Archive"}
          </button>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-muted-foreground">{buildNotePreview(note.body_markdown)}</p>

      {taskCount > 0 && (
        <section className="mt-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked Tasks</h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {note.task_links
              .filter((taskLink) => taskLink.task)
              .map((taskLink) => (
                <div
                  key={taskLink.id}
                  className="rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-xs text-foreground"
                >
                  <div className="font-medium">{taskLink.task?.title}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-muted-foreground">
                    <span>{taskLink.task?.status}</span>
                    {taskLink.task?.due_at && <span>Due {formatRelativeDate(taskLink.task.due_at)}</span>}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {decisionCount > 0 && (
        <section className="mt-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Decisions</h4>
          <div className="space-y-2">
            {note.decisions.map((decision) => (
              <div key={decision.id} className="rounded-lg border border-stroke bg-panel-muted px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="text-sm font-medium text-foreground">{decision.title}</h5>
                  <span className="rounded-full bg-panel px-2 py-1 text-[11px] text-muted-foreground">
                    {formatDecisionStatusLabel(decision.decision_status)}
                  </span>
                  {decision.decided_at && (
                    <span className="text-[11px] text-muted-foreground">{formatTimestamp(decision.decided_at)}</span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{decision.summary}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
