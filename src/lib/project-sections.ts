import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectSection } from "@/types/database";

export const PROJECT_SECTION_TITLE_PATTERN = /^\[([^\]]+)\]\s*-\s*(.+)$/;

export class ProjectSectionServiceError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "project_section_error") {
    super(message);
    this.name = "ProjectSectionServiceError";
    this.status = status;
    this.code = code;
  }
}

export interface SectionAwareTaskLike {
  id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  section_id: string | null;
  section_name?: string | null;
}

export interface SectionGroupedTaskBucket<T extends SectionAwareTaskLike> {
  section_id: string | null;
  section_name: string | null;
  tasks: T[];
}

export interface ProjectTaskGroups<T extends SectionAwareTaskLike> {
  project_id: string;
  project_name: string;
  has_sections: boolean;
  groups: SectionGroupedTaskBucket<T>[];
}

export interface BackfillTaskPreviewRow {
  task_id: string;
  old_title: string;
  new_title: string;
  section_name: string;
  project_id: string;
}

export interface BackfillProjectSectionInput {
  id?: string;
  user_id: string;
  project_id: string;
  name: string;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export interface BackfillTaskInput {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
}

export interface PlannedProjectSectionCreate {
  user_id: string;
  project_id: string;
  name: string;
  sort_order: number;
  identity: string;
}

export interface PlannedTaskBackfillUpdate {
  task_id: string;
  user_id: string;
  project_id: string;
  old_title: string;
  new_title: string;
  section_name: string;
  section_identity: string;
}

export interface ProjectSectionsBackfillPlan {
  preview_rows: BackfillTaskPreviewRow[];
  sections_to_create: PlannedProjectSectionCreate[];
  task_updates: PlannedTaskBackfillUpdate[];
  skipped_no_project: BackfillTaskInput[];
  skipped_empty_title: Array<BackfillTaskInput & { section_name: string }>;
}

export function normalizeProjectSectionName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProjectSectionIdentity(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeProjectSectionSortOrder(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectSectionServiceError("sort_order must be a finite integer", 400, "invalid_sort_order");
  }

  return Math.round(value);
}

export function isProjectSectionUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && String((error as { code?: unknown }).code) === "23505"
  );
}

export function sortProjectSections(
  left: Pick<ProjectSection, "sort_order" | "created_at">,
  right: Pick<ProjectSection, "sort_order" | "created_at">
): number {
  if (left.sort_order !== right.sort_order) {
    return left.sort_order - right.sort_order;
  }

  return left.created_at.localeCompare(right.created_at);
}

export function resolveTaskProjectSectionState(input: {
  current_project_id: string | null;
  current_section_id: string | null;
  has_project_input: boolean;
  project_id_input: string | null;
  has_section_input: boolean;
  section_id_input: string | null;
}): { project_id: string | null; section_id: string | null } {
  const nextProjectId = input.has_project_input ? input.project_id_input : input.current_project_id;
  let nextSectionId = input.has_section_input ? input.section_id_input : input.current_section_id;

  if (
    input.has_project_input
    && input.project_id_input !== input.current_project_id
    && !input.has_section_input
  ) {
    nextSectionId = null;
  }

  return {
    project_id: nextProjectId,
    section_id: nextSectionId,
  };
}

export async function requireOwnedProjectSection(
  supabase: SupabaseClient,
  userId: string,
  sectionId: string,
  errorMessage = "section_id is invalid"
): Promise<ProjectSection> {
  const { data, error } = await supabase
    .from("project_sections")
    .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
    .eq("id", sectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ProjectSectionServiceError(errorMessage, 400, "invalid_project_section");
  }

  return data as ProjectSection;
}

export async function listOwnedProjectSections(
  supabase: SupabaseClient,
  userId: string,
  projectIds: string[]
): Promise<ProjectSection[]> {
  if (projectIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("project_sections")
    .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
    .eq("user_id", userId)
    .in("project_id", [...new Set(projectIds)])
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data || []) as ProjectSection[]).sort(sortProjectSections);
}

export async function validateTaskSectionAssignment(
  supabase: SupabaseClient,
  userId: string,
  input: {
    project_id: string | null;
    section_id: string | null;
  }
): Promise<ProjectSection | null> {
  if (input.section_id && !input.project_id) {
    throw new ProjectSectionServiceError("section_id requires project_id", 400, "section_requires_project");
  }

  if (!input.section_id) {
    return null;
  }

  const section = await requireOwnedProjectSection(supabase, userId, input.section_id);
  if (section.project_id !== input.project_id) {
    throw new ProjectSectionServiceError(
      "section_id must belong to the selected project",
      400,
      "section_project_mismatch"
    );
  }

  return section;
}

