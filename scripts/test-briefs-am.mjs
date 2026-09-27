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

await test("timeline: upcoming vs past comes from start vs saved_at, not the edition", () => {
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
    ["Starts at the save", false],
  ]);
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
