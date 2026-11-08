/** Server-only reads using the caller's client, with RLS and explicit owner filters. */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase.generated";
import { buildCraftView, type CraftInput } from "@/lib/craft";
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

export async function loadCraftView(client: SupabaseClient<Database>, userId: string, projectId?: string, now = new Date()) {
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
