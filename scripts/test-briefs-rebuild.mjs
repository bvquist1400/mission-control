#!/usr/bin/env node
// Pure tests for "brief rebuild" (Baseline task 5dbe87fd):
//  (B) a work digest note re-filed after the brief read it (same note id, a
//      newer updated_at) counts as new: brief_status asks for a refresh
//      (am_digest_updated / pm_digest_updated), the EOD's "AM note already in
//      the morning brief" rule follows the note's version, get_brief_digest's
//      in_morning_brief agrees, and the refresh appends items from the new text.
//  (V) the brief records which version of each note it was built from
//      (Baseline task 483846c2), so a re-file between the routine's read and
//      its save is caught and no check compares two clocks.
//  (A) save_brief / save_eod_brief take `force: true` (with mode "refresh"):
//      a rebuild on command with nothing new, same refresh rules (items kept,
//      old text saved, no notice), and never a first save.
//
// No database and no network: the service runs against an in-memory stand-in
// for the Supabase calls it makes (selects honour their column list), and
// fetch is replaced by a counter. Every test runs even if an earlier one
// fails, so a run on the old code shows each missing behaviour separately.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(file) {
  try {
    return await import(pathToFileURL(path.join(ROOT, "src", file)).href);
  } catch (error) {
    return { __missing: String(error.message).split("\n")[0] };
  }
}

const status = await load("lib/briefs/refresh-status.ts");
const view = await load("lib/briefs/refresh-view.ts");
const validate = await load("lib/briefs/validate.ts");
const service = await load("lib/briefs/service.ts");
const wd = await load("lib/briefing/work-digest.ts");

