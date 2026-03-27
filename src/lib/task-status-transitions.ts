import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskStatus } from "@/types/database";

interface QueueTaskStatusTransitionInput {
  userId: string;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  transitionedAt?: string;
}

export function queueTaskStatusTransition(
  supabase: SupabaseClient,
  input: QueueTaskStatusTransitionInput
): void {
  const transitionedAt = input.transitionedAt ?? new Date().toISOString();

  void (async () => {
    try {
      const { error } = await supabase
        .from("task_status_transitions")
        .insert({
          user_id: input.userId,
          task_id: input.taskId,
          from_status: input.fromStatus,
          to_status: input.toStatus,
          transitioned_at: transitionedAt,
        });

      if (error) {
        console.error("[tasks] failed to record task status transition:", error);
      }
    } catch (error: unknown) {
      console.error("[tasks] failed to record task status transition:", error);
    }
  })();
}
