// Tests for "Break into tasks" (Baseline task d1f7e622, mockup 3a320c1c), offline:
//
// - The rules (src/lib/break-into-tasks.ts): proposed dates (spread over the
//   days left, last = the task's due date, weekends skipped for work, every day
//   for personal, several steps per day when there are more steps than days,
//   next working days without a usable due date), "Starts as", the summary
//   line, request parsing (unknown fields, dates, owners, duplicates), the plan
//   sent to migration 066's function (finished steps Done with their tick time
//   and tick day, open steps' statuses, "waits on previous" only between open
//   steps, priority, destinations incl. the no-project path), the refusals.
// - The umbrella's progress (Brent 10/29: "Today counts the new tasks"): the
//   card view counts step tasks ("4/6 tasks", all done lights Done), the
//   Portfolio credit, the project section heading.
// - The Today query embeds the step tasks in the same request.
// - The routes with a fake client: one database call, refusals mapped, the
//   FamCal/actions keys not allowed, GET /api/tasks/{id} adds part_of/step_tasks.
//
//   npm run test:break-into-tasks

import assert from "node:assert/strict";

const bit = await import("../src/lib/break-into-tasks.ts");
const view = await import("../src/lib/task-range-view.ts");
const queries = await import("../src/lib/today/queries.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 8).join("\n    ")}`);
  }
}

/** An instant at an ET wall-clock time on a date (EDT until 11/1/2026, EST after). */
function etAt(date, time = "10:00") {
  const offset = date < "2026-11-01" ? "-04:00" : "-05:00";
  return new Date(`${date}T${time}:00${offset}`);
}
const endOfEt = (date) => {
  const offset = date < "2026-11-01" ? "-04:00" : "-05:00";
  return new Date(`${date}T23:59:59.999${offset}`).toISOString();
};

const work = (overrides = {}) => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Fix readiness script failures from Daniel's review and retest (Scripts 002 + 006)",
  status: "In Progress",
  owner: "brent",
  start_at: etAt("2026-10-21", "00:00").toISOString(),
  due_at: endOfEt("2026-10-30"),
  tags: ["work"],
  project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  base_priority: 60,
  project: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "EPIC Research Build", tags: [] },
  ...overrides,
});

let rowSeq = 0;
const row = (text, done = false, completedAt = null, extra = {}) => {
  rowSeq += 1;
  return {
    id: `cccccccc-cccc-4ccc-8ccc-${String(rowSeq).padStart(12, "0")}`,
    text,
    is_done: done,
    sort_order: rowSeq,
    completed_at: completedAt,
    unit_count: null,
    work_type: null,
    ...extra,
  };
};
// The mockup's six steps: four finished, two open.
const mockRows = () => [
  row("Retest row 64 (outpatient visit navigator)", true, etAt("2026-10-21", "14:00").toISOString()),
  row("Exclude observational studies, retest rows 80–82", true, etAt("2026-10-22", "11:00").toISOString()),
  row("Build the QuickAction, retest rows 83–84", true, etAt("2026-10-26", "16:30").toISOString()),
  row("Complete 006"),
  row("Complete 009", true, etAt("2026-10-28", "09:15").toISOString()),
  row("Complete 015"),
];

await test("Dates: the mockup case: 2 open steps on Thu 10/29 → the days left are Thu and Fri, the last lands on the due date", () => {
  const proposed = bit.proposeStepDates(work(), 2, etAt("2026-10-29"));
  assert.deepEqual(proposed.dates, ["2026-10-29", "2026-10-30"]);
  assert.equal(proposed.basis, "spread");
  assert.equal(
    bit.proposedDatesHint(proposed, 2),
    "Proposed dates: the 2 open steps are spread over the days left (Thu 10/29 and Fri 10/30), and the last one lands on this task's due date, Fri 10/30. Change any date."
  );
});

await test("Dates: spread evenly over a longer window, weekends skipped for a work task, last = due", () => {
  const task = work({ start_at: null, due_at: endOfEt("2026-11-10") });
  // Thu 10/29 .. Tue 11/10 = 9 working days (Sat/Sun skipped).
  const proposed = bit.proposeStepDates(task, 3, etAt("2026-10-29"));
  assert.equal(proposed.window.length, 9);
  assert.ok(proposed.window.every((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())));
  assert.deepEqual(proposed.dates, ["2026-11-02", "2026-11-05", "2026-11-10"]);
});