function need(mod, ...names) {
  if (mod.__missing) assert.fail(`module missing: ${mod.__missing}`);
  for (const name of names) assert.equal(typeof mod[name], "function", `${name} is not exported`);
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${String(error instanceof Error ? error.message : error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const USER = "11111111-1111-4111-8111-111111111111";
const NOTE_AM = "a7bc8f88-0000-4000-8000-000000000001";
const NOTE_PM = "a7bc8f88-0000-4000-8000-000000000002";
const DAY = "2026-10-29";
const AM_FIXTURE = readFileSync(path.join(ROOT, "scripts/fixtures/work-digest/work-digest-2026-10-29-am.md"), "utf8");
const PM_FIXTURE = AM_FIXTURE.replace("edition: am", "edition: pm");
const W2_LINE = "Nathan asked for a suggestion on which location value to use because the study record import failed without one.";
const W3_LINE = "Nathan moved one study record to the test environment and asked Saif to check it works before he migrates the rest.";

// Times (EDT, UTC-4): AM note filed 7:41, AM brief built 7:58, catch-up 8:45,
// AM note re-filed 9:30, EOD built 4:18, PM note filed 4:31.
const T = {
  amFiled: "2026-10-29T11:41:00Z",
  amBuilt: "2026-10-29T11:58:00Z",
  amCatchup: "2026-10-29T12:45:00Z",
  amRefiled: "2026-10-29T13:30:00Z",
  eodBuilt: "2026-10-29T20:18:00Z",
  pmFiled: "2026-10-29T20:31:00Z",
};

const amRow = (extra = {}) => ({ id: NOTE_AM, user_id: USER, title: `Work digest ${DAY} AM`, body_markdown: AM_FIXTURE, status: "active", created_at: T.amFiled, updated_at: T.amFiled, ...extra });
const pmRow = (extra = {}) => ({ id: NOTE_PM, user_id: USER, title: `Work digest ${DAY} PM`, body_markdown: PM_FIXTURE, status: "active", created_at: T.pmFiled, updated_at: T.pmFiled, ...extra });
const briefRow = (ids, extra = {}) => ({ code: "AM-1029", created_at: T.amBuilt, content: { work_digest_note_ids: ids }, covered_meeting_ids: [], ...extra });

function amStatus(brief, notes) {
  need(status, "buildBriefStatus");
  return status.buildBriefStatus({ edition: "am", date: DAY, brief, notes });
}

// ---------------------------------------------------------------------------
// (B) brief_status: a re-filed note
// ---------------------------------------------------------------------------

await test("B1 new note: filed after the build and not in the brief asks for a refresh (am_digest_not_in_brief), as before", () => {
  const result = amStatus(briefRow([]), [amRow({ created_at: "2026-10-29T12:06:00Z", updated_at: "2026-10-29T12:06:00Z" })]);
  assert.deepEqual(result.refresh_needed, { digest: true, reasons: ["am_digest_not_in_brief"] });
  assert.equal(result.digest_notes[0].reason, "am_digest_not_in_brief");
  assert.equal(result.digest_notes[0].updated_since_brief, false);
});

await test("B2 same note, unchanged: recorded and not updated since the build asks for nothing", () => {
  const result = amStatus(briefRow([NOTE_AM]), [amRow()]);
  assert.deepEqual(result.refresh_needed, { digest: false, reasons: [] });
  assert.equal(result.digest_notes[0].in_brief, true);
  assert.equal(result.digest_notes[0].updated_since_brief, false);
  assert.equal(result.digest_notes[0].needs_refresh, false);
  assert.equal(result.digest_notes[0].reason, null);
  assert.equal(result.digest_notes[0].updated_at, T.amFiled);
});

await test("B3 same note, re-filed after the build: in_brief stays true (by id) but it asks for a refresh with am_digest_updated", () => {
  const result = amStatus(briefRow([NOTE_AM]), [amRow({ updated_at: T.amRefiled })]);
  assert.deepEqual(result.refresh_needed, { digest: true, reasons: ["am_digest_updated"] });
  const [note] = result.digest_notes;
  assert.equal(note.in_brief, true);
  assert.equal(note.updated_since_brief, true);
  assert.equal(note.needs_refresh, true);
  assert.equal(note.reason, "am_digest_updated");
  assert.equal(note.updated_at, T.amRefiled);
  assert.equal(note.filed_at, T.amFiled, "filed_at stays the note's created_at");
  assert.equal(result.brief.last_built_at, T.amBuilt);
  assert.ok(status.REFRESH_REASONS.includes("am_digest_updated") && status.REFRESH_REASONS.includes("pm_digest_updated"));
});

await test("B4 updated before the build (or exactly at it): no refresh", () => {
  assert.equal(amStatus(briefRow([NOTE_AM]), [amRow({ updated_at: "2026-10-29T11:50:00Z" })]).refresh_needed.digest, false);
  assert.equal(amStatus(briefRow([NOTE_AM]), [amRow({ updated_at: T.amBuilt })]).refresh_needed.digest, false);
  // Postgres writes microseconds; same instant still isn't "after".
  assert.equal(amStatus(briefRow([NOTE_AM], { created_at: "2026-10-29T11:58:00.123456+00:00" }), [amRow({ updated_at: "2026-10-29T11:58:00.123+00:00" })]).refresh_needed.digest, false);
});

await test("B5 the last refresh counts as the build time: updated before it = nothing; after it = refresh", () => {
  const refreshed = (updatedAt) =>
    amStatus(briefRow([NOTE_AM], { content: { work_digest_note_ids: [NOTE_AM], refreshes: [{ at: T.amCatchup, reason: "AM work digest added" }] } }), [amRow({ updated_at: updatedAt })]);
  assert.equal(refreshed("2026-10-29T12:30:00Z").refresh_needed.digest, false, "re-filed 8:30, refreshed 8:45");
  assert.equal(refreshed("2026-10-29T12:30:00Z").brief.last_built_at, T.amCatchup);
  assert.deepEqual(refreshed(T.amRefiled).refresh_needed.reasons, ["am_digest_updated"]);
});

await test("B6 missing updated_at (note or brief times unreadable): falls back to the old id-only rule", () => {
  const { updated_at: _drop, ...noUpdated } = amRow();
  void _drop;
  assert.equal(amStatus(briefRow([NOTE_AM]), [noUpdated]).refresh_needed.digest, false);
  assert.equal(amStatus(briefRow([NOTE_AM]), [{ ...noUpdated, updated_at: null }]).digest_notes[0].updated_since_brief, false);
  assert.equal(amStatus(briefRow([NOTE_AM]), [amRow({ updated_at: "garbage" })]).refresh_needed.digest, false);
  assert.equal(amStatus(briefRow([NOTE_AM], { created_at: null }), [amRow({ updated_at: T.amRefiled })]).refresh_needed.digest, false);
  // Not recorded: the old rule still asks for it, whatever the times.
  assert.deepEqual(amStatus(briefRow([]), [noUpdated]).refresh_needed.reasons, ["am_digest_not_in_brief"]);
  // No brief: build, never refresh.
  assert.deepEqual(amStatus(null, [amRow({ updated_at: T.amRefiled })]).refresh_needed, { digest: false, reasons: [] });
  // An unreadable re-filed note never asks for a refresh.
  assert.equal(amStatus(briefRow([NOTE_AM]), [amRow({ updated_at: T.amRefiled, body_markdown: "garbage" })]).refresh_needed.digest, false);
});

function eodStatus({ eodIds, eodBuilt = T.eodBuilt, eodRefreshes, morningIds, morningBuilt, notes }) {
  need(status, "buildBriefStatus");
  return status.buildBriefStatus({
    edition: "eod",
    date: DAY,
    brief: briefRow(eodIds, { code: "EOD-1029", created_at: eodBuilt, content: { work_digest_note_ids: eodIds, ...(eodRefreshes ? { refreshes: eodRefreshes } : {}) } }),
    morningNoteIds: morningIds,
    morningBuiltAt: morningBuilt,
    notes,
  });
}

await test("B7 EOD/AM: an AM note the morning brief read (and not re-filed since) is not needed; re-filed after the morning brief, the EOD needs it (am_digest_updated)", () => {
  // The PM note was filed at 4:05, before the EOD's 4:18 build.
  const pmBefore = pmRow({ created_at: "2026-10-29T20:05:00Z", updated_at: "2026-10-29T20:05:00Z" });
  const notes = (amUpdated) => [amRow({ updated_at: amUpdated }), pmBefore];
  // Morning read it, unchanged: EOD needs only the PM note.
  const plain = eodStatus({ eodIds: [NOTE_PM], morningIds: [NOTE_AM], morningBuilt: T.amBuilt, notes: notes(T.amFiled) });
  assert.deepEqual(plain.refresh_needed, { digest: false, reasons: [] });
  assert.equal(plain.digest_notes[0].in_morning_brief, true);
  assert.equal(plain.digest_notes[0].updated_since_morning_brief, false);

  // Re-filed at 9:30 after the morning brief (7:58), EOD (4:18) didn't record it: the EOD must take it in.
  const refiled = eodStatus({ eodIds: [NOTE_PM], morningIds: [NOTE_AM], morningBuilt: T.amBuilt, notes: notes(T.amRefiled) });
  assert.deepEqual(refiled.refresh_needed.reasons, ["am_digest_updated"]);
  assert.equal(refiled.digest_notes[0].in_morning_brief, true);
  assert.equal(refiled.digest_notes[0].updated_since_morning_brief, true);
  assert.equal(refiled.digest_notes[0].needs_refresh, true);

  // The EOD built after the re-file and recorded the note: it has this version.
  assert.equal(eodStatus({ eodIds: [NOTE_AM, NOTE_PM], morningIds: [NOTE_AM], morningBuilt: T.amBuilt, notes: notes(T.amRefiled) }).refresh_needed.digest, false);

  // The morning brief was rebuilt after the re-file ("rebuild am" at 9:40): the EOD doesn't need it.
  assert.equal(eodStatus({ eodIds: [NOTE_PM], morningIds: [NOTE_AM], morningBuilt: "2026-10-29T13:40:00Z", notes: notes(T.amRefiled) }).refresh_needed.digest, false);

  // Re-filed after BOTH briefs (5:30 PM): the EOD has an old version and so does the morning one.
  const late = eodStatus({ eodIds: [NOTE_AM, NOTE_PM], morningIds: [NOTE_AM], morningBuilt: T.amBuilt, notes: notes("2026-10-29T21:30:00Z") });
  assert.deepEqual(late.refresh_needed.reasons, ["am_digest_updated"]);
  assert.equal(late.digest_notes[0].updated_since_brief, true);

  // PM note re-filed after the EOD's last refresh.
  const pmLate = eodStatus({ eodIds: [NOTE_PM], eodRefreshes: [{ at: "2026-10-29T21:00:00Z" }], morningIds: [NOTE_AM], morningBuilt: T.amBuilt, notes: [amRow(), pmRow({ updated_at: "2026-10-29T21:20:00Z" })] });
  assert.deepEqual(pmLate.refresh_needed.reasons, ["pm_digest_updated"]);

  // Morning brief time unknown (old caller): old rule, recorded = not needed.
  assert.equal(eodStatus({ eodIds: [NOTE_PM], morningIds: [NOTE_AM], morningBuilt: undefined, notes: notes(T.amRefiled) }).refresh_needed.digest, false);
  // Neither brief read it: not in brief, as before.
  assert.deepEqual(eodStatus({ eodIds: [NOTE_PM], morningIds: [], morningBuilt: T.amBuilt, notes: notes(T.amFiled) }).refresh_needed.reasons, ["am_digest_not_in_brief"]);
});

await test("B8 get_brief_digest agrees: in_morning_brief is false (and updated_after_morning_brief true) once the AM note is re-filed after the morning brief's last build", () => {
  need(wd, "buildWorkDigestSection");
  const morningBrief = (extra = {}) => ({ code: "AM-1029", created_at: T.amBuilt, content: { work_digest_note_ids: [NOTE_AM] }, ...extra });
  const unchanged = wd.buildWorkDigestSection({ date: DAY, mode: "eod", rows: [amRow(), pmRow()], morningBrief: morningBrief() });
  assert.equal(unchanged.am.in_morning_brief, true);
  assert.equal(unchanged.am.updated_after_morning_brief, undefined);
  const refiled = wd.buildWorkDigestSection({ date: DAY, mode: "eod", rows: [amRow({ updated_at: T.amRefiled }), pmRow()], morningBrief: morningBrief() });
  assert.equal(refiled.am.in_morning_brief, false);
  assert.equal(refiled.am.updated_after_morning_brief, true);
  const rebuilt = wd.buildWorkDigestSection({
    date: DAY,
    mode: "eod",
    rows: [amRow({ updated_at: T.amRefiled }), pmRow()],
    morningBrief: morningBrief({ content: { work_digest_note_ids: [NOTE_AM], refreshes: [{ at: "2026-10-29T13:40:00Z" }] } }),
  });
  assert.equal(rebuilt.am.in_morning_brief, true);
  // No created_at on the morning brief (old shape): id-only, as before.
  const old = wd.buildWorkDigestSection({ date: DAY, mode: "eod", rows: [amRow({ updated_at: T.amRefiled })], morningBrief: { code: "AM-1029", content: { work_digest_note_ids: [NOTE_AM] } } });
  assert.equal(old.am.in_morning_brief, true);
});

await test("B9 the page banner says a re-filed note was updated (not that it is missing), with the updated time", () => {
  need(view, "lateDigestBannerText");
  const base = { edition: "am", briefDate: "2026-10-29", builtAt: T.amBuilt };
  const text = view.lateDigestBannerText({ ...base, notes: [{ edition: "am", filed_at: T.amFiled, updated_at: T.amRefiled, updated: true }], now: new Date("2026-10-29T13:35:00Z") });
  assert.equal(text, "The AM work digest was re-filed after this brief was last built (updated 9:30 AM). The catch-up run hasn't added it yet. Run the catch-up again to refresh this page.");
  const mixed = view.lateDigestBannerText({
    edition: "eod",
    briefDate: "2026-10-29",
    builtAt: T.eodBuilt,
    notes: [{ edition: "pm", filed_at: T.pmFiled }, { edition: "am", filed_at: T.amFiled, updated_at: T.amRefiled, updated: true }],
    now: new Date("2026-10-29T20:40:00Z"),
  });
  assert.equal(
    mixed,
    "The PM work digest came in after this brief was built (filed 4:31 PM). The AM work digest was re-filed after this brief was last built (updated 9:30 AM). A refresh is queued for 5:00 PM."
  );
  assert.doesNotMatch(text + mixed, /claude|anthropic/i);
  // Unchanged words for a note that is simply late.
  assert.equal(
    view.lateDigestBannerText({ ...base, builtAt: "2026-10-29T11:57:00Z", notes: [{ edition: "am", filed_at: "2026-10-29T12:06:00Z" }], now: new Date("2026-10-29T12:10:00Z") }),
    "The AM work digest came in after this brief was built (filed 8:06 AM). A refresh is queued for 8:45 AM."
  );
});

// ---------------------------------------------------------------------------
// In-memory Supabase stand-in (selects honour their plain column list)
// ---------------------------------------------------------------------------

function makeWorld({ notes = [], briefs = [], items = [] } = {}) {
  return { tables: { briefs: briefs.map((row) => structuredClone(row)), brief_items: items.map((row) => structuredClone(row)), notes: notes.map((row) => structuredClone(row)), brief_revisions: [] }, rpcCalls: [], seq: 0 };
}

function project(row, columns) {
  if (!columns || columns.includes("(") || columns.trim() === "*") return row;
  const keep = columns.split(",").map((column) => column.trim()).filter(Boolean);
  return Object.fromEntries(keep.filter((column) => column in row).map((column) => [column, row[column]]));
}

function fakeSupabase(world) {
  const nextId = () => `99999999-9999-4999-8999-${String(++world.seq).padStart(12, "0")}`;
  function from(table) {
    const rows = (world.tables[table] ??= []);
    let op = "select";
    let payload = null;
    let single = null;
    let columns = null;
    let head = false;
    let orderBy = null;
    let descending = false;
    let cap = Infinity;
    const filters = [];
    const builder = {
      select: (cols, options) => ((columns = cols ?? null), (head = Boolean(options?.head)), builder),
      insert: (value) => ((op = "insert"), (payload = Array.isArray(value) ? value : [value]), builder),
      update: (value) => ((op = "update"), (payload = value), builder),
      eq: (column, value) => (column.includes(".") ? builder : (filters.push((row) => row[column] === value), builder)),
      in: (column, values) => (filters.push((row) => values.includes(row[column])), builder),
      is: (column, value) => (filters.push((row) => (row[column] ?? null) === value), builder),
      gt: (column, value) => (filters.push((row) => row[column] > value), builder),
      gte: (column, value) => (filters.push((row) => row[column] >= value), builder),
      lt: (column, value) => (filters.push((row) => row[column] < value), builder),
      lte: (column, value) => (filters.push((row) => row[column] <= value), builder),
      order: (column, options) => ((orderBy = options?.referencedTable ? orderBy : column), (descending = options?.ascending === false), builder),
      limit: (count) => ((cap = count), builder),
      maybeSingle: () => ((single = "maybe"), run()),
      single: () => ((single = "one"), run()),
      then: (resolve, reject) => run().then(resolve, reject),
    };
    function run() {
      let data;
      if (op === "insert") {
        if (table === "brief_items") {
          for (const row of payload) {
            if (rows.some((existing) => existing.user_id === row.user_id && existing.item_key === row.item_key)) {
              return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate item_key" } });
            }
          }
        }
        const defaults =
          table === "briefs"
            ? { notified_at: null, notify_sent_at: null, notify_error: null, created_at: world.now ?? T.amBuilt, updated_at: world.now ?? T.amBuilt }
            : { state: "open", dismissed_reason: null, dismissed_note: null, choice: null, created_task_id: null, prior_due: null, acted_at: null, created_at: world.now ?? T.amBuilt, updated_at: world.now ?? T.amBuilt };
        data = payload.map((row) => ({ id: nextId(), ...defaults, ...structuredClone(row) }));
        rows.push(...data);
      } else if (op === "update") {
        data = rows.filter((row) => filters.every((filter) => filter(row)));
        for (const row of data) Object.assign(row, structuredClone(payload));
      } else {
        data = rows.filter((row) => filters.every((filter) => filter(row)));
        if (orderBy) {
          data = [...data].sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0));
          if (descending) data.reverse();
        }
        data = data.slice(0, cap);
        if (head) return Promise.resolve({ data: null, count: data.length, error: null });
        data = data.map((row) => project(row, columns));
      }
      data = structuredClone(data);
      if (single) data = data[0] ?? null;
      if (single === "one" && !data) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } });
      return Promise.resolve({ data, error: null });
    }
    return builder;
  }
  return {
    from,
    // brief_refresh_content (068), as the migration does it: the old content
    // goes to a revision; notes read and coverage are unioned (old first, notes
    // at most 4); the refresh {at, reason} is appended to content.refreshes.
    async rpc(name, args) {
      world.rpcCalls.push({ name, args: structuredClone(args) });
      assert.equal(name, "brief_refresh_content", `unexpected rpc ${name}`);
      const brief = world.tables.briefs.find((row) => row.id === args.p_brief_id && row.user_id === args.p_user_id);
      if (!brief) return { data: { ok: false, reason: "not_found" }, error: null };
      const revisionId = nextId();
      world.tables.brief_revisions.push({ id: revisionId, brief_id: brief.id, content: structuredClone(brief.content), covered_meeting_ids: [...brief.covered_meeting_ids], reason: args.p_refresh.reason ?? null });
      const notes = [...new Set([...(brief.content.work_digest_note_ids ?? []), ...(args.p_content.work_digest_note_ids ?? [])])].slice(0, 4);
      const refreshes = [...(brief.content.refreshes ?? []), args.p_refresh.reason ? { at: args.p_refresh.at, reason: args.p_refresh.reason } : { at: args.p_refresh.at }];
      const { refreshes: _r, work_digest_note_ids: _n, ...rest } = args.p_content;
      void _r;
      void _n;
      brief.content = { ...rest, ...(notes.length ? { work_digest_note_ids: notes } : {}), refreshes };
      brief.covered_meeting_ids = [...new Set([...brief.covered_meeting_ids, ...args.p_covered_meeting_ids])];
      brief.updated_at = args.p_refresh.at;
      return { data: { ok: true, revision_id: revisionId, content: brief.content, covered_meeting_ids: brief.covered_meeting_ids }, error: null };
    },
  };
}

