#!/usr/bin/env node
// Pure tests for brief refresh (Baseline task e8f1449d): text caps cut at a
// sentence or word boundary with "…" and reported as warnings (the footnote cap
// is 1,200), the save's `mode: "refresh"` input, brief_status's rule for which
// work digest notes a brief should cover, and the page's "Refreshed" line and
// late-digest banner. No database; see test-briefs-refresh-db.mjs for the save
// itself (items kept, revisions, no second notice).
//
// Modules added by this change are imported inside each test, so on the code
// before it every test fails on its own assertion or import, never the run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validate = await import("../src/lib/briefs/validate.ts");
const load = (file) => import(`../src/lib/briefs/${file}`);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${String(error instanceof Error ? error.message : error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

const sentence = (n, words = 12) => `Sentence ${n} ${"word ".repeat(words - 3).trim()} end.`;
const paragraph = (count, words) => Array.from({ length: count }, (_, index) => sentence(index + 1, words)).join(" ");

function parse(body) {
  const parsed = validate.parseSaveBriefInput({ edition: "am", date: "2026-11-03", items: [], ...body }, new Date("2026-11-03T13:00:00Z"));
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return parsed.value;
}

// ---------------------------------------------------------------------------
// cutAtBoundary
// ---------------------------------------------------------------------------

await test("cutAtBoundary: under the cap is unchanged; over it ends at the last sentence with …", async () => {
  const { cutAtBoundary, ELLIPSIS } = await load("text-cut.ts");
  assert.equal(cutAtBoundary("Short. Text.", 50), "Short. Text.");
  const text = paragraph(10, 12);
  const cut = cutAtBoundary(text, 300);
  assert.ok(cut.length <= 300, `${cut.length} > 300`);
  assert.ok(cut.endsWith(`end.${ELLIPSIS}`), cut.slice(-20));
  assert.ok(text.startsWith(cut.slice(0, -1)));
});

await test("cutAtBoundary: with no sentence end in the second half, it cuts at the last word boundary, never mid-word", async () => {
  const { cutAtBoundary, ELLIPSIS } = await load("text-cut.ts");
  const text = `First. ${"alpha beta gamma, delta ".repeat(40)}`;
  const cut = cutAtBoundary(text, 120);
  assert.ok(cut.length <= 120);
  assert.ok(cut.endsWith(ELLIPSIS));
  const kept = cut.slice(0, -1);
  assert.ok(text.startsWith(kept));
  // The next character in the original is whitespace (or a joiner we trimmed): the last word is whole.
  assert.match(text.slice(kept.length), /^[\s,]/);
  assert.doesNotMatch(kept, /[,\s]$/, "no trailing comma or space before the …");
});

await test("cutAtBoundary: a sentence that ends exactly at the edge counts; one long unbroken run is cut hard (still with …)", async () => {
  const { cutAtBoundary, ELLIPSIS } = await load("text-cut.ts");
  const exact = `${"a".repeat(57)} b. next words here`;
  assert.equal(cutAtBoundary(exact, 61), `${"a".repeat(57)} b.${ELLIPSIS}`);
  const run = "x".repeat(50);
  assert.equal(cutAtBoundary(run, 10), `${"x".repeat(9)}${ELLIPSIS}`);
});

await test("cutAtBoundary: never longer than the cap (random text, many caps)", async () => {
  const { cutAtBoundary } = await load("text-cut.ts");
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pieces = ["word", "x", "longerword", ".", "!", "?", ",", " ", " ", " ", "”", ")", "—"];
  for (let round = 0; round < 300; round += 1) {
    const text = Array.from({ length: 200 }, () => pieces[Math.floor(rand() * pieces.length)]).join("");
    const max = 2 + Math.floor(rand() * 400);
    const cut = cutAtBoundary(text, max);
    assert.ok(cut.length <= max, `cap ${max}, got ${cut.length}`);
    if (text.length <= max) assert.equal(cut, text);
  }
});

// ---------------------------------------------------------------------------
// validate: caps, warnings, mode
// ---------------------------------------------------------------------------

await test("footnote: 600 characters is kept whole (the cap was 500, now 1,200), with no warning", async () => {
  const footnote = `${paragraph(8, 17)}`.slice(0, 599).replace(/\s$/, "x") + ".";
  assert.equal(footnote.length, 600);
  const value = parse({ content: { footnote, tiles: [{ key: "mail", type: "list", label: "Mail", footnote }] } });
  assert.equal(value.content.footnote, footnote);
  assert.equal(value.content.tiles[0].footnote, footnote);
  assert.deepEqual(value.warnings, []);
});

await test("footnote over 1,200: cut at the last sentence end with …, and a warning names the field and the original length", async () => {
  const { ELLIPSIS } = await load("text-cut.ts");
  const footnote = paragraph(20, 14);
  assert.ok(footnote.length > 1200);
  const value = parse({ content: { footnote, tiles: [{ key: "mail", type: "list", label: "Mail", footnote }] } });
  for (const kept of [value.content.footnote, value.content.tiles[0].footnote]) {
    assert.ok(kept.length <= 1200, String(kept.length));
    assert.ok(kept.endsWith(`end.${ELLIPSIS}`), kept.slice(-12));
  }
  const fields = value.warnings.map((warning) => warning.field);
  assert.deepEqual(fields, ["content.tiles[0].footnote", "content.footnote"]);
  for (const warning of value.warnings) {
    assert.equal(warning.original_length, footnote.length);
    assert.equal(warning.max, 1200);
    assert.equal(warning.action, "cut");
    assert.ok(warning.kept_length <= 1200);
  }
});

await test("every prose cap cuts at a boundary and warns: narrative, a first move, a tile row, a meeting prep, an item's why and detail", async () => {
  const { ELLIPSIS } = await load("text-cut.ts");
  const long = (n) => `${"Plain words without a stop ".repeat(Math.ceil(n / 27))}`.slice(0, n);
  const value = parse({
    content: {
      narrative: long(4100),
      first_moves: ["ok", long(1100)],
      tiles: [{ key: "due", type: "list", label: "Due", groups: [{ rows: [{ title: long(600), meta: "m" }] }] }],
      meetings: [{ title: "IWG", start: "2026-11-03T15:00:00Z", prep: long(1100) }],
    },
    items: [{ kind: "carry_over", title: "Do it", why: long(1100), task_ids: ["43f28321-3e6c-4e26-ad61-4f362be72e5d"] }],
  });
  const byField = Object.fromEntries(value.warnings.map((warning) => [warning.field, warning]));
  assert.deepEqual(Object.keys(byField).sort(), [
    "content.first_moves[1]",
    "content.meetings[0].prep",
    "content.narrative",
    "content.tiles[0].groups[0].rows[0].title",
    "items[0].why",
  ]);
  for (const text of [value.content.narrative, value.content.first_moves[1], value.content.tiles[0].groups[0].rows[0].title, value.content.meetings[0].prep, value.items[0].payload.why]) {
    assert.ok(text.endsWith(ELLIPSIS));
    assert.match(text.slice(-2, -1), /[a-z]/, "ends on a whole word");
  }
  assert.equal(byField["content.narrative"].original_length, 4100);
});

await test("identifiers over their cap are cut short as before (no …) but still reported", async () => {
  const value = parse({ covered_meeting_ids: ["m".repeat(250)], content: { meetings: [{ id: "g".repeat(230), title: "T", start: "2026-11-03T15:00:00Z" }] } });
  assert.equal(value.covered_meeting_ids[0].length, 200);
  assert.equal(value.content.meetings[0].id.length, 200);
  assert.deepEqual(
    value.warnings.map((warning) => [warning.field, warning.action, warning.original_length]),
    [["covered_meeting_ids[0]", "cut_identifier", 250], ["content.meetings[0].id", "cut_identifier", 230]]
  );
});

await test("an item title over 500 is still refused (400), not cut; a meeting id over 200 on an item is refused with its own message", async () => {
  const bad = validate.parseSaveBriefInput({ edition: "am", items: [{ kind: "carry_over", title: "t".repeat(501), task_ids: ["43f28321-3e6c-4e26-ad61-4f362be72e5d"] }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.includes("500 characters or fewer")));
  const badId = validate.parseSaveBriefInput({
    edition: "am",
    items: [{ kind: "proposed_task", title: "x", source: { meetings: [{ id: "i".repeat(201), title: "M", lines: ["a line"] }] } }],
  });
  assert.equal(badId.ok, false);
  assert.ok(badId.errors.some((error) => error.includes(".id must be 200 characters or fewer")), badId.errors.join("; "));
});

await test("reading stored content records no warnings and keeps content.refreshes (malformed entries dropped, last 20 kept)", async () => {
  const { collectSaveWarnings } = await load("text-cut.ts");
  const refreshes = Array.from({ length: 23 }, (_, index) => ({ at: new Date(Date.UTC(2026, 10, 3, 13, index)).toISOString(), reason: `r${index}` }));
  const { value, warnings } = collectSaveWarnings(() => 0);
  assert.equal(value, 0);
  assert.deepEqual(warnings, []);
  const content = validate.normalizeBriefContent({ footnote: "x".repeat(2000), refreshes: [...refreshes, { at: "nope" }, "junk", { reason: "no at" }] });
  assert.equal(content.refreshes.length, 20);
  assert.equal(content.refreshes[0].reason, "r3");
  assert.equal(content.refreshes[19].reason, "r22");
});

await test("mode: absent is the normal save; \"refresh\" with a reason; anything else, or a reason without refresh, is a 400", async () => {
  const plain = parse({});
  assert.equal(plain.mode, undefined);
  assert.equal("refresh_reason" in plain, false);
  const refresh = parse({ mode: "Refresh", refresh_reason: "  AM work digest added " });
  assert.equal(refresh.mode, "refresh");
  assert.equal(refresh.refresh_reason, "AM work digest added");
  const noReason = parse({ mode: "refresh" });
  assert.equal(noReason.refresh_reason, null);
  for (const body of [{ mode: "rebuild" }, { mode: 3 }, { refresh_reason: "why" }, { mode: "refresh", refresh_reason: 7 }]) {
    const result = validate.parseSaveBriefInput({ edition: "am", items: [], ...body });
    assert.equal(result.ok, false, JSON.stringify(body));
  }
  const longReason = parse({ mode: "refresh", refresh_reason: "Added the AM digest that came in late and two late meetings ".repeat(5) });
  assert.ok(longReason.refresh_reason.length <= 200);
  assert.equal(longReason.warnings[0].field, "refresh_reason");
});

// ---------------------------------------------------------------------------
// brief_status rule
// ---------------------------------------------------------------------------

const AM_FIXTURE = readFileSync(path.join(ROOT, "scripts/fixtures/work-digest/work-digest-2026-10-29-am.md"), "utf8");
const DAY = "2026-10-29";
const NOTE_AM = "11111111-1111-4111-8111-111111111111";
const NOTE_PM = "22222222-2222-4222-8222-222222222222";
const amRow = (extra = {}) => ({ id: NOTE_AM, title: `Work digest ${DAY} AM`, body_markdown: AM_FIXTURE, status: "active", created_at: "2026-10-29T12:06:00Z", ...extra });
const pmRow = (extra = {}) => ({
  id: NOTE_PM,
  title: `Work digest ${DAY} PM`,
  body_markdown: AM_FIXTURE.replace("edition: am", "edition: pm"),
  status: "active",
  created_at: "2026-10-29T20:31:00Z",
  ...extra,
});
const briefRow = (ids = [], extra = {}) => ({ code: "AM-1029", created_at: "2026-10-29T11:57:00Z", content: { work_digest_note_ids: ids }, covered_meeting_ids: ["m1"], ...extra });

await test("brief_status (am): no brief means build, never refresh; a filed AM note missing from the brief asks for a refresh; recorded, missing or unreadable notes don't", async () => {
  const { buildBriefStatus } = await load("refresh-status.ts");
  const none = buildBriefStatus({ edition: "am", date: DAY, brief: null, notes: [amRow()] });
  assert.equal(none.brief.exists, false);
  assert.deepEqual(none.refresh_needed, { digest: false, reasons: [] });
  assert.equal(none.digest_notes[0].status, "ok");

  const late = buildBriefStatus({ edition: "am", date: DAY, brief: briefRow(), notes: [amRow()] });
  assert.deepEqual(late.refresh_needed, { digest: true, reasons: ["am_digest_not_in_brief"] });
  assert.deepEqual(late.digest_notes, [
    { edition: "am", title: `Work digest ${DAY} AM`, status: "ok", note_id: NOTE_AM, filed_at: "2026-10-29T12:06:00Z", in_brief: false, needs_refresh: true },
  ]);
  assert.equal(late.brief.code, "AM-1029");
  assert.equal(late.brief.built_at, "2026-10-29T11:57:00Z");
  assert.deepEqual(late.brief.covered_meeting_ids, ["m1"]);

  assert.equal(buildBriefStatus({ edition: "am", date: DAY, brief: briefRow([NOTE_AM]), notes: [amRow()] }).refresh_needed.digest, false);
  assert.equal(buildBriefStatus({ edition: "am", date: DAY, brief: briefRow(), notes: [] }).digest_notes[0].status, "missing");
  assert.equal(buildBriefStatus({ edition: "am", date: DAY, brief: briefRow(), notes: [] }).refresh_needed.digest, false);
  const unreadable = buildBriefStatus({ edition: "am", date: DAY, brief: briefRow(), notes: [amRow({ body_markdown: "garbage" })] });
  assert.equal(unreadable.digest_notes[0].status, "unreadable");
  assert.equal(unreadable.refresh_needed.digest, false);
  // The morning brief never looks at the PM note.
  assert.deepEqual(buildBriefStatus({ edition: "am", date: DAY, brief: briefRow([NOTE_AM]), notes: [amRow(), pmRow()] }).digest_notes.map((note) => note.edition), ["am"]);
});

await test("brief_status (eod): the PM note counts; the AM note only when the morning brief didn't read it either", async () => {
  const { buildBriefStatus } = await load("refresh-status.ts");
  const eod = (ids, morning) => buildBriefStatus({ edition: "eod", date: DAY, brief: briefRow(ids, { code: "EOD-1029" }), morningNoteIds: morning, notes: [amRow(), pmRow()] });
  assert.deepEqual(eod([], [NOTE_AM]).refresh_needed.reasons, ["pm_digest_not_in_brief"]);
  assert.equal(eod([], [NOTE_AM]).digest_notes[0].in_morning_brief, true);
  assert.deepEqual(eod([], []).refresh_needed.reasons, ["am_digest_not_in_brief", "pm_digest_not_in_brief"]);
  assert.deepEqual(eod([], null).refresh_needed.reasons, ["am_digest_not_in_brief", "pm_digest_not_in_brief"]);
  assert.deepEqual(eod([NOTE_PM], [NOTE_AM]).refresh_needed, { digest: false, reasons: [] });
  assert.deepEqual(eod([NOTE_AM, NOTE_PM], []).refresh_needed, { digest: false, reasons: [] });
});

await test("brief_status: last refresh and refresh count come from content.refreshes", async () => {
  const { buildBriefStatus } = await load("refresh-status.ts");
  const refreshes = [{ at: "2026-10-29T12:45:00Z", reason: "AM work digest added" }, { at: "2026-10-29T13:10:00Z" }];
  const status = buildBriefStatus({ edition: "am", date: DAY, brief: briefRow([NOTE_AM], { content: { work_digest_note_ids: [NOTE_AM], refreshes } }), notes: [amRow()] });
  assert.equal(status.brief.refresh_count, 2);
  assert.deepEqual(status.brief.last_refresh, { at: "2026-10-29T13:10:00Z" });
});

// ---------------------------------------------------------------------------
// Page words
// ---------------------------------------------------------------------------

await test("refresh line: none for a brief never refreshed; the last refresh's ET time and reason; the count when more than one", async () => {
  const { refreshLineText } = await load("refresh-view.ts");
  assert.equal(refreshLineText(undefined), null);
  assert.equal(refreshLineText([]), null);
  assert.equal(refreshLineText([{ at: "2026-11-03T13:45:00Z", reason: "AM work digest added" }]), "Refreshed 8:45 AM: AM work digest added");
  assert.equal(
    refreshLineText([{ at: "2026-11-03T13:45:00Z", reason: "a" }, { at: "2026-11-03T14:02:00Z" }, { at: "2026-11-03T22:00:00Z", reason: "PM work digest added" }]),
    "Refreshed 5:00 PM: PM work digest added (refreshed 3 times)"
  );
  assert.equal(refreshLineText([{ at: "2026-11-03T13:45:00Z" }]), "Refreshed 8:45 AM");
});

await test("late-digest banner: queued before the catch-up run, plain after it, nothing when no note is late; copy never names the AI product", async () => {
  const { lateDigestBannerText } = await load("refresh-view.ts");
  const base = { edition: "am", briefDate: "2026-11-03", builtAt: "2026-11-03T12:57:00Z" };
  assert.equal(lateDigestBannerText({ ...base, notes: [], now: new Date("2026-11-03T13:10:00Z") }), null);
  const queued = lateDigestBannerText({ ...base, notes: [{ edition: "am", filed_at: "2026-11-03T13:06:00Z" }], now: new Date("2026-11-03T13:10:00Z") });
  assert.equal(queued, "The AM work digest came in after this brief was built (filed 8:06 AM). A refresh is queued for 8:45 AM.");
  const after = lateDigestBannerText({ ...base, notes: [{ edition: "am", filed_at: "2026-11-03T13:06:00Z" }], now: new Date("2026-11-03T14:00:00Z") });
  assert.equal(after, "The AM work digest came in after this brief was built (filed 8:06 AM). The catch-up run hasn't added it yet. Run the catch-up again to refresh this page.");
  const eod = lateDigestBannerText({
    edition: "eod",
    briefDate: "2026-11-03",
    builtAt: "2026-11-03T21:18:00Z",
    notes: [{ edition: "pm", filed_at: "2026-11-03T21:31:00Z" }, { edition: "am", filed_at: "2026-11-03T13:06:00Z" }],
    now: new Date("2026-11-03T21:40:00Z"),
  });
  assert.equal(eod, "The AM and PM work digests (filed 8:06 AM and 4:31 PM) are not in this brief yet. A refresh is queued for 5:00 PM.");
  for (const text of [queued, after, eod]) assert.doesNotMatch(text, /claude/i);
});

await test("the page and the MCP tools are wired: refresh line + banner on the page, brief_status and mode on the tools, the status route in the upstream router", async () => {
  const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
  assert.match(read("src/components/briefs/BriefPage.tsx"), /refreshLine=\{refreshLineText\(content\.refreshes\)\}/);
  assert.match(read("src/components/briefs/BriefPage.tsx"), /className="late-digest"/);
  assert.match(read("src/app/briefs/[code]/page.tsx"), /lateDigestBannerText\(/);
  const mcp = read("src/app/api/mcp/route.ts");
  assert.match(mcp, /'brief_status'/);
  assert.match(mcp, /mode: z\.enum\(\['refresh'\]\)/);
  assert.match(read("src/app/api/mcp-upstream/[...path]/route.ts"), /segments\[1\] === 'status'/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