export function groupTasksByProjectSections<T extends SectionAwareTaskLike>(
  tasks: T[],
  projectSections: ProjectSection[]
): { grouped_projects: ProjectTaskGroups<T>[]; unassigned_tasks: T[] } {
  const sectionsByProjectId = new Map<string, ProjectSection[]>();
  for (const section of projectSections) {
    const existing = sectionsByProjectId.get(section.project_id) ?? [];
    existing.push(section);
    sectionsByProjectId.set(section.project_id, existing);
  }

  const unassignedTasks: T[] = [];
  const tasksByProjectId = new Map<string, T[]>();

  for (const task of tasks) {
    if (!task.project_id) {
      unassignedTasks.push(task);
      continue;
    }

    const existing = tasksByProjectId.get(task.project_id) ?? [];
    existing.push(task);
    tasksByProjectId.set(task.project_id, existing);
  }

  const groupedProjects: ProjectTaskGroups<T>[] = [];

  for (const [projectId, projectTasks] of tasksByProjectId.entries()) {
    const projectName = projectTasks[0]?.project_name ?? "Unknown project";
    const sections = [...(sectionsByProjectId.get(projectId) ?? [])].sort(sortProjectSections);

    if (sections.length === 0) {
      groupedProjects.push({
        project_id: projectId,
        project_name: projectName,
        has_sections: false,
        groups: [
          {
            section_id: null,
            section_name: null,
            tasks: projectTasks,
          },
        ],
      });
      continue;
    }

    const tasksBySectionId = new Map<string, T[]>();
    const unsectionedProjectTasks: T[] = [];

    for (const task of projectTasks) {
      if (!task.section_id) {
        unsectionedProjectTasks.push(task);
        continue;
      }

      const existing = tasksBySectionId.get(task.section_id) ?? [];
      existing.push(task);
      tasksBySectionId.set(task.section_id, existing);
    }

    const groups: SectionGroupedTaskBucket<T>[] = [];
    for (const section of sections) {
      const sectionTasks = tasksBySectionId.get(section.id) ?? [];
      if (sectionTasks.length === 0) {
        continue;
      }

      groups.push({
        section_id: section.id,
        section_name: section.name,
        tasks: sectionTasks,
      });
    }

    if (unsectionedProjectTasks.length > 0) {
      groups.push({
        section_id: null,
        section_name: null,
        tasks: unsectionedProjectTasks,
      });
    }

    groupedProjects.push({
      project_id: projectId,
      project_name: projectName,
      has_sections: true,
      groups,
    });
  }

  groupedProjects.sort((left, right) => left.project_name.localeCompare(right.project_name));

  return {
    grouped_projects: groupedProjects,
    unassigned_tasks: unassignedTasks,
  };
}

export function parseBracketedProjectSectionTaskTitle(
  title: string
): { section_name: string; task_title: string } | null {
  const match = PROJECT_SECTION_TITLE_PATTERN.exec(title);
  if (!match) {
    return null;
  }

  const sectionName = normalizeProjectSectionName(match[1]);
  if (!sectionName) {
    return null;
  }

  return {
    section_name: sectionName,
    task_title: match[2].trim(),
  };
}

export function buildProjectSectionsBackfillPlan(input: {
  tasks: BackfillTaskInput[];
  existing_sections: BackfillProjectSectionInput[];
}): ProjectSectionsBackfillPlan {
  const previewRows: BackfillTaskPreviewRow[] = [];
  const sectionsToCreate: PlannedProjectSectionCreate[] = [];
  const taskUpdates: PlannedTaskBackfillUpdate[] = [];
  const skippedNoProject: BackfillTaskInput[] = [];
  const skippedEmptyTitle: Array<BackfillTaskInput & { section_name: string }> = [];

  const existingByProject = new Map<string, Map<string, BackfillProjectSectionInput>>();
  const createdByProject = new Map<string, Map<string, PlannedProjectSectionCreate>>();
  const nextSortOrderByProject = new Map<string, number>();

  for (const section of input.existing_sections) {
    const key = `${section.user_id}:${section.project_id}`;
    const byIdentity = existingByProject.get(key) ?? new Map<string, BackfillProjectSectionInput>();
    byIdentity.set(normalizeProjectSectionIdentity(section.name), section);
    existingByProject.set(key, byIdentity);

    const nextSortOrder = Math.max(nextSortOrderByProject.get(key) ?? 0, section.sort_order + 1);
    nextSortOrderByProject.set(key, nextSortOrder);
  }

  for (const task of input.tasks) {
    const parsed = parseBracketedProjectSectionTaskTitle(task.title);
    if (!parsed) {
      continue;
    }

    if (!task.project_id) {
      skippedNoProject.push(task);
      continue;
    }

    if (parsed.task_title.length === 0) {
      skippedEmptyTitle.push({
        ...task,
        section_name: parsed.section_name,
      });
      continue;
    }

    const identity = normalizeProjectSectionIdentity(parsed.section_name);
    const projectKey = `${task.user_id}:${task.project_id}`;
    const existingSections = existingByProject.get(projectKey) ?? new Map<string, BackfillProjectSectionInput>();
    const plannedSections = createdByProject.get(projectKey) ?? new Map<string, PlannedProjectSectionCreate>();

    if (!existingSections.has(identity) && !plannedSections.has(identity)) {
      const plannedCreate: PlannedProjectSectionCreate = {
        user_id: task.user_id,
        project_id: task.project_id,
        name: parsed.section_name,
        sort_order: nextSortOrderByProject.get(projectKey) ?? 0,
        identity,
      };

      plannedSections.set(identity, plannedCreate);
      createdByProject.set(projectKey, plannedSections);
      nextSortOrderByProject.set(projectKey, plannedCreate.sort_order + 1);
      sectionsToCreate.push(plannedCreate);
    }

    previewRows.push({
      task_id: task.id,
      old_title: task.title,
      new_title: parsed.task_title,
      section_name: parsed.section_name,
      project_id: task.project_id,
    });

    taskUpdates.push({
      task_id: task.id,
      user_id: task.user_id,
      project_id: task.project_id,
      old_title: task.title,
      new_title: parsed.task_title,
      section_name: parsed.section_name,
      section_identity: identity,
    });
  }

  return {
    preview_rows: previewRows,
    sections_to_create: sectionsToCreate,
    task_updates: taskUpdates,
    skipped_no_project: skippedNoProject,
    skipped_empty_title: skippedEmptyTitle,
  };
}
