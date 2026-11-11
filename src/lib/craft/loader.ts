/** Server-only reads using the caller's client, with RLS and explicit owner filters. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase.generated";
import { buildCraftProjectList, buildCraftView, type CraftInput, type CraftProjectListInput, type CraftScreenView } from "@/lib/craft";
import { chunks, pagedSelect } from "@/lib/supabase/batch";

type Tables = Database["public"]["Tables"];
export class CraftNotFoundError extends Error {}

async function lastProject(client: SupabaseClient<Database>, userId: string): Promise<string> {
  const projects = await pagedSelect<Tables["craft_projects"]["Row"]>((from, to) => client.from("craft_projects")
    .select("*").eq("user_id", userId).order("created_at", { ascending: false }).order("project_id").range(from, to));
  if (!projects.length) throw new CraftNotFoundError("No craft projects yet");
  const latest = [];
  for (const ids of chunks(projects.map((project) => project.project_id))) {
    const { data, error } = await client.from("work_sessions").select("project_id, session_date, created_at, id")
      .eq("user_id", userId).in("project_id", ids).order("session_date", { ascending: false })
      .order("created_at", { ascending: false }).order("id").limit(1);
    if (error) throw error;
    if (data?.[0]) latest.push(data[0]);
  }
  latest.sort((a, b) => b.session_date.localeCompare(a.session_date) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return latest[0]?.project_id ?? projects[0].project_id;
}

/** Every craft project the caller owns, for the title switcher: 4 reads in all, however many projects. */
export async function loadCraftProjects(client: SupabaseClient<Database>, userId: string) {
  const crafts = await pagedSelect<CraftProjectListInput["craft_projects"][number]>((from, to) => client.from("craft_projects")
    .select("project_id, craft, active_part_id").eq("user_id", userId).order("project_id").range(from, to));
  if (!crafts.length) return [];
  const projectIds = chunks(crafts.map((craft) => craft.project_id));
  const [projects, parts] = await Promise.all([
    Promise.all(projectIds.map((ids) => pagedSelect<CraftProjectListInput["projects"][number]>((from, to) => client.from("projects")
      .select("id, name").eq("user_id", userId).in("id", ids).order("id").range(from, to)))).then((pages) => pages.flat()),
    Promise.all(projectIds.map((ids) => pagedSelect<CraftProjectListInput["parts"][number]>((from, to) => client.from("craft_parts")
      .select("id, project_id, name, sort_order, total_rows, row_word, quarters, quarter, quarter_row, ridges, stitch_count")
      .eq("user_id", userId).in("project_id", ids).order("id").range(from, to)))).then((pages) => pages.flat()),
  ]);
  const items = (await Promise.all(chunks(parts.map((part) => part.id)).map((ids) => pagedSelect<CraftProjectListInput["items"][number]>((from, to) => client
    .from("task_checklist_items").select("id, craft_part_id, craft_row, is_done").eq("user_id", userId).in("craft_part_id", ids)
    .eq("is_done", false).order("id").range(from, to))))).flat();
  return buildCraftProjectList({ craft_projects: crafts, projects, parts, items });
}

export async function loadCraftView(client: SupabaseClient<Database>, userId: string, projectId?: string, now = new Date()): Promise<CraftScreenView> {
  // The list loads alongside the view; the view's own error (404 vs 500) wins when both fail.
  const [view, projects] = await Promise.allSettled([loadOneCraftView(client, userId, projectId, now), loadCraftProjects(client, userId)]);
  if (view.status === "rejected") throw view.reason;
  if (projects.status === "rejected") throw projects.reason;
  return { ...view.value, projects: projects.value };
}

async function loadOneCraftView(client: SupabaseClient<Database>, userId: string, projectId: string | undefined, now: Date) {
  const id = projectId ?? await lastProject(client, userId);
  const [projectResult, craftResult] = await Promise.all([
    client.from("projects").select("id, name").eq("user_id", userId).eq("id", id).single(),
    client.from("craft_projects").select("*").eq("user_id", userId).eq("project_id", id).single(),
  ]);
  if (projectResult.error) throw projectResult.error;
  if (craftResult.error) throw craftResult.error;
  const [parts, sessions, timerResult] = await Promise.all([
    pagedSelect<Tables["craft_parts"]["Row"]>((from, to) => client.from("craft_parts").select("*").eq("user_id", userId).eq("project_id", id).order("id").range(from, to)),
    pagedSelect<Tables["work_sessions"]["Row"]>((from, to) => client.from("work_sessions").select("*").eq("user_id", userId).eq("project_id", id).order("id").range(from, to)),
    client.from("craft_timers").select("*").eq("user_id", userId).eq("project_id", id).maybeSingle(),
  ]);
  if (timerResult.error) throw timerResult.error;
  const items: CraftInput["items"] = [], segments: CraftInput["segments"] = [];
  const session_items: CraftInput["session_items"] = [], sitting_details: CraftInput["sitting_details"] = [];
  for (const ids of chunks(parts.map((part) => part.id))) {
    const [partItems, partSegments] = await Promise.all([
      pagedSelect<Tables["task_checklist_items"]["Row"]>((from, to) => client.from("task_checklist_items").select("*").eq("user_id", userId).in("craft_part_id", ids).order("id").range(from, to)),
      pagedSelect<Tables["craft_segments"]["Row"]>((from, to) => client.from("craft_segments").select("*").eq("user_id", userId).in("part_id", ids).order("id").range(from, to)),
    ]);
    items.push(...partItems); segments.push(...partSegments);
  }
  for (const ids of chunks(sessions.map((session) => session.id))) {
    const [links, details] = await Promise.all([
      pagedSelect<Tables["work_session_items"]["Row"]>((from, to) => client.from("work_session_items").select("*").eq("user_id", userId).in("session_id", ids).order("session_id").order("checklist_item_id").range(from, to)),
      pagedSelect<Tables["craft_sitting_details"]["Row"]>((from, to) => client.from("craft_sitting_details").select("*").eq("user_id", userId).in("session_id", ids).order("session_id").range(from, to)),
    ]);
    session_items.push(...links); sitting_details.push(...details);
  }
  return buildCraftView({ project: projectResult.data, craft_project: craftResult.data, parts, segments, items,
    sessions, session_items, sitting_details, timer: timerResult.data, server_now: now.toISOString() });
}
