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
  CRAFT_ROW_ITEM_MATCH, CRAFT_SETUP_CHANGED, canonicalUnitText, craftSetupPayload, parseCreateBody, planCraftSetup,
  type CraftSetupPlan, type SetupSnapshot,
} from "@/lib/craft/setup";
import { craftSetupFingerprint } from "@/lib/craft/setup-fingerprint";
import { removeBlockersText } from "@/lib/craft";
import {
  parseResetBody, resetBlockerStop, resetCarry, resetCarryLines,
  type CraftResetPreview, type ResetCarryRow, type ResetOldPart,
} from "@/lib/craft/reset";

type Client = SupabaseClient<Database>;

/** Remove met a lock it couldn't wait for (40P01 / 55P03): nothing was removed. */
export const CRAFT_REMOVE_BUSY = "The project was busy and nothing was removed. Try again in a moment.";

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
    pagedSelect<SetupSnapshot["sections"][number]>((from, to) => client.from("project_sections").select("id, sort_order, created_at, name")
      .eq("user_id", userId).eq("project_id", projectId).order("id").range(from, to)),
    pagedSelect<SetupSnapshot["tasks"][number]>((from, to) => client.from("tasks").select("id, section_id, title, is_sample, created_at, unit_count::text, work_type")
      .eq("user_id", userId).eq("project_id", projectId).order("id").range(from, to)),
  ]).then(([sectionRows, taskRows]) => [sectionRows, taskRows.map((task) => ({
    ...task, unit_count: canonicalUnitText(task.unit_count === null || task.unit_count === undefined ? null : String(task.unit_count)), work_type: task.work_type ?? null,
  }))] as const);
  // unit_count as the database's numeric text, never through a JavaScript number (072 hashes trim_scale(unit_count)::text).
  const items = (await Promise.all(chunks(tasks.map((task) => task.id)).map((ids) => pagedSelect<SetupSnapshot["items"][number]>((from, to) => client
    .from("task_checklist_items").select("id, task_id, text, is_done, sort_order, unit_count::text, craft_part_id, work_type")
    .eq("user_id", userId).in("task_id", ids).order("id").range(from, to))))).flat()
    .map((item) => ({ ...item, unit_count: canonicalUnitText(item.unit_count === null || item.unit_count === undefined ? null : String(item.unit_count)), work_type: item.work_type ?? null }));
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
    // A deadlock or lock wait the database gave up on: nothing was written; the preview is the way back.
    if (error.code === "40P01" || error.code === "55P03") throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    throw error;
  }
  return data as { project_id: string; parts: number; segments: number; rows_linked: number; active_part_id: string | null; units_filled: number };
}

/** Reset met a lock it couldn't wait for: nothing changed. */
export const CRAFT_RESET_BUSY = "The project was busy and nothing was reset. Try again in a moment.";
export const CRAFT_RESET_NOT_ON_SCREEN = "This project isn’t on the craft screen. Use Set up craft screen from the project page.";

/**
 * S4 (B): the Reset preview. The plan is planCraftSetup's (reset mode: the old links and the craft row are not
 * STOPs); the fingerprint and the carry-over list come from 075's craft_reset_preview in one statement. The
 * plan's setup fingerprint must equal the one that statement hashed (else the rows moved between the two reads:
 * read again once, then "busy").
 */
export async function loadCraftResetPreview(client: Client, userId: string, projectId: string, attempt = 0): Promise<CraftResetPreview> {
  const snapshot = await loadSetupSnapshot(client, userId, projectId);
  if (!snapshot.on_craft_screen) throw new CraftSetupRefusal(409, CRAFT_RESET_NOT_ON_SCREEN, "not_on_screen");
  const plan = planCraftSetup(snapshot, { reset: true });
  const { data, error } = await client.rpc("craft_reset_preview", { p_user_id: userId, p_project_id: projectId });
  if (error) throw error;
  const reply = data as unknown as { setup_fingerprint: string; fingerprint: string; blockers: string[] | null; old_parts: ResetOldPart[]; carry: ResetCarryRow[]; on_craft_screen: boolean };
  if (!reply.on_craft_screen) throw new CraftSetupRefusal(409, CRAFT_RESET_NOT_ON_SCREEN, "not_on_screen");
  if (reply.setup_fingerprint !== craftSetupFingerprint(snapshot)) {
    if (attempt < 1) return loadCraftResetPreview(client, userId, projectId, attempt + 1);
    throw new CraftSetupRefusal(409, CRAFT_RESET_BUSY, "busy");
  }
  const blockers = reply.blockers ?? [];
  const stops = blockers.length ? [resetBlockerStop(blockers), ...plan.stops] : plan.stops;
  const carry = resetCarry(reply.carry ?? [], reply.old_parts ?? []);
  return {
    plan: { ...plan, ok: stops.length === 0, stops, stitch_fills: stops.length === 0 ? plan.stitch_fills : [] },
    fingerprint: reply.fingerprint, old_parts: reply.old_parts ?? [], carry, carry_lines: resetCarryLines(carry), blockers,
  };
}

