import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortfolioInput, PortfolioTaskRow } from "@/lib/portfolio";

const TASK_COLUMNS =
  "id, title, status, owner, owner_label, status_line, due_at, created_at, updated_at, priority_score, implementation_id, project_id, section_id, is_recurring_template, tags, project:projects(tags)";

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

  const [implementations, projects, sections] = await Promise.all([
    supabase
      .from("implementations")
      .select("id, name, phase, rag, status_summary, next_milestone, next_milestone_date, portfolio_rank")
      .eq("user_id", userId),
    supabase
      .from("projects")
      .select("id, name, implementation_id, stage, portfolio_rank")
      .eq("user_id", userId),
    supabase
      .from("project_sections")
      .select("id, project_id, name, sort_order")
      .eq("user_id", userId),
  ]);
  if (implementations.error) throw implementations.error;
  if (projects.error) throw projects.error;
  if (sections.error) throw sections.error;

  return {
    tasks,
    implementations: implementations.data ?? [],
    projects: projects.data ?? [],
    sections: sections.data ?? [],
  };
}
