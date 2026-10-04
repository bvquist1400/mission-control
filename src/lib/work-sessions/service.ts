/**
 * Work sessions and the pace forecast: the one service path behind
 * `/api/work-sessions`, `/api/projects/[id]/forecast`, `/api/pace-rates` and the
 * MCP tools (`log_work_session`, `list_work_sessions`, `update_work_session`,
 * `delete_work_session`, `get_project_forecast`, `get_pace_rates`).
 *
 * Every query filters by user_id: API-key and MCP callers use the service-role
 * client, which bypasses RLS. Migration 059's triggers re-check ownership and
 * that linked rows belong to the session's project.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeForecast,
  computePooledRates,
  formatForecastLine,
  normalizeUnitCount,
  normalizeWorkType,
  type CrossProjectRate,
  type PaceForecast,
  type PaceInput,
  type PaceItemInput,
  type PaceSessionInput,
  type PaceTaskInput,
} from "@/lib/pace";
import {
  etDateOf,
  isDateOnly,
  matchRows,
  parseRowsSpec,
  reanchorInstant,
  resolveSessionTiming,
} from "@/lib/work-sessions/parse";
import type { WorkSession } from "@/types/database";

export class WorkSessionServiceError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "WorkSessionServiceError";
    this.status = status;
    this.details = details;
  }
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const ID_CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_SOURCES = ["manual", "agent", "backfill"] as const;
type SessionSource = (typeof SESSION_SOURCES)[number];

export interface WorkSessionView extends WorkSession {
  item_ids: string[];
}

function bad(message: string, details?: unknown): never {
  throw new WorkSessionServiceError(400, message, details);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) bad(`${field} must be a UUID`);
  return (value as string).trim();
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") bad(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (trimmed.length > max) bad(`${field} must be ${max} characters or fewer`);
  return trimmed || null;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("Body must be a JSON object");
  return body as Record<string, unknown>;
}

async function pagedSelect<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error("pagedSelect: too many rows");
}

function chunks<T>(values: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

// ── Loading ─────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  unit_label: string | null;
  target_date: string | null;
  pace_settings: unknown;
}

interface TaskRow extends PaceTaskInput {
  project_id: string | null;
  title: string;
}

interface ItemRow extends PaceItemInput {
  text: string;
  sort_order: number;
  completed_at: string | null;
}

async function loadProject(supabase: SupabaseClient, userId: string, projectId: string): Promise<ProjectRow> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, unit_label, target_date, pace_settings")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new WorkSessionServiceError(404, "Project not found");
  return data as ProjectRow;
}

async function loadProjectTasks(supabase: SupabaseClient, userId: string, projectId: string): Promise<TaskRow[]> {
  return pagedSelect<TaskRow>((from, to) =>
    supabase
      .from("tasks")
      .select("id, title, project_id, status, estimated_minutes, unit_count, work_type, is_sample, section_id")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("is_recurring_template", false)
      .order("id", { ascending: true })
      .range(from, to)
  ).then((rows) => rows.map((row) => ({ ...row, unit_count: row.unit_count === null ? null : Number(row.unit_count) })));
}

async function loadItems(supabase: SupabaseClient, userId: string, taskIds: string[]): Promise<ItemRow[]> {
  const out: ItemRow[] = [];
  for (const ids of chunks(taskIds)) {
    out.push(
      ...(await pagedSelect<ItemRow>((from, to) =>
        supabase
          .from("task_checklist_items")
          .select("id, task_id, text, is_done, sort_order, unit_count, work_type, completed_at")
          .eq("user_id", userId)
          .in("task_id", ids)
          .order("id", { ascending: true })
          .range(from, to)
      ))
    );
  }
  return out.map((row) => ({ ...row, unit_count: row.unit_count === null ? null : Number(row.unit_count) }));
}

async function loadSessionItemIds(supabase: SupabaseClient, userId: string, sessionIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const ids of chunks(sessionIds)) {
    const rows = await pagedSelect<{ session_id: string; checklist_item_id: string }>((from, to) =>
      supabase
        .from("work_session_items")
        .select("session_id, checklist_item_id")
        .eq("user_id", userId)
        .in("session_id", ids)
        .order("session_id", { ascending: true })
        .order("checklist_item_id", { ascending: true })
        .range(from, to)
    );
    for (const row of rows) {
      const list = map.get(row.session_id) ?? [];
      list.push(row.checklist_item_id);
      map.set(row.session_id, list);
    }
  }
  return map;
}

function normalizeSessionRow(row: Record<string, unknown>): WorkSession {
  return {
    ...(row as unknown as WorkSession),
    extra_units: row.extra_units === null || row.extra_units === undefined ? null : Number(row.extra_units),
  };
}

async function loadProjectSessions(supabase: SupabaseClient, userId: string, projectId: string): Promise<WorkSessionView[]> {
  const rows = await pagedSelect<Record<string, unknown>>((from, to) =>
    supabase
      .from("work_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .order("session_date", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
  );
  const sessions = rows.map(normalizeSessionRow);
  const links = await loadSessionItemIds(supabase, userId, sessions.map((session) => session.id));
  return sessions.map((session) => ({ ...session, item_ids: links.get(session.id) ?? [] }));
}

function toPaceSession(session: WorkSessionView): PaceSessionInput {
  return {
    id: session.id,
    task_id: session.task_id,
    session_date: session.session_date,
    started_at: session.started_at,
    ended_at: session.ended_at,
    created_at: session.created_at,
    minutes: session.minutes,
    exclude_from_stats: session.exclude_from_stats,
    item_ids: session.item_ids,
    extra_units: session.extra_units,
    extra_work_type: session.extra_work_type,
  };
}

interface LoadedProject {
  project: ProjectRow;
  sections: Array<{ id: string; name: string; planned_start: string | null; planned_end: string | null }>;
  tasks: TaskRow[];
  items: ItemRow[];
  sessions: WorkSessionView[];
}

async function loadProjectData(supabase: SupabaseClient, userId: string, projectId: string): Promise<LoadedProject> {
  const project = await loadProject(supabase, userId, projectId);
  const [sectionsResult, tasks, sessions] = await Promise.all([
    supabase
      .from("project_sections")
      .select("id, name, planned_start, planned_end")
      .eq("user_id", userId)
      .eq("project_id", projectId),
    loadProjectTasks(supabase, userId, projectId),
    loadProjectSessions(supabase, userId, projectId),
  ]);
  if (sectionsResult.error) throw sectionsResult.error;
  const items = await loadItems(supabase, userId, tasks.map((task) => task.id));
  return {
    project,
    sections: (sectionsResult.data ?? []) as LoadedProject["sections"],
    tasks,
    items,
    sessions,
  };
}

async function loadOtherProjectRates(
  supabase: SupabaseClient,
  userId: string,
  unitLabel: string | null,
  excludeProjectId: string | null
): Promise<CrossProjectRate[]> {
  if (!unitLabel) return [];
  const pooled = await pooledRatesForUnit(supabase, userId, unitLabel, excludeProjectId);
  return pooled.rates
    .filter((rate) => rate.scope === "main")
    .map((rate) => ({ work_type: rate.work_type, seconds_per_unit: rate.seconds_per_unit, n_sessions: rate.n_sessions }));
}

async function pooledRatesForUnit(
  supabase: SupabaseClient,
  userId: string,
  unitLabel: string,
  excludeProjectId: string | null
) {
  let query = supabase.from("projects").select("id, name").eq("user_id", userId).eq("unit_label", unitLabel);
  if (excludeProjectId) query = query.neq("id", excludeProjectId);
  const { data, error } = await query;
  if (error) throw error;
  const projects = (data ?? []) as Array<{ id: string; name: string }>;
  const loaded = [];
  for (const project of projects) {
    const tasks = await loadProjectTasks(supabase, userId, project.id);
    const items = await loadItems(supabase, userId, tasks.map((task) => task.id));
    const sessions = (await loadProjectSessions(supabase, userId, project.id)).map(toPaceSession);
    loaded.push({ project, tasks, items, sessions });
  }
  return {
    projects,
    rates: computePooledRates(loaded),
    byProject: loaded.map((entry) => ({
      project_id: entry.project.id,
      project_name: entry.project.name,
      rates: computePooledRates([entry]),
    })),
  };
}

export function etToday(now: Date = new Date()): string {
  return etDateOf(now);
}

function paceInputFrom(data: LoadedProject, today: string, otherProjectRates: CrossProjectRate[]): PaceInput {
  return {
    project: { unit_label: data.project.unit_label, target_date: data.project.target_date, pace_settings: data.project.pace_settings },
    sections: data.sections.map((section) => ({ id: section.id, planned_start: section.planned_start })),
    tasks: data.tasks,
    items: data.items,
    sessions: data.sessions.map(toPaceSession),
    today,
    otherProjectRates,
  };
}

export interface ProjectForecastResult {
  project: { id: string; name: string; unit_label: string | null; target_date: string | null };
  line: string;
  forecast: PaceForecast;
}

export async function getProjectForecast(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  options: { today?: string; now?: Date; focusType?: string | null } = {}
): Promise<ProjectForecastResult> {
  requireUuid(projectId, "project_id");
  const today = options.today ?? etToday(options.now);
  if (!isDateOnly(today)) bad("today must be YYYY-MM-DD");
  const data = await loadProjectData(supabase, userId, projectId);
  const otherRates = await loadOtherProjectRates(supabase, userId, data.project.unit_label, projectId);
  const forecast = computeForecast(paceInputFrom(data, today, otherRates));
  return {
    project: {
      id: data.project.id,
      name: data.project.name,
      unit_label: data.project.unit_label,
      target_date: data.project.target_date,
    },
    line: formatForecastLine(forecast, options.focusType ?? null),
    forecast,
  };
}

export async function getPaceRates(
  supabase: SupabaseClient,
  userId: string,
  params: { unit_label: string | null; work_type?: string | null }
) {
  // Stored lowercased (projects PATCH), so match "Stitches" too.
  const unitLabel = params.unit_label?.trim().toLowerCase();
  if (!unitLabel) bad("unit_label is required (e.g. stitches)");
  const workType = normalizeWorkType(params.work_type ?? null);
  if (!workType.ok) bad(workType.error);
  const pooled = await pooledRatesForUnit(supabase, userId, unitLabel as string, null);
  const keep = <T extends { work_type: string }>(rows: T[]) =>
    workType.value ? rows.filter((row) => row.work_type === workType.value) : rows;
  const shape = (rate: ReturnType<typeof computePooledRates>[number]) => ({
    work_type: rate.work_type,
    scope: rate.scope,
    seconds_per_unit: Math.round(rate.seconds_per_unit * 100) / 100,
    n_sessions: rate.n_sessions,
    units: rate.units,
    minutes: Math.round(rate.minutes * 10) / 10,
    label: rate.label,
  });
  return {
    unit_label: unitLabel,
    work_type: workType.value,
    note: "Measured from counted sessions only (the most recent 8 per type and scope). Sample-scope speeds come from a swatch/test piece and are labelled.",
    projects: pooled.projects.map((project) => project.id),
    rates: keep(pooled.rates).map(shape),
    by_project: pooled.byProject.map((entry) => ({
      project_id: entry.project_id,
      project_name: entry.project_name,
      rates: keep(entry.rates).map(shape),
    })),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

interface ResolvedTarget {
  projectId: string;
  task: TaskRow | null;
}

async function resolveTarget(
  supabase: SupabaseClient,
  userId: string,
  taskIdInput: unknown,
  projectIdInput: unknown
): Promise<ResolvedTarget> {
  const hasTask = taskIdInput !== undefined && taskIdInput !== null;
  const hasProject = projectIdInput !== undefined && projectIdInput !== null;
  if (!hasTask && !hasProject) bad("Give task_id, or project_id for a sitting that spanned several tasks");
  let task: TaskRow | null = null;
  if (hasTask) {
    const taskId = requireUuid(taskIdInput, "task_id");
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, project_id, status, estimated_minutes, unit_count, work_type, is_sample, section_id")
      .eq("id", taskId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new WorkSessionServiceError(404, "Task not found");
    task = data as TaskRow;
    if (!task.project_id) bad("That task is not in a project; work sessions belong to a project");
  }
  const projectId = hasProject ? requireUuid(projectIdInput, "project_id") : (task!.project_id as string);
  if (task && task.project_id !== projectId) bad("task_id is not in project_id");
  await loadProject(supabase, userId, projectId);
  return { projectId, task };
}

async function resolveItemIds(
  supabase: SupabaseClient,
  userId: string,
  target: ResolvedTarget,
  itemIdsInput: unknown,
  rowsInput: unknown
): Promise<string[]> {
  const ids = new Set<string>();
  const hasItemIds = itemIdsInput !== undefined && itemIdsInput !== null;
  const hasRows = rowsInput !== undefined && rowsInput !== null && String(rowsInput).trim() !== "";
  if (!hasItemIds && !hasRows) return [];

  // Items in scope: the task's, or the whole project's for a multi-task sitting.
  const taskIds = target.task
    ? [target.task.id]
    : (await loadProjectTasks(supabase, userId, target.projectId)).map((task) => task.id);
  const items = await loadItems(supabase, userId, taskIds);
  const byId = new Map(items.map((item) => [item.id, item]));

  if (hasItemIds) {
    if (!Array.isArray(itemIdsInput)) bad("item_ids must be an array of checklist item UUIDs");
    const notFound: string[] = [];
    for (const raw of itemIdsInput as unknown[]) {
      const id = requireUuid(raw, "item_ids[]");
      if (!byId.has(id)) notFound.push(id);
      else ids.add(id);
    }
    if (notFound.length > 0) {
      bad(
        target.task ? "Some item_ids are not checklist items of this task" : "Some item_ids are not checklist items in this project",
        { not_found: notFound }
      );
    }
  }
  if (hasRows) {
    if (typeof rowsInput !== "string") bad("rows must be a string like \"11-15\", \"11, 12\" or \"row 10\"");
    const parsed = parseRowsSpec(rowsInput as string);
    if (!parsed.ok) bad(parsed.error);
    const match = matchRows(parsed.value, items);
    if (match.missing.length > 0 || match.ambiguous.length > 0) {
      bad(
        `Couldn't match every row${match.missing.length ? `; no item starting "Row N" for: ${match.missing.join(", ")}` : ""}${
          match.ambiguous.length ? `; more than one item for: ${match.ambiguous.map((entry) => entry.row).join(", ")} (give task_id or item_ids)` : ""
        }`,
        { missing_rows: match.missing, ambiguous_rows: match.ambiguous }
      );
    }
    for (const id of match.item_ids) ids.add(id);
  }
  return [...ids];
}

function parseSessionFlags(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if ("note" in body) out.note = optionalString(body.note, "note", 2000);
  if ("exclude_from_stats" in body) {
    if (typeof body.exclude_from_stats !== "boolean") bad("exclude_from_stats must be true or false");
    out.exclude_from_stats = body.exclude_from_stats;
  }
  if ("exclude_reason" in body) out.exclude_reason = optionalString(body.exclude_reason, "exclude_reason", 200);
  if ("extra_units" in body) {
    const units = normalizeUnitCount(body.extra_units, "extra_units");
    if (!units.ok) bad(units.error);
    out.extra_units = units.value;
  }
  if ("extra_work_type" in body) {
    const type = normalizeWorkType(body.extra_work_type);
    if (!type.ok) bad(type.error);
    out.extra_work_type = type.value;
  }
  if (!partial || "source" in body) {
    const source = body.source ?? "manual";
    if (!SESSION_SOURCES.includes(source as SessionSource)) bad(`source must be one of ${SESSION_SOURCES.join(", ")}`);
    out.source = source;
  }
  if ("source_ref" in body) out.source_ref = optionalString(body.source_ref, "source_ref", 200);
  return out;
}

/** Maps an error from a session RPC (migration 059) to a caller-facing error. */
function rpcError(error: { code?: string; message?: string; details?: string | null }): WorkSessionServiceError {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "P0002":
      return new WorkSessionServiceError(404, "Work session not found");
    case "23503":
    case "23514":
    case "22023":
    case "22P02":
    case "23502":
      return new WorkSessionServiceError(400, message);
    case "23505":
      return new WorkSessionServiceError(409, "A session with this source_ref already exists");
    case "42501":
      return new WorkSessionServiceError(403, message);
    default:
      return Object.assign(new Error(message), error) as unknown as WorkSessionServiceError;
  }
}

