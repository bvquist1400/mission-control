import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateFinalPriorityScore,
  calculatePriorityBoosts,
  getHighPriorityStakeholderNames,
  recalculateTaskPriority,
} from "@/lib/priority";
import { queueTaskStatusTransition } from "@/lib/task-status-transitions";
import { isTaskExternalSourceUniqueViolation } from "@/lib/task-external-source";
import {
  BRIEF_TIME_ZONE,
  buildBriefCode,
  computeBriefItemKey,
  normalizeBriefCode,
  resolveTomorrowDueAt,
} from "@/lib/briefs/keys";
import { normalizeBriefContent } from "@/lib/briefs/validate";
import {
  EOD_PROPOSAL_SOURCE_SYSTEM,
  type BriefAction,
  type BriefActionInput,
  type BriefContent,
  type BriefCounts,
  type BriefItemKind,
  type BriefItemRow,
  type BriefItemState,
  type BriefMeeting,
  type BriefRow,
  type BriefTaskSummary,
  type BriefView,
  type SaveBriefInput,
} from "@/lib/briefs/types";
import type { Task, TaskStatus } from "@/types/database";

// Supabase clients arrive both typed (<Database>) and untyped depending on the
// auth path, so the service accepts either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>;

export class BriefServiceError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "BriefServiceError";
    this.status = status;
    this.details = details;
  }
}

const BRIEF_SELECT = "id, user_id, edition, brief_date, code, content, covered_meeting_ids, emailed_at, created_at, updated_at";
const ITEM_SELECT =
  "id, user_id, brief_id, n, item_key, kind, payload, task_ids, source, state, dismissed_reason, dismissed_note, choice, created_task_id, acted_at, created_at, updated_at";
const TASK_ACTION_SELECT = "id, user_id, title, status, due_at, base_priority, priority_score, stakeholder_mentions";

/** Kinds whose items come from meetings (the "decide" list); the rest need a call. */
export const MEETING_ITEM_KINDS: ReadonlySet<BriefItemKind> = new Set(["proposed_task"]);

/** Which actions each kind accepts, and from which states. Same-state repeats are idempotent. */
const ACTION_RULES: Record<BriefItemKind, Partial<Record<BriefAction, { from: BriefItemState[]; to: BriefItemState | "open" }>>> = {
  proposed_task: {
    accept: { from: ["open", "dismissed"], to: "accepted" },
    dismiss: { from: ["open", "dismissed"], to: "dismissed" },
    undo: { from: ["dismissed"], to: "open" },
  },
  carry_over: {
    done: { from: ["open"], to: "done" },
    tomorrow: { from: ["open"], to: "deferred" },
    park: { from: ["open"], to: "parked" },
  },
  carry_group: {
    tomorrow: { from: ["open"], to: "deferred" },
    park: { from: ["open"], to: "parked" },
  },
  choice: {
    pick: { from: ["open", "decided"], to: "decided" },
    undo: { from: ["decided"], to: "open" },
  },
};

export function allowedActionsForKind(kind: BriefItemKind): BriefAction[] {
  return Object.keys(ACTION_RULES[kind]) as BriefAction[];
}

/** Repeating accept/done/tomorrow/park on an item already in that state is a no-op success. */
const IDEMPOTENT_ACTIONS: ReadonlySet<BriefAction> = new Set(["accept", "done", "tomorrow", "park"]);

function isRepeat(item: BriefItemRow, action: BriefAction): boolean {
  const rule = ACTION_RULES[item.kind][action];
  return Boolean(rule) && IDEMPOTENT_ACTIONS.has(action) && item.state === rule!.to;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asBriefRow(row: Record<string, unknown>): BriefRow {
  return { ...(row as unknown as BriefRow), content: normalizeBriefContent(row.content) };
}

function asItemRow(row: Record<string, unknown>): BriefItemRow {
  const item = row as unknown as BriefItemRow;
  const source = (item.source && Array.isArray(item.source.meetings) ? item.source : { meetings: [] }) as BriefItemRow["source"];
  return { ...item, source, payload: item.payload ?? { title: "" }, task_ids: item.task_ids ?? [] };
}

/** Throws 400 listing every id that isn't one of the user's tasks. */
async function assertTasksOwned(supabase: AnySupabase, userId: string, taskIds: string[]): Promise<Map<string, Task>> {
  const unique = [...new Set(taskIds)];
  const found = new Map<string, Task>();
  if (unique.length === 0) return found;

  const { data, error } = await supabase.from("tasks").select(TASK_ACTION_SELECT).eq("user_id", userId).in("id", unique);
  if (error) throw error;
  for (const row of data ?? []) found.set((row as Task).id, row as Task);

  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw new BriefServiceError(400, `Unknown task id(s): ${missing.join(", ")}`, { unknown_task_ids: missing });
  }
  return found;
}