await test("Dates: a personal task counts every day (Brent 10/22, weekends only for personal), task or project tag", () => {
  const personal = work({ tags: ["personal"], start_at: null, due_at: endOfEt("2026-11-01") });
  assert.deepEqual(bit.proposeStepDates(personal, 4, etAt("2026-10-29")).dates, ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  const viaProject = work({ tags: [], project: { tags: ["personal"] }, start_at: null, due_at: endOfEt("2026-11-01") });
  assert.equal(bit.proposeStepDates(viaProject, 4, etAt("2026-10-29")).window.length, 4);
});

await test("Dates: more steps than days share days; the last still gets the due date", () => {
  const proposed = bit.proposeStepDates(work(), 5, etAt("2026-10-29"));
  assert.deepEqual(proposed.dates, ["2026-10-29", "2026-10-29", "2026-10-30", "2026-10-30", "2026-10-30"]);
});

await test("Dates: a start date in the future starts the spread there", () => {
  const task = work({ start_at: etAt("2026-11-02", "00:00").toISOString(), due_at: endOfEt("2026-11-06") });
  assert.deepEqual(bit.proposeStepDates(task, 2, etAt("2026-10-29")).dates, ["2026-11-04", "2026-11-06"]);
});

await test("Dates: no due date, or one already past → today + 1 working day, + 2, … (Fri → Mon)", () => {
  const none = bit.proposeStepDates(work({ due_at: null }), 3, etAt("2026-10-29"));
  assert.equal(none.basis, "next_days");
  assert.deepEqual(none.dates, ["2026-10-30", "2026-11-02", "2026-11-03"]);
  const past = bit.proposeStepDates(work({ due_at: endOfEt("2026-10-20") }), 1, etAt("2026-10-29"));
  assert.deepEqual(past.dates, ["2026-10-30"]);
  assert.match(bit.proposedDatesHint(none, 3), /has no due date ahead/);
});

await test("Dates: a work task due on a Saturday still lands its last step on the due date", () => {
  const proposed = bit.proposeStepDates(work({ start_at: null, due_at: endOfEt("2026-10-31") }), 2, etAt("2026-10-29"));
  assert.equal(proposed.dates.at(-1), "2026-10-31");
});

await test("Starts as: the first open step follows an In Progress task, the rest Planned, waiting ones 'Blocked by dependency'", () => {
  assert.equal(bit.startsAsLabel("In Progress", 0, false), "In Progress");
  assert.equal(bit.startsAsLabel("Planned", 0, false), "Planned");
  assert.equal(bit.startsAsLabel("In Progress", 1, false), "Planned");
  assert.equal(bit.startsAsLabel("In Progress", 1, true), "Blocked by dependency");
  assert.equal(bit.openStepStatus("In Progress", 1), "Planned");
});

await test("The button shows only with at least one open step and no steps yet", () => {
  assert.equal(bit.canBreakIntoTasks([{ is_done: true }, { is_done: false }]), true);
  assert.equal(bit.canBreakIntoTasks([{ is_done: true }]), false);
  assert.equal(bit.canBreakIntoTasks([]), false);
  assert.equal(bit.canBreakIntoTasks([{ is_done: false }], 3), false, "already an umbrella");
});

await test("Summary line and button label (mockup words)", () => {
  const s = bit.breakSummary({ kind: "new_section", name: work().title, projectName: "EPIC Research Build", openCount: 2, doneCount: 4 });
  assert.equal(s.line, "Creates 2 open tasks + 4 done tasks in a new section “Fix readiness script failures…” in EPIC Research Build.");
  assert.equal(s.button, "Break into 6 tasks");
  assert.match(s.umbrellaLine, /stays open as their umbrella/);
  assert.equal(bit.breakSummary({ kind: "new_project", name: "Kitchen", projectName: null, openCount: 1, doneCount: 0 }).line, "Creates 1 open task in a new project “Kitchen”.");
  assert.equal(bit.breakSummary({ kind: "existing_section", name: "x", projectName: "P", sectionName: null, openCount: 1, doneCount: 0 }).line, "Creates 1 open task in P, with no section.");
  assert.equal(bit.breakSummary({ kind: "existing_project", name: "Kitchen redo", projectName: "Home", openCount: 0, doneCount: 2 }).line, "Creates 2 done tasks in the project “Home”, as a new section “Kitchen redo”.");
  const none = bit.breakSummary({ kind: "new_section", name: "x", projectName: "P", openCount: 0, doneCount: 0 });
  assert.equal(none.ready, false);
});

await test("Parsing: a good request; unknown fields, bad dates, bad owners, duplicates and empty lists are refused", () => {
  const rows = mockRows();
  const good = bit.parseBreakRequest({
    destination: { kind: "new_section", name: "  Section A  " },
    steps: [{ checklist_item_id: rows[3].id, due_date: "2026-10-29", owner: "brent", waits_on_previous: false }],
  });
  assert.equal(good.ok, true);
  assert.equal(good.value.destination.name, "Section A");
  const bad = (body) => bit.parseBreakRequest(body);
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [], extra: 1 }).error, /Unknown field: extra/);
  assert.match(bad({ destination: { kind: "nope" }, steps: [] }).error, /destination.kind/);
  assert.match(bad({ destination: { kind: "new_section", name: " " }, steps: [] }).error, /name/);
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [] }).error, /at least one step/);
  const step = { checklist_item_id: rows[3].id, due_date: "2026-02-30", owner: "brent" };
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [step] }).error, /real YYYY-MM-DD/);
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [{ ...step, due_date: null, owner: "pm" }] }).error, /owner/);
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [{ ...step, due_date: null }, { ...step, due_date: null }] }).error, /twice/);
  assert.match(bad({ destination: { kind: "new_section", name: "x" }, steps: [{ ...step, due_date: null, status: "Done" }] }).error, /Unknown step field: status/);
  assert.match(bad({ destination: { kind: "existing_project" }, steps: [step] }).error, /name|project/i);
  assert.match(bad({ destination: { kind: "existing_project", name: "x" }, steps: [{ ...step, due_date: null }] }).error, /Pick a project/);
});

