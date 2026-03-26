import { transitionIntelligenceArtifactStatus } from "./promotion";
import type { IntelligencePromotionStore, PersistedIntelligenceArtifact } from "./phase2-types";
import type {
  ExecuteAcceptedReminderArtifactsOptions,
  ExecuteAcceptedReminderArtifactsResult,
  IntelligenceReminderStore,
  PersistedIntelligenceReminderExecution,
  PersistedReminderTaskComment,
} from "./phase3-types";

const REMINDER_EXECUTION_KIND = "task_comment_reminder";

function parseTaskIdFromSubjectKey(subjectKey: string): string | null {
  return subjectKey.startsWith("task:") ? subjectKey.slice("task:".length) || null : null;
}

function primaryFamilyKey(artifact: PersistedIntelligenceArtifact): string | null {
  const coveredFamilies = artifact.reviewPayload.coveredFamilies;
  if (!Array.isArray(coveredFamilies)) {
    return null;
  }

  const family = coveredFamilies.find((value): value is string => typeof value === "string" && value.length > 0);
  return family ?? null;
}

function buildReminderTaskComment(artifact: PersistedIntelligenceArtifact): string {
  const lines = [
    "[Mission Control reminder]",
    artifact.summary,
    "",
    `Why now: ${artifact.reason}`,
  ];

  const familyKey = primaryFamilyKey(artifact);
  if (familyKey) {
    lines.push(`Promotion family: ${familyKey}`);
  }

  lines.push(`Artifact: ${artifact.id}`);
  return lines.join("\n");
}

function recordExecution(
  executionsById: Map<string, PersistedIntelligenceReminderExecution>,
  execution: PersistedIntelligenceReminderExecution
): void {
  executionsById.set(execution.id, execution);
}

export async function executeAcceptedReminderArtifactsForUser(
  reminderStore: IntelligenceReminderStore,
  promotionStore: IntelligencePromotionStore,
  userId: string,
  options: ExecuteAcceptedReminderArtifactsOptions = {}
): Promise<ExecuteAcceptedReminderArtifactsResult> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const inspectedArtifacts = await reminderStore.listAcceptedReminderArtifacts(userId, options.limit ?? 25);
  const executionsById = new Map<string, PersistedIntelligenceReminderExecution>();
  const comments: PersistedReminderTaskComment[] = [];
  const appliedArtifactIds: string[] = [];
  const skipped: ExecuteAcceptedReminderArtifactsResult["skipped"] = [];
  const errors: ExecuteAcceptedReminderArtifactsResult["errors"] = [];

  for (const artifact of inspectedArtifacts) {
    const taskId = parseTaskIdFromSubjectKey(artifact.subjectKey);
    if (!taskId) {
      skipped.push({
        artifactId: artifact.id,
        reason: "artifact subject_key is not task-backed",
      });
      continue;
    }

    try {
      const existingExecution = await reminderStore.getReminderExecution(userId, artifact.id, REMINDER_EXECUTION_KIND);
      if (existingExecution?.status === "completed") {
        recordExecution(executionsById, existingExecution);

        await transitionIntelligenceArtifactStatus(promotionStore, userId, artifact.id, "applied", {
          triggeredBy: "system",
          note: "Reminder task comment already exists; marking accepted artifact applied.",
          payload: {
            outputKind: "task_comment",
            reminderExecutionId: existingExecution.id,
            taskCommentId: existingExecution.taskCommentId,
          },
        });

        appliedArtifactIds.push(artifact.id);
        continue;
      }

      if (existingExecution?.status === "started") {
        recordExecution(executionsById, existingExecution);
        skipped.push({
          artifactId: artifact.id,
          reason: "reminder execution already started",
        });
        continue;
      }

      const claimedExecution = await reminderStore.claimReminderExecution({
        userId,
        artifactId: artifact.id,
        executionKind: REMINDER_EXECUTION_KIND,
        taskId,
        payload: {
          outputKind: "task_comment",
          artifactSummary: artifact.summary,
        },
        nowIso,
      });
      recordExecution(executionsById, claimedExecution);

      if (claimedExecution.status === "completed") {
        await transitionIntelligenceArtifactStatus(promotionStore, userId, artifact.id, "applied", {
          triggeredBy: "system",
          note: "Reminder task comment already exists; marking accepted artifact applied.",
          payload: {
            outputKind: "task_comment",
            reminderExecutionId: claimedExecution.id,
            taskCommentId: claimedExecution.taskCommentId,
          },
        });
        appliedArtifactIds.push(artifact.id);
        continue;
      }

      const comment = await reminderStore.createSystemTaskComment({
        userId,
        taskId,
        content: buildReminderTaskComment(artifact),
      });
      comments.push(comment);

      const completedExecution = await reminderStore.completeReminderExecution(userId, claimedExecution.id, {
        taskCommentId: comment.id,
        payload: {
          outputKind: "task_comment",
          taskCommentId: comment.id,
          artifactSummary: artifact.summary,
        },
        nowIso,
      });
      recordExecution(executionsById, completedExecution);

      await transitionIntelligenceArtifactStatus(promotionStore, userId, artifact.id, "applied", {
        triggeredBy: "system",
        note: "Applied accepted reminder as a system task comment.",
        payload: {
          outputKind: "task_comment",
          reminderExecutionId: completedExecution.id,
          taskCommentId: comment.id,
        },
      });

      appliedArtifactIds.push(artifact.id);
    } catch (error) {
      errors.push({
        artifactId: artifact.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    inspectedArtifacts,
    executions: [...executionsById.values()],
    comments,
    appliedArtifactIds,
    skipped,
    errors,
  };
}