function countItems(items: Pick<BriefItemRow, "kind" | "state">[]): BriefCounts {
  const open = items.filter((item) => item.state === "open");
  const fromMeetings = open.filter((item) => MEETING_ITEM_KINDS.has(item.kind)).length;
  return { total: items.length, open: open.length, from_meetings: fromMeetings, calls: open.length - fromMeetings };
}

export function briefUrl(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, "")}/briefs/${encodeURIComponent(code)}`;
}

function meetingKey(meeting: BriefMeeting): string {
  return meeting.id ?? `${meeting.title}|${meeting.start}`;
}

function mergeMeetings(existing: BriefMeeting[] = [], incoming: BriefMeeting[] = []): BriefMeeting[] {
  const merged = new Map<string, BriefMeeting>();
  for (const meeting of existing) merged.set(meetingKey(meeting), meeting);
  for (const meeting of incoming) if (!merged.has(meetingKey(meeting))) merged.set(meetingKey(meeting), meeting);
  return [...merged.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export function buildBriefEmail(code: string, url: string, counts: BriefCounts, content: BriefContent) {
  const done = content.stats?.find((stat) => stat.key === "done")?.value;
  const subject = [code, `${counts.open} to decide`, done !== undefined ? `${done} done` : null].filter(Boolean).join(" · ");
  const parts: string[] = [];
  if (counts.from_meetings) parts.push(`${counts.from_meetings} from meetings`);
  if (counts.calls) parts.push(`${counts.calls} ${counts.calls === 1 ? "needs" : "need"} a call`);
  const lines = [
    `${counts.open} to decide${parts.length ? `: ${parts.join(", ")}` : ""}.`,
    ...(done !== undefined ? [`${done} done.`] : []),
    "",
    url,
    "",
    `Or in Claude: review ${code}`,
  ];
  return { subject, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Save (routine / chat). First save creates the brief; a same-day rerun only
// appends items from meetings the brief hasn't covered. Existing items, their
// n and their state are never touched.
// ---------------------------------------------------------------------------

export interface SaveBriefSkip {
  index: number;
  reason: "meeting_already_covered" | "rerun_only_appends_meeting_items" | "duplicate_in_request" | "already_in_a_brief";
  item_key: string;
}

export interface SaveBriefResult {
  code: string;
  url: string;
  brief_id: string;
  brief_date: string;
  created: boolean;
  appended: Array<{ n: number; kind: BriefItemKind; item_key: string; title: string }>;
  skipped: SaveBriefSkip[];
  counts: BriefCounts;
  email: { send: boolean; subject: string; body: string; already_emailed_at: string | null } | null;
}

async function loadBriefByDate(supabase: AnySupabase, userId: string, edition: string, briefDate: string) {
  const { data, error } = await supabase
    .from("briefs")
    .select(BRIEF_SELECT)
    .eq("user_id", userId)
    .eq("edition", edition)
    .eq("brief_date", briefDate)
    .maybeSingle();
  if (error) throw error;
  return data ? asBriefRow(data as Record<string, unknown>) : null;
}

async function createBrief(supabase: AnySupabase, userId: string, input: SaveBriefInput): Promise<BriefRow | null> {
  let code = buildBriefCode(input.edition, input.brief_date);
  const { data: clash, error: clashError } = await supabase
    .from("briefs")
    .select("id")
    .eq("user_id", userId)
    .eq("code", code)
    .maybeSingle();
  if (clashError) throw clashError;
  if (clash) code = buildBriefCode(input.edition, input.brief_date, true);

  const { data, error } = await supabase
    .from("briefs")
    .insert({
      user_id: userId,
      edition: input.edition,
      brief_date: input.brief_date,
      code,
      content: input.content,
      covered_meeting_ids: input.covered_meeting_ids,
    })
    .select(BRIEF_SELECT)
    .single();

  if (error) {
    // A concurrent save for the same day won the insert; fall through to the rerun path.
    if (String(error.code) === "23505") return null;
    throw error;
  }
  return asBriefRow(data as Record<string, unknown>);
}

export async function saveBrief(
  supabase: AnySupabase,
  userId: string,
  input: SaveBriefInput,
  options: { appUrl: string }
): Promise<SaveBriefResult> {
  const referencedTaskIds = input.items.flatMap((item) => [
    ...item.task_ids,
    ...(item.payload.maybe_tracked ? [item.payload.maybe_tracked.task_id] : []),
  ]);
  await assertTasksOwned(supabase, userId, referencedTaskIds);

  let brief = await loadBriefByDate(supabase, userId, input.edition, input.brief_date);
  let created = false;
  if (!brief) {
    brief = await createBrief(supabase, userId, input);
    created = brief !== null;
    brief ??= await loadBriefByDate(supabase, userId, input.edition, input.brief_date);
    if (!brief) throw new BriefServiceError(500, "Brief could not be created");
  }

  const covered = new Set(created ? [] : brief.covered_meeting_ids);
  const skipped: SaveBriefSkip[] = [];
  const candidates: Array<{ index: number; key: string; item: SaveBriefInput["items"][number] }> = [];
  const keysInRequest = new Set<string>();

  input.items.forEach((item, index) => {
    const key = computeBriefItemKey(input.edition, input.brief_date, item);
    if (!created) {
      const meetingIds = item.source.meetings.map((meeting) => meeting.id);
      if (meetingIds.length === 0) {
        skipped.push({ index, reason: "rerun_only_appends_meeting_items", item_key: key });
        return;
      }
      if (meetingIds.every((id) => covered.has(id))) {
        skipped.push({ index, reason: "meeting_already_covered", item_key: key });
        return;
      }
    }
    if (keysInRequest.has(key)) {
      skipped.push({ index, reason: "duplicate_in_request", item_key: key });
      return;
    }
    keysInRequest.add(key);
    candidates.push({ index, key, item });
  });

  if (candidates.length) {
    const { data: existingKeys, error: keyError } = await supabase
      .from("brief_items")
      .select("item_key")
      .eq("user_id", userId)
      .in("item_key", candidates.map((candidate) => candidate.key));
    if (keyError) throw keyError;
    const taken = new Set((existingKeys ?? []).map((row) => (row as { item_key: string }).item_key));
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (taken.has(candidates[i].key)) {
        skipped.push({ index: candidates[i].index, reason: "already_in_a_brief", item_key: candidates[i].key });
        candidates.splice(i, 1);
      }
    }
  }
  skipped.sort((a, b) => a.index - b.index);

  const appended: SaveBriefResult["appended"] = [];
  if (candidates.length) {
    const { data: maxRow, error: maxError } = await supabase
      .from("brief_items")
      .select("n")
      .eq("user_id", userId)
      .eq("brief_id", brief.id)
      .order("n", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw maxError;
    let n = (maxRow as { n: number } | null)?.n ?? 0;
    const briefId = brief.id;

    const rows = candidates.map(({ key, item }) => {
      n += 1;
      appended.push({ n, kind: item.kind, item_key: key, title: item.payload.title });
      return {
        user_id: userId,
        brief_id: briefId,
        n,
        item_key: key,
        kind: item.kind,
        payload: item.payload,
        task_ids: item.task_ids,
        source: item.source,
      };
    });

    const { error: insertError } = await supabase.from("brief_items").insert(rows);
    if (insertError) {
      if (String(insertError.code) === "23505") {
        throw new BriefServiceError(409, "Another save for this brief ran at the same time. Run it again; it only appends what's missing.");
      }
      throw insertError;
    }
  }

  // Covered = what the caller says it read, plus every meeting an appended item cites.
  const nextCovered = new Set([...brief.covered_meeting_ids, ...input.covered_meeting_ids]);
  for (const candidate of candidates) for (const meeting of candidate.item.source.meetings) nextCovered.add(meeting.id);

  const briefUpdates: Record<string, unknown> = {};
  if (nextCovered.size !== brief.covered_meeting_ids.length) briefUpdates.covered_meeting_ids = [...nextCovered];
  if (!created && input.content.meetings?.length) {
    // Only the timeline grows on a rerun, so new items have their meeting on the page.
    briefUpdates.content = { ...brief.content, meetings: mergeMeetings(brief.content.meetings, input.content.meetings) };
  }
  if (Object.keys(briefUpdates).length) {
    const { error: updateError } = await supabase.from("briefs").update(briefUpdates).eq("id", brief.id).eq("user_id", userId);
    if (updateError) throw updateError;
    if (briefUpdates.content) brief = { ...brief, content: briefUpdates.content as BriefContent };
  }

  const { data: allItems, error: itemsError } = await supabase
    .from("brief_items")
    .select("kind, state")
    .eq("user_id", userId)
    .eq("brief_id", brief.id);
  if (itemsError) throw itemsError;
  const counts = countItems((allItems ?? []) as Pick<BriefItemRow, "kind" | "state">[]);
  const url = briefUrl(options.appUrl, brief.code);

  let email: SaveBriefResult["email"] = null;
  if (input.claim_email) {
    const { subject, body } = buildBriefEmail(brief.code, url, counts, brief.content);
    // Claim-then-send: only the first claim gets send=true, so a rerun never emails twice.
    const { data: claimed, error: claimError } = await supabase
      .from("briefs")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", brief.id)
      .eq("user_id", userId)
      .is("emailed_at", null)
      .select("id");
    if (claimError) throw claimError;
    email = { send: (claimed ?? []).length > 0, subject, body, already_emailed_at: brief.emailed_at };
  }

  return {
    code: brief.code,
    url,
    brief_id: brief.id,
    brief_date: brief.brief_date,
    created,
    appended,
    skipped,
    counts,
    email,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function loadBriefByCode(supabase: AnySupabase, userId: string, code: string): Promise<BriefRow> {
  const { data, error } = await supabase
    .from("briefs")
    .select(BRIEF_SELECT)
    .eq("user_id", userId)
    .eq("code", normalizeBriefCode(code))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BriefServiceError(404, `No brief ${normalizeBriefCode(code)}`);
  return asBriefRow(data as Record<string, unknown>);
}

export async function getBrief(supabase: AnySupabase, userId: string, code: string, options: { appUrl: string }): Promise<BriefView> {
  const brief = await loadBriefByCode(supabase, userId, code);
  const { data, error } = await supabase
    .from("brief_items")
    .select(ITEM_SELECT)
    .eq("user_id", userId)
    .eq("brief_id", brief.id)
    .order("n", { ascending: true });
  if (error) throw error;
  const items = (data ?? []).map((row) => asItemRow(row as Record<string, unknown>));

  const taskIds = new Set<string>();
  for (const item of items) {
    item.task_ids.forEach((id) => taskIds.add(id));
    if (item.created_task_id) taskIds.add(item.created_task_id);
    if (item.payload.maybe_tracked?.task_id) taskIds.add(item.payload.maybe_tracked.task_id);
  }
  for (const tile of brief.content.tiles ?? []) {
    for (const group of tile.groups ?? []) for (const row of group.rows) if (row.task_id) taskIds.add(row.task_id);
  }

  const tasks: Record<string, BriefTaskSummary> = {};
  if (taskIds.size) {
    const { data: taskRows, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, status, due_at")
      .eq("user_id", userId)
      .in("id", [...taskIds]);
    if (taskError) throw taskError;
    for (const row of taskRows ?? []) tasks[(row as BriefTaskSummary).id] = row as BriefTaskSummary;
  }

  return { brief, items, tasks, counts: countItems(items), url: briefUrl(options.appUrl, brief.code) };
}

// ---------------------------------------------------------------------------
// Act: the one code path behind the page buttons and act_on_brief_items.
// Validates every action before executing any of them.
// ---------------------------------------------------------------------------

export interface BriefActionResult {
  n: number;
  action: BriefAction;
  ok: boolean;
  state?: BriefItemState;
  already?: boolean;
  task_id?: string;
  task_ids?: string[];
  due_at?: string;
  choice?: string;
  error?: string;
}

function describeSources(item: BriefItemRow): string {
  return item.source.meetings
    .map((meeting) => {
      const when = meeting.start
        ? new Date(meeting.start).toLocaleString("en-US", {
            timeZone: BRIEF_TIME_ZONE,
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : null;
      const head = `- ${meeting.title}${when ? ` (${when})` : ""}${meeting.url ? ` ${meeting.url}` : ""}`;
      return [head, ...meeting.lines.map((line) => `  "${line}"`)].join("\n");
    })
    .join("\n");
}

async function acceptProposal(
  supabase: AnySupabase,
  userId: string,
  brief: BriefRow,
  item: BriefItemRow
): Promise<string> {
  const lookup = async () => {
    const { data, error } = await supabase
      .from("tasks")
      .select("id")
      .eq("user_id", userId)
      .eq("external_source_system", EOD_PROPOSAL_SOURCE_SYSTEM)
      .eq("external_source_id", item.item_key)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  };

  const existing = await lookup();
  if (existing) return existing;

  const title = item.payload.title.slice(0, 500);
  const description = [item.payload.detail, `From ${brief.code} #${item.n}:`, describeSources(item)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const boosts = calculatePriorityBoosts([], null, title, "Backlog", highPriorityNames);

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title,
      description,
      status: "Backlog",
      task_type: "Task",
      base_priority: 50,
      priority_score: calculateFinalPriorityScore(50, boosts),
      estimated_minutes: 30,
      estimate_source: "default",
      needs_review: false,
      blocker: false,
      stakeholder_mentions: [],
      tags: ["from-meeting"],
      source_type: "Meeting",
      source_url: item.source.meetings.find((meeting) => meeting.url)?.url ?? null,
      external_source_system: EOD_PROPOSAL_SOURCE_SYSTEM,
      external_source_id: item.item_key,
    })
    .select("id")
    .single();

  if (error) {
    // A concurrent Accept created it first: the 054 index guarantees one task.
    if (isTaskExternalSourceUniqueViolation(error)) {
      const raced = await lookup();
      if (raced) return raced;
    }
    throw error;
  }

  const taskId = (data as { id: string }).id;
  queueTaskStatusTransition(supabase, { userId, taskId, fromStatus: null, toStatus: "Backlog" });
  return taskId;
}

