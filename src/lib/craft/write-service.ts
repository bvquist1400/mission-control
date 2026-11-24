/**
 * Server-only: the craft screen's writes (S2). Each is ONE call to a migration 073 function with the caller's client
 * (RLS on, SECURITY INVOKER), after checking that the part belongs to the project in the URL (a missing row is the
 * 404, PGRST116). Notes are a plain insert/delete on craft_notes (071's ownership trigger checks the part and
 * session). Every reply carries the fresh view, so the screen never shows a count the server doesn't have.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase.generated";
import { loadCraftView } from "@/lib/craft/loader";
import { partRowsOf } from "@/lib/craft";
import { CRAFT_CHECK_IDS_MAX, CRAFT_MAX_ROWS, addRowsRefusal, lowerRefusal, raiseWhereText, setTotalRefusalText, takeBackRefusalText, type RowWord } from "@/lib/craft/actions";
import { queueTaskStatusTransition } from "@/lib/task-status-transitions";

type Client = SupabaseClient<Database>;

/** A refusal with plain words; the route answers with this status, the reason and any extra fields. */
export class CraftWriteError extends Error {
  status: number;
  reason: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, reason: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status; this.reason = reason; this.extra = extra;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string): never => { throw new CraftWriteError(400, message, "invalid"); };

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("Body must be a JSON object");
  return body as Record<string, unknown>;
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) bad(`Unknown fields: ${extra.join(", ")}`);
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) bad(`${field} must be a UUID`);
  return (value as string).toLowerCase();
}
function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) bad(`${field} must be a whole number from ${min} to ${max}`);
  return value as number;
}
const optional = <T>(value: unknown, read: (v: unknown) => T): T | null => (value === undefined || value === null ? null : read(value));

/** The part, owned by the caller and in this project (single(): none = PGRST116 = 404). */
async function partIn(client: Client, userId: string, projectId: string, partId: string) {
  const { data, error } = await client.from("craft_parts").select("id, project_id, row_word, total_rows")
    .eq("user_id", userId).eq("project_id", projectId).eq("id", partId).single();
  if (error) throw error;
  return data;
}

/** 073 errors → plain refusals. Anything else is rethrown (a 500). */
function rpcFailure(error: { code?: string; message?: string }): never {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "22023": case "23514": case "22P02": case "23503": case "22003":
      throw new CraftWriteError(400, message, "invalid");
    case "42501":
      throw new CraftWriteError(403, "Not allowed", "forbidden");
    case "P0002":
      throw new CraftWriteError(404, "Craft project or part not found", "not_found");
    case "40001": case "40P01": case "55P03":
      throw new CraftWriteError(409, "Not saved: the rows were busy. Try again.", "busy");
    default:
      throw Object.assign(new Error(message), error);
  }
}

const view = (client: Client, userId: string, projectId: string) => loadCraftView(client, userId, projectId);
type RpcResult = { status: string; [key: string]: unknown };

const STALE_ROW = "Not saved: the count changed on another screen. The screen now shows the latest.";

// ── Row done / Undo / Fix count / band close ─────────────────────────────────
export async function writeRows(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "mode", "expected_row", "to_row", "segment_id"]);
  const partId = uuid(body.part_id, "part_id");
  const mode = body.mode;
  // S3 (074) F2: undo_one is the Row done toast's Undo (exactly one row; refused when rows after it are ticked).
  if (mode !== "done" && mode !== "undo" && mode !== "undo_one" && mode !== "fix" && mode !== "close") bad("mode must be done, undo, undo_one, fix or close");
  const expected = mode === "close" ? optional(body.expected_row, (v) => int(v, "expected_row", 1, 100_000)) : int(body.expected_row, "expected_row", 1, 100_000);
  const withRow = mode === "undo" || mode === "undo_one" || mode === "fix";
  const toRow = withRow ? int(body.to_row, "to_row", 1, 100_000) : null;
  if (!withRow && body.to_row !== undefined && body.to_row !== null) bad("to_row is only for undo, undo_one and fix");
  const segmentId = mode === "close" ? uuid(body.segment_id, "segment_id") : null;
  if (mode !== "close" && body.segment_id !== undefined && body.segment_id !== null) bad("segment_id is only for close");
  await partIn(client, userId, projectId, partId);
  const { data, error } = await client.rpc("craft_rows", {
    p_user_id: userId, p_part_id: partId, p_expected_row: expected as number, p_to_row: toRow as number, p_mode: mode as string,
    ...(segmentId ? { p_segment_id: segmentId } : {}),
  });
  if (error) rpcFailure(error);
  const result = data as RpcResult;
  const closed = result.closed as { task_id: string; from_status: string | null } | null | undefined;
  if (result.status === "ok" && closed?.from_status && closed.from_status !== "Done") {
    queueTaskStatusTransition(client, { userId, taskId: closed.task_id, fromStatus: closed.from_status as never, toStatus: "Done" });
  }
  const fresh = await view(client, userId, projectId);
  if (result.status === "stale") throw new CraftWriteError(409, mode === "undo_one"
    ? "Not undone: rows after it were ticked since. Use Undo rows… to choose." : STALE_ROW, "stale", { result, view: fresh });
  if (result.status === "finished") throw new CraftWriteError(409, "Not saved: every row of this part is already ticked.", "finished", { result, view: fresh });
  if (result.status === "open_rows") throw new CraftWriteError(409, "Not closed: a row of this band isn't ticked any more.", "open_rows", { result, view: fresh });
  return { result, view: fresh };
}

