import type { SupabaseClient } from "@supabase/supabase-js";
import { isOpenTask, type PortfolioInput, type PortfolioTaskRow } from "@/lib/portfolio";
import { fetchTaskDependencySummaries } from "@/lib/task-dependencies";

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

function single<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function loadPortfolioInput(supabase: SupabaseClient, userId: string): Promise<PortfolioInput> {
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

  const [implementations, projects, sections, blockers] = await Promise.all([
    supabase
      .from("implementations")
      .select("id, name, phase, rag, status_summary, next_milestone, next_milestone_date, portfolio_rank")
      .eq("user_id", userId),
    supabase
      .from("projects")
      .select("id, name, implementation_id, stage, portfolio_rank, target_date")
      .eq("user_id", userId),
    supabase
      .from("project_sections")
      .select("id, project_id, name, sort_order, planned_start, planned_end")
      .eq("user_id", userId),
    loadBrentBlockers(supabase, userId, tasks),
  ]);
  if (implementations.error) throw implementations.error;
  if (projects.error) throw projects.error;
  if (sections.error) throw sections.error;

  return {
    tasks,
    implementations: implementations.data ?? [],
    projects: projects.data ?? [],
    sections: sections.data ?? [],
    blockers,
  };
}
