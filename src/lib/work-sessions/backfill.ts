/**
 * Pace tracking backfill for the Christmas Tree Blanket (project
 * 5c09c4cd-086d-47bc-a971-77772a1d9f37): tags units/work types from checklist
 * text, and turns Brent's Oct 3 note plus the time-log comments into work
 * sessions. `buildBackfillPlan` is pure (dry run, tested in `test:pace`);
 * `applyBackfillPlan` writes it idempotently (sessions keyed by source_ref).
 * The CLI is `scripts/pace-backfill.mjs`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaceInput, PaceSettings } from "@/lib/pace";
import { etDateOf, etLocalToUtcIso, itemRowNumber, matchRows, parseClockTime, parseRowsSpec } from "@/lib/work-sessions/parse";

export const BLANKET_PROJECT_ID = "5c09c4cd-086d-47bc-a971-77772a1d9f37";
export const BLANKET_UNIT_LABEL = "stitches";
export const BLANKET_PACE_SETTINGS: PaceSettings = {
  size: {
    label: "width",
    current: 195,
    step: 12,
    offset: 3,
    min: 27,
    unit: "stitches",
    work_types: ["chain", "sc", "plain-dc", "waffle", "colorwork-dc"],
  },
};
const SWATCH_WIDTH = 27;
const BODY_WIDTH = 195;
const OCT3_SOURCE_REF = "brent-chat-2026-10-04-oct3";
const WORK_TYPE_ALIASES: Record<string, string> = { "tree-dc-colorwork": "colorwork-dc" };

// ── Input shapes (the snapshot's, which the DB reader also produces) ────────

export interface BackfillComment {
  id: string;
  created_at: string;
  content: string;
}

export interface BackfillItem {
  id: string;
  text: string;
  is_done: boolean;
  sort_order: number;
  unit_count?: number | null;
  work_type?: string | null;
  completed_at?: string | null;
}

export interface BackfillTask {
  id: string;
  title: string;
  status: string;
  section_id: string | null;
  section_name?: string | null;
  estimated_minutes: number | null;
  checklist: BackfillItem[];
  comments: BackfillComment[];
}

export interface BackfillSnapshot {
  project: { id: string; name: string; target_date: string | null; unit_label?: string | null; pace_settings?: unknown };
  sections: Array<{ id: string; name: string; planned_start: string | null; planned_end: string | null }>;
  tasks: BackfillTask[];
  /** Sessions already stored (by source_ref) — skipped. */
  existing_source_refs?: string[];
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface PlannedItemTag {
  item_id: string;
  task_id: string;
  text: string;
  unit_count: number;
  work_type: string;
  rule: string;
}

export interface PlannedSession {
  source_ref: string;
  task_id: string | null;
  session_date: string;
  started_at: string | null;
  ended_at: string | null;
  minutes: number;
  exclude_from_stats: boolean;
  exclude_reason: string | null;
  note: string;
  item_ids: string[];
  origin: string;
  already_stored: boolean;
}

export interface BackfillPlan {
  project: { id: string; unit_label: string; pace_settings: PaceSettings };
  task_updates: Array<{ task_id: string; title: string; is_sample: boolean; unit_count: number | null; work_type: string | null; width: number | null }>;
  item_tags: PlannedItemTag[];
  no_unit_items: Array<{ item_id: string; task_title: string; text: string; rule: string }>;
  unmatched: Array<{ task_title: string; text: string; reason: string }>;
  rule_hits: Record<string, number>;
  rules_without_hits: string[];
  sessions: PlannedSession[];
  completed_at_updates: Array<{ item_id: string; completed_at: string; via: string }>;
  warnings: string[];
}

interface ItemRule {
  name: string;
  test: RegExp;
  type: string | null; // null = a check item with no units
  units: "width" | "n" | null;
}

