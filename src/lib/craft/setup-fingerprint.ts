/**
 * Server-only: the setup fingerprint. Migration 072's craft_setup_fingerprint() builds the SAME text
 * from the locked rows inside craft_setup_project, so a tick, rename, move or new item between the
 * preview and Create is refused. Keep the two in step (test:craft pins the format, test:craft-db
 * proves JS and SQL agree on real rows).
 *
 * One line per row, sorted by id within each kind; texts are hashed so no separator can be forged:
 *   craft-setup-v1|<project_id>
 *   s|<section id>|<sort_order>|<created_at in ms>
 *   t|<task id>|<section id or "">|<created_at in ms>|<is_sample 1/0>|<sha256(title)>
 *   i|<item id>|<task id>|<sort_order>|<is_done 1/0>|<unit_count or "">|<craft_part_id or "">|<sha256(text)>
 * unit_count is the database's numeric text (the loader reads unit_count::text), trimmed like
 * trim_scale(): never a JavaScript number, so 1e-7 and 1e21 keep their digits (FR1, F3/F5).
 */
import { createHash } from "node:crypto";
import { canonicalUnitText, type SetupSnapshot } from "@/lib/craft/setup";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ms = (iso: string | null) => { const t = iso === null ? NaN : Date.parse(iso); return Number.isFinite(t) ? String(t) : ""; };
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function craftSetupFingerprintText(snapshot: SetupSnapshot): string {
  return [
    `craft-setup-v1|${snapshot.project.id}`,
    byId(snapshot.sections).map((s) => `s|${s.id}|${s.sort_order}|${ms(s.created_at)}`).join("\n"),
    byId(snapshot.tasks).map((t) => `t|${t.id}|${t.section_id ?? ""}|${ms(t.created_at)}|${t.is_sample ? 1 : 0}|${sha(t.title)}`).join("\n"),
    byId(snapshot.items).map((i) => `i|${i.id}|${i.task_id}|${i.sort_order}|${i.is_done ? 1 : 0}|${canonicalUnitText(i.unit_count) ?? ""}|${i.craft_part_id ?? ""}|${sha(i.text)}`).join("\n"),
  ].join("\n");
}

export const craftSetupFingerprint = (snapshot: SetupSnapshot) => sha(craftSetupFingerprintText(snapshot));