function planFor(rows, steps, destination = { kind: "new_section", name: "New S" }, umbrella = work(), now = etAt("2026-10-29")) {
  const parsed = bit.parseBreakRequest({ destination, steps });
  assert.equal(parsed.ok, true, parsed.error);
  return bit.planBreak(parsed.value, { umbrella, rows, projectName: umbrella.project?.name ?? null, now });
}

await test("Plan: finished steps are Done tasks with their tick time and tick day; open steps get their dates, owners and statuses", () => {
  const rows = mockRows();
  const plan = planFor(
    rows,
    rows.map((r, i) => ({ checklist_item_id: r.id, due_date: r.is_done ? null : ["2026-10-29", "2026-10-30"][i === 3 ? 0 : 1], owner: i === 5 ? "agent" : "brent", waits_on_previous: true }))
  );
  assert.equal(plan.ok, true, plan.error);
  const steps = plan.value.steps;
  assert.deepEqual(steps.map((s) => s.status), ["Done", "Done", "Done", "In Progress", "Done", "Planned"]);
  assert.equal("done_at" in steps[0], false, "066 reads the tick time from the locked row itself");
  assert.equal(steps[0].due_at, endOfEt("2026-10-21"), "a finished step is dated the day it was ticked");
  assert.equal(steps[4].due_at, endOfEt("2026-10-28"));
  assert.equal(steps[3].due_at, endOfEt("2026-10-29"));
  assert.equal(steps[5].due_at, work().due_at, "a step on the task's due date gets the task's own due instant");
  assert.equal(steps[5].owner, "agent");
  assert.deepEqual(steps.map((s) => s.waits_on_previous), [false, false, false, false, false, true], "only the second open step waits (finished steps are never chained)");
  assert.equal(steps.every((s) => s.expect_done === (s.status === "Done")), true);
  assert.match(steps[3].comment, /^Part of “Fix readiness script failures.*”: broken out of its checklist on Thu 10\/29 \(step 4 of 6\)/);
  assert.match(plan.value.umbrella_comment, /^Broken into 6 tasks in the new section “New S” \(4 already done\)\. This task stays open as their umbrella/);
  assert.equal(plan.value.expect_base_priority, 60);
  assert.equal(plan.value.expect_project_id, work().project_id);
  assert.deepEqual(plan.value.destination, {
    kind: "new_section",
    project_id: work().project_id,
    section_id: null,
    name: "New S",
    planned_start: "2026-10-21",
    planned_end: "2026-10-30",
    stage: null,
  });
  for (const step of steps) {
    assert.ok(Number.isInteger(step.priority_score) && step.priority_score >= 0 && step.priority_score <= 100);
  }
});

await test("Plan: steps are taken in checklist order whatever order they were sent in; a row ticked before 059 kept times has no date", () => {
  const rows = [row("Old tick", true, null), row("A"), row("B")];
  const plan = planFor(rows, [
    { checklist_item_id: rows[2].id, due_date: null, owner: "brent", waits_on_previous: true },
    { checklist_item_id: rows[0].id, due_date: null, owner: "brent" },
    { checklist_item_id: rows[1].id, due_date: null, owner: "brent" },
  ]);
  assert.deepEqual(plan.value.steps.map((s) => s.title), ["Old tick", "A", "B"]);
  assert.equal(plan.value.steps[0].due_at, null);
  assert.equal(plan.value.steps[2].waits_on_previous, true);
});

