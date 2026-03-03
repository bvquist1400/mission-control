import type { TaskChecklistItem, TaskComment, TaskDependencySummary } from "@/types/database";

export interface TaskDetailData {
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  dependencies: TaskDependencySummary[];
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
  const dependencies = dependenciesRes.ok ? await dependenciesRes.json() : { dependencies: [] };

  return {
    comments,
    checklist,
    dependencies: Array.isArray(dependencies.dependencies) ? dependencies.dependencies : [],
  };
}
