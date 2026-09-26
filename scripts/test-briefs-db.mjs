#!/usr/bin/env node
// Database tests for brief pages (migration 055 + src/lib/briefs/service.ts),
// run against a LOCAL Supabase stack with every migration applied:
//
//   BRIEFS_TEST_SUPABASE_URL=http://127.0.0.1:55321 \
//   BRIEFS_TEST_ANON_KEY=... BRIEFS_TEST_SERVICE_ROLE_KEY=... \
//   npm run test:briefs-db
//
// It creates two throwaway users, exercises the service the way the API/MCP
// path does (service-role client + explicit user id) and the way the page does
// (the user's own client, under RLS), then deletes the users.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.BRIEFS_TEST_SUPABASE_URL;
const anonKey = process.env.BRIEFS_TEST_ANON_KEY;
const serviceKey = process.env.BRIEFS_TEST_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error("Set BRIEFS_TEST_SUPABASE_URL, BRIEFS_TEST_ANON_KEY and BRIEFS_TEST_SERVICE_ROLE_KEY (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users. Local stacks only.`);
  process.exit(2);
}

// No real Telegram calls, ever: without these the default notifier fails fast before any network.
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, getBrief, actOnBriefItems, getTodayBriefStatus, BriefServiceError } = await import("../src/lib/briefs/service.ts");
const { briefButtonView } = await import("../src/lib/briefs/button.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");
const { resolveTomorrowDueAt } = await import("../src/lib/briefs/keys.ts");

const APP_URL = "http://localhost:3000";

/** A mocked notifier that records what it would have sent. */
function fakeNotifier() {
  const sent = [];
  return { sent, send: async (text) => { sent.push(text); } };
}
const quiet = fakeNotifier();
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function rejects(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BriefServiceError, `expected BriefServiceError, got ${error?.message ?? error}`);
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a rejection");
}