// ── Timer ───────────────────────────────────────────────────────────────────
const TIMER_ACTIONS = ["start", "pause", "resume", "toggle", "discard", "adjust", "stopped_ago"] as const;
export async function writeTimer(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["action", "part_id", "minutes", "expected_version", "force"]);
  if (!TIMER_ACTIONS.includes(body.action as (typeof TIMER_ACTIONS)[number])) bad(`action must be one of ${TIMER_ACTIONS.join(", ")}`);
  const partId = optional(body.part_id, (v) => uuid(v, "part_id"));
  const minutes = optional(body.minutes, (v) => int(v, "minutes", -1440, 1440));
  const version = optional(body.expected_version, (v) => int(v, "expected_version", 0, 2_000_000_000));
  if (body.force !== undefined && typeof body.force !== "boolean") bad("force must be true or false");
  if (partId) await partIn(client, userId, projectId, partId);
  const { data, error } = await client.rpc("craft_timer", {
    p_user_id: userId, p_action: body.action as string, p_project_id: projectId,
    ...(partId ? { p_part_id: partId } : {}), ...(minutes !== null ? { p_minutes: minutes } : {}),
    ...(version !== null ? { p_expected_version: version } : {}), p_force: body.force === true,
  });
  if (error) rpcFailure(error);
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh };
  const words: Record<string, string> = {
    stale: "Not saved: the timer changed on another screen. The screen now shows it.",
    conflict: "Another project's timer has time that isn't saved yet.",
    new_day: "This sitting started on an earlier day.",
    none: "There is no timer running on this project.",
    not_running: "The timer isn't running.",
  };
  throw new CraftWriteError(409, words[result.status] ?? "Not saved.", result.status, { result, view: fresh });
}

// ── Log sitting ─────────────────────────────────────────────────────────────
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export async function writeSitting(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "use_timer", "timer_version", "minutes", "date", "started_at", "ended_at", "from_row", "to_row", "to_quarter", "expected_row", "note", "idempotency_key", "in_progress"]);
  const partId = uuid(body.part_id, "part_id");
  if (typeof body.use_timer !== "boolean") bad("use_timer must be true or false");
  const useTimer = body.use_timer as boolean;
  const timerVersion = useTimer ? int(body.timer_version, "timer_version", 0, 2_000_000_000) : null;
  const minutes = optional(body.minutes, (v) => int(v, "minutes", 1, 1440));
  if (!useTimer && minutes === null) bad("minutes are required without the timer");
  const date = optional(body.date, (v) => { if (typeof v !== "string" || !DATE.test(v)) bad("date must be YYYY-MM-DD"); return v as string; });
  const instant = (v: unknown, field: string) => { if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/T/.test(v)) bad(`${field} must be an ISO time`); return new Date(v as string).toISOString(); };
  const startedAt = optional(body.started_at, (v) => instant(v, "started_at"));
  const endedAt = optional(body.ended_at, (v) => instant(v, "ended_at"));
  if (useTimer && (startedAt || endedAt || date)) bad("times and date come from the timer");
  const fromRow = optional(body.from_row, (v) => int(v, "from_row", 0, 100_000));
  if (!useTimer && fromRow === null) bad("from_row is required without the timer");
  const toRow = int(body.to_row, "to_row", 0, 100_000);
  const toQuarter = optional(body.to_quarter, (v) => int(v, "to_quarter", 0, 3)) ?? 0;
  const expected = int(body.expected_row, "expected_row", 1, 100_000);
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") bad("note must be text");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 2000) bad("note must be 2000 characters or fewer");
  if (typeof body.idempotency_key !== "string" || !body.idempotency_key.trim() || body.idempotency_key.trim().length > 190) bad("idempotency_key must be 1 to 190 characters");
  const key = (body.idempotency_key as string).trim();
  if (body.in_progress !== undefined && typeof body.in_progress !== "boolean") bad("in_progress must be true or false");
  await partIn(client, userId, projectId, partId);
  // S3 (074): craft_save_sitting = 073's Log sitting plus "Partway through row N" (the next row linked in progress).
  const { data, error } = await client.rpc("craft_save_sitting", {
    p_user_id: userId, p_part_id: partId, p_use_timer: useTimer, p_timer_version: timerVersion as number, p_minutes: minutes as number,
    p_date: date as string, p_started_at: startedAt as string, p_ended_at: endedAt as string, p_from_row: fromRow as number,
    p_to_row: toRow, p_to_quarter: toQuarter, p_expected_row: expected, p_note: note || (null as unknown as string), p_idempotency_key: key,
    p_in_progress: body.in_progress === true,
  });
  if (error) {
    // Two identical retries at once: the loser's insert hits the source_ref index; answer with the winner.
    if (error.code === "23505") {
      const { data: found } = await client.from("work_sessions").select("id, project_id").eq("user_id", userId).eq("source_ref", `client:${key}`).maybeSingle();
      if (found && found.project_id === projectId) return { result: { status: "duplicate", session_id: found.id }, view: await view(client, userId, projectId), duplicate: true };
      throw new CraftWriteError(409, "This sitting key was already used for another project's sitting.", "key_used");
    }
    rpcFailure(error);
  }
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh, duplicate: false };
  if (result.status === "duplicate") return { result, view: fresh, duplicate: true };
  const words: Record<string, string> = {
    stale: STALE_ROW,
    stale_timer: "Not saved: the timer changed on another screen. Check the minutes and save again.",
    no_timer: "Not saved: there is no timer on this project any more. Type the minutes instead.",
  };
  throw new CraftWriteError(409, words[result.status] ?? "Not saved.", result.status, { result, view: fresh });
}

