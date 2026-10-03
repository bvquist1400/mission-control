// Pure tests for the Portfolio page model (src/lib/portfolio.ts: counts, timeline
// planned windows, lane health), the task
// owner field parser (src/lib/task-owner.ts) and the record-page Markdown
// parser (src/lib/markdown.ts). No database.
//
//   npm run test:portfolio

import assert from "node:assert/strict";

const {
  percentDone,
  countTasks,
  buildPortfolio,
  buildTimeline,
  laneHealth,
  taskCredit,
  timelinePosition,
  toEtDate,
} = await import("../src/lib/portfolio.ts");
const { loadChecklistProgress, loadPortfolioInput } = await import("../src/lib/portfolio-queries.ts");
const { parseTaskOwnerFields, normalizeTaskOwner } = await import("../src/lib/task-owner.ts");
const { parseMarkdown, parseInline, safeHref } = await import("../src/lib/markdown.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function testAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// 5:00 PM ET on Mon 9/28/2026.
const NOW = new Date("2026-09-28T21:00:00Z");
const TODAY = "2026-09-28";

let seq = 0;
function task(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `t${seq}`;
  return {
    id,
    title: `Task ${id}`,
    status: "Backlog",
    owner: "agent",
    owner_label: null,
    status_line: null,
    due_at: null,
    created_at: "2026-09-24T14:00:00Z",
    updated_at: "2026-09-24T14:00:00Z",
    priority_score: 50,
    implementation_id: "app-a",
    project_id: "proj-a",
    section_id: null,
    is_recurring_template: false,
    tags: ["personal"],
    project: { tags: ["personal"] },
    ...overrides,
  };
}

const IMPLS = [
  { id: "app-a", name: "Stock & Stir", phase: "Build", rag: "Green", status_summary: "Release 3 is on phones. More detail follows.", next_milestone: "", next_milestone_date: null, portfolio_rank: 2 },
  { id: "app-b", name: "FamCal", phase: "Build", rag: "Green", status_summary: "", next_milestone: "Friday page", next_milestone_date: "2026-10-09", portfolio_rank: 1 },
  { id: "app-w", name: "OnCore", phase: "Discovery", rag: "Green", status_summary: "", next_milestone: "", next_milestone_date: null, portfolio_rank: 3 },
];
const PROJECTS = [
  { id: "proj-a", name: "Stock & Stir", implementation_id: "app-a", stage: "In Progress", portfolio_rank: 1 },
  { id: "proj-b1", name: "Finance Loop", implementation_id: "app-b", stage: "In Progress", portfolio_rank: 1 },
  { id: "proj-b2", name: "Sunday Brief", implementation_id: "app-b", stage: "In Progress", portfolio_rank: 2 },
  { id: "proj-x", name: "Old idea", implementation_id: "app-b", stage: "Cancelled", portfolio_rank: 3 },
];
const SECTIONS = [
  { id: "sec-r3", project_id: "proj-a", name: "Release 3", sort_order: 0 },
  { id: "sec-r4", project_id: "proj-a", name: "Release 4", sort_order: 1 },
];

// ── % done ────────────────────────────────────────────────────────────────
test("percentDone is done ÷ all, rounded", () => {
  assert.equal(percentDone(10, 28), 36);
  assert.equal(percentDone(1, 3), 33);
  assert.equal(percentDone(2, 3), 67);
  assert.equal(percentDone(4, 4), 100);
  assert.equal(percentDone(0, 5), 0);
});

test("percentDone never claims 100% with work left, or 0% once something is done", () => {
  assert.equal(percentDone(199, 200), 99);
  assert.equal(percentDone(1, 300), 1);
});

test("percentDone is null with no tasks and clamps bad input", () => {
  assert.equal(percentDone(0, 0), null);
  assert.equal(percentDone(5, 4), 100);
  assert.equal(percentDone(-1, 4), 0);
});

test("countTasks: Parked and Missed are closed but not done; owners count open tasks only", () => {
  const counts = countTasks([
    task({ status: "Done" }),
    task({ status: "Done", owner: "brent" }),
    task({ status: "Parked" }),
    task({ status: "Missed" }),
    task({ status: "In Progress", owner: "brent" }),
    task({ status: "Blocked/Waiting" }),
    task({ status: "Backlog" }),
  ]);
  assert.deepEqual(counts, { done: 2, total: 7, credit: 2, pct: 29, open: 3, brentOpen: 1, brentLater: 0, agentOpen: 2 });
});

test("countTasks: Brent's blocked tasks (Blocked/Waiting or an open dependency) count as later, not open for him", () => {
  const counts = countTasks(
    [
      task({ id: "c1", status: "In Progress", owner: "brent" }),
      task({ id: "c2", status: "Blocked/Waiting", owner: "brent" }),
      task({ id: "c3", status: "Planned", owner: "brent" }),
      task({ id: "c4", status: "Blocked/Waiting", owner: "agent" }),
    ],
    { c3: ["Release 3.1"] }
  );
  assert.deepEqual(counts, { done: 0, total: 4, credit: 0, pct: 0, open: 4, brentOpen: 1, brentLater: 2, agentOpen: 1 });
});

// ── buildPortfolio ────────────────────────────────────────────────────────
function sampleInput() {
  return {
    implementations: IMPLS,
    projects: PROJECTS,
    sections: SECTIONS,
    tasks: [
      task({ id: "a1", status: "Done", section_id: "sec-r3" }),
      task({ id: "a2", status: "In Progress", section_id: "sec-r3", owner: "brent", status_line: "8 of 11 checks passed.", due_at: "2026-10-01T21:00:00Z", updated_at: "2026-09-28T19:00:00Z" }),
      task({ id: "a3", status: "Backlog", section_id: "sec-r4", priority_score: 90 }),
      task({ id: "a4", status: "In Progress", owner_label: "Codex", status_line: "Diagnosing two pantry bugs.", updated_at: "2026-09-28T20:00:00Z" }),
      task({ id: "a5", status: "Parked" }),
      task({ id: "tmpl", status: "Parked", is_recurring_template: true }),
      task({ id: "b1", implementation_id: "app-b", project_id: "proj-b1", status: "Done", project: { tags: ["personal"] } }),
      task({ id: "b2", implementation_id: "app-b", project_id: "proj-b2", status: "Planned", owner: "brent", due_at: "2026-09-26T21:00:00Z" }),
      task({ id: "b3", implementation_id: "app-b", project_id: "proj-x", status: "Backlog" }),
      task({ id: "w1", implementation_id: "app-w", project_id: null, status: "Done", tags: [], project: null }),
      task({ id: "w2", implementation_id: "app-w", project_id: null, status: "Backlog", owner: "brent", tags: [], project: null }),
      task({ id: "loose", implementation_id: null, project_id: null, status: "Planned", owner: "brent" }),
    ],
  };
}

test("personal scope keeps personal tasks only, skips recurring templates, orders apps by rank", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.today, TODAY);
  assert.deepEqual(view.apps.map((app) => app.name), ["FamCal", "Stock & Stir"]);
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  // a1..a5 count (the recurring template doesn't): 1 done of 5.
  assert.deepEqual([ss.counts.done, ss.counts.total, ss.counts.pct], [1, 5, 20]);
  assert.equal(ss.counts.brentOpen, 1);
  assert.equal(ss.counts.agentOpen, 2);
  assert.deepEqual(ss.agentLabels, ["Codex"]);
});

test("hero: Brent's open count includes tasks with no app; % done covers app tasks", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.brentOpen, 3); // a2, b2, loose
  assert.deepEqual([view.overall.done, view.overall.total], [2, 8]);
  assert.equal(view.overall.pct, 25);
  assert.equal(view.agentInProgress, 1); // a4 (a2 is Brent's)
});

test("work and all scopes", () => {
  const work = buildPortfolio(sampleInput(), { scope: "work", now: NOW });
  assert.deepEqual(work.apps.map((app) => app.name), ["OnCore"]);
  assert.equal(work.apps[0].counts.pct, 50);
  assert.equal(work.brentOpen, 1);
  const all = buildPortfolio(sampleInput(), { scope: "all", now: NOW });
  assert.deepEqual(all.apps.map((app) => app.name), ["FamCal", "Stock & Stir", "OnCore"]);
  assert.equal(all.brentOpen, 4);
});

test("assigned to you: dated first (soonest, overdue flagged), then by priority", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.deepEqual(view.assigned.map((t) => t.id), ["b2", "a2", "loose"]);
  assert.equal(view.assigned[0].overdue, true);
  assert.equal(view.assigned[0].due, "2026-09-26");
  assert.equal(view.assigned[1].overdue, false);
  assert.equal(view.assigned[1].statusLine, "8 of 11 checks passed.");
  assert.equal(view.assigned[1].app, "Stock & Stir");
  assert.equal(view.assigned[2].app, null);
});

test("where it stands: newest open status_line, else the app summary's first sentence", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss.stand, "Diagnosing two pantry bugs.");
  const input = sampleInput();
  input.tasks = input.tasks.map((t) => ({ ...t, status_line: null }));
  const ss2 = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss2.stand, "Release 3 is on phones.");
});

test("next: the app's milestone if set, else the soonest upcoming due task, else top priority", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.apps.find((app) => app.name === "FamCal").next, "Friday page (Oct 9)");
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  const a2 = sampleInput().tasks.find((t) => t.id === "a2");
  assert.equal(ss.next, a2.title); // due 10/1 beats a3's higher priority
  const input = sampleInput();
  input.tasks = input.tasks.map((t) => ({ ...t, due_at: null }));
  const ss2 = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss2.next, input.tasks.find((t) => t.id === "a3").title);
});

