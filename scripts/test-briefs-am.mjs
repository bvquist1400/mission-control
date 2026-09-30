#!/usr/bin/env node
// Pure tests for the morning (AM) brief on the brief-page system: the AM code
// and item keys, the ready notice's headline stat, the tile href allowlist,
// upcoming vs past blocks on the day timeline, prep from today's events, and
// the MCP save_brief / get_brief surface. No database; see test-briefs-am-db.mjs.
//
// Each test reports and the run continues, so a run against code without the
// morning changes shows every failing case, not just the first.

import assert from "node:assert/strict";

process.env.MISSION_CONTROL_API_KEY ||= "contract-test-key";
process.env.MISSION_CONTROL_USER_ID ||= "00000000-0000-0000-0000-000000000000";
process.env.DEPLOYMENT_ROLE = "main";
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const keys = await import("../src/lib/briefs/keys.ts");
const validate = await import("../src/lib/briefs/validate.ts");
const { buildBriefNotice } = await import("../src/lib/briefs/notify.ts");
const { identifyPrepTasks } = await import("../src/lib/briefing/prep-tasks.ts");
const digestModule = await import("../src/lib/briefing/digest.ts").catch((error) => ({ missing: error.message }));
const timeline = await import("../src/components/briefs/timeline.ts").catch((error) => ({ missing: error.message }));

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.message ?? error).split("\n").join("\n  ")}`);
  }
}

function needTimeline() {
  assert.ok(!timeline.missing, `src/components/briefs/timeline.ts: ${timeline.missing}`);
  return timeline;
}

const TASK_IWG = "08716a41-7c5d-4c55-9b0e-3a1d2c4b5e6f";
const TASK_AYESHA = "89c3d20f-1111-4a2b-8c3d-4e5f60718293";
const ET_OFFSET = "-04:00"; // EDT on 9/28/2026

// ---------------------------------------------------------------------------
// (a) edition 'am': code and keys
// ---------------------------------------------------------------------------

await test("AM code is AM-MMDD (year appended on a clash), and 'am' is an accepted edition", () => {
  assert.equal(keys.buildBriefCode("am", "2026-09-28"), "AM-0928");
  assert.equal(keys.buildBriefCode("am", "2027-09-28", true), "AM-09282027");
  const parsed = validate.parseSaveBriefInput({ edition: "am", date: "2026-09-28", items: [] });
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  assert.equal(parsed.value.edition, "am");
  const upper = validate.parseSaveBriefInput({ edition: " AM ", date: "2026-09-28", items: [] });
  assert.equal(upper.ok, true, upper.errors?.join("; "));
  assert.equal(upper.value.edition, "am");
  const bad = validate.parseSaveBriefInput({ edition: "midday", items: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /edition must be one of eod, am/);
});

await test("AM item keys are scoped to the edition, so a task can be a call in the AM and the EOD brief on one day", () => {
  const item = { kind: "carry_over", payload: { title: "Present IB 225" }, task_ids: [TASK_IWG], source: { meetings: [] } };
  const am = keys.computeBriefItemKey("am", "2026-09-28", item);
  const eod = keys.computeBriefItemKey("eod", "2026-09-28", item);
  assert.equal(am, `am:2026-09-28:carry_over:${TASK_IWG}`);
  assert.equal(eod, `eod:2026-09-28:carry_over:${TASK_IWG}`);
  assert.notEqual(am, eod);
});

// ---------------------------------------------------------------------------
// (f) the notice's headline stat is the first stat, whatever its key
// ---------------------------------------------------------------------------

await test("notice: the morning's first stat is the headline (no 'done' key needed)", () => {
  const counts = { total: 3, open: 3, from_meetings: 0, calls: 3 };
  const text = buildBriefNotice("AM-0928", "https://example.test/briefs/AM-0928", counts, {
    stats: [
      { key: "due", label: "due today", value: 9 },
      { key: "meetings", label: "meetings", value: 3 },
      { key: "waiting", label: "waiting on others", value: 7 },
    ],
  });
  assert.equal(
    text,
    "AM-0928 is ready · 3 to decide · 9 due today\nhttps://example.test/briefs/AM-0928\nOr in Claude: review AM-0928"
  );
});

await test("notice: the EOD shape is unchanged ('19 done' first), and no stats means no third part", () => {
  const counts = { total: 13, open: 6, from_meetings: 5, calls: 1 };
  const eod = buildBriefNotice("EOD-0925", "u", counts, {
    stats: [
      { key: "done", label: "done", value: 19 },
      { key: "rolling", label: "rolling", value: 14 },
    ],
  });
  assert.equal(eod.split("\n")[0], "EOD-0925 is ready · 6 to decide · 19 done");
  // As on main: a "done" stat is the headline wherever the model put it.
  const reordered = buildBriefNotice("EOD-0930", "u", counts, {
    stats: [
      { key: "notes", label: "notes read", value: 5 },
      { key: "done", label: "done", value: 19 },
    ],
  });
  assert.equal(reordered.split("\n")[0], "EOD-0930 is ready · 6 to decide · 19 done");
  assert.equal(buildBriefNotice("AM-0928", "u", counts, {}).split("\n")[0], "AM-0928 is ready · 6 to decide");
});

// ---------------------------------------------------------------------------
// (d) tile href: only /briefs/<CODE>
// ---------------------------------------------------------------------------

await test("tile href allowlist: /briefs/<CODE> for a known edition survives; everything else is dropped", () => {
  const { safeBriefHref } = validate;
  assert.equal(typeof safeBriefHref, "function", "validate.safeBriefHref is missing");
  assert.equal(safeBriefHref("/briefs/EOD-0927"), "/briefs/EOD-0927");
  assert.equal(safeBriefHref(" /briefs/eod-0927 "), "/briefs/EOD-0927");
  assert.equal(safeBriefHref("/briefs/AM-0928"), "/briefs/AM-0928");
  assert.equal(safeBriefHref("/briefs/EOD-09242027"), "/briefs/EOD-09242027");
  for (const bad of [
    "https://evil.example/briefs/EOD-0927",
    "//evil.example/briefs/EOD-0927",
    "javascript:alert(1)",
    "/briefs/EOD-0927?x=1",
    "/briefs/EOD-0927#top",
    "/briefs/EOD-0927/",
    "/briefs/../settings",
    "/briefs/MIDDAY-0928",
    "/briefs/EOD-927",
    "/briefs/EOD%2D0927",
    "/tasks",
    "/r/task/08716a41",
    "",
    42,
    null,
  ]) {
    assert.equal(safeBriefHref(bad), null, `should drop ${JSON.stringify(bad)}`);
  }
});

await test("tile href: content keeps an allowed href and drops a bad one without dropping the tile", () => {
  const content = validate.normalizeBriefContent({
    tiles: [
      { key: "lastnight", type: "list", label: "Since last night · EOD-0927", value: 2, suffix: "handled", href: "/briefs/EOD-0927" },
      { key: "evil", type: "list", label: "Evil", href: "https://evil.example/briefs/EOD-0927" },
    ],
  });
  assert.equal(content.tiles.length, 2);
  assert.equal(content.tiles[0].href, "/briefs/EOD-0927");
  assert.equal("href" in content.tiles[1], false);
});

// ---------------------------------------------------------------------------
// (c) content: meetings[].prep / task_ids, agenda free lines; EOD content round-trips unchanged
// ---------------------------------------------------------------------------

await test("content keeps meetings[].prep and task_ids (own UUIDs only) and agenda free lines", () => {
  const content = validate.normalizeBriefContent({
    next: {
      label: "Today · Mon 9/28",
      agenda: [
        { time: "8:00", title: "Free until 10 · IWG prep", free: true },
        { time: "1:00", title: "Security IWG · you present, #1" },
      ],
    },
    meetings: [
      {
        title: "Security IWG 2026",
        start: `2026-09-28T13:00:00${ET_OFFSET}`,
        end: `2026-09-28T13:50:00${ET_OFFSET}`,
        has_notes: false,
        prep: "Present the IB 225 request. Bring the SUP screenshots.",
        task_ids: [TASK_IWG.toUpperCase(), "not-a-uuid", TASK_IWG],
      },
    ],
  });
  assert.equal(content.next.agenda[0].free, true);
  assert.equal("free" in content.next.agenda[1], false);
  assert.equal(content.meetings[0].prep, "Present the IB 225 request. Bring the SUP screenshots.");
  assert.deepEqual(content.meetings[0].task_ids, [TASK_IWG]);
});

await test("EOD content without the new fields round-trips with no new keys", () => {
  const eod = {
    heading: "Thu, Sep 24",
    stats: [{ key: "done", label: "done", value: 19 }],
    next: { label: "Tomorrow · Fri 9/25", agenda: [{ time: "8:00", title: "DMG" }] },
    meetings: [
      { id: "81eb535e", title: "Brenda", short: "Brenda", start: "2026-09-24T17:01:00.000Z", end: "2026-09-24T17:30:00.000Z", url: null, has_notes: true },
      { id: null, title: "Change Control", short: null, start: "2026-09-24T18:00:00.000Z", end: null, url: null, has_notes: false },
    ],
    tiles: [{ key: "done", type: "list", label: "Done today", value: 19 }],
  };
  assert.deepEqual(validate.normalizeBriefContent(eod), eod);
});

// ---------------------------------------------------------------------------
// (c) timeline: upcoming vs past blocks, free bands, the save marker
// ---------------------------------------------------------------------------

const AM_MEETINGS = [
  { id: null, title: "Cayuse–iCooper Data Flow", short: null, start: `2026-09-28T10:00:00${ET_OFFSET}`, end: `2026-09-28T11:00:00${ET_OFFSET}`, url: null, has_notes: false, prep: "Go in listening." },
  { id: null, title: "Security IWG 2026", short: null, start: `2026-09-28T13:00:00${ET_OFFSET}`, end: `2026-09-28T13:50:00${ET_OFFSET}`, url: null, has_notes: false, prep: "You present.", task_ids: [TASK_IWG] },
  { id: null, title: "OnCore CTMS Weekly Project Status", short: null, start: `2026-09-28T14:00:00${ET_OFFSET}`, end: `2026-09-28T15:00:00${ET_OFFSET}`, url: null, has_notes: false },
];

await test("timeline: a morning's meetings are all upcoming, with free bands and the mockup's heading", () => {
  const { buildDayTimeline, timelineHeading } = needTimeline();
  const model = buildDayTimeline(AM_MEETINGS, `2026-09-28T08:01:00${ET_OFFSET}`);
  assert.deepEqual(model.spans.map((span) => span.upcoming), [true, true, true]);
  assert.equal(model.upcoming, 3);
  assert.equal(model.withPrep, 1);
  assert.deepEqual(model.free, [
    { start: 8 * 60 + 1, end: 10 * 60 },
    { start: 11 * 60, end: 13 * 60 },
    { start: 15 * 60, end: 16 * 60 + 30 },
  ]);
  assert.equal(timelineHeading(model), "3 on the calendar, 1 with prep tracked · free 5h 30m");
});

await test("timeline: the save marker is clamped to the axis start when the brief saves before 8:00", () => {
  const { buildDayTimeline } = needTimeline();
  const model = buildDayTimeline(AM_MEETINGS, `2026-09-28T07:30:00${ET_OFFSET}`);
  assert.equal(model.S, 8 * 60);
  assert.equal(model.marker, 8 * 60, "a 7:30 save sits at 8:00, not off the left edge");
  assert.equal(model.free[0].start, 8 * 60, "free time starts at the work window, not at 7:30");
  const late = buildDayTimeline(AM_MEETINGS, `2026-09-28T16:15:00${ET_OFFSET}`);
  assert.equal(late.marker, 16 * 60 + 15);
});

await test("timeline: an EOD saved at 4:15 is all past, has no free bands and keeps its 'with notes' heading", () => {
  const { buildDayTimeline, timelineHeading } = needTimeline();
  const eodMeetings = [
    { id: "81eb535e", title: "Brenda", short: null, start: "2026-09-24T17:01:00Z", end: "2026-09-24T17:30:00Z", url: null, has_notes: true },
    { id: "58210575", title: "Brent-Saif 1:1", short: null, start: "2026-09-24T19:00:00Z", end: "2026-09-24T19:30:00Z", url: null, has_notes: true },
    { id: null, title: "Change Control", short: null, start: "2026-09-24T15:00:00Z", end: "2026-09-24T16:00:00Z", url: null, has_notes: false },
  ];
  const model = buildDayTimeline(eodMeetings, "2026-09-24T20:15:00Z");
  assert.deepEqual(model.spans.map((span) => span.upcoming), [false, false, false]);
  assert.deepEqual(model.free, []);
  assert.equal(timelineHeading(model), "3 on the calendar, 2 with notes");
  assert.equal(model.marker, 16 * 60 + 15);
});

await test("timeline: an 8:00 meeting still under way at an 8:03 save is current: solid, prep row, counted, never 'No notes'", () => {
  const { buildDayTimeline, timelineHeading } = needTimeline();
  const tuesday = [
    { id: null, title: "Decision Making Group", short: "DMG", start: `2026-09-29T08:00:00${ET_OFFSET}`, end: `2026-09-29T08:30:00${ET_OFFSET}`, url: null, has_notes: false,
      prep: "Bring the Wave 2 numbers.", task_ids: [TASK_IWG] },
    { id: null, title: "Later", short: null, start: `2026-09-29T10:00:00${ET_OFFSET}`, end: `2026-09-29T11:00:00${ET_OFFSET}`, url: null, has_notes: false },
  ];
  const model = buildDayTimeline(tuesday, `2026-09-29T08:03:00${ET_OFFSET}`);
  assert.deepEqual(model.spans.map((span) => [span.meeting.title, span.upcoming]), [
    ["Decision Making Group", true],
    ["Later", true],
  ]);
  assert.equal(model.withPrep, 1, "the under-way meeting's prep task counts");
  assert.equal(model.withNotes, 0);
  assert.equal(timelineHeading(model), "2 on the calendar, 1 with prep tracked · free 7h");
  assert.deepEqual(model.free, [
    { start: 8 * 60 + 30, end: 10 * 60 },
    { start: 11 * 60, end: 16 * 60 + 30 },
  ], "the running meeting stays busy until it ends");
  // A meeting with no end time that started before the save is over.
  const noEnd = buildDayTimeline([{ ...tuesday[0], end: null }], `2026-09-29T08:03:00${ET_OFFSET}`);
  assert.equal(noEnd.spans[0].upcoming, false);
});

await test("timeline (EOD side): ended meetings unchanged; a meeting with notes still running at the save stays a notes meeting", () => {
  const { buildDayTimeline, timelineHeading } = needTimeline();
  const eod = [
    { id: "81eb535e", title: "Brenda", short: null, start: "2026-09-24T17:01:00Z", end: "2026-09-24T17:30:00Z", url: null, has_notes: true },
    { id: "3f2e1d0c", title: "Wrap-up with notes", short: null, start: "2026-09-24T19:45:00Z", end: "2026-09-24T20:30:00Z", url: null, has_notes: true },
    { id: null, title: "Change Control", short: null, start: "2026-09-24T15:00:00Z", end: "2026-09-24T16:00:00Z", url: null, has_notes: false },
    { id: null, title: "Still running, no notes", short: null, start: "2026-09-24T20:00:00Z", end: "2026-09-24T20:30:00Z", url: null, has_notes: false },
  ];
  const model = buildDayTimeline(eod, "2026-09-24T20:15:00Z");
  assert.deepEqual(model.spans.map((span) => [span.meeting.title, span.upcoming]), [
    ["Brenda", false],
    ["Wrap-up with notes", false],
    ["Change Control", false],
    ["Still running, no notes", true],
  ]);
  assert.equal(model.withNotes, 2);
  assert.equal(timelineHeading(model), "4 on the calendar, 2 with notes");
  assert.deepEqual(model.free, []);
});

await test("timeline: upcoming vs past comes from the meeting's end vs saved_at, not the edition", () => {
  const { buildDayTimeline } = needTimeline();
  const mixed = [
    { id: "a1", title: "Morning sync", short: null, start: `2026-09-28T09:00:00${ET_OFFSET}`, end: `2026-09-28T09:30:00${ET_OFFSET}`, url: null, has_notes: true },
    { id: null, title: "Late call", short: null, start: `2026-09-28T16:30:00${ET_OFFSET}`, end: `2026-09-28T17:00:00${ET_OFFSET}`, url: null, has_notes: false },
    { id: null, title: "Starts at the save", short: null, start: `2026-09-28T16:15:00${ET_OFFSET}`, end: `2026-09-28T16:25:00${ET_OFFSET}`, url: null, has_notes: false },
  ];
  const model = buildDayTimeline(mixed, `2026-09-28T16:15:00${ET_OFFSET}`);
  assert.deepEqual(model.spans.map((span) => [span.meeting.title, span.upcoming]), [
    ["Morning sync", false],
    ["Late call", true],
    ["Starts at the save", true],
  ]);
  // Ended exactly at the save: over.
  const ended = buildDayTimeline([{ ...mixed[2], end: `2026-09-28T16:15:00${ET_OFFSET}`, start: `2026-09-28T16:00:00${ET_OFFSET}` }], `2026-09-28T16:15:00${ET_OFFSET}`);
  assert.equal(ended.spans[0].upcoming, false);
});

// ---------------------------------------------------------------------------
// (g) prep from today's events
// ---------------------------------------------------------------------------

function task(overrides) {
  return {
    id: overrides.id,
    title: overrides.title,
    task_type: overrides.task_type ?? "Task",
    estimated_minutes: overrides.estimated_minutes ?? 30,
    priority_score: 50,
    due_at: overrides.due_at ?? null,
    status: overrides.status ?? "Planned",
    blocker: false,
    waiting_on: null,
    project_id: null,
    section_id: null,
  };
}

await test("prep from today's events: meeting matches and due-today work, worded for today", () => {
  const todayEvents = [{ title: "Security IWG 2026", start_at: "2026-09-28T17:00:00.000Z", end_at: "2026-09-28T17:50:00.000Z" }];
  const tasks = [
    task({ id: TASK_IWG, title: "Present IB 225 request at Security IWG" }),
    task({ id: TASK_AYESHA, title: "Draft the OnCore billing walkthrough", due_at: "2026-09-28T19:00:00", estimated_minutes: 90 }),
    task({ id: "d0000000-0000-4000-8000-000000000003", title: "Security IWG notes", status: "Done" }),
  ];
  const prep = identifyPrepTasks(tasks, todayEvents, "2026-09-28", { day: "today" });
  assert.deepEqual(prep.map((entry) => entry.task.id), [TASK_IWG, TASK_AYESHA]);
  assert.match(prep[0].reason, /^Related to: Security IWG 2026 at 1:00 PM$/);
  assert.equal(prep[0].targetMeetingTitle, "Security IWG 2026");
  assert.equal(prep[1].reason, "Due today (90 min) - block time for it early");
  // EOD's call (no option) keeps its wording.
  const eod = identifyPrepTasks(tasks, todayEvents, "2026-09-28");
  assert.equal(eod[1].reason, "Due tomorrow (90 min) - consider starting today");
});

// ---------------------------------------------------------------------------
// (g2) the task-to-meeting match must not link unrelated tasks on one generic word
// Regression for 9/29: all eight "Check for REDCap Upgrade" copies were listed as prep
// for the 8:00 "BOS check-in" because both titles contain "check". On 9/28 two Google IT
// cert modules were linked to Monday's meetings the same way.
// ---------------------------------------------------------------------------

function relatedTo(taskTitle, eventTitle, extra = {}) {
  const events = [{ title: eventTitle, start_at: "2026-09-29T12:00:00.000Z", end_at: "2026-09-29T12:30:00.000Z" }];
  const prep = identifyPrepTasks([task({ id: "e0000000-0000-4000-8000-000000000001", title: taskTitle, ...extra })], events, "2026-09-29", { day: "today" });
  return prep.length === 1 && prep[0].targetMeetingTitle === eventTitle;
}

await test("match: 'Check for REDCap Upgrade' is not prep for the BOS check-in (the 9/29 false match)", () => {
  assert.equal(relatedTo("Check for REDCap Upgrade", "BOS check-in"), false);
  assert.equal(relatedTo("Check for REDCap Upgrade", "BOS calendar and budget build weekly check in"), false);
  // All eight orphaned copies at once: none of them is prep for the meeting.
  const events = [{ title: "BOS check-in", start_at: "2026-09-29T12:00:00.000Z", end_at: "2026-09-29T12:30:00.000Z" }];
  const copies = Array.from({ length: 8 }, (_, index) => task({ id: `e0000000-0000-4000-8000-00000000010${index}`, title: "Check for REDCap Upgrade" }));
  assert.deepEqual(identifyPrepTasks(copies, events, "2026-09-29", { day: "today" }), []);
});

await test("match: one shared word never links, even a distinctive one (a reconstruction of the 9/28 Google IT cert false match)", () => {
  // The exact 9/28 titles were not kept; this has the same shape: a course module sharing one topic word with a meeting.
  assert.equal(relatedTo("Google IT Support Certificate C4 M5: Security basics", "Security IWG 2026"), false);
  assert.equal(relatedTo("Google IT Support Certificate C4 M6: Data storage and backups", "Cayuse-iCooper Data Flow"), false);
  // A task that is only generic words cannot match anything.
  assert.equal(relatedTo("Weekly check in follow up notes", "Weekly check in with the team: follow up on notes"), false);
});

await test("match: generic words do not count toward the two-word minimum", () => {
  // "check", "build", "verify", "test" are shared here, but they are generic; only "redcap" is left.
  assert.equal(relatedTo("Verify and test REDCap build", "REDCap build check"), false);
  // With a second real word in common it matches.
  assert.equal(relatedTo("Verify REDCap upgrade plan", "REDCap upgrade planning session"), true);
});

await test("match: real task-to-meeting matches still link (2+ shared words, and 30%+ of the task's or 60%+ of the meeting's)", () => {
  // The existing fixture case.
  assert.equal(relatedTo("Present IB 225 request at Security IWG", "Security IWG 2026"), true);
  // Live titles (9/29 replay of tasks x calendar). Long task titles share only a few words with a short meeting
  // title, so the task-side 30% floor alone dropped them; the meeting-side 60% coverage keeps them.
  assert.equal(relatedTo("Present the ECL security class change at Change Control before the prod push", "Bi-Weekly Change Control Meeting"), true);
  assert.equal(relatedTo("Watch Bootcamp demo \u2014 Calendar Import (Trainer Bootcamp homework)", "Trainer Bootcamp - OnCore"), true);
  assert.equal(relatedTo("Watch Bootcamp demo \u2014 Calendar Build: Procedures Visits (Trainer Bootcamp homework)", "Trainer Bootcamp - OnCore"), true);
  assert.equal(relatedTo("Present IB 225 / Reporting Workbench routing request at Security IWG", "Security IWG 2026"), true);
  assert.equal(relatedTo("Update Research security classes for research and non-research users", "Research Security Class Questions"), true);
  // Modeled on the 9/28 brief: OnCore CTMS prep and the OnCore status meeting.
  assert.equal(relatedTo("Chase Saif on OnCore CTMS field mapping", "OnCore CTMS Weekly Project Status Meeting"), true);
  // A long task title that shares OnCore + CTMS covers all of the meeting's significant words, so it links now.
  assert.equal(relatedTo("Send Nancy the OnCore CTMS budget template and the billing grid for the coordinators", "OnCore CTMS Weekly Project Status Meeting"), true);
});

await test("match: the live false links stay out (REDCap Upgrade, Research-owned navigators, C4 M6)", () => {
  assert.equal(relatedTo("Check for REDCap Upgrade", "Advarra OnCore - BOS calendar and budget build weekly check in"), false);
  assert.equal(relatedTo("Check for REDCap Upgrade", "Epic Upgrade Weekly Project Meeting"), false);
  assert.equal(relatedTo("Check for REDCap Upgrade", "GBM1 Trial \u2013 REDCap Data Decommissioning"), false);
  assert.equal(relatedTo("Update Research-owned navigators", "Strategic meeting: Research Technology"), false);
  assert.equal(relatedTo("C4 M6: Final Project", "OnCore CTMS Weekly Project Status Meeting"), false);
});

await test("match: accepted losses stay unlinked (one-word Cayuse, and 'build' is a generic word)", () => {
  // Real, but a one-shared-word link is exactly the false-match class (the same one-word rule linked REDCap Upgrade
  // to Epic Upgrade and to the GBM1 REDCap meeting), so no single-word exception was added. The task still lists as prep.
  assert.equal(relatedTo("Cayuse Routing", "Cayuse-iCooper Data Flow"), false);
  // Also unlinked: "classes" vs "class" are different words (no plural matching; adding it re-links weak "Research ..." meetings).
  assert.equal(relatedTo("Configure Research security classes to support study record creation and management", "Research Security Class Questions"), false);
  // Real too, but it only overlaps on "calendar" and "budget" (2 of the task's 9 words, 2 of the meeting's 5); keeping "build"
  // as a generic word is what keeps unrelated tasks out, and taking it off the list re-links a false one.
  assert.equal(relatedTo("Pick a real study for a parallel calendar build in staging (you and the budget team build the same study)", "Advarra OnCore - BOS calendar and budget build weekly check in"), false);
});

await test("match: a MeetingPrep task still shows up without a matching meeting, just with no link", () => {
  const events = [{ title: "BOS check-in", start_at: "2026-09-29T12:00:00.000Z", end_at: "2026-09-29T12:30:00.000Z" }];
  const prep = identifyPrepTasks([task({ id: "e0000000-0000-4000-8000-000000000002", title: "Check for REDCap Upgrade", task_type: "MeetingPrep" })], events, "2026-09-29", { day: "today" });
  assert.equal(prep.length, 1);
  assert.equal(prep[0].targetMeetingTitle, undefined);
  assert.equal(prep[0].reason, "Meeting preparation task");
});

// ---------------------------------------------------------------------------
// (g3) the digest's task items: created_at, recurring_template_id, identical titles collapsed
// ---------------------------------------------------------------------------

function digestItem(id, title, extra = {}) {
  return {
    id,
    title,
    status: "Planned",
    project_id: null,
    project_name: null,
    section_id: null,
    section_name: null,
    due_at: null,
    due_label: null,
    context: null,
    reason: "Related to: Security IWG 2026 at 1:00 PM",
    recent_update: null,
    created_at: null,
    recurring_template_id: null,
    supporting_notes: [],
    active_decisions: [],
    ...extra,
  };
}

await test("digest: task items carry created_at and recurring_template_id, null-safe", () => {
  assert.ok(!digestModule.missing, `digest.ts: ${digestModule.missing}`);
  const now = new Date("2026-09-29T12:00:00.000Z");
  const base = {
    id: "f0000000-0000-4000-8000-000000000001",
    title: "Check for REDCap Upgrade",
    status: "Planned",
    project_id: null,
    section_id: null,
    due_at: null,
    stakeholder_mentions: [],
    waiting_on: null,
    blocker: false,
    project: null,
    implementation: null,
    sprint: null,
  };
  const withColumns = digestModule.toTaskDigestItem({ ...base, created_at: "2026-05-11T12:00:00.000Z", recurring_template_id: "tmpl-9" }, now, "2026-09-29", new Map(), null);
  assert.equal(withColumns.created_at, "2026-05-11T12:00:00.000Z");
  assert.equal(withColumns.recurring_template_id, "tmpl-9");
  const without = digestModule.toTaskDigestItem({ ...base }, now, "2026-09-29", new Map(), null);
  assert.equal(without.created_at, null);
  assert.equal(without.recurring_template_id, null);
});

await test("digest: a collapsed EOD entry's reason has no double period (reason ending in '.' + duplicate note)", () => {
  assert.ok(!digestModule.missing, `digest.ts: ${digestModule.missing}`);
  const now = new Date("2026-09-29T12:00:00.000Z");
  const eodItem = {
    taskId: "f0000000-0000-4000-8000-0000000002a0",
    title: "Check for REDCap Upgrade",
    context: null,
    reason: "Still open heading into tomorrow, so it needs a deliberate restart instead of another warm-up lap.",
    updatedAt: "2026-07-09T12:00:00.000Z",
    dueAt: null,
    duplicateCount: 8,
    duplicateTaskIds: [],
  };
  const eodEntry = digestModule.toDigestTaskItemFromReview(eodItem, new Map(), now, "2026-09-29", new Map(), null);
  assert.equal(
    eodEntry.reason,
    "Still open heading into tomorrow, so it needs a deliberate restart instead of another warm-up lap. 8 identical open tasks, listed once"
  );
  assert.doesNotMatch(eodEntry.reason, /\.\./);
  // A reason with no trailing period still reads the same way.
  const plain = digestModule.toDigestTaskItemFromReview({ ...eodItem, reason: "Due today" }, new Map(), now, "2026-09-29", new Map(), null);
  assert.equal(plain.reason, "Due today. 8 identical open tasks, listed once");
  // The morning/midday collapse path uses the same join.
  const collapsed = digestModule.collapseDigestTaskItems([
    digestItem("a1", "Same title", { reason: "Ends with a period." }),
    digestItem("a2", "Same title", { reason: "Ends with a period." }),
  ]);
  assert.equal(collapsed[0].reason, "Ends with a period. 2 identical open tasks, listed once");
});

await test("digest: eight identical titles become one entry x8 with the copies listed", () => {
  assert.ok(!digestModule.missing, `digest.ts: ${digestModule.missing}`);
  const mondays = ["2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];
  const eight = mondays.map((day, index) =>
    digestItem(`f0000000-0000-4000-8000-0000000001${index}0`, "Check for REDCap Upgrade", { created_at: `${day}T12:00:00.000Z` })
  );
  const other = digestItem("f0000000-0000-4000-8000-000000000999", "Pick a real study for a parallel calendar build");
  const collapsed = digestModule.collapseDigestTaskItems([other, ...eight]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].title, other.title);
  assert.equal(collapsed[0].duplicate_count, 1);
  assert.deepEqual(collapsed[0].duplicate_task_ids, []);
  assert.equal(collapsed[0].reason, other.reason);
  assert.equal(collapsed[1].duplicate_count, 8);
  assert.deepEqual(collapsed[1].duplicate_task_ids, eight.slice(1).map((item) => item.id));
  assert.equal(collapsed[1].id, eight[0].id);
  assert.equal(collapsed[1].duplicates_created_from, "2026-05-11T12:00:00.000Z");
  assert.equal(collapsed[1].duplicates_created_to, "2026-06-29T12:00:00.000Z");
  assert.match(collapsed[1].reason, /8 identical open tasks, listed once/);
  // Case and spacing don't hide a duplicate.
  const messy = digestModule.collapseDigestTaskItems([digestItem("a", "Check for  REDCap Upgrade"), digestItem("b", " check for redcap upgrade ")]);
  assert.equal(messy.length, 1);
  assert.equal(messy[0].duplicate_count, 2);
  // Blank titles never merge.
  assert.equal(digestModule.collapseDigestTaskItems([digestItem("c", ""), digestItem("d", "")]).length, 2);
});

// ---------------------------------------------------------------------------
// (a)/(b) MCP surface: save_brief(edition) + the save_eod_brief alias; get_brief by latest
// ---------------------------------------------------------------------------

const { POST } = await import("../src/app/api/mcp/route.ts");
async function rpc(body) {
  const response = await POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY,
        "mcp-session-id": "stateless",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    })
  );
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:")).slice(5) : text;
  return JSON.parse(payload);
}
await rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "am-test", version: "1" } } });
const listed = (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).result.tools;
const tool = (name) => listed.find((entry) => entry.name === name);

await test("MCP: save_brief takes edition eod|am; save_eod_brief stays, with the same fields minus edition", () => {
  const saveBrief = tool("save_brief");
  const alias = tool("save_eod_brief");
  assert.ok(saveBrief, "save_brief is not registered");
  assert.ok(alias, "save_eod_brief alias is gone");
  assert.deepEqual(saveBrief.inputSchema.properties.edition.enum, ["eod", "am"]);
  assert.ok(saveBrief.inputSchema.required.includes("edition"));
  const { edition, ...rest } = saveBrief.inputSchema.properties;
  assert.ok(edition);
  assert.deepEqual(rest, alias.inputSchema.properties);
  assert.deepEqual(saveBrief.inputSchema.required.filter((key) => key !== "edition"), alias.inputSchema.required);
});

await test("MCP: get_brief accepts code or latest (eod|am), and refuses neither or both without calling Baseline", async () => {
  const getBrief = tool("get_brief");
  assert.deepEqual(getBrief.inputSchema.properties.latest?.enum, ["eod", "am"]);
  assert.equal((getBrief.inputSchema.required ?? []).includes("code"), false);
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async (...args) => {
    fetched += 1;
    return originalFetch(...args);
  };
  try {
    for (const args of [{}, { code: "EOD-0925", latest: "eod" }]) {
      const result = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_brief", arguments: args } })).result;
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, /either code or latest/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetched, 0);
});

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