/** Order matters: the first rule that matches wins. */
const ITEM_RULES: ItemRule[] = [
  { name: "check item (Count …)", test: /^\s*count\b/i, type: null, units: null },
  { name: "check item (markers / fasten off)", test: /^\s*(place markers|do not fasten off|fasten off)\b/i, type: null, units: null },
  { name: "Chain N → chain, N", test: /^\s*chain\s+(\d+)\s*$/i, type: "chain", units: "n" },
  { name: "waffle setup row, dc across → plain-dc", test: /waffle setup row,\s*dc across/i, type: "plain-dc", units: "width" },
  { name: "waffle Row A / Row B → waffle", test: /waffle row [ab]\b/i, type: "waffle", units: "width" },
  { name: "dc across in cream → plain-dc", test: /dc across in cream/i, type: "plain-dc", units: "width" },
  { name: "N-wide … row → colorwork-dc", test: /\b\d+-wide\b.*\brow\b/i, type: "colorwork-dc", units: "width" },
  { name: "sc across / row 1 sc → sc", test: /(\bsc across\b|^\s*row 1:\s*sc\b)/i, type: "sc", units: "width" },
];

const BORDER_RULES: Array<{ name: string; test: RegExp; units: number }> = [
  { name: "Border round 1 → task sc 970", test: /border round 1\b/i, units: 970 },
  { name: "Border round 2 → task sc 980", test: /border round 2\b/i, units: 980 },
];

function isSwatchSection(name: string | null | undefined): boolean {
  return /swatch/i.test(name ?? "");
}
function isBodySection(name: string | null | undefined): boolean {
  return /body/i.test(name ?? "");
}

function etEndOfDayIso(date: string): string {
  return etLocalToUtcIso(date, 23 * 60 + 59);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function etYearOf(iso: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date(iso)));
}

interface ParsedLog {
  date: string;
  rows: number[];
  start: number | null;
  end: number | null;
  minutes: number | null;
  exclude: boolean;
  excludeReason: string | null;
  note: string | null;
  workType: string | null;
  stitches: number | null;
  flags: string[];
}

