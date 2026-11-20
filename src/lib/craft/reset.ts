/**
 * Craft S4 (B): "Reset craft screen" words and rules, pure (browser-safe). Reset unlinks the project's parts
 * and sets it up again with today's rules in one transaction (migration 075's craft_reset_project). Ticks stay
 * on the rows; sittings, notes, rip-backs, instructions, the timer, links and yarn are re-pointed to the same
 * rows (by item first, then by task + row number). 075's craft_reset_preview says where each one lands; this
 * module turns that into the preview's lists.
 */
import { CRAFT_NAME_MAX, type CraftSetupPlan } from "@/lib/craft/setup";

export type ResetCarryKind = "sitting" | "note" | "frog" | "instruction" | "timer" | "link" | "yarn";
/** One row of craft_reset_preview().carry: new_part null = can't be re-pointed. */
export interface ResetCarryRow {
  kind: ResetCarryKind;
  id: string | null;
  old_part_id: string | null;
  new_part: number | null;
  from_row: number | null;
  to_row: number | null;
  at_row: number | null;
  date?: string | null;
  old_from_row?: number | null;
  old_to_row?: number | null;
  text?: string | null;
}
export interface ResetOldPart { id: string; name: string; row_word: string; total_rows: number; row_count: number }
export interface ResetLost { kind: ResetCarryKind; id: string | null; text: string }
export interface ResetCarry {
  carried: Record<ResetCarryKind, number>;
  lost: ResetLost[];
}

const KINDS: ResetCarryKind[] = ["sitting", "note", "frog", "instruction", "timer", "link", "yarn"];
const WORDS: Record<ResetCarryKind, [string, string]> = {
  sitting: ["sitting", "sittings"], note: ["note", "notes"], frog: ["rip-back", "rip-backs"], instruction: ["instruction", "instructions"],
  timer: ["timer", "timers"], link: ["link", "links"], yarn: ["yarn", "yarns"],
};
const count = (kind: ResetCarryKind, n: number) => `${n} ${WORDS[kind][n === 1 ? 0 : 1]}`;
const dateText = (date: string | null | undefined) => {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "a sitting";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** What each kind loses when it can't be matched to a row of the new parts (075). */
export const RESET_LOST_WORDS: Record<ResetCarryKind, string> = {
  sitting: "keeps its minutes and rows ticked, but no longer names a part on the craft screen",
  note: "stays with the project, without a part or row",
  frog: "is removed from the rip-back history (the sittings it left out stay left out)",
  instruction: "is removed",
  timer: "keeps running, without a part",
  link: "stays with the project, without a part",
  yarn: "stays with the project, without a part",
};

export function resetCarry(rows: ResetCarryRow[], oldParts: ResetOldPart[]): ResetCarry {
  const carried = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<ResetCarryKind, number>;
  const partName = new Map(oldParts.map((part) => [part.id, part.name]));
  const lost: ResetLost[] = [];
  for (const row of rows) {
    if (row.new_part !== null && row.new_part !== undefined) { carried[row.kind]++; continue; }
    const part = row.old_part_id ? partName.get(row.old_part_id) : undefined;
    const where = part ? ` on ${part}` : "";
    const text = row.kind === "sitting"
      ? `${dateText(row.date)}${where}, rows ${(row.old_from_row ?? 0) + 1}–${row.old_to_row ?? "?"}`
      : row.kind === "frog" ? `Ripped back${where}${row.old_to_row ? ` to row ${row.old_to_row}` : ""}`
        : row.kind === "timer" ? `The running timer${where}`
          : `${row.text ?? WORDS[row.kind][0]}${where}`;
    lost.push({ kind: row.kind, id: row.id, text });
  }
  return { carried, lost };
}

/** The preview's lines: what carries over, then each thing that can't and what happens to it. */
export function resetCarryLines(carry: ResetCarry): string[] {
  const kept = KINDS.filter((kind) => carry.carried[kind] > 0).map((kind) => count(kind, carry.carried[kind]));
  const lines = [kept.length ? `Moves with its rows: ${joinWords(kept)}.` : "No sittings, notes or rip-backs to move."];
  for (const kind of KINDS) {
    const lost = carry.lost.filter((entry) => entry.kind === kind);
    if (!lost.length) continue;
    lines.push(`Can’t be matched to a row (${count(kind, lost.length)}); each ${RESET_LOST_WORDS[kind]}: ${lost.slice(0, 8).map((entry) => entry.text).join("; ")}${lost.length > 8 ? `; and ${lost.length - 8} more` : ""}.`);
  }
  return lines;
}

function joinWords(words: string[]) {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Reset's own refusals (075 MC75K): what Set up can't make again. */
export const RESET_BLOCKER_WORDS: Record<string, string> = { quarters: "quarter rows", ridges: "ridge counts", close_checks: "band checks" };
export const resetBlockerStop = (keys: string[]) =>
  `This project has ${joinWords([...new Set(keys.map((key) => RESET_BLOCKER_WORDS[key] ?? "craft settings"))])} that a reset can’t make again, so it can’t be reset.`;

export const RESET_KEEPS = "Your ticks, stitch counts and sittings stay on the rows.";
export const resetGoes = (oldParts: number, newParts: number) =>
  `Replaces the ${oldParts} ${oldParts === 1 ? "part" : "parts"} on the craft screen with the ${newParts} below, set up again from the checklists.`;

export type ResetBody = { fingerprint: string; names: string[] };
/** The Reset body: the preview's fingerprint and one name per new part. */
export function parseResetBody(body: unknown, partCount: number): { ok: true; value: ResetBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const record = body as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !["fingerprint", "names"].includes(key));
  if (unknownKey) return { ok: false, error: `Unknown field: ${unknownKey}` };
  if (typeof record.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.fingerprint)) return { ok: false, error: "fingerprint is required" };
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
  return { ok: true, value: { fingerprint: record.fingerprint, names } };
}

/** The preview the reset screen, the route and MCP craft_reset share. */
export interface CraftResetPreview {
  plan: CraftSetupPlan;
  fingerprint: string;
  old_parts: ResetOldPart[];
  carry: ResetCarry;
  carry_lines: string[];
  blockers: string[];
}
export const craftResetHref = (projectId: string) => `/craft/setup/${projectId}?reset=1`;