async function applyCarryAction(
  supabase: AnySupabase,
  userId: string,
  brief: BriefRow,
  item: BriefItemRow,
  action: "done" | "tomorrow" | "park",
  now: Date
): Promise<{ due_at?: string }> {
  const tasks = await assertTasksOwned(supabase, userId, item.task_ids);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const dueAt = action === "tomorrow" ? resolveTomorrowDueAt(brief.brief_date, now) : undefined;

  for (const taskId of item.task_ids) {
    const task = tasks.get(taskId)!;
    const updates: Partial<Task> = {};
    if (action === "done") updates.status = "Done";
    if (action === "park") updates.status = "Parked";
    if (dueAt) updates.due_at = dueAt;
    updates.priority_score = recalculateTaskPriority({ ...task, ...updates } as Task, highPriorityNames);

    const { data, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", taskId)
      .eq("user_id", userId)
      .select("id");
    if (error) throw error;
    if (!data || data.length !== 1) throw new BriefServiceError(404, `Task ${taskId} not found`);

    if (updates.status && updates.status !== task.status) {
      queueTaskStatusTransition(supabase, {
        userId,
        taskId,
        fromStatus: task.status as TaskStatus,
        toStatus: updates.status as TaskStatus,
      });
    }
  }
  return dueAt ? { due_at: dueAt } : {};
}

export async function actOnBriefItems(
  supabase: AnySupabase,
  userId: string,
  code: string,
  actions: BriefActionInput[],
  options: { now?: Date } = {}
): Promise<{ code: string; results: BriefActionResult[]; counts: BriefCounts }> {
  const now = options.now ?? new Date();
  const brief = await loadBriefByCode(supabase, userId, code);

  const { data, error } = await supabase
    .from("brief_items")
    .select(ITEM_SELECT)
    .eq("user_id", userId)
    .eq("brief_id", brief.id)
    .in("n", actions.map((action) => action.n));
  if (error) throw error;
  const byN = new Map((data ?? []).map((row) => {
    const item = asItemRow(row as Record<string, unknown>);
    return [item.n, item] as const;
  }));

  // Validate everything first; execute nothing if anything is off.
  const problems: string[] = [];
  for (const action of actions) {
    const item = byN.get(action.n);
    if (!item) {
      problems.push(`#${action.n} isn't in ${brief.code}`);
      continue;
    }
    const rule = ACTION_RULES[item.kind][action.action];
    if (!rule) {
      problems.push(`#${action.n} is a ${item.kind}; "${action.action}" doesn't apply (use ${allowedActionsForKind(item.kind).join(", ")})`);
      continue;
    }
    if (!rule.from.includes(item.state) && !isRepeat(item, action.action)) {
      problems.push(
        item.state === "accepted"
          ? `#${action.n} was already accepted (task ${item.created_task_id ?? "deleted"}); change it in Baseline`
          : `#${action.n} is ${item.state}; "${action.action}" isn't possible from there`
      );
      continue;
    }
    if (action.action === "pick") {
      const keys = (item.payload.options ?? []).map((option) => option.key);
      if (!action.choice || !keys.includes(action.choice)) {
        problems.push(`#${action.n}: choice must be one of ${keys.join(", ")}`);
      }
    }
    if (action.action === "dismiss" && !action.reason && !action.note) {
      problems.push(`#${action.n}: dismiss needs a reason or a note`);
    }
  }
  if (problems.length) {
    throw new BriefServiceError(400, problems.join("; "), { problems });
  }

  const results: BriefActionResult[] = [];
  for (const action of actions) {
    const item = byN.get(action.n)!;
    const rule = ACTION_RULES[item.kind][action.action]!;
    const actedAt = now.toISOString();
    try {
      if (isRepeat(item, action.action)) {
        results.push({
          n: item.n,
          action: action.action,
          ok: true,
          already: true,
          state: item.state,
          ...(item.created_task_id ? { task_id: item.created_task_id } : {}),
        });
        continue;
      }

      const updates: Record<string, unknown> = { state: rule.to, acted_at: actedAt };
      const result: BriefActionResult = { n: item.n, action: action.action, ok: true, state: rule.to };

      switch (action.action) {
        case "accept": {
          const taskId = await acceptProposal(supabase, userId, brief, item);
          Object.assign(updates, { created_task_id: taskId, dismissed_reason: null, dismissed_note: null });
          result.task_id = taskId;
          break;
        }
        case "dismiss":
          Object.assign(updates, { dismissed_reason: action.reason, dismissed_note: action.note });
          break;
        case "done":
        case "tomorrow":
        case "park":
          Object.assign(result, await applyCarryAction(supabase, userId, brief, item, action.action, now));
          result.task_ids = item.task_ids;
          break;
        case "pick":
          updates.choice = action.choice;
          result.choice = action.choice ?? undefined;
          break;
        case "undo":
          Object.assign(updates, { dismissed_reason: null, dismissed_note: null, choice: null, acted_at: null });
          break;
      }

      const { error: updateError } = await supabase
        .from("brief_items")
        .update(updates)
        .eq("id", item.id)
        .eq("user_id", userId);
      if (updateError) throw updateError;
      results.push(result);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      results.push({ n: item.n, action: action.action, ok: false, error: message });
    }
  }

  const { data: allItems, error: countError } = await supabase
    .from("brief_items")
    .select("kind, state")
    .eq("user_id", userId)
    .eq("brief_id", brief.id);
  if (countError) throw countError;

  return { code: brief.code, results, counts: countItems((allItems ?? []) as Pick<BriefItemRow, "kind" | "state">[]) };
}
