/**
 * Craft S1C: what "Set up craft screen" would make for a project. Pure (no I/O, no crypto) so the
 * setup page, the routes and `test:craft` share one rule. Nothing here guesses: anything ambiguous
 * is a STOP with a plain reason, and the preview shows exactly what Create writes.
 */

export const CRAFT_SETUP_MAX_ROWS = 2000;
export const CRAFT_NAME_MAX = 80;
export type CraftKind = "knit" | "crochet" | "other";
export type RowWord = "row" | "round";

export interface SetupSnapshot {
  project: { id: string; name: string; tags: string[] | null };
  /** The project already has a craft_projects row. */
  on_craft_screen: boolean;
  /** name: S4 default part names come from the section name ("1. Scarf" → "Scarf"). */
  sections: { id: string; sort_order: number; created_at: string | null; name?: string | null }[];
  /** unit_count / work_type: S4 stitch counts (H) check a task's rows against the task's own unit_count. */
  tasks: { id: string; section_id: string | null; title: string; is_sample: boolean; created_at: string; unit_count?: string | null; work_type?: string | null }[];
  /** unit_count is the database's numeric text (read as unit_count::text), canonical as canonicalUnitText() makes it. */
  items: { id: string; task_id: string; text: string; is_done: boolean; sort_order: number; unit_count: string | null; craft_part_id: string | null; work_type?: string | null }[];
}

export interface PlannedRow { item_id: string; row: number; is_done: boolean; text: string }
export interface PlannedSegment { task_id: string; name: string; from_row: number; to_row: number; sort_order: number; row_count: number }
export interface PlannedPart {
  name: string;
  row_word: RowWord;
  total_rows: number;
  /** Rows that exist (gaps are allowed, so this can be below total_rows). */
  row_count: number;
  done_count: number;
  /** Lowest unticked existing row; null when every row is ticked. */
  current_row: number | null;
  stitch_count: number | null;
  sort_order: number;
  segments: PlannedSegment[];
  rows: PlannedRow[];
  /** Missing row numbers inside 1..total_rows, as inclusive ranges. */
  gaps: [number, number][];
  gap_notes: string[];
  /** S4 (C): "labels" = the screen's row numbers are the pattern's; "straight" = the labels restart inside the part, so rows are counted 1, 2, 3 … in task order. */
  numbering: "labels" | "straight";
  /** S4 (H): what the stitch-count step fills on this part's tasks. */
  stitches: PartStitchPlan;
}
/** S4 (H): per part, the rows (and cast-ons) that get a stitch count, the stitches in all, and the tasks left alone. */
export interface PartStitchPlan {
  rows_filled: number;
  cast_ons_filled: number;
  /** Every row and cast-on of the part with a count after the fill (counts already there included). */
  total_stitches: number;
  skipped: { task_id: string; task_title: string; reason: string }[];
}
/** One write of the stitch-count step: only items whose unit_count is empty; work_type only for a cast-on with none. */
export interface StitchFill { item_id: string; unit_count: number; work_type: string | null }
export interface PlainItem { id: string; task_id: string; task_title: string; text: string; is_done: boolean; swatch: boolean }
/** A plain step that looks like a numbered row but doesn't match the rule (" Rnd 16", "rnd 31", "Rnd16"). */
export interface NearMiss { id: string; task_id: string; task_title: string; text: string }
export interface CraftSetupPlan {
  project: { id: string; name: string };
  ok: boolean;
  stops: string[];
  parts: PlannedPart[];
  plain_items: PlainItem[];
  /** Listed on the preview under "Not counted as rounds/rows" so they can be fixed before Create; never a STOP. */
  near_misses: NearMiss[];
  /** Index into parts of the first part with an unticked row (null when all are ticked or there are none). */
  active_part_index: number | null;
  default_craft: CraftKind;
  /** S4 (H): every stitch-count write Create (or Reset) makes, in item order. */
  stitch_fills: StitchFill[];
}