test("ET dates: a due time late in the ET evening stays on that ET day", () => {
  assert.equal(toEtDate("2026-10-04T03:30:00Z"), "2026-10-03");
  assert.equal(toEtDate("2026-10-04T04:30:00Z"), "2026-10-04");
  assert.equal(toEtDate(null), null);
  assert.equal(toEtDate("not a date"), null);
});

// ── Assigned to you: actionable only (slice 2) ─────────────────────────────
function blockedInput() {
  const input = sampleInput();
  input.tasks.push(
    task({ id: "x1", status: "Blocked/Waiting", owner: "brent", waiting_on: "Release 3.1 build", status_line: "Comes to you when 3.1 is on TestFlight.", follow_up_at: "2026-10-02T13:00:00Z", due_at: "2026-09-20T21:00:00Z" }),
    task({ id: "x2", status: "Planned", owner: "brent", title: "Check the rename on the iPad" }),
    task({ id: "x3", status: "Blocked/Waiting", owner: "brent", implementation_id: "app-b", project_id: "proj-b1", updated_at: "2026-09-27T12:00:00Z" }),
    task({ id: "x4", status: "Done", owner: "brent", section_id: "sec-r3" })
  );
  input.blockers = { x2: ["Menu & Market rename", "Siri fix"] };
  return input;
}

test("assigned to you shows only actionable tasks; blocked ones move to coming later", () => {
  const view = buildPortfolio(blockedInput(), { scope: "personal", now: NOW });
  assert.deepEqual(view.assigned.map((t) => t.id), ["b2", "a2", "loose"], "same list as without the blocked tasks");
  assert.deepEqual(view.comingLater.map((t) => t.id), ["x1", "x3", "x2"], "dated first, then newest change");
  const [x1, x3, x2] = view.comingLater;
  assert.equal(x1.waitingOn, "Release 3.1 build");
  assert.equal(x1.followUp, "2026-10-02");
  assert.equal(x1.statusLine, "Comes to you when 3.1 is on TestFlight.");
  assert.deepEqual(x1.blockedBy, []);
  assert.deepEqual(x2.blockedBy, ["Menu & Market rename", "Siri fix"], "dependency-blocked even though Planned");
  assert.equal(x2.status, "Planned");
  assert.equal(x3.app, "FamCal");
  assert.equal(x3.waitingOn, null);
});

test("hero count counts only actionable tasks; blocked ones are brentLater", () => {
  const before = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const view = buildPortfolio(blockedInput(), { scope: "personal", now: NOW });
  assert.equal(view.brentOpen, before.brentOpen);
  assert.equal(view.brentOpen, 3);
  assert.equal(view.brentLater, 3);
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss.counts.brentOpen, 1);
  assert.equal(ss.counts.brentLater, 2);
  // A dependency that is done no longer blocks: the lookup only lists unfinished ones.
  const unblocked = blockedInput();
  unblocked.blockers = {};
  assert.deepEqual(
    buildPortfolio(unblocked, { scope: "personal", now: NOW }).assigned.map((t) => t.id),
    ["b2", "a2", "x2", "loose"]
  );
});

test("assigned rows flag decision tasks (tag or 'Decide:' title) for the hand-back warning", () => {
  const input = sampleInput();
  input.tasks.push(
    task({ id: "d1", owner: "brent", status: "Planned", title: "Decide: keep both boards?" }),
    task({ id: "d2", owner: "brent", status: "Planned", title: "Board merge", tags: ["personal", "Decision"] })
  );
  const view = buildPortfolio(input, { scope: "personal", now: NOW });
  const byId = Object.fromEntries(view.assigned.map((t) => [t.id, t.decision]));
  assert.deepEqual(byId, { b2: false, a2: false, d1: true, d2: true, loose: false });
});

// ── Timeline ──────────────────────────────────────────────────────────────
// No section has planned dates in this fixture, so every lane is "unscheduled":
// the chart is empty and the sections are listed under it.
test("timeline: sections with no planned dates move to the earlier/unscheduled list (no guessed bars)", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const ss = view.apps.find((app) => app.name === "Stock & Stir").timeline;
  assert.deepEqual(ss.lanes, [], "nothing is drawn without planned dates");
  assert.deepEqual(ss.earlier.map((lane) => lane.label), ["Release 3", "Release 4", "Other tasks"]);
  assert.deepEqual(ss.earlier.map((lane) => lane.text), ["1 of 2 done", "0 of 1 done", "0 of 2 done"]);
  assert.equal(ss.summary, null, "no target date and no planned section: no app chip");
  assert.equal(ss.target, null);
  const fam = view.apps.find((app) => app.name === "FamCal").timeline;
  assert.deepEqual(fam.earlier.map((lane) => lane.label), ["Finance Loop", "Sunday Brief"], "cancelled project skipped");
  assert.equal(fam.earlier.every((lane) => lane.project === null), true);
  assert.deepEqual(fam.earlier.map((lane) => lane.text), ["1 of 1 done", "0 of 1 done"]);
});

test("timeline: a project's unsectioned tasks sit beside its sections as 'Other tasks', labelled by project when there are several", () => {
  const input = sampleInput();
  input.tasks.push(task({ id: "c1", implementation_id: "app-b", project_id: "proj-b1", section_id: "sec-b1", status: "Backlog" }));
  input.sections = [...SECTIONS, { id: "sec-b1", project_id: "proj-b1", name: "Slice", sort_order: 0 }];
  const fam = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "FamCal").timeline;
  assert.deepEqual(fam.earlier.map((lane) => [lane.project, lane.label]), [
    ["Finance Loop", "Slice"],
    ["Finance Loop", "Other tasks"],
    [null, "Sunday Brief"],
  ]);
});

// ── Health rule (the approved mockup's rule) ───────────────────────────────
const health = (done, total, start, end, today, open) => laneHealth({ done, total, start, end, today, open });

test("laneHealth: no tasks, done, starts later", () => {
  assert.deepEqual(health(0, 0, "2026-10-05", "2026-10-09", "2026-10-06"), { kind: "empty", label: "No tasks yet" });
  assert.deepEqual(health(4, 4, "2026-10-05", "2026-10-09", "2026-10-30"), { kind: "done", label: "Done" }, "all done wins even long after the end");
  assert.deepEqual(health(0, 3, "2026-10-05", "2026-10-09", "2026-09-30"), { kind: "plan", label: "Starts 10/5" });
  assert.deepEqual(health(3, 4, "2026-10-05", "2026-10-09", "2026-09-30", 1), { kind: "plan", label: "Starts 10/5" });
  assert.deepEqual(health(2, 4, "2026-10-05", "2026-10-09", "2026-10-30", 0), { kind: "done", label: "Done" }, "nothing open (the rest parked) is finished");
});

test("laneHealth: late is after the planned end with work open; the end day itself is not late", () => {
  assert.deepEqual(health(0, 4, "2026-09-30", "2026-10-02", "2026-10-03"), { kind: "late", label: "Late · due 10/2" });
  assert.deepEqual(health(8, 9, "2026-09-29", "2026-10-06", "2026-10-07"), { kind: "late", label: "Late · due 10/6" });
  assert.notEqual(health(0, 4, "2026-09-30", "2026-10-02", "2026-10-02").kind, "late");
});

test("laneHealth: behind, ahead and on track around the 25% and 15% margins", () => {
  // 10-day window 10/1–10/10; on 10/6 expected = 5.5 / 10 = 0.55.
  const run = (done, total) => health(done, total, "2026-10-01", "2026-10-10", "2026-10-06").kind;
  assert.equal(run(0, 10), "behind"); // 0 + .25 < .55
  assert.equal(run(3, 10), "ok"); // .3 + .25 = .55, not below it
  assert.equal(run(2, 10), "behind"); // .2 + .25 < .55
  assert.equal(run(6, 10), "ok"); // .6 < .55 + .15
  assert.equal(run(7, 10), "ahead"); // .7 ≥ .7
  assert.equal(run(9, 10), "ahead");
  assert.deepEqual(health(2, 10, "2026-10-01", "2026-10-10", "2026-10-06"), { kind: "behind", label: "Behind" });
  assert.deepEqual(health(7, 10, "2026-10-01", "2026-10-10", "2026-10-06"), { kind: "ahead", label: "Ahead" });
  assert.deepEqual(health(5, 10, "2026-10-01", "2026-10-10", "2026-10-06"), { kind: "ok", label: "On track" });
});

test("laneHealth: a 3-day window on its first day is On track with nothing done", () => {
  // expected = 0.5 / 3 = 0.17: 0 + .25 is not below it, and 0 is not .15 above it.
  assert.deepEqual(health(0, 4, "2026-09-30", "2026-10-02", "2026-09-30"), { kind: "ok", label: "On track" });
  // The rule's own edge: a 1-day window is half over on its day (0.5 ÷ 1), so nothing done is Behind.
  assert.deepEqual(health(0, 1, "2026-09-30", "2026-09-30", "2026-09-30"), { kind: "behind", label: "Behind" });
});

