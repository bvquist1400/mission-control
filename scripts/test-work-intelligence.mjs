#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const updateFixtures = process.argv.includes("--update-fixtures");
const fixturesDir = path.join(cwd, "src/lib/work-intelligence/__fixtures__");
const nowIso = "2026-03-24T17:30:00.000Z";
const currentSprint = {
  id: "sprint-12",
  name: "Sprint 12",
  theme: "Cutover prep",
  start_date: "2026-03-23",
  end_date: "2026-03-27",
};

const metadataModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/metadata.ts")).href);
const snapshotModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/snapshot.ts")).href);
const priorityModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/priority-stack.ts")).href);
const executionModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/execution-state.ts")).href);
const statusUpdateRecommendationsModule = await import(
  pathToFileURL(path.join(cwd, "src/lib/work-intelligence/status-update-recommendations.ts")).href
);
const reviewSnapshotsModule = await import(pathToFileURL(path.join(cwd, "src/lib/briefing/review-snapshots.ts")).href);
const eodReviewModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/eod-review.ts")).href);
const weeklyReviewModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/weekly-review.ts")).href);
const monthlyReviewModule = await import(pathToFileURL(path.join(cwd, "src/lib/work-intelligence/monthly-review.ts")).href);

const { buildCanonicalMetadata } = metadataModule;
const { buildWorkIntelligenceSnapshot } = snapshotModule;
const { workPriorityStackRead } = priorityModule;
const { workExecutionStateRead } = executionModule;
const { buildStatusUpdateRecommendations } = statusUpdateRecommendationsModule;
const { buildReviewSnapshotSummary, buildReviewSnapshotTitle } = reviewSnapshotsModule;
const { buildWorkEodReview } = eodReviewModule;
const { buildWorkWeeklyReview, buildProjectRollups } = weeklyReviewModule;
const { buildWorkMonthlyReview, buildMonthlyProjectRollups } = monthlyReviewModule;

function buildWindow(overrides = {}) {
  return {
    requestedDate: "2026-03-24",
    since: "2026-03-24T13:00:00.000Z",
    dayStartIso: "2026-03-24T04:00:00.000Z",
    dayEndExclusiveIso: "2026-03-25T04:00:00.000Z",
    timezone: "America/New_York",
    ...overrides,
  };
}

function makeTask(id, overrides = {}) {
  const base = {
    id,
    user_id: "user-1",
    title: id,
    description: null,
    implementation_id: "impl-1",
    project_id: "proj-1",
    sprint_id: currentSprint.id,
    status: "Planned",
    task_type: "Task",
    priority_score: 60,
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
    created_at: "2026-03-20T14:00:00.000Z",
    updated_at: "2026-03-24T14:00:00.000Z",
    implementation: {
      id: "impl-1",
      name: "Alpha Platform",
      phase: "Build",
      rag: "Yellow",
    },
    project: {
      id: "proj-1",
      name: "Quarterly Launch",
      stage: "In Progress",
      rag: "Yellow",
    },
    sprint: currentSprint,
  };

  return {
    ...base,
    ...overrides,
    implementation: overrides.implementation ?? base.implementation,
    project: overrides.project ?? base.project,
    sprint: overrides.sprint ?? base.sprint,
  };
}

