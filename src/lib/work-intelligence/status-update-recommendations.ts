import type { SupabaseClient } from "@supabase/supabase-js";
import { getLatestTimestamp, getTaskLatestMovementAt } from "./snapshot";
import type { WorkIntelligenceSnapshot, WorkIntelligenceTask } from "./types";

interface ProjectArtifactRow {
  id: string;
  name: string;
  status_summary: string | null;
  updated_at: string;
}

interface ImplementationArtifactRow {
  id: string;
  name: string;
  status_summary: string | null;
  updated_at: string;
}

interface ProjectStatusUpdateArtifactRow {
  id: string;
  project_id: string;
  implementation_id: string | null;
  captured_for_date: string;
  updated_at: string;
  related_task_ids: string[] | null;
}

interface ImplementationStatusUpdateArtifactRow {
  id: string;
  implementation_id: string;
  created_at: string;
  related_task_ids: string[] | null;
}

interface MovementTask {
  task: WorkIntelligenceTask;
  latestMovementAt: string;
  hasCommentMovement: boolean;
}

interface BuildStatusUpdateRecommendationInput {
  requestedDate: string;
  snapshot: Pick<WorkIntelligenceSnapshot, "tasks" | "commentActivity" | "window">;
  projects: ProjectArtifactRow[];
  implementations: ImplementationArtifactRow[];
  projectStatusUpdates: ProjectStatusUpdateArtifactRow[];
  implementationStatusUpdates: ImplementationStatusUpdateArtifactRow[];
  limit?: number;
}

interface ReadStatusUpdateRecommendationsInput {
  supabase: SupabaseClient;
  userId: string;
  requestedDate: string;
  snapshot: Pick<WorkIntelligenceSnapshot, "tasks" | "commentActivity" | "window">;
  limit?: number;
}

export type WorkStatusUpdateRecommendationReasonCode =
  | "missing_status_artifact"
  | "movement_outpaced_status_artifact"
  | "completed_thread_reporting_hygiene";

export interface WorkStatusUpdateRecommendation {
  key: string;
  entityType: "project" | "implementation";
  entityId: string;
  entityName: string;
  reasonCode: WorkStatusUpdateRecommendationReasonCode;
  summary: string;
  reason: string;
  latestMovementAt: string;
  lastStatusArtifactAt: string | null;
  relatedTaskIds: string[];
  relatedTaskTitles: string[];
}

export interface WorkStatusUpdateRecommendationResult {
  recommendations: WorkStatusUpdateRecommendation[];
  latestStatusArtifactAt: string | null;
}

function hasNonEmptyText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildMovementTasks(
  snapshot: Pick<WorkIntelligenceSnapshot, "tasks" | "commentActivity" | "window">
): MovementTask[] {
  return snapshot.tasks
    .filter((task) => task.status !== "Parked")
    .map((task) => {
      const latestMovementAt = getTaskLatestMovementAt(task, snapshot.commentActivity);
      return latestMovementAt
        ? {
            task,
            latestMovementAt,
            hasCommentMovement: snapshot.commentActivity.has(task.id),
          }
        : null;
    })
    .filter((candidate): candidate is MovementTask => candidate !== null)
    .filter((candidate) => candidate.latestMovementAt >= snapshot.window.dayStartIso)
    .filter((candidate) => {
      if (candidate.task.status === "Done") {
        return true;
      }

      if (candidate.hasCommentMovement) {
        return true;
      }

      return candidate.task.status === "In Progress" || candidate.task.status === "Blocked/Waiting";
    });
}

function uniqueTaskIds(tasks: MovementTask[]): string[] {
  return [...new Set(tasks.map((item) => item.task.id))];
}

function uniqueTaskTitles(tasks: MovementTask[]): string[] {
  return [...new Set(tasks.map((item) => item.task.title))];
}

function buildLatestMovementAt(tasks: MovementTask[]): string | null {
  return getLatestTimestamp(tasks.map((item) => item.latestMovementAt));
}

function latestByIso<T>(items: T[], getIso: (item: T) => string | null): T | null {
  let latest: T | null = null;
  let latestIso: string | null = null;

  for (const item of items) {
    const iso = getIso(item);
    if (!iso) {
      continue;
    }

    if (!latestIso || iso > latestIso) {
      latest = item;
      latestIso = iso;
    }
  }

  return latest;
}

