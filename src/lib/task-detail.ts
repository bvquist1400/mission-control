import type { TaskChecklistItem, TaskComment, TaskDependencySummary } from "@/types/database";

/** A task that waits on this one (GET /api/tasks/{id}/dependencies `blocks`, S0's BlocksLink). */
export interface TaskBlocksLink {
  dependency_id: string;
  id: string | null;
  title: string;
  status: string | null;
  due_at: string | null;
}

export interface TaskDetailData {
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  dependencies: TaskDependencySummary[];
  /** null when the tasks that wait on this one couldn't all be read. */
  blocks: TaskBlocksLink[] | null;
}

export async function fetchTaskDetails(taskId: string, signal?: AbortSignal): Promise<TaskDetailData> {
  const requestInit: RequestInit = { cache: "no-store", signal };
  const [commentsRes, checklistRes, dependenciesRes] = await Promise.all([
    fetch(`/api/tasks/${taskId}/comments`, requestInit),
    fetch(`/api/tasks/${taskId}/checklist`, requestInit),
    fetch(`/api/tasks/${taskId}/dependencies`, requestInit),
  ]);

  const comments = commentsRes.ok ? await commentsRes.json() : [];
  const checklist = checklistRes.ok ? await checklistRes.json() : [];
  const dependencies = dependenciesRes.ok ? await dependenciesRes.json() : { dependencies: [], blocks: null };

  return {
    comments,
    checklist,
    dependencies: Array.isArray(dependencies.dependencies) ? dependencies.dependencies : [],
    blocks: Array.isArray(dependencies.blocks) ? dependencies.blocks : null,
  };
}
