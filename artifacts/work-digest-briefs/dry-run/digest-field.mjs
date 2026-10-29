// Dry run, step 1: the exact `work_digest` field get_brief_digest would return
// for the two de-identified fixtures, built by the real reader over in-memory
// note rows (no database, no network). Run from the repo root:
//   node --experimental-strip-types --loader ./scripts/alias-loader.mjs artifacts/work-digest-briefs/dry-run/digest-field.mjs
import { readFileSync, writeFileSync } from "node:fs";
const wd = await import(new URL("../../../src/lib/briefing/work-digest.ts", import.meta.url).href);
const fixture = (name) => readFileSync(new URL(`../../../scripts/fixtures/work-digest/${name}`, import.meta.url), "utf8");
const filedLine = (when) => `Filed from the Cooper digest file on ${when}.\n`;
const AM = "00000000-0000-4000-8000-0000000000a1"; // placeholder id for the dry run
const PM = "00000000-0000-4000-8000-0000000000b2"; // placeholder id for the dry run

// Morning, Thu 10/29: the current-layout fixture as the AM note.
const amRow = { id: AM, title: "Work digest 2026-10-29 AM", body_markdown: fixture("work-digest-2026-10-29-am.md") + filedLine("10/29/2026 7:41 AM ET"), status: "active", updated_at: "2026-10-29T11:41:00Z" };
const morning = wd.buildWorkDigestSection({ date: "2026-10-29", mode: "morning", rows: [amRow] });

// EOD, Wed 10/28 (A): the real PM fixture as filed, old layout -> unreadable.
const legacyBody = fixture("work-digest-2026-10-28-pm.md");
const pmRowA = { id: PM, title: "Work digest 2026-10-28 PM", body_markdown: legacyBody + filedLine("10/28/2026 4:21 PM ET"), status: "active", updated_at: "2026-10-28T20:21:00Z" };
const eodA = wd.buildWorkDigestSection({ date: "2026-10-28", mode: "eod", rows: [pmRowA], morningBrief: { code: "AM-1028", content: {} } });

// EOD, Wed 10/28 (B): the same PM text with only the two missing structural
// lines added (still_waiting: 0, and status: open on every W block), i.e. what
// the current skill would have written; no item text is added or changed.
const upgraded = legacyBody.replace("skipped_sensitive: 1", "still_waiting: 0\nskipped_sensitive: 1").replace(/^(owner: .*)$/gm, "$1\nstatus: open");
const pmRowB = { ...pmRowA, body_markdown: upgraded + filedLine("10/28/2026 4:21 PM ET") };
const eodB = wd.buildWorkDigestSection({ date: "2026-10-28", mode: "eod", rows: [pmRowB], morningBrief: { code: "AM-1028", content: {} } });

const out = { morning_1029: morning, eod_1028_as_filed: eodA, eod_1028_upgraded_layout: eodB };
writeFileSync(new URL("./work_digest-fields.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ morning: morning.am.status, eodA: [eodA.am.status, eodA.pm.status, eodA.pm.reason], eodB: [eodB.pm.status, eodB.pm.items?.length] }));