/*
 * The row rule, shared word for word with migration 072 (craft_setup_plan) so the preview and the
 * database never disagree (FR1, F3): "Row", "Rnd" or "Round" as written, one or more spaces or tabs,
 * ASCII digits, then a character that is not [0-9A-Za-z_] (or the end). NBSP, U+FEFF and other
 * separators are not a row (they show up as near-misses instead).
 */
const ROW_LABEL = /^(Row|Rnd|Round)[ \t]+([0-9]+)(?![0-9A-Za-z_])/;
/** JavaScript's \s, written out so 072 can use the same class (PostgreSQL's \s differs by locale). */
export const CRAFT_WHITESPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
// A number followed by a dash, "to", "and", a comma or a decimal is a range or a fraction: never a single row.
const RANGE_AFTER = new RegExp(`^(?:[${CRAFT_WHITESPACE}]*(?:[-‐‑‒–—―−~/&,+]|(?:to|through|thru|and)(?![0-9A-Za-z_]))[${CRAFT_WHITESPACE}]*[0-9]|\\.[0-9])`, "i");
/** The project page's "Set up craft screen" check (a PostgREST `match`, PostgreSQL regex): the same rule. */
export const CRAFT_ROW_ITEM_MATCH = "^(Row|Rnd|Round)[ \\t]+[0-9]+([^0-9A-Za-z_]|$)";
// Looks numbered once leading blanks and invisible characters are dropped, in any case, with up to three
// non-alphanumeric characters (or none) before the number: listed, never counted.
const NEAR_MISS = /^(?:row|rnd|round)s?[^0-9A-Za-z]{0,3}[0-9]/i;
const LEADING_BLANKS = new RegExp(`^[${CRAFT_WHITESPACE}\\u200b-\\u200d\\u2060]+`);

/** unit_count as PostgreSQL's trim_scale(numeric)::text: "36.0" → "36", "36.500" → "36.5"; never exponent form. */
export function canonicalUnitText(text: string | null): string | null {
  if (text === null) return null;
  const value = text.trim();
  return /^-?[0-9]+\.[0-9]*$/.test(value) ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
/** A stitch count is a whole number the integer column can hold. */
function stitchCountOf(text: string | null | undefined): number | null {
  if (text === null || text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) return null;
  const n = Number(text);
  return n <= 2147483647 ? n : null;
}

export type RowParse = { kind: "row"; word: RowWord; label: string; row: number } | { kind: "plain" } | { kind: "bad"; reason: "range" | "zero" | "too_big" };

/** "Rnd 15 (est.) · knit" → round 15. Case as written; an optional "(est.)" after the number is fine. */
export function parseRowLabel(text: string): RowParse {
  const match = ROW_LABEL.exec(text);
  if (!match) return { kind: "plain" };
  const rest = text.slice(match[0].length);
  if (RANGE_AFTER.test(rest)) return { kind: "bad", reason: "range" };
  const row = Number(match[2]);
  if (row === 0) return { kind: "bad", reason: "zero" };
  if (!Number.isSafeInteger(row) || row > 1_000_000) return { kind: "bad", reason: "too_big" };
  return { kind: "row", word: match[1] === "Row" ? "row" : "round", label: match[1], row };
}

/** Trim to a column limit by characters (code points), as Postgres char_length counts them. */
export function clipName(text: string, max = CRAFT_NAME_MAX): string {
  const chars = Array.from(text.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("").trimEnd();
}

/** "Mitten 1 · Cuff: cast on + rnds 1–31" → "Mitten 1 · Cuff"; titles without " · " are used whole. */
export function partNameFromTitle(title: string): string {
  const at = title.indexOf(" · ");
  if (at < 0) return clipName(title);
  const after = title.slice(at + 3);
  const colon = after.indexOf(":");
  const stage = (colon < 0 ? after : after.slice(0, colon)).trim();
  return clipName(stage ? `${title.slice(0, at).trim()} · ${stage}` : title);
}

const msOf = (iso: string | null) => { const t = iso === null ? NaN : Date.parse(iso); return Number.isFinite(t) ? t : null; };
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The project page's order: sections by sort_order, then creation in whole milliseconds (none first), then id; tasks by
 * creation in whole milliseconds, then id; unsectioned last. 073's craft_setup_plan sorts by exactly these keys (S1C
 * re-check: comparing the timestamps as text put "…:00+00:00" after "…:00.5+00:00" with localeCompare, unlike SQL).
 */
export function orderSetupTasks(snapshot: Pick<SetupSnapshot, "sections" | "tasks">) {
  const sections = [...snapshot.sections].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    const at = msOf(a.created_at), bt = msOf(b.created_at);
    if (at === null && bt !== null) return -1;
    if (at !== null && bt === null) return 1;
    if (at !== null && bt !== null && at !== bt) return at - bt;
    return byId(a, b);
  });
  const taskOrder = (a: SetupSnapshot["tasks"][number], b: SetupSnapshot["tasks"][number]) => {
    const at = msOf(a.created_at), bt = msOf(b.created_at);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    if (at !== null && bt === null) return -1;
    if (at === null && bt !== null) return 1;
    return byId(a, b);
  };
  const known = new Set(sections.map((section) => section.id));
  return [
    ...sections.flatMap((section) => snapshot.tasks.filter((task) => task.section_id === section.id).sort(taskOrder)),
    ...snapshot.tasks.filter((task) => task.section_id === null || !known.has(task.section_id)).sort(taskOrder),
  ];
}

