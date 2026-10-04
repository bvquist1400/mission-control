#!/usr/bin/env node
// Personal tasks and personal projects must never reach the automated work
// surfaces: the EOD / weekly / monthly reviews, the briefing digest and the
// briefing's open review items. Each surface runs against a tiny in-memory
// Supabase fake; no database needed.
//
//   npm run test:personal-work-reviews

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const load = (rel) => import(pathToFileURL(path.join(cwd, rel)).href);

const { workEodReviewRead } = await load("src/lib/work-intelligence/eod-review.ts");
const { workWeeklyReviewRead, stripPersonalFromStoredEodReview } = await load("src/lib/work-intelligence/weekly-review.ts");
const { workMonthlyReviewRead } = await load("src/lib/work-intelligence/monthly-review.ts");
const { readBriefingOpenReviewItems } = await load("src/lib/briefing/open-review-items.ts");
const { buildDailyBriefDigest } = await load("src/lib/briefing/digest.ts");
const { excludePersonalCommitments, excludePersonalProjectUpdates, excludePersonalTasks } = await load("src/lib/personal-exclusion.ts");
const { calculateCapacity } = await load("src/lib/capacity.ts");

/** A chainable, thenable stand-in for the Supabase query builder. Honors `.in()`; ignores everything else. */
function makeSupabase(tables) {
  return {
    from(table) {
      const state = { rows: tables[table] ?? [], write: false };
      const builder = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              return (resolve, reject) =>
                Promise.resolve({ data: state.write ? null : state.rows, error: null }).then(resolve, reject);
            }
            if (prop === "maybeSingle" || prop === "single") {
              return () => Promise.resolve({ data: state.rows[0] ?? null, error: null });
            }
            return (...args) => {
              if (prop === "update" || prop === "upsert" || prop === "insert" || prop === "delete") state.write = true;
              if (prop === "in") {
                const [column, values] = args;
                state.rows = state.rows.filter((row) => values.includes(row[column]));
              }
              return builder;
            };
          },
        }
      );
      return builder;
    },
  };
}

let passed = 0;
let failed = 0;
// Every test runs even if an earlier one fails, so one run shows every surface that leaks.
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      failed += 1;
      console.log(`not ok - ${name}\n    ${String(error.message).split("\n").slice(0, 6).join("\n    ")}`);
    });
}

const DAY = "2026-03-24"; // a Tuesday
const NOW = new Date("2026-03-24T21:00:00.000Z");
const RECENT = "2026-03-24T14:00:00.000Z";
const OLD = "2026-03-02T14:00:00.000Z";

const WORK_PROJECT = { id: "proj-work", name: "Quarterly Launch", stage: "In Progress", rag: "Green", tags: [] };
const PERSONAL_PROJECT = { id: "proj-hobby", name: "Personal — Christmas Tree Blanket", stage: "In Progress", rag: "Green", tags: ["personal", "hobby"] };
const IMPL = { id: "impl-1", name: "Alpha Platform", phase: "Build", rag: "Green" };

function makeTask(id, overrides = {}) {
  return {
    id,
    user_id: "user-1",
    title: `Title of ${id}`,
    description: null,
    implementation_id: "impl-1",
    project_id: WORK_PROJECT.id,
    sprint_id: null,
    status: "Planned",
    task_type: "Task",
    priority_score: 60,
    base_priority: 60,
    estimated_minutes: 60,
    actual_minutes: null,
    recurrence: null,
    estimate_source: "manual",
    due_at: null,
    needs_review: false,
    blocker: false,
    waiting_on: null,
    follow_up_at: null,
    stakeholder_mentions: [],
    tags: [],
    source_type: "manual",
    source_url: null,
    inbox_item_id: null,
    pinned_excerpt: null,
    pinned: false,
    owner: "agent",
    is_recurring_template: false,
    recurring_template_id: null,
    created_at: "2026-03-20T14:00:00.000Z",
    updated_at: RECENT,
    implementation: IMPL,
    project: WORK_PROJECT,
    sprint: null,
    ...overrides,
  };
}