function countingNotifier() {
  const sent = [];
  return { sent, send: async (text) => void sent.push(text) };
}

/** Runs `fn` with fetch replaced by a counter (a notice, an n8n call or any other outbound request would show up here). */
async function withNoNetwork(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error(`unexpected network call: ${url}`);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

function parseSave(raw, now) {
  need(validate, "parseSaveBriefInput");
  return validate.parseSaveBriefInput(raw, now);
}

async function save(world, raw, now, notifier = countingNotifier()) {
  need(service, "saveBrief");
  const parsed = parseSave(raw, now);
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  world.now = now.toISOString();
  return service.saveBrief(fakeSupabase(world), USER, parsed.value, { appUrl: "http://localhost:3000", notifier, now });
}

const digestItem = (block, line, title) => ({ kind: "proposed_task", title, source: { work_digest: { note_id: NOTE_AM, edition: "am", blocks: [block], lines: [line] } } });
const W3_ITEM = digestItem("W3", W3_LINE, "Check the study record Nathan moved to test");
const W2_ITEM = digestItem("W2", W2_LINE, "Suggest the location value for the import");

/** Today's AM brief as the 7:58 run left it: the AM note recorded, W3 proposed and already accepted by Brent. */
async function builtMorning(world) {
  const first = await save(world, { edition: "am", date: DAY, content: { heading: "Thu, Oct 29", narrative: "Old text.", work_digest_note_ids: [NOTE_AM] }, items: [W3_ITEM] }, new Date(T.amBuilt));
  assert.equal(first.created, true);
  const item = world.tables.brief_items[0];
  Object.assign(item, { state: "accepted", acted_at: "2026-10-29T12:10:00Z", created_task_id: "cccccccc-0000-4000-8000-000000000001", choice: null });
  return { first, item: structuredClone(item) };
}

// ---------------------------------------------------------------------------
// (B) the refresh takes in the re-filed note's text
// ---------------------------------------------------------------------------

await test("B10 refresh after a re-file: a new W item from the same note is appended (not work_digest_already_covered); the kept item is untouched", async () => {
  const world = makeWorld({ notes: [amRow()] });
  const { item: before } = await builtMorning(world);
  // Brent re-files the digest at 9:30: same note id, new text has W2 too (the fixture already does) and a new updated_at.
  world.tables.notes[0].updated_at = T.amRefiled;
  const { result, calls } = await withNoNetwork(() =>
    save(world, { edition: "am", date: DAY, mode: "refresh", refresh_reason: "AM work digest re-filed", content: { heading: "Thu, Oct 29", narrative: "New text.", work_digest_note_ids: [NOTE_AM] }, items: [W3_ITEM, W2_ITEM] }, new Date("2026-10-29T13:35:00Z"))
  );
  assert.deepEqual(calls, []);
  assert.equal(result.mode, "refresh");
  assert.deepEqual(result.skipped.map((skip) => [skip.reason, skip.n]), [["kept_on_refresh", 1]]);
  assert.deepEqual(result.appended.map((entry) => [entry.n, entry.title]), [[2, "Suggest the location value for the import"]]);
  assert.deepEqual(world.tables.brief_items[0], before, "the accepted item is byte for byte the same");
  assert.equal(world.tables.briefs[0].content.narrative, "New text.");
  assert.equal(world.tables.brief_revisions[0].content.narrative, "Old text.");
});

await test("B11 refresh with the note NOT re-filed since the build: a new W item from it is still skipped as work_digest_already_covered (old rule)", async () => {
  const world = makeWorld({ notes: [amRow()] });
  await builtMorning(world);
  const result = await save(world, { edition: "am", date: DAY, mode: "refresh", content: { narrative: "New text.", work_digest_note_ids: [NOTE_AM] }, items: [W3_ITEM, W2_ITEM] }, new Date("2026-10-29T13:35:00Z"));
  assert.deepEqual(result.skipped.map((skip) => skip.reason), ["kept_on_refresh", "work_digest_already_covered"]);
  assert.deepEqual(result.appended, []);
});

await test("B12 a plain (non-refresh) rerun after a re-file keeps the old append rule: nothing new from a recorded note", async () => {
  const world = makeWorld({ notes: [amRow()] });
  await builtMorning(world);
  world.tables.notes[0].updated_at = T.amRefiled;
  const result = await save(world, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM] }, items: [W2_ITEM] }, new Date("2026-10-29T13:35:00Z"));
  assert.deepEqual(result.skipped.map((skip) => skip.reason), ["work_digest_already_covered"]);
});