// ── Ripped back (S3, 074) ───────────────────────────────────────────────────
export async function writeFrog(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "expected_row", "from_row", "to_row", "note", "exclude_session_ids", "idempotency_key"]);
  const partId = uuid(body.part_id, "part_id");
  const expected = int(body.expected_row, "expected_row", 1, 100_000);
  const fromRow = int(body.from_row, "from_row", 1, 100_000);
  const toRow = int(body.to_row, "to_row", 1, 100_000);
  if (toRow < fromRow) bad("to_row must be at least from_row");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") bad("note must be text");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if ([...note].length > 1000) bad("note must be 1000 characters or fewer");
  const raws = body.exclude_session_ids ?? [];
  if (!Array.isArray(raws) || raws.length > 500) bad("exclude_session_ids must be a list of sitting ids");
  const exclude = [...new Set((raws as unknown[]).map((v) => uuid(v, "exclude_session_ids[]")))];
  if (typeof body.idempotency_key !== "string" || !body.idempotency_key.trim() || body.idempotency_key.trim().length > 190) bad("idempotency_key must be 1 to 190 characters");
  await partIn(client, userId, projectId, partId);
  const { data, error } = await client.rpc("craft_frog", {
    p_user_id: userId, p_part_id: partId, p_expected_row: expected, p_from_row: fromRow, p_to_row: toRow,
    p_note: note || (null as unknown as string), p_exclude_session_ids: exclude, p_idempotency_key: (body.idempotency_key as string).trim(),
  });
  if (error) {
    if (error.code === "23505") throw new CraftWriteError(409, "This rip-back key was already used for another part.", "key_used");
    rpcFailure(error);
  }
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh, duplicate: false };
  if (result.status === "duplicate") return { result, view: fresh, duplicate: true };
  const words: Record<string, string> = {
    stale: STALE_ROW,
    other_part: "Not saved: the screen moved to another part. Rip back on the part the screen shows.",
  };
  throw new CraftWriteError(409, words[result.status] ?? "Not saved.", result.status, { result, view: fresh });
}