const wordFor = (word: RowWord, plural = false) => (word === "round" ? (plural ? "Rounds" : "Round") : plural ? "Rows" : "Row");
const quote = (text: string) => `“${clipName(text.replace(/\s+/g, " "), 60)}”`;
const fmt = (n: number) => n.toLocaleString("en-US");

function gapsOf(numbers: number[], total: number): [number, number][] {
  const have = new Set(numbers), gaps: [number, number][] = [];
  for (let n = 1; n <= total; n++) {
    if (have.has(n)) continue;
    const start = n;
    while (n + 1 <= total && !have.has(n + 1)) n++;
    gaps.push([start, n]);
  }
  return gaps;
}

export function gapNote(word: RowWord, [from, to]: [number, number]): string {
  const what = from === to ? `${wordFor(word)} ${from} is` : `${wordFor(word, true)} ${from}–${to} are`;
  return from === 1 ? `${what} not in the list; the screen starts at ${to + 1}.` : `${what} not in the list; the screen goes from ${from - 1} to ${to + 1}.`;
}

export function defaultCraftKind(tags: string[] | null): CraftKind {
  const lower = (tags ?? []).map((tag) => tag.toLowerCase());
  if (lower.includes("knitting")) return "knit";
  if (lower.includes("crochet")) return "crochet";
  return "other";
}

/** S4 (D): "1. Scarf" → "Scarf", "2) Hood" → "Hood"; no section (or nothing left) → "Body". Never a task title. */
export function partNameFromSection(name: string | null | undefined): string {
  // FR1 N3: only a list number "N. " / "N) " (digits, a dot or paren, then a space); "2026 plan" and "1.5 Body" stay whole.
  const stripped = (name ?? "").replace(LEADING_BLANKS, "").replace(/^[0-9]+[.)][ \t]+/, "").trim();
  return stripped ? clipName(stripped) : "Body";
}

type RowEntry = { item: SetupSnapshot["items"][number]; word: RowWord; label: string; row: number };
type TaskEntry = { task: SetupSnapshot["tasks"][number]; word: RowWord; rows: RowEntry[]; lo: number; hi: number; distinct: boolean };

/** Every label distinct and, in task order, each task starts after the one before ends: the numbers run on. */
function numbersRunOn(entries: TaskEntry[]): boolean {
  const seen = new Set<number>();
  for (const entry of entries) for (const row of entry.rows) { if (seen.has(row.row)) return false; seen.add(row.row); }
  return entries.every((entry, i) => i === 0 || entry.lo > entries[i - 1].hi);
}