await test("B13 getBriefStatus end to end: re-filed → am_digest_updated; after the refresh → no change (no loop)", async () => {
  need(service, "getBriefStatus");
  const world = makeWorld({ notes: [amRow()] });
  await builtMorning(world);
  const read = () => service.getBriefStatus(fakeSupabase(world), USER, "am", DAY);
  assert.equal((await read()).refresh_needed.digest, false);
  world.tables.notes[0].updated_at = T.amRefiled;
  const stale = await read();
  assert.deepEqual(stale.refresh_needed.reasons, ["am_digest_updated"]);
  assert.equal(stale.digest_notes[0].updated_at, T.amRefiled, "getBriefStatus reads the note's updated_at");
  await save(world, { edition: "am", date: DAY, mode: "refresh", content: { work_digest_note_ids: [NOTE_AM] }, items: [W3_ITEM] }, new Date("2026-10-29T13:35:00Z"));
  const after = await read();
  assert.deepEqual(after.refresh_needed, { digest: false, reasons: [] });
  assert.equal(after.brief.last_built_at, "2026-10-29T13:35:00.000Z");
});

await test("B14 getBriefStatus (eod) reads the morning brief's build/refresh time, so a re-filed AM note reaches the EOD", async () => {
  need(service, "getBriefStatus");
  const world = makeWorld({ notes: [amRow(), pmRow({ created_at: "2026-10-29T20:00:00Z", updated_at: "2026-10-29T20:00:00Z" })] });
  await builtMorning(world);
  await save(world, { edition: "eod", date: DAY, content: { work_digest_note_ids: [NOTE_PM] }, items: [] }, new Date(T.eodBuilt));
  assert.equal((await service.getBriefStatus(fakeSupabase(world), USER, "eod", DAY)).refresh_needed.digest, false);
  world.tables.notes[0].updated_at = "2026-10-29T20:50:00Z";
  const result = await service.getBriefStatus(fakeSupabase(world), USER, "eod", DAY);
  assert.deepEqual(result.refresh_needed.reasons, ["am_digest_updated"]);
});