test("laneHealth: the mockup's '10/7 if nothing else finishes' case", () => {
  const today = "2026-10-07";
  assert.equal(health(0, 4, "2026-09-30", "2026-10-02", today).label, "Late · due 10/2"); // Build 32
  assert.equal(health(6, 9, "2026-09-29", "2026-10-06", today).label, "Late · due 10/6"); // Redesign
  assert.equal(health(0, 3, "2026-10-05", "2026-10-09", today).label, "Behind"); // Link import
  assert.equal(health(0, 3, "2026-10-05", "2026-10-27", today).label, "On track"); // Plus
  assert.equal(health(0, 3, "2026-10-08", "2026-10-22", today).label, "Starts 10/8"); // Duo
});

test("laneHealth: expected share is clamped 0–1 and ignores out-of-range done counts", () => {
  assert.equal(health(99, 4, "2026-10-01", "2026-10-10", "2026-10-02", 1).kind, "ahead");
  assert.equal(health(-3, 4, "2026-10-01", "2026-10-10", "2026-10-10").kind, "behind"); // 0 + .25 < .95
});

// ── Menu & Market: the real lanes from the approved mockup ─────────────────
const MM_PROJECTS = [
  { id: "proj-a", name: "Stock & Stir", implementation_id: "app-a", stage: "In Progress", portfolio_rank: 1, target_date: "2026-11-20" },
];
const MM_LANES = [
  ["mm1", "Build 32", "2026-09-30", "2026-10-02", 0, 4, true],
  ["mm2", "Redesign", "2026-09-29", "2026-10-06", 6, 9, false],
  ["mm3", "Link import", "2026-10-05", "2026-10-09", 0, 3, false],
  ["mm4", "Plus", "2026-10-05", "2026-10-27", 0, 3, true],
  ["mm5", "Duo", "2026-10-08", "2026-10-22", 0, 3, true],
  ["mm6", "Launch prep", "2026-10-26", "2026-11-04", 0, 4, false],
  ["mm7", "App Review", "2026-11-04", "2026-11-20", 0, 0, false],
];
function mmSections() {
  return MM_LANES.map(([id, name, start, end], index) => ({ id, project_id: "proj-a", name, sort_order: index, planned_start: start, planned_end: end }));
}
function mmTasks() {
  const out = [];
  for (const [id, , , , done, total, brent] of MM_LANES) {
    for (let i = 0; i < total; i += 1) {
      out.push(task({ id: `${id}-${i}`, section_id: id, status: i < done ? "Done" : "Backlog", owner: brent && i === done ? "brent" : "agent" }));
    }
  }
  return out;
}
const mm = (today) => buildTimeline(mmTasks(), MM_PROJECTS, mmSections(), today);

test("timeline (9/30): one lane per planned section, in order, with health, share, You badge", () => {
  const timeline = mm("2026-09-30");
  assert.deepEqual(timeline.lanes.map((lane) => lane.label), MM_LANES.map((lane) => lane[1]));
  assert.deepEqual(timeline.lanes.map((lane) => lane.health.label), [
    "On track", // Build 32: the first day of a 3-day window
    "Ahead", // Redesign 6/9
    "Starts 10/5",
    "Starts 10/5",
    "Starts 10/8",
    "Starts 10/26",
    "No tasks yet", // App Review: planned, no tasks
  ]);
  assert.deepEqual(timeline.lanes.map((lane) => lane.health.kind), ["ok", "ahead", "plan", "plan", "plan", "plan", "empty"]);
  const [build, redesign] = timeline.lanes;
  assert.equal(redesign.share, 6 / 9);
  assert.deepEqual([redesign.start, redesign.end, redesign.done, redesign.total], ["2026-09-29", "2026-10-06", 6, 9]);
  assert.equal(redesign.sub, "6 of 9 done");
  assert.equal(build.share, 0);
  assert.equal(build.hasBrent, true);
  assert.equal(redesign.hasBrent, false);
  assert.equal(timeline.lanes[6].sub, "Planned");
  assert.equal(timeline.earlier.length, 0);
});

test("timeline (10/7, nothing finished since): Build 32 and Redesign Late, Link import Behind, Plus On track", () => {
  const timeline = mm("2026-10-07");
  const byName = Object.fromEntries(timeline.lanes.map((lane) => [lane.label, lane.health]));
  assert.deepEqual(byName["Build 32"], { kind: "late", label: "Late · due 10/2" });
  assert.deepEqual(byName["Redesign"], { kind: "late", label: "Late · due 10/6" });
  assert.deepEqual(byName["Link import"], { kind: "behind", label: "Behind" });
  assert.deepEqual(byName["Plus"], { kind: "ok", label: "On track" });
  assert.deepEqual(byName["Duo"], { kind: "plan", label: "Starts 10/8" });
  // The app chip is only the health word; "Late · due 10/2" is the lane's own label.
  assert.deepEqual(timeline.summary.health, { kind: "late", label: "Late" });
  assert.equal(timeline.summary.line, "Target 11/20 · 6 of 26 tasks done");
});

test("app chip: two Late lanes with different due dates still read just 'Late'", () => {
  const timeline = buildTimeline(
    [task({ id: "l1", section_id: "mm1" }), task({ id: "l2", section_id: "mm2" })],
    MM_PROJECTS,
    mmSections().filter((section) => ["mm1", "mm2"].includes(section.id)),
    "2026-10-20"
  );
  assert.deepEqual(timeline.lanes.map((lane) => lane.health.label), ["Late · due 10/2", "Late · due 10/6"]);
  assert.deepEqual(timeline.summary.health, { kind: "late", label: "Late" });
});

test("app chip and count use only the sections drawn on the chart: a section that ended months ago with open tasks changes neither", () => {
  const sections = [
    ...mmSections().slice(2, 4),
    { id: "mm-ancient", project_id: "proj-a", name: "Ended in May", sort_order: 9, planned_start: "2026-05-01", planned_end: "2026-05-30" },
  ];
  const tasks = [
    task({ id: "n1", section_id: "mm3", status: "Done" }),
    task({ id: "n2", section_id: "mm3", status: "Done" }),
    task({ id: "n5", section_id: "mm3" }),
    task({ id: "n3", section_id: "mm4", status: "Done" }),
    task({ id: "n4", section_id: "mm4" }),
    task({ id: "old1", section_id: "mm-ancient" }),
    task({ id: "old2", section_id: "mm-ancient" }),
  ];
  const timeline = buildTimeline(tasks, MM_PROJECTS, sections, "2026-10-07");
  assert.deepEqual(timeline.lanes.map((lane) => lane.health.kind), ["ahead", "ahead"]);
  assert.deepEqual(timeline.earlier.map((lane) => lane.label), ["Ended in May"]);
  assert.deepEqual(timeline.summary.health, { kind: "ok", label: "On track" }, "the stale open section must not turn the chip red");
  assert.equal(timeline.summary.line, "Target 11/20 · 3 of 5 tasks done", "its 2 open tasks aren't counted");
  // Same for a finished section and one with no planned dates.
  const hidden = buildTimeline(
    [...tasks, task({ id: "s1", section_id: "mm-shipped", status: "Done" }), task({ id: "u1", section_id: "mm-free" })],
    MM_PROJECTS,
    [
      ...sections,
      { id: "mm-shipped", project_id: "proj-a", name: "Shipped", sort_order: 10, planned_start: "2026-09-20", planned_end: "2026-10-01" },
      { id: "mm-free", project_id: "proj-a", name: "Free", sort_order: 11, planned_start: null, planned_end: null },
    ],
    "2026-10-07"
  );
  assert.deepEqual(hidden.summary, timeline.summary);
});

test("app chip: the worst health among started lanes (Late > Behind > On track); not-started lanes don't count", () => {
  assert.deepEqual(mm("2026-09-30").summary.health, { kind: "ok", label: "On track" }, "ahead shows as On track on the app chip");
  assert.deepEqual(mm("2026-10-07").summary.health, { kind: "late", label: "Late" }, "no due date on the app chip");
  // Only Behind and On track started: Behind wins.
  const behindOnly = buildTimeline(
    [task({ id: "p1", section_id: "mm3" }), task({ id: "p2", section_id: "mm4" })],
    MM_PROJECTS,
    mmSections().filter((section) => ["mm3", "mm4"].includes(section.id)),
    "2026-10-07"
  );
  assert.deepEqual(behindOnly.summary.health, { kind: "behind", label: "Behind" });
  // Before anything starts there is no chip colour, but the line still shows.
  const early = mm("2026-09-01");
  assert.equal(early.summary.health, null);
  assert.match(early.summary.line, /^Target 11\/20 · 6 of 26 tasks done$/);
  // Finished sections aren't drawn, so they give no chip and no count; the target still shows.
  const allDone = buildTimeline(
    [task({ id: "d1", section_id: "mm3", status: "Done" }), task({ id: "d2", section_id: "mm4", status: "Done" })],
    MM_PROJECTS,
    mmSections().filter((section) => ["mm3", "mm4"].includes(section.id)),
    "2026-10-07"
  );
  assert.equal(allDone.summary.health, null);
  assert.equal(allDone.summary.line, "Target 11/20");
});

