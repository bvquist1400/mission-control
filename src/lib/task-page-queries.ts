import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTaskDependencySummaries } from "@/lib/task-dependencies";
import type { TaskPageChecklistRow, TaskPageCommentRow, TaskPageTaskRow } from "@/lib/task-page";

function single<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export interface TaskPageInput {
  task: TaskPageTaskRow;
  checklist: TaskPageChecklistRow[];
  comments: TaskPageCommentRow[];
  blockers: string[];
}

/** Everything the task page shows, for the signed-in user's own task (null when it isn't theirs). */
export async function loadTaskPageInput(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<TaskPageInput | null> {
  const { data: row, error } = await supabase
    .from("tasks")
    .select(
      "id, title, status, owner, owner_label, status_line, due_at, waiting_on, follow_up_at, description, tags, implementation:implementations(name), project:projects(name), section:project_sections(name)"
    )
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const [checklist, comments, dependencies] = await Promise.all([
    supabase
      .from("task_checklist_items")
      .select("id, text, is_done, sort_order")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("task_comments")
      .select("id, content, created_at")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    fetchTaskDependencySummaries(supabase, userId, [taskId]),
  ]);
  if (checklist.error) throw checklist.error;
  if (comments.error) throw comments.error;

  const named = (value: unknown) => single(value as { name: string } | { name: string }[] | null)?.name ?? null;
  const raw = row as unknown as Omit<TaskPageTaskRow, "app" | "project" | "section"> & {
    implementation: unknown;
    project: unknown;
    section: unknown;
  };
  const { implementation, project, section, ...fields } = raw;

  return {
    task: { ...fields, app: named(implementation), project: named(project), section: named(section) },
    checklist: (checklist.data ?? []) as TaskPageChecklistRow[],
    comments: (comments.data ?? []) as TaskPageCommentRow[],
    blockers: (dependencies.get(taskId) ?? []).filter((dependency) => dependency.unresolved).map((dependency) => dependency.title),
  };
}