/**
 * S4 (C, picks 1 and 2): one part per section (and per run of one row word inside it); a part never crosses a
 * section. Inside a section the tasks go by their first row number when the numbers run on (the scarf's "Rows
 * 201–300" made before "Rows 1–100"), else in the project page's order. A part whose labels run on keeps them as
 * its row numbers (gaps allowed); a part whose labels restart (Sophie Hood's "Row 1 (rep 2)") is counted straight
 * through, 1, 2, 3 … in task order then checklist order, and each row keeps its pattern text. A cast-on or any
 * other unnumbered item stays a plain step, so it is a step before Row 1 on the screen. migration 075's
 * craft_plan_core() is the same rule in SQL (test:craft-db pins the two).
 */
export function planCraftSetup(snapshot: SetupSnapshot, options: { reset?: boolean } = {}): CraftSetupPlan {
  const stops: string[] = [];
  const stop = (reason: string) => { if (!stops.includes(reason)) stops.push(reason); };
  const tasks = orderSetupTasks(snapshot);
  const itemsByTask = new Map<string, SetupSnapshot["items"]>();
  for (const item of [...snapshot.items].sort((a, b) => a.sort_order - b.sort_order || byId(a, b))) {
    const list = itemsByTask.get(item.task_id) ?? [];
    list.push(item);
    itemsByTask.set(item.task_id, list);
  }
  if (snapshot.on_craft_screen && !options.reset) stop("This project is already on the craft screen. Use Reset craft screen there if you want to set it up again.");

  const plain_items: PlainItem[] = [];
  const near_misses: NearMiss[] = [];
  const linked = options.reset ? [] : snapshot.items.filter((item) => item.craft_part_id !== null);
  if (linked.length) {
    const first = linked[0], task = snapshot.tasks.find((t) => t.id === first.task_id);
    stop(`${linked.length === 1 ? "One checklist item is" : `${fmt(linked.length)} checklist items are`} already linked to a craft part (for example ${quote(first.text)} on ${quote(task?.title ?? "a task")}).`);
  }

  // Section groups in the project page's order (orderSetupTasks already sorted them); unsectioned last.
  const known = new Set(snapshot.sections.map((section) => section.id));
  const groupOf = (task: SetupSnapshot["tasks"][number]) => (task.section_id !== null && known.has(task.section_id) ? task.section_id : null);
  const groups: { section_id: string | null; entries: TaskEntry[] }[] = [];
  for (const task of tasks) {
    const items = itemsByTask.get(task.id) ?? [];
    const rowItems: RowEntry[] = [];
    for (const item of items) {
      const parsed = task.is_sample ? { kind: "plain" as const } : parseRowLabel(item.text);
      if (parsed.kind === "row") { rowItems.push({ item, word: parsed.word, label: parsed.label, row: parsed.row }); continue; }
      if (parsed.kind === "bad") {
        stop(parsed.reason === "range"
          ? `${quote(item.text)} on ${quote(task.title)} looks like a range of rows; give each one its own checklist item in the app first.`
          : parsed.reason === "zero"
            ? `${quote(item.text)} on ${quote(task.title)} is numbered 0; rows and rounds start at 1. Fix it in the app first.`
            : `${quote(item.text)} on ${quote(task.title)} has a row number that is too big.`);
      }
      plain_items.push({ id: item.id, task_id: task.id, task_title: task.title, text: item.text, is_done: item.is_done, swatch: task.is_sample });
      if (parsed.kind === "plain" && !task.is_sample && NEAR_MISS.test(item.text.replace(LEADING_BLANKS, ""))) {
        near_misses.push({ id: item.id, task_id: task.id, task_title: task.title, text: item.text });
      }
    }
    if (!rowItems.length) continue;
    if (new Set(rowItems.map((entry) => entry.word)).size > 1) {
      stop(`${quote(task.title)} mixes “Row” items with “Rnd”/“Round” items; use one word for the whole task and fix it in the app first.`);
      continue;
    }
    const numbers = rowItems.map((entry) => entry.row);
    const section_id = groupOf(task);
    let group = groups.at(-1);
    if (!group || group.section_id !== section_id) { group = { section_id, entries: [] }; groups.push(group); }
    group.entries.push({ task, word: rowItems[0].word, rows: rowItems, lo: Math.min(...numbers), hi: Math.max(...numbers), distinct: new Set(numbers).size === numbers.length });
  }

  const sectionName = new Map(snapshot.sections.map((section) => [section.id, section.name ?? null]));
  const parts: (PlannedPart & { tasks: TaskEntry[] })[] = [];
  for (const group of groups) {
    const byLabel = [...group.entries].sort((a, b) => a.lo - b.lo || taskCreatedOrder(a.task, b.task));
    const ordered = group.entries.every((entry) => entry.distinct) && numbersRunOn(byLabel) ? byLabel : group.entries;
    const runs: TaskEntry[][] = [];
    for (const entry of ordered) {
      const run = runs.at(-1);
      if (run && run[0].word === entry.word) run.push(entry); else runs.push([entry]);
    }
    const base = group.section_id === null ? "Body" : partNameFromSection(sectionName.get(group.section_id));
    runs.forEach((run, k) => {
      const numbering = numbersRunOn(run) ? "labels" as const : "straight" as const;
      const rows: PlannedRow[] = [];
      const segments: PlannedSegment[] = [];
      let position = 0;
      for (const entry of run) {
        const taskRows = entry.rows.map((row) => ({ item_id: row.item.id, row: numbering === "labels" ? row.row : ++position, is_done: row.item.is_done, text: row.item.text }));
        rows.push(...taskRows);
        const numbersHere = taskRows.map((row) => row.row);
        segments.push({ task_id: entry.task.id, name: clipName(entry.task.title), from_row: Math.min(...numbersHere), to_row: Math.max(...numbersHere), sort_order: segments.length, row_count: taskRows.length });
      }
      rows.sort((a, b) => a.row - b.row);
      parts.push({
        name: runs.length > 1 && k > 0 ? clipName(`${base} ${k + 1}`) : base,
        row_word: run[0].word, total_rows: Math.max(...rows.map((row) => row.row)), row_count: rows.length, done_count: 0,
        current_row: null, stitch_count: null, sort_order: parts.length, segments, rows, gaps: [], gap_notes: [], numbering,
        stitches: { rows_filled: 0, cast_ons_filled: 0, total_stitches: 0, skipped: [] }, tasks: run,
      });
    });
  }

  if (!parts.length && (!snapshot.on_craft_screen || options.reset)) stop("No checklist item starts with “Row N”, “Rnd N” or “Round N”, so there is nothing to count yet.");

  const stitch_fills = planStitchCounts(parts, itemsByTask);
  const filled = new Map(stitch_fills.map((fill) => [fill.item_id, String(fill.unit_count)]));
  const unitOf = new Map(snapshot.items.map((item) => [item.id, canonicalUnitText(item.unit_count)]));
  const finished = parts.map(({ tasks: _tasks, ...part }) => {
    void _tasks;
    if (part.total_rows > CRAFT_SETUP_MAX_ROWS) stop(`${quote(part.name)} goes up to ${part.row_word} ${fmt(part.total_rows)}; one part can hold at most ${fmt(CRAFT_SETUP_MAX_ROWS)}.`);
    part.done_count = part.rows.filter((row) => row.is_done).length;
    part.current_row = part.rows.find((row) => !row.is_done)?.row ?? null;
    // The stitch count reads the rows as Create leaves them: counts already there, else the stitch-count step's.
    const stitches = part.rows.map((row) => unitOf.get(row.item_id) ?? filled.get(row.item_id) ?? null);
    const first = stitches[0];
    part.stitch_count = stitches.every((count) => count === first) ? stitchCountOf(first) : null;
    part.gaps = part.total_rows > CRAFT_SETUP_MAX_ROWS ? [] : gapsOf(part.rows.map((row) => row.row), part.total_rows);
    part.gap_notes = part.gaps.map((gap) => gapNote(part.row_word, gap));
    return part;
  });
  const active = finished.findIndex((part) => part.current_row !== null);
  return {
    project: { id: snapshot.project.id, name: snapshot.project.name },
    ok: stops.length === 0,
    stops,
    parts: finished,
    plain_items,
    near_misses,
    active_part_index: active < 0 ? null : active,
    default_craft: defaultCraftKind(snapshot.project.tags),
    stitch_fills: stops.length === 0 ? stitch_fills : [],
  };
}