test("app line: 'Target 11/20 · X of Y tasks done', drawn sections only", () => {
  const timeline = mm("2026-09-30");
  assert.equal(timeline.summary.line, "Target 11/20 · 6 of 26 tasks done");
  assert.deepEqual([timeline.summary.done, timeline.summary.total, timeline.summary.targetDate], [6, 26, "2026-11-20"]);
  // A section without planned dates isn't counted, and neither are its tasks.
  const withExtra = buildTimeline(
    [...mmTasks(), task({ id: "free1", section_id: "later", status: "Done" }), task({ id: "free2", section_id: "later" })],
    MM_PROJECTS,
    [...mmSections(), { id: "later", project_id: "proj-a", name: "Later", sort_order: 9, planned_start: null, planned_end: null }],
    "2026-09-30"
  );
  assert.equal(withExtra.summary.line, "Target 11/20 · 6 of 26 tasks done");
  assert.deepEqual(withExtra.earlier.map((lane) => [lane.label, lane.text]), [["Later", "1 of 2 done"]]);
});

test("app summary shows only with a project target date or a planned section", () => {
  const none = buildTimeline(mmTasks(), [{ ...MM_PROJECTS[0], target_date: null }], [], "2026-09-30");
  assert.equal(none.summary, null);
  // A target date alone: the line is just the target; no chip colour (nothing scheduled has started).
  const targetOnly = buildTimeline(mmTasks(), MM_PROJECTS, [], "2026-09-30");
  assert.equal(targetOnly.summary.line, "Target 11/20");
  assert.equal(targetOnly.summary.health, null);
  assert.equal(targetOnly.lanes.length, 0);
  // A planned section alone: no target in the line.
  const plannedOnly = buildTimeline(mmTasks(), [{ ...MM_PROJECTS[0], target_date: null }], mmSections(), "2026-09-30");
  assert.equal(plannedOnly.summary.line, "6 of 26 tasks done");
  assert.equal(plannedOnly.target, null);
  // A cancelled or finished project's target isn't shown.
  for (const stage of ["Done", "Cancelled"]) {
    assert.equal(buildTimeline(mmTasks(), [{ ...MM_PROJECTS[0], stage, target_date: "2026-11-20" }], [], "2026-09-30").summary, null, stage);
  }
});

test("target marker: placed in the middle of its day, inside the window, with the dashed guide's position", () => {
  const timeline = mm("2026-09-30");
  assert.deepEqual(timeline.target, { date: "2026-11-20" });
  assert.ok(timeline.target.date >= timeline.start && timeline.target.date <= timeline.end);
  const span = Math.round((Date.parse(`${timeline.end}T00:00:00Z`) - Date.parse(`${timeline.start}T00:00:00Z`)) / 86_400_000);
  const days = Math.round((Date.parse("2026-11-20T00:00:00Z") - Date.parse(`${timeline.start}T00:00:00Z`)) / 86_400_000);
  assert.equal(timelinePosition(timeline, "2026-11-20", 0.5), ((days + 0.5) / span) * 100);
  const today = timelinePosition(timeline, "2026-09-30", 0.5);
  assert.ok(today > 0 && today < timelinePosition(timeline, "2026-11-20", 0.5));
  // A bar that includes its last day ends at the end of that day.
  assert.ok(timelinePosition(timeline, "2026-10-02", 1) > timelinePosition(timeline, "2026-10-02"));
});

test("target marker: the window stretches to show it; one beyond 12 weeks or already past is left off the chart", () => {
  const far = buildTimeline(mmTasks(), [{ ...MM_PROJECTS[0], target_date: "2027-06-01" }], mmSections(), "2026-09-30");
  assert.equal(far.target, null);
  assert.equal(far.summary.line.startsWith("Target 6/1 · "), true, "the line still names it");
  const past = buildTimeline(mmTasks(), [{ ...MM_PROJECTS[0], target_date: "2026-05-01" }], mmSections(), "2026-09-30");
  assert.equal(past.target, null);
  // Today is 10/28 in a window that would end ~11/25 without it: a 12/10 target stretches the end.
  const late = buildTimeline(
    [task({ id: "z1", section_id: "mm3" })],
    [{ ...MM_PROJECTS[0], target_date: "2026-12-10" }],
    mmSections().filter((section) => section.id === "mm3"),
    "2026-10-28"
  );
  assert.equal(late.target?.date, "2026-12-10");
});

test("finished and unscheduled sections go to the earlier list, but finished planned ones still count toward the line", () => {
  const sections = [
    ...mmSections().slice(0, 2),
    { id: "mm-done", project_id: "proj-a", name: "Shipped", sort_order: 3, planned_start: "2026-09-01", planned_end: "2026-09-20" },
    { id: "mm-half", project_id: "proj-a", name: "Start only", sort_order: 4, planned_start: "2026-10-01", planned_end: null },
    { id: "mm-end", project_id: "proj-a", name: "End only", sort_order: 5, planned_start: null, planned_end: "2026-10-30" },
    { id: "mm-bad", project_id: "proj-a", name: "Backwards", sort_order: 6, planned_start: "2026-10-20", planned_end: "2026-10-01" },
    { id: "mm-old", project_id: "proj-a", name: "Stale", sort_order: 7, planned_start: "2026-06-01", planned_end: "2026-06-30" },
  ];
  const tasks = [
    ...mmTasks().filter((t) => t.section_id === "mm1" || t.section_id === "mm2"),
    task({ id: "sh1", section_id: "mm-done", status: "Done" }),
    task({ id: "sh2", section_id: "mm-done", status: "Done" }),
    task({ id: "so1", section_id: "mm-half" }),
    task({ id: "eo1", section_id: "mm-end", status: "Done" }),
    task({ id: "bd1", section_id: "mm-bad" }),
    task({ id: "st1", section_id: "mm-old" }),
  ];
  const timeline = buildTimeline(tasks, MM_PROJECTS, sections, "2026-09-30");
  assert.deepEqual(timeline.lanes.map((lane) => lane.label), ["Build 32", "Redesign"]);
  assert.deepEqual(timeline.earlier.map((lane) => [lane.label, lane.text]), [
    ["Shipped", "2 of 2 done"],
    ["Start only", "0 of 1 done"],
    ["End only", "1 of 1 done"],
    ["Backwards", "0 of 1 done"],
    ["Stale", "0 of 1 done"],
  ]);
  // Only the drawn lanes count: Build 32 0/4 and Redesign 6/9. Shipped and the stale lane do not.
  assert.equal(timeline.summary.line, "Target 11/20 · 6 of 13 tasks done");
  assert.deepEqual(timeline.summary.health, { kind: "ok", label: "On track" }, "the stale open lane doesn't make it late");
});

test("timeline window: starts on a Monday a week back, ends 4–12 weeks ahead, weekly ticks", () => {
  const timeline = buildTimeline(mmTasks(), MM_PROJECTS, mmSections(), "2026-09-30");
  assert.equal(new Date(`${timeline.start}T00:00:00Z`).getUTCDay(), 1);
  assert.ok(timeline.start <= "2026-09-23" && timeline.start >= "2026-09-14");
  assert.ok(timeline.end >= "2026-11-23" && timeline.end <= "2026-12-23");
  assert.equal(timelinePosition(timeline, timeline.start), 0);
  assert.equal(timelinePosition(timeline, "2030-01-01"), 100);
  assert.equal(timeline.ticks[0], timeline.start);
  assert.equal(Date.parse(timeline.ticks[1]) - Date.parse(timeline.ticks[0]), 7 * 86_400_000);
  assert.equal(timeline.ticks.every((tick) => new Date(`${tick}T00:00:00Z`).getUTCDay() === 1), true);
});

test("timeline with no tasks and no plans is empty and centred on today", () => {
  const timeline = buildTimeline([], PROJECTS, SECTIONS, TODAY);
  assert.deepEqual(timeline.lanes, []);
  assert.deepEqual(timeline.earlier, []);
  assert.equal(timeline.summary, null);
  assert.equal(timeline.today, TODAY);
  assert.ok(timeline.start <= TODAY && timeline.end > TODAY);
});

test("a planned section with no tasks yet still draws, as 'No tasks yet'", () => {
  const timeline = buildTimeline([], MM_PROJECTS, mmSections().slice(6), "2026-10-01");
  assert.equal(timeline.lanes.length, 1);
  assert.deepEqual(timeline.lanes[0].health, { kind: "empty", label: "No tasks yet" });
  assert.equal(timeline.lanes[0].share, 0);
  assert.equal(timeline.summary.health, null, "nothing has started");
});

test("buildPortfolio: every app's target reads 'Target M/D' (no per-app name)", () => {
  const input = sampleInput();
  input.projects = PROJECTS.map((project) =>
    project.id === "proj-a" || project.id === "proj-b2" ? { ...project, target_date: "2026-11-20" } : project
  );
  input.sections = [
    { ...SECTIONS[0], planned_start: "2026-09-21", planned_end: "2026-10-09" },
    { ...SECTIONS[1], planned_start: "2026-10-12", planned_end: "2026-11-06" },
  ];
  const view = buildPortfolio(input, { scope: "personal", now: NOW });
  const ss = view.apps.find((app) => app.name === "Stock & Stir").timeline;
  assert.deepEqual(ss.lanes.map((lane) => lane.label), ["Release 3", "Release 4"]);
  assert.equal(ss.summary.line, "Target 11/20 · 1 of 3 tasks done");
  assert.deepEqual(ss.earlier.map((lane) => lane.label), ["Other tasks"]);
  const fam = view.apps.find((app) => app.name === "FamCal").timeline;
  assert.equal(fam.summary.line, "Target 11/20");
  assert.equal(fam.lanes.length, 0);
  assert.deepEqual(fam.earlier.map((lane) => lane.label), ["Finance Loop", "Sunday Brief"]);
});