await test("B15 fetchWorkDigestSection reads the morning brief's created_at (the EOD digest's in_morning_brief follows a re-file)", async () => {
  need(wd, "fetchWorkDigestSection");
  const world = makeWorld({ notes: [amRow({ updated_at: T.amRefiled })], briefs: [{ id: "b-am", user_id: USER, edition: "am", brief_date: DAY, code: "AM-1029", created_at: T.amBuilt, content: { work_digest_note_ids: [NOTE_AM] }, covered_meeting_ids: [] }] });
  const section = await wd.fetchWorkDigestSection(fakeSupabase(world), USER, DAY, "eod");
  assert.equal(section.am.status, "ok");
  assert.equal(section.am.in_morning_brief, false);
  assert.equal(section.am.updated_after_morning_brief, true);
});

// ---------------------------------------------------------------------------
// (V) versions (Baseline task 483846c2): the brief records which version of
//     each note it was built from, so a re-file between the routine's read and
//     its save is caught, and nothing compares the app's clock with the DB's.
// ---------------------------------------------------------------------------

const nv = await load("lib/briefs/note-version.ts");
// Postgres-style times (microseconds), as PostgREST returns them.
const V1 = "2026-10-29T11:41:00.123456+00:00";
const V2 = "2026-10-29T11:59:30.654321+00:00";
const V3 = "2026-10-29T12:44:10.000001+00:00";

await test("V1 versions compare to the microsecond, on one clock; malformed versions are dropped (that note keeps the save-time rule)", () => {
  need(nv, "noteVersionMicros", "readNoteVersions", "noteRefiledSince", "versionToRecord");
  assert.ok(nv.noteVersionMicros("2026-10-29T11:58:00.123457+00:00") > nv.noteVersionMicros("2026-10-29T11:58:00.123456+00:00"), "same millisecond, later microsecond");
  assert.equal(nv.noteVersionMicros("2026-10-29T11:58:00.123+00:00"), nv.noteVersionMicros("2026-10-29T11:58:00.123Z"));
  assert.equal(nv.noteVersionMicros("2026-10-29T07:58:00-04:00"), nv.noteVersionMicros("2026-10-29T11:58:00Z"));
  assert.equal(nv.noteVersionMicros("garbage"), null);
  assert.deepEqual(nv.readNoteVersions({ work_digest_note_versions: { [NOTE_AM.toUpperCase()]: V1, [NOTE_PM]: "nope", "not-a-uuid": V1 } }), { [NOTE_AM]: V1 });
  assert.deepEqual(nv.readNoteVersions({ work_digest_note_versions: [V1] }), {});
  // With a version: only a later updated_at is a re-file, whatever the brief's save time says.
  assert.equal(nv.noteRefiledSince({ noteUpdatedAt: V2, recordedVersion: V1, briefBuiltAt: "2026-10-29T12:00:00Z" }), true, "re-filed 7:59:30, saved 8:00: caught");
  assert.equal(nv.noteRefiledSince({ noteUpdatedAt: V1, recordedVersion: V1, briefBuiltAt: "2026-10-29T11:41:00.050Z" }), false, "same version: not re-filed, even with the save time 73 ms before updated_at (clock skew)");
  // No version: the old rule.
  assert.equal(nv.noteRefiledSince({ noteUpdatedAt: V2, recordedVersion: null, briefBuiltAt: "2026-10-29T12:00:00Z" }), false);
  assert.equal(nv.noteRefiledSince({ noteUpdatedAt: V2, recordedVersion: undefined, briefBuiltAt: "2026-10-29T11:58:00Z" }), true);
  // What a save records: the caller's read when not later than the note; else the note's current version.
  assert.deepEqual(nv.versionToRecord(V1, V2), { version: V1, as_read: true });
  assert.deepEqual(nv.versionToRecord(V3, V2), { version: V2, as_read: false }, "a version later than the note's is not believed");
  assert.deepEqual(nv.versionToRecord(undefined, V2), { version: V2, as_read: false });
  assert.equal(nv.versionToRecord(V1, null), null);
});