const taskCreatedOrder = (a: SetupSnapshot["tasks"][number], b: SetupSnapshot["tasks"][number]) => {
  const at = msOf(a.created_at), bt = msOf(b.created_at);
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (at !== null && bt === null) return -1;
  if (at === null && bt !== null) return 1;
  return byId(a, b);
};

/*
 * S4 (H): stitch counts for rows that have none. unit_count = the stitches WORKED in that row = the count on the
 * needle before it: the previous row's "→ N", or N after "Cast on N" (the cast-on itself gets N, work type
 * "cast-on", the slug the mittens already use). A row that moves stitches to a holder ("3 sts to holder, k to last
 * 3 … → 42") works the count after it. A row with no "→ N" keeps the count it started with (a constant-width
 * task), but only in a task with its own unit_count to check the carried count against. The count carries from task to task and part to part in the screen's order. A task whose rows can't all
 * be counted (no count before a row) or whose rows don't add up to the task's own unit_count is left alone and
 * listed; never a partial fill, never a guess, never over a count already there. "Check: …" and other plain steps
 * get none. Create and Reset write these through migration 075, which re-checks every rule but the text reading.
 */
export const CAST_ON = /^[ \t]*cast[ \t]+on[ \t]+([0-9]{1,9})(?![0-9])/i;
const ARROW = /→[ \t]*([0-9]{1,9})(?![0-9])/g;
const TO_HOLDER = /\b(?:to|onto)[ \t]+(?:a[ \t]+|the[ \t]+)?(?:st(?:itch)?[ \t]+)?holders?\b/i;
export const CAST_ON_WORK_TYPE = "cast-on";