// ── The list under the chart, when there is no chart ───────────────────────
test("earlier list rows carry the old bars' facts: overdue since, in progress / waiting, You", () => {
  const input = sampleInput();
  input.tasks.push(
    task({ id: "o1", status: "Planned", section_id: "sec-r4", due_at: "2026-09-20T21:00:00Z", owner: "brent" }),
    task({ id: "o2", status: "Backlog", section_id: "sec-r4", due_at: "2026-09-25T21:00:00Z" }),
    task({ id: "o3", status: "Backlog", section_id: "sec-r4", due_at: "2026-10-30T21:00:00Z" })
  );
  const rows = Object.fromEntries(
    buildPortfolio(input, { scope: "personal", now: NOW })
      .apps.find((app) => app.name === "Stock & Stir")
      .timeline.earlier.map((lane) => [lane.label, lane])
  );
  // Release 3: a2 is Brent's, In Progress, due 10/1 (not passed).
  assert.deepEqual([rows["Release 3"].state, rows["Release 3"].overdueSince, rows["Release 3"].hasBrent], ["in progress", null, true]);
  // Release 4: earliest passed due date wins; a future due date isn't overdue; Brent owns an open one.
  assert.deepEqual([rows["Release 4"].state, rows["Release 4"].overdueSince, rows["Release 4"].hasBrent], [null, "2026-09-20", true]);
  // Other tasks: a4 is an agent's In Progress task.
  assert.deepEqual([rows["Other tasks"].state, rows["Other tasks"].hasBrent], ["in progress", false]);
});

test("earlier list: waiting state, and closed tasks never count as overdue or owned", () => {
  const input = {
    implementations: IMPLS,
    projects: PROJECTS,
    sections: SECTIONS,
    tasks: [
      task({ id: "w1", status: "Blocked/Waiting", section_id: "sec-r3", due_at: "2026-09-26T21:00:00Z" }),
      task({ id: "w2", status: "Done", section_id: "sec-r4", due_at: "2026-09-20T21:00:00Z", owner: "brent" }),
      task({ id: "w3", status: "Parked", section_id: "sec-r4", due_at: "2026-09-20T21:00:00Z", owner: "brent" }),
    ],
  };
  const rows = Object.fromEntries(
    buildPortfolio(input, { scope: "personal", now: NOW })
      .apps.find((app) => app.name === "Stock & Stir")
      .timeline.earlier.map((lane) => [lane.label, lane])
  );
  assert.deepEqual([rows["Release 3"].state, rows["Release 3"].overdueSince], ["waiting", "2026-09-26"]);
  assert.deepEqual([rows["Release 4"].state, rows["Release 4"].overdueSince, rows["Release 4"].hasBrent], [null, null, false]);
});

test("planned dates never change Assigned to you, the counts or anything outside the timeline", () => {
  const plain = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const input = sampleInput();
  input.sections = [
    { ...SECTIONS[0], planned_start: "2026-09-21", planned_end: "2026-10-09" },
    { ...SECTIONS[1], planned_start: "2026-10-12", planned_end: "2026-11-06" },
  ];
  input.projects = PROJECTS.map((project) => (project.id === "proj-a" ? { ...project, target_date: "2026-11-20" } : project));
  const planned = buildPortfolio(input, { scope: "personal", now: NOW });
  assert.deepEqual(planned.assigned, plain.assigned);
  assert.deepEqual(planned.comingLater, plain.comingLater);
  assert.equal(planned.brentOpen, plain.brentOpen);
  assert.deepEqual(planned.overall, plain.overall);
  for (const app of planned.apps) {
    const before = plain.apps.find((a) => a.id === app.id);
    assert.deepEqual({ ...app, timeline: null }, { ...before, timeline: null });
  }
});

test("a planned end in the past is Late on the timeline only (open work), and Done once nothing is open", () => {
  const input = sampleInput();
  input.sections = [{ ...SECTIONS[0], planned_start: "2026-09-01", planned_end: "2026-09-10" }];
  const ss = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir").timeline;
  assert.deepEqual(ss.lanes.map((lane) => [lane.label, lane.health.label]), [["Release 3", "Late · due 9/10"]]);
  assert.equal(ss.summary.health.kind, "late");
  input.tasks = input.tasks.map((t) => (t.section_id === "sec-r3" ? { ...t, status: "Done" } : t));
  const done = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir").timeline;
  assert.deepEqual(done.lanes, []);
  assert.deepEqual(done.earlier.map((lane) => [lane.label, lane.text]), [["Release 3", "2 of 2 done"], ["Other tasks", "0 of 3 done"]]);
  assert.equal(done.summary, null, "nothing drawn, no target: no app chip");
});

// ── Owner fields ──────────────────────────────────────────────────────────
// ── Personal projects without an application ─────────────────────────────
const BLANKET = {
  id: "proj-blanket",
  name: "Personal — Christmas Tree Blanket",
  implementation_id: null,
  stage: "In Progress",
  portfolio_rank: 5,
  tags: ["personal", "crochet", "hobby"],
};
const BLANKET_SECTIONS = [
  { id: "bs-swatch", project_id: "proj-blanket", name: "1. Swatch", sort_order: 0, planned_start: "2026-09-21", planned_end: "2026-09-27" },
  { id: "bs-yarn", project_id: "proj-blanket", name: "2. Yarn", sort_order: 1, planned_start: "2026-09-28", planned_end: "2026-10-11" },
  { id: "bs-body", project_id: "proj-blanket", name: "3. Blanket body", sort_order: 2, planned_start: "2026-10-12", planned_end: "2026-11-22" },
  { id: "bs-finish", project_id: "proj-blanket", name: "4. Finishing", sort_order: 3, planned_start: "2026-11-23", planned_end: "2026-12-10" },
];
function blanketTask(overrides = {}) {
  return task({
    owner: "brent",
    implementation_id: null,
    project_id: "proj-blanket",
    tags: ["personal", "crochet"],
    project: { tags: BLANKET.tags },
    ...overrides,
  });
}
function blanketInput(extra = {}) {
  const input = sampleInput();
  input.projects = [...PROJECTS, BLANKET];
  input.sections = [...SECTIONS, ...BLANKET_SECTIONS];
  input.tasks = [
    ...input.tasks,
    blanketTask({ id: "bl1", status: "Done", section_id: "bs-swatch" }),
    blanketTask({ id: "bl2", status: "Done", section_id: "bs-swatch" }),
    blanketTask({ id: "bl3", status: "In Progress", section_id: "bs-yarn", status_line: "Yarn is on order.", priority_score: 70 }),
    blanketTask({ id: "bl4", status: "Backlog", section_id: "bs-yarn" }),
    blanketTask({ id: "bl5", status: "Backlog", section_id: "bs-body" }),
    blanketTask({ id: "bl6", status: "Blocked/Waiting", section_id: "bs-body" }),
    blanketTask({ id: "bl7", status: "Backlog", section_id: "bs-finish", owner: "agent", owner_label: "PM" }),
  ];
  Object.assign(input, extra);
  return input;
}
const blanketLane = (view) => view.apps.find((app) => app.kind === "project");

test("a personal project with no application gets its own lane, after the app lanes, without the 'Personal — ' prefix", () => {
  const view = buildPortfolio(blanketInput(), { scope: "personal", now: NOW });
  assert.deepEqual(view.apps.map((app) => app.name), ["FamCal", "Stock & Stir", "Christmas Tree Blanket"]);
  const lane = blanketLane(view);
  assert.equal(lane.id, "project:proj-blanket", "never collides with an application id");
  assert.equal(lane.kind, "project");
  assert.equal(lane.phase, "In Progress");
  assert.deepEqual(view.apps.filter((app) => app.kind === "app").map((app) => app.id), ["app-b", "app-a"]);
});

test("a project lane has the same counts, status line and next as an app lane", () => {
  const lane = blanketLane(buildPortfolio(blanketInput(), { scope: "personal", now: NOW }));
  assert.deepEqual([lane.counts.done, lane.counts.total, lane.counts.pct, lane.counts.open], [2, 7, 29, 5]);
  assert.equal(lane.stand, "Yarn is on order.");
  assert.equal(lane.next, "Task bl3", "no due dates: the highest-priority open task");
  assert.deepEqual(lane.agentLabels, ["PM"]);
});

test("a project lane's timeline is drawn from its sections' planned dates", () => {
  const lane = blanketLane(buildPortfolio(blanketInput(), { scope: "personal", now: NOW }));
  assert.deepEqual(
    lane.timeline.lanes.map((l) => [l.label, l.start, l.end, l.done, l.total]),
    [
      ["2. Yarn", "2026-09-28", "2026-10-11", 0, 2],
      ["3. Blanket body", "2026-10-12", "2026-11-22", 0, 2],
      ["4. Finishing", "2026-11-23", "2026-12-10", 0, 1],
    ]
  );
  assert.deepEqual(lane.timeline.earlier.map((l) => [l.label, l.text]), [["1. Swatch", "2 of 2 done"]]);
  assert.equal(lane.timeline.summary.line, "0 of 5 tasks done");
  assert.equal(lane.timeline.lanes.every((l) => l.project === null), true, "one project: no project prefix on the rows");
});

