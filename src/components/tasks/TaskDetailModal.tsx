"use client";

import { Modal } from "@/components/ui/Modal";
import { TaskMetaEditor } from "@/components/tasks/TaskMetaEditor";
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
}

export function TaskDetailModal({
  task,
  allTasks,
  commitments,
  onClose,
  onTaskUpdated,
}: TaskDetailModalProps) {
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
    deleteChecklistItem,
    addDependency,
    removeDependency,
  } = useTaskDetail({ taskId: task?.id ?? null, onTaskUpdated });

  async function handleUpdate(_taskId: string, updates: TaskUpdatePayload) {
    await updateTask(updates);
  }

  return (
    <Modal open={!!task} onClose={onClose} title={task?.title}>
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
                disabled={task.status === "Done" || isSaving}
                className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark Done
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          )}

          {/* Meta editor */}
          <TaskMetaEditor
            key={`${task.id}:${task.updated_at}`}
            task={task}
            isSaving={isSaving}
            onUpdate={handleUpdate}
          />

          {/* Detail sections */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-3">
              <ChecklistSection
                checklist={checklist}
                onToggle={(item) => void toggleChecklistItem(item)}
                onAdd={(text) => void addChecklistItem(text)}
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
          )}
        </div>
      )}
    </Modal>
  );
}