// One work task and two kinds of personal task for each thing a review lists.
function taskSet() {
  const personalTagged = { tags: ["personal"] };
  const inPersonalProject = { project_id: PERSONAL_PROJECT.id, project: PERSONAL_PROJECT, implementation_id: null, implementation: null };
  return [
    // Shipped this week
    makeTask("w-done", { status: "Done" }),
    makeTask("p-done-tag", { status: "Done", ...personalTagged }),
    makeTask("p-done-proj", { status: "Done", ...inPersonalProject }),
    // Open, blocked, needing a decision, and stalled
    makeTask("w-open", { status: "In Progress", due_at: "2026-03-24T20:00:00.000Z" }),
    makeTask("p-open-tag", { status: "In Progress", due_at: "2026-03-24T20:00:00.000Z", ...personalTagged }),
    makeTask("p-open-proj", { status: "In Progress", due_at: "2026-03-24T20:00:00.000Z", ...inPersonalProject }),
    makeTask("w-blocked", { status: "Blocked/Waiting", blocker: true, waiting_on: "Vendor" }),
    makeTask("p-blocked-proj", { status: "Blocked/Waiting", blocker: true, waiting_on: "Yarn shop", ...inPersonalProject }),
    makeTask("w-decide", { needs_review: true }),
    makeTask("p-decide-proj", { needs_review: true, ...inPersonalProject }),
    makeTask("w-stalled", { status: "In Progress", updated_at: OLD }),
    makeTask("p-stalled-proj", { status: "In Progress", updated_at: OLD, ...inPersonalProject }),
  ];
}

const PERSONAL_IDS = ["p-done-tag", "p-done-proj", "p-open-tag", "p-open-proj", "p-blocked-proj", "p-decide-proj", "p-stalled-proj"];

function commitmentRows() {
  return [
    {
      id: "c-work", title: "Work commitment", direction: "theirs", status: "Open", due_at: null, notes: null,
      created_at: "2026-03-01T14:00:00.000Z", updated_at: "2026-03-01T14:00:00.000Z",
      stakeholder: { id: "s-1", name: "Pat" },
      task: { id: "w-open", title: "Title of w-open", status: "In Progress", implementation_id: "impl-1", tags: [], project: { tags: [] } },
    },
    {
      id: "c-personal", title: "Personal commitment", direction: "theirs", status: "Open", due_at: null, notes: null,
      created_at: "2026-03-01T14:00:00.000Z", updated_at: "2026-03-01T14:00:00.000Z",
      stakeholder: { id: "s-2", name: "Yarn Shop" },
      task: { id: "p-open-proj", title: "Title of p-open-proj", status: "In Progress", implementation_id: null, tags: [], project: { tags: ["personal", "hobby"] } },
    },
  ];
}

function projectUpdates() {
  const base = {
    summary: "Summary", rag: "Yellow", changes_today: ["Did a thing"], blockers: ["Waiting on something"],
    next_step: "Next", needs_decision: "Pick one", implementation: null,
  };
  return [
    { id: "u-work", project_id: WORK_PROJECT.id, captured_for_date: DAY, project: WORK_PROJECT, ...base },
    { id: "u-personal", project_id: PERSONAL_PROJECT.id, captured_for_date: DAY, project: PERSONAL_PROJECT, ...base },
  ];
}

function allTables(extra = {}) {
  return {
    tasks: taskSet(),
    commitments: commitmentRows(),
    implementations: [IMPL],
    project_status_updates: projectUpdates(),
    briefing_review_snapshots: [],
    projects: [WORK_PROJECT, PERSONAL_PROJECT],
    ...extra,
  };
}

function assertNoPersonal(value, label) {
  const text = JSON.stringify(value);
  for (const id of PERSONAL_IDS) {
    assert.ok(!text.includes(id), `${label} leaked ${id}`);
  }
  for (const needle of ["Title of p-", "Christmas Tree Blanket", "Personal commitment", "Yarn Shop", "u-personal"]) {
    assert.ok(!text.includes(needle), `${label} leaked "${needle}"`);
  }
}

await test("weekly review: personal tasks never show as shipped, stalled or pending decisions", async () => {
  const result = await workWeeklyReviewRead({
    supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW, includeRawSignals: true,
  });
  const { routePayload } = result;
  assert.deepEqual(routePayload.shipped.map((task) => task.id), ["w-done"]);
  assert.deepEqual(routePayload.stalled.map((task) => task.id), ["w-stalled"]);
  assert.deepEqual(routePayload.pending_decisions.map((task) => task.id), ["w-decide"]);
  assertNoPersonal(result, "weekly review");
});

await test("weekly review: a commitment on a personal task is dropped, a work one stays", async () => {
  const { routePayload } = await workWeeklyReviewRead({
    supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW,
  });
  assert.deepEqual(routePayload.cold_commitments.map((c) => c.id), ["c-work"]);
});

await test("weekly review: status updates for a personal project are dropped", async () => {
  const { routePayload } = await workWeeklyReviewRead({
    supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW,
  });
  assert.deepEqual(routePayload.project_rollups.map((r) => r.project_id), [WORK_PROJECT.id]);
  assert.deepEqual(routePayload.projects_needing_attention.map((r) => r.project_id), [WORK_PROJECT.id]);
});