function buildTaskThreadLabel(taskTitles: string[]): string {
  if (taskTitles.length === 0) {
    return "work";
  }

  if (taskTitles.length === 1) {
    return taskTitles[0];
  }

  if (taskTitles.length === 2) {
    return `${taskTitles[0]} and ${taskTitles[1]}`;
  }

  return `${taskTitles[0]} and ${taskTitles.length - 1} other thread${taskTitles.length - 1 === 1 ? "" : "s"}`;
}

function buildRecommendationReason(
  entityName: string,
  entityType: WorkStatusUpdateRecommendation["entityType"],
  reasonCode: WorkStatusUpdateRecommendationReasonCode,
  taskTitles: string[],
  completedCount: number
): { summary: string; reason: string } {
  const artifactLabel = entityType === "project" ? "project status" : "implementation status";
  const taskThreadLabel = buildTaskThreadLabel(taskTitles);

  if (reasonCode === "missing_status_artifact") {
    return {
      summary: `${entityName} moved today, but there is no fresh ${artifactLabel} artifact capturing it.`,
      reason: `${taskThreadLabel} moved today, and ${entityName} still has no current ${artifactLabel} artifact to show it.`,
    };
  }

  if (reasonCode === "completed_thread_reporting_hygiene") {
    return {
      summary: `${entityName} likely needs a status refresh because completed work changed the thread.`,
      reason:
        completedCount === 1
          ? `${taskThreadLabel} closed today, so the last ${artifactLabel} probably underreports where ${entityName} now stands.`
          : `${completedCount} completed threads changed ${entityName} today, so the last ${artifactLabel} is probably stale.`,
    };
  }

  return {
    summary: `${entityName} moved enough today that the current ${artifactLabel} likely lags reality.`,
    reason: `${taskThreadLabel} moved after the last ${artifactLabel}, so the recorded status probably needs a refresh.`,
  };
}

function buildRecommendation(
  entityType: WorkStatusUpdateRecommendation["entityType"],
  entityId: string,
  entityName: string,
  tasks: MovementTask[],
  lastStatusArtifactAt: string | null,
  reasonCode: WorkStatusUpdateRecommendationReasonCode
): WorkStatusUpdateRecommendation | null {
  const latestMovementAt = buildLatestMovementAt(tasks);
  if (!latestMovementAt) {
    return null;
  }

  const relatedTaskIds = uniqueTaskIds(tasks);
  const relatedTaskTitles = uniqueTaskTitles(tasks);
  const completedCount = tasks.filter((item) => item.task.status === "Done").length;
  const { summary, reason } = buildRecommendationReason(entityName, entityType, reasonCode, relatedTaskTitles, completedCount);

  return {
    key: `${entityType}:${entityId}:${reasonCode}`,
    entityType,
    entityId,
    entityName,
    reasonCode,
    summary,
    reason,
    latestMovementAt,
    lastStatusArtifactAt,
    relatedTaskIds,
    relatedTaskTitles,
  };
}

function buildRecommendationScore(item: WorkStatusUpdateRecommendation): number {
  const base =
    item.reasonCode === "completed_thread_reporting_hygiene"
      ? 6
      : item.reasonCode === "missing_status_artifact"
        ? 5
        : 4;

  return base + Math.min(item.relatedTaskIds.length, 4);
}

function groupByProject(tasks: MovementTask[]): Map<string, MovementTask[]> {
  const grouped = new Map<string, MovementTask[]>();

  for (const item of tasks) {
    const projectId = item.task.project_id;
    if (!projectId) {
      continue;
    }

    const current = grouped.get(projectId) ?? [];
    current.push(item);
    grouped.set(projectId, current);
  }

  return grouped;
}

function groupByImplementation(tasks: MovementTask[]): Map<string, MovementTask[]> {
  const grouped = new Map<string, MovementTask[]>();

  for (const item of tasks) {
    const implementationId = item.task.implementation_id;
    if (!implementationId) {
      continue;
    }

    const current = grouped.get(implementationId) ?? [];
    current.push(item);
    grouped.set(implementationId, current);
  }

  return grouped;
}