test("project lanes appear in the personal and all scopes, never in work scope (and Brent's work lane is untouched)", () => {
  const input = blanketInput();
  for (const scope of ["personal", "all"]) {
    assert.ok(blanketLane(buildPortfolio(input, { scope, now: NOW })), `${scope} shows the lane`);
  }
  const work = buildPortfolio(input, { scope: "work", now: NOW });
  assert.equal(work.apps.some((app) => app.kind === "project"), false);
  assert.deepEqual(work.apps.map((app) => app.name), ["OnCore"]);
  const sans = buildPortfolio(sampleInput(), { scope: "work", now: NOW });
  assert.deepEqual(work.overall, sans.overall);
  assert.deepEqual(work.assigned, sans.assigned);
});

test("a task tagged only 'work' in a non-personal project never makes a lane, even with no application", () => {
  const input = blanketInput();
  input.projects = input.projects.map((p) => (p.id === "proj-blanket" ? { ...p, tags: ["crochet"] } : p));
  input.tasks = input.tasks.map((t) => (t.project_id === "proj-blanket" ? { ...t, tags: ["crochet"], project: { tags: ["crochet"] } } : t));
  assert.equal(blanketLane(buildPortfolio(input, { scope: "all", now: NOW })), undefined, "needs the personal tag on the project");
  assert.equal(blanketLane(buildPortfolio(input, { scope: "personal", now: NOW })), undefined);
});

test("a project lane needs in-scope tasks, and cancelled or app-owned projects get none", () => {
  const empty = blanketInput();
  empty.tasks = empty.tasks.filter((t) => t.project_id !== "proj-blanket");
  assert.equal(blanketLane(buildPortfolio(empty, { scope: "personal", now: NOW })), undefined);
  const cancelled = blanketInput();
  cancelled.projects = cancelled.projects.map((p) => (p.id === "proj-blanket" ? { ...p, stage: "Cancelled" } : p));
  assert.equal(blanketLane(buildPortfolio(cancelled, { scope: "personal", now: NOW })), undefined);
  const withApp = blanketInput();
  withApp.projects = withApp.projects.map((p) => (p.id === "proj-blanket" ? { ...p, implementation_id: "app-a" } : p));
  assert.equal(blanketLane(buildPortfolio(withApp, { scope: "personal", now: NOW })), undefined, "projects with an application ride that app's lane");
});

test("project lanes sort by project rank, and a task already in an app lane is never counted twice", () => {
  const input = blanketInput();
  input.projects.push({ ...BLANKET, id: "proj-two", name: "Personal - Garden beds", portfolio_rank: 2 });
  input.tasks.push(blanketTask({ id: "g1", project_id: "proj-two", status: "Backlog" }));
  // A blanket task that carries an application id of its own counts in that app's lane only.
  input.tasks.push(blanketTask({ id: "stray", implementation_id: "app-a", status: "Backlog" }));
  const view = buildPortfolio(input, { scope: "personal", now: NOW });
  assert.deepEqual(view.apps.filter((a) => a.kind === "project").map((a) => a.name), ["Garden beds", "Christmas Tree Blanket"]);
  assert.equal(blanketLane(view) && view.apps.find((a) => a.name === "Christmas Tree Blanket").counts.total, 7);
  assert.equal(view.apps.find((a) => a.name === "Stock & Stir").counts.total, 6);
});

test("overall totals include project lanes in personal and all scope (chosen: Brent wants to see personal progress)", () => {
  const plain = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const view = buildPortfolio(blanketInput(), { scope: "personal", now: NOW });
  assert.equal(view.overall.total, plain.overall.total + 7);
  assert.equal(view.overall.done, plain.overall.done + 2);
  assert.equal(buildPortfolio(blanketInput(), { scope: "all", now: NOW }).overall.total, buildPortfolio(sampleInput(), { scope: "all", now: NOW }).overall.total + 7);
});

// ── The hobby tag ─────────────────────────────────────────────────────────
test("hobby tasks stay out of Assigned to you, Coming to you later and Brent's counts, but not the lane's progress", () => {
  const view = buildPortfolio(blanketInput(), { scope: "personal", now: NOW });
  assert.equal(view.assigned.some((t) => t.id.startsWith("bl")), false, "no hobby task in Assigned");
  assert.equal(view.comingLater.some((t) => t.id.startsWith("bl")), false, "no hobby task in Coming later (bl6 is blocked)");
  const lane = blanketLane(view);
  assert.deepEqual([lane.counts.done, lane.counts.total, lane.counts.open], [2, 7, 5]);
  assert.deepEqual([lane.counts.brentOpen, lane.counts.brentLater, lane.counts.agentOpen], [0, 0, 1], "agent counts unchanged");
  const plain = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.deepEqual(view.assigned, plain.assigned, "the hero list is exactly what it was without the blanket");
  assert.deepEqual(view.comingLater, plain.comingLater);
  assert.equal(view.brentOpen, plain.brentOpen);
  assert.equal(view.brentLater, plain.brentLater);
  assert.equal(view.overall.brentOpen, plain.overall.brentOpen);
  assert.equal(view.overall.brentLater, plain.overall.brentLater);
});

test("hobby tasks light no 'You' marker on the timeline", () => {
  const lane = blanketLane(buildPortfolio(blanketInput(), { scope: "personal", now: NOW }));
  assert.equal(lane.timeline.lanes.some((l) => l.hasBrent), false);
});

test("a personal task under an application (no hobby tag) still lands in Assigned to you", () => {
  const input = blanketInput();
  input.tasks.push(task({ id: "ss-brent", status: "In Progress", owner: "brent", project_id: "proj-a" }));
  const view = buildPortfolio(input, { scope: "personal", now: NOW });
  const row = view.assigned.find((t) => t.id === "ss-brent");
  assert.ok(row, "Stock & Stir style tasks are not hobby tasks");
  assert.equal(row.app, "Stock & Stir");
});

test("the hobby tag works on the task itself, and anywhere (an app lane's hobby task also leaves Assigned)", () => {
  const input = sampleInput();
  input.tasks.push(
    task({ id: "own-hobby", status: "In Progress", owner: "brent", tags: ["personal", "hobby"] }),
    task({ id: "not-hobby", status: "In Progress", owner: "brent", tags: ["personal"] })
  );
  const view = buildPortfolio(input, { scope: "personal", now: NOW });
  assert.equal(view.assigned.some((t) => t.id === "own-hobby"), false);
  assert.equal(view.assigned.some((t) => t.id === "not-hobby"), true);
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss.counts.total, 7, "both still count toward the app's progress");
});

test("parseTaskOwnerFields: absent keys change nothing (old callers)", () => {
  assert.deepEqual(parseTaskOwnerFields({ title: "x" }), { ok: true, value: {} });
  assert.deepEqual(parseTaskOwnerFields({ owner: undefined }), { ok: true, value: {} });
});

test("parseTaskOwnerFields: normalizes owner, trims and collapses lines, empty clears", () => {
  const result = parseTaskOwnerFields({ owner: " Brent ", owner_label: "  PM ", status_line: "Line one.\n\n  Line   two. " });
  assert.deepEqual(result, { ok: true, value: { owner: "brent", owner_label: "PM", status_line: "Line one. Line two." } });
  assert.deepEqual(parseTaskOwnerFields({ owner_label: "", status_line: null }), {
    ok: true,
    value: { owner_label: null, status_line: null },
  });
});

test("parseTaskOwnerFields: rejects unknown owners, null owner, non-strings and long values", () => {
  assert.equal(parseTaskOwnerFields({ owner: "bob" }).ok, false);
  assert.equal(parseTaskOwnerFields({ owner: null }).ok, false);
  assert.equal(parseTaskOwnerFields({ owner_label: 5 }).ok, false);
  assert.match(parseTaskOwnerFields({ owner_label: "x".repeat(41) }).error, /40/);
  assert.equal(parseTaskOwnerFields({ owner_label: "x".repeat(40) }).ok, true);
  assert.match(parseTaskOwnerFields({ status_line: "y".repeat(281) }).error, /280/);
  assert.equal(parseTaskOwnerFields({ status_line: "y".repeat(280) }).ok, true);
  assert.equal(normalizeTaskOwner("AGENT"), "agent");
  assert.equal(normalizeTaskOwner("you"), null);
});

// ── Markdown ──────────────────────────────────────────────────────────────
test("markdown: headings, paragraphs with line breaks, bold/italic/code", () => {
  const blocks = parseMarkdown("# Title\n\nFirst **bold** and *it* and `code`.\nSecond line\n\n## Sub");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "heading"]);
  assert.equal(blocks[0].level, 1);
  const para = blocks[1].children;
  assert.deepEqual(para.map((n) => n.type), ["text", "strong", "text", "em", "text", "code", "text", "br", "text"]);
  assert.equal(para[1].children[0].value, "bold");
});

test("markdown: task lists (the raw '- [ ]' Brent saw), nested and ordered lists", () => {
  const [list] = parseMarkdown("- [x] Siri\n- [ ] Split View\n  - nested detail\n- plain");
  assert.equal(list.type, "list");
  assert.deepEqual(list.items.map((item) => item.checked), [true, false, null]);
  assert.equal(list.items[1].children[1].type, "list");
  assert.equal(list.items[1].children[1].items[0].children[0].children[0].value, "nested detail");
  const [ordered] = parseMarkdown("3. three\n4. four");
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);
  assert.equal(ordered.items.length, 2);
});