/** Reset: a fresh preview, the caller's fingerprint, then ONE 075 call. */
export async function resetCraftProject(client: Client, userId: string, projectId: string, body: unknown) {
  const preview = await loadCraftResetPreview(client, userId, projectId);
  const { plan } = preview;
  if (!plan.ok) throw new CraftSetupRefusal(409, plan.stops[0] ?? "This project can't be reset.", "stop", plan.stops);
  const parsed = parseResetBody(body, plan.parts.length);
  if (!parsed.ok) {
    if (body && typeof body === "object" && Array.isArray((body as { names?: unknown }).names) && (body as { names: unknown[] }).names.length !== plan.parts.length) {
      throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    }
    throw new CraftSetupRefusal(400, parsed.error, "invalid");
  }
  if (parsed.value.fingerprint !== preview.fingerprint) throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
  const { craft: _craft, ...payload } = craftSetupPayload(plan, "other", parsed.value.names);
  void _craft;
  const { data, error } = await client.rpc("craft_reset_project", {
    p_user_id: userId, p_project_id: projectId, p_plan: payload as unknown as Json, p_fingerprint: preview.fingerprint,
  });
  if (error) {
    if (error.code === "MC072") throw new CraftSetupRefusal(409, CRAFT_SETUP_CHANGED, "changed");
    if (error.code === "P0002") throw new CraftSetupRefusal(409, CRAFT_RESET_NOT_ON_SCREEN, "not_on_screen");
    if (error.code === "MC75K") {
      const keys = String((error as { details?: string | null }).details ?? "").split(",").filter(Boolean);
      throw new CraftSetupRefusal(409, resetBlockerStop(keys), "keeps");
    }
    if (error.code === "22023") throw new CraftSetupRefusal(400, "The reset plan was not accepted. Open the preview again.", "invalid");
    if (error.code === "40P01" || error.code === "55P03") throw new CraftSetupRefusal(409, CRAFT_RESET_BUSY, "busy");
    throw error;
  }
  return data as { project_id: string; parts: number; segments: number; rows_linked: number; active_part_id: string | null; units_filled: number;
    old_parts: number; carried: Record<string, number>; lost: Record<string, number> };
}

/** Remove: the craft_projects read is the 404 (PGRST116); 072 unlinks the rows, then removes the craft rows. */
export async function removeCraftProject(client: Client, userId: string, projectId: string) {
  const found = await client.from("craft_projects").select("project_id").eq("user_id", userId).eq("project_id", projectId).single();
  if (found.error) throw found.error;
  const { data, error } = await client.rpc("craft_remove_project", { p_user_id: userId, p_project_id: projectId });
  if (error) {
    if (error.code === "P0002") throw new CraftSetupRefusal(409, "This project is no longer on the craft screen.", "gone");
    // 072 refuses when the project has things Set up can't make again (links, instructions, …): nothing changed.
    if (error.code === "MC72R") {
      const keys = String((error as { details?: string | null }).details ?? "").split(",").filter(Boolean);
      throw new CraftSetupRefusal(409, `This project can’t be removed from the craft screen: it has ${removeBlockersText(keys)} that Set up can’t make again.`, "keeps");
    }
    // S1C re-check (073 carry-over c): a deadlock or lock wait the database gave up on, like Create: nothing changed.
    if (error.code === "40P01" || error.code === "55P03") throw new CraftSetupRefusal(409, CRAFT_REMOVE_BUSY, "busy");
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
      .eq("user_id", userId).in("task_id", ids).filter("text", "match", CRAFT_ROW_ITEM_MATCH).limit(1);
    if (error) throw error;
    if (data?.length) return true;
  }
  return false;
}