await test("weekly review: personal tasks do not count toward application health", async () => {
  const tables = allTables({
    commitments: [],
    tasks: [
      makeTask("p-block-1", { status: "Blocked/Waiting", blocker: true, tags: ["personal"] }),
      makeTask("p-block-2", { status: "Blocked/Waiting", blocker: true, project_id: PERSONAL_PROJECT.id, project: PERSONAL_PROJECT }),
    ],
  });
  const { routePayload } = await workWeeklyReviewRead({ supabase: makeSupabase(tables), userId: "user-1", date: DAY, now: NOW });
  const score = routePayload.health_scores.find((s) => s.id === "impl-1");
  assert.equal(score.health_score, 0, "two personal blockers must not raise the score");
});

await test("weekly review: an old EOD snapshot cannot bring a personal task back", async () => {
  const stored = {
    id: "snap-1", review_type: "eod", anchor_date: DAY, period_start: DAY, period_end: DAY,
    title: "EOD", summary: "", source: "system", created_at: RECENT, updated_at: RECENT,
    payload: {
      review: {
        reviewType: "eod", requestedDate: DAY, generatedAt: RECENT,
        completedToday: [
          { taskId: "w-done", title: "Title of w-done", context: null, reason: "Closed today.", updatedAt: RECENT, dueAt: null },
          { taskId: "p-done-proj", title: "Title of p-done-proj", context: null, reason: "Closed today.", updatedAt: RECENT, dueAt: null },
        ],
        rolledForward: [{ taskId: "p-open-tag", title: "Title of p-open-tag", context: null, reason: "Open.", updatedAt: RECENT, dueAt: null }],
        openBlockers: [], tomorrowFirstThings: [], coldFollowups: [], statusUpdateRecommendations: [], operatingRisks: [], narrativeHints: [],
      },
    },
  };
  const result = await workWeeklyReviewRead({
    supabase: makeSupabase(allTables({ briefing_review_snapshots: [stored] })), userId: "user-1", date: DAY, now: NOW, includeRawSignals: true,
  });
  assertNoPersonal(result.review, "weekly review (stored EOD)");
  assert.ok(JSON.stringify(result.review).includes("w-done"), "the work item from the stored EOD stays");

  const unit = stripPersonalFromStoredEodReview({ review: stored.payload.review }, new Set(["p-done-proj", "p-open-tag"]));
  assert.deepEqual(unit.review.completedToday.map((i) => i.taskId), ["w-done"]);
  assert.deepEqual(unit.review.rolledForward, []);
});

await test("EOD review: personal tasks never appear in completed, rolled forward, blockers or tomorrow-first", async () => {
  const result = await workEodReviewRead({
    supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW, includeRawSignals: true, includeNarrativeHints: true,
  });
  const { review } = result;
  assert.deepEqual(review.completedToday.map((i) => i.taskId), ["w-done"]);
  assert.ok(review.rolledForward.every((i) => i.taskId.startsWith("w-")));
  assert.ok(review.openBlockers.every((i) => i.taskId.startsWith("w-")));
  assert.ok(review.openBlockers.some((i) => i.taskId === "w-blocked"));
  assertNoPersonal(result, "EOD review");
});

await test("EOD review: a commitment on a personal task is not a cold follow-up", async () => {
  const { review } = await workEodReviewRead({ supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW });
  const text = JSON.stringify(review.coldFollowups);
  assert.ok(!text.includes("c-personal") && !text.includes("Personal commitment"));
});

await test("monthly review: status updates for a personal project are dropped", async () => {
  const result = await workMonthlyReviewRead({ supabase: makeSupabase(allTables()), userId: "user-1", date: DAY, now: NOW });
  assert.deepEqual(result.routePayload.project_rollups.map((r) => r.project_id), [WORK_PROJECT.id]);
  assert.equal(result.routePayload.totals.project_status_update_count, 1);
  assertNoPersonal(result, "monthly review");
});

await test("briefing open review items: an artifact about a personal task is dropped", async () => {
  const artifact = (id, taskId) => ({
    id, artifact_kind: "single_contract", subject_key: `task:${taskId}`, primary_contract_type: "recently_unblocked",
    severity: "high", review_payload: {}, updated_at: RECENT,
  });
  const tables = {
    intelligence_artifacts: [artifact("a-work", "w-open"), artifact("a-tag", "p-open-tag"), artifact("a-proj", "p-open-proj")],
    tasks: taskSet().map(({ id, title, tags, project }) => ({ id, title, tags, project: { tags: project.tags } })),
  };
  const items = await readBriefingOpenReviewItems(makeSupabase(tables), "user-1");
  assert.deepEqual(items.map((item) => item.task_id), ["w-open"]);
});

