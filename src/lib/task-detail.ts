import type { TaskChecklistItem, TaskComment, TaskDependencySummary } from "@/types/database";

export interface TaskDetailData {
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  dependencies: TaskDependencySummary[];
}

export async function fetchTaskDetails(taskId: string): Promise<TaskDetailData> {
  const [commentsRes, checklistRes, dependenciesRes] = await Promise.all([
    fetch(`/api/tasks/${taskId}/comments`, { cache: "no-store" }),
    fetch(`/api/tasks/${taskId}/checklist`, { cache: "no-store" }),
    fetch(`/api/tasks/${taskId}/dependencies`, { cache: "no-store" }),
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
