import type { SupabaseClient } from "@supabase/supabase-js";
import { isOpenTask, type ChecklistProgress, type PortfolioInput, type PortfolioTaskRow } from "@/lib/portfolio";
import type { PaceForecast } from "@/lib/pace";
import { fetchTaskDependencySummaries } from "@/lib/task-dependencies";
import { getProjectForecast } from "@/lib/work-sessions/service";

const TASK_COLUMNS =
  "id, title, status, owner, owner_label, status_line, due_at, created_at, updated_at, priority_score, implementation_id, project_id, section_id, is_recurring_template, tags, waiting_on, blocked_reason, follow_up_at, project:projects(tags)";

/** Keeps each dependency lookup's id list (a URL filter) short. */
const DEPENDENCY_CHUNK = 100;

/**
 * Unfinished dependencies for Brent's open tasks: a task that still waits on
 * another isn't his to act on yet. Agents' tasks don't need the lookup.
 */
async function loadBrentBlockers(
  supabase: SupabaseClient,
  userId: string,
  tasks: PortfolioTaskRow[]
): Promise<Record<string, string[]>> {
  const ids = tasks
    .filter((task) => task.owner === "brent" && isOpenTask(task) && !task.is_recurring_template)
    .map((task) => task.id);
  const blockers: Record<string, string[]> = {};
  for (let from = 0; from < ids.length; from += DEPENDENCY_CHUNK) {
    const summaries = await fetchTaskDependencySummaries(supabase, userId, ids.slice(from, from + DEPENDENCY_CHUNK));
    for (const [taskId, list] of summaries) {
      const titles = list.filter((dependency) => dependency.unresolved).map((dependency) => dependency.title);
      if (titles.length > 0) blockers[taskId] = titles;
    }
  }
  return blockers;
}

/** PostgREST caps a response (1,000 rows by default), so read tasks in pages. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

/**
 * Checklist items ticked / all per task, for % done's partial credit. One paged read of the
 * user's items (two small columns each, not one query per task); a task with no items has no entry.
 * Scoped by user_id like every other query here; RLS also limits it to the signed-in user.
 */
export async function loadChecklistProgress(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, ChecklistProgress>> {
  const progress: Record<string, ChecklistProgress> = {};
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("task_checklist_items")
      .select("task_id, is_done")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ task_id: string; is_done: boolean }>;
    for (const row of rows) {
      const entry = (progress[row.task_id] ??= { done: 0, total: 0 });
      entry.total += 1;
      if (row.is_done) entry.done += 1;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return progress;
}

function single<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export interface PortfolioQueryDeps {
  /** The forecast for one project (default: the work-sessions service). Injected in tests. */
  getForecast?: (
    supabase: SupabaseClient,
    userId: string,
    projectId: string
  ) => Promise<{ forecast: PaceForecast }>;
}

/**
 * Forecasts for the projects that count units (`unit_label`), one service call each. Pace only adds to the
 * page, so a failing forecast is logged and that project simply has no pace line.
 */
export async function loadPortfolioPace(
  supabase: SupabaseClient,
  userId: string,
  projects: Array<{ id: string; unit_label?: string | null }>,
  deps: PortfolioQueryDeps = {}
): Promise<Record<string, PaceForecast>> {
  const getForecast = deps.getForecast ?? ((client, user, projectId) => getProjectForecast(client, user, projectId));
  const pace: Record<string, PaceForecast> = {};
  for (const project of projects) {
    if (!project.unit_label) continue;
    try {
      pace[project.id] = (await getForecast(supabase, userId, project.id)).forecast;
    } catch (error) {
      console.error(`[portfolio] failed to load the pace forecast for project ${project.id}; showing it without pace:`, error);
    }
  }
  return pace;
}

export async function loadPortfolioInput(
  supabase: SupabaseClient,
  userId: string,
  deps: PortfolioQueryDeps = {}
): Promise<PortfolioInput> {
  const tasks: PortfolioTaskRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<PortfolioTaskRow & { project: unknown }>;
    for (const row of rows) {
      tasks.push({ ...row, project: single(row.project as PortfolioTaskRow["project"] | PortfolioTaskRow["project"][]) });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const [implementations, projects, sections, blockers, checklist] = await Promise.all([
    supabase
      .from("implementations")
      .select("id, name, phase, rag, status_summary, next_milestone, next_milestone_date, portfolio_rank")
      .eq("user_id", userId),
    supabase
      .from("projects")
      .select("id, name, implementation_id, stage, portfolio_rank, target_date, tags, unit_label")
      .eq("user_id", userId),
    supabase
      .from("project_sections")
      .select("id, project_id, name, sort_order, planned_start, planned_end")
      .eq("user_id", userId),
    loadBrentBlockers(supabase, userId, tasks),
    // The checklist only adds partial credit, so a failed read must not take the page down:
    // log it and fall back to whole-task percentages (no partial credit), as before checklists counted.
    loadChecklistProgress(supabase, userId).catch((error: unknown) => {
      console.error("[portfolio] failed to load checklist progress; showing whole-task percentages:", error);
      return {} as Record<string, ChecklistProgress>;
    }),
  ]);
  if (implementations.error) throw implementations.error;
  if (projects.error) throw projects.error;
  if (sections.error) throw sections.error;

  const projectRows = projects.data ?? [];
  return {
    tasks,
    implementations: implementations.data ?? [],
    projects: projectRows,
    sections: sections.data ?? [],
    blockers,
    checklist,
    pace: await loadPortfolioPace(supabase, userId, projectRows, deps),
  };
}
