"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { TaskMetaEditor } from "@/components/tasks/TaskMetaEditor";
import { TaskNotesPanel } from "@/components/tasks/TaskNotesPanel";
import { ChecklistSection } from "@/components/tasks/ChecklistSection";
import { TaskComments } from "@/components/tasks/TaskComments";
import { TaskDependencies } from "@/components/tasks/TaskDependencies";
import { StatusSelector } from "@/components/ui/StatusSelector";
import { useTaskDetail } from "@/hooks/useTaskDetail";
import type {
  CommitmentSummary,
  TaskUpdatePayload,
  TaskWithImplementation,
} from "@/types/database";

interface TaskDetailModalProps {
  task: TaskWithImplementation | null;
  allTasks: TaskWithImplementation[];
  commitments: CommitmentSummary[];
  onClose: () => void;
  onTaskUpdated: (taskId: string, updates: TaskUpdatePayload) => void;
  onTaskDeleted: (taskId: string) => void;
}

export function TaskDetailModal({
  task,
  allTasks,
  commitments,
  onClose,
  onTaskUpdated,
  onTaskDeleted,
}: TaskDetailModalProps) {
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const {
    loading,
    error,
    comments,
    checklist,
    dependencies,
    isSaving,
    updateTask,
    addComment,
    updateComment,
    deleteComment,
    toggleChecklistItem,
    addChecklistItem,
    updateChecklistItem,
    deleteChecklistItem,
    addDependency,
    removeDependency,
  } = useTaskDetail({ taskId: task?.id ?? null, onTaskUpdated });

  useEffect(() => {
    setDeleteError(null);
    setIsDeleting(false);
  }, [task?.id]);

  async function handleUpdate(_taskId: string, updates: TaskUpdatePayload) {
    await updateTask(updates);
  }

  function handleTaskReplace(updatedTask: TaskWithImplementation) {
    onTaskUpdated(updatedTask.id, updatedTask as unknown as TaskUpdatePayload);
  }

  async function handleDelete() {
    if (!task || isDeleting) {
      return;
    }

    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) {
      return;
    }

    setDeleteError(null);
    setIsDeleting(true);

    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Failed to delete task" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to delete task");
      }

      onTaskDeleted(task.id);
      onClose();
    } catch (deleteTaskError) {
      setDeleteError(deleteTaskError instanceof Error ? deleteTaskError.message : "Failed to delete task");
      setIsDeleting(false);
    }
  }

  return (
    <Modal open={!!task} onClose={onClose} title={task?.title} size="wide">
      {task && (
        <div className="space-y-4">
          {/* Quick-action bar */}
          <div className="flex flex-wrap items-center gap-3">
            <StatusSelector
              value={task.status}
              onChange={(status) => void updateTask({ status })}
            />
            {task.implementation && (
              <span className="rounded bg-panel-muted px-2 py-1 text-xs text-muted-foreground">
                {task.implementation.name}
              </span>
            )}
            {task.project && (
              <span className="rounded bg-panel-muted px-2 py-1 text-xs text-muted-foreground">
                {task.project.name}
              </span>
            )}
            {task.sprint && (
              <span className="rounded bg-panel-muted px-2 py-1 text-xs text-muted-foreground">
                {task.sprint.name}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {task.blocker && (
                <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                  Blocker
                </span>
              )}
              <button
                type="button"
                onClick={() =>
                  void updateTask({ status: "Done" }).then(() => onClose())
                }
                disabled={task.status === "Done" || isSaving || isDeleting}
                className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark Done
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isSaving || isDeleting}
                className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDeleting ? "Deleting..." : "Delete Task"}
              </button>
            </div>
          </div>

          {(error || deleteError) && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error || deleteError}</p>
          )}

          {/* Meta editor */}
          <TaskMetaEditor
            task={task}
            isSaving={isSaving || isDeleting}
            onUpdate={handleUpdate}
            onReplaceTask={handleTaskReplace}
          />

          {/* Detail sections */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-3">
                <ChecklistSection
                  checklist={checklist}
                  onToggle={(item) => void toggleChecklistItem(item)}
                  onAdd={(text) => void addChecklistItem(text)}
                  onUpdate={(itemId, text) => void updateChecklistItem(itemId, text)}
                  onDelete={(itemId) => void deleteChecklistItem(itemId)}
                />
                <TaskDependencies
                  taskId={task.id}
                  dependencies={dependencies}
                  availableTasks={allTasks}
                  availableCommitments={commitments}
                  onDependencyAdded={addDependency}
                  onDependencyRemoved={removeDependency}
                />
                <TaskComments
                  taskId={task.id}
                  comments={comments}
                  onCommentAdded={addComment}
                  onCommentUpdated={updateComment}
                  onCommentDeleted={deleteComment}
                />
              </div>

              <TaskNotesPanel taskId={task.id} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
