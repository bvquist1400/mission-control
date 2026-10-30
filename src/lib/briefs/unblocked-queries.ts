import type { SupabaseClient } from "@supabase/supabase-js";
import { isPersonalTaskOrProject } from "@/lib/personal-exclusion";
import { fetchAllPages } from "@/lib/task-dependency-links";
import { isNowUnblocked, UNBLOCK_RETRY_MAX_ATTEMPTS } from "@/lib/task-unblocks";
import type { UnblockPill } from "@/lib/briefs/unblocked";
import type { TaskStatus } from "@/types/database";

// The two reads behind the brief's "Recently unblocked" section. Both run on save.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

const ID_CHUNK_SIZE = 100;

interface OpenUnblockRow {
  id: string;
  task_id: string;
  unblocked_at: string;
  waited_on_task_ids: string[] | null;
  waited_on_commitment_ids: string[] | null;
}

interface PillTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
  unblocked_at: string | null;
  is_recurring_template: boolean | null;
  tags: string[] | null;
  project?: unknown;
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += ID_CHUNK_SIZE) out.push(values.slice(index, index + ID_CHUNK_SIZE));
  return out;
}

/** Titles of the items a row may name; anything personal is only counted (a work brief drops personal work). */
async function readBlockerTitles(supabase: AnySupabase, userId: string, rows: OpenUnblockRow[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const taskIds = [...new Set(rows.flatMap((row) => row.waited_on_task_ids ?? []))];
  const commitmentIds = [...new Set(rows.flatMap((row) => row.waited_on_commitment_ids ?? []))];

  for (const ids of chunks(taskIds)) {
    const { data, error } = await supabase.from("tasks").select("id, title, tags, project:projects(tags)").eq("user_id", userId).in("id", ids);
    if (error) throw error;
    for (const task of (data ?? []) as Array<{ id: string; title: string; tags: string[] | null; project?: unknown }>) {
      if (!isPersonalTaskOrProject(task)) titles.set(task.id, task.title);
    }
  }
  for (const ids of chunks(commitmentIds)) {
    const { data, error } = await supabase
      .from("commitments")
      .select("id, title, task:tasks(tags, project:projects(tags))")
      .eq("user_id", userId)
      .in("id", ids);
    if (error) throw error;
    for (const commitment of (data ?? []) as Array<{ id: string; title: string; task?: unknown }>) {
      const linked = [commitment.task].flat().filter(Boolean) as Array<{ tags?: string[] | null; project?: unknown }>;
      if (!linked.some((task) => isPersonalTaskOrProject(task))) titles.set(commitment.id, commitment.title);
    }
  }
  return titles;
}

/**
 * Every task showing the pill right now, newest unblock first: an open
 * task_unblocks row, the task still open with `unblocked_at` set. Personal tasks
 * are left out, like every other part of the work briefs, and so are repeating
 * templates (the template isn't a thing to do; its instances get their own row).
 * Paged on the row id until an empty page, so PostgREST's row cap can't cut it off.
 */
export async function readOpenUnblockPills(supabase: AnySupabase, userId: string): Promise<UnblockPill[]> {
  const open = await fetchAllPages<OpenUnblockRow>((afterId, limit) => {
    let query = supabase
      .from("task_unblocks")
      .select("id, task_id, unblocked_at, waited_on_task_ids, waited_on_commitment_ids")
      .eq("user_id", userId)
      .is("cleared_at", null)
      .is("reverted_at", null);
    if (afterId) query = query.gt("id", afterId);
    return query.order("id", { ascending: true }).limit(limit);
  });
  if (open.length === 0) return [];

  const tasks = new Map<string, PillTaskRow>();
  for (const ids of chunks([...new Set(open.map((row) => row.task_id))])) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, status, due_at, unblocked_at, is_recurring_template, tags, project:projects(tags)")
      .eq("user_id", userId)
      .in("id", ids);
    if (error) throw error;
    for (const task of (data ?? []) as PillTaskRow[]) tasks.set(task.id, task);
  }

  const showing = open
    .filter((row) => {
      const task = tasks.get(row.task_id);
      return Boolean(task) && isNowUnblocked(task!) && !task!.is_recurring_template && !isPersonalTaskOrProject(task!);
    })
    .sort((a, b) => Date.parse(b.unblocked_at) - Date.parse(a.unblocked_at));
  if (showing.length === 0) return [];

  const titles = await readBlockerTitles(supabase, userId, showing);
  return showing.map((row) => {
    const task = tasks.get(row.task_id)!;
    const waited = [...(row.waited_on_task_ids ?? []), ...(row.waited_on_commitment_ids ?? [])];
    const named = waited.map((id) => titles.get(id)).filter((title): title is string => Boolean(title));
    return {
      task_id: task.id,
      title: task.title,
      status: task.status,
      due_at: task.due_at,
      unblocked_at: row.unblocked_at,
      waited_on: named,
      waited_on_hidden: waited.length - named.length,
    };
  });
}

/** Retries that gave up: `closed_at IS NULL AND attempts >= 8` (067, header 7). A count, no row is read. */
export async function countStuckUnblockRetries(supabase: AnySupabase, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("task_unblock_retries")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("closed_at", null)
    .gte("attempts", UNBLOCK_RETRY_MAX_ATTEMPTS);
  if (error) throw error;
  return count ?? 0;
}
