import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectStage, RagStatus, TaskStatus, TaskType } from '@/types/database';

export interface ProjectTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  default_stage: ProjectStage;
  default_rag: RagStatus;
  default_status_summary: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectTemplateSectionRecord {
  id: string;
  template_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectTemplateTaskRecord {
  id: string;
  template_id: string;
  template_section_id: string | null;
  title: string;
  description: string | null;
  task_type: TaskType;
  priority_score: number;
  status: TaskStatus;
  relative_due_days: number | null;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
  sort_order: number;
  checklist_items: string[];
  created_at: string;
  updated_at: string;
}

export interface ProjectTemplateDetailRecord extends ProjectTemplateRecord {
  sections: Array<ProjectTemplateSectionRecord & { tasks: ProjectTemplateTaskRecord[] }>;
  unsectioned_tasks: ProjectTemplateTaskRecord[];
}

export interface TemplateInstantiationInput {
  kickoffDate: string;
  projectName: string | null;
  implementationId: string | null;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeOptionalUuid(value: unknown): string | null {
  const normalized = normalizeOptionalText(value);
  return normalized;
}

export function resolveDueFromKickoff(kickoffDate: string, relativeDueDays: number | null): {
  due_date: string | null;
  due_at: string | null;
} {
  if (relativeDueDays === null) {
    return { due_date: null, due_at: null };
  }

  const kickoff = new Date(`${kickoffDate}T00:00:00.000Z`);
  kickoff.setUTCDate(kickoff.getUTCDate() + relativeDueDays);
  const dueDate = kickoff.toISOString().slice(0, 10);

  return {
    due_date: dueDate,
    // Store due dates near end-of-day UTC so local date rendering does not slip to the prior day.
    due_at: `${dueDate}T23:59:59.999Z`,
  };
}

export async function fetchTemplateDetailForUser(
  supabase: SupabaseClient,
  userId: string,
  templateId: string
): Promise<ProjectTemplateDetailRecord | null> {
  const { data: template, error: templateError } = await supabase
    .from('project_templates')
    .select('id, name, description, default_stage, default_rag, default_status_summary, is_active, created_at, updated_at')
    .eq('id', templateId)
    .eq('user_id', userId)
    .single();

  if (templateError) {
    if (templateError.code === 'PGRST116') {
      return null;
    }
    throw templateError;
  }

  const [{ data: sections, error: sectionError }, { data: tasks, error: taskError }] = await Promise.all([
    supabase
      .from('project_template_sections')
      .select('id, template_id, name, sort_order, created_at, updated_at')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    supabase
      .from('project_template_tasks')
      .select('id, template_id, template_section_id, title, description, task_type, priority_score, status, relative_due_days, needs_review, blocker, waiting_on, sort_order, checklist_items, created_at, updated_at')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
  ]);

  if (sectionError) {
    throw sectionError;
  }
  if (taskError) {
    throw taskError;
  }

  const sectionRows = (sections ?? []) as ProjectTemplateSectionRecord[];
  const taskRows = (tasks ?? []) as ProjectTemplateTaskRecord[];

  const tasksBySectionId = new Map<string, ProjectTemplateTaskRecord[]>();
  const unsectionedTasks: ProjectTemplateTaskRecord[] = [];

  for (const task of taskRows) {
    if (!task.template_section_id) {
      unsectionedTasks.push(task);
      continue;
    }

    const existing = tasksBySectionId.get(task.template_section_id) ?? [];
    existing.push(task);
    tasksBySectionId.set(task.template_section_id, existing);
  }

  return {
    ...(template as ProjectTemplateRecord),
    sections: sectionRows.map((section) => ({
      ...section,
      tasks: tasksBySectionId.get(section.id) ?? [],
    })),
    unsectioned_tasks: unsectionedTasks,
  };
}
