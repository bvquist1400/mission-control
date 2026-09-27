#!/usr/bin/env node
// Database tests for the morning (AM) brief, against a LOCAL Supabase stack
// with every migration applied (same env as test-briefs-db.mjs):
//
//   BRIEFS_TEST_SUPABASE_URL=http://127.0.0.1:55321 \
//   BRIEFS_TEST_ANON_KEY=... BRIEFS_TEST_SERVICE_ROLE_KEY=... \
//   npm run test:briefs-am-db
//
// Covers: saving AM-MMDD next to EOD-MMDD, the latest-EOD lookup the morning
// run uses, the app-shell button across AM → EOD, the notice text on save,
// meeting prep tasks in the page view, and today's prep in the morning digest.
// Each test reports and the run continues, so a run against code without the
// morning changes shows every failing case.

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

// No real Telegram calls, ever.
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const service = await import("../src/lib/briefs/service.ts");
const { saveBrief, getBrief, actOnBriefItems, getTodayBriefStatus, BriefServiceError } = service;
const { briefButtonView } = await import("../src/lib/briefs/button.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");
const { buildDailyBriefDigest } = await import("../src/lib/briefing/digest.ts");

const APP_URL = "http://localhost:3000";
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split("\n").slice(0, 4).join("\n  ")}`);
  }
}

function fakeNotifier() {
  const sent = [];
  return { sent, send: async (text) => { sent.push(text); } };
}

async function makeUser(label) {
  const email = `briefs-am-test-${label}-${randomUUID().slice(0, 8)}@example.test`;
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
    .insert({ user_id: userId, title, status: "Planned", task_type: "Task", ...extra })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

function input(body) {
  const result = parseSaveBriefInput(body, new Date("2026-09-28T12:01:00Z"));
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

function actions(list) {
  const result = parseBriefActions(list);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

async function save(userId, body, notifier = fakeNotifier()) {
  return saveBrief(admin, userId, input(body), { appUrl: APP_URL, notifier });
}

/** Mon 9/28 8:05 AM EDT and 4:20 PM EDT. */
const MON_AM = new Date("2026-09-28T12:05:00Z");
const MON_PM = new Date("2026-09-28T20:20:00Z");

const users = [];
try {
  const alice = await makeUser("alice");
  const bob = await makeUser("bob");
  users.push(alice, bob);

  const iwg = await makeTask(alice.id, "Present IB 225 / Reporting Workbench routing request at Security IWG", { due_at: "2026-09-28T17:00:00Z" });
  const ayesha = await makeTask(alice.id, "Prep for Ayesha's OnCore billing/dataflow walkthrough", { due_at: "2026-09-28T23:59:00Z" });
  const homework = [
    await makeTask(alice.id, "Locate existing OnCore documentation"),
    await makeTask(alice.id, "Advarra University 300 — Basic Calendars"),
    await makeTask(alice.id, "Protocol Calendars chapter"),
  ];

  const amBody = {
    edition: "am",
    date: "2026-09-28",
    content: {
      heading: "Mon, Sep 28",
      narrative: "A lighter Monday than the count says.",
      stats: [
        { key: "due", label: "due today", value: 9 },
        { key: "meetings", label: "meetings", value: 3 },
      ],
      next: { label: "Today · Mon 9/28", agenda: [{ time: "8:00", title: "Free until 10 · IWG prep", free: true }, { time: "1:00", title: "Security IWG · you present, #1" }] },
      meetings: [
        { title: "Cayuse–iCooper Data Flow", start: "2026-09-28T14:00:00Z", end: "2026-09-28T15:00:00Z", has_notes: false, prep: "Go in listening." },
        { title: "Security IWG 2026", start: "2026-09-28T17:00:00Z", end: "2026-09-28T17:50:00Z", has_notes: false, prep: "You present.", task_ids: [iwg] },
      ],
      tiles: [
        { key: "lastnight", type: "list", label: "Since last night · EOD-0925", value: 2, suffix: "handled", href: "/briefs/EOD-0925" },
      ],
    },
    items: [
      { kind: "carry_over", title: "Present IB 225 / Reporting Workbench routing request at Security IWG", label: "Prep · Security IWG 1:00", task_ids: [iwg], why: "Due at the meeting." },
      { kind: "carry_over", title: "Prep for Ayesha's OnCore billing/dataflow walkthrough", label: "Due today · placeholder date", task_ids: [ayesha] },
      { kind: "carry_group", title: "Trainer Bootcamp homework", task_ids: homework },
    ],
  };

  await test("save: an AM brief gets AM-0928, am-scoped keys, and the morning notice text", async () => {
    const notifier = fakeNotifier();
    const result = await save(alice.id, amBody, notifier);
    assert.equal(result.code, "AM-0928");
    assert.equal(result.created, true);
    assert.equal(result.counts.open, 3);
    assert.deepEqual(result.appended.map((entry) => entry.item_key.split(":").slice(0, 3).join(":")), [
      "am:2026-09-28:carry_over",
      "am:2026-09-28:carry_over",
      "am:2026-09-28:carry_group",
    ]);
    assert.equal(result.notify.status, "sent");
    assert.deepEqual(notifier.sent, [`AM-0928 is ready · 3 to decide · 9 due today\n${APP_URL}/briefs/AM-0928\nOr in Claude: review AM-0928`]);
    const { data } = await admin.from("briefs").select("edition, code").eq("id", result.brief_id).single();
    assert.deepEqual(data, { edition: "am", code: "AM-0928" });
  });

  await test("page view: meeting prep, prep task summaries, free agenda lines and the tile href come back", async () => {
    const view = await getBrief(alice.client, alice.id, "AM-0928", { appUrl: APP_URL });
    assert.equal(view.brief.content.meetings[1].prep, "You present.");
    assert.deepEqual(view.brief.content.meetings[1].task_ids, [iwg]);
    assert.equal(view.tasks[iwg]?.title, "Present IB 225 / Reporting Workbench routing request at Security IWG");
    assert.equal(view.brief.content.next.agenda[0].free, true);
    assert.equal(view.brief.content.tiles[0].href, "/briefs/EOD-0925");
    // Another user's view never includes Alice's prep task.
    await assert.rejects(getBrief(bob.client, bob.id, "AM-0928", { appUrl: APP_URL }), (error) => error instanceof BriefServiceError && error.status === 404);
  });

  await test("button across AM → EOD: the AM brief until the EOD saves, then the EOD", async () => {
    const morning = await getTodayBriefStatus(admin, alice.id, { now: MON_AM });
    assert.deepEqual(morning && { code: morning.code, open: morning.open, total: morning.total }, { code: "AM-0928", open: 3, total: 3 });
    assert.equal(briefButtonView(morning).label, "AM-0928 · 3 to decide");

    // Brent decides one call on the AM page; the button follows.
    await actOnBriefItems(admin, alice.id, "AM-0928", actions([{ n: 2, action: "park" }]));
    assert.equal((await getTodayBriefStatus(alice.client, alice.id, { now: MON_AM })).open, 2);

    // The EOD saves at 4:15; the same task can be a call again tonight (its own key).
    const eod = await save(alice.id, {
      edition: "eod",
      date: "2026-09-28",
      content: { stats: [{ key: "done", label: "done", value: 4 }] },
      items: [{ kind: "carry_over", title: "Present IB 225", task_ids: [iwg] }],
    });
    assert.equal(eod.code, "EOD-0928");
    assert.equal(eod.appended[0].item_key, `eod:2026-09-28:carry_over:${iwg}`);
    const evening = await getTodayBriefStatus(alice.client, alice.id, { now: MON_PM });
    assert.deepEqual(evening && { code: evening.code, open: evening.open }, { code: "EOD-0928", open: 1 });
    assert.equal(briefButtonView(evening).label, "EOD-0928 · 1 to decide");

    // A later AM rerun doesn't take the button back: the brief created last wins, not the one touched last.
    await save(alice.id, { ...amBody, items: [] });
    assert.equal((await getTodayBriefStatus(alice.client, alice.id, { now: MON_PM })).code, "EOD-0928");
    // Bob sees neither.
    assert.equal(await getTodayBriefStatus(bob.client, bob.id, { now: MON_PM }), null);
  });

  await test("latest-EOD lookup: Friday's EOD on Monday morning; future and other users' briefs never count", async () => {
    const latest = service.getLatestBrief;
    assert.equal(typeof latest, "function", "service.getLatestBrief is missing");
    const carol = await makeUser("carol");
    users.push(carol);
    const quiet = fakeNotifier();
    for (const date of ["2026-09-24", "2026-09-25"]) {
      await save(carol.id, { edition: "eod", date, content: { stats: [{ key: "done", label: "done", value: 1 }] }, items: [] }, quiet);
    }
    // A brief dated after "now" (a mistaken future date) is not "the last EOD".
    await save(carol.id, { edition: "eod", date: "2026-09-29", items: [] }, quiet);
    await save(carol.id, { edition: "am", date: "2026-09-28", items: [] }, quiet);

    const monday = await latest(admin, carol.id, "eod", { appUrl: APP_URL, now: MON_AM });
    assert.equal(monday.brief.code, "EOD-0925");
    assert.equal(monday.url, `${APP_URL}/briefs/EOD-0925`);
    assert.ok(Array.isArray(monday.items));
    const before = await latest(admin, carol.id, "eod", { appUrl: APP_URL, before: "2026-09-25" });
    assert.equal(before.brief.code, "EOD-0924");
    // before= only tightens the bound: a future before never reaches a future-dated brief.
    const farBefore = await latest(admin, carol.id, "eod", { appUrl: APP_URL, now: MON_AM, before: "2027-01-01" });
    assert.equal(farBefore.brief.code, "EOD-0925");
    const am = await latest(carol.client, carol.id, "am", { appUrl: APP_URL, now: MON_AM });
    assert.equal(am.brief.code, "AM-0928");

    await assert.rejects(latest(bob.client, bob.id, "eod", { appUrl: APP_URL, now: MON_AM }), (error) => error instanceof BriefServiceError && error.status === 404);
    // Bob's client asking for Carol's id: RLS and the user filter both apply.
    await assert.rejects(latest(bob.client, carol.id, "eod", { appUrl: APP_URL, now: MON_AM }), (error) => error instanceof BriefServiceError && error.status === 404);
  });

  await test("digest morning: today's prep comes from today's (remaining) events; EOD has none", async () => {
    const dave = await makeUser("dave");
    users.push(dave);
    // A future Monday, so every event is still ahead whatever time the test runs.
    const day = "2027-03-01";
    const { error } = await admin.from("calendar_events").insert({
      user_id: dave.id,
      source: "local",
      external_event_id: `am-test-${randomUUID()}`,
      start_at: "2027-03-01T18:00:00Z",
      end_at: "2027-03-01T18:50:00Z",
      title: "Security IWG 2027",
      content_hash: "am-test",
    });
    if (error) throw error;
    const match = await makeTask(dave.id, "Present IB 225 request at Security IWG");
    const due = await makeTask(dave.id, "Draft the OnCore billing walkthrough", { due_at: "2027-03-01T19:00:00", estimated_minutes: 90 });
    await makeTask(dave.id, "Unrelated admin cleanup");

    const morning = await buildDailyBriefDigest({ supabase: admin, userId: dave.id, mode: "morning", date: day });
    assert.ok(Array.isArray(morning.tasks.today_prep), "tasks.today_prep is missing");
    const byId = Object.fromEntries(morning.tasks.today_prep.map((item) => [item.id, item.reason]));
    assert.equal(byId[match], "Related to: Security IWG 2027 at 1:00 PM");
    assert.equal(byId[due], "Due today (90 min) - block time for it early");
    assert.equal(Object.keys(byId).length, 2);

    const eod = await buildDailyBriefDigest({ supabase: admin, userId: dave.id, mode: "eod", date: day });
    assert.deepEqual(eod.tasks.today_prep, []);
  });
} finally {
  for (const user of users) {
    await admin.auth.admin.deleteUser(user.id).catch(() => null);
  }
}

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