/** `TIMELOG | 2026-10-04 | rows 11-15 | type=… | stitches=135 | start=13:38 | end=14:39 | minutes=61 | clean=unknown | note=…` */
export function parseTimelogComment(content: string): ParsedLog | { error: string } | null {
  const trimmed = content.trim();
  if (!/^TIMELOG\s*\|/i.test(trimmed)) return null;
  const parts = trimmed.split("|").map((part) => part.trim());
  const date = parts[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return { error: `TIMELOG date "${date}" is not YYYY-MM-DD` };
  const rows = parseRowsSpec(parts[2] ?? "");
  if (!rows.ok) return { error: `TIMELOG rows: ${rows.error}` };
  const fields: Record<string, string> = {};
  // The note may itself contain "|"; everything after "note=" is the note.
  const noteIndex = parts.findIndex((part) => /^note=/i.test(part));
  const keyed = noteIndex >= 0 ? parts.slice(3, noteIndex) : parts.slice(3);
  for (const part of keyed) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  const note = noteIndex >= 0 ? parts.slice(noteIndex).join(" | ").replace(/^note=/i, "").trim() : null;
  const clean = (fields.clean ?? "unknown").toLowerCase();
  const flags: string[] = [];
  if (clean === "unknown") flags.push("clean=unknown (counted)");
  const exclude = clean === "no";
  const rawType = fields.type?.toLowerCase() ?? null;
  return {
    date,
    rows: rows.value,
    start: fields.start ? parseClockTime(fields.start) : null,
    end: fields.end ? parseClockTime(fields.end) : null,
    minutes: fields.minutes ? Number(fields.minutes) : null,
    exclude,
    excludeReason: exclude ? (/reading instructions/i.test(note ?? "") ? "reading-instructions" : "unclean") : null,
    note,
    workType: rawType ? WORK_TYPE_ALIASES[rawType] ?? rawType : null,
    stitches: fields.stitches ? Number(fields.stitches) : null,
    flags,
  };
}

/** `Session · Oct 5 · 7:40–8:42 PM · 62 min · rows 11–12 · learning · note: …` (year: the one putting the date on or before the comment, ET). */
export function parseSessionComment(content: string, createdAt: string): ParsedLog | { error: string } | null {
  const trimmed = content.trim();
  if (!/^session\s*·/i.test(trimmed)) return null;
  const noteMatch = /·\s*note:\s*([\s\S]*)$/i.exec(trimmed);
  const head = noteMatch ? trimmed.slice(0, noteMatch.index) : trimmed;
  const parts = head.split("·").map((part) => part.trim()).filter(Boolean).slice(1);
  let date: string | null = null;
  let start: number | null = null;
  let end: number | null = null;
  let minutes: number | null = null;
  let rows: number[] = [];
  let learning = false;
  const unknown: string[] = [];
  for (const part of parts) {
    const dateMatch = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i.exec(part);
    const timeMatch = /^(\d{1,2}(?::\d{2})?)\s*([ap]m)?\s*[–—-]\s*(\d{1,2}(?::\d{2})?)\s*([ap]m)?$/i.exec(part);
    const minutesMatch = /^(\d+)\s*min(ute)?s?$/i.exec(part);
    if (dateMatch && MONTHS.includes(dateMatch[1].toLowerCase())) {
      const month = MONTHS.indexOf(dateMatch[1].toLowerCase()) + 1;
      const monthDay = `${String(month).padStart(2, "0")}-${String(Number(dateMatch[2])).padStart(2, "0")}`;
      // The year that puts the sitting on or before the day the comment was written
      // (a Jan 2 comment about "Dec 30" means last year's Dec 30).
      const year = etYearOf(createdAt);
      date = `${year}-${monthDay}` <= etDateOf(createdAt) ? `${year}-${monthDay}` : `${year - 1}-${monthDay}`;
    } else if (timeMatch) {
      const endMeridiem = timeMatch[4] ?? null;
      const startMeridiem = timeMatch[2] ?? endMeridiem;
      const withColon = (value: string) => (value.includes(":") ? value : `${value}:00`);
      start = parseClockTime(`${withColon(timeMatch[1])}${startMeridiem ? ` ${startMeridiem}` : ""}`);
      end = parseClockTime(`${withColon(timeMatch[3])}${endMeridiem ? ` ${endMeridiem}` : ""}`);
      // "11:30–12:15 PM": the shared meridiem made the start later than the end → it was AM.
      if (start !== null && end !== null && !timeMatch[2] && endMeridiem && start > end) start -= 12 * 60;
    } else if (minutesMatch) {
      minutes = Number(minutesMatch[1]);
    } else if (/^rows?\b/i.test(part)) {
      const parsed = parseRowsSpec(part);
      if (!parsed.ok) return { error: `Session rows: ${parsed.error}` };
      rows = parsed.value;
    } else if (/^learning$/i.test(part)) {
      learning = true;
    } else {
      unknown.push(part);
    }
  }
  if (!date) return { error: "Session comment has no date like \"Oct 5\"" };
  return {
    date,
    rows,
    start,
    end,
    minutes,
    exclude: learning,
    excludeReason: learning ? "learning" : null,
    note: noteMatch ? noteMatch[1].trim() : null,
    workType: null,
    stitches: null,
    flags: unknown.map((part) => `unrecognised part "${part}"`),
  };
}

function tagTask(task: BackfillTask, sectionName: string | null) {
  const rowsInTask = task.checklist.some((item) => itemRowNumber(item.text) !== null);
  const swatch = isSwatchSection(sectionName) && rowsInTask;
  const body = isBodySection(sectionName);
  const width = swatch ? SWATCH_WIDTH : body ? BODY_WIDTH : null;
  const border = BORDER_RULES.find((rule) => rule.test.test(task.title));
  return { swatch, body, width, border };
}

export function buildBackfillPlan(snapshot: BackfillSnapshot): BackfillPlan {
  const sectionName = new Map(snapshot.sections.map((section) => [section.id, section.name]));
  const existingRefs = new Set(snapshot.existing_source_refs ?? []);
  const plan: BackfillPlan = {
    project: { id: snapshot.project.id, unit_label: BLANKET_UNIT_LABEL, pace_settings: BLANKET_PACE_SETTINGS },
    task_updates: [],
    item_tags: [],
    no_unit_items: [],
    unmatched: [],
    rule_hits: Object.fromEntries([...ITEM_RULES, ...BORDER_RULES].map((rule) => [rule.name, 0])),
    rules_without_hits: [],
    sessions: [],
    completed_at_updates: [],
    warnings: [],
  };

  const unitsByItem = new Map<string, { units: number; type: string }>();
  for (const task of snapshot.tasks) {
    const sName = task.section_name ?? sectionName.get(task.section_id ?? "") ?? null;
    const tag = tagTask(task, sName);
    if (tag.border) {
      plan.rule_hits[tag.border.name] += 1;
      plan.task_updates.push({ task_id: task.id, title: task.title, is_sample: false, unit_count: tag.border.units, work_type: "sc", width: null });
      for (const item of task.checklist) plan.no_unit_items.push({ item_id: item.id, task_title: task.title, text: item.text, rule: "border task: units are on the task" });
      continue;
    }
    if (tag.width === null) {
      // Warm-up, measuring, yarn, weaving ends, washing: no units.
      continue;
    }
    plan.task_updates.push({ task_id: task.id, title: task.title, is_sample: tag.swatch, unit_count: null, work_type: null, width: tag.width });
    for (const item of task.checklist) {
      const rule = ITEM_RULES.find((candidate) => candidate.test.test(item.text));
      if (!rule) {
        plan.unmatched.push({ task_title: task.title, text: item.text, reason: "no rule matched" });
        continue;
      }
      plan.rule_hits[rule.name] += 1;
      if (rule.type === null) {
        plan.no_unit_items.push({ item_id: item.id, task_title: task.title, text: item.text, rule: rule.name });
        continue;
      }
      const units = rule.units === "n" ? Number(rule.test.exec(item.text)?.[1]) : tag.width;
      plan.item_tags.push({ item_id: item.id, task_id: task.id, text: item.text, unit_count: units, work_type: rule.type, rule: rule.name });
      unitsByItem.set(item.id, { units, type: rule.type });
    }
  }
  plan.rules_without_hits = Object.entries(plan.rule_hits).filter(([, hits]) => hits === 0).map(([name]) => name);
  if (plan.rule_hits["Chain N → chain, N"] > 0 && !plan.item_tags.some((tag) => tag.work_type === "chain" && tag.unit_count === 196)) {
    plan.warnings.push("the body's foundation chain (Chain 196) was not tagged");
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  const byTitle = (prefix: RegExp) => snapshot.tasks.find((task) => prefix.test(task.title));
  const step2 = byTitle(/^step 2:/i);
  const step3 = byTitle(/^step 3:/i);
  if (!step2 || !step3) {
    plan.warnings.push("couldn't find Step 2 / Step 3 for the Oct 3 session");
  } else {
    const step3Rows = matchRows([7, 8, 9], step3.checklist.map((item) => ({ ...item, task_id: step3.id })));
    if (step3Rows.missing.length || step3Rows.ambiguous.length) plan.warnings.push(`Oct 3: step 3 rows 7–9 not all found (${step3Rows.missing.join(", ")})`);
    const step2Units = step2.checklist.filter((item) => unitsByItem.has(item.id)).map((item) => item.id);
    plan.sessions.push({
      source_ref: OCT3_SOURCE_REF,
      task_id: null,
      session_date: "2026-10-03",
      started_at: null,
      ended_at: null,
      minutes: 300,
      exclude_from_stats: true,
      exclude_reason: "learning",
      note: "About 5 hours across step 1 (warm-up), step 2 (swatch rows 1–6) and step 3 rows 7–9; no per-task split (Brent 10/4)",
      item_ids: [...step2Units, ...step3Rows.item_ids],
      origin: "Brent in chat 10/4",
      already_stored: existingRefs.has(OCT3_SOURCE_REF),
    });
  }

  for (const task of snapshot.tasks) {
    for (const comment of task.comments ?? []) {
      const parsed = parseTimelogComment(comment.content) ?? parseSessionComment(comment.content, comment.created_at);
      if (parsed === null) continue;
      if ("error" in parsed) {
        plan.unmatched.push({ task_title: task.title, text: comment.content, reason: parsed.error });
        continue;
      }
      const match = matchRows(parsed.rows, task.checklist.map((item) => ({ ...item, task_id: task.id })));
      if (match.missing.length || match.ambiguous.length) {
        plan.unmatched.push({
          task_title: task.title,
          text: comment.content,
          reason: `rows not matched: missing ${match.missing.join(", ") || "none"}; ambiguous ${match.ambiguous.map((entry) => entry.row).join(", ") || "none"}`,
        });
        continue;
      }
      const startedAt = parsed.start !== null ? etLocalToUtcIso(parsed.date, parsed.start) : null;
      const endedAt = parsed.end !== null ? etLocalToUtcIso(parsed.date, parsed.end) : null;
      const span = startedAt && endedAt ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60000) : null;
      const minutes = parsed.minutes ?? span;
      if (!minutes || minutes < 1) {
        plan.unmatched.push({ task_title: task.title, text: comment.content, reason: "no minutes and no start–end" });
        continue;
      }
      if (span !== null && parsed.minutes !== null && Math.abs(span - parsed.minutes) > 1) {
        plan.warnings.push(`comment ${comment.id}: minutes=${parsed.minutes} but start–end is ${span} min (using minutes)`);
      }
      const taggedUnits = match.item_ids.reduce((sum, id) => sum + (unitsByItem.get(id)?.units ?? 0), 0);
      if (parsed.stitches !== null && parsed.stitches !== taggedUnits) {
        plan.warnings.push(`comment ${comment.id}: stitches=${parsed.stitches} but its rows are tagged ${taggedUnits}`);
      }
      const types = new Set(match.item_ids.map((id) => unitsByItem.get(id)?.type).filter(Boolean));
      if (parsed.workType && types.size > 0 && !(types.size === 1 && types.has(parsed.workType))) {
        plan.warnings.push(`comment ${comment.id}: type=${parsed.workType} but its rows are tagged ${[...types].join(", ")}`);
      }
      for (const flag of parsed.flags) plan.warnings.push(`comment ${comment.id}: ${flag}`);
      for (const id of match.item_ids) {
        const item = task.checklist.find((candidate) => candidate.id === id);
        if (item && !item.is_done) plan.warnings.push(`comment ${comment.id}: row "${item.text}" is linked but not ticked (left as is)`);
      }
      plan.sessions.push({
        source_ref: comment.id,
        task_id: task.id,
        session_date: parsed.date,
        started_at: startedAt,
        ended_at: endedAt,
        minutes,
        exclude_from_stats: parsed.exclude,
        exclude_reason: parsed.excludeReason,
        note: [parsed.note, `(backfilled from comment ${comment.id})`].filter(Boolean).join(" "),
        item_ids: match.item_ids,
        origin: /^TIMELOG/i.test(comment.content.trim()) ? "TIMELOG comment" : "Session comment",
        already_stored: existingRefs.has(comment.id),
      });
    }
  }

  // Done linked rows with no completed_at get the session's end (or 23:59 ET that day).
  const itemById = new Map(snapshot.tasks.flatMap((task) => task.checklist.map((item) => [item.id, item] as const)));
  const seen = new Set<string>();
  for (const session of plan.sessions) {
    for (const id of session.item_ids) {
      const item = itemById.get(id);
      if (!item || !item.is_done || item.completed_at || seen.has(id)) continue;
      seen.add(id);
      plan.completed_at_updates.push({ item_id: id, completed_at: session.ended_at ?? etEndOfDayIso(session.session_date), via: session.source_ref });
    }
  }
  return plan;
}

/** The pace input the project would have after the plan is applied (for the dry-run forecast). */
export function paceInputAfterPlan(snapshot: BackfillSnapshot, plan: BackfillPlan, today: string): PaceInput {
  const taskUpdate = new Map(plan.task_updates.map((update) => [update.task_id, update]));
  const itemTag = new Map(plan.item_tags.map((tag) => [tag.item_id, tag]));
  return {
    project: { unit_label: plan.project.unit_label, target_date: snapshot.project.target_date, pace_settings: plan.project.pace_settings },
    sections: snapshot.sections.map((section) => ({ id: section.id, planned_start: section.planned_start })),
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      estimated_minutes: task.estimated_minutes,
      unit_count: taskUpdate.get(task.id)?.unit_count ?? null,
      work_type: taskUpdate.get(task.id)?.work_type ?? null,
      is_sample: taskUpdate.get(task.id)?.is_sample ?? false,
      section_id: task.section_id,
    })),
    items: snapshot.tasks.flatMap((task) =>
      task.checklist.map((item) => ({
        id: item.id,
        task_id: task.id,
        is_done: item.is_done,
        unit_count: itemTag.get(item.id)?.unit_count ?? null,
        work_type: itemTag.get(item.id)?.work_type ?? null,
      }))
    ),
    sessions: plan.sessions.map((session) => ({
      id: session.source_ref,
      task_id: session.task_id,
      session_date: session.session_date,
      started_at: session.started_at,
      ended_at: session.ended_at,
      minutes: session.minutes,
      exclude_from_stats: session.exclude_from_stats,
      item_ids: session.item_ids,
      extra_units: null,
      extra_work_type: null,
    })),
    today,
  };
}