test("markdown: a blank line between items keeps one list; lazy continuation joins the item", () => {
  const blocks = parseMarkdown("- one\n\n- two\ncontinued\n\nAfter");
  assert.deepEqual(blocks.map((b) => b.type), ["list", "paragraph"]);
  assert.equal(blocks[0].items.length, 2);
  assert.deepEqual(blocks[0].items[1].children[0].children.map((n) => n.type), ["text", "br", "text"]);
});

test("markdown: GFM tables with alignment and escaped pipes", () => {
  const [table] = parseMarkdown("| Project | Id |\n| :--- | ---: |\n| A \\| B | 1 |\n| C | 2 |");
  assert.equal(table.type, "table");
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0][0].value, "A | B");
});

test("markdown: fenced code, blockquote, rule", () => {
  const blocks = parseMarkdown("```sql\nselect 1;\n**not bold**\n```\n> quoted\n\n---");
  assert.deepEqual(blocks.map((b) => b.type), ["code", "blockquote", "hr"]);
  assert.equal(blocks[0].lang, "sql");
  assert.equal(blocks[0].value, "select 1;\n**not bold**");
});

test("markdown links: safe schemes only; bare URLs lose trailing punctuation", () => {
  assert.equal(safeHref("https://claude.ai/x"), "https://claude.ai/x");
  assert.equal(safeHref("/r/task/1"), "/r/task/1");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  // Browsers treat "\" like "/", so "/\evil.example/x" is protocol-relative too.
  assert.equal(safeHref("/\\evil.example/x"), null);
  assert.equal(parseInline("[x](/\\evil.example/x)").some((n) => n.type === "link"), false);
  // Browsers strip tabs and newlines from URLs before resolving them.
  assert.equal(safeHref("/\t/evil.example"), null);
  assert.equal(safeHref("/\n/evil.example"), null);
  assert.equal(safeHref("/\r\\evil.example"), null);
  assert.equal(safeHref("/r/task/1?x=a b"), null);
  assert.equal(safeHref("https://claude.ai/artifact/abc"), "https://claude.ai/artifact/abc");
  assert.equal(safeHref("data:text/html,x"), null);
  const bad = parseInline("[click](javascript:alert(1))");
  assert.equal(bad.some((n) => n.type === "link"), false);
  const good = parseInline("[mockup](https://claude.ai/artifact/abc)");
  assert.equal(good[0].type, "link");
  const bare = parseInline("See https://example.com/a_b, then (https://example.com/c).");
  const links = bare.filter((n) => n.type === "link").map((n) => n.href);
  assert.deepEqual(links, ["https://example.com/a_b", "https://example.com/c"]);
});

test("markdown: snake_case and lone asterisks stay text; raw HTML stays text", () => {
  const nodes = parseInline("owner_label and status_line, 2 * 3 * 4");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].value, "owner_label and status_line, 2 * 3 * 4");
  const html = parseInline("<script>alert(1)</script>");
  assert.deepEqual(html, [{ type: "text", value: "<script>alert(1)</script>" }]);
  assert.equal(parseInline("\\*literal\\*")[0].value, "*literal*");
});

test("markdown: empty and pathological input", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown(null), []);
  const deep = Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
  const started = Date.now();
  assert.equal(parseMarkdown(deep).length, 1);
  const stars = "*".repeat(5000) + "a" + "_".repeat(5000);
  parseInline(stars);
  assert.ok(Date.now() - started < 2000, "parser stays fast on hostile input");
});

// ── Partial credit from checklist items (Brent, 10/3) ─────────────────────
// Each task is an equal slice of the row; a task's checklist items split its slice equally.
// Done = 1, a task not Done = ticked ÷ items (0 with no checklist). Counts stay whole tasks.
const cl = (done, total) => ({ done, total });

test("taskCredit: Done is 1 whatever its checklist; open is ticked ÷ items; no checklist is 0", () => {
  assert.equal(taskCredit({ id: "x", status: "Done" }, { x: cl(0, 5) }), 1, "a Done task with unticked items still counts 1");
  assert.equal(taskCredit({ id: "x", status: "Done" }), 1);
  assert.equal(taskCredit({ id: "x", status: "In Progress" }, { x: cl(3, 14) }), 3 / 14);
  assert.equal(taskCredit({ id: "x", status: "Backlog" }, { x: cl(0, 14) }), 0, "an unticked checklist earns nothing");
  assert.equal(taskCredit({ id: "x", status: "Backlog" }, { x: cl(4, 4) }), 1, "a fully ticked open task earns its whole slice");
  assert.equal(taskCredit({ id: "x", status: "Backlog" }, {}), 0, "no checklist, no credit");
  assert.equal(taskCredit({ id: "x", status: "Backlog" }, { x: cl(0, 0) }), 0, "an empty checklist is no checklist");
  assert.equal(taskCredit({ id: "x", status: "Backlog" }, { x: cl(9, 4) }), 1, "ticked is clamped to the items");
  assert.equal(taskCredit({ id: "x", status: "Parked" }, { x: cl(1, 2) }), 0.5, "Parked/Missed keep what was ticked, and stay in the denominator");
});

test("percentDone with partial credit: never 100 unless every task is Done, never 0 with any progress", () => {
  assert.equal(percentDone(2, 23, 2 + 3 / 14), 10);
  assert.equal(percentDone(0, 4, 0.5), 13);
  assert.equal(percentDone(0, 300, 1 / 14), 1, "partial progress alone never rounds down to 0");
  assert.equal(percentDone(3, 4, 4), 99, "all credit but one task still open is 99, not 100");
  assert.equal(percentDone(199, 200, 200), 99);
  assert.equal(percentDone(4, 4, 4), 100);
  assert.equal(percentDone(2, 5, 1), 40, "progress below done is lifted to done");
  assert.equal(percentDone(0, 5, 9), 99, "progress above the total is clamped, and 100 still needs every task Done");
  assert.equal(percentDone(2, 5), 40, "two arguments behave as before");
});

// The real blanket row (10/3 5:23 PM ET): 23 tasks, Steps 1 and 2 Done, Step 3 has 14 items with 3 ticked.
const NOW_103 = new Date("2026-10-03T21:23:00Z");
function realBlanket() {
  const tasks = [
    blanketTask({ id: "st1", status: "Done" }),
    blanketTask({ id: "st2", status: "Done" }),
    blanketTask({ id: "st3", status: "In Progress" }),
    ...Array.from({ length: 20 }, (_, i) => blanketTask({ id: `st${i + 4}`, status: "Backlog" })),
  ];
  return {
    implementations: [],
    projects: [BLANKET],
    sections: [],
    tasks,
    // Some open tasks have checklists with nothing ticked; Step 3 has 3 of 14.
    checklist: { st3: cl(3, 14), st4: cl(0, 6), st5: cl(0, 3), st6: cl(0, 8), st1: cl(0, 2) },
  };
}

test("the real blanket row: Steps 1-2 Done and 3 of 14 ticked on Step 3 reads 10%, not 9%", () => {
  const input = realBlanket();
  assert.equal(input.tasks.length, 23);
  const withChecklist = buildPortfolio(input, { scope: "personal", now: NOW_103 });
  const lane = blanketLane(withChecklist);
  assert.equal(lane.counts.total, 23);
  assert.equal(lane.counts.done, 2, "the count stays whole tasks");
  assert.ok(Math.abs(lane.counts.credit - (2 + 3 / 14)) < 1e-9);
  assert.equal(lane.counts.pct, 10); // (1 + 1 + 3/14) / 23 = 9.66 → 10
  assert.equal(withChecklist.overall.pct, 10, "the hero's overall % uses the same credit");
  assert.equal(withChecklist.overall.done, 2);
  const before = blanketLane(buildPortfolio({ ...input, checklist: undefined }, { scope: "personal", now: NOW_103 }));
  assert.equal(before.counts.pct, 9, "without the checklist data it is today's 2 ÷ 23 = 9");
  assert.equal(before.counts.credit, 2);
});

test("a Done task with unticked items counts 1; an open task with every item ticked counts 1 but never finishes the row", () => {
  const input = {
    implementations: [],
    projects: [BLANKET],
    sections: [],
    tasks: [blanketTask({ id: "d1", status: "Done" }), blanketTask({ id: "o1", status: "In Progress" })],
    checklist: { d1: cl(0, 5), o1: cl(4, 4) },
  };
  const view = buildPortfolio(input, { scope: "personal", now: NOW_103 });
  const lane = blanketLane(view);
  assert.equal(lane.counts.credit, 2, "1 for the Done task whatever its items, 1 for the fully ticked one");
  assert.equal(lane.counts.done, 1);
  assert.equal(lane.counts.open, 1, "the fully ticked task is still open");
  assert.equal(lane.counts.pct, 99, "not 100 until it is Done");
  assert.equal(view.overall.pct, 99);
  // With the task marked Done, the row is 100.
  input.tasks[1] = blanketTask({ id: "o1", status: "Done" });
  assert.equal(blanketLane(buildPortfolio(input, { scope: "personal", now: NOW_103 })).counts.pct, 100);
});

