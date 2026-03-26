import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeNoteDecisionRow, normalizeNoteLinkRow, normalizeNoteRow } from "@/lib/notes-shared";
import { fetchTaskDependencySummaries } from "@/lib/task-dependencies";
import type {
  Commitment,
  ImplementationSummary,
  NoteDecision,
  NoteLink,
  NoteLinkEntityType,
  Project,
  Sprint,
  Stakeholder,
  Task,
  TaskComment,
} from "@/types/database";
import type {
  IntelligenceContextNote,
  IntelligenceTaskCommentContext,
  IntelligenceTaskCommitmentContext,
  IntelligenceTaskContext,
  IntelligenceTaskRecord,
  ReadIntelligenceTaskContextsOptions,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTE_EXCERPT_LENGTH = 240;
const COMMENT_EXCERPT_LENGTH = 180;
const ACTIVE_TASK_STATUSES = new Set(["Backlog", "Planned", "In Progress", "Blocked/Waiting"]);

interface NoteTaskRow {
  id: string;
  note_id: string;
  task_id: string;
  relationship_type: string;
  created_at: string;
}

interface CommitmentRow extends Commitment {
  stakeholder_id: string;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function truncate(value: string, maxLength: number): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/[#*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNoteExcerpt(markdown: string): string | null {
  return truncate(stripMarkdown(markdown), NOTE_EXCERPT_LENGTH);
}

function toCommentExcerpt(value: string): string | null {
  return truncate(value, COMMENT_EXCERPT_LENGTH);
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;

  for (const value of values) {
    const parsed = parseIso(value);
    if (parsed === null) {
      continue;
    }

    const iso = new Date(parsed).toISOString();
    if (!latest || iso > latest) {
      latest = iso;
    }
  }

  return latest;
}

function daysSince(now: Date, iso: string): number {
  const parsed = parseIso(iso);
  if (parsed === null) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
}

function buildEntityTaskMap(
  tasks: IntelligenceTaskRecord[],
  commitmentsByTaskId: Map<string, IntelligenceTaskCommitmentContext[]>
): Record<Exclude<NoteLinkEntityType, "calendar_event">, Map<string, string[]>> {
  const maps: Record<Exclude<NoteLinkEntityType, "calendar_event">, Map<string, string[]>> = {
    task: new Map(),
    implementation: new Map(),
    project: new Map(),
    stakeholder: new Map(),
    commitment: new Map(),
    sprint: new Map(),
  };

  function add(map: Map<string, string[]>, entityId: string | null | undefined, taskId: string): void {
    if (!entityId) {
      return;
    }

    const existing = map.get(entityId) ?? [];
    if (!existing.includes(taskId)) {
      existing.push(taskId);
      map.set(entityId, existing);
    }
  }

  for (const task of tasks) {
    add(maps.task, task.id, task.id);
    add(maps.implementation, task.implementation_id, task.id);
    add(maps.project, task.project_id, task.id);
    add(maps.sprint, task.sprint_id, task.id);

    for (const commitment of commitmentsByTaskId.get(task.id) ?? []) {
      add(maps.commitment, commitment.id, task.id);
      add(maps.stakeholder, commitment.stakeholder?.id, task.id);
    }
  }

  return maps;
}

function relationRank(reasons: string[]): number {
  if (reasons.some((reason) => reason.startsWith("note_task:") || reason.startsWith("task:"))) {
    return 0;
  }

  if (reasons.some((reason) => reason.startsWith("commitment:") || reason.startsWith("stakeholder:"))) {
    return 1;
  }

  return 2;
}

async function fetchTasks(
  supabase: SupabaseClient,
  userId: string,
  taskIds?: string[]
): Promise<Task[]> {
  let query = supabase
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .order("priority_score", { ascending: false })
    .order("updated_at", { ascending: false });

  if (taskIds && taskIds.length > 0) {
    query = query.in("id", [...new Set(taskIds)]);
  } else {
    query = query.neq("status", "Done").neq("status", "Parked");
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return ((data || []) as Task[]).filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
}

async function fetchImplementations(
  supabase: SupabaseClient,
  userId: string,
  implementationIds: string[]
): Promise<Map<string, ImplementationSummary>> {
  const byId = new Map<string, ImplementationSummary>();

  if (implementationIds.length === 0) {
    return byId;
  }

  const { data, error } = await supabase
    .from("implementations")
    .select("id, name, phase, rag, portfolio_rank")
    .eq("user_id", userId)
    .in("id", implementationIds);

  if (error) {
    throw error;
  }

  for (const row of (data || []) as ImplementationSummary[]) {
    byId.set(row.id, row);
  }

  return byId;
}

async function fetchProjects(
  supabase: SupabaseClient,
  userId: string,
  projectIds: string[]
): Promise<Map<string, Project>> {
  const byId = new Map<string, Project>();

  if (projectIds.length === 0) {
    return byId;
  }

  const { data, error } = await supabase
    .from("projects")
    .select("id, user_id, implementation_id, name, description, stage, rag, target_date, servicenow_spm_id, status_summary, portfolio_rank, created_at, updated_at")
    .eq("user_id", userId)
    .in("id", projectIds);

  if (error) {
    throw error;
  }

  for (const row of (data || []) as Project[]) {
    byId.set(row.id, row);
  }

  return byId;
}

async function fetchSprints(
  supabase: SupabaseClient,
  userId: string,
  sprintIds: string[]
): Promise<Map<string, Sprint>> {
  const byId = new Map<string, Sprint>();

  if (sprintIds.length === 0) {
    return byId;
  }

  const { data, error } = await supabase
    .from("sprints")
    .select("id, user_id, name, start_date, end_date, theme, focus_implementation_id, created_at, updated_at")
    .eq("user_id", userId)
    .in("id", sprintIds);

  if (error) {
    throw error;
  }

  for (const row of (data || []) as Sprint[]) {
    byId.set(row.id, row);
  }

  return byId;
}

async function fetchTaskComments(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[]
): Promise<Map<string, IntelligenceTaskCommentContext[]>> {
  const byTaskId = new Map<string, IntelligenceTaskCommentContext[]>();

  if (taskIds.length === 0) {
    return byTaskId;
  }

  const { data, error } = await supabase
    .from("task_comments")
    .select("id, user_id, task_id, content, source, created_at, updated_at")
    .eq("user_id", userId)
    .in("task_id", taskIds)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  for (const row of (data || []) as TaskComment[]) {
    const comment: IntelligenceTaskCommentContext = {
      id: row.id,
      content: row.content,
      excerpt: toCommentExcerpt(row.content),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const existing = byTaskId.get(row.task_id) ?? [];
    existing.push(comment);
    byTaskId.set(row.task_id, existing);
  }

  return byTaskId;
}

async function fetchTaskCommitments(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[]
): Promise<Map<string, IntelligenceTaskCommitmentContext[]>> {
  const byTaskId = new Map<string, IntelligenceTaskCommitmentContext[]>();

  if (taskIds.length === 0) {
    return byTaskId;
  }

  const { data, error } = await supabase
    .from("commitments")
    .select("id, user_id, stakeholder_id, task_id, title, direction, status, due_at, done_at, notes, created_at, updated_at")
    .eq("user_id", userId)
    .eq("status", "Open")
    .in("task_id", taskIds)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  const commitmentRows = (data || []) as CommitmentRow[];
  const stakeholderIds = [...new Set(commitmentRows.map((row) => row.stakeholder_id).filter(isNonEmptyString))];
  const stakeholderById = new Map<string, Stakeholder>();

  if (stakeholderIds.length > 0) {
    const stakeholdersResult = await supabase
      .from("stakeholders")
      .select("id, user_id, name, email, role, organization, notes, context, created_at, updated_at")
      .eq("user_id", userId)
      .in("id", stakeholderIds);

    if (stakeholdersResult.error) {
      throw stakeholdersResult.error;
    }

    for (const stakeholder of (stakeholdersResult.data || []) as Stakeholder[]) {
      stakeholderById.set(stakeholder.id, stakeholder);
    }
  }

  for (const row of commitmentRows) {
    if (!row.task_id) {
      continue;
    }

    const stakeholder = stakeholderById.get(row.stakeholder_id);
    const commitment: IntelligenceTaskCommitmentContext = {
      id: row.id,
      title: row.title,
      direction: row.direction,
      status: row.status,
      dueAt: row.due_at,
      updatedAt: row.updated_at,
      stakeholder: stakeholder ? { id: stakeholder.id, name: stakeholder.name } : null,
    };

    const existing = byTaskId.get(row.task_id) ?? [];
    existing.push(commitment);
    byTaskId.set(row.task_id, existing);
  }

  return byTaskId;
}

async function fetchNoteTaskRows(
  supabase: SupabaseClient,
  userId: string,
  taskIds: string[]
): Promise<NoteTaskRow[]> {
  if (taskIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("note_tasks")
    .select("id, user_id, note_id, task_id, relationship_type, created_at")
    .eq("user_id", userId)
    .in("task_id", taskIds);

  if (error) {
    throw error;
  }

  return (data || []) as NoteTaskRow[];
}

async function fetchNoteLinksByEntityType(
  supabase: SupabaseClient,
  userId: string,
  entityType: Exclude<NoteLinkEntityType, "calendar_event">,
  entityIds: string[]
): Promise<NoteLink[]> {
  if (entityIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("note_links")
    .select("*")
    .eq("user_id", userId)
    .eq("entity_type", entityType)
    .in("entity_id", entityIds);

  if (error) {
    throw error;
  }

  return ((data || []) as Array<Record<string, unknown>>).map((row) => normalizeNoteLinkRow(row));
}

export async function readIntelligenceTaskContexts(
  supabase: SupabaseClient,
  userId: string,
  options: ReadIntelligenceTaskContextsOptions = {}
): Promise<IntelligenceTaskContext[]> {
  const now = options.now ?? new Date();
  const tasks = await fetchTasks(supabase, userId, options.taskIds);
  const taskIds = tasks.map((task) => task.id);

  if (taskIds.length === 0) {
    return [];
  }

  const implementationIds = [...new Set(tasks.map((task) => task.implementation_id).filter(isNonEmptyString))];
  const projectIds = [...new Set(tasks.map((task) => task.project_id).filter(isNonEmptyString))];
  const sprintIds = [...new Set(tasks.map((task) => task.sprint_id).filter(isNonEmptyString))];

  const [
    implementationById,
    projectById,
    sprintById,
    dependencyMap,
    commentsByTaskId,
    commitmentsByTaskId,
  ] = await Promise.all([
    fetchImplementations(supabase, userId, implementationIds),
    fetchProjects(supabase, userId, projectIds),
    fetchSprints(supabase, userId, sprintIds),
    fetchTaskDependencySummaries(supabase, userId, taskIds),
    fetchTaskComments(supabase, userId, taskIds),
    fetchTaskCommitments(supabase, userId, taskIds),
  ]);

  const taskRecords: IntelligenceTaskRecord[] = tasks.map((task) => {
    const dependencies = dependencyMap.get(task.id) ?? [];
    return {
      ...task,
      implementation: task.implementation_id ? implementationById.get(task.implementation_id) ?? null : null,
      project: task.project_id
        ? (() => {
            const project = projectById.get(task.project_id);
            return project
              ? {
                  id: project.id,
                  name: project.name,
                  stage: project.stage,
                  rag: project.rag,
                }
              : null;
          })()
        : null,
      sprint: task.sprint_id
        ? (() => {
            const sprint = sprintById.get(task.sprint_id);
            return sprint
              ? {
                  id: sprint.id,
                  name: sprint.name,
                  start_date: sprint.start_date,
                  end_date: sprint.end_date,
                }
              : null;
          })()
        : null,
      dependencies,
      dependency_blocked: dependencies.some((dependency) => dependency.unresolved),
    };
  });

  const entityTaskMap = buildEntityTaskMap(taskRecords, commitmentsByTaskId);
  const [
    noteTaskRows,
    taskLinks,
    implementationLinks,
    projectLinks,
    sprintLinks,
    commitmentLinks,
    stakeholderLinks,
  ] = await Promise.all([
    fetchNoteTaskRows(supabase, userId, taskIds),
    fetchNoteLinksByEntityType(supabase, userId, "task", [...entityTaskMap.task.keys()]),
    fetchNoteLinksByEntityType(supabase, userId, "implementation", [...entityTaskMap.implementation.keys()]),
    fetchNoteLinksByEntityType(supabase, userId, "project", [...entityTaskMap.project.keys()]),
    fetchNoteLinksByEntityType(supabase, userId, "sprint", [...entityTaskMap.sprint.keys()]),
    fetchNoteLinksByEntityType(supabase, userId, "commitment", [...entityTaskMap.commitment.keys()]),
    fetchNoteLinksByEntityType(supabase, userId, "stakeholder", [...entityTaskMap.stakeholder.keys()]),
  ]);

  const allNoteIds = new Set<string>();
  for (const row of noteTaskRows) {
    allNoteIds.add(row.note_id);
  }
  for (const link of [
    ...taskLinks,
    ...implementationLinks,
    ...projectLinks,
    ...sprintLinks,
    ...commitmentLinks,
    ...stakeholderLinks,
  ]) {
    allNoteIds.add(link.note_id);
  }

  const noteById = new Map<string, ReturnType<typeof normalizeNoteRow>>();
  const decisionsByNoteId = new Map<string, NoteDecision[]>();

  if (allNoteIds.size > 0) {
    const noteIds = [...allNoteIds];
    const [notesResult, decisionsResult] = await Promise.all([
      supabase
        .from("notes")
        .select("*")
        .eq("user_id", userId)
        .eq("status", "active")
        .in("id", noteIds)
        .order("updated_at", { ascending: false }),
      supabase
        .from("note_decisions")
        .select("*")
        .eq("user_id", userId)
        .in("note_id", noteIds)
        .order("updated_at", { ascending: false }),
    ]);

    if (notesResult.error) {
      throw notesResult.error;
    }

    if (decisionsResult.error) {
      throw decisionsResult.error;
    }

    for (const row of (notesResult.data || []) as Array<Record<string, unknown>>) {
      const note = normalizeNoteRow(row);
      noteById.set(note.id, note);
    }

    for (const row of (decisionsResult.data || []) as Array<Record<string, unknown>>) {
      const decision = normalizeNoteDecisionRow(row);
      const existing = decisionsByNoteId.get(decision.note_id) ?? [];
      existing.push(decision);
      decisionsByNoteId.set(decision.note_id, existing);
    }
  }

  const noteReasonsByTaskId = new Map<string, Map<string, Set<string>>>();

  function addNoteReason(taskId: string, noteId: string, reason: string): void {
    if (!noteById.has(noteId)) {
      return;
    }

    const notesForTask = noteReasonsByTaskId.get(taskId) ?? new Map<string, Set<string>>();
    const reasons = notesForTask.get(noteId) ?? new Set<string>();
    reasons.add(reason);
    notesForTask.set(noteId, reasons);
    noteReasonsByTaskId.set(taskId, notesForTask);
  }

  for (const row of noteTaskRows) {
    addNoteReason(row.task_id, row.note_id, `note_task:${row.relationship_type}`);
  }

  for (const [entityType, links] of [
    ["task", taskLinks],
    ["implementation", implementationLinks],
    ["project", projectLinks],
    ["sprint", sprintLinks],
    ["commitment", commitmentLinks],
    ["stakeholder", stakeholderLinks],
  ] as const) {
    const tasksByEntity = entityTaskMap[entityType];

    for (const link of links) {
      for (const taskId of tasksByEntity.get(link.entity_id) ?? []) {
        addNoteReason(taskId, link.note_id, `${entityType}:${link.link_role}`);
      }
    }
  }

  return taskRecords.map((task) => {
    const comments = commentsByTaskId.get(task.id) ?? [];
    const notes: IntelligenceContextNote[] = [...(noteReasonsByTaskId.get(task.id)?.entries() ?? [])]
      .map(([noteId, reasons]) => {
        const note = noteById.get(noteId);
        if (!note) {
          return null;
        }

        return {
          id: note.id,
          title: note.title,
          noteType: note.note_type,
          status: note.status,
          updatedAt: note.updated_at,
          lastReviewedAt: note.last_reviewed_at,
          excerpt: toNoteExcerpt(note.body_markdown),
          relationReasons: [...reasons].sort(),
          decisions: (decisionsByNoteId.get(note.id) ?? []).map((decision) => ({
            id: decision.id,
            title: decision.title,
            summary: decision.summary,
            decisionStatus: decision.decision_status,
            decidedAt: decision.decided_at,
            updatedAt: decision.updated_at,
          })),
        };
      })
      .filter((note): note is IntelligenceContextNote => note !== null)
      .sort((left, right) => {
        const relationDiff = relationRank(left.relationReasons) - relationRank(right.relationReasons);
        if (relationDiff !== 0) {
          return relationDiff;
        }

        const updatedDiff = (parseIso(right.updatedAt) ?? 0) - (parseIso(left.updatedAt) ?? 0);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }

        return left.title.localeCompare(right.title);
      });

    const latestActivityAt =
      maxIso([
        task.updated_at,
        comments[0]?.updatedAt ?? null,
        comments[0]?.createdAt ?? null,
      ]) ?? task.updated_at;

    return {
      task,
      latestActivityAt,
      daysSinceActivity: daysSince(now, latestActivityAt),
      comments,
      notes,
      openCommitments: commitmentsByTaskId.get(task.id) ?? [],
    };
  });
}