await test("V2 brief_status: a note re-filed after the read but before the save asks for a refresh (am_digest_updated); the same version never does, even with the save time before updated_at", () => {
  // Read V1 at 7:58:40, re-filed V2 at 7:59:30, saved at 8:00 (after the re-file).
  const brief = briefRow([NOTE_AM], { created_at: "2026-10-29T12:00:00Z", content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V1 } } });
  const raced = amStatus(brief, [amRow({ updated_at: V2 })]);
  assert.deepEqual(raced.refresh_needed, { digest: true, reasons: ["am_digest_updated"] });
  assert.equal(raced.digest_notes[0].brief_version, V1);
  assert.equal(raced.digest_notes[0].updated_since_brief, true);
  // Skew: the save time (app clock) is 70 ms BEFORE the note's updated_at (DB clock), same version.
  const skewed = briefRow([NOTE_AM], { created_at: "2026-10-29T11:41:00.053Z", content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V1 } } });
  assert.deepEqual(amStatus(skewed, [amRow({ updated_at: V1 })]).refresh_needed, { digest: false, reasons: [] });
  // EOD: the morning brief's version decides whether the EOD needs the AM note.
  const pmBefore = pmRow({ created_at: "2026-10-29T20:05:00Z", updated_at: "2026-10-29T20:05:00Z" });
  const eod = (morningVersions) =>
    status.buildBriefStatus({
      edition: "eod",
      date: DAY,
      brief: briefRow([NOTE_PM], { code: "EOD-1029", created_at: T.eodBuilt, content: { work_digest_note_ids: [NOTE_PM] } }),
      morningNoteIds: [NOTE_AM],
      morningBuiltAt: "2026-10-29T12:00:00Z",
      morningNoteVersions: morningVersions,
      notes: [amRow({ updated_at: V2 }), pmBefore],
    });
  assert.deepEqual(eod({ [NOTE_AM]: V1 }).refresh_needed.reasons, ["am_digest_updated"], "the morning brief was built from V1: the EOD needs V2");
  assert.equal(eod({ [NOTE_AM]: V2 }).refresh_needed.digest, false);
  assert.equal(eod(null).refresh_needed.digest, false, "no morning version: the old save-time rule (V2 is before 8:00)");
});

await test("V3 get_brief_digest gives each note's updated_at (the version to send back), and the EOD's in_morning_brief follows the morning brief's version", () => {
  need(wd, "buildWorkDigestSection", "readWorkDigestNote");
  assert.equal(wd.readWorkDigestNote([amRow({ updated_at: V1 })], DAY, "am").updated_at, V1);
  assert.equal(wd.readWorkDigestNote([amRow({ updated_at: V1, body_markdown: "garbage" })], DAY, "am").updated_at, V1);
  assert.equal("updated_at" in wd.readWorkDigestNote([amRow({ updated_at: null })], DAY, "am"), false);
  const morningBrief = (versions) => ({ code: "AM-1029", created_at: "2026-10-29T12:00:00Z", content: { work_digest_note_ids: [NOTE_AM], ...(versions ? { work_digest_note_versions: versions } : {}) } });
  const raced = wd.buildWorkDigestSection({ date: DAY, mode: "eod", rows: [amRow({ updated_at: V2 }), pmRow()], morningBrief: morningBrief({ [NOTE_AM]: V1 }) });
  assert.equal(raced.am.in_morning_brief, false);
  assert.equal(raced.am.updated_after_morning_brief, true);
  assert.equal(raced.am.updated_at, V2);
  const current = wd.buildWorkDigestSection({ date: DAY, mode: "eod", rows: [amRow({ updated_at: V2 }), pmRow()], morningBrief: morningBrief({ [NOTE_AM]: V2 }) });
  assert.equal(current.am.in_morning_brief, true);
});

await test("V4 save end to end: read V1, re-filed V2 before the save → caught; the catch-up reads V2, re-filed V3 before its save → caught again; reading V3 → clear (no loop)", async () => {
  need(service, "saveBrief", "getBriefStatus");
  const world = makeWorld({ notes: [amRow({ updated_at: V1 })] });
  const read = () => service.getBriefStatus(fakeSupabase(world), USER, "am", DAY);
  // 7:58:40 the routine reads V1; 7:59:30 Brent re-files; 8:00 the routine saves what it read.
  world.tables.notes[0].updated_at = V2;
  const first = await save(world, { edition: "am", date: DAY, content: { narrative: "Built.", work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V1 } }, items: [W3_ITEM] }, new Date("2026-10-29T12:00:00Z"));
  assert.equal(first.created, true);
  assert.deepEqual(first.work_digest_versions, [{ note_id: NOTE_AM, version: V1, as_read: true }]);
  assert.deepEqual(world.tables.briefs[0].content.work_digest_note_versions, { [NOTE_AM]: V1 });
  assert.deepEqual((await read()).refresh_needed.reasons, ["am_digest_updated"], "caught, though the save came after the re-file");

  // 8:45 catch-up reads V2; Brent re-files V3 at 8:44:10... before its save at 8:45:30.
  world.tables.notes[0].updated_at = V3;
  const refresh = await save(world, { edition: "am", date: DAY, mode: "refresh", refresh_reason: "AM work digest re-filed", content: { narrative: "Refreshed.", work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V2 } }, items: [W3_ITEM, W2_ITEM] }, new Date("2026-10-29T12:45:30Z"));
  assert.equal(refresh.mode, "refresh");
  assert.deepEqual(refresh.appended.map((entry) => entry.title), ["Suggest the location value for the import"], "the re-filed note's new item is appended");
  assert.deepEqual(world.tables.briefs[0].content.work_digest_note_versions, { [NOTE_AM]: V2 });
  assert.deepEqual((await read()).refresh_needed.reasons, ["am_digest_updated"], "V3 still news");

  // The next catch-up reads V3: clear.
  await save(world, { edition: "am", date: DAY, mode: "refresh", content: { narrative: "Refreshed again.", work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V3 } }, items: [W3_ITEM, W2_ITEM] }, new Date("2026-10-29T13:00:00Z"));
  assert.deepEqual((await read()).refresh_needed, { digest: false, reasons: [] });
  assert.equal(world.tables.briefs[0].content.work_digest_note_versions[NOTE_AM], V3);
});

