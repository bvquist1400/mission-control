import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateFinalPriorityScore,
  calculatePriorityBoosts,
  getHighPriorityStakeholderNames,
  recalculateTaskPriority,
} from "@/lib/priority";
import { queueTaskStatusTransition } from "@/lib/task-status-transitions";
import {
  BRIEF_TIME_ZONE,
  buildBriefCode,
  computeBriefItemKey,
  normalizeBriefCode,
  resolveTomorrowDueAt,
  todayInBriefTimeZone,
} from "@/lib/briefs/keys";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import { buildBriefNotice, telegramNotifierFromEnv, type BriefNotifier } from "@/lib/briefs/notify";
import { normalizeBriefContent } from "@/lib/briefs/validate";
import {
  type BriefAction,
  type BriefActionInput,
  type BriefAgendaLine,
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

const BRIEF_SELECT =
  "id, user_id, edition, brief_date, code, content, covered_meeting_ids, notified_at, notify_sent_at, notify_error, created_at, updated_at";
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

/** Swap each agenda line's request-position choice_item for the saved item's n. */
function resolveAgendaChoices(agenda: BriefAgendaLine[], nByIndex: Map<number, number>): BriefAgendaLine[] {
  return agenda.map(({ choice_item, ...line }) => {
    const n = choice_item === undefined ? undefined : nByIndex.get(choice_item);
    return n ? { ...line, choice_n: n } : line;
  });
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
  /**
   * The ready-notice (Telegram). Only the first save of a brief tries to send;
   * later saves report "already_claimed" (another save owns the single attempt;
   * sent_at says whether it has been delivered yet). A failure never fails the save.
   */
  notify: {
    status: "sent" | "failed" | "already_claimed";
    error: string | null;
    /** When the single attempt was claimed. */
    notified_at: string | null;
    /** When Telegram accepted the message; null until (unless) it did. Never set before delivery. */
    sent_at: string | null;
  };
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

/**
 * Claim-then-send, so a brief notifies at most once however many saves race:
 * only the save whose UPDATE flips notified_at from NULL sends. notified_at is
 * the claim; notify_sent_at is written only after Telegram accepted the
 * message, and notify_error records why it didn't. A save that lost the claim
 * reports "already_claimed" with whatever is durable, never "sent". Never throws.
 */
async function notifyOnce(
  supabase: AnySupabase,
  userId: string,
  brief: BriefRow,
  text: string,
  notifier: BriefNotifier = telegramNotifierFromEnv()
): Promise<SaveBriefResult["notify"]> {
  const attemptedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("briefs")
    .update({ notified_at: attemptedAt })
    .eq("id", brief.id)
    .eq("user_id", userId)
    .is("notified_at", null)
    .select("id");
  if (claimError) {
    console.error("[briefs] notify claim failed:", claimError);
    return { status: "failed", error: "Couldn't record the notification claim", notified_at: brief.notified_at, sent_at: brief.notify_sent_at };
  }
  if (!claimed?.length) {
    // Re-read: the claim may have been made (and sent, or failed) after this save loaded the brief.
    const { data: current } = await supabase
      .from("briefs")
      .select("notified_at, notify_sent_at, notify_error")
      .eq("id", brief.id)
      .eq("user_id", userId)
      .maybeSingle();
    const row = (current ?? brief) as Pick<BriefRow, "notified_at" | "notify_sent_at" | "notify_error">;
    return { status: "already_claimed", error: row.notify_error, notified_at: row.notified_at, sent_at: row.notify_sent_at };
  }

  try {
    await notifier.send(text);
  } catch (caught) {
    const message = (caught instanceof Error ? caught.message : String(caught)).slice(0, 1000);
    const { error: recordError } = await supabase
      .from("briefs")
      .update({ notify_error: message })
      .eq("id", brief.id)
      .eq("user_id", userId);
    if (recordError) console.error("[briefs] couldn't record notify_error:", recordError);
    return { status: "failed", error: message, notified_at: attemptedAt, sent_at: null };
  }

  // Delivered. Only now is sent_at written, so nothing reports a send that didn't happen.
  const sentAt = new Date().toISOString();
  const { error: sentError } = await supabase
    .from("briefs")
    .update({ notify_sent_at: sentAt })
    .eq("id", brief.id)
    .eq("user_id", userId);
  if (sentError) console.error("[briefs] couldn't record notify_sent_at:", sentError);
  return { status: "sent", error: null, notified_at: attemptedAt, sent_at: sentAt };
}

export async function saveBrief(
  supabase: AnySupabase,
  userId: string,
  input: SaveBriefInput,
  options: { appUrl: string; notifier?: BriefNotifier }
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
  const nByIndex = new Map<number, number>();
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

    const rows = candidates.map(({ index, key, item }) => {
      n += 1;
      nByIndex.set(index, n);
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
  if (created && brief.content.next?.agenda.some((line) => line.choice_item !== undefined)) {
    briefUpdates.content = {
      ...brief.content,
      next: { ...brief.content.next, agenda: resolveAgendaChoices(brief.content.next.agenda, nByIndex) },
    };
  }
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

  const notify = await notifyOnce(supabase, userId, brief, buildBriefNotice(brief.code, url, counts, brief.content), options.notifier);

  return {
    code: brief.code,
    url,
    brief_id: brief.id,
    brief_date: brief.brief_date,
    created,
    appended,
    skipped,
    counts,
    notify,
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

/** Today's brief (ET date, never UTC) and how many items are still open, for the app-shell button. */
export async function getTodayBriefStatus(
  supabase: AnySupabase,
  userId: string,
  options: { now?: Date; edition?: string } = {}
): Promise<TodayBriefStatus | null> {
  const briefDate = todayInBriefTimeZone(options.now ?? new Date());
  const { data: brief, error } = await supabase
    .from("briefs")
    .select("id, code, brief_date")
    .eq("user_id", userId)
    .eq("edition", options.edition ?? "eod")
    .eq("brief_date", briefDate)
    .maybeSingle();
  if (error) throw error;
  if (!brief) return null;

  const { data: items, error: itemsError } = await supabase
    .from("brief_items")
    .select("state")
    .eq("user_id", userId)
    .eq("brief_id", (brief as { id: string }).id);
  if (itemsError) throw itemsError;

  const rows = (items ?? []) as Array<{ state: string }>;
  return {
    code: (brief as { code: string }).code,
    brief_date: (brief as { brief_date: string }).brief_date,
    open: rows.filter((row) => row.state === "open").length,
    total: rows.length,
  };
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
  /** The item changed between validation and the write; nothing was applied. Re-read and decide again. */
  conflict?: boolean;
  current_state?: BriefItemState;
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

/** The task Accept creates. brief_item_transition inserts it in the same transaction as the state change. */
async function buildProposalTask(supabase: AnySupabase, userId: string, brief: BriefRow, item: BriefItemRow) {
  const title = item.payload.title.slice(0, 500);
  const description = [item.payload.detail, `From ${brief.code} #${item.n}:`, describeSources(item)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const boosts = calculatePriorityBoosts([], null, title, "Backlog", highPriorityNames);
  return {
    title,
    description,
    base_priority: 50,
    priority_score: calculateFinalPriorityScore(50, boosts),
    tags: ["from-meeting"],
    source_type: "Meeting",
    source_url: item.source.meetings.find((meeting) => meeting.url)?.url ?? null,
  };
}

interface TransitionOutcome {
  ok: boolean;
  reason?: "conflict" | "not_found";
  state?: BriefItemState;
  created_task_id?: string | null;
  choice?: string | null;
  task_inserted?: boolean;
}

/**
 * Compare-and-set on the item row (see brief_item_transition in 055): the
 * change applies only if the item is still in `expected`, under a row lock.
 */
async function transitionItem(
  supabase: AnySupabase,
  userId: string,
  item: BriefItemRow,
  expected: BriefItemState,
  next: BriefItemState,
  fields: Record<string, unknown>,
  task: Record<string, unknown> | null = null,
  taskUpdates: Array<Record<string, unknown>> | null = null
): Promise<TransitionOutcome> {
  const { data, error } = await supabase.rpc("brief_item_transition", {
    p_user_id: userId,
    p_item_id: item.id,
    p_expected_state: expected,
    p_state: next,
    p_fields: fields,
    p_task: task,
    p_task_updates: taskUpdates,
  });
  if (error) throw error;
  return data as TransitionOutcome;
}

/** PostgREST errors are plain objects, not Error instances. */
function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (caught && typeof caught === "object" && "message" in caught) return String((caught as { message: unknown }).message);
  return String(caught);
}

function conflictResult(item: BriefItemRow, action: BriefAction, outcome: TransitionOutcome): BriefActionResult {
  const current = outcome.state;
  return {
    n: item.n,
    action,
    ok: false,
    conflict: true,
    ...(current ? { current_state: current } : {}),
    error:
      outcome.reason === "not_found"
        ? `#${item.n} no longer exists`
        : `#${item.n} changed to ${current} while this was saving; nothing was applied. Refresh and decide again.`,
  };
}

/**
 * The task changes a carry action makes, computed from the tasks as they are
 * now. brief_item_transition applies them in the same transaction as the item's
 * new state, so they land together or not at all.
 */
async function buildCarryUpdates(
  supabase: AnySupabase,
  userId: string,
  brief: BriefRow,
  item: BriefItemRow,
  action: "done" | "tomorrow" | "park",
  now: Date
) {
  const tasks = await assertTasksOwned(supabase, userId, item.task_ids);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const dueAt = action === "tomorrow" ? resolveTomorrowDueAt(brief.brief_date, now) : undefined;

  const updates = item.task_ids.map((taskId) => {
    const task = tasks.get(taskId)!;
    const change: Partial<Task> = {};
    if (action === "done") change.status = "Done";
    if (action === "park") change.status = "Parked";
    if (dueAt) change.due_at = dueAt;
    change.priority_score = recalculateTaskPriority({ ...task, ...change } as Task, highPriorityNames);
    return { id: taskId, ...change, from_status: task.status as TaskStatus };
  });
  return { dueAt, updates };
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

      const next = rule.to as BriefItemState;
      const result: BriefActionResult = { n: item.n, action: action.action, ok: true, state: next };

      switch (action.action) {
        case "accept": {
          const task = await buildProposalTask(supabase, userId, brief, item);
          const outcome = await transitionItem(
            supabase,
            userId,
            item,
            item.state,
            "accepted",
            { acted_at: actedAt, dismissed_reason: null, dismissed_note: null },
            task
          );
          if (!outcome.ok) {
            // Another Accept got there first: same item, same task, so this is a repeat, not a conflict.
            if (outcome.state === "accepted") {
              results.push({
                n: item.n,
                action: action.action,
                ok: true,
                already: true,
                state: "accepted",
                ...(outcome.created_task_id ? { task_id: outcome.created_task_id } : {}),
              });
            } else {
              results.push(conflictResult(item, action.action, outcome));
            }
            continue;
          }
          result.task_id = outcome.created_task_id ?? undefined;
          if (outcome.task_inserted && outcome.created_task_id) {
            queueTaskStatusTransition(supabase, { userId, taskId: outcome.created_task_id, fromStatus: null, toStatus: "Backlog" });
          }
          break;
        }
        case "dismiss":
        case "pick":
        case "undo": {
          const fields =
            action.action === "dismiss"
              ? { acted_at: actedAt, dismissed_reason: action.reason, dismissed_note: action.note }
              : action.action === "pick"
                ? { acted_at: actedAt, choice: action.choice }
                : { acted_at: null, dismissed_reason: null, dismissed_note: null, choice: null };
          const outcome = await transitionItem(supabase, userId, item, item.state, next, fields);
          if (!outcome.ok) {
            results.push(conflictResult(item, action.action, outcome));
            continue;
          }
          if (action.action === "pick") result.choice = action.choice ?? undefined;
          break;
        }
        case "done":
        case "tomorrow":
        case "park": {
          // One transaction: the item's new state and every task write commit together or not at all.
          // So "already" below can only ever mean the tasks really were updated.
          const { dueAt, updates } = await buildCarryUpdates(supabase, userId, brief, item, action.action, now);
          const outcome = await transitionItem(
            supabase,
            userId,
            item,
            item.state,
            next,
            { acted_at: actedAt },
            null,
            updates.map((update) => ({
              id: update.id,
              ...(update.status ? { status: update.status } : {}),
              ...(update.due_at ? { due_at: update.due_at } : {}),
              priority_score: update.priority_score,
            }))
          );
          if (!outcome.ok) {
            results.push(
              outcome.state === next
                ? { n: item.n, action: action.action, ok: true, already: true, state: next, task_ids: item.task_ids }
                : conflictResult(item, action.action, outcome)
            );
            continue;
          }
          for (const update of updates) {
            if (update.status && update.status !== update.from_status) {
              queueTaskStatusTransition(supabase, {
                userId,
                taskId: update.id,
                fromStatus: update.from_status,
                toStatus: update.status as TaskStatus,
              });
            }
          }
          if (dueAt) result.due_at = dueAt;
          result.task_ids = item.task_ids;
          break;
        }
      }

      results.push(result);
    } catch (caught) {
      results.push({ n: item.n, action: action.action, ok: false, error: errorMessage(caught) });
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