// ── Change total rows/rounds ─────────────────────────────────────────────────
export async function writeTotal(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "total", "expected_total", "text", "work_type", "how"]);
  const partId = uuid(body.part_id, "part_id");
  const total = int(body.total, "total", 1, 2000);
  const expected = int(body.expected_total, "expected_total", 1, 100_000);
  // S3 FR3: the pattern text and work type of rows Change total adds ("knit (US 7)", stockinette); none = the last row's type, a bare label.
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") bad("text must be text");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if ([...text].length > 200) bad("text must be 200 characters or fewer");
  if (body.work_type !== undefined && body.work_type !== null && (typeof body.work_type !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.work_type))) bad("work_type must be a lowercase work type (letters, numbers, dashes)");
  const workType = typeof body.work_type === "string" ? body.work_type : null;
  // S3 FR4: where raised rows go ("after_row" = right after the part's last row, before a step after it; "after_steps" =
  // after that step), or "take_back" = a lowering that drops the rows above the new total whatever their text (the
  // sheet named them and asked a second time). None = the default rules.
  if (body.how !== undefined && body.how !== null && !["after_row", "after_steps", "take_back"].includes(body.how as string)) bad("how must be after_row, after_steps or take_back");
  const how = typeof body.how === "string" ? body.how : null;
  if (how === "take_back" && total >= expected) bad("take_back only lowers a total");
  if ((how === "after_row" || how === "after_steps") && total <= expected) bad("after_row and after_steps only raise a total");
  const part = await partIn(client, userId, projectId, partId);
  const { data, error } = await client.rpc("craft_set_total", { p_user_id: userId, p_part_id: partId, p_total: total, p_expected_total: expected,
    ...(text ? { p_text: text } : {}), ...(workType ? { p_work_type: workType } : {}), ...(how ? { p_how: how } : {}) });
  if (error) rpcFailure(error);
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh };
  if (result.status === "stale") throw new CraftWriteError(409, "Not saved: the total changed on another screen. The screen now shows it.", "stale", { result, view: fresh });
  const word: RowWord = part.row_word === "round" ? "round" : "row";
  const reason = String(result.reason ?? "refused"), rows = (result.rows as number[] | undefined) ?? [];
  // FR5: the real blocker in plain words. A raise with no `how` while a step follows the last row says to pick before
  // or after it; a take-back names the raised row that blocks it (or that the rows weren't added by a raise); a usual
  // lowering names what is ticked or in a sitting and the total it can reach, never "undo" a knitted row.
  const freshRows = partRowsOf(fresh, partId), freshPart = fresh.parts.find((entry) => entry.id === partId);
  const lowered = how === null && total < expected && freshPart ? lowerRefusal(word, freshRows, freshPart.total_rows, total, true) : null;
  const message = reason === "where" ? raiseWhereText(word, ((result.steps as string[] | undefined) ?? []), (result.after_row as number | undefined) ?? null)
    : how === "take_back" ? takeBackRefusalText(word, { reason, rows, remove: (result.above as number[] | undefined) ?? freshRows.filter((s) => s.row > total).map((s) => s.row) })
    : lowered ? lowered.text
    : setTotalRefusalText(word, { reason, rows, need: result.need as number | undefined });
  throw new CraftWriteError(409, message, reason, { result, view: fresh });
}

// ── Checks (S3 FR3) ──────────────────────────────────────────────────────────
/** Done on a check card (or Yes on Row done's "Not done yet"): ticks those plain checklist items, only if they're this project's checks. */
export async function writeCheck(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["item_ids"]);
  const raws = body.item_ids;
  // FR5 (Sol 2): "Mark all done" can send more than 50 (074's craft_check takes up to 500; the screen sends batches).
  if (!Array.isArray(raws) || raws.length < 1 || raws.length > CRAFT_CHECK_IDS_MAX) bad(`item_ids must be a list of 1 to ${CRAFT_CHECK_IDS_MAX} check ids`);
  const ids = [...new Set((raws as unknown[]).map((v) => uuid(v, "item_ids[]")))];
  const craft = await client.from("craft_projects").select("project_id").eq("user_id", userId).eq("project_id", projectId).single();
  if (craft.error) throw craft.error;
  const { data, error } = await client.rpc("craft_check", { p_user_id: userId, p_project_id: projectId, p_item_ids: ids });
  if (error) rpcFailure(error);
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh };
  throw new CraftWriteError(409, "Not saved: that check changed on another screen. The screen now shows the latest.", String(result.status), { result, view: fresh });
}

// ── Work on this part (S3 FR3) ──────────────────────────────────────────────
export async function writePart(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "expected_part_id"]);
  const partId = uuid(body.part_id, "part_id");
  const expected = optional(body.expected_part_id, (v) => uuid(v, "expected_part_id"));
  await partIn(client, userId, projectId, partId);
  const { data, error } = await client.rpc("craft_pick_part", { p_user_id: userId, p_part_id: partId, p_expected_part_id: expected as string });
  if (error) rpcFailure(error);
  const result = data as RpcResult;
  const fresh = await view(client, userId, projectId);
  if (result.status === "ok") return { result, view: fresh };
  const words: Record<string, string> = {
    stale: "Not saved: the screen's part changed on another screen. The screen now shows it.",
    finished: "Every row of that part is ticked. Change total… adds rows to it.",
  };
  throw new CraftWriteError(409, words[result.status] ?? "Not saved.", result.status, { result, view: fresh });
}

