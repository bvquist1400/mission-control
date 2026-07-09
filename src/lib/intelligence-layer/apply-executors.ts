import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "@/types/database";
import { getHighPriorityStakeholderNames, recalculateTaskPriority } from "@/lib/priority";
import { queueTaskStatusTransition } from "@/lib/task-status-transitions";
import { isPostgrestNotFound } from "@/lib/supabase/errors";
import { parseTaskIdFromSubjectKey } from "./presentation";
import type { PersistedIntelligenceArtifact } from "./phase2-types";

export interface ApplyArtifactExecutionResult {
  executed: boolean;
  executorAction: string | null;
  reason: string | null;
}

async function fetchSubjectTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single();

  if (error) {
    if (isPostgrestNotFound(error)) {
      return null;
    }

    throw error;
  }

  return data as Task;
}

async function executeStaleTaskApply(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<ApplyArtifactExecutionResult> {
  const task = await fetchSubjectTask(supabase, userId, taskId);
  if (!task) {
    return { executed: false, executorAction: null, reason: "Subject task no longer exists" };
  }

  if (task.status === "Parked" || task.status === "Done") {
    return { executed: false, executorAction: null, reason: `Task is already ${task.status}` };
  }

  const highPriorityStakeholderNames = await getHighPriorityStakeholderNames(supabase, userId);
  const priorityScore = recalculateTaskPriority(
    { ...task, status: "Parked" },
    highPriorityStakeholderNames
  );

  const { error } = await supabase
    .from("tasks")
    .update({
      status: "Parked",
      priority_score: priorityScore,
    })
    .eq("id", taskId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  queueTaskStatusTransition(supabase, {
    userId,
    taskId,
    fromStatus: task.status,
    toStatus: "Parked",
  });

  return { executed: true, executorAction: "park_task", reason: null };
}

async function executeAmbiguousTaskApply(
  supabase: SupabaseClient,
  userId: string,
  taskId: string
): Promise<ApplyArtifactExecutionResult> {
  const task = await fetchSubjectTask(supabase, userId, taskId);
  if (!task) {
    return { executed: false, executorAction: null, reason: "Subject task no longer exists" };
  }

  if (task.needs_review) {
    return { executed: false, executorAction: null, reason: "Task is already flagged for review" };
  }

  const { error } = await supabase
    .from("tasks")
    .update({ needs_review: true })
    .eq("id", taskId)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }

  return { executed: true, executorAction: "flag_needs_review", reason: null };
}

/**
 * Runs the per-type side effect for an "apply" action before the artifact's
 * status transition is committed. Reminder-type artifacts have their own
 * executor (src/lib/intelligence-layer/reminders.ts) and are not routed here.
 */
export async function executeApplyArtifactAction(
  supabase: SupabaseClient,
  userId: string,
  artifact: PersistedIntelligenceArtifact
): Promise<ApplyArtifactExecutionResult> {
  const taskId = parseTaskIdFromSubjectKey(artifact.subjectKey);
  if (!taskId) {
    return { executed: false, executorAction: null, reason: null };
  }

  switch (artifact.primaryContractType) {
    case "stale_task":
      return executeStaleTaskApply(supabase, userId, taskId);
    case "ambiguous_task":
      return executeAmbiguousTaskApply(supabase, userId, taskId);
    default:
      return { executed: false, executorAction: null, reason: null };
  }
}