/** The last "→ N" in a row's text (the count after the row), else null. */
export function stitchesAfter(text: string): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(ARROW)) last = Number(match[1]);
  return last !== null && last > 0 ? last : null;
}
export const movesToHolder = (text: string) => TO_HOLDER.test(text);

function planStitchCounts(parts: { tasks: TaskEntry[]; stitches: PartStitchPlan; rows: PlannedRow[] }[], itemsByTask: Map<string, SetupSnapshot["items"]>): StitchFill[] {
  const fills: StitchFill[] = [];
  let needle: number | null = null;
  for (const part of parts) {
    for (const entry of part.tasks) {
      const rowIds = new Set(entry.rows.map((row) => row.item.id));
      const planned: { item: SetupSnapshot["items"][number]; worked: number | null; castOn: boolean }[] = [];
      let problem: string | null = null;
      for (const item of itemsByTask.get(entry.task.id) ?? []) {
        const castOn = rowIds.has(item.id) ? null : CAST_ON.exec(item.text);
        if (castOn) {
          const n = Number(castOn[1]);
          if (n > 0) { needle = n; planned.push({ item, worked: n, castOn: true }); }
          continue;
        }
        if (!rowIds.has(item.id)) continue;
        const after = stitchesAfter(item.text) ?? needle;
        const worked = movesToHolder(item.text) ? after : needle;
        if (worked === null && problem === null && item.unit_count === null) {
          problem = `${quote(item.text)} has no stitch count before it (no “→ N” on an earlier row and no cast-on), so this task is left without counts.`;
        }
        planned.push({ item, worked, castOn: false });
        needle = after;
      }
      const toFill = planned.filter((entry) => entry.item.unit_count === null);
      if (!toFill.length) continue;
      // A count carried over a row with no "→ N" is only trusted when the task's own total can check it.
      const hasTotal = entry.task.unit_count !== null && entry.task.unit_count !== undefined;
      if (problem === null && !hasTotal && planned.some((p) => !p.castOn && stitchesAfter(p.item.text) === null)) {
        problem = "Some rows have no “→ N” and the task has no stitch total to check the carried count against, so this task is left without counts.";
      }
      if (problem === null && entry.task.unit_count !== null && entry.task.unit_count !== undefined) {
        const items = itemsByTask.get(entry.task.id) ?? [];
        const newUnits = new Map(toFill.map((p) => [p.item.id, p.worked as number]));
        const sum = items.reduce((total, item) => total + (item.unit_count !== null ? Number(item.unit_count) : newUnits.get(item.id) ?? 0), 0);
        const want = Number(entry.task.unit_count);
        if (sum !== want) problem = `Its rows add up to ${fmt(sum)} stitches but the task says ${fmt(want)}, so this task is left without counts.`;
      }
      if (problem !== null) { part.stitches.skipped.push({ task_id: entry.task.id, task_title: entry.task.title, reason: problem }); continue; }
      for (const p of toFill) {
        fills.push({ item_id: p.item.id, unit_count: p.worked as number, work_type: p.castOn && !p.item.work_type ? CAST_ON_WORK_TYPE : null });
        if (p.castOn) part.stitches.cast_ons_filled++; else part.stitches.rows_filled++;
      }
    }
    const filledHere = new Map(fills.map((fill) => [fill.item_id, fill.unit_count]));
    part.stitches.total_stitches = part.tasks.reduce((total, entry) => total + (itemsByTask.get(entry.task.id) ?? [])
      .filter((item) => entry.rows.some((row) => row.item.id === item.id) || CAST_ON.test(item.text))
      .reduce((n, item) => n + (item.unit_count !== null ? Number(item.unit_count) : filledHere.get(item.id) ?? 0), 0), 0);
  }
  return fills;
}

