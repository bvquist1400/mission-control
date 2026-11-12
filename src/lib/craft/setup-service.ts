/**
 * Server-only: read a project for "Set up craft screen", write it with migration 072's
 * craft_setup_project, and take a project off the craft screen with craft_remove_project.
 * Reads use the caller's client (RLS) with explicit user filters. The paged reads are not one
 * snapshot, which is fine: 072 rebuilds the fingerprint under its locks and refuses any difference.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase.generated";
import { chunks, pagedSelect } from "@/lib/supabase/batch";
import {
  CRAFT_SETUP_CHANGED, craftSetupPayload, parseCreateBody, planCraftSetup,
  type CraftSetupPlan, type SetupSnapshot,
} from "@/lib/craft/setup";
import { craftSetupFingerprint } from "@/lib/craft/setup-fingerprint";

type Client = SupabaseClient<Database>;

/** A refusal with plain words for the screen; the route answers with this status. */
export class CraftSetupRefusal extends Error {
  status: 400 | 409;
  reason: string;
  stops?: string[];
  constructor(status: 400 | 409, message: string, reason: string, stops?: string[]) {
    super(message);
    this.status = status; this.reason = reason; this.stops = stops;
  }
}

export async function loadSetupSnapshot(client: Client, userId: string, projectId: string): Promise<SetupSnapshot> {
  const [projectResult, craftResult] = await Promise.all([
    client.from("projects").select("id, name, tags").eq("user_id", userId).eq("id", projectId).single(),
    client.from("craft_projects").select("project_id").eq("user_id", userId).eq("project_id", projectId).maybeSingle(),
  ]);
  if (projectResult.error) throw projectResult.error;
  if (craftResult.error) throw craftResult.error;
  const [sections, tasks] = await Promise.all([
    pagedSelect<SetupSnapshot["sections"][number]>((from, to) => client.from("project_sections").select("id, sort_order, created_at")
      .eq("user_id", userId).eq("project_id", projectId).order("id").range(from, to)),
    pagedSelect<SetupSnapshot["tasks"][number]>((from, to) => client.from("tasks").select("id, section_id, title, is_sample, created_at")
      .eq("user_id", userId).eq("project_id", projectId).order("id").range(from, to)),
  ]);
  const items = (await Promise.all(chunks(tasks.map((task) => task.id)).map((ids) => pagedSelect<SetupSnapshot["items"][number]>((from, to) => client
    .from("task_checklist_items").select("id, task_id, text, is_done, sort_order, unit_count, craft_part_id")
    .eq("user_id", userId).in("task_id", ids).order("id").range(from, to))))).flat();
  return { project: projectResult.data, on_craft_screen: craftResult.data !== null, sections, tasks, items };
}

export interface CraftSetupPreview { plan: CraftSetupPlan; fingerprint: string }

export async function loadCraftSetupPreview(client: Client, userId: string, projectId: string): Promise<CraftSetupPreview> {
  const snapshot = await loadSetupSnapshot(client, userId, projectId);
  return { plan: planCraftSetup(snapshot), fingerprint: craftSetupFingerprint(snapshot) };
}

/** Create: a fresh read, the same plan, the preview's fingerprint, then one 072 call. */
export async function createCraftSetup(client: Client, userId: string, projectId: string, body: unknown) {
  const { plan, fingerprint } = await loadCraftSetupPreview(client, userId, projectId);
  if (!plan.ok) throw new CraftSetupRefusal(409, plan.stops[0] ?? "This project can't be set up yet.", "stop", plan.stops);
  const parsed = parseCreateBody(body, plan.parts.length);
  if (!parsed.ok) {
    // A preview with a different number of parts is a changed project, not a bad request.
    if (body && typeof body === "object" && Array.isArray((body as { names?: unknown }).names) && (body as { names: unknown[] }).names.length !== plan.parts.length) {
      throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    }
    throw new CraftSetupRefusal(400, parsed.error, "invalid");
  }
  if (parsed.value.fingerprint !== fingerprint) throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
  const payload = craftSetupPayload(plan, parsed.value.craft, parsed.value.names);
  const { data, error } = await client.rpc("craft_setup_project", {
    p_user_id: userId, p_project_id: projectId, p_plan: payload as unknown as Json, p_fingerprint: fingerprint,
  });
  if (error) {
    if (error.code === "MC072") throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    if (error.code === "23505") throw new CraftSetupRefusal(409, "This project is already on the craft screen.", "exists");
    if (error.code === "P0002") throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    if (error.code === "22023") throw new CraftSetupRefusal(400, "The setup plan was not accepted. Open the preview again.", "invalid");
    throw error;
  }
  return data as { project_id: string; parts: number; segments: number; rows_linked: number; active_part_id: string | null };
}

/** Remove: the craft_projects read is the 404 (PGRST116); 072 unlinks the rows, then removes the craft rows. */
export async function removeCraftProject(client: Client, userId: string, projectId: string) {
  const found = await client.from("craft_projects").select("project_id").eq("user_id", userId).eq("project_id", projectId).single();
  if (found.error) throw found.error;
  const { data, error } = await client.rpc("craft_remove_project", { p_user_id: userId, p_project_id: projectId });
  if (error) {
    if (error.code === "P0002") throw new CraftSetupRefusal(409, "This project is no longer on the craft screen.", "gone");
    throw error;
  }
  return data as { project_id: string; items_unlinked: number; parts_removed: number; segments_removed: number };
}

/** For the project page: show "Set up craft screen" only with at least one numbered row item outside a swatch task. */
export async function projectHasRowItems(client: Client, userId: string, projectId: string): Promise<boolean> {
  const tasks = await pagedSelect<{ id: string }>((from, to) => client.from("tasks").select("id")
    .eq("user_id", userId).eq("project_id", projectId).eq("is_sample", false).order("id").range(from, to));
  for (const ids of chunks(tasks.map((task) => task.id))) {
    const { data, error } = await client.from("task_checklist_items").select("id")
      .eq("user_id", userId).in("task_id", ids).filter("text", "match", "^(Row|Rnd|Round)[[:space:]]+[0-9]").limit(1);
    if (error) throw error;
    if (data?.length) return true;
  }
  return false;
}
