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
  resolveTomorrowDate,
  resolveTomorrowDueAt,
  todayInBriefTimeZone,
} from "@/lib/briefs/keys";
import {
  DEFAULT_ACCEPT_DUE,
  etDateOfDueAt,
  isAcceptDuePreset,
  pickedDateProblem,
  resolveAcceptDueAt,
  resolvePickedDueAt,
} from "@/lib/briefs/due";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import { buildBriefNotice, telegramNotifierFromEnv, type BriefNotifier } from "@/lib/briefs/notify";
import { normalizeBriefContent, normalizeStoredWorkDigestRef } from "@/lib/briefs/validate";
import { parseWorkDigestNote, parseWorkDigestTitle } from "@/lib/briefing/work-digest";
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
  type BriefPriorDue,
  type BriefRow,
  type BriefTaskSummary,
  type BriefView,
  type BriefWorkDigestRef,
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
  "id, user_id, brief_id, n, item_key, kind, payload, task_ids, source, state, dismissed_reason, dismissed_note, choice, created_task_id, prior_due, acted_at, created_at, updated_at";
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
  // Undo only exists for a deferral (Tomorrow or a picked date): it puts each task's due date back from
  // the snapshot the transition saved (064). Parked and Done stay as they were.
  carry_over: {
    done: { from: ["open"], to: "done" },
    tomorrow: { from: ["open"], to: "deferred" },
    move: { from: ["open"], to: "deferred" },
    park: { from: ["open"], to: "parked" },
    undo: { from: ["deferred"], to: "open" },
  },
  carry_group: {
    tomorrow: { from: ["open"], to: "deferred" },
    move: { from: ["open"], to: "deferred" },
    park: { from: ["open"], to: "parked" },
    undo: { from: ["deferred"], to: "open" },
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

/** The ET day the saved snapshot says a deferred item's tasks were moved to, or null (moved before 064). */
function deferredToDate(item: BriefItemRow): string | null {
  const applied = item.prior_due?.[0]?.applied_due_at;
  return applied ? etDateOfDueAt(applied) : null;
}

/**
 * A repeat is a no-op success only when it would leave the same date: Move for
 * the day it already moved to, Tomorrow for the day Tomorrow means (or when the
 * move predates the saved snapshot, so nothing says where it went). A different
 * day is refused (Undo first), never silently ignored: it answers "already"
 * while the task sits somewhere else. Re-deferring in place was not chosen: the
 * state machine has one way out of "deferred" (Undo), which restores the
 * pre-brief date from the snapshot; a second deferral on top would have to carry
 * that snapshot forward through the database function.
 */
function isRepeat(item: BriefItemRow, input: BriefActionInput, brief: Pick<BriefRow, "brief_date">, now: Date): boolean {
  const rule = ACTION_RULES[item.kind][input.action];
  if (!rule || item.state !== rule.to) return false;
  if (input.action === "move") {
    const movedTo = deferredToDate(item);
    return movedTo !== null && movedTo === input.date;
  }
  if (input.action === "tomorrow") {
    const movedTo = deferredToDate(item);
    return movedTo === null || movedTo === resolveTomorrowDate(brief.brief_date, now);
  }
  return IDEMPOTENT_ACTIONS.has(input.action);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asBriefRow(row: Record<string, unknown>): BriefRow {
  return { ...(row as unknown as BriefRow), content: normalizeBriefContent(row.content) };
}

function asItemRow(row: Record<string, unknown>): BriefItemRow {
  const item = row as unknown as BriefItemRow;
  const stored = (item.source && Array.isArray(item.source.meetings) ? item.source : { meetings: [] }) as BriefItemRow["source"];
  const workDigest = normalizeStoredWorkDigestRef(stored.work_digest);
  const { work_digest: _dropped, ...rest } = stored;
  void _dropped;
  const source = (workDigest ? { ...rest, work_digest: workDigest } : rest) as BriefItemRow["source"];
  const priorDue = Array.isArray(item.prior_due) ? (item.prior_due as BriefPriorDue[]) : null;
  return { ...item, source, payload: item.payload ?? { title: "" }, task_ids: item.task_ids ?? [], prior_due: priorDue };
}

/**
 * What the page and the API show of an item: the saved snapshot stays on the
 * server; callers only learn whether Undo is possible.
 */
function toViewItem(item: BriefItemRow): BriefItemRow {
  const { prior_due: priorDue, ...rest } = item;
  return { ...rest, can_undo: item.state === "deferred" && Array.isArray(priorDue) && priorDue.length > 0 };
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
  reason:
    | "meeting_already_covered"
    | "work_digest_already_covered"
    | "rerun_only_appends_meeting_items"
    | "duplicate_in_request"
    | "already_in_a_brief";
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

function collapseSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Checks every source.work_digest against its note before anything is saved:
 * the note is Brent's, active, titled "Work digest <date> AM|PM" for that
 * edition, still readable, every cited block exists, and the lines are exactly
 * those blocks' `what` lines. Returns the items with each citation rebuilt
 * from the note (its lines in block order, date and where), so the page, the
 * task description and the item key never carry text the note doesn't have.
 */
async function resolveWorkDigestCitations(
  supabase: AnySupabase,
  userId: string,
  items: SaveBriefInput["items"]
): Promise<SaveBriefInput["items"]> {
  const noteIds = [...new Set(items.map((item) => item.source.work_digest?.note_id).filter((id): id is string => Boolean(id)))];
  if (noteIds.length === 0) return items;

  const { data, error } = await supabase
    .from("notes")
    .select("id, title, body_markdown, status")
    .eq("user_id", userId)
    .in("id", noteIds);
  if (error) throw error;
  const notes = new Map(((data ?? []) as Array<{ id: string; title: string; body_markdown: string | null; status: string | null }>).map((note) => [note.id, note]));

  const errors: string[] = [];
  const resolved = items.map((item, index) => {
    const ref = item.source.work_digest;
    if (!ref) return item;
    const path = `items[${index}].source.work_digest`;
    const note = notes.get(ref.note_id);
    const named = note ? parseWorkDigestTitle(note.title) : null;
    if (!note || !named || (note.status ?? "active") !== "active") {
      errors.push(`${path}.note_id is not an active work digest note of yours`);
      return item;
    }
    if (named.edition !== ref.edition) {
      errors.push(`${path}.edition is ${ref.edition} but the note is the ${named.edition.toUpperCase()} digest`);
      return item;
    }
    const parsed = parseWorkDigestNote(note.body_markdown);
    if (!parsed.ok) {
      errors.push(`${path}: the note can't be read (${parsed.reason}), so it can't be cited`);
      return item;
    }
    const blocks = ref.blocks.map((block) => parsed.value.items.find((entry) => entry.block === block));
    const missing = ref.blocks.filter((_, blockIndex) => !blocks[blockIndex]);
    if (missing.length) {
      errors.push(`${path}.blocks ${missing.join(", ")} not in the note`);
      return item;
    }
    const expected = blocks.map((entry) => entry!.what);
    const given = new Set(ref.lines.map(collapseSpaces));
    const wanted = new Set(expected.map(collapseSpaces));
    if (given.size !== wanted.size || [...given].some((line) => !wanted.has(line))) {
      errors.push(`${path}.lines must be the what line of each cited block, copied exactly (${ref.blocks.join(", ")})`);
      return item;
    }
    const wheres = [...new Set(blocks.map((entry) => entry!.where))].sort();
    const citation: BriefWorkDigestRef = {
      note_id: ref.note_id,
      edition: ref.edition,
      blocks: ref.blocks,
      lines: expected,
      date: named.date,
      where: wheres.length > 1 ? "Mail and Teams" : wheres[0],
    };
    return { ...item, source: { ...item.source, work_digest: citation } };
  });
  if (errors.length) throw new BriefServiceError(400, errors[0], { errors });
  return resolved;
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
  input = { ...input, items: await resolveWorkDigestCitations(supabase, userId, input.items) };

  let brief = await loadBriefByDate(supabase, userId, input.edition, input.brief_date);
  let created = false;
  if (!brief) {
    brief = await createBrief(supabase, userId, input);
    created = brief !== null;
    brief ??= await loadBriefByDate(supabase, userId, input.edition, input.brief_date);
    if (!brief) throw new BriefServiceError(500, "Brief could not be created");
  }

  const covered = new Set(created ? [] : brief.covered_meeting_ids);
  const coveredNotes = new Set(created ? [] : brief.content.work_digest_note_ids ?? []);
  const skipped: SaveBriefSkip[] = [];
  const candidates: Array<{ index: number; key: string; item: SaveBriefInput["items"][number] }> = [];
  const keysInRequest = new Set<string>();

  input.items.forEach((item, index) => {
    const key = computeBriefItemKey(input.edition, input.brief_date, item);
    if (!created) {
      // A rerun appends only items with a source this brief hasn't covered yet:
      // a meeting not in covered_meeting_ids, or a work digest note not in
      // content.work_digest_note_ids (the late PM note on an EOD rerun).
      const meetingIds = item.source.meetings.map((meeting) => meeting.id);
      const digestNoteId = item.source.work_digest?.note_id ?? null;
      if (meetingIds.length === 0 && !digestNoteId) {
        skipped.push({ index, reason: "rerun_only_appends_meeting_items", item_key: key });
        return;
      }
      const newMeeting = meetingIds.some((id) => !covered.has(id));
      const newNote = digestNoteId !== null && !coveredNotes.has(digestNoteId);
      if (!newMeeting && !newNote) {
        skipped.push({ index, reason: meetingIds.length ? "meeting_already_covered" : "work_digest_already_covered", item_key: key });
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
  // Work digest notes read = what the brief had, what the caller says it read, and every note an appended item cites.
  const knownNotes = brief.content.work_digest_note_ids ?? [];
  const nextNotes = [...new Set([...knownNotes, ...(input.content.work_digest_note_ids ?? [])])];
  for (const candidate of candidates) {
    const noteId = candidate.item.source.work_digest?.note_id;
    if (noteId && !nextNotes.includes(noteId)) nextNotes.push(noteId);
  }
  if (nextNotes.length !== knownNotes.length) {
    const base = (briefUpdates.content as BriefContent | undefined) ?? brief.content;
    briefUpdates.content = { ...base, work_digest_note_ids: nextNotes.slice(0, 4) };
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

/**
 * The brief and its items in ONE request (items embedded through the
 * brief_items (brief_id, user_id) → briefs (id, user_id) key, ordered by n and
 * filtered by user like the separate read was). Speed check fix 2: the page
 * used to wait for the brief, then its items, then the tasks.
 */
async function loadBriefWithItems(
  supabase: AnySupabase,
  userId: string,
  code: string
): Promise<{ brief: BriefRow; itemRows: Record<string, unknown>[] }> {
  const { data, error } = await supabase
    .from("briefs")
    .select(`${BRIEF_SELECT}, brief_items(${ITEM_SELECT})`)
    .eq("user_id", userId)
    .eq("code", normalizeBriefCode(code))
    .eq("brief_items.user_id", userId)
    .order("n", { referencedTable: "brief_items", ascending: true })
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BriefServiceError(404, `No brief ${normalizeBriefCode(code)}`);
  const { brief_items: embedded, ...briefFields } = data as Record<string, unknown>;
  const itemRows = (Array.isArray(embedded) ? embedded : []) as Record<string, unknown>[];
  return { brief: asBriefRow(briefFields), itemRows };
}

export async function getBrief(supabase: AnySupabase, userId: string, code: string, options: { appUrl: string }): Promise<BriefView> {
  const { brief, itemRows } = await loadBriefWithItems(supabase, userId, code);
  const items = itemRows.map((row) => toViewItem(asItemRow(row)));

  const taskIds = new Set<string>();
  for (const item of items) {
    item.task_ids.forEach((id) => taskIds.add(id));
    if (item.created_task_id) taskIds.add(item.created_task_id);
    if (item.payload.maybe_tracked?.task_id) taskIds.add(item.payload.maybe_tracked.task_id);
  }
  for (const tile of brief.content.tiles ?? []) {
    for (const group of tile.groups ?? []) for (const row of group.rows) if (row.task_id) taskIds.add(row.task_id);
  }
  for (const meeting of brief.content.meetings ?? []) for (const id of meeting.task_ids ?? []) taskIds.add(id);

  const tasks: Record<string, BriefTaskSummary> = {};
  if (taskIds.size) {
    const { data: taskRows, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, status, due_at, owner")
      .eq("user_id", userId)
      .in("id", [...taskIds]);
    if (taskError) throw taskError;
    for (const row of taskRows ?? []) tasks[(row as BriefTaskSummary).id] = row as BriefTaskSummary;
  }

  return { brief, items, tasks, counts: countItems(items), url: briefUrl(options.appUrl, brief.code) };
}

/**
 * The most recent brief of an edition dated today or earlier (ET), e.g. the
 * last EOD for a morning run: Friday's on a Monday. Future-dated briefs never
 * count. `before` (YYYY-MM-DD) also excludes that date and later, for "the one before".
 */
export async function getLatestBrief(
  supabase: AnySupabase,
  userId: string,
  edition: string,
  options: { appUrl: string; now?: Date; before?: string }
): Promise<BriefView> {
  let query = supabase
    .from("briefs")
    .select("code")
    .eq("user_id", userId)
    .eq("edition", edition)
    .lte("brief_date", todayInBriefTimeZone(options.now ?? new Date()));
  // `before` only tightens the bound; it never reaches past today.
  if (options.before) query = query.lt("brief_date", options.before);
  const { data, error } = await query
    .order("brief_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BriefServiceError(404, `No ${edition.toUpperCase()} brief yet`);
  return getBrief(supabase, userId, (data as { code: string }).code, { appUrl: options.appUrl });
}

/**
 * The newest briefs of either edition first saved before `before`, newest
 * first, for the digest's "since the last brief" window. Callers skip the
 * brief they are building (a same-day rerun) with `pickPreviousBrief`.
 */
export async function listRecentBriefSaves(
  supabase: AnySupabase,
  userId: string,
  options: { before: Date; limit?: number }
): Promise<Array<{ code: string; edition: string; brief_date: string; created_at: string }>> {
  const { data, error } = await supabase
    .from("briefs")
    .select("code, edition, brief_date, created_at")
    .eq("user_id", userId)
    .lt("created_at", options.before.toISOString())
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 3);
  if (error) throw error;
  return (data ?? []) as Array<{ code: string; edition: string; brief_date: string; created_at: string }>;
}

/**
 * Today's brief for the app-shell button (ET date, never UTC) and how many of
 * its items are still open. With several editions today, the one saved last
 * wins: the morning brief until the EOD saves, then the EOD.
 */
export async function getTodayBriefStatus(
  supabase: AnySupabase,
  userId: string,
  options: { now?: Date; edition?: string } = {}
): Promise<TodayBriefStatus | null> {
  const briefDate = todayInBriefTimeZone(options.now ?? new Date());
  // One request: the brief with its items' states embedded (was two in a row;
  // this runs in the root layout on every page).
  let query = supabase
    .from("briefs")
    .select("id, code, brief_date, brief_items(state)")
    .eq("user_id", userId)
    .eq("brief_date", briefDate)
    .eq("brief_items.user_id", userId);
  if (options.edition) query = query.eq("edition", options.edition);
  const { data: brief, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!brief) return null;

  const embedded = (brief as { brief_items?: unknown }).brief_items;
  const rows = (Array.isArray(embedded) ? embedded : []) as Array<{ state: string }>;
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
  /** Tomorrow / Move: the new due date. Accept: the created task's due date (null = no date), only when this call created it. */
  due_at?: string | null;
  /** Accept: who holds the created task ("brent"), only when this call created it. */
  owner?: string;
  choice?: string;
  error?: string;
  /** The item changed between validation and the write; nothing was applied. Re-read and decide again. */
  conflict?: boolean;
  current_state?: BriefItemState;
  /** Undo was refused for a reason that will not go away on its own (a task's date was changed since, or no snapshot): the page stops offering Undo. */
  undo_blocked?: boolean;
}

/** "Work digest 2026-10-29 AM, W3" for a digest citation. */
export function workDigestCitationLabel(ref: BriefWorkDigestRef, fallbackDate: string): string {
  return `Work digest ${ref.date ?? fallbackDate} ${ref.edition.toUpperCase()}, ${ref.blocks.join(", ")}`;
}

function describeSources(item: BriefItemRow, briefDate: string): string {
  const digest = item.source.work_digest;
  const digestLines = digest
    ? [[`- ${workDigestCitationLabel(digest, briefDate)}${digest.where ? ` (${digest.where})` : ""}`, ...digest.lines.map((line) => `  "${line}"`)].join("\n")]
    : [];
  const meetingLines = item.source.meetings
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
    });
  return [...meetingLines, ...digestLines].join("\n");
}

/**
 * Where an accepted proposal says it came from. Meeting proposals are
 * unchanged; a work digest citation adds the "from-work-digest" tag, and a
 * digest-only proposal is source_type "Work digest" linking its note.
 */
export function proposalTaskSource(item: Pick<BriefItemRow, "source">): { tags: string[]; source_type: string; source_url: string | null } {
  const hasMeetings = item.source.meetings.length > 0;
  const digest = item.source.work_digest;
  const tags = [...(hasMeetings || !digest ? ["from-meeting"] : []), ...(digest ? ["from-work-digest"] : [])];
  const meetingUrl = item.source.meetings.find((meeting) => meeting.url)?.url ?? null;
  return {
    tags,
    source_type: hasMeetings || !digest ? "Meeting" : "Work digest",
    source_url: meetingUrl ?? (digest ? `/r/note/${digest.note_id}` : null),
  };
}

/**
 * The task Accept creates. brief_item_transition inserts it in the same
 * transaction as the state change, owned by Brent (058) with this due date
 * (null = none), so the due-date boost is part of its first priority score.
 */
async function buildProposalTask(supabase: AnySupabase, userId: string, brief: BriefRow, item: BriefItemRow, dueAt: string | null) {
  const title = item.payload.title.slice(0, 500);
  const description = [item.payload.detail, `From ${brief.code} #${item.n}:`, describeSources(item, brief.brief_date)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const boosts = calculatePriorityBoosts([], dueAt, title, "Backlog", highPriorityNames);
  return {
    title,
    description,
    due_at: dueAt,
    base_priority: 50,
    priority_score: calculateFinalPriorityScore(50, boosts),
    ...proposalTaskSource(item),
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

/** Undo refused by the database because a task's date changed after the move (064, SQLSTATE MC064). */
const TASK_CHANGED_SQLSTATE = "MC064";

function actionErrorMessage(item: BriefItemRow, caught: unknown): string {
  if (caught && typeof caught === "object" && (caught as { code?: unknown }).code === TASK_CHANGED_SQLSTATE) {
    return `#${item.n} can't be undone: a task's due date was changed after the move, and Undo would overwrite it. Change it in Baseline.`;
  }
  return errorMessage(caught);
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
 * new state, so they land together or not at all. A deferral (Tomorrow, or Move
 * to a picked day) writes only due_at and the recomputed priority, exactly like
 * Tomorrow always has: nothing here touches the date cascade (the brief's write
 * path never has), so a moved task's dependents stay where they are.
 */
async function buildCarryUpdates(
  supabase: AnySupabase,
  userId: string,
  brief: BriefRow,
  item: BriefItemRow,
  action: { action: "done" | "tomorrow" | "park" | "move"; date?: string | null },
  now: Date
) {
  const tasks = await assertTasksOwned(supabase, userId, item.task_ids);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  const dueAt =
    action.action === "tomorrow"
      ? resolveTomorrowDueAt(brief.brief_date, now)
      : action.action === "move"
        ? resolvePickedDueAt(action.date ?? "", now)
        : undefined;

  const updates = item.task_ids.map((taskId) => {
    const task = tasks.get(taskId)!;
    const change: Partial<Task> = {};
    if (action.action === "done") change.status = "Done";
    if (action.action === "park") change.status = "Parked";
    if (dueAt) change.due_at = dueAt;
    change.priority_score = recalculateTaskPriority({ ...task, ...change } as Task, highPriorityNames);
    return { id: taskId, ...change, from_status: task.status as TaskStatus };
  });
  return { dueAt, updates };
}

/**
 * Undo of a deferral: every task goes back to the due date the transition saved
 * (null = it had none), priority recomputed for that date. Each update carries
 * `expect_due_at`, the date the move set: the database refuses the whole undo if
 * any task has been edited since, rather than overwrite a newer date.
 */
async function buildUndoUpdates(supabase: AnySupabase, userId: string, item: BriefItemRow) {
  const snapshot = new Map((item.prior_due ?? []).map((entry) => [entry.id, entry] as const));
  const missing = item.task_ids.filter((id) => !snapshot.has(id));
  if (missing.length || snapshot.size === 0) {
    throw new BriefServiceError(409, `#${item.n} can't be undone: its earlier due dates weren't saved. Change the task dates in Baseline.`);
  }
  const tasks = await assertTasksOwned(supabase, userId, item.task_ids);
  const highPriorityNames = await getHighPriorityStakeholderNames(supabase, userId);
  return [...new Set(item.task_ids)].map((taskId) => {
    const before = snapshot.get(taskId)!;
    const task = tasks.get(taskId)!;
    return {
      id: taskId,
      due_at: before.due_at,
      expect_due_at: before.applied_due_at,
      priority_score: recalculateTaskPriority({ ...task, due_at: before.due_at } as Task, highPriorityNames),
    };
  });
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
    if (!rule.from.includes(item.state) && !isRepeat(item, action, brief, now)) {
      const movedTo = (action.action === "move" || action.action === "tomorrow") && item.state === "deferred" ? deferredToDate(item) : null;
      problems.push(
        item.state === "accepted"
          ? `#${action.n} was already accepted (task ${item.created_task_id ?? "deleted"}); change it in Baseline`
          : movedTo
            ? `#${action.n} is already moved to ${movedTo}; undo it first to pick another day`
            : `#${action.n} is ${item.state}; "${action.action}" isn't possible from there`
      );
      continue;
    }
    if (action.action === "move") {
      const problem = pickedDateProblem(action.date, now);
      if (problem) problems.push(`#${action.n}: ${problem}`);
    }
    if (action.action === "undo" && item.state === "deferred" && !item.prior_due?.length) {
      problems.push(`#${action.n} can't be undone: it was moved before earlier due dates were saved. Change the task dates in Baseline`);
    }
    if (action.date && action.action !== "move") {
      problems.push(`#${action.n}: date only applies to move`);
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
    if (action.due && action.action !== "accept") {
      problems.push(`#${action.n}: due only applies to accept`);
    }
    if (action.action === "accept" && action.due && !isAcceptDuePreset(action.due)) {
      const problem = pickedDateProblem(action.due, now);
      if (problem) problems.push(`#${action.n}: ${problem}; otherwise use today, tomorrow, this_week or none`);
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
      if (isRepeat(item, action, brief, now)) {
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
          const dueAt = resolveAcceptDueAt(action.due ?? DEFAULT_ACCEPT_DUE, brief.brief_date, now);
          const task = await buildProposalTask(supabase, userId, brief, item, dueAt);
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
            result.due_at = dueAt;
            result.owner = "brent";
            queueTaskStatusTransition(supabase, { userId, taskId: outcome.created_task_id, fromStatus: null, toStatus: "Backlog" });
          }
          break;
        }
        case "dismiss":
        case "pick":
        case "undo": {
          if (action.action === "undo" && (item.kind === "carry_over" || item.kind === "carry_group")) {
            // One transaction: each task's due date goes back from the saved snapshot and the card reopens.
            const updates = await buildUndoUpdates(supabase, userId, item);
            const outcome = await transitionItem(supabase, userId, item, item.state, next, { acted_at: null }, null, updates);
            if (!outcome.ok) {
              results.push(conflictResult(item, action.action, outcome));
              continue;
            }
            result.task_ids = item.task_ids;
            break;
          }
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
        case "move":
        case "park": {
          // One transaction: the item's new state and every task write commit together or not at all.
          // So "already" below can only ever mean the tasks really were updated.
          const { dueAt, updates } = await buildCarryUpdates(supabase, userId, brief, item, { action: action.action, date: action.date }, now);
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
      const undoBlocked =
        action.action === "undo" &&
        (caught instanceof BriefServiceError || (caught as { code?: unknown } | null)?.code === TASK_CHANGED_SQLSTATE);
      results.push({
        n: item.n,
        action: action.action,
        ok: false,
        error: actionErrorMessage(item, caught),
        ...(undoBlocked ? { undo_blocked: true } : {}),
      });
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
