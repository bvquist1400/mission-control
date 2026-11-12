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
  sections: { id: string; sort_order: number; created_at: string | null }[];
  tasks: { id: string; section_id: string | null; title: string; is_sample: boolean; created_at: string }[];
  /** unit_count is the database's numeric text (read as unit_count::text), canonical as canonicalUnitText() makes it. */
  items: { id: string; task_id: string; text: string; is_done: boolean; sort_order: number; unit_count: string | null; craft_part_id: string | null }[];
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
}
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

/** The project page's order: sections by sort_order then creation, tasks by creation then id, unsectioned last. */
export function orderSetupTasks(snapshot: Pick<SetupSnapshot, "sections" | "tasks">) {
  const sections = [...snapshot.sections].sort((a, b) => a.sort_order - b.sort_order
    || (a.created_at ?? "").localeCompare(b.created_at ?? "") || byId(a, b));
  const taskOrder = (a: SetupSnapshot["tasks"][number], b: SetupSnapshot["tasks"][number]) => {
    const at = msOf(a.created_at), bt = msOf(b.created_at);
    if (at !== null && bt !== null && at !== bt) return at - bt;
    if (at !== null && bt === null) return -1;
    if (at === null && bt !== null) return 1;
    return a.id.localeCompare(b.id);
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

export function planCraftSetup(snapshot: SetupSnapshot): CraftSetupPlan {
  const stops: string[] = [];
  const stop = (reason: string) => { if (!stops.includes(reason)) stops.push(reason); };
  const tasks = orderSetupTasks(snapshot);
  const itemsByTask = new Map<string, SetupSnapshot["items"]>();
  for (const item of [...snapshot.items].sort((a, b) => a.sort_order - b.sort_order || byId(a, b))) {
    const list = itemsByTask.get(item.task_id) ?? [];
    list.push(item);
    itemsByTask.set(item.task_id, list);
  }
  if (snapshot.on_craft_screen) stop("This project is already on the craft screen. Use Remove from craft screen there first if you want to set it up again.");

  type Building = PlannedPart & { section_id: string | null; stitches: (string | null)[] };
  const parts: Building[] = [];
  const plain_items: PlainItem[] = [];
  const near_misses: NearMiss[] = [];
  const linked = snapshot.items.filter((item) => item.craft_part_id !== null);
  if (linked.length) {
    const first = linked[0], task = snapshot.tasks.find((t) => t.id === first.task_id);
    stop(`${linked.length === 1 ? "One checklist item is" : `${fmt(linked.length)} checklist items are`} already linked to a craft part (for example ${quote(first.text)} on ${quote(task?.title ?? "a task")}).`);
  }

  for (const task of tasks) {
    const items = itemsByTask.get(task.id) ?? [];
    const rowItems: { item: SetupSnapshot["items"][number]; word: RowWord; label: string; row: number }[] = [];
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
    const words = new Set(rowItems.map((entry) => entry.word));
    if (words.size > 1) {
      stop(`${quote(task.title)} mixes “Row” items with “Rnd”/“Round” items; use one word for the whole task and fix it in the app first.`);
      continue;
    }
    const word = rowItems[0].word;
    const seen = new Map<number, number>();
    for (const entry of rowItems) seen.set(entry.row, (seen.get(entry.row) ?? 0) + 1);
    const repeats = [...seen].filter(([, count]) => count > 1).map(([row]) => row).sort((a, b) => a - b);
    const numbers = rowItems.map((entry) => entry.row);
    const lowest = Math.min(...numbers), highest = Math.max(...numbers);
    const previous = parts.at(-1);
    const continues = previous && previous.section_id === task.section_id && previous.row_word === word && lowest === previous.total_rows + 1;
    const part: Building = continues ? previous : {
      name: "", row_word: word, total_rows: 0, row_count: 0, done_count: 0, current_row: null, stitch_count: null,
      sort_order: parts.length, segments: [], rows: [], gaps: [], gap_notes: [], section_id: task.section_id, stitches: [],
    };
    if (!continues) parts.push(part);
    part.name = partNameFromTitle(task.title);
    if (repeats.length) {
      stop(`${wordFor(word)} ${repeats.slice(0, 3).join(", ")}${repeats.length > 3 ? "…" : ""} ${repeats.length === 1 ? "is" : "are"} listed twice on ${quote(part.name)}; fix it in the app first.`);
    }
    part.segments.push({ task_id: task.id, name: clipName(task.title), from_row: lowest, to_row: highest, sort_order: part.segments.length, row_count: rowItems.length });
    part.total_rows = Math.max(part.total_rows, highest);
    for (const entry of rowItems) {
      part.rows.push({ item_id: entry.item.id, row: entry.row, is_done: entry.item.is_done, text: entry.item.text });
      part.stitches.push(canonicalUnitText(entry.item.unit_count));
    }
  }

  if (!parts.length && !snapshot.on_craft_screen) stop("No checklist item starts with “Row N”, “Rnd N” or “Round N”, so there is nothing to count yet.");

  const finished = parts.map(({ section_id: _section, stitches, ...part }) => {
    void _section;
    part.rows.sort((a, b) => a.row - b.row);
    if (part.total_rows > CRAFT_SETUP_MAX_ROWS) stop(`${quote(part.name)} goes up to ${part.row_word} ${fmt(part.total_rows)}; one part can hold at most ${fmt(CRAFT_SETUP_MAX_ROWS)}.`);
    part.row_count = part.rows.length;
    part.done_count = part.rows.filter((row) => row.is_done).length;
    part.current_row = part.rows.find((row) => !row.is_done)?.row ?? null;
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
  };
}

/** What Create sends to craft_setup_project (072): the plan with Brent's names and craft kind. */
export interface CraftSetupPayload {
  craft: CraftKind;
  active_part_index: number | null;
  parts: { name: string; row_word: RowWord; total_rows: number; stitch_count: number | null; sort_order: number;
    segments: { task_id: string; name: string; from_row: number; to_row: number; sort_order: number }[];
    rows: { item_id: string; row: number }[] }[];
}
export function craftSetupPayload(plan: CraftSetupPlan, craft: CraftKind, names: string[]): CraftSetupPayload {
  return {
    craft,
    active_part_index: plan.active_part_index,
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
