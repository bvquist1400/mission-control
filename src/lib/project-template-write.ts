import type { ProjectStage, RagStatus, TaskStatus, TaskType } from '@/types/database';

export interface TemplateSectionWriteInput {
  id?: string;
  client_key?: string;
  name: string;
  sort_order: number;
}

export interface TemplateTaskWriteInput {
  id?: string;
  title: string;
  description: string | null;
  section_key: string | null;
  template_section_id?: string | null;
  task_type: TaskType;
  status: TaskStatus;
  priority_score: number;
  relative_due_days: number | null;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
  sort_order: number;
  checklist_items: string[];
}

export interface TemplateWriteBody {
  name?: unknown;
  description?: unknown;
  default_stage?: unknown;
  default_rag?: unknown;
  default_status_summary?: unknown;
  is_active?: unknown;
  sections?: unknown;
  tasks?: unknown;
}

export const PROJECT_STAGE_VALUES: ProjectStage[] = [
  'Proposed',
  'Planned',
  'Ready',
  'In Progress',
  'Blocked',
  'Review',
  'Done',
  'On Hold',
  'Cancelled',
];

export const RAG_VALUES: RagStatus[] = ['Green', 'Yellow', 'Red'];
export const TASK_TYPE_VALUES: TaskType[] = ['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'];
export const TASK_STATUS_VALUES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done'];

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

export function parseTemplateWriteBody(body: TemplateWriteBody) {
  const name = asString(body.name);
  if (!name) {
    throw new Error('Template name is required');
  }
  if (name.length > 200) {
    throw new Error('Template name must be 200 characters or fewer');
  }

  const description = asString(body.description);
  const defaultStatusSummary = asString(body.default_status_summary) ?? '';
  const isActive = asBoolean(body.is_active, true);

  const defaultStageCandidate = asString(body.default_stage);
  const defaultStage: ProjectStage = defaultStageCandidate && PROJECT_STAGE_VALUES.includes(defaultStageCandidate as ProjectStage)
    ? (defaultStageCandidate as ProjectStage)
    : 'Planned';

  const defaultRagCandidate = asString(body.default_rag);
  const defaultRag: RagStatus = defaultRagCandidate && RAG_VALUES.includes(defaultRagCandidate as RagStatus)
    ? (defaultRagCandidate as RagStatus)
    : 'Green';

  const sectionsSource = Array.isArray(body.sections) ? body.sections : [];
  const sections: TemplateSectionWriteInput[] = sectionsSource.flatMap((entry, index) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const sectionName = asString(row.name);
      if (!sectionName) {
        return [];
      }

      const sortOrder = asNumberOrNull(row.sort_order) ?? ((index + 1) * 10);
      return [{
        id: asString(row.id) ?? undefined,
        client_key: asString(row.client_key) ?? undefined,
        name: sectionName,
        sort_order: Math.round(sortOrder),
      }];
    });

  const tasksSource = Array.isArray(body.tasks) ? body.tasks : [];
  const tasks: TemplateTaskWriteInput[] = tasksSource.flatMap((entry, index) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const title = asString(row.title);
      if (!title) {
        return [];
      }

      const taskTypeCandidate = asString(row.task_type);
      const taskType: TaskType = taskTypeCandidate && TASK_TYPE_VALUES.includes(taskTypeCandidate as TaskType)
        ? (taskTypeCandidate as TaskType)
        : 'Task';

      const statusCandidate = asString(row.status);
      const status: TaskStatus = statusCandidate && TASK_STATUS_VALUES.includes(statusCandidate as TaskStatus)
        ? (statusCandidate as TaskStatus)
        : 'Backlog';

      const priorityRaw = asNumberOrNull(row.priority_score) ?? 50;
      const priority = Math.max(0, Math.min(100, Math.round(priorityRaw)));
      const relativeDueDays = asNumberOrNull(row.relative_due_days);
      const checklistItemsSource = Array.isArray(row.checklist_items) ? row.checklist_items : [];
      const checklistItems = checklistItemsSource
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      return [{
        id: asString(row.id) ?? undefined,
        title,
        description: asString(row.description),
        section_key: asString(row.section_key),
        template_section_id: asString(row.template_section_id),
        task_type: taskType,
        status,
        priority_score: priority,
        relative_due_days: relativeDueDays === null ? null : Math.round(relativeDueDays),
        needs_review: asBoolean(row.needs_review, false),
        blocker: asBoolean(row.blocker, false),
        waiting_on: asString(row.waiting_on),
        sort_order: Math.round(asNumberOrNull(row.sort_order) ?? ((index + 1) * 10)),
        checklist_items: checklistItems,
      }];
    });

  return {
    name,
    description,
    defaultStage,
    defaultRag,
    defaultStatusSummary,
    isActive,
    sections,
    tasks,
  };
}
