export const TASK_EXTERNAL_SOURCE_UNIQUE_INDEX = "uq_tasks_user_external_source_id";
export const TASKADVISOR_SOURCE_SYSTEM = "taskadvisor";

export interface ExternalSourceTaskIdentity {
  id: string;
  user_id: string;
  title: string;
  source_url: string | null;
  tags: string[];
  external_source_system: string | null;
  external_source_id: string | null;
}

export interface ExternalSourceBackfillUpdate {
  task_id: string;
  user_id: string;
  title: string;
  external_source_system: string;
  external_source_id: string;
  evidence: "source_url" | "tag";
}

export interface ExternalSourceBackfillConflict {
  user_id: string;
  external_source_id: string;
  tasks: Array<{ task_id: string; title: string }>;
}

export interface ExternalSourceBackfillPlan {
  updates: ExternalSourceBackfillUpdate[];
  conflicts: ExternalSourceBackfillConflict[];
}

export interface ExternalSourceLookupRow {
  external_source_id: string | null;
  id: string;
  title: string;
  status: string;
  waiting_on: string | null;
  section_id: string | null;
  tags: string[];
}

const TASKADVISOR_URL_PATTERN = /^(?:https?:\/\/)?orion\.epic\.com\/project\/12392\/task\/(\d+)(?:[/?#]|$)/i;
const CSV_TAG_PATTERN = /^csv-(\d+)$/;

export function normalizeExternalSourceValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isTaskExternalSourceUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown; details?: unknown };
  if (String(candidate.code ?? "") !== "23505") return false;
  const detail = `${String(candidate.constraint ?? "")} ${String(candidate.message ?? "")} ${String(candidate.details ?? "")}`;
  return detail.includes(TASK_EXTERNAL_SOURCE_UNIQUE_INDEX);
}

export function externalSourceConflictPayload(input: {
  external_source_system: string;
  external_source_id: string;
  task: { id: string; title: string };
}) {
  return {
    error: "External source identity is already assigned to another task",
    code: "external_source_conflict",
    external_source_system: input.external_source_system,
    external_source_id: input.external_source_id,
    conflicting_task: {
      id: input.task.id,
      title: input.task.title,
    },
  };
}

export function extractTaskadvisorId(task: Pick<ExternalSourceTaskIdentity, "source_url" | "tags">): {
  external_source_id: string;
  evidence: "source_url" | "tag";
} | null {
  const urlMatch = task.source_url?.match(TASKADVISOR_URL_PATTERN);
  if (urlMatch) return { external_source_id: urlMatch[1], evidence: "source_url" };

  for (const tag of task.tags || []) {
    const tagMatch = tag.match(CSV_TAG_PATTERN);
    if (tagMatch) return { external_source_id: tagMatch[1], evidence: "tag" };
  }

  return null;
}

export function buildTaskExternalSourceBackfillPlan(
  tasks: ExternalSourceTaskIdentity[]
): ExternalSourceBackfillPlan {
  const candidates: ExternalSourceBackfillUpdate[] = [];

  for (const task of tasks) {
    const extracted = extractTaskadvisorId(task);
    if (!extracted) continue;

    if (
      task.external_source_system === TASKADVISOR_SOURCE_SYSTEM
      && task.external_source_id === extracted.external_source_id
    ) {
      continue;
    }

    candidates.push({
      task_id: task.id,
      user_id: task.user_id,
      title: task.title,
      external_source_system: TASKADVISOR_SOURCE_SYSTEM,
      external_source_id: extracted.external_source_id,
      evidence: extracted.evidence,
    });
  }

  const claims = new Map<string, Array<{ task_id: string; title: string }>>();
  for (const task of tasks) {
    const extracted = extractTaskadvisorId(task);
    const sourceSystem = extracted ? TASKADVISOR_SOURCE_SYSTEM : task.external_source_system;
    const sourceId = extracted?.external_source_id ?? task.external_source_id;
    if (!sourceSystem || !sourceId) continue;
    const key = `${task.user_id}\u0000${sourceSystem}\u0000${sourceId}`;
    const owners = claims.get(key) ?? [];
    owners.push({ task_id: task.id, title: task.title });
    claims.set(key, owners);
  }

  const conflicts: ExternalSourceBackfillConflict[] = [];
  for (const [key, owners] of claims) {
    if (owners.length < 2) continue;
    const [userId, sourceSystem, externalSourceId] = key.split("\u0000");
    if (sourceSystem !== TASKADVISOR_SOURCE_SYSTEM) continue;
    conflicts.push({ user_id: userId, external_source_id: externalSourceId, tasks: owners });
  }

  return {
    updates: candidates,
    conflicts,
  };
}

export function formatExternalSourceLookup(
  requestedIds: string[],
  rows: ExternalSourceLookupRow[]
): {
  matched: Array<{
    external_source_id: string;
    task_id: string;
    title: string;
    status: string;
    waiting_on: string | null;
    section_id: string | null;
    tags: string[];
  }>;
  unmatched: string[];
} {
  const byId = new Map(rows.flatMap((row) => row.external_source_id ? [[row.external_source_id, row] as const] : []));
  const uniqueRequestedIds = [...new Set(requestedIds)];

  return {
    matched: uniqueRequestedIds.flatMap((externalSourceId) => {
      const row = byId.get(externalSourceId);
      return row ? [{
        external_source_id: externalSourceId,
        task_id: row.id,
        title: row.title,
        status: row.status,
        waiting_on: row.waiting_on,
        section_id: row.section_id,
        tags: row.tags,
      }] : [];
    }),
    unmatched: uniqueRequestedIds.filter((externalSourceId) => !byId.has(externalSourceId)),
  };
}