// ── Notes ───────────────────────────────────────────────────────────────────
export async function writeNote(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["part_id", "row", "text"]);
  const partId = optional(body.part_id, (v) => uuid(v, "part_id"));
  const row = optional(body.row, (v) => int(v, "row", 1, 100_000));
  if (row !== null && partId === null) bad("a row note needs part_id");
  if (typeof body.text !== "string" || !body.text.trim()) bad("text is required");
  const text = (body.text as string).trim();
  if ([...text].length > 1000) bad("text must be 1000 characters or fewer");
  // The craft project row is the 404 for a project that isn't on the craft screen.
  const craft = await client.from("craft_projects").select("project_id").eq("user_id", userId).eq("project_id", projectId).single();
  if (craft.error) throw craft.error;
  if (partId) await partIn(client, userId, projectId, partId);
  const { data, error } = await client.from("craft_notes").insert({ user_id: userId, project_id: projectId, part_id: partId, row, text })
    .select("id, part_id, row, text, created_at, session_id").single();
  if (error) rpcFailure(error);
  return { note: data, view: await view(client, userId, projectId) };
}

export async function deleteNote(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["id"]);
  const id = uuid(body.id, "id");
  const { data, error } = await client.from("craft_notes").delete().eq("user_id", userId).eq("project_id", projectId).eq("id", id).select("id").single();
  if (error) throw error;
  return { deleted: data.id, view: await view(client, userId, projectId) };
}

// ── Craft estimates E3: add rows to a sitting already logged ─────────────────
const rowList = (detail: string | undefined) => (detail ?? "").split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
/**
 * POST /api/craft/[id]/sitting-rows { session_id, part_id, expected_row, from_row, to_row }: rows from–to of the part
 * become finished rows of a sitting already logged in this project, in ONE call to migration 076's
 * `craft_add_sitting_rows` (one transaction): it locks the sitting, the project's tasks, the part and the rows,
 * refuses (raises, nothing written) a changed count, rows another sitting finished and unticked rows before them,
 * then ticks the unticked ones and links them through work_session_update. The sitting's minutes, date, task and
 * left-out flag are never sent. Refusals keep the words and codes the sheet shows (`addRowsRefusal`).
 */
export async function writeSittingRows(client: Client, userId: string, projectId: string, raw: unknown) {
  const body = record(raw);
  onlyKeys(body, ["session_id", "part_id", "expected_row", "from_row", "to_row"]);
  const sessionId = uuid(body.session_id, "session_id");
  const partId = uuid(body.part_id, "part_id");
  const expected = int(body.expected_row, "expected_row", 1, 100_000);
  const fromRow = int(body.from_row, "from_row", 1, 100_000);
  const toRow = int(body.to_row, "to_row", 1, 100_000);
  if (toRow < fromRow) bad("to_row must be at least from_row");
  if (toRow - fromRow + 1 > CRAFT_MAX_ROWS) bad(`At most ${CRAFT_MAX_ROWS} rows at a time`);
  const part = await partIn(client, userId, projectId, partId);
  const word: RowWord = part.row_word === "round" ? "round" : "row";
  const { data, error } = await client.rpc("craft_add_sitting_rows", {
    p_user_id: userId, p_project_id: projectId, p_session_id: sessionId, p_part_id: partId,
    p_expected_row: expected, p_from_row: fromRow, p_to_row: toRow,
  });
  if (error) {
    if (error.code === "MC076") {
      const rows = rowList(error.details);
      if (error.message === "stale") throw new CraftWriteError(409, STALE_ROW, "stale", { result: { status: "stale", current_row: rows[0] ?? null }, view: await view(client, userId, projectId) });
      const plan = { rows: error.message === "no_rows" ? [] : [fromRow], tick: [], add: [], in_sitting: error.message === "in_sitting" ? rows : [], earlier: error.message === "earlier" ? rows : [] };
      const reason = error.message === "no_rows" ? "no_rows" : error.message === "in_sitting" ? "in_sitting" : "earlier";
      throw new CraftWriteError(reason === "no_rows" ? 400 : 409, `Not saved: ${addRowsRefusal(word, plan, fromRow, toRow)}`, reason, { rows });
    }
    if (error.code === "P0002" && /SITTING/.test(error.message ?? "")) throw new CraftWriteError(404, "Sitting not found in this project", "not_found");
    rpcFailure(error);
  }
  return { result: data as RpcResult, view: await view(client, userId, projectId) };
}