await test("V5 a caller that sends no versions (the old prompt): the note's updated_at at save time is recorded, so a refresh right after a filing never asks again (no clock skew); a version later than the note's is not believed", async () => {
  const world = makeWorld({ notes: [amRow({ updated_at: V1 })] });
  // The app's save time is BEFORE the note's DB time (skew), as on colima.
  const first = await save(world, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM] }, items: [] }, new Date("2026-10-29T11:41:00.050Z"));
  assert.deepEqual(first.work_digest_versions, [{ note_id: NOTE_AM, version: V1, as_read: false }]);
  assert.equal((await service.getBriefStatus(fakeSupabase(world), USER, "am", DAY)).refresh_needed.digest, false);
  const future = makeWorld({ notes: [amRow({ updated_at: V1 })] });
  const bogus = await save(future, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V3 } }, items: [] }, new Date("2026-10-29T12:00:00Z"));
  assert.deepEqual(bogus.work_digest_versions, [{ note_id: NOTE_AM, version: V1, as_read: false }]);
  // A version for a note that isn't the caller's (or doesn't exist) records nothing.
  const stranger = makeWorld({ notes: [] });
  const none = await save(stranger, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V1 } }, items: [] }, new Date("2026-10-29T12:00:00Z"));
  assert.deepEqual(none.work_digest_versions, []);
  assert.equal("work_digest_note_versions" in stranger.tables.briefs[0].content, false);
});

await test("V6 a plain rerun keeps a known note's old version (it never takes in a re-filed note's items) and records a new note's; a refresh keeps the versions of notes it didn't read", async () => {
  const world = makeWorld({ notes: [amRow({ updated_at: V1 }), pmRow({ updated_at: "2026-10-29T20:31:00.5+00:00" })] });
  await save(world, { edition: "eod", date: DAY, content: { work_digest_note_ids: [NOTE_AM] }, items: [] }, new Date(T.eodBuilt));
  world.tables.notes[0].updated_at = V3;
  await save(world, { edition: "eod", date: DAY, content: { work_digest_note_ids: [NOTE_AM, NOTE_PM], work_digest_note_versions: { [NOTE_AM]: V3, [NOTE_PM]: "2026-10-29T20:31:00.5+00:00" } }, items: [] }, new Date("2026-10-29T20:40:00Z"));
  assert.deepEqual(world.tables.briefs[0].content.work_digest_note_versions, { [NOTE_AM]: V1, [NOTE_PM]: "2026-10-29T20:31:00.5+00:00" });
  const stale = await service.getBriefStatus(fakeSupabase(world), USER, "eod", DAY);
  assert.deepEqual(stale.refresh_needed.reasons, ["am_digest_updated"], "the rerun didn't take in V3, and brief_status still says so");
  // A refresh that reads only the AM note keeps the PM note's version.
  await save(world, { edition: "eod", date: DAY, mode: "refresh", content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: V3 } }, items: [] }, new Date("2026-10-29T21:00:00Z"));
  assert.deepEqual(world.tables.briefs[0].content.work_digest_note_versions, { [NOTE_AM]: V3, [NOTE_PM]: "2026-10-29T20:31:00.5+00:00" });
  assert.equal((await service.getBriefStatus(fakeSupabase(world), USER, "eod", DAY)).refresh_needed.digest, false);
});

await test("V7 the MCP tools ask for the versions: get_brief_digest names updated_at, the save tools take content.work_digest_note_versions, brief_status names brief_version", () => {
  const mcp = readFileSync(path.join(ROOT, "src/app/api/mcp/route.ts"), "utf8");
  assert.match(mcp, /`updated_at` \(the version you read/);
  assert.match(mcp, /work_digest_note_versions\{<note id>/);
  assert.match(mcp, /its updated_at from get_brief_digest in content\.work_digest_note_versions/);
  assert.match(mcp, /brief_version \(the version of the note the brief was built from\)/);
  for (const doc of ["docs/routines/morning.md", "docs/routines/eod.md"]) {
    assert.match(readFileSync(path.join(ROOT, doc), "utf8"), /work_digest_note_versions/, `${doc} tells the routine to send the versions`);
  }
});

await test("V8 a version sent cut to the millisecond or the second is the same version (no false re-file, no refresh loop); exact stays exact; a real re-file 1 s after the read is still caught", async () => {
  need(nv, "versionToRecord");
  const stored = "2026-10-29T11:41:00.217518+00:00";
  for (const [label, sent] of [["exact", stored], ["ms", "2026-10-29T11:41:00.217Z"], ["seconds", "2026-10-29T11:41:00Z"], ["ET offset, seconds", "2026-10-29T07:41:00-04:00"]]) {
    assert.deepEqual(nv.versionToRecord(sent, stored), { version: stored, as_read: true }, label);
  }
  // Not a cut of the current version: kept as sent (an older read).
  assert.deepEqual(nv.versionToRecord("2026-10-29T11:41:00.216Z", stored), { version: "2026-10-29T11:41:00.216Z", as_read: true });
  // End to end: the routine sends the times cut short; with no re-file, brief_status stays clear run after run.
  for (const sent of ["2026-10-29T11:41:00.217Z", "2026-10-29T11:41:00Z"]) {
    const world = makeWorld({ notes: [amRow({ updated_at: stored })] });
    await save(world, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: sent } }, items: [] }, new Date("2026-10-29T12:00:00Z"));
    assert.equal(world.tables.briefs[0].content.work_digest_note_versions[NOTE_AM], stored, `${sent} is stored as the note's own version`);
    assert.deepEqual((await service.getBriefStatus(fakeSupabase(world), USER, "am", DAY)).refresh_needed, { digest: false, reasons: [] }, sent);
    await save(world, { edition: "am", date: DAY, mode: "refresh", content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: sent } }, items: [] }, new Date("2026-10-29T12:45:00Z"));
    assert.equal((await service.getBriefStatus(fakeSupabase(world), USER, "am", DAY)).refresh_needed.digest, false, `${sent}: no refresh loop`);
  }
  // A real re-file 1 s after the read, with the read sent at ms or whole-second precision: caught.
  for (const sent of ["2026-10-29T11:41:00.217Z", "2026-10-29T11:41:00Z", stored]) {
    const world = makeWorld({ notes: [amRow({ updated_at: "2026-10-29T11:41:01.217518+00:00" })] });
    const result = await save(world, { edition: "am", date: DAY, content: { work_digest_note_ids: [NOTE_AM], work_digest_note_versions: { [NOTE_AM]: sent } }, items: [] }, new Date("2026-10-29T12:00:00Z"));
    assert.deepEqual(result.work_digest_versions, [{ note_id: NOTE_AM, version: sent, as_read: true }]);
    assert.deepEqual((await service.getBriefStatus(fakeSupabase(world), USER, "am", DAY)).refresh_needed.reasons, ["am_digest_updated"], `${sent}: re-filed 1 s after the read`);
  }
});

