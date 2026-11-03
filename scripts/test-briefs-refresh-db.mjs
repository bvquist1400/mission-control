#!/usr/bin/env node
// Database tests for brief refresh (Baseline task e8f1449d, migration 068), run
// against a LOCAL Supabase stack with every migration applied:
//
//   BRIEFS_TEST_SUPABASE_URL=$STACK_API_URL BRIEFS_TEST_ANON_KEY=$STACK_ANON_KEY \
//   BRIEFS_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY \
//   BRIEFS_TEST_DB_CONTAINER=$STACK_DB_CONTAINER npm run test:briefs-refresh-db
//
// (see "Local DB test stack" in CLAUDE.md). The real save path: mode "refresh"
// keeps every item byte for byte (accepted, dismissed, deferred, decided,
// parked, done), appends new ones as n+1, rewrites the content, writes a
// brief_revisions row, never sends a second notice; a refresh before the brief
// exists is a first save; brief_status; the boundary cut on a real save; RLS;
// two refreshes at once; 068 rollback and re-apply.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.BRIEFS_TEST_SUPABASE_URL;
const anonKey = process.env.BRIEFS_TEST_ANON_KEY;
const serviceKey = process.env.BRIEFS_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.BRIEFS_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set BRIEFS_TEST_SUPABASE_URL, BRIEFS_TEST_ANON_KEY, BRIEFS_TEST_SERVICE_ROLE_KEY and BRIEFS_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users. Local stacks only.`);
  process.exit(2);
}
if (!/^supabase_db_[A-Za-z0-9_-]+$/.test(dbContainer)) {
  console.error(`Refusing BRIEFS_TEST_DB_CONTAINER=${dbContainer}: expected a local supabase_db_<project> container.`);
  process.exit(2);
}

delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, getBrief, actOnBriefItems } = await import("../src/lib/briefs/service.ts");
const service = await import("../src/lib/briefs/service.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");

const APP_URL = "http://localhost:3000";
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8" }
  ).trim();
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
    const detail = error instanceof Error ? error.stack : JSON.stringify(error);
    console.log(`not ok - ${name}\n  ${String(detail).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const users = [];
async function makeUser(label) {
  const email = `briefs-refresh-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

async function makeTask(userId, title, extra = {}) {
  const { data, error } = await admin.from("tasks").insert({ user_id: userId, title, status: "Planned", task_type: "Task", ...extra }).select("id").single();
  if (error) throw error;
  return data.id;
}

const AM_FIXTURE = readFileSync(path.join(ROOT, "scripts/fixtures/work-digest/work-digest-2026-10-29-am.md"), "utf8");
const W3_LINE = "Nathan moved one study record to the test environment and asked Saif to check it works before he migrates the rest.";

/** Files a work digest note for `date` (the fixture with its date and edition swapped). */
async function fileDigest(userId, date, edition = "am") {
  const body = AM_FIXTURE.replace("date: 2026-10-29", `date: ${date}`).replace("edition: am", `edition: ${edition}`);
  const { data, error } = await admin
    .from("notes")
    .insert({ user_id: userId, title: `Work digest ${date} ${edition.toUpperCase()}`, body_markdown: body, note_type: "working_note" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

let dayOffset = 100;
/** A fresh brief date for each test, well in the past, so tests never share a brief. */
function nextDate() {
  dayOffset += 1;
  return psql(`SELECT ((now() AT TIME ZONE 'America/New_York')::DATE - ${dayOffset})::TEXT;`);
}

function input(body) {
  const parsed = parseSaveBriefInput({ edition: "am", content: {}, items: [], ...body }, new Date());
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return parsed.value;
}

function counter() {
  const sent = [];
  return { sent, notifier: { send: async (text) => void sent.push(text) } };
}

const save = (client, userId, body, notifier) => saveBrief(client, userId, input(body), { appUrl: APP_URL, notifier: notifier ?? { send: async () => {} } });

async function act(client, userId, code, list) {
  const parsed = parseBriefActions(list);
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  return actOnBriefItems(client, userId, code, parsed.value);
}

async function itemRows(briefId) {
  const { data, error } = await admin.from("brief_items").select("*").eq("brief_id", briefId).order("n");
  if (error) throw error;
  return data;
}

async function briefRow(briefId) {
  const { data, error } = await admin.from("briefs").select("*").eq("id", briefId).single();
  if (error) throw error;
  return data;
}

async function revisions(briefId) {
  const { data, error } = await admin.from("brief_revisions").select("*").eq("brief_id", briefId).order("replaced_at");
  if (error) throw error;
  return data;
}

const meeting = (id, line, title = "Planning sync") => ({ id, title, start: "2026-10-01T14:00:00Z", url: null, lines: [line] });

try {
  const user = await makeUser("a");
  const { client } = user;

  await test("068: brief_revisions and brief_refresh_content exist with grants, RLS on, and the four owner policies", async () => {
    assert.equal(psql(`SELECT relrowsecurity FROM pg_class WHERE relname = 'brief_revisions';`), "t");
    assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE tablename = 'brief_revisions';`), "4");
    assert.equal(psql(`SELECT has_function_privilege('authenticated', 'brief_refresh_content(uuid,uuid,jsonb,text[],jsonb)', 'EXECUTE');`), "t");
    assert.equal(psql(`SELECT has_function_privilege('anon', 'brief_refresh_content(uuid,uuid,jsonb,text[],jsonb)', 'EXECUTE');`), "f");
    assert.equal(psql(`SELECT has_table_privilege('authenticated', 'brief_revisions', 'SELECT');`), "t");
  });

  await test("refresh keeps every item byte for byte (accepted, dismissed, deferred, done, decided, parked), appends new ones as n+1, rewrites the content, and never notifies again", async () => {
    const date = nextDate();
    const [t1, t2, t3, t4] = await Promise.all(["Carry one", "Carry two", "Group a", "Group b"].map((title) => makeTask(user.id, title)));
    const { sent, notifier } = counter();
    const items = [
      { kind: "proposed_task", title: "Send the job codes", source: { meetings: [meeting("m1", "Brent to send the job codes")] } },
      { kind: "proposed_task", title: "Book the review", source: { meetings: [meeting("m1", "Book the review room")] } },
      { kind: "carry_over", title: "Carry one", task_ids: [t1] },
      { kind: "carry_over", title: "Carry two", task_ids: [t2] },
      { kind: "choice", title: "Bootcamp or IWG at 1", options: [{ key: "bootcamp", label: "Bootcamp" }, { key: "iwg", label: "IWG" }] },
      { kind: "carry_group", title: "Two homework tasks", task_ids: [t3, t4] },
    ];
    const first = await save(client, user.id, {
      date,
      content: { narrative: "Old narrative.", footnote: "Built at 7:57 without the AM digest.", next: { label: "Today", agenda: [{ time: "1:00", title: "Clash", choice_item: 4 }] }, tiles: [{ key: "mail", type: "list", label: "Old mail" }] },
      covered_meeting_ids: ["m1"],
      items,
    }, notifier);
    assert.equal(first.created, true);
    assert.equal(first.notify.status, "sent");
    assert.equal(sent.length, 1);
    assert.equal(first.mode, "append");

    const acted = await act(client, user.id, first.code, [
      { n: 1, action: "accept" },
      { n: 2, action: "dismiss", reason: "not_mine" },
      { n: 3, action: "tomorrow" },
      { n: 4, action: "done" },
      { n: 5, action: "pick", choice: "iwg" },
      { n: 6, action: "park" },
    ]);
    assert.ok(acted.results.every((result) => result.ok), JSON.stringify(acted.results));
    const before = await itemRows(first.brief_id);
    assert.deepEqual(before.map((row) => row.state), ["accepted", "dismissed", "deferred", "done", "decided", "parked"]);
    const briefBefore = await briefRow(first.brief_id);

    const note = await fileDigest(user.id, date);
    // The same six items reworded (titles and whys change; the keys don't), plus a digest proposal and a late meeting's.
    const reworded = items.map((item) => ({ ...item, title: `${item.title} (reworded)`, why: "new words" }));
    reworded[4] = { ...items[4], why: "new words" }; // a choice's key is its title + options: same title, same item
    const refresh = await save(client, user.id, {
      date,
      mode: "refresh",
      refresh_reason: "AM work digest added",
      content: {
        narrative: "New narrative with the digest.",
        footnote: "Built 7:57 without the AM digest; refreshed 8:45 when it arrived.",
        next: { label: "Today", agenda: [{ time: "1:00", title: "Clash", choice_item: 4 }, { time: "2:00", title: "Late item", choice_item: 6 }] },
        tiles: [{ key: "mail", type: "list", label: "From mail and Teams" }],
        work_digest_note_ids: [note],
        refreshes: [{ at: "2020-01-01T00:00:00Z", reason: "forged" }],
      },
      covered_meeting_ids: ["m1", "m2"],
      items: [
        ...reworded,
        { kind: "proposed_task", title: "Check the migrated record", source: { work_digest: { note_id: note, edition: "am", blocks: ["W3"], lines: [W3_LINE] } } },
        { kind: "proposed_task", title: "Late meeting item", source: { meetings: [meeting("m2", "Brent drafts the memo", "Late call")] } },
      ],
    }, notifier);

    assert.equal(refresh.created, false);
    assert.equal(refresh.mode, "refresh");
    assert.equal(refresh.notify.status, "skipped_refresh");
    assert.equal(sent.length, 1, "no second notice");
    assert.deepEqual(refresh.appended.map((entry) => entry.n), [7, 8]);
    assert.deepEqual(
      refresh.skipped.map((skip) => [skip.index, skip.reason, skip.n]),
      [[0, "kept_on_refresh", 1], [1, "kept_on_refresh", 2], [2, "kept_on_refresh", 3], [3, "kept_on_refresh", 4], [4, "kept_on_refresh", 5], [5, "kept_on_refresh", 6]]
    );

    const after = await itemRows(first.brief_id);
    assert.deepEqual(after.slice(0, 6), before, "the six existing rows are byte for byte the same, updated_at included");
    assert.deepEqual(after.slice(6).map((row) => [row.n, row.state, row.kind]), [[7, "open", "proposed_task"], [8, "open", "proposed_task"]]);

    const briefAfter = await briefRow(first.brief_id);
    assert.equal(briefAfter.notified_at, briefBefore.notified_at);
    assert.equal(briefAfter.notify_sent_at, briefBefore.notify_sent_at);
    assert.equal(briefAfter.content.narrative, "New narrative with the digest.");
    assert.equal(briefAfter.content.footnote, "Built 7:57 without the AM digest; refreshed 8:45 when it arrived.");
    assert.deepEqual(briefAfter.content.tiles.map((tile) => tile.label), ["From mail and Teams"]);
    assert.deepEqual(briefAfter.content.work_digest_note_ids, [note]);
    assert.deepEqual(briefAfter.covered_meeting_ids, ["m1", "m2"]);
    assert.equal(briefAfter.content.refreshes.length, 1, "the caller's forged refresh record is ignored");
    assert.equal(briefAfter.content.refreshes[0].reason, "AM work digest added");
    assert.deepEqual(briefAfter.content.next.agenda.map((line) => line.choice_n), [5, 7], "agenda links resolve to the kept choice (#5) and an appended item (#7)");

    const [revision] = await revisions(first.brief_id);
    assert.equal(revision.id, refresh.revision_id);
    assert.equal(revision.content.narrative, "Old narrative.");
    assert.equal(revision.content.footnote, "Built at 7:57 without the AM digest.");
    assert.deepEqual(revision.covered_meeting_ids, ["m1"]);
    assert.equal(revision.reason, "AM work digest added");
    assert.equal(new Date(revision.saved_at).getTime(), new Date(briefBefore.updated_at).getTime());

    // The page reads it: the refresh line's data and every state.
    const view = await getBrief(client, user.id, first.code, { appUrl: APP_URL });
    assert.equal(view.brief.content.refreshes.length, 1);
    assert.deepEqual(view.items.map((item) => item.state), ["accepted", "dismissed", "deferred", "done", "decided", "parked", "open", "open"]);

    // A second refresh with nothing new: no items appended, a second revision, two refresh records, still one notice.
    const again = await save(client, user.id, { date, mode: "refresh", refresh_reason: "late meeting notes", content: { narrative: "Third." }, covered_meeting_ids: [], items: reworded }, notifier);
    assert.deepEqual(again.appended, []);
    assert.equal(sent.length, 1);
    const third = await briefRow(first.brief_id);
    assert.equal(third.content.refreshes.length, 2);
    assert.equal(third.content.footnote, undefined, "a field the refresh leaves out is gone (the old one is in the revision)");
    assert.deepEqual(third.content.work_digest_note_ids, [note], "notes read are a union, never lost");
    assert.deepEqual(third.covered_meeting_ids, ["m1", "m2"], "coverage is a union, never lost");
    const all = await revisions(first.brief_id);
    assert.equal(all.length, 2);
    assert.equal(all[1].content.narrative, "New narrative with the digest.");
    assert.deepEqual(await itemRows(first.brief_id), after);
  });

  await test("the kept choice's agenda link survives a refresh (choice_item resolves to the kept item's n)", async () => {
    const date = nextDate();
    const choice = { kind: "choice", title: "Clash at 1", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] };
    const first = await save(client, user.id, { date, content: { next: { label: "Today", agenda: [{ time: "1:00", title: "Clash", choice_item: 0 }] } }, items: [choice] });
    await act(client, user.id, first.code, [{ n: 1, action: "pick", choice: "b" }]);
    await save(client, user.id, { date, mode: "refresh", content: { next: { label: "Today", agenda: [{ time: "9:00", title: "Free", free: true }, { time: "1:00", title: "Clash", choice_item: 0 }] } }, items: [choice] });
    const row = await briefRow(first.brief_id);
    assert.deepEqual(row.content.next.agenda, [{ time: "9:00", title: "Free", free: true }, { time: "1:00", title: "Clash", choice_n: 1 }]);
  });

  await test("refresh still follows today's append rules: a proposal from a covered meeting with a new line is skipped, already_in_a_brief holds across briefs, a reworded digest citation is refused", async () => {
    const date = nextDate();
    const first = await save(client, user.id, { date, covered_meeting_ids: ["mc"], items: [{ kind: "proposed_task", title: "One", source: { meetings: [meeting("mc", "line one")] } }] });
    const refresh = await save(client, user.id, {
      date,
      mode: "refresh",
      items: [
        { kind: "proposed_task", title: "Two", source: { meetings: [meeting("mc", "a new line from a covered meeting")] } },
        { kind: "carry_over", title: "A new carry", task_ids: [await makeTask(user.id, "c")] },
      ],
    });
    assert.deepEqual(refresh.appended, []);
    assert.deepEqual(refresh.skipped.map((skip) => skip.reason), ["meeting_already_covered", "rerun_only_appends_meeting_items"]);

    // A proposal already on ANOTHER brief stays there.
    const other = nextDate();
    await save(client, user.id, { date: other, items: [{ kind: "proposed_task", title: "Elsewhere", source: { meetings: [meeting("mx", "elsewhere line")] } }] });
    const cross = await save(client, user.id, { date, mode: "refresh", items: [{ kind: "proposed_task", title: "Elsewhere", source: { meetings: [meeting("mx", "elsewhere line")] } }] });
    assert.deepEqual(cross.skipped.map((skip) => skip.reason), ["already_in_a_brief"]);

    const note = await fileDigest(user.id, date);
    await assert.rejects(
      save(client, user.id, { date, mode: "refresh", items: [{ kind: "proposed_task", title: "Bad", source: { work_digest: { note_id: note, edition: "am", blocks: ["W3"], lines: ["Nathan moved a record."] } } }] }),
      (error) => error.status === 400
    );
    assert.equal((await revisions(first.brief_id)).length, 2, "two refreshes saved; the refused one wrote nothing");
  });

  await test("a refresh before the brief exists is a first save: created, the one notice, no revision, no refresh record", async () => {
    const date = nextDate();
    const { sent, notifier } = counter();
    const result = await save(client, user.id, { date, mode: "refresh", refresh_reason: "catch-up", content: { narrative: "Built by the catch-up.", refreshes: [{ at: "2020-01-01T00:00:00Z" }] } }, notifier);
    assert.equal(result.created, true);
    assert.equal(result.mode, "append");
    assert.equal(result.revision_id, null);
    assert.equal(result.notify.status, "sent");
    assert.equal(sent.length, 1);
    const row = await briefRow(result.brief_id);
    assert.ok(row.notified_at);
    assert.equal(row.content.narrative, "Built by the catch-up.");
    assert.equal(row.content.refreshes, undefined);
    assert.equal((await revisions(result.brief_id)).length, 0);
  });

  await test("the default save is unchanged: a rerun doesn't rewrite the content, keeps refresh records, and says already_claimed", async () => {
    const date = nextDate();
    const first = await save(client, user.id, { date, content: { narrative: "Original." } });
    await save(client, user.id, { date, mode: "refresh", refresh_reason: "r", content: { narrative: "Refreshed." } });
    const rerun = await save(client, user.id, { date, content: { narrative: "A rerun's words are ignored." }, items: [] });
    assert.equal(rerun.mode, "append");
    assert.equal(rerun.notify.status, "already_claimed");
    const row = await briefRow(first.brief_id);
    assert.equal(row.content.narrative, "Refreshed.");
    assert.equal(row.content.refreshes.length, 1);
  });

  await test("the boundary cut on a real save: a 600-character footnote is kept whole; one over 1,200 ends at a sentence with … and the reply warns", async () => {
    const date = nextDate();
    const whole = `${"Footnote words that carry on. ".repeat(20)}`.trim().slice(0, 600);
    const kept = await save(client, user.id, { date, content: { footnote: whole } });
    assert.equal((await briefRow(kept.brief_id)).content.footnote, whole);
    assert.deepEqual(kept.warnings, []);
    const long = Array.from({ length: 30 }, (_, index) => `Sentence ${index} says something useful about the day.`).join(" ");
    const cut = await save(client, user.id, { date, mode: "refresh", content: { footnote: long } });
    const stored = (await briefRow(kept.brief_id)).content.footnote;
    assert.ok(stored.length <= 1200);
    assert.ok(stored.endsWith("the day.…"), stored.slice(-20));
    assert.deepEqual(cut.warnings.map((warning) => [warning.field, warning.original_length]), [["content.footnote", long.length]]);
  });

  await test("brief_status: build before the brief exists; refresh once the AM note is filed after it; clear after the refresh; EOD covers PM, and AM only when the morning brief lacked it", async () => {
    const date = nextDate();
    let status = await service.getBriefStatus(client, user.id, "am", date);
    assert.equal(status.brief.exists, false);
    assert.deepEqual(status.refresh_needed, { digest: false, reasons: [] });
    assert.equal(status.digest_notes[0].status, "missing");

    const am = await save(client, user.id, { date, covered_meeting_ids: ["g1"] });
    const note = await fileDigest(user.id, date);
    status = await service.getBriefStatus(client, user.id, "am", date);
    assert.equal(status.brief.exists, true);
    assert.equal(status.brief.code, am.code);
    assert.deepEqual(status.brief.covered_meeting_ids, ["g1"]);
    assert.deepEqual(status.refresh_needed, { digest: true, reasons: ["am_digest_not_in_brief"] });
    assert.equal(status.digest_notes[0].note_id, note);
    assert.ok(status.digest_notes[0].filed_at);

    await save(client, user.id, { date, mode: "refresh", refresh_reason: "AM work digest added", content: { work_digest_note_ids: [note] } });
    status = await service.getBriefStatus(client, user.id, "am", date);
    assert.deepEqual(status.refresh_needed, { digest: false, reasons: [] });
    assert.equal(status.brief.refresh_count, 1);
    assert.equal(status.brief.last_refresh.reason, "AM work digest added");

    // EOD: the AM note is in the morning brief, so only the PM note matters.
    await save(client, user.id, { edition: "eod", date });
    status = await service.getBriefStatus(client, user.id, "eod", date);
    assert.deepEqual(status.refresh_needed, { digest: false, reasons: [] });
    assert.equal(status.digest_notes.find((entry) => entry.edition === "am").in_morning_brief, true);
    await fileDigest(user.id, date, "pm");
    status = await service.getBriefStatus(client, user.id, "eod", date);
    assert.deepEqual(status.refresh_needed.reasons, ["pm_digest_not_in_brief"]);

    // Another user's notes and briefs never show.
    const other = await makeUser("status");
    const theirs = await service.getBriefStatus(other.client, other.id, "am", date);
    assert.equal(theirs.brief.exists, false);
    assert.equal(theirs.digest_notes[0].status, "missing");
  });

  await test("RLS: another user can't read a brief's revisions or refresh it; the machine key's service-role client can refresh", async () => {
    const date = nextDate();
    const first = await save(client, user.id, { date, content: { narrative: "Mine." } });
    await save(client, user.id, { date, mode: "refresh", content: { narrative: "Mine again." } });
    const intruder = await makeUser("intruder");
    const { data: seen } = await intruder.client.from("brief_revisions").select("id").eq("brief_id", first.brief_id);
    assert.deepEqual(seen, []);
    const { error } = await intruder.client.rpc("brief_refresh_content", {
      p_user_id: user.id,
      p_brief_id: first.brief_id,
      p_content: { narrative: "hijack" },
      p_covered_meeting_ids: [],
      p_refresh: { at: new Date().toISOString() },
    });
    assert.equal(error?.code, "42501");
    const { data: own } = await intruder.client.rpc("brief_refresh_content", {
      p_user_id: intruder.id,
      p_brief_id: first.brief_id,
      p_content: { narrative: "hijack" },
      p_covered_meeting_ids: [],
      p_refresh: { at: new Date().toISOString() },
    });
    assert.deepEqual(own, { ok: false, reason: "not_found" });
    assert.equal((await briefRow(first.brief_id)).content.narrative, "Mine again.");

    const viaKey = await save(admin, user.id, { date, mode: "refresh", content: { narrative: "Via the key." } });
    assert.equal(viaKey.mode, "refresh");
    assert.equal((await briefRow(first.brief_id)).content.narrative, "Via the key.");
    assert.equal((await revisions(first.brief_id)).length, 2);
  });

  await test("two refreshes at once: both land, each revision holds the content it replaced (none lost), two refresh records", async () => {
    const date = nextDate();
    const first = await save(client, user.id, { date, content: { narrative: "Start." } });
    await Promise.all([
      save(client, user.id, { date, mode: "refresh", refresh_reason: "one", content: { narrative: "One." } }),
      save(admin, user.id, { date, mode: "refresh", refresh_reason: "two", content: { narrative: "Two." } }),
    ]);
    const row = await briefRow(first.brief_id);
    const revs = await revisions(first.brief_id);
    assert.equal(revs.length, 2);
    assert.equal(row.content.refreshes.length, 2);
    const final = row.content.narrative;
    const other = final === "One." ? "Two." : "One.";
    assert.ok(["One.", "Two."].includes(final));
    assert.deepEqual(revs.map((revision) => revision.content.narrative).sort(), ["Start.", other].sort());
    assert.equal(row.content.refreshes[1].reason, final === "One." ? "one" : "two", "the last record is the content on the page");
  });

  await test("068 rolls back and re-applies cleanly (briefs keep their refreshed content)", async () => {
    const date = nextDate();
    const first = await save(client, user.id, { date, content: { narrative: "Before." } });
    await save(client, user.id, { date, mode: "refresh", content: { narrative: "After." } });
    const migration = readFileSync(path.join(ROOT, "supabase/migrations/068_brief_revisions.sql"), "utf8");
    psql(readFileSync(path.join(ROOT, "supabase/rollbacks/068_brief_revisions.down.sql"), "utf8"));
    try {
      assert.equal(psql(`SELECT to_regclass('public.brief_revisions') IS NULL;`), "t");
      assert.equal(psql(`SELECT count(*) FROM pg_proc WHERE proname = 'brief_refresh_content';`), "0");
      assert.equal((await briefRow(first.brief_id)).content.narrative, "After.");
    } finally {
      // Always put 068 back (twice: re-applying is safe), so a failure here never leaves the stack without it.
      psql(migration);
      psql(migration);
      psql(`NOTIFY pgrst, 'reload schema';`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(psql(`SELECT count(*) FROM pg_policies WHERE tablename = 'brief_revisions';`), "4");
    const again = await save(client, user.id, { date, mode: "refresh", content: { narrative: "Again." } });
    assert.equal(again.mode, "refresh");
    assert.equal((await revisions(first.brief_id)).length, 1);
  });
} finally {
  for (const id of users) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