function makeComment(taskId, content, createdAt) {
  return {
    id: `comment-${taskId}-${createdAt}`,
    task_id: taskId,
    content,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeEvent(title, startAt, endAt, overrides = {}) {
  return {
    title,
    start_at: startAt,
    end_at: endAt,
    is_all_day: false,
    temporal_status: "upcoming",
    ...overrides,
  };
}

function buildSnapshot({ tasks, events = [], comments = [], sprint = currentSprint, window = buildWindow(), now = nowIso }) {
  return buildWorkIntelligenceSnapshot({
    now: new Date(now),
    window,
    tasks,
    events,
    taskComments: comments,
    currentSprint: sprint,
  });
}

function makeCommitment(id, overrides = {}) {
  return {
    id,
    title: id,
    direction: "theirs",
    status: "Open",
    due_at: null,
    created_at: "2026-03-18T13:00:00.000Z",
    stakeholder: { id: "stake-1", name: "Casey" },
    task: null,
    ...overrides,
  };
}

function makeCommitmentRow(id, overrides = {}) {
  const base = makeCommitment(id, overrides);
  return {
    ...base,
    notes: null,
    updated_at: overrides.updated_at ?? base.created_at,
  };
}

function makeProjectUpdate(id, overrides = {}) {
  const base = {
    id,
    project_id: "proj-1",
    captured_for_date: "2026-03-24",
    summary: "Tightened the launch path and exposed one unresolved blocker.",
    rag: "Yellow",
    changes_today: ["Tightened launch scope"],
    blockers: ["Waiting on vendor signoff"],
    next_step: "Get vendor signoff and lock the cutover note.",
    needs_decision: null,
    project: {
      id: "proj-1",
      name: "Quarterly Launch",
      stage: "In Progress",
      rag: "Yellow",
    },
    implementation: {
      id: "impl-1",
      name: "Alpha Platform",
      phase: "Build",
      rag: "Yellow",
      portfolio_rank: 1,
    },
  };

  return {
    ...base,
    ...overrides,
    project: overrides.project ?? base.project,
    implementation: overrides.implementation ?? base.implementation,
  };
}

function makeWeeklySnapshot(review, payloadOverrides = {}) {
  return {
    snapshotId: `weekly-${review.period.startDate}`,
    periodStart: review.period.startDate,
    periodEnd: review.period.endDate,
    generatedAt: review.generatedAt,
    review,
    legacyPayload: null,
    rawSnapshot: {
      id: `weekly-${review.period.startDate}`,
      review_type: "weekly",
      period_start: review.period.startDate,
      period_end: review.period.endDate,
      title: `Weekly Review: ${review.period.startDate} to ${review.period.endDate}`,
      summary: "Stored weekly review",
      source: "system",
      payload: {
        week: {
          start_date: review.period.startDate,
          end_date: review.period.endDate,
        },
        shipped: [],
        stalled: [],
        cold_commitments: [],
        pending_decisions: [],
        project_rollups: review.projectRollups,
        projects_needing_attention: [],
        project_decisions: [],
        health_scores: [],
        next_week_suggestions: review.nextWeekCalls,
        review,
        ...payloadOverrides,
      },
    },
  };
}

function writeOrAssertFixture(filename, value) {
  const targetPath = path.join(fixturesDir, filename);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  if (updateFixtures) {
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.writeFileSync(targetPath, serialized);
    return;
  }

  const expected = fs.readFileSync(targetPath, "utf8");
  assert.equal(serialized, expected, `${filename} fixture changed`);
}

const metadataHigh = buildCanonicalMetadata({
  generatedAt: nowIso,
  freshnessSources: [
    {
      source: "tasks",
      latestAt: "2026-03-24T16:30:00.000Z",
      staleAfterHours: 72,
      required: true,
    },
    {
      source: "calendar",
      latestAt: null,
      staleAfterHours: 24,
      allowMissing: true,
    },
  ],
  caveats: [null, undefined],
  includeRawSignals: true,
  rawSignals: { checked: true },
});

assert.equal(metadataHigh.confidence, "high");
assert.equal(metadataHigh.freshness.overall, "fresh");
assert.deepEqual(metadataHigh.rawSignals, { checked: true });

const metadataLow = buildCanonicalMetadata({
  generatedAt: nowIso,
  freshnessSources: [
    {
      source: "tasks",
      latestAt: "2026-03-18T12:00:00.000Z",
      staleAfterHours: 72,
      required: true,
    },
  ],
  includeRawSignals: false,
  rawSignals: { checked: false },
});

assert.equal(metadataLow.confidence, "low");
assert.equal(metadataLow.freshness.overall, "stale");
assert.equal("rawSignals" in metadataLow, false);

const metadataMixed = buildCanonicalMetadata({
  generatedAt: nowIso,
  freshnessSources: [
    {
      source: "tasks",
      latestAt: "2026-03-24T16:00:00.000Z",
      staleAfterHours: 72,
      required: true,
    },
    {
      source: "calendar",
      latestAt: "2026-03-22T12:00:00.000Z",
      staleAfterHours: 24,
      allowMissing: true,
    },
  ],
  caveats: ["Signals are mixed."],
});

assert.equal(metadataMixed.confidence, "medium");
assert.equal(metadataMixed.freshness.overall, "mixed");

const prioritySnapshot = buildSnapshot({
  tasks: [
    makeTask("task-due", {
      title: "Send launch checklist",
      priority_score: 82,
      estimated_minutes: 90,
      due_at: "2026-03-24T20:00:00.000Z",
      updated_at: "2026-03-24T15:00:00.000Z",
    }),
    makeTask("task-followup", {
      title: "Vendor approval follow-up",
      status: "Blocked/Waiting",
      priority_score: 76,
      estimated_minutes: 30,
      waiting_on: "Vendor approval",
      follow_up_at: "2026-03-24T15:30:00.000Z",
      updated_at: "2026-03-21T16:00:00.000Z",
    }),
    makeTask("task-active", {
      title: "Finalize migration notes",
      status: "In Progress",
      priority_score: 74,
      estimated_minutes: 120,
      updated_at: "2026-03-24T14:15:00.000Z",
    }),
    makeTask("task-defer", {
      title: "Legal dependency review",
      status: "Blocked/Waiting",
      priority_score: 78,
      waiting_on: "Legal review",
      follow_up_at: "2026-03-26T15:00:00.000Z",
      updated_at: "2026-03-24T12:00:00.000Z",
    }),
    makeTask("task-backlog", {
      title: "Polish dashboard copy",
      priority_score: 60,
      estimated_minutes: 60,
      updated_at: "2026-03-24T11:00:00.000Z",
    }),
  ],
  comments: [
    makeComment("task-active", "Documented the latest migration edge cases.", "2026-03-24T14:40:00.000Z"),
  ],
  events: [
    makeEvent("Staff sync", "2026-03-24T17:45:00.000Z", "2026-03-24T18:45:00.000Z"),
    makeEvent("Vendor review", "2026-03-24T19:00:00.000Z", "2026-03-24T20:00:00.000Z"),
    makeEvent("Cutover prep", "2026-03-24T20:15:00.000Z", "2026-03-24T21:15:00.000Z"),
  ],
});

const priorityRead = workPriorityStackRead(prioritySnapshot, {
  limit: 3,
  includeRawSignals: true,
});

assert.equal(priorityRead.topItems[0].taskId, "task-due");
assert.equal(priorityRead.rawSignals.noSingleDominantPriority, false);
assert.equal(priorityRead.deferForNow.some((item) => item.taskId === "task-defer"), true);
writeOrAssertFixture("priority-stack.sample.json", priorityRead);

const ambiguousPrioritySnapshot = buildSnapshot({
  tasks: [
    makeTask("ambiguous-protect", {
      title: "Finalize launch notes",
      priority_score: 80,
      estimated_minutes: 60,
      due_at: "2026-03-25T20:00:00.000Z",
      updated_at: "2026-03-24T15:00:00.000Z",
    }),
    makeTask("ambiguous-finish", {
      title: "Close migration checklist",
      status: "In Progress",
      priority_score: 78,
      estimated_minutes: 60,
      updated_at: "2026-03-24T15:15:00.000Z",
    }),
    makeTask("ambiguous-third", {
      title: "Draft stakeholder FAQ",
      priority_score: 62,
      estimated_minutes: 45,
      updated_at: "2026-03-24T12:00:00.000Z",
    }),
  ],
});

const ambiguousPriorityRead = workPriorityStackRead(ambiguousPrioritySnapshot, {
  limit: 3,
  includeRawSignals: true,
});

assert.equal(ambiguousPriorityRead.rawSignals.noSingleDominantPriority, true);
assert.equal(ambiguousPriorityRead.primaryTradeoff?.startsWith("No single dominant priority."), true);
writeOrAssertFixture("priority-stack.ambiguous.sample.json", ambiguousPriorityRead);

const overloadedSnapshot = buildSnapshot({
  tasks: [
    makeTask("overdue-contract", {
      title: "Send client contract redlines",
      priority_score: 88,
      estimated_minutes: 90,
      due_at: "2026-03-24T15:00:00.000Z",
      updated_at: "2026-03-24T14:45:00.000Z",
    }),
    makeTask("overdue-cutover", {
      title: "Finalize cutover checklist",
      status: "In Progress",
      priority_score: 81,
      estimated_minutes: 120,
      due_at: "2026-03-24T16:30:00.000Z",
      updated_at: "2026-03-24T15:30:00.000Z",
    }),
    makeTask("active-qa", {
      title: "Close QA regression set",
      status: "In Progress",
      priority_score: 76,
      estimated_minutes: 120,
      updated_at: "2026-03-24T14:10:00.000Z",
    }),
    makeTask("blocked-security", {
      title: "Security review handoff",
      status: "Blocked/Waiting",
      priority_score: 74,
      waiting_on: "Security review",
      follow_up_at: "2026-03-25T15:00:00.000Z",
      updated_at: "2026-03-24T13:30:00.000Z",
    }),
    makeTask("backlog-copy", {
      title: "Clean up announcement copy",
      priority_score: 62,
      estimated_minutes: 45,
      updated_at: "2026-03-24T11:30:00.000Z",
    }),
    makeTask("done-note", {
      title: "Publish migration status note",
      status: "Done",
      priority_score: 55,
      estimated_minutes: 30,
      updated_at: "2026-03-24T13:10:00.000Z",
    }),
  ],
  comments: [
    makeComment("active-qa", "Closed the first batch of failing tests.", "2026-03-24T14:20:00.000Z"),
  ],
  events: [
    makeEvent("Ops sync", "2026-03-24T17:45:00.000Z", "2026-03-24T18:45:00.000Z"),
    makeEvent("Launch readiness review", "2026-03-24T19:00:00.000Z", "2026-03-24T20:00:00.000Z"),
    makeEvent("Leadership update", "2026-03-24T20:15:00.000Z", "2026-03-24T21:15:00.000Z"),
  ],
});

const overloadedRead = workExecutionStateRead(overloadedSnapshot, {
  includeRawSignals: true,
});

assert.equal(overloadedRead.loadAssessment.isOverloaded, true);
assert.equal(overloadedRead.topRisk?.label, "Overdue delivery pressure");
writeOrAssertFixture("execution-state.overloaded.sample.json", overloadedRead);

const staleSnapshot = buildSnapshot({
  tasks: [
    makeTask("stale-followup", {
      title: "Vendor reply on timeline risk",
      status: "Blocked/Waiting",
      priority_score: 77,
      waiting_on: "Vendor reply",
      follow_up_at: "2026-03-23T15:00:00.000Z",
      updated_at: "2026-03-20T16:00:00.000Z",
    }),
    makeTask("quiet-active", {
      title: "Refine launch runbook",
      status: "In Progress",
      priority_score: 70,
      updated_at: "2026-03-18T15:30:00.000Z",
    }),
    makeTask("next-step", {
      title: "Prep launch office-hours notes",
      priority_score: 68,
      due_at: "2026-03-26T15:00:00.000Z",
      updated_at: "2026-03-24T12:20:00.000Z",
    }),
  ],
});

const staleRead = workExecutionStateRead(staleSnapshot, {
  includeRawSignals: true,
});

assert.deepEqual(
  staleSnapshot.followUpRiskTasks.map((task) => task.id),
  ["stale-followup"]
);
assert.deepEqual(
  staleSnapshot.statusUncertainTasks.map((task) => task.id),
  ["stale-followup", "quiet-active"]
);
assert.deepEqual(
  staleSnapshot.quietInProgressTasks.map((task) => task.id),
  ["quiet-active"]
);
assert.equal(staleRead.topRisk?.label, "Stale follow-up risk");
assert.equal(staleRead.confidence, "medium");
assert.deepEqual(staleRead.rawSignals.followUpRiskTaskIds, ["stale-followup"]);
assert.deepEqual(staleRead.rawSignals.quietInProgressTaskIds, ["quiet-active"]);
writeOrAssertFixture("execution-state.stale.sample.json", staleRead);

const mixedSignalSnapshot = buildSnapshot({
  tasks: [
    makeTask("stale-a", {
      title: "Reconcile launch metrics",
      status: "In Progress",
      priority_score: 73,
      updated_at: "2026-03-15T14:00:00.000Z",
    }),
    makeTask("stale-b", {
      title: "Draft stakeholder note",
      priority_score: 69,
      due_at: "2026-03-25T18:00:00.000Z",
      updated_at: "2026-03-16T14:00:00.000Z",
    }),
    makeTask("stale-c", {
      title: "Waiting on design signoff",
      status: "Blocked/Waiting",
      priority_score: 71,
      waiting_on: "Design signoff",
      updated_at: "2026-03-14T14:00:00.000Z",
    }),
  ],
  sprint: null,
});

const mixedSignalRead = workExecutionStateRead(mixedSignalSnapshot, {
  includeRawSignals: true,
});

assert.equal(mixedSignalSnapshot.coreCounts.followUpRisks, 1);
assert.equal(mixedSignalSnapshot.coreCounts.statusUncertain, 3);
assert.equal(mixedSignalSnapshot.coreCounts.quietInProgress, 1);
assert.equal(mixedSignalRead.confidence, "low");
assert.equal(mixedSignalRead.whatLooksStale.length >= 3, true);
assert.deepEqual(mixedSignalRead.rawSignals.statusUncertainTaskIds, ["stale-a", "stale-c", "stale-b"]);
writeOrAssertFixture("execution-state.mixed-confidence.sample.json", mixedSignalRead);

const statusUpdateSnapshot = buildSnapshot({
  now: "2026-03-24T22:30:00.000Z",
  window: buildWindow({
    since: "2026-03-24T04:00:00.000Z",
    dayStartIso: "2026-03-24T04:00:00.000Z",
    dayEndExclusiveIso: "2026-03-25T04:00:00.000Z",
  }),
  tasks: [
    makeTask("project-done", {
      title: "Close launch checklist",
      status: "Done",
      updated_at: "2026-03-24T19:00:00.000Z",
    }),
    makeTask("implementation-thread", {
      title: "Tighten implementation note",
      status: "In Progress",
      project_id: null,
      project: null,
      updated_at: "2026-03-24T17:00:00.000Z",
    }),
  ],
  comments: [
    makeComment("implementation-thread", "Captured the implementation-specific change list.", "2026-03-24T17:20:00.000Z"),
  ],
});

const statusUpdateRecommendations = buildStatusUpdateRecommendations({
  requestedDate: "2026-03-24",
  snapshot: statusUpdateSnapshot,
  projects: [
    {
      id: "proj-1",
      name: "Quarterly Launch",
      status_summary: "Last written status from last week.",
      updated_at: "2026-03-20T12:00:00.000Z",
    },
  ],
  implementations: [
    {
      id: "impl-1",
      name: "Alpha Platform",
      status_summary: "Implementation note from yesterday.",
      updated_at: "2026-03-23T12:00:00.000Z",
    },
  ],
  projectStatusUpdates: [],
  implementationStatusUpdates: [
    {
      id: "impl-update-old",
      implementation_id: "impl-1",
      created_at: "2026-03-23T12:00:00.000Z",
      related_task_ids: ["older-thread"],
    },
  ],
  limit: 4,
});

assert.equal(statusUpdateRecommendations.recommendations.length, 2);
assert.equal(statusUpdateRecommendations.recommendations[0]?.entityType, "project");
assert.equal(statusUpdateRecommendations.recommendations.some((item) => item.entityType === "implementation"), true);
assert.equal(
  statusUpdateRecommendations.recommendations.some((item) => item.reasonCode === "completed_thread_reporting_hygiene"),
  true
);
writeOrAssertFixture("status-update-recommendations.sample.json", statusUpdateRecommendations);

const eodSnapshot = buildSnapshot({
  now: "2026-03-24T22:30:00.000Z",
  window: buildWindow({
    since: "2026-03-24T04:00:00.000Z",
    dayStartIso: "2026-03-24T04:00:00.000Z",
    dayEndExclusiveIso: "2026-03-25T04:00:00.000Z",
  }),
  tasks: [
    makeTask("done-launch", {
      title: "Ship launch checklist",
      status: "Done",
      priority_score: 82,
      updated_at: "2026-03-24T20:15:00.000Z",
    }),
    makeTask("done-note", {
      title: "Publish rollout note",
      status: "Done",
      priority_score: 70,
      updated_at: "2026-03-24T18:30:00.000Z",
    }),
    makeTask("roll-cutover", {
      title: "Finish cutover runbook",
      status: "In Progress",
      priority_score: 78,
      due_at: "2026-03-24T21:00:00.000Z",
      updated_at: "2026-03-24T17:10:00.000Z",
    }),
    makeTask("block-vendor", {
      title: "Vendor signoff follow-up",
      status: "Blocked/Waiting",
      priority_score: 76,
      waiting_on: "Vendor signoff",
      follow_up_at: "2026-03-24T16:00:00.000Z",
      updated_at: "2026-03-21T16:00:00.000Z",
    }),
    makeTask("prep-demo", {
      title: "Prep customer demo deck",
      priority_score: 68,
      due_at: "2026-03-25T15:00:00.000Z",
      updated_at: "2026-03-24T15:20:00.000Z",
    }),
  ],
  comments: [
    makeComment("roll-cutover", "Closed half the cutover runbook.", "2026-03-24T17:30:00.000Z"),
  ],
});

const eodReview = buildWorkEodReview({
  requestedDate: "2026-03-24",
  timezone: "America/New_York",
  snapshot: eodSnapshot,
  openCommitments: [
    makeCommitment("commitment-cold", {
      title: "Get pricing answer back to Casey",
      created_at: "2026-03-17T13:00:00.000Z",
      task: { id: "roll-cutover", title: "Finish cutover runbook", status: "In Progress" },
    }),
  ],
  openCommitmentRows: [
    makeCommitmentRow("commitment-cold", {
      title: "Get pricing answer back to Casey",
      created_at: "2026-03-17T13:00:00.000Z",
      updated_at: "2026-03-18T14:00:00.000Z",
      task: { id: "roll-cutover", title: "Finish cutover runbook", status: "In Progress" },
    }),
  ],
  tomorrowEventLatestAt: "2026-03-25T18:00:00.000Z",
  prepCandidates: [
    {
      taskId: "prep-demo",
      title: "Prep customer demo deck",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Tomorrow starts with customer-facing time, so the deck should be ready before the first open block.",
      updatedAt: "2026-03-24T15:20:00.000Z",
      dueAt: "2026-03-25T15:00:00.000Z",
    },
  ],
  statusUpdateRecommendations: buildStatusUpdateRecommendations({
    requestedDate: "2026-03-24",
    snapshot: eodSnapshot,
    projects: [
      {
        id: "proj-1",
        name: "Quarterly Launch",
        status_summary: "Scope note from the previous day.",
        updated_at: "2026-03-23T12:00:00.000Z",
      },
    ],
    implementations: [
      {
        id: "impl-1",
        name: "Alpha Platform",
        status_summary: "Implementation note from the previous day.",
        updated_at: "2026-03-23T12:00:00.000Z",
      },
    ],
    projectStatusUpdates: [],
    implementationStatusUpdates: [],
    limit: 4,
  }).recommendations,
  statusArtifactsLatestAt: "2026-03-23T12:00:00.000Z",
  includeRawSignals: true,
  includeNarrativeHints: true,
});

assert.equal(eodReview.reviewType, "eod");
assert.equal(eodReview.completedToday.length, 2);
assert.equal(eodReview.rolledForward[0]?.taskId, "roll-cutover");
assert.equal(eodReview.coldFollowups.some((item) => item.kind === "commitment"), true);
assert.equal(eodReview.statusUpdateRecommendations.length > 0, true);
assert.equal(eodReview.narrativeHints.some((hint) => /executive|retrospective|alignment/i.test(hint)), false);
assert.equal(buildReviewSnapshotTitle("eod", "2026-03-24", "2026-03-24"), "EOD Review: 2026-03-24");
assert.equal(buildReviewSnapshotSummary("eod", { review: eodReview }).includes("completed"), true);
writeOrAssertFixture("eod-review.sample.json", eodReview);

function cloneReview(baseReview, overrides = {}) {
  return {
    ...baseReview,
    ...overrides,
    dayOutcome: overrides.dayOutcome ?? baseReview.dayOutcome,
    completedToday: overrides.completedToday ?? baseReview.completedToday,
    rolledForward: overrides.rolledForward ?? baseReview.rolledForward,
    openBlockers: overrides.openBlockers ?? baseReview.openBlockers,
    coldFollowups: overrides.coldFollowups ?? baseReview.coldFollowups,
    tomorrowFirstThings: overrides.tomorrowFirstThings ?? baseReview.tomorrowFirstThings,
    statusUpdateRecommendations: overrides.statusUpdateRecommendations ?? baseReview.statusUpdateRecommendations,
    operatingRisks: overrides.operatingRisks ?? baseReview.operatingRisks,
    narrativeHints: overrides.narrativeHints ?? baseReview.narrativeHints,
    freshness: overrides.freshness ?? baseReview.freshness,
    caveats: overrides.caveats ?? baseReview.caveats,
    supportingSignals: overrides.supportingSignals ?? baseReview.supportingSignals,
    rawSignals: overrides.rawSignals ?? baseReview.rawSignals,
  };
}

const secondEodReview = cloneReview(eodReview, {
  requestedDate: "2026-03-25",
  generatedAt: "2026-03-25T22:40:00.000Z",
  completedToday: [
    {
      taskId: "roll-cutover",
      title: "Finish cutover runbook",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Closed today.",
      updatedAt: "2026-03-25T19:20:00.000Z",
      dueAt: "2026-03-24T21:00:00.000Z",
    },
  ],
  rolledForward: [
    {
      taskId: "slip-qa",
      title: "Close QA regression set",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still waiting on Vendor signoff before QA can close.",
      updatedAt: "2026-03-25T18:10:00.000Z",
      dueAt: "2026-03-25T20:00:00.000Z",
    },
  ],
  openBlockers: [
    {
      taskId: "block-vendor",
      title: "Vendor signoff follow-up",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still waiting on Vendor signoff.",
      updatedAt: "2026-03-25T17:00:00.000Z",
      dueAt: null,
    },
  ],
  coldFollowups: [
    {
      id: "block-vendor",
      kind: "task",
      title: "Vendor signoff follow-up",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      owner: "Vendor signoff",
      reason: "Follow-up date has already passed.",
      updatedAt: "2026-03-25T17:00:00.000Z",
      dueAt: null,
    },
  ],
  operatingRisks: [
    {
      label: "Cold follow-up risk",
      severity: "high",
      summary: "Vendor signoff is still the same wait-state fire.",
      relatedTaskIds: ["block-vendor"],
    },
  ],
  tomorrowFirstThings: [
    {
      taskId: "slip-qa",
      title: "Close QA regression set",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still the strongest reopening move if tomorrow starts cold.",
      updatedAt: "2026-03-25T18:10:00.000Z",
      dueAt: "2026-03-25T20:00:00.000Z",
    },
  ],
  narrativeHints: [
    "The day moved, but the vendor wait state is still dragging across the close.",
    "Close QA regression set is still rolling, so tomorrow cannot open wide.",
  ],
});

const thirdEodReview = cloneReview(eodReview, {
  requestedDate: "2026-03-26",
  generatedAt: "2026-03-26T22:55:00.000Z",
  completedToday: [
    {
      taskId: "done-deck",
      title: "Finalize customer demo deck",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Closed today.",
      updatedAt: "2026-03-26T18:30:00.000Z",
      dueAt: null,
    },
  ],
  rolledForward: [
    {
      taskId: "slip-qa",
      title: "Close QA regression set",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still waiting on Vendor signoff before QA can close.",
      updatedAt: "2026-03-26T18:45:00.000Z",
      dueAt: "2026-03-26T20:00:00.000Z",
    },
  ],
  openBlockers: [
    {
      taskId: "block-vendor",
      title: "Vendor signoff follow-up",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still waiting on Vendor signoff.",
      updatedAt: "2026-03-26T17:20:00.000Z",
      dueAt: null,
    },
  ],
  coldFollowups: [
    {
      id: "block-vendor",
      kind: "task",
      title: "Vendor signoff follow-up",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      owner: "Vendor signoff",
      reason: "Waiting thread has aged enough that it now needs an explicit nudge.",
      updatedAt: "2026-03-26T17:20:00.000Z",
      dueAt: null,
    },
  ],
  operatingRisks: [
    {
      label: "Cold follow-up risk",
      severity: "high",
      summary: "Vendor signoff is still the same wait-state fire.",
      relatedTaskIds: ["block-vendor"],
    },
  ],
  tomorrowFirstThings: [
    {
      taskId: "slip-qa",
      title: "Close QA regression set",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      reason: "Still the strongest reopening move if tomorrow starts cold.",
      updatedAt: "2026-03-26T18:45:00.000Z",
      dueAt: "2026-03-26T20:00:00.000Z",
    },
  ],
  narrativeHints: [
    "The week is ending with the same QA rollover still alive.",
    "Vendor signoff is still the blocker that refuses to clear itself.",
  ],
});

const weeklyProjectRollups = buildProjectRollups([
  makeProjectUpdate("project-update-1", {
    captured_for_date: "2026-03-24",
    changes_today: ["Tightened launch scope"],
    blockers: ["Waiting on vendor signoff"],
    next_step: "Get vendor signoff and close QA.",
  }),
  makeProjectUpdate("project-update-2", {
    captured_for_date: "2026-03-25",
    changes_today: ["Closed cutover runbook"],
    blockers: ["Waiting on vendor signoff"],
    next_step: "Finish QA and prep release note.",
  }),
  makeProjectUpdate("project-update-3", {
    project_id: "proj-2",
    captured_for_date: "2026-03-26",
    summary: "Customer demo thread improved after deck cleanup.",
    rag: "Green",
    changes_today: ["Finished demo deck"],
    blockers: [],
    next_step: "Use demo momentum to lock next customer call.",
    needs_decision: "Decide whether to expand the pilot scope.",
    project: {
      id: "proj-2",
      name: "Customer Pilot",
      stage: "In Progress",
      rag: "Green",
    },
    implementation: {
      id: "impl-2",
      name: "Pilot Workstream",
      phase: "Build",
      rag: "Green",
      portfolio_rank: 2,
    },
  }),
]);

const weeklyReview = buildWorkWeeklyReview({
  startDate: "2026-03-23",
  anchorDate: "2026-03-27",
  timezone: "America/New_York",
  storedDailyReviews: [
    { snapshotId: "eod-2026-03-24", requestedDate: "2026-03-24", review: eodReview, generatedAt: eodReview.generatedAt },
    { snapshotId: "eod-2026-03-25", requestedDate: "2026-03-25", review: secondEodReview, generatedAt: secondEodReview.generatedAt },
    { snapshotId: "eod-2026-03-26", requestedDate: "2026-03-26", review: thirdEodReview, generatedAt: thirdEodReview.generatedAt },
  ],
  shipped: [
    makeTask("done-launch", {
      title: "Ship launch checklist",
      status: "Done",
      updated_at: "2026-03-24T20:15:00.000Z",
    }),
    makeTask("done-deck", {
      title: "Finalize customer demo deck",
      status: "Done",
      implementation: {
        id: "impl-2",
        name: "Pilot Workstream",
        phase: "Build",
        rag: "Green",
      },
      project: {
        id: "proj-2",
        name: "Customer Pilot",
        stage: "In Progress",
        rag: "Green",
      },
      updated_at: "2026-03-26T18:30:00.000Z",
    }),
  ],
  stalled: [
    makeTask("slip-qa", {
      title: "Close QA regression set",
      status: "In Progress",
      updated_at: "2026-03-20T15:00:00.000Z",
    }),
  ],
  pendingDecisions: [
    makeTask("decision-pilot", {
      title: "Decide pilot scope",
      needs_review: true,
      status: "Planned",
      implementation: {
        id: "impl-2",
        name: "Pilot Workstream",
        phase: "Build",
        rag: "Green",
      },
      project: {
        id: "proj-2",
        name: "Customer Pilot",
        stage: "In Progress",
        rag: "Green",
      },
      updated_at: "2026-03-26T16:30:00.000Z",
    }),
  ],
  coldCommitments: [
    makeCommitment("commitment-cold", {
      title: "Get pricing answer back to Casey",
      created_at: "2026-03-17T13:00:00.000Z",
    }),
  ],
  projectRollups: weeklyProjectRollups,
  projectsNeedingAttention: weeklyProjectRollups.filter((project) => project.notable_blockers.length > 0 || Boolean(project.latest_needs_decision)),
  projectDecisions: weeklyProjectRollups.filter((project) => Boolean(project.latest_needs_decision)),
  healthScores: [],
  tasksLatestAt: "2026-03-26T18:45:00.000Z",
  commitmentsLatestAt: "2026-03-18T14:00:00.000Z",
  projectUpdatesLatestAt: "2026-03-26T23:59:59.999Z",
  includeRawSignals: true,
  includeNarrativeHints: true,
});

assert.equal(weeklyReview.reviewType, "weekly");
assert.equal(weeklyReview.dailyReviewCount, 3);
assert.equal(weeklyReview.whatKeptSlipping[0]?.title, "Close QA regression set");
assert.equal(weeklyReview.whatKeptSlipping[0]?.primaryReason, "Still waiting on Vendor signoff before QA can close.");
assert.equal(weeklyReview.whatKeptSlipping[0]?.summary.includes("Vendor signoff"), true);
assert.equal(weeklyReview.recurringRisks.some((risk) => risk.label === "Cold follow-up risk" || risk.label === "Vendor signoff follow-up"), true);
assert.equal(weeklyReview.confidence, "medium");
assert.equal(weeklyReview.rawSignals.missingDailyReviewDates.length, 2);
assert.equal(weeklyReview.nextWeekCalls.some((call) => /^Stop reloading /.test(call)), true);
assert.equal(weeklyReview.nextWeekCalls.some((call) => /Vendor signoff/.test(call)), true);
assert.equal(weeklyReview.narrativeHints.some((hint) => /executive|retrospective|alignment/i.test(hint)), false);
writeOrAssertFixture("weekly-review.chain.sample.json", weeklyReview);

const fallbackWeeklyReview = buildWorkWeeklyReview({
  startDate: "2026-03-23",
  anchorDate: "2026-03-27",
  timezone: "America/New_York",
  storedDailyReviews: [],
  shipped: [
    makeTask("fallback-done", {
      title: "Ship fallback work",
      status: "Done",
      updated_at: "2026-03-24T18:00:00.000Z",
    }),
  ],
  stalled: [
    makeTask("fallback-stalled", {
      title: "Stalled migration thread",
      status: "In Progress",
      updated_at: "2026-03-18T18:00:00.000Z",
    }),
  ],
  pendingDecisions: [],
  coldCommitments: [],
  projectRollups: weeklyProjectRollups,
  projectsNeedingAttention: weeklyProjectRollups.slice(0, 1),
  projectDecisions: [],
  healthScores: [],
  tasksLatestAt: "2026-03-24T18:00:00.000Z",
  commitmentsLatestAt: null,
  projectUpdatesLatestAt: "2026-03-26T23:59:59.999Z",
});

assert.equal(fallbackWeeklyReview.dailyReviewCount, 0);
assert.equal(fallbackWeeklyReview.whatMoved.length > 0, true);
assert.equal(fallbackWeeklyReview.confidence, "low");
assert.equal(fallbackWeeklyReview.caveats.some((caveat) => /raw operational signals/i.test(caveat)), true);

const secondWeeklyReview = {
  ...weeklyReview,
  period: {
    startDate: "2026-03-30",
    endDate: "2026-04-03",
    anchorDate: "2026-04-03",
    timezone: "America/New_York",
  },
  generatedAt: "2026-04-03T23:00:00.000Z",
  weekPattern: {
    label: "drag_outpaced_closure",
    summary: "The second week of the month slipped harder than it moved.",
  },
  whatMoved: [
    {
      key: "task:pilot-followup",
      title: "Lock customer follow-up",
      context: "Pilot Workstream / Customer Pilot",
      summary: "Customer follow-up finally moved cleanly.",
      occurrences: 1,
      daysSeen: ["2026-04-02"],
      relatedTaskIds: ["pilot-followup"],
    },
  ],
  whatKeptSlipping: [
    {
      key: "task:slip-qa",
      title: "Close QA regression set",
      context: "Alpha Platform / Quarterly Launch / Sprint 12",
      summary: "Still survived another weekly cut.",
      occurrences: 2,
      daysSeen: ["2026-03-31", "2026-04-02"],
      relatedTaskIds: ["slip-qa"],
    },
  ],
  recurringRisks: [
    {
      key: "risk:cold follow-up risk",
      label: "Cold follow-up risk",
      summary: "Vendor signoff kept reappearing at the weekly layer too.",
      occurrences: 2,
      daysSeen: ["2026-04-03"],
      relatedTaskIds: ["block-vendor"],
    },
  ],
  nextWeekCalls: [
    "Do not let QA become the default soundtrack next week.",
    "Resolve the vendor signoff wait state before opening more scope.",
  ],
  narrativeHints: [
    "The second week slipped harder than it moved.",
    "QA and vendor signoff both kept surviving the weekly cut.",
  ],
};

const monthlyProjectRollups = buildMonthlyProjectRollups([
  makeProjectUpdate("month-update-1", {
    captured_for_date: "2026-03-04",
    rag: "Green",
    blockers: [],
    changes_today: ["Shipped onboarding improvements"],
    next_step: "Protect the cleaner launch path.",
    needs_decision: null,
  }),
  makeProjectUpdate("month-update-2", {
    captured_for_date: "2026-03-11",
    rag: "Yellow",
    blockers: ["Vendor signoff still open"],
    changes_today: ["QA slipped into next week"],
    next_step: "Reset QA scope and force a vendor answer.",
    needs_decision: "Decide whether to cut the last QA edge cases from the release.",
  }),
  makeProjectUpdate("month-update-3", {
    project_id: "proj-2",
    captured_for_date: "2026-03-18",
    summary: "Pilot work improved after the demo deck cleanup.",
    rag: "Green",
    blockers: [],
    changes_today: ["Closed demo prep", "Scheduled customer follow-up"],
    next_step: "Use the pilot momentum to widen the customer thread.",
    needs_decision: null,
    project: {
      id: "proj-2",
      name: "Customer Pilot",
      stage: "In Progress",
      rag: "Green",
    },
  }),
]);

const monthlyReview = buildWorkMonthlyReview({
  monthStart: "2026-03-01",
  anchorDate: "2026-03-20",
  timezone: "America/New_York",
  weeklyReviews: [
    makeWeeklySnapshot(weeklyReview),
    makeWeeklySnapshot(secondWeeklyReview),
    makeWeeklySnapshot({
      ...weeklyReview,
      period: {
        startDate: "2026-03-16",
        endDate: "2026-03-20",
        anchorDate: "2026-03-20",
        timezone: "America/New_York",
      },
      generatedAt: "2026-03-20T23:00:00.000Z",
      weekPattern: {
        label: "traction_with_drag",
        summary: "The week moved, but QA and vendor drag stayed alive.",
      },
      recurringRisks: [
        {
          key: "risk:cold follow-up risk",
          label: "Cold follow-up risk",
          summary: "Vendor signoff kept reappearing.",
          occurrences: 2,
          daysSeen: ["2026-03-20"],
          relatedTaskIds: ["block-vendor"],
        },
      ],
      nextWeekCalls: [
        "Resolve vendor signoff before opening more scope.",
      ],
    }),
  ],
  projectRollups: monthlyProjectRollups,
  projectUpdatesLatestAt: "2026-03-18T23:59:59.999Z",
  includeRawSignals: true,
  includeNarrativeHints: true,
});

assert.equal(monthlyReview.reviewType, "monthly");
assert.equal(monthlyReview.weeklyReviewCount, 3);
assert.equal(monthlyReview.recurringPressurePoints.some((point) => point.label === "Cold follow-up risk"), true);
assert.equal(monthlyReview.directionChanges.length > 0, true);
assert.equal(monthlyReview.confidence, "medium");
assert.equal(monthlyReview.rawSignals.missingWeekStartDates.length >= 1, true);
assert.equal(monthlyReview.narrativeHints.some((hint) => /executive|retrospective|alignment/i.test(hint)), false);
assert.equal(buildReviewSnapshotSummary("monthly", { review: monthlyReview, project_rollups: monthlyProjectRollups, weekly_snapshots: [1, 2, 3] }).includes("weekly snapshots"), true);
writeOrAssertFixture("monthly-review.chain.sample.json", monthlyReview);

const fallbackMonthlyReview = buildWorkMonthlyReview({
  monthStart: "2026-03-01",
  anchorDate: "2026-03-20",
  timezone: "America/New_York",
  weeklyReviews: [],
  projectRollups: monthlyProjectRollups,
  projectUpdatesLatestAt: "2026-03-18T23:59:59.999Z",
});

assert.equal(fallbackMonthlyReview.weeklyReviewCount, 0);
assert.equal(fallbackMonthlyReview.confidence, "low");
assert.equal(fallbackMonthlyReview.recurringPressurePoints.length > 0, true);
assert.equal(fallbackMonthlyReview.caveats.some((caveat) => /project status history/i.test(caveat)), true);

console.log(updateFixtures ? "Work-intelligence fixtures updated." : "Work-intelligence tests passed.");