/** What Create sends to craft_setup_project (072): the plan with Brent's names and craft kind. */
export interface CraftSetupPayload {
  craft: CraftKind;
  active_part_index: number | null;
  /** S4 (H): the stitch-count step's writes (075 re-checks them: empty counts only, task sums). */
  units: StitchFill[];
  parts: { name: string; row_word: RowWord; total_rows: number; stitch_count: number | null; sort_order: number;
    segments: { task_id: string; name: string; from_row: number; to_row: number; sort_order: number }[];
    rows: { item_id: string; row: number }[] }[];
}
export function craftSetupPayload(plan: CraftSetupPlan, craft: CraftKind, names: string[]): CraftSetupPayload {
  return {
    craft,
    active_part_index: plan.active_part_index,
    units: plan.stitch_fills,
    parts: plan.parts.map((part, index) => ({
      name: names[index] ?? part.name, row_word: part.row_word, total_rows: part.total_rows, stitch_count: part.stitch_count, sort_order: part.sort_order,
      segments: part.segments.map(({ task_id, name, from_row, to_row, sort_order }) => ({ task_id, name, from_row, to_row, sort_order })),
      rows: part.rows.map(({ item_id, row }) => ({ item_id, row })),
    })),
  };
}

export type CreateBody = { fingerprint: string; craft: CraftKind; names: string[] };
/** The Create body: the preview's fingerprint, a craft kind and one name per part (renamed or as shown). */
export function parseCreateBody(body: unknown, partCount: number): { ok: true; value: CreateBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const record = body as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !["fingerprint", "craft", "names"].includes(key));
  if (unknownKey) return { ok: false, error: `Unknown field: ${unknownKey}` };
  if (typeof record.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.fingerprint)) return { ok: false, error: "fingerprint is required" };
  if (record.craft !== "knit" && record.craft !== "crochet" && record.craft !== "other") return { ok: false, error: "craft must be knit, crochet or other" };
  if (!Array.isArray(record.names) || record.names.length !== partCount) return { ok: false, error: "names must list one name per part" };
  const names: string[] = [];
  for (const raw of record.names) {
    if (typeof raw !== "string") return { ok: false, error: "Each part name must be text" };
    if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: "Part names cannot contain control characters" };
    const name = raw.trim();
    if (!name) return { ok: false, error: "Each part needs a name" };
    if (Array.from(name).length > CRAFT_NAME_MAX) return { ok: false, error: `Part names can be at most ${CRAFT_NAME_MAX} characters` };
    names.push(name);
  }
  return { ok: true, value: { fingerprint: record.fingerprint, craft: record.craft, names } };
}

export const CRAFT_SETUP_CHANGED = "Something changed since the preview. Open it again.";
export const craftSetupHref = (projectId: string) => `/craft/setup/${projectId}`;