test("a work app row with no checklists is unchanged; with checklists it earns partial credit too", () => {
  const plain = buildPortfolio(sampleInput(), { scope: "work", now: NOW });
  assert.equal(plain.apps[0].counts.pct, 50);
  assert.equal(plain.apps[0].counts.credit, 1);
  const empty = buildPortfolio({ ...sampleInput(), checklist: {} }, { scope: "work", now: NOW });
  assert.deepEqual(empty, plain, "an empty checklist map changes nothing");
  // w2 (open) has 1 of 2 items ticked: (1 + .5) ÷ 2 = 75%.
  const partly = buildPortfolio({ ...sampleInput(), checklist: { w2: cl(1, 2) } }, { scope: "work", now: NOW });
  assert.equal(partly.apps[0].counts.pct, 75);
  assert.deepEqual([partly.apps[0].counts.done, partly.apps[0].counts.total, partly.apps[0].counts.open], [1, 2, 1]);
  assert.equal(partly.overall.pct, 75);
  // And in every scope: a personal app row moves too (a2 half ticked: (1 + .5) ÷ 5 = 30%).
  const personal = buildPortfolio({ ...sampleInput(), checklist: { a2: cl(2, 4) } }, { scope: "personal", now: NOW });
  assert.equal(personal.apps.find((app) => app.name === "Stock & Stir").counts.pct, 30);
});

test("whole-task counts, owner counts and labels do not change with partial credit", () => {
  const plain = buildPortfolio(sampleInput(), { scope: "all", now: NOW });
  const partly = buildPortfolio({ ...sampleInput(), checklist: { a2: cl(2, 4), a3: cl(1, 3), w2: cl(1, 2) } }, { scope: "all", now: NOW });
  const strip = (app) => ({ ...app.counts, pct: 0, credit: 0 });
  assert.deepEqual(partly.apps.map(strip), plain.apps.map(strip));
  for (const key of ["brentOpen", "brentLater", "agentOpen", "agentInProgress", "assigned", "comingLater"]) {
    assert.deepEqual(partly[key], plain[key], key);
  }
  assert.equal(partly.overall.done, plain.overall.done);
  assert.equal(partly.overall.open, plain.overall.open);
});

// A 10-day section window 10/1–10/10; on 10/6 the expected share is 0.55, so Behind is a share under .30 and Ahead from .70.
function windowTimeline(checklist) {
  const tasks = [
    ...Array.from({ length: 2 }, (_, i) => task({ id: `ph-d${i}`, status: "Done", section_id: "sec-w" })),
    task({ id: "ph-x", status: "In Progress", section_id: "sec-w" }),
    ...Array.from({ length: 7 }, (_, i) => task({ id: `ph-o${i}`, status: "Backlog", section_id: "sec-w" })),
  ];
  const sections = [{ id: "sec-w", project_id: "proj-a", name: "Window", sort_order: 0, planned_start: "2026-10-01", planned_end: "2026-10-10" }];
  return buildTimeline(tasks, [PROJECTS[0]], sections, "2026-10-06", checklist).lanes[0];
}

test("laneHealth: partial credit moves the judgment (credit defaults to done)", () => {
  const h = (done, credit) => laneHealth({ done, credit, total: 10, start: "2026-10-01", end: "2026-10-10", today: "2026-10-06" }).kind;
  assert.equal(h(2, undefined), "behind", "no credit given: done share .2 is behind");
  assert.equal(h(2, 2.5), "behind"); // .25 + .25 < .55
  assert.equal(h(2, 3), "ok"); // .30 + .25 = .55, not below it
  assert.equal(h(2, 6.9), "ok");
  assert.equal(h(2, 7), "ahead"); // .70 ≥ .55 + .15
  assert.equal(h(2, 1), "behind", "credit below done never lowers the share below done");
  assert.equal(laneHealth({ done: 9, credit: 10, total: 10, open: 1, start: "2026-10-01", end: "2026-10-10", today: "2026-10-06" }).kind, "ahead");
  assert.equal(laneHealth({ done: 2, credit: 4, total: 4, open: 0, start: "2026-10-01", end: "2026-10-10", today: "2026-10-06" }).kind, "done", "open tasks decide Done, never credit");
});

test("timeline: the fill and Behind/On track follow partly ticked checklists", () => {
  const none = windowTimeline({});
  assert.deepEqual([none.done, none.total, none.credit, none.share, none.health.kind], [2, 10, 2, 0.2, "behind"]);
  assert.equal(none.sub, "2 of 10 done · 1 in progress");
  // 5 of 10 items on the In Progress task: credit 2.5, still Behind, and the fill moves.
  const half = windowTimeline({ "ph-x": cl(5, 10) });
  assert.equal(half.credit, 2.5);
  assert.equal(half.share, 0.25);
  assert.equal(half.health.kind, "behind");
  assert.equal(half.sub, "2 of 10 done + partial · 1 in progress", "whole-task count stays; '+ partial' explains the fill");
  assert.equal(half.done, 2);
  // Every item ticked: credit 3 → share .30 crosses the threshold, Behind → On track.
  const all = windowTimeline({ "ph-x": cl(10, 10) });
  assert.equal(all.share, 0.3);
  assert.deepEqual([all.health.kind, all.health.label], ["ok", "On track"]);
  assert.equal(all.done, 2, "a fully ticked open task is not counted as done");
  // Items spread over several open tasks add up the same way: 7 tasks × 1/2 + ... credit 2 + .5×2 = 3.
  const spread = windowTimeline({ "ph-o0": cl(1, 2), "ph-o1": cl(2, 4) });
  assert.equal(spread.credit, 3);
  assert.equal(spread.health.kind, "ok");
});

test("timeline summary line: whole-task count, '+ partial' only when partly ticked items add to it", () => {
  const tasks = [task({ id: "s1", status: "Done", section_id: "sec-w" }), task({ id: "s2", status: "Backlog", section_id: "sec-w" })];
  const sections = [{ id: "sec-w", project_id: "proj-a", name: "Window", sort_order: 0, planned_start: "2026-10-01", planned_end: "2026-10-10" }];
  const run = (checklist) => buildTimeline(tasks, [PROJECTS[0]], sections, "2026-10-06", checklist).summary;
  assert.equal(run({}).line, "1 of 2 tasks done");
  assert.equal(run({ s1: cl(0, 3) }).line, "1 of 2 tasks done", "a Done task's unticked items add nothing");
  const partly = run({ s2: cl(1, 2) });
  assert.equal(partly.line, "1 of 2 tasks done + partial");
  assert.deepEqual([partly.done, partly.total, partly.credit], [1, 2, 1.5]);
});

test("buildPortfolio feeds the checklist through to the app rows' timelines", () => {
  const input = blanketInput({ checklist: { bl4: cl(1, 2) } });
  const lane = blanketLane(buildPortfolio(input, { scope: "personal", now: NOW }));
  const yarn = lane.timeline.lanes.find((l) => l.label === "2. Yarn");
  assert.deepEqual([yarn.done, yarn.total, yarn.credit, yarn.share], [0, 2, 0.5, 0.25]);
  assert.equal(yarn.sub, "0 of 2 done + partial · 1 in progress");
  assert.equal(lane.counts.pct, Math.round(((2 + 0.5) / 7) * 100));
});

// ── Loading the checklist numbers: one paged read, not one query per task ───
function mockSupabase(rowsByTable) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, filters: [], range: null };
      calls.push(call);
      const builder = {
        select(columns) {
          call.columns = columns;
          return builder;
        },
        eq(column, value) {
          call.filters.push([column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        range(from, to) {
          call.range = [from, to];
          return builder;
        },
        then(resolve) {
          const rows = rowsByTable[table] ?? [];
          resolve({ data: call.range ? rows.slice(call.range[0], call.range[1] + 1) : rows, error: null });
        },
      };
      return builder;
    },
  };
}

await testAsync("loadChecklistProgress: ticked ÷ items per task from one paged, user-scoped read", async () => {
  const rows = [];
  for (let i = 0; i < 2300; i += 1) rows.push({ task_id: `t${i % 50}`, is_done: i % 3 === 0 });
  const client = mockSupabase({ task_checklist_items: rows });
  const progress = await loadChecklistProgress(client, "user-1");
  // 2,300 rows are 3 pages of up to 1,000; never a query per task (50 tasks).
  assert.equal(client.calls.length, 3);
  assert.ok(client.calls.every((call) => call.table === "task_checklist_items"));
  assert.ok(client.calls.every((call) => call.filters.some(([c, v]) => c === "user_id" && v === "user-1")), "scoped by user_id");
  assert.equal(client.calls[0].columns, "task_id, is_done", "only the two columns it needs");
  assert.equal(Object.keys(progress).length, 50);
  const totals = Object.values(progress).reduce((sum, p) => [sum[0] + p.done, sum[1] + p.total], [0, 0]);
  assert.deepEqual(totals, [rows.filter((r) => r.is_done).length, 2300]);
  assert.deepEqual(progress.t0, { done: rows.filter((r, i) => i % 50 === 0 && r.is_done).length, total: 46 });
  assert.deepEqual(await loadChecklistProgress(mockSupabase({}), "user-1"), {}, "no items: no entries (no partial credit)");
});

await testAsync("loadPortfolioInput carries the checklist numbers into the model input", async () => {
  const client = mockSupabase({
    tasks: [],
    implementations: [],
    projects: [],
    project_sections: [],
    task_checklist_items: [
      { task_id: "z1", is_done: true },
      { task_id: "z1", is_done: false },
    ],
  });
  const input = await loadPortfolioInput(client, "user-1");
  assert.deepEqual(input.checklist, { z1: { done: 1, total: 2 } });
  assert.equal(client.calls.filter((call) => call.table === "task_checklist_items").length, 1, "one checklist query");
});

console.log(`\n${passed} passed`);