// ---------------------------------------------------------------------------
// (A) force: rebuild on command
// ---------------------------------------------------------------------------

await test("A1 validation: force true needs mode refresh; force false is a plain save; anything but a boolean is a 400", () => {
  const ok = parseSave({ edition: "am", date: DAY, items: [], mode: "refresh", force: true });
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  assert.equal(ok.value.force, true);
  const off = parseSave({ edition: "am", date: DAY, items: [], mode: "refresh", force: false });
  assert.equal(off.ok, true);
  assert.equal("force" in off.value, false);
  for (const body of [{ force: true }, { mode: "refresh", force: "yes" }, { mode: "refresh", force: 1 }]) {
    const bad = parseSave({ edition: "am", date: DAY, items: [], ...body });
    assert.equal(bad.ok, false, JSON.stringify(body));
  }
  assert.match(parseSave({ edition: "am", date: DAY, items: [], force: true }).errors.join(" "), /force only applies with mode "refresh"/);
});

await test("A2 forced rebuild with nothing new: content rewritten, old text in a revision, every item kept as Brent left it, no notice, no network call", async () => {
  const world = makeWorld({ notes: [amRow()] });
  const notifier = countingNotifier();
  const { first, item: before } = await builtMorning(world);
  assert.equal(first.notify.status, "sent");
  const briefBefore = structuredClone(world.tables.briefs[0]);
  // brief_status says nothing is new.
  need(service, "getBriefStatus");
  assert.equal((await service.getBriefStatus(fakeSupabase(world), USER, "am", DAY)).refresh_needed.digest, false);
  const { result, calls } = await withNoNetwork(() =>
    save(world, { edition: "am", date: DAY, mode: "refresh", force: true, content: { heading: "Thu, Oct 29", narrative: "Rebuilt text.", work_digest_note_ids: [NOTE_AM] }, items: [W3_ITEM] }, new Date("2026-10-29T14:30:00Z"), notifier)
  );
  assert.deepEqual(calls, [], "no outbound request (no Telegram, no n8n)");
  assert.deepEqual(notifier.sent, [], "the notifier was never called");
  assert.equal(result.mode, "refresh");
  assert.equal(result.forced, true);
  assert.equal(result.notify.status, "skipped_refresh");
  assert.equal(result.created, false);
  assert.deepEqual(result.appended, []);
  assert.deepEqual(result.skipped.map((skip) => [skip.reason, skip.n]), [["kept_on_refresh", 1]]);
  assert.deepEqual(world.tables.brief_items, [before]);
  const brief = world.tables.briefs[0];
  assert.equal(brief.content.narrative, "Rebuilt text.");
  assert.equal(brief.notified_at, briefBefore.notified_at, "notified_at untouched");
  assert.equal(brief.notify_sent_at, briefBefore.notify_sent_at);
  assert.equal(world.tables.brief_revisions.length, 1);
  assert.equal(world.tables.brief_revisions[0].content.narrative, "Old text.");
  assert.deepEqual(brief.content.refreshes, [{ at: "2026-10-29T14:30:00.000Z", reason: "Rebuilt on request" }], "a forced rebuild without a reason says so on the page");
  assert.ok(result.revision_id);
});

await test("A3 forced rebuild keeps the caller's reason when given", async () => {
  const world = makeWorld({ notes: [amRow()] });
  await builtMorning(world);
  await save(world, { edition: "am", date: DAY, mode: "refresh", force: true, refresh_reason: "rebuilt after Brent's edits", content: {}, items: [] }, new Date("2026-10-29T14:30:00Z"));
  assert.equal(world.tables.briefs[0].content.refreshes.at(-1).reason, "rebuilt after Brent's edits");
});

await test("A4 forced rebuild with no brief yet is refused (409): nothing created, no notice, no network call", async () => {
  need(service, "BriefServiceError");
  const world = makeWorld({ notes: [amRow()] });
  const notifier = countingNotifier();
  const { result, calls } = await withNoNetwork(async () => {
    try {
      await save(world, { edition: "eod", date: DAY, mode: "refresh", force: true, content: { narrative: "x" }, items: [] }, new Date(T.eodBuilt), notifier);
      return null;
    } catch (error) {
      return error;
    }
  });
  assert.ok(result, "expected a refusal");
  assert.equal(result.status, 409, result.message);
  assert.match(result.message, /no EOD brief for 2026-10-29 to rebuild/i);
  assert.deepEqual(calls, []);
  assert.deepEqual(notifier.sent, []);
  assert.deepEqual(world.tables.briefs, []);
  assert.deepEqual(world.tables.brief_items, []);
  assert.deepEqual(world.rpcCalls, []);
});

await test("A5 an unforced refresh with no brief is still a normal first save (with its one notice), unchanged", async () => {
  const world = makeWorld({ notes: [amRow()] });
  const notifier = countingNotifier();
  const result = await save(world, { edition: "am", date: DAY, mode: "refresh", content: {}, items: [] }, new Date(T.amBuilt), notifier);
  assert.equal(result.created, true);
  assert.equal(result.mode, "append");
  assert.equal(result.notify.status, "sent");
  assert.equal(notifier.sent.length, 1);
  assert.equal(result.forced, undefined);
});

await test("A6 the MCP tools and the API expose force the same way as mode: save_brief and save_eod_brief take force (boolean), the contract snapshot has it", () => {
  const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
  const mcp = read("src/app/api/mcp/route.ts");
  assert.match(mcp, /force: z\.boolean\(\)\.optional\(\)/);
  const snapshot = JSON.parse(read("scripts/fixtures/mcp-tools.snapshot.json"));
  for (const name of ["save_brief", "save_eod_brief"]) {
    const tool = snapshot.find((entry) => entry.name === name);
    assert.equal(tool?.inputSchema?.properties?.force?.type, "boolean", `${name} has force`);
  }
  // brief_status's description names the new reasons.
  assert.match(mcp, /am_digest_updated/);
  // The page passes "updated" notes to the banner.
  assert.match(read("src/app/briefs/[code]/page.tsx"), /updated:/);
  // The only routes that save a brief go through parseSaveBriefInput (no new auth path).
  assert.match(read("src/app/api/briefs/route.ts"), /parseSaveBriefInput\(/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
