/**
 * Craft estimates (E2): `GET /api/craft/pace` reads every craft project's estimate in one call (`?project_id=`
 * narrows it to one; the craft screen sends its own until E4's All projects tab needs the rest). Computed, never
 * stored: the project's forecast input (the same reads as the project page's forecast) plus its craft parts and
 * rows, through the pure `buildCraftEstimate`. One project failing leaves the others (and the screen) working.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase.generated";
import { buildCraftEstimate, type CraftEstimate, type EstimatePart, type EstimateRow } from "@/lib/craft/estimate";
import { etToday, loadProjectPaceInput } from "@/lib/work-sessions/service";
import { chunks, pagedSelect } from "@/lib/supabase/batch";

export interface CraftPaceEntry { project_id: string; name: string | null; estimate: CraftEstimate | null; error: string | null }
export interface CraftPaceReply { today: string; projects: CraftPaceEntry[] }

export async function getCraftPace(client: SupabaseClient<Database>, userId: string, projectId: string | null, now = new Date()): Promise<CraftPaceReply> {
  const today = etToday(now);
  let query = client.from("craft_projects").select("project_id, active_part_id").eq("user_id", userId);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query.order("project_id");
  if (error) throw error;
  const crafts = data ?? [];
  const projects: CraftPaceEntry[] = [];
  for (const craft of crafts) {
    try {
      const [{ project, input }, parts] = await Promise.all([
        loadProjectPaceInput(client as unknown as SupabaseClient, userId, craft.project_id, today),
        pagedSelect<EstimatePart>((from, to) => client.from("craft_parts").select("id, name, sort_order, row_word, total_rows, stitch_count")
          .eq("user_id", userId).eq("project_id", craft.project_id).order("id").range(from, to)),
      ]);
      const rows: EstimateRow[] = [];
      for (const ids of chunks(parts.map((part) => part.id))) {
        const items = await pagedSelect<{ id: string; craft_part_id: string | null; craft_row: number | null; is_done: boolean; completed_at: string | null }>((from, to) => client
          .from("task_checklist_items").select("id, craft_part_id, craft_row, is_done, completed_at").eq("user_id", userId).in("craft_part_id", ids).order("id").range(from, to));
        for (const item of items) {
          if (item.craft_part_id && item.craft_row !== null) rows.push({ item_id: item.id, part_id: item.craft_part_id, row: item.craft_row, is_done: item.is_done, completed_at: item.completed_at });
        }
      }
      projects.push({ project_id: craft.project_id, name: project.name, estimate: buildCraftEstimate({ pace: input, parts, rows, active_part_id: craft.active_part_id }), error: null });
    } catch (failure) {
      console.error("Craft estimate failed for one project:", (failure as { code?: string } | null)?.code ?? "error");
      projects.push({ project_id: craft.project_id, name: null, estimate: null, error: "unavailable" });
    }
  }
  return { today, projects };
}