function buildProjectRecommendations(input: BuildStatusUpdateRecommendationInput, movementTasks: MovementTask[]): WorkStatusUpdateRecommendation[] {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const updatesByProject = new Map<string, ProjectStatusUpdateArtifactRow[]>();

  for (const update of input.projectStatusUpdates) {
    const current = updatesByProject.get(update.project_id) ?? [];
    current.push(update);
    updatesByProject.set(update.project_id, current);
  }

  const recommendations: WorkStatusUpdateRecommendation[] = [];

  for (const [projectId, tasks] of groupByProject(movementTasks).entries()) {
    const project = projectsById.get(projectId);
    const entityName = project?.name ?? tasks[0]?.task.project?.name ?? "Unknown project";
    const latestStatusUpdate = latestByIso(updatesByProject.get(projectId) ?? [], (item) => item.updated_at);
    const lastStatusArtifactAt = getLatestTimestamp([
      project && hasNonEmptyText(project.status_summary) ? project.updated_at : null,
      latestStatusUpdate?.updated_at ?? null,
    ]);
    const latestMovementAt = buildLatestMovementAt(tasks);
    if (!latestMovementAt) {
      continue;
    }

    const latestUpdateTouchesMovement =
      latestStatusUpdate?.related_task_ids?.some((taskId) => tasks.some((task) => task.task.id === taskId)) ?? false;
    const hasCurrentArtifact = Boolean(lastStatusArtifactAt && lastStatusArtifactAt >= latestMovementAt && (latestUpdateTouchesMovement || hasNonEmptyText(project?.status_summary)));
    if (hasCurrentArtifact) {
      continue;
    }

    const reasonCode: WorkStatusUpdateRecommendationReasonCode =
      !hasNonEmptyText(project?.status_summary) && !latestStatusUpdate
        ? "missing_status_artifact"
        : tasks.some((task) => task.task.status === "Done")
          ? "completed_thread_reporting_hygiene"
          : "movement_outpaced_status_artifact";

    const recommendation = buildRecommendation("project", projectId, entityName, tasks, lastStatusArtifactAt, reasonCode);
    if (recommendation) {
      recommendations.push(recommendation);
    }
  }

  return recommendations;
}

function buildImplementationRecommendations(
  input: BuildStatusUpdateRecommendationInput,
  movementTasks: MovementTask[],
  projectRecommendations: WorkStatusUpdateRecommendation[]
): WorkStatusUpdateRecommendation[] {
  const implementationsById = new Map(input.implementations.map((implementation) => [implementation.id, implementation]));
  const updatesByImplementation = new Map<string, ImplementationStatusUpdateArtifactRow[]>();
  const projectCoveredTaskIds = new Set(projectRecommendations.flatMap((item) => item.relatedTaskIds));

  for (const update of input.implementationStatusUpdates) {
    const current = updatesByImplementation.get(update.implementation_id) ?? [];
    current.push(update);
    updatesByImplementation.set(update.implementation_id, current);
  }

  const recommendations: WorkStatusUpdateRecommendation[] = [];

  for (const [implementationId, tasks] of groupByImplementation(movementTasks).entries()) {
    const distinctProjectIds = new Set(tasks.map((item) => item.task.project_id).filter(Boolean));
    const hasImplementationLevelMovement = tasks.some((item) => !item.task.project_id) || distinctProjectIds.size > 1;
    if (!hasImplementationLevelMovement) {
      continue;
    }

    const uncoveredTasks = tasks.filter((item) => !projectCoveredTaskIds.has(item.task.id));
    if (uncoveredTasks.length === 0) {
      continue;
    }

    const implementation = implementationsById.get(implementationId);
    const entityName = implementation?.name ?? tasks[0]?.task.implementation?.name ?? "Unknown implementation";
    const latestStatusUpdate = latestByIso(updatesByImplementation.get(implementationId) ?? [], (item) => item.created_at);
    const lastStatusArtifactAt = getLatestTimestamp([
      implementation && hasNonEmptyText(implementation.status_summary) ? implementation.updated_at : null,
      latestStatusUpdate?.created_at ?? null,
    ]);
    const latestMovementAt = buildLatestMovementAt(uncoveredTasks);
    if (!latestMovementAt) {
      continue;
    }

    const latestUpdateTouchesMovement =
      latestStatusUpdate?.related_task_ids?.some((taskId) => uncoveredTasks.some((task) => task.task.id === taskId)) ?? false;
    const hasCurrentArtifact = Boolean(
      lastStatusArtifactAt &&
      lastStatusArtifactAt >= latestMovementAt &&
      (latestUpdateTouchesMovement || hasNonEmptyText(implementation?.status_summary))
    );
    if (hasCurrentArtifact) {
      continue;
    }

    const reasonCode: WorkStatusUpdateRecommendationReasonCode =
      !hasNonEmptyText(implementation?.status_summary) && !latestStatusUpdate
        ? "missing_status_artifact"
        : uncoveredTasks.some((task) => task.task.status === "Done")
          ? "completed_thread_reporting_hygiene"
          : "movement_outpaced_status_artifact";

    const recommendation = buildRecommendation(
      "implementation",
      implementationId,
      entityName,
      uncoveredTasks,
      lastStatusArtifactAt,
      reasonCode
    );
    if (recommendation) {
      recommendations.push(recommendation);
    }
  }

  return recommendations;
}