async function makeUser(label) {
  const email = `briefs-test-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

async function makeTask(userId, title, extra = {}) {
  const { data, error } = await admin
    .from("tasks")
    .insert({ user_id: userId, title, status: "Backlog", task_type: "Task", ...extra })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

function parsed(body) {
  const result = parseSaveBriefInput(body, new Date("2026-09-24T20:15:00Z"));
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

function actions(list) {
  const result = parseBriefActions(list);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

async function itemsOf(userId, code) {
  const view = await getBrief(admin, userId, code, { appUrl: APP_URL });
  return view.items;
}

async function eodProposalTasks(userId) {
  const { data, error } = await admin
    .from("tasks")
    .select("id, external_source_id, title, status")
    .eq("user_id", userId)
    .eq("external_source_system", "eod_proposal");
  if (error) throw error;
  return data;
}

const MEETING = {
  brenda: { id: "81eb535e-5db0-4276-acd6-8e46bdb5e88f", title: "Research nurse template with Brenda", start: "2026-09-24T17:01:00Z", url: "https://notes.granola.ai/d/81eb535e" },
  saif: { id: "58210575-4ec7-4414-9a03-008396aa05d4", title: "Brent-Saif 1:1", start: "2026-09-24T19:00:00Z", url: "https://notes.granola.ai/d/58210575" },
  dep: { id: "74775a7f-caca-4f8a-bf91-81bd32f1b60b", title: "DEP workgroup", start: "2026-09-24T13:43:00Z", url: "https://notes.granola.ai/d/74775a7f" },
  late: { id: "late-meeting-4pm", title: "Late afternoon sync", start: "2026-09-24T20:00:00Z", url: null },
};

function proposalItem(meeting, title, line) {
  return { kind: "proposed_task", title, source: { meetings: [{ ...meeting, lines: [line] }] } };
}

const users = [];
try {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  users.push(alice, bob);

  const pitch = await makeTask(alice.id, "Write the OnCore elevator pitch", { due_at: "2026-09-24T23:59:00Z" });
  const wave = [await makeTask(alice.id, "Verify consent scanning"), await makeTask(alice.id, "Import PDFs"), await makeTask(alice.id, "Doc type category")];
  const tracked = await makeTask(alice.id, "Modify roles for patient-study association");
  const bobTask = await makeTask(bob.id, "Bob's private task");

  const firstRun = {
    date: "2026-09-24",
    content: {
      heading: "Thu, Sep 24",
      narrative: "Today was a good day.",
      stats: [{ key: "done", label: "done", value: 19 }],
      next: { label: "Tomorrow · Fri 9/25", agenda: [{ time: "8:00", title: "DMG" }, { time: "10:00", title: "Two meetings", choice_item: 6 }] },
      meetings: [MEETING.dep, MEETING.brenda, MEETING.saif].map((m) => ({ ...m, has_notes: true })),
    },
    covered_meeting_ids: [MEETING.dep.id, MEETING.brenda.id, MEETING.saif.id],
    items: [
      proposalItem(MEETING.brenda, "Build the research nurse sub-template", "Build the research nurse sub-template (Brent)"),
      proposalItem(MEETING.brenda, "Verify research nurse job codes", "Verify research nurse job codes in CellPoint spreadsheet (Brent)"),
      {
        ...proposalItem(MEETING.saif, "Meet with Nathan before Tuesday", "Meet with Nathan before Tuesday (Brent)"),
        maybe_tracked: { task_id: tracked, text: "its waiting note mentions Nathan" },
      },
      proposalItem(MEETING.dep, "Work with Amy Lam on the encounter conversion table", "Work with Amy Lam on encounter conversion (Brent)"),
      { kind: "carry_over", title: "Write the OnCore elevator pitch", task_ids: [pitch], why: "Due tonight." },
      { kind: "carry_group", title: "Wave 2 consent cluster", task_ids: wave },
      {
        kind: "choice",
        title: "Two meetings at 10 AM tomorrow. Which one?",
        options: [
          { key: "bootcamp", label: "Trainer Bootcamp", recommended: true },
          { key: "workflows", label: "Research Technology Workflows" },
        ],
      },
    ],
  };

  let saved;
  await test("save creates EOD-0924 with items numbered in order", async () => {
    saved = await saveBrief(admin, alice.id, parsed(firstRun), { appUrl: APP_URL, notifier: quiet });
    assert.equal(saved.code, "EOD-0924");
    assert.equal(saved.created, true);
    assert.deepEqual(saved.appended.map((item) => item.n), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(saved.counts, { total: 7, open: 7, from_meetings: 4, calls: 3 });
    assert.equal(saved.url, "http://localhost:3000/briefs/EOD-0924");
    assert.equal(saved.notify.status, "sent");
    assert.equal(quiet.sent.length, 1);
    assert.match(quiet.sent[0], /^EOD-0924 is ready · 7 to decide · 19 done\nhttp:\/\/localhost:3000\/briefs\/EOD-0924\nOr in Claude: review EOD-0924$/);
    const { data: stored } = await admin.from("briefs").select("content").eq("id", saved.brief_id).single();
    assert.deepEqual(stored.content.next.agenda[1], { time: "10:00", title: "Two meetings", choice_n: 7 });
  });

  await test("a foreign task_id is rejected at save (carry_over and maybe_tracked), and nothing is written", async () => {
    const foreignCarry = parsed({ date: "2026-09-22", items: [{ kind: "carry_over", title: "Not yours", task_ids: [bobTask] }] });
    await rejects(saveBrief(admin, alice.id, foreignCarry, { appUrl: APP_URL, notifier: quiet }), 400, /Unknown task id/);
    const foreignMaybe = parsed({
      date: "2026-09-22",
      items: [{ ...proposalItem(MEETING.dep, "x", "y"), maybe_tracked: { task_id: bobTask, text: "peek" } }],
    });
    await rejects(saveBrief(admin, alice.id, foreignMaybe, { appUrl: APP_URL, notifier: quiet }), 400, /Unknown task id/);
    const { data } = await admin.from("briefs").select("id").eq("user_id", alice.id).eq("brief_date", "2026-09-22");
    assert.equal(data.length, 0);
  });

  await test("the database also rejects a foreign task id on a brief item (service-role write)", async () => {
    const { error } = await admin.from("brief_items").insert({
      user_id: alice.id,
      brief_id: saved.brief_id,
      n: 99,
      item_key: `raw:${randomUUID()}`,
      kind: "carry_over",
      task_ids: [bobTask],
    });
    assert.ok(error, "insert should fail");
    assert.equal(error.code, "23503");
  });

  await test("double accept = 1 task (sequential and concurrent)", async () => {
    const first = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 1, action: "accept" }]));
    const second = await actOnBriefItems(admin, alice.id, "eod-0924", actions([{ n: 1, action: "accept" }]));
    assert.equal(first.results[0].ok, true);
    assert.equal(second.results[0].already, true);
    assert.equal(second.results[0].task_id, first.results[0].task_id);

    const racers = await Promise.all(
      Array.from({ length: 4 }, () => actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 2, action: "accept" }])))
    );
    const racedIds = new Set(racers.map((r) => r.results[0].task_id));
    assert.equal(racedIds.size, 1, `concurrent accepts produced ${racedIds.size} tasks`);

    const tasks = await eodProposalTasks(alice.id);
    assert.equal(tasks.length, 2);
    const items = await itemsOf(alice.id, "EOD-0924");
    for (const n of [1, 2]) {
      const item = items.find((entry) => entry.n === n);
      assert.equal(item.state, "accepted");
      const task = tasks.find((entry) => entry.id === item.created_task_id);
      assert.ok(task, `#${n} points at its task`);
      assert.equal(task.external_source_id, item.item_key);
      assert.equal(task.status, "Backlog");
    }
  });

  await test("accept after dismiss reuses the key; accept of an accepted item via another code path is still one task", async () => {
    await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 4, action: "dismiss", reason: "not mine" }]));
    const accepted = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 4, action: "accept" }]));
    assert.equal(accepted.results[0].ok, true);
    // The page (user's own client, under RLS) accepting again lands on the same task.
    const viaPage = await actOnBriefItems(alice.client, alice.id, "EOD-0924", actions([{ n: 4, action: "accept" }]));
    assert.equal(viaPage.results[0].task_id, accepted.results[0].task_id);
    const item = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 4);
    assert.equal(item.dismissed_reason, null);
    assert.equal((await eodProposalTasks(alice.id)).length, 3);
  });

  await test("dismiss without a reason or a note is rejected by the service and by the table", async () => {
    await rejects(
      actOnBriefItems(admin, alice.id, "EOD-0924", [{ n: 3, action: "dismiss", reason: null, note: null, choice: null }]),
      400,
      /reason or a note/
    );
    const item = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 3);
    const { error } = await admin.from("brief_items").update({ state: "dismissed" }).eq("id", item.id);
    assert.ok(error, "check constraint should fire");
    assert.equal(error.code, "23514");

    const withNote = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 3, action: "dismiss", note: "Covering it with Nathan Friday" }]));
    assert.equal(withNote.results[0].state, "dismissed");
    const after = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 3);
    assert.equal(after.dismissed_reason, null);
    assert.equal(after.dismissed_note, "Covering it with Nathan Friday");
  });

  await test("validation runs before execution: one bad action means nothing changes", async () => {
    const before = await eodProposalTasks(alice.id);
    await rejects(
      actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 3, action: "undo" }, { n: 99, action: "accept" }])),
      400,
      /#99 isn't in EOD-0924/
    );
    await rejects(actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 5, action: "accept" }])), 400, /carry_over/);
    const item3 = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 3);
    assert.equal(item3.state, "dismissed", "#3 was not undone");
    assert.equal((await eodProposalTasks(alice.id)).length, before.length);
  });

  await test("choice records the pick; a bad key is rejected; undo clears it", async () => {
    await rejects(actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 7, action: "pick", choice: "gym" }])), 400, /bootcamp, workflows/);
    const picked = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 7, action: "pick", choice: "Bootcamp" }]));
    assert.equal(picked.results[0].choice, "bootcamp");
    let item = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 7);
    assert.equal(item.state, "decided");
    assert.equal(item.choice, "bootcamp");
    await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 7, action: "pick", choice: "workflows" }]));
    item = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 7);
    assert.equal(item.choice, "workflows");
    await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 7, action: "undo" }]));
    item = (await itemsOf(alice.id, "EOD-0924")).find((entry) => entry.n === 7);
    assert.equal(item.state, "open");
    assert.equal(item.choice, null);
    await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 7, action: "pick", choice: "bootcamp" }]));
  });

  await test("carry_over Tomorrow sets the next ET weekday; carry_group Park parks every task", async () => {
    const now = new Date();
    const result = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 5, action: "tomorrow" }, { n: 6, action: "park" }]), { now });
    assert.equal(result.results[0].due_at, resolveTomorrowDueAt("2026-09-24", now));
    const { data: pitchRow } = await admin.from("tasks").select("due_at").eq("id", pitch).single();
    assert.equal(new Date(pitchRow.due_at).toISOString(), result.results[0].due_at);
    const { data: waveRows } = await admin.from("tasks").select("status").in("id", wave);
    assert.deepEqual(waveRows.map((row) => row.status), ["Parked", "Parked", "Parked"]);
    const again = await actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 5, action: "tomorrow" }]));
    assert.equal(again.results[0].already, true);
    await rejects(actOnBriefItems(admin, alice.id, "EOD-0924", actions([{ n: 5, action: "park" }])), 400, /deferred/);
  });

  await test("a rerun appends only uncovered meetings; existing n, state and item_key never change", async () => {
    const before = await itemsOf(alice.id, "EOD-0924");
    const rerun = await saveBrief(
      admin,
      alice.id,
      parsed({
        ...firstRun,
        content: {
          narrative: "A rewritten narrative that must not replace the first one.",
          meetings: [...firstRun.content.meetings, { ...MEETING.late, has_notes: true }],
        },
        covered_meeting_ids: [...firstRun.covered_meeting_ids, MEETING.late.id],
        items: [
          // Same meeting, reworded: skipped because the meeting is covered.
          proposalItem(MEETING.brenda, "Build the RN sub-template (reworded)", "Build the research nurse sub-template (Brent)"),
          // Carry-overs are never appended on a rerun.
          { kind: "carry_over", title: "Write the pitch", task_ids: [pitch] },
          // New meeting: appended.
          proposalItem(MEETING.late, "Send the late-sync recap to Saif", "Send recap to Saif (Brent)"),
          // Duplicate within the request: skipped.
          proposalItem(MEETING.late, "Send the late-sync recap to Saif again", "Send recap to Saif (Brent)"),
        ],
      }),
      { appUrl: APP_URL }
    );
    assert.equal(rerun.created, false);
    assert.deepEqual(rerun.appended.map((item) => item.n), [8]);
    assert.deepEqual(
      rerun.skipped.map((skip) => skip.reason),
      ["meeting_already_covered", "rerun_only_appends_meeting_items", "duplicate_in_request"]
    );

    const after = await itemsOf(alice.id, "EOD-0924");
    const pick = ({ n, item_key, kind, state, choice, created_task_id, dismissed_reason, dismissed_note, payload }) => ({
      n, item_key, kind, state, choice, created_task_id, dismissed_reason, dismissed_note, title: payload.title,
    });
    assert.deepEqual(after.filter((item) => item.n <= 7).map(pick), before.map(pick));

    const { data: brief } = await admin.from("briefs").select("content, covered_meeting_ids").eq("id", saved.brief_id).single();
    assert.equal(brief.content.narrative, "Today was a good day.");
    assert.equal(brief.content.meetings.length, 4);
    assert.ok(brief.covered_meeting_ids.includes(MEETING.late.id));

    // Running the same rerun again appends nothing.
    const third = await saveBrief(admin, alice.id, parsed({ ...firstRun, covered_meeting_ids: [], items: [proposalItem(MEETING.late, "x", "Send recap to Saif (Brent)")] }), { appUrl: APP_URL, notifier: quiet });
    assert.deepEqual(third.appended, []);
  });

  await test("a proposal already in an earlier brief is not re-proposed on a later day", async () => {
    const nextDay = await saveBrief(
      admin,
      alice.id,
      parsed({ date: "2026-09-25", items: [proposalItem(MEETING.brenda, "Verify job codes (again)", "Verify research nurse job codes in CellPoint spreadsheet (Brent)")] }),
      { appUrl: APP_URL }
    );
    assert.equal(nextDay.code, "EOD-0925");
    assert.deepEqual(nextDay.skipped.map((skip) => skip.reason), ["already_in_a_brief"]);
  });

  await test("notify fires once per brief across reruns and racing first saves", async () => {
    const before = quiet.sent.length;
    const rerun = await saveBrief(admin, alice.id, parsed(firstRun), { appUrl: APP_URL, notifier: quiet });
    assert.equal(rerun.notify.status, "already_notified");
    assert.equal(quiet.sent.length, before, "a rerun must not notify again");

    const racer = fakeNotifier();
    const body = parsed({ date: "2026-09-29", items: [proposalItem(MEETING.dep, "Race item", "Race line (Brent)")] });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => saveBrief(admin, alice.id, body, { appUrl: APP_URL, notifier: racer }))
    );
    assert.equal(racer.sent.length, 1, `racing first saves sent ${racer.sent.length} notices`);
    const statuses = results.filter((r) => r.status === "fulfilled").map((r) => r.value.notify.status);
    assert.equal(statuses.filter((status) => status === "sent").length, 1);
  });

  await test("missing Telegram env: the save still succeeds and notify_error is recorded", async () => {
    const result = await saveBrief(
      admin,
      alice.id,
      parsed({ date: "2026-09-30", items: [proposalItem(MEETING.saif, "No env item", "No env line (Brent)")] }),
      { appUrl: APP_URL } // no notifier: the real Telegram one, with its env vars unset
    );
    assert.equal(result.created, true);
    assert.equal(result.appended.length, 1);
    assert.equal(result.notify.status, "failed");
    assert.match(result.notify.error, /isn't configured/);
    const { data } = await admin.from("briefs").select("notified_at, notify_error").eq("id", result.brief_id).single();
    assert.ok(data.notified_at);
    assert.match(data.notify_error, /BASELINE_TELEGRAM_BOT_TOKEN/);
    // A rerun doesn't retry (and so can't double-send after an ambiguous failure).
    const again = await saveBrief(admin, alice.id, parsed({ date: "2026-09-30", items: [] }), { appUrl: APP_URL, notifier: quiet });
    assert.equal(again.notify.status, "already_notified");
  });

  await test("button status: ET day, open → lit, all decided → done, no brief → nothing", async () => {
    // 10/5 11:30 PM ET is already 10/6 in UTC: the button must still show 10/5's brief.
    const lateEvening = new Date("2026-10-06T03:30:00Z");
    assert.equal(await getTodayBriefStatus(admin, alice.id, { now: lateEvening }), null);

    await saveBrief(
      admin,
      alice.id,
      parsed({
        date: "2026-10-05",
        items: [
          proposalItem(MEETING.brenda, "Button item", "Button line (Brent)"),
          { kind: "choice", title: "Pick one", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] },
        ],
      }),
      { appUrl: APP_URL, notifier: quiet }
    );

    const open = await getTodayBriefStatus(admin, alice.id, { now: lateEvening });
    assert.deepEqual(open, { code: "EOD-1005", brief_date: "2026-10-05", open: 2, total: 2 });
    assert.equal(briefButtonView(open).label, "EOD-1005 · 2 to decide");
    assert.equal(briefButtonView(open).tone, "open");

    await actOnBriefItems(admin, alice.id, "EOD-1005", actions([{ n: 1, action: "dismiss", reason: "not_worth_it" }, { n: 2, action: "pick", choice: "a" }]));
    const done = await getTodayBriefStatus(alice.client, alice.id, { now: lateEvening });
    assert.equal(done.open, 0);
    assert.equal(briefButtonView(done).label, "EOD-1005 · done");
    assert.equal(briefButtonView(done).tone, "done");

    // 12:30 AM ET on 10/6: a new day with no brief yet.
    assert.equal(await getTodayBriefStatus(admin, alice.id, { now: new Date("2026-10-06T04:30:00Z") }), null);
    // Another user never sees it.
    assert.equal(await getTodayBriefStatus(bob.client, bob.id, { now: lateEvening }), null);
    assert.equal(await getTodayBriefStatus(bob.client, alice.id, { now: lateEvening }), null);
  });

  await test("a new year's brief on the same day gets a longer code", async () => {
    const nextYear = await saveBrief(admin, alice.id, parsed({ date: "2027-09-24", items: [] }), { appUrl: APP_URL, notifier: quiet });
    assert.equal(nextYear.code, "EOD-09242027");
  });

  await test("ownership: another user can't read or act on the brief through the service", async () => {
    await rejects(getBrief(admin, bob.id, "EOD-0924", { appUrl: APP_URL }), 404);
    await rejects(actOnBriefItems(admin, bob.id, "EOD-0924", actions([{ n: 3, action: "undo" }])), 404);
    await rejects(getBrief(bob.client, bob.id, "EOD-0924", { appUrl: APP_URL }), 404);
    // Bob's own user id with Alice's code but Alice's client: RLS + the user filter both apply.
    await rejects(getBrief(alice.client, bob.id, "EOD-0924", { appUrl: APP_URL }), 404);
  });

  await test("RLS: users see and change only their own briefs and items; anon sees nothing", async () => {
    const own = await alice.client.from("brief_items").select("id").eq("brief_id", saved.brief_id);
    assert.equal(own.error, null);
    assert.equal(own.data.length, 8);

    const peek = await bob.client.from("briefs").select("id");
    assert.equal(peek.data.length, 0);
    const peekItems = await bob.client.from("brief_items").select("id");
    assert.equal(peekItems.data.length, 0);

    const tamper = await bob.client.from("brief_items").update({ state: "open" }).eq("brief_id", saved.brief_id).select("id");
    assert.equal(tamper.data.length, 0);
    const wipe = await bob.client.from("briefs").delete().eq("id", saved.brief_id).select("id");
    assert.equal(wipe.data.length, 0);

    // Bob inserting an item into Alice's brief: as himself it breaks the (brief_id, user_id) FK; as Alice it breaks RLS.
    const asBob = await bob.client.from("brief_items").insert({ user_id: bob.id, brief_id: saved.brief_id, n: 50, item_key: `x:${randomUUID()}`, kind: "choice" });
    assert.ok(asBob.error);
    const asAlice = await bob.client.from("brief_items").insert({ user_id: alice.id, brief_id: saved.brief_id, n: 51, item_key: `x:${randomUUID()}`, kind: "choice" });
    assert.ok(asAlice.error);
    assert.equal(asAlice.error.code, "42501");
    const fakeBrief = await bob.client.from("briefs").insert({ user_id: alice.id, edition: "eod", brief_date: "2026-01-02", code: "EOD-0102" });
    assert.equal(fakeBrief.error?.code, "42501");

    // Alice can't point an item at Bob's task even with her own client.
    const item = own.data[0];
    const sneak = await alice.client.from("brief_items").update({ task_ids: [bobTask] }).eq("id", item.id);
    assert.ok(sneak.error);

    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const anonBriefs = await anon.from("briefs").select("id");
    assert.equal((anonBriefs.data ?? []).length, 0);
    const anonItems = await anon.from("brief_items").select("id");
    assert.equal((anonItems.data ?? []).length, 0);

    const { count } = await admin.from("brief_items").select("id", { count: "exact", head: true }).eq("brief_id", saved.brief_id);
    assert.equal(count, 8, "nothing was inserted, changed or removed by Bob");
  });

  await test("the page path (user's client under RLS) reads the full view", async () => {
    const view = await getBrief(alice.client, alice.id, "EOD-0924", { appUrl: APP_URL });
    assert.equal(view.items.length, 8);
    assert.equal(view.tasks[tracked].title, "Modify roles for patient-study association");
    assert.equal(view.tasks[pitch].title, "Write the OnCore elevator pitch");
  });
} finally {
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id).catch(() => null);
  }
}

console.log(`\n${passed} passed`);