async function readSession(supabase: SupabaseClient, userId: string, id: string): Promise<WorkSessionView> {
  const { data, error } = await supabase.from("work_sessions").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new WorkSessionServiceError(404, "Work session not found");
  const links = await loadSessionItemIds(supabase, userId, [id]);
  return { ...normalizeSessionRow(data as Record<string, unknown>), item_ids: links.get(id) ?? [] };
}

async function findBySourceRef(supabase: SupabaseClient, userId: string, sourceRef: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("work_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("source_ref", sourceRef)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/** The type with the most units among a session's linked rows / extra units (for the summary line). */
async function focusTypeFor(
  supabase: SupabaseClient,
  userId: string,
  session: WorkSessionView,
  task: TaskRow | null
): Promise<string | null> {
  const totals = new Map<string, number>();
  if (session.item_ids.length > 0) {
    const { data, error } = await supabase
      .from("task_checklist_items")
      .select("id, task_id, unit_count, work_type")
      .eq("user_id", userId)
      .in("id", session.item_ids.slice(0, ID_CHUNK));
    if (error) throw error;
    const taskTypes = new Map<string, string | null>();
    for (const row of (data ?? []) as Array<{ task_id: string; unit_count: number | null; work_type: string | null }>) {
      if (!row.unit_count) continue;
      let type = row.work_type;
      if (!type) {
        if (!taskTypes.has(row.task_id)) {
          const { data: taskRow } = await supabase.from("tasks").select("work_type").eq("id", row.task_id).eq("user_id", userId).maybeSingle();
          taskTypes.set(row.task_id, (taskRow as { work_type: string | null } | null)?.work_type ?? null);
        }
        type = taskTypes.get(row.task_id) ?? null;
      }
      if (type) totals.set(type, (totals.get(type) ?? 0) + Number(row.unit_count));
    }
  }
  const extraType = session.extra_work_type ?? task?.work_type ?? null;
  if (session.extra_units && extraType) totals.set(extraType, (totals.get(extraType) ?? 0) + session.extra_units);
  return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export interface LogWorkSessionResult {
  session: WorkSessionView;
  marked_done: number;
  /** True when an idempotency_key matched an earlier call: nothing new was written. */
  duplicate: boolean;
  forecast_line: string;
  forecast: PaceForecast;
}

/** Client idempotency keys share the source_ref column, namespaced so they can't collide with backfill refs. */
export function idempotencySourceRef(key: unknown): string | null {
  if (key === undefined || key === null) return null;
  if (typeof key !== "string" || !key.trim() || key.trim().length > 190) {
    bad("idempotency_key must be a non-empty string of at most 190 characters");
  }
  return `client:${(key as string).trim()}`;
}

async function sessionResult(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  projectId: string,
  task: TaskRow | null,
  markedDone: number,
  duplicate: boolean,
  now?: Date
): Promise<LogWorkSessionResult> {
  const session = await readSession(supabase, userId, sessionId);
  const focusType = await focusTypeFor(supabase, userId, session, task);
  const forecast = await getProjectForecast(supabase, userId, projectId, { now, focusType });
  return { session, marked_done: markedDone, duplicate, forecast_line: forecast.line, forecast: forecast.forecast };
}

/**
 * Logs one sitting. Inputs are parsed and resolved here (rows → item ids,
 * times); the write itself is one RPC (`work_session_create`): the session,
 * its links and the row ticks commit together or not at all, and the RPC
 * re-checks that every row is in the project.
 */
export async function logWorkSession(
  supabase: SupabaseClient,
  userId: string,
  rawBody: unknown,
  options: { now?: Date; defaultSource?: SessionSource } = {}
): Promise<LogWorkSessionResult> {
  const body = asRecord(rawBody);
  const target = await resolveTarget(supabase, userId, body.task_id, body.project_id);
  const timing = resolveSessionTiming(
    {
      date: body.date === undefined || body.date === null ? null : String(body.date),
      start: body.start === undefined || body.start === null ? null : String(body.start),
      end: body.end === undefined || body.end === null ? null : String(body.end),
      minutes: body.minutes === undefined || body.minutes === null ? null : (body.minutes as number),
    },
    options.now
  );
  if (!timing.ok) bad(timing.error);
  if (body.mark_items_done !== undefined && typeof body.mark_items_done !== "boolean") bad("mark_items_done must be true or false");
  const idempotencyRef = idempotencySourceRef(body.idempotency_key);
  if (idempotencyRef && body.source_ref !== undefined) bad("Give idempotency_key or source_ref, not both");
  const { idempotency_key: _ignored, ...rest } = body;
  void _ignored;
  const flags = parseSessionFlags(
    {
      ...rest,
      ...(rest.source === undefined && options.defaultSource ? { source: options.defaultSource } : {}),
      ...(idempotencyRef ? { source_ref: idempotencyRef } : {}),
    },
    false
  );

  // A retried call with the same idempotency key returns the first session.
  if (idempotencyRef) {
    const existing = await findBySourceRef(supabase, userId, idempotencyRef);
    if (existing) return sessionResult(supabase, userId, existing, target.projectId, target.task, 0, true, options.now);
  }
  const itemIds = await resolveItemIds(supabase, userId, target, body.item_ids, body.rows);

  if (flags.source_ref && !idempotencyRef) {
    const existing = await findBySourceRef(supabase, userId, flags.source_ref as string);
    if (existing) throw new WorkSessionServiceError(409, "A session with this source_ref already exists", { session_id: existing });
  }

  const { data, error } = await supabase.rpc("work_session_create", {
    p_user_id: userId,
    p_session: {
      project_id: target.projectId,
      task_id: target.task?.id ?? null,
      session_date: timing.value.session_date,
      started_at: timing.value.started_at,
      ended_at: timing.value.ended_at,
      minutes: timing.value.minutes,
      ...flags,
    },
    p_item_ids: itemIds,
    p_mark_done: body.mark_items_done !== false,
  });
  if (error) {
    // Two identical retries racing: the loser returns the winner's session.
    if (error.code === "23505" && idempotencyRef) {
      const existing = await findBySourceRef(supabase, userId, idempotencyRef);
      if (existing) return sessionResult(supabase, userId, existing, target.projectId, target.task, 0, true, options.now);
    }
    throw rpcError(error);
  }
  const created = data as { session_id: string; marked_done: number };
  return sessionResult(supabase, userId, created.session_id, target.projectId, target.task, created.marked_done, false, options.now);
}

export async function listWorkSessions(
  supabase: SupabaseClient,
  userId: string,
  params: { project_id?: string | null; task_id?: string | null; since?: string | null }
): Promise<WorkSessionView[]> {
  if (!params.project_id && !params.task_id) bad("Give project_id or task_id");
  if (params.since && !isDateOnly(params.since)) bad("since must be YYYY-MM-DD (ET)");
  const rows = await pagedSelect<Record<string, unknown>>((from, to) => {
    let query = supabase.from("work_sessions").select("*").eq("user_id", userId);
    if (params.project_id) query = query.eq("project_id", requireUuid(params.project_id, "project_id"));
    if (params.task_id) query = query.eq("task_id", requireUuid(params.task_id, "task_id"));
    if (params.since) query = query.gte("session_date", params.since);
    return query.order("session_date", { ascending: false }).order("created_at", { ascending: false }).range(from, to);
  });
  const sessions = rows.map(normalizeSessionRow);
  const links = await loadSessionItemIds(supabase, userId, sessions.map((session) => session.id));
  return sessions.map((session) => ({ ...session, item_ids: links.get(session.id) ?? [] }));
}

/**
 * Changes a session in one RPC (`work_session_update`): the fields and, when
 * item_ids/rows are given, the replacement links commit together or not at all.
 * Changing only the date moves the stored start/end to that day at the same ET
 * clock time; an ISO start/end must fall on the session's date.
 */
export async function updateWorkSession(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  rawBody: unknown,
  options: { now?: Date } = {}
): Promise<{ session: WorkSessionView; forecast_line: string }> {
  requireUuid(id, "id");
  const body = asRecord(rawBody);
  const allowed = [
    "task_id", "date", "start", "end", "minutes", "item_ids", "rows", "note",
    "exclude_from_stats", "exclude_reason", "extra_units", "extra_work_type",
  ];
  const unknownKeys = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) bad(`Unknown fields: ${unknownKeys.join(", ")}`, { allowed });
  if (Object.keys(body).length === 0) bad("No fields to update");

  const current = await readSession(supabase, userId, id);
  const changes: Record<string, unknown> = parseSessionFlags(body, true);

  let target: ResolvedTarget = { projectId: current.project_id, task: null };
  if ("task_id" in body) {
    if (body.task_id === null) {
      changes.task_id = null;
    } else {
      target = await resolveTarget(supabase, userId, body.task_id, current.project_id);
      changes.task_id = target.task!.id;
    }
  } else if (current.task_id) {
    target = await resolveTarget(supabase, userId, current.task_id, current.project_id);
  }

  if (["date", "start", "end", "minutes"].some((key) => key in body)) {
    const newDate = "date" in body ? (body.date === null ? null : String(body.date)) : current.session_date;
    if (!newDate || !isDateOnly(newDate)) bad("date must be YYYY-MM-DD (ET)");
    const moveStored = (stored: string | null) =>
      stored && newDate !== current.session_date ? reanchorInstant(stored, current.session_date, newDate as string) : stored;
    const timingInput = {
      date: newDate,
      // Untouched stored times follow a date change, keeping their ET clock time.
      start: "start" in body ? (body.start === null ? null : String(body.start)) : moveStored(current.started_at),
      end: "end" in body ? (body.end === null ? null : String(body.end)) : moveStored(current.ended_at),
      // A new start/end without new minutes recomputes minutes from them.
      minutes: "minutes" in body
        ? (body.minutes as number | null)
        : ("start" in body || "end" in body) ? null : current.minutes,
    };
    const timing = resolveSessionTiming(timingInput, options.now);
    if (!timing.ok) bad(timing.error);
    Object.assign(changes, timing.value);
  }

  const replaceItems = "item_ids" in body || "rows" in body;
  const itemIds = replaceItems ? await resolveItemIds(supabase, userId, target, body.item_ids, body.rows) : null;

  const { error } = await supabase.rpc("work_session_update", {
    p_user_id: userId,
    p_session_id: id,
    p_changes: changes,
    p_item_ids: itemIds,
  });
  if (error) throw rpcError(error);
  const session = await readSession(supabase, userId, id);
  const forecast = await getProjectForecast(supabase, userId, session.project_id, { now: options.now });
  return { session, forecast_line: forecast.line };
}

/** Deletes a session and its links in one RPC. Checklist rows it ticked stay ticked. */
export async function deleteWorkSession(supabase: SupabaseClient, userId: string, id: string) {
  requireUuid(id, "id");
  const { data, error } = await supabase.rpc("work_session_delete", { p_user_id: userId, p_session_id: id });
  if (error) throw rpcError(error);
  const result = data as { project_id: string };
  return { deleted: true, id, project_id: result.project_id, note: "Checklist rows it ticked stay ticked." };
}