// ── Database read + apply ───────────────────────────────────────────────────

export async function readBackfillSnapshot(supabase: SupabaseClient, projectId: string): Promise<BackfillSnapshot & { user_id: string }> {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, user_id, name, target_date, unit_label, pace_settings")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) throw new Error(`project ${projectId} not found`);
  const userId = (project as { user_id: string }).user_id;
  const [sections, tasks, sessions] = await Promise.all([
    supabase.from("project_sections").select("id, name, planned_start, planned_end").eq("user_id", userId).eq("project_id", projectId),
    supabase
      .from("tasks")
      .select("id, title, status, section_id, estimated_minutes")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("is_recurring_template", false),
    supabase.from("work_sessions").select("source_ref").eq("user_id", userId).eq("project_id", projectId).not("source_ref", "is", null),
  ]);
  for (const result of [sections, tasks, sessions]) if (result.error) throw result.error;
  const taskRows = (tasks.data ?? []) as Array<Omit<BackfillTask, "checklist" | "comments">>;
  const ids = taskRows.map((task) => task.id);
  const [items, comments] = ids.length
    ? await Promise.all([
        supabase
          .from("task_checklist_items")
          .select("id, task_id, text, is_done, sort_order, unit_count, work_type, completed_at")
          .eq("user_id", userId)
          .in("task_id", ids)
          .order("sort_order", { ascending: true }),
        supabase.from("task_comments").select("id, task_id, content, created_at").eq("user_id", userId).in("task_id", ids).order("created_at"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (items.error) throw items.error;
  if (comments.error) throw comments.error;
  const sectionName = new Map(((sections.data ?? []) as Array<{ id: string; name: string }>).map((section) => [section.id, section.name]));
  return {
    user_id: userId,
    project: project as BackfillSnapshot["project"],
    sections: (sections.data ?? []) as BackfillSnapshot["sections"],
    tasks: taskRows.map((task) => ({
      ...task,
      section_name: sectionName.get(task.section_id ?? "") ?? null,
      checklist: ((items.data ?? []) as Array<BackfillItem & { task_id: string }>).filter((item) => item.task_id === task.id),
      comments: ((comments.data ?? []) as Array<BackfillComment & { task_id: string }>).filter((comment) => comment.task_id === task.id),
    })),
    existing_source_refs: ((sessions.data ?? []) as Array<{ source_ref: string }>).map((row) => row.source_ref),
  };
}

export interface ApplyResult {
  project_updated: boolean;
  tasks_updated: number;
  items_tagged: number;
  sessions_created: number;
  sessions_skipped: number;
  links_created: number;
  completed_at_set: number;
}

/** Writes the plan. Safe to re-run: values are set (not added), sessions are skipped by source_ref. */
export async function applyBackfillPlan(supabase: SupabaseClient, userId: string, plan: BackfillPlan): Promise<ApplyResult> {
  const result: ApplyResult = {
    project_updated: false, tasks_updated: 0, items_tagged: 0, sessions_created: 0, sessions_skipped: 0, links_created: 0, completed_at_set: 0,
  };
  const check = (error: unknown) => {
    if (error) throw error;
  };

  const { error: projectError } = await supabase
    .from("projects")
    .update({ unit_label: plan.project.unit_label, pace_settings: plan.project.pace_settings as never })
    .eq("id", plan.project.id)
    .eq("user_id", userId);
  check(projectError);
  result.project_updated = true;

  for (const update of plan.task_updates) {
    const { error } = await supabase
      .from("tasks")
      .update({ is_sample: update.is_sample, unit_count: update.unit_count, work_type: update.work_type })
      .eq("id", update.task_id)
      .eq("user_id", userId)
      .eq("project_id", plan.project.id);
    check(error);
    result.tasks_updated += 1;
  }

  for (const tag of plan.item_tags) {
    const { error } = await supabase
      .from("task_checklist_items")
      .update({ unit_count: tag.unit_count, work_type: tag.work_type })
      .eq("id", tag.item_id)
      .eq("user_id", userId);
    check(error);
    result.items_tagged += 1;
  }

  for (const session of plan.sessions) {
    const { data: existing, error: lookupError } = await supabase
      .from("work_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("source_ref", session.source_ref)
      .maybeSingle();
    check(lookupError);
    if (existing) {
      result.sessions_skipped += 1;
      continue;
    }
    // One RPC per session: the session and its links commit together (no ticks: rows keep their state).
    const { error } = await supabase.rpc("work_session_create", {
      p_user_id: userId,
      p_session: {
        project_id: plan.project.id,
        task_id: session.task_id,
        session_date: session.session_date,
        started_at: session.started_at,
        ended_at: session.ended_at,
        minutes: session.minutes,
        exclude_from_stats: session.exclude_from_stats,
        exclude_reason: session.exclude_reason,
        note: session.note,
        source: "backfill",
        source_ref: session.source_ref,
      },
      p_item_ids: session.item_ids,
      p_mark_done: false,
    });
    check(error);
    result.links_created += session.item_ids.length;
    result.sessions_created += 1;
  }

  for (const update of plan.completed_at_updates) {
    const { data, error } = await supabase
      .from("task_checklist_items")
      .update({ completed_at: update.completed_at })
      .eq("id", update.item_id)
      .eq("user_id", userId)
      .eq("is_done", true)
      .is("completed_at", null)
      .select("id");
    check(error);
    result.completed_at_set += (data ?? []).length;
  }
  return result;
}