await test("briefing digest: personal tasks, their commitments and their review artifacts stay out", async () => {
  const tables = allTables({
    stakeholders: [{ id: "s-1", name: "Pat" }, { id: "s-2", name: "Yarn Shop" }],
    intelligence_artifacts: [{
      id: "a-proj", artifact_kind: "single_contract", subject_key: "task:p-open-proj", primary_contract_type: "recently_unblocked",
      severity: "high", review_payload: {}, updated_at: RECENT,
    }],
  });
  const digest = await buildDailyBriefDigest({ supabase: makeSupabase(tables), userId: "user-1", mode: "morning", date: DAY });
  assertNoPersonal(digest, "briefing digest");
  assert.ok(JSON.stringify(digest).includes("w-open"), "the work task is still in the digest");
});

// Pace tracking (migration 059) rolls work-session minutes into tasks.actual_minutes,
// which feeds the capacity estimate's estimation accuracy. A hobby project's
// sessions must never move the work numbers.
await test("capacity: a personal task's session-rolled actual_minutes never changes work estimation accuracy or capacity", async () => {
  const work = makeTask("w-acc", { status: "Done", estimated_minutes: 60, actual_minutes: 60 });
  const personal = makeTask("p-acc-proj", {
    status: "Done", estimated_minutes: 60, actual_minutes: 374,
    project_id: PERSONAL_PROJECT.id, project: PERSONAL_PROJECT, implementation_id: null, implementation: null,
  });
  const unfiltered = calculateCapacity([work, personal], new Set(), 0);
  assert.notEqual(unfiltered.breakdown.estimation_accuracy, 1, "sensitivity: unfiltered, the personal actual would move it");
  const filtered = calculateCapacity(excludePersonalTasks([work, personal]), new Set(), 0);
  assert.equal(filtered.breakdown.estimation_accuracy, 1, "work only: 60 actual / 60 estimated");
  assert.deepEqual(filtered, calculateCapacity([work], new Set(), 0));

  // The briefing digest's capacity numbers are identical whether or not the
  // personal tasks (with big session-rolled actuals) are in the database.
  const withActuals = (tasks) => tasks.map((task) => (task.id.startsWith("p-") ? { ...task, actual_minutes: 374 } : task));
  // An open personal task due today (capacity reads "today" from the clock) with a big estimate:
  // if it leaked, required minutes and the RAG would change.
  const personalDueToday = makeTask("p-due-today-proj", {
    status: "In Progress", estimated_minutes: 480, actual_minutes: 374, due_at: new Date().toISOString(),
    project_id: PERSONAL_PROJECT.id, project: PERSONAL_PROJECT, implementation_id: null, implementation: null,
  });
  const digestWith = await buildDailyBriefDigest({
    supabase: makeSupabase(allTables({ tasks: withActuals([...taskSet(), work, personal, personalDueToday]) })), userId: "user-1", mode: "morning", date: DAY,
  });
  const digestWithout = await buildDailyBriefDigest({
    supabase: makeSupabase(allTables({ tasks: [...taskSet(), work].filter((task) => !task.id.startsWith("p-")) })), userId: "user-1", mode: "morning", date: DAY,
  });
  const capacityOf = (digest) => ({
    rag: digest.signals.capacity_rag, available: digest.signals.available_minutes, required: digest.signals.required_minutes,
  });
  assert.deepEqual(capacityOf(digestWith), capacityOf(digestWithout));
});

await test("excludePersonalCommitments and excludePersonalProjectUpdates (object and array relations)", () => {
  const rows = [
    { id: "a", task: null },
    { id: "b", task: { tags: ["personal"] } },
    { id: "c", task: { tags: [], project: { tags: ["personal"] } } },
    { id: "d", task: [{ tags: [], project: [{ tags: ["personal"] }] }] },
    { id: "e", task: { tags: ["work"], project: { tags: [] } } },
  ];
  assert.deepEqual(excludePersonalCommitments(rows).map((r) => r.id), ["a", "e"]);
  const updates = [{ id: "x", project: { tags: ["personal"] } }, { id: "y", project: [{ tags: [] }] }, { id: "z", project: null }];
  assert.deepEqual(excludePersonalProjectUpdates(updates).map((r) => r.id), ["y", "z"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