await test("Plan: a Planned task's first open step starts Planned; leaving rows out only breaks out the chosen ones", () => {
  const rows = mockRows();
  const plan = planFor(rows, [{ checklist_item_id: rows[5].id, due_date: "2026-10-30", owner: "brent" }], undefined, work({ status: "Planned" }));
  assert.equal(plan.value.steps.length, 1);
  assert.equal(plan.value.steps[0].status, "Planned");
  assert.equal(plan.value.steps[0].waits_on_previous, false, "the first open step never waits");
});

await test("Plan: no project → new project (stage from the task) or an existing project's new section; section kinds refused", () => {
  const rows = [row("A"), row("B", true, etAt("2026-10-27").toISOString())];
  const standalone = work({ project_id: null, project: null, tags: ["personal"] });
  const steps = rows.map((r) => ({ checklist_item_id: r.id, due_date: null, owner: "brent" }));
  const asProject = planFor(rows, steps, { kind: "new_project", name: "Garage" }, standalone);
  assert.equal(asProject.ok, true);
  assert.deepEqual(asProject.value.destination, { kind: "new_project", project_id: null, section_id: null, name: "Garage", planned_start: null, planned_end: null, stage: "In Progress" });
  const existing = planFor(rows, steps, { kind: "existing_project", name: "Garage", project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, standalone);
  assert.equal(existing.value.destination.project_id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(existing.value.destination.planned_end, "2026-10-30");
  const refused = planFor(rows, steps, { kind: "new_section", name: "x" }, standalone);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no project/);
  const refused2 = planFor(rows, steps, { kind: "new_project", name: "x" });
  assert.equal(refused2.ok, false);
});

await test("Plan: a step id that isn't on the checklist is refused before any write", () => {
  const plan = planFor(mockRows(), [{ checklist_item_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", due_date: null, owner: "brent" }]);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /no longer on this task/);
});

await test("Refusals map to plain words and statuses", () => {
  assert.equal(bit.breakRefusal("already_broken").status, 409);
  assert.equal(bit.breakRefusal("checklist_changed").status, 409);
  assert.equal(bit.breakRefusal("section_name_taken").status, 409);
  assert.equal(bit.breakRefusal("not_found").status, 404);
  assert.equal(bit.breakRefusal("recurring_template").status, 400);
  assert.match(bit.breakRefusal("whatever").error, /could not be done/);
});

await test("Umbrella progress: the card counts step tasks ('4/6 tasks'), not the kept checklist", () => {
  const umbrella = {
    ...work(),
    checklist_rows: [{ is_done: false, unit_count: null }, { is_done: false, unit_count: null }],
    step_tasks: [{ status: "Done" }, { status: "Done" }, { status: "Done" }, { status: "In Progress" }, { status: "Done" }, { status: "Planned" }],
  };
  const progress = bit.progressRowsFor(umbrella);
  assert.equal(progress.source, "tasks");
  const card = view.buildRangeCardView(umbrella, progress.rows, etAt("2026-10-29"), { stepsAreTasks: true });
  assert.equal(card.steps.text, "4/6 tasks");
  assert.equal(card.steps.basis, "tasks");
  assert.equal(card.fillPercent, 67);
  assert.equal(card.allStepsDone, false);
  assert.match(card.srText, /4 of 6 tasks done, 67%/);
  assert.equal(view.stepsPillText(card), "4/6 tasks");
  // A task without steps keeps its checklist (unchanged multi-day behaviour).
  const plain = bit.progressRowsFor({ checklist_rows: umbrella.checklist_rows, step_tasks: [] });
  assert.equal(plain.source, "checklist");
  assert.equal(view.buildRangeCardView(umbrella, plain.rows, etAt("2026-10-29")).steps.text, "0/2 steps");
});

await test("Umbrella progress: every step Done → all steps done, Done lights up, the umbrella stays open (never auto-closed)", () => {
  const umbrella = { ...work(), step_tasks: Array.from({ length: 3 }, () => ({ status: "Done" })) };
  const card = view.buildRangeCardView(umbrella, bit.progressRowsFor(umbrella).rows, etAt("2026-10-29"), { stepsAreTasks: true });
  assert.equal(card.allStepsDone, true);
  assert.equal(view.stepsPillText(card), "3/3 tasks · all done");
  assert.equal(card.fillPercent, 100);
  assert.equal(umbrella.status, "In Progress");
  assert.equal(bit.stepsDoneText(umbrella.step_tasks), "All 3 steps done");
  assert.equal(bit.stepsDoneText([{ status: "Done" }, { status: "Planned" }]), "1/2 tasks done");
});

await test("Portfolio credit: an umbrella's entry becomes its steps (done/all); others keep their checklist", () => {
  const tasks = [
    { id: "u", status: "In Progress" },
    { id: "s1", status: "Done", parent_task_id: "u" },
    { id: "s2", status: "Planned", parent_task_id: "u" },
    { id: "s3", status: "Done", parent_task_id: "u" },
    { id: "x", status: "Planned" },
  ];
  const credit = bit.withStepProgress(tasks, { u: { done: 0, total: 6 }, x: { done: 1, total: 2 } });
  assert.deepEqual(credit.u, { done: 2, total: 3 });
  assert.deepEqual(credit.x, { done: 1, total: 2 });
  const untouched = { x: { done: 1, total: 2 } };
  assert.equal(bit.withStepProgress([{ id: "x", status: "Planned" }], untouched), untouched);
});

await test("Project page: a section whose tasks all share one umbrella shows its done/total; a mixed section shows nothing", () => {
  assert.deepEqual(bit.sectionUmbrella([{ status: "Done", parent_task_id: "u" }, { status: "Planned", parent_task_id: "u" }]), { umbrellaId: "u", done: 1, total: 2 });
  assert.equal(bit.sectionUmbrella([{ status: "Done", parent_task_id: "u" }, { status: "Planned", parent_task_id: null }]), null);
  assert.equal(bit.sectionUmbrella([]), null);
});

await test("Today query: the step tasks ride in the same request (one select, no per-task reads)", async () => {
  assert.match(queries.TODAY_TASK_SELECT, /step_tasks:tasks!parent_task_id\(id, title, status\)/);
  assert.match(queries.TODAY_TASK_SELECT, /checklist_rows:task_checklist_items\(is_done, unit_count\)/);
  const calls = [];
  const builder = {
    select(value) { calls.push(["select", value]); return builder; },
    eq() { return builder; }, in() { return builder; }, or() { return builder; }, order() { return builder; }, not() { return builder; }, neq() { return builder; }, gte() { return builder; },
    limit() {
      return Promise.resolve({
        data: [
          { id: "u", title: "U", status: "In Progress", step_tasks: [{ id: "s", title: "S", status: "Done" }], checklist_rows: [], project: null, implementation: null, sprint: null, section: null },
          { id: "p", title: "P", status: "Planned", project: null, implementation: null, sprint: null, section: null },
        ],
        error: null,
      });
    },
  };
  const tasks = await queries.queryTopThreeTasks({ from: () => builder }, "user", "all", etAt("2026-10-29"));
  assert.equal(calls.length, 1);
  assert.deepEqual(tasks.map((task) => task.step_tasks), [[{ id: "s", title: "S", status: "Done" }], []]);
});

// ── Routes with a fake client ────────────────────────────────────────────────

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";
process.env.DEPLOYMENT_ROLE = "main";
const { NextRequest } = await import("next/server.js");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const breakRoute = await import("../src/app/api/tasks/[id]/break/route.ts");
const USER = "99999999-9999-4999-8999-999999999999";
const TASK = work().id;

function fakeClient({ task, rows, rpc }) {
  const rpcCalls = [];
  const table = (name) => {
    const state = { name };
    const b = {
      select() { return b; }, eq() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() {
        if (name === "tasks") return Promise.resolve({ data: task, error: null });
        if (name === "projects" || name === "project_sections") return Promise.resolve({ data: { name: "Somewhere" }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve) { return Promise.resolve({ data: name === "task_checklist_items" ? rows : [], error: null }).then(resolve); },
    };
    return Object.assign(b, state);
  };
  return {
    rpcCalls,
    from: table,
    rpc(fn, args) { rpcCalls.push([fn, args]); return Promise.resolve(rpc(fn, args)); },
  };
}

function post(client, body, authSource = "legacy_api_key") {
  const request = new NextRequest(`http://localhost/api/tasks/${TASK}/break`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  writeInternalAuthContext(request, { supabase: client, user: { id: USER }, userId: USER, authSource });
  return breakRoute.POST(request, { params: Promise.resolve({ id: TASK }) });
}

await test("Route: one database call carries the whole plan; the reply is the function's", async () => {
  const rows = mockRows();
  const client = fakeClient({
    task: { ...work(), is_recurring_template: false },
    rows,
    rpc: () => ({ data: { ok: true, task_ids: ["t1"], section_id: "s", section_created: true }, error: null }),
  });
  const response = await post(client, {
    destination: { kind: "new_section", name: "Steps" },
    steps: rows.map((r) => ({ checklist_item_id: r.id, due_date: r.is_done ? null : "2026-10-30", owner: "brent", waits_on_previous: true })),
  });
  assert.equal(response.status, 201);
  assert.equal(client.rpcCalls.length, 1);
  const [fn, args] = client.rpcCalls[0];
  assert.equal(fn, "break_task_into_tasks");
  assert.equal(args.p_user_id, USER);
  assert.equal(args.p_task_id, TASK);
  assert.equal(args.p_request.steps.length, 6);
  assert.equal((await response.json()).section_created, true);
});

await test("Route: refusals become plain 409/404s; a bad body is a 400 with no database call; a busy lock is a 503", async () => {
  const rows = mockRows();
  const body = { destination: { kind: "new_section", name: "Steps" }, steps: [{ checklist_item_id: rows[3].id, due_date: null, owner: "brent" }] };
  const refused = fakeClient({ task: work(), rows, rpc: () => ({ data: { ok: false, reason: "checklist_changed" }, error: null }) });
  const r1 = await post(refused, body);
  assert.equal(r1.status, 409);
  assert.match((await r1.json()).error, /checklist changed/);
  const none = fakeClient({ task: work(), rows, rpc: () => { throw new Error("must not be called"); } });
  const r2 = await post(none, { ...body, sneaky: true });
  assert.equal(r2.status, 400);
  assert.equal(none.rpcCalls.length, 0);
  const busy = fakeClient({ task: work(), rows, rpc: () => ({ data: null, error: { code: "55P03", message: "lock timeout" } }) });
  const r3 = await post(busy, body);
  assert.equal(r3.status, 503);
  assert.equal((await r3.json()).reason, "busy");
});

await test("Route: Undo is one call carrying only the break's id", async () => {
  const client = fakeClient({ task: work(), rows: [], rpc: () => ({ data: { ok: true, deleted_tasks: 2 }, error: null }) });
  const response = await post(client, { action: "undo", break_id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(response.status, 200);
  assert.equal(client.rpcCalls[0][0], "undo_break_task_into_tasks");
  assert.deepEqual(client.rpcCalls[0][1].p_request, { break_id: "11111111-1111-4111-8111-111111111111" });
  const bad = await post(client, { action: "undo", break_id: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(client.rpcCalls.length, 1);
});

await test("Route auth: the FamCal and actions keys may not break tasks (route-auth allowlists)", async () => {
  const { isMachineKeyRouteAllowed } = await import("../src/lib/supabase/route-auth.ts");
  for (const path of [`/api/tasks/${TASK}/break`, `/api/tasks/${TASK}/steps`]) {
    for (const method of ["POST", "GET"]) {
      assert.equal(isMachineKeyRouteAllowed("famcal_api_key", method, path), false, `famcal ${method} ${path}`);
      assert.equal(isMachineKeyRouteAllowed("actions_api_key", method, path), false, `actions ${method} ${path}`);
    }
  }
  assert.equal(isMachineKeyRouteAllowed("legacy_api_key", "POST", `/api/tasks/${TASK}/break`), true);
});

// ── Fix round 1 (Codex Astra review of 5c5c8b4): one test per finding ──────

await test("FR P1-1: Undo refuses client-supplied cleanup ids (task_ids, section_id, project_id, umbrella_comment_id) before any database call", async () => {
  const client = fakeClient({ task: work(), rows: [], rpc: () => { throw new Error("must not be called"); } });
  const unrelatedProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  for (const body of [
    { action: "undo", task_ids: ["11111111-1111-4111-8111-111111111111"], project_id: unrelatedProject, section_id: null, umbrella_comment_id: null },
    { action: "undo", break_id: "11111111-1111-4111-8111-111111111111", project_id: unrelatedProject },
    { action: "undo", break_id: "11111111-1111-4111-8111-111111111111", umbrella_comment_id: "22222222-2222-4222-8222-222222222222" },
    { action: "undo" },
  ]) {
    const response = await post(client, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(client.rpcCalls.length, 0);
});

await test("FR P1-2: the Undo refusal says what changed (edits, comments, links, new tasks), so the toast's promise is true", () => {
  const refusal = bit.breakRefusal("changed");
  assert.equal(refusal.status, 409);
  assert.match(refusal.error, /comment/);
  assert.match(refusal.error, /link/);
});

await test("FR P1-3: every system comment has a plain variant that names neither the umbrella nor the destination", () => {
  const rows = [row("A"), row("B", true, etAt("2026-10-27").toISOString())];
  const standalone = work({ title: "Pick up the dog food", project_id: null, project: null, tags: ["personal"] });
  const parsed = bit.parseBreakRequest({
    destination: { kind: "existing_project", name: "Garage", project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    steps: rows.map((r) => ({ checklist_item_id: r.id, due_date: null, owner: "brent" })),
  });
  const plan = bit.planBreak(parsed.value, { umbrella: standalone, rows, projectName: null, destinationLabel: "CONFIDENTIAL WORK PROJECT", now: etAt("2026-10-29") });
  assert.equal(plan.ok, true, plan.error);
  assert.match(plan.value.umbrella_comment, /CONFIDENTIAL WORK PROJECT/, "the named one, for the same audience");
  assert.ok(plan.value.umbrella_comment_generic, "a plain umbrella comment is sent");
  assert.doesNotMatch(plan.value.umbrella_comment_generic, /CONFIDENTIAL|Garage/);
  assert.match(plan.value.umbrella_comment_generic, /^Broken into 2 tasks in another project \(1 already done\)/);
  for (const step of plan.value.steps) {
    assert.match(step.comment, /Pick up the dog food/);
    assert.ok(step.comment_generic, "a plain step comment is sent");
    assert.doesNotMatch(step.comment_generic, /dog food/);
    assert.match(step.comment_generic, /^Part of another task: broken out of its checklist on Thu 10\/29 \(step \d of 2\)/);
  }
});

const umbrellaWith = (overrides, stepStatuses) => ({ ...work(overrides), step_tasks: stepStatuses.map((status) => ({ status })) });
const cardFor = (task, now = etAt("2026-10-29")) => {
  const progress = bit.progressRowsFor(task);
  return view.buildRangeCardView(task, progress.rows, now, { stepsAreTasks: progress.source === "tasks" });
};

await test("FR P2-1: an umbrella without a range (due date only, no due date, start = due) still shows 'x/y tasks' on Today", () => {
  const cases = {
    dueOnly: umbrellaWith({ start_at: null, due_at: endOfEt("2026-10-30") }, ["Done", "Planned"]),
    noDue: umbrellaWith({ start_at: null, due_at: null }, ["Done", "Planned"]),
    sameDay: umbrellaWith({ start_at: etAt("2026-10-30", "00:00").toISOString(), due_at: endOfEt("2026-10-30") }, ["Done", "Planned"]),
  };
  for (const [name, task] of Object.entries(cases)) {
    const card = cardFor(task);
    assert.ok(card, `${name}: a card view`);
    assert.equal(card.steps.text, "1/2 tasks", name);
    assert.equal(card.steps.basis, "tasks", name);
    assert.equal(card.fillPercent, 50, name);
    assert.equal(card.isRange, false, name);
    assert.equal(card.elapsedPercent, null, name);
    assert.equal(card.allStepsDone, false, name);
    assert.match(card.srText, /1 of 2 tasks done, 50%/, name);
  }
  assert.equal(cardFor(cases.dueOnly).chipText, "Due Fri 10/30");
  assert.equal(cardFor(cases.noDue).chipText, "");
  assert.equal(cardFor(umbrellaWith({ start_at: null, due_at: endOfEt("2026-10-29") }, ["Planned"])).chipText, "Due today");
  const late = cardFor(umbrellaWith({ start_at: null, due_at: endOfEt("2026-10-27") }, ["Planned"]));
  assert.equal(late.chipText, "Overdue");
  assert.equal(late.tone, "late");
  // A plain task without a range keeps the old card (null), and a closed umbrella too.
  assert.equal(view.buildRangeCardView(work({ start_at: null }), [{ is_done: false, unit_count: null }], etAt("2026-10-29")), null);
  assert.equal(cardFor(umbrellaWith({ start_at: null, status: "Done" }, ["Done"])), null);
  // A real range keeps its range card.
  assert.equal(cardFor(umbrellaWith({}, ["Done", "Planned"])).isRange, true);
});

await test("FR P2-1: every step Done lights the Done button whatever the umbrella's dates", () => {
  for (const overrides of [{ start_at: null, due_at: endOfEt("2026-10-30") }, { start_at: null, due_at: null }]) {
    const card = cardFor(umbrellaWith(overrides, ["Done", "Done"]));
    assert.equal(card.allStepsDone, true);
    assert.equal(view.stepsPillText(card), "2/2 tasks · all done");
    assert.match(card.srText, /The Done button is ready/);
  }
});

await test("FR P2-2: pace counts a converted checklist row and its step once (10 → 10, not 20; step Done → 0; partial; Undo)", async () => {
  const pace = await import("../src/lib/pace.ts");
  const U = "aaaaaaaa-0000-4000-8000-000000000001";
  const C = "aaaaaaaa-0000-4000-8000-000000000002";
  const task = (id, extra = {}) => ({ id, status: "In Progress", estimated_minutes: 60, unit_count: null, work_type: "sc", is_sample: false, section_id: null, ...extra });
  const items = [
    { id: "row-10", task_id: U, is_done: false, unit_count: 10, work_type: "sc" },
    { id: "row-4", task_id: U, is_done: false, unit_count: 4, work_type: "sc" },
  ];
  const left = (tasks) => pace.buildUnitEntries(tasks, items).filter((e) => !e.done && !e.inactive).reduce((sum, e) => sum + e.units, 0);
  const umbrella = task(U);
  assert.equal(left([umbrella]), 14, "before the break");
  // Partial selection: only the 10-unit row is broken out (066 copies its units to the step).
  const step = task(C, { status: "Planned", unit_count: 10, section_id: "new-section", source_checklist_item_id: "row-10" });
  assert.equal(left([umbrella, step]), 14, "after the break: the same work, counted once");
  const entries = pace.buildUnitEntries([umbrella, step], items);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.item_id === "row-10").section_id, "new-section", "the row's work sits in the step's lane");
  assert.equal(left([umbrella, { ...step, status: "Done" }]), 4, "step Done → its row's units are done");
  assert.equal(left([umbrella, { ...step, status: "Parked" }]), 4, "step Parked → not work left");
  assert.equal(left([umbrella]), 14, "Undo deletes the step: the row counts alone again");
  // A step whose row isn't in this project's input (moved elsewhere) keeps its own units.
  assert.equal(left([step]), 10);
});

await test("FR2 LOW-3: a step whose checklist row had no units counts the units set on the step later (5, not 0)", async () => {
  const pace = await import("../src/lib/pace.ts");
  const U = "aaaaaaaa-0000-4000-8000-000000000001";
  const C = "aaaaaaaa-0000-4000-8000-000000000002";
  const task = (id, extra = {}) => ({ id, status: "In Progress", estimated_minutes: 60, unit_count: null, work_type: "sc", is_sample: false, section_id: null, ...extra });
  const items = [
    { id: "row-none", task_id: U, is_done: false, unit_count: null, work_type: "sc" },
    { id: "row-zero", task_id: U, is_done: false, unit_count: 0, work_type: "sc" },
    { id: "row-10", task_id: U, is_done: false, unit_count: 10, work_type: "sc" },
  ];
  const left = (tasks) => pace.buildUnitEntries(tasks, items).filter((e) => !e.done && !e.inactive).reduce((sum, e) => sum + e.units, 0);
  const umbrella = task(U);
  const fromNone = task(C, { status: "Planned", unit_count: 5, section_id: "lane", source_checklist_item_id: "row-none" });
  assert.equal(left([umbrella, fromNone]), 15, "the row with 10 + the step's own 5 (was 10: the 5 were dropped)");
  const own = pace.buildUnitEntries([umbrella, fromNone], items).find((e) => e.key === `task:${C}`);
  assert.ok(own, "the step has its own entry");
  assert.equal(own.section_id, "lane");
  assert.equal(left([umbrella, { ...fromNone, source_checklist_item_id: "row-zero" }]), 15, "a 0-unit row doesn't speak for its step either");
  assert.equal(left([umbrella, { ...fromNone, status: "Done" }]), 10, "step Done → its own 5 are done");
  // A row WITH units still speaks for its step (P2-2 unchanged): 10 counted once.
  const paired = task("aaaaaaaa-0000-4000-8000-000000000003", { status: "Planned", unit_count: 10, source_checklist_item_id: "row-10" });
  assert.equal(left([umbrella, paired]), 10);
  assert.equal(left([umbrella, paired, fromNone]), 15);
});

await test("FR P2-4: a Done, Missed or Parked task can't be broken (button hidden, plan refused, refusal words)", () => {
  for (const status of ["Done", "Missed", "Parked"]) {
    assert.equal(bit.canBreakIntoTasks([{ is_done: false }], 0, status), false, status);
    const rows = [row("Open")];
    const plan = planFor(rows, [{ checklist_item_id: rows[0].id, due_date: null, owner: "brent" }], undefined, work({ status }));
    assert.equal(plan.ok, false, status);
    assert.match(plan.error, /can’t be broken into tasks/);
  }
  for (const status of ["Backlog", "Planned", "In Progress", "Blocked/Waiting"]) {
    assert.equal(bit.canBreakIntoTasks([{ is_done: false }], 0, status), true, status);
  }
  assert.equal(bit.breakRefusal("task_closed").status, 409);
  assert.match(bit.breakRefusal("task_closed").error, /closed/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