export function buildStatusUpdateRecommendations(
  input: BuildStatusUpdateRecommendationInput
): WorkStatusUpdateRecommendationResult {
  const movementTasks = buildMovementTasks(input.snapshot);
  if (movementTasks.length === 0) {
    return { recommendations: [], latestStatusArtifactAt: null };
  }

  const projectRecommendations = buildProjectRecommendations(input, movementTasks);
  const implementationRecommendations = buildImplementationRecommendations(input, movementTasks, projectRecommendations);
  const recommendations = [...projectRecommendations, ...implementationRecommendations]
    .sort((left, right) => {
      const scoreDiff = buildRecommendationScore(right) - buildRecommendationScore(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return right.latestMovementAt.localeCompare(left.latestMovementAt) || left.entityName.localeCompare(right.entityName);
    })
    .slice(0, Math.max(1, input.limit ?? 4));

  return {
    recommendations,
    latestStatusArtifactAt: getLatestTimestamp([
      ...input.projects.map((project) => (hasNonEmptyText(project.status_summary) ? project.updated_at : null)),
      ...input.implementations.map((implementation) => (hasNonEmptyText(implementation.status_summary) ? implementation.updated_at : null)),
      ...input.projectStatusUpdates.map((update) => update.updated_at),
      ...input.implementationStatusUpdates.map((update) => update.created_at),
    ]),
  };
}

export async function readStatusUpdateRecommendations(
  input: ReadStatusUpdateRecommendationsInput
): Promise<WorkStatusUpdateRecommendationResult> {
  const movementTasks = buildMovementTasks(input.snapshot);
  const projectIds = [...new Set(movementTasks.map((item) => item.task.project_id).filter(Boolean))];
  const implementationIds = [...new Set(movementTasks.map((item) => item.task.implementation_id).filter(Boolean))];

  if (projectIds.length === 0 && implementationIds.length === 0) {
    return { recommendations: [], latestStatusArtifactAt: null };
  }

  const projectPromise =
    projectIds.length > 0
      ? input.supabase
          .from("projects")
          .select("id, name, status_summary, updated_at")
          .eq("user_id", input.userId)
          .in("id", projectIds)
      : Promise.resolve({ data: [], error: null });
  const implementationPromise =
    implementationIds.length > 0
      ? input.supabase
          .from("implementations")
          .select("id, name, status_summary, updated_at")
          .eq("user_id", input.userId)
          .in("id", implementationIds)
      : Promise.resolve({ data: [], error: null });
  const projectUpdatesPromise =
    projectIds.length > 0
      ? input.supabase
          .from("project_status_updates")
          .select("id, project_id, implementation_id, captured_for_date, updated_at, related_task_ids")
          .eq("user_id", input.userId)
          .in("project_id", projectIds)
          .order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null });
  const implementationUpdatesPromise =
    implementationIds.length > 0
      ? input.supabase
          .from("status_updates")
          .select("id, implementation_id, created_at, related_task_ids")
          .eq("user_id", input.userId)
          .in("implementation_id", implementationIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null });

  const [projectsResult, implementationsResult, projectUpdatesResult, implementationUpdatesResult] = await Promise.all([
    projectPromise,
    implementationPromise,
    projectUpdatesPromise,
    implementationUpdatesPromise,
  ]);

  if (projectsResult.error) {
    throw projectsResult.error;
  }

  if (implementationsResult.error) {
    throw implementationsResult.error;
  }

  if (projectUpdatesResult.error) {
    throw projectUpdatesResult.error;
  }

  if (implementationUpdatesResult.error) {
    throw implementationUpdatesResult.error;
  }

  return buildStatusUpdateRecommendations({
    requestedDate: input.requestedDate,
    snapshot: input.snapshot,
    projects: (projectsResult.data || []) as ProjectArtifactRow[],
    implementations: (implementationsResult.data || []) as ImplementationArtifactRow[],
    projectStatusUpdates: (projectUpdatesResult.data || []) as ProjectStatusUpdateArtifactRow[],
    implementationStatusUpdates: (implementationUpdatesResult.data || []) as ImplementationStatusUpdateArtifactRow[],
    limit: input.limit,
  });
}
