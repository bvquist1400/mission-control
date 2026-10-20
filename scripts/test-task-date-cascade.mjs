// Tests for cascade due dates (Baseline task 6fcad51b, slice S1): the planner in
// src/lib/task-date-cascade.ts (working days in ET, modes, skips, floor, cycles,
// diamonds, caps), the PATCH /api/tasks/{id} integration (cascade true/false/
// "preview", cascade_mode, cascade_confirm, the two-statement seam), the FamCal
// key both ways, MCP update_task's new parameters, and the S1 carry list (FamCal
// list/detail alignment, paged fetchTaskDependencySummaries, the loop guard's
// error mapping, OAuth remove scope, create-time initial_comment/checklist).
//
// Offline: no database and no network. Route handlers run with an injected auth
// context and an in-memory fake Supabase client; the SQL function is modelled by
// the fake's rpc (the real one is pinned by test:task-date-cascade-db).
//
//   npm run test:task-date-cascade

import assert from "node:assert/strict";

const LEGACY_KEY = "test-legacy-key-cccccccccccccccc";
const API_USER_ID = "00000000-0000-4000-8000-000000000001";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;
process.env.DEPLOYMENT_ROLE = "main";

const mcpCalls = [];
let mcpResponder = () => new Response(JSON.stringify({ error: "no responder" }), { status: 500 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const call = { url, method: (init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : undefined };
  mcpCalls.push(call);
  return mcpResponder(call);
};

const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const cascade = await import("../src/lib/task-date-cascade.ts");
const famcal = await import("../src/lib/famcal-api-key.ts");
const deps = await import("../src/lib/task-dependencies.ts");
const scopes = await import("../src/lib/mcp/upstream-scopes.ts");
const taskRoute = await import("../src/app/api/tasks/[id]/route.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const dependenciesRoute = await import("../src/app/api/tasks/[id]/dependencies/route.ts");
const mcpRoute = await import("../src/app/api/mcp/route.ts");

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

// ET instants. October 2026 is EDT (UTC-4) until Sun Nov 1, then EST (UTC-5).
const etAt = (date, time = "17:00") => {
  const offset = date >= "2026-11-01" ? "-05:00" : "-04:00";
  return new Date(`${date}T${time}:00${offset}`).toISOString();
};
const etDate = (iso) => cascade.etDateOf(iso);

// ── 1. ET working-day math ─────────────────────────────────────────────────
await test("workdaysBetween: Tue→Thu 2, Fri→Mon 1, Sat→Sun 0, Sat→Mon 1, earlier 0", () => {
  assert.equal(cascade.workdaysBetween("2026-10-20", "2026-10-22"), 2);
  assert.equal(cascade.workdaysBetween("2026-10-23", "2026-10-26"), 1);
  assert.equal(cascade.workdaysBetween("2026-10-24", "2026-10-25"), 0);
  assert.equal(cascade.workdaysBetween("2026-10-24", "2026-10-26"), 1);
  assert.equal(cascade.workdaysBetween("2026-10-22", "2026-10-20"), 0);
});

await test("addWorkdays skips weekends; shiftByWorkdays keeps the ET time of day across the DST change", () => {
  assert.equal(cascade.addWorkdays("2026-10-22", 2), "2026-10-26");
  assert.equal(cascade.addWorkdays("2026-10-24", 1), "2026-10-26");
  const friday5pm = etAt("2026-10-30");
  const shifted = cascade.shiftByWorkdays(friday5pm, 2);
  assert.equal(shifted, etAt("2026-11-03"));
  assert.equal(shifted, "2026-11-03T22:00:00.000Z");
  // End of the ET day stays the end of the ET day.
  assert.equal(cascade.shiftByWorkdays("2026-10-31T03:59:59.999Z", 1), "2026-11-03T04:59:59.999Z");
});

await test("formatEtDay reads the ET date, not UTC", () => {
  assert.equal(cascade.formatEtDay("2026-10-23T03:59:59.999Z"), "Thu 10/22");
  assert.equal(cascade.formatEtDay(etAt("2026-10-26")), "Mon 10/26");
});

// ── 2. Planner (pure) ─────────────────────────────────────────────────────
const tid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function graphOf(rootId, rows, edges, extra = {}) {
  const tasks = new Map();
  // Depth by BFS over edges (the loader's order).
  const depth = new Map([[rootId, 0]]);
  let frontier = [rootId];
  for (let d = 1; frontier.length; d += 1) {
    const next = [];
    for (const [waiting, on] of edges) {
      if (frontier.includes(on) && !depth.has(waiting)) {
        depth.set(waiting, d);
        const row = rows[waiting];
        if (row && cascade.classifyCascadeTask(row).kind !== "stop") next.push(waiting);
      }
    }
    frontier = next;
  }
  for (const [taskId, row] of Object.entries(rows)) {
    if (depth.has(taskId) && taskId !== rootId) tasks.set(taskId, { ...row, depth: depth.get(taskId) });
  }
  return {
    rootId,
    tasks,
    edges: edges
      .filter(([waiting, on]) => (waiting === rootId || tasks.has(waiting)) && (on === rootId || tasks.has(on)))
      .map(([task_id, depends_on_task_id]) => ({ task_id, depends_on_task_id })),
    depthLimited: 0,
    tooLarge: false,
    ...extra,
  };
}

const row = (taskId, title, due, extra = {}) => ({
  id: taskId, title, status: "Planned", due_at: due, project_id: null, is_recurring_template: false, recurring_template_id: null, ...extra,
});

function plan(rootId, rows, edges, { oldDue, newDue, mode = "same_gap" }) {
  const trigger = cascade.cascadeTrigger({ status: "Planned", due_at: oldDue }, { status: "Planned", due_at: newDue }, mode);
  assert.equal(trigger.run, true, `trigger: ${JSON.stringify(trigger)}`);
  return cascade.planTaskDateCascade({
    graph: graphOf(rootId, rows, edges),
    mode,
    deltaWorkdays: trigger.deltaWorkdays,
    rootOldDueAt: oldDue,
    rootNewDueAt: newDue,
  });
}
const movedDates = (result) => Object.fromEntries(result.moves.map((move) => [move.title, etDate(move.new_due_at)]));

await test("Brent's example: license Tue 10/20 → Thu 10/22 moves voter registration Thu 10/22 → Mon 10/26", () => {
  const L = tid(1), V = tid(2);
  const result = plan(L, { [V]: row(V, "Voter registration", etAt("2026-10-22")) }, [[V, L]], {
    oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22"),
  });
  assert.equal(result.deltaWorkdays, 2);
  assert.deepEqual(movedDates(result), { "Voter registration": "2026-10-26" });
  const comments = cascade.buildCascadeMoveComments({
    rootTitle: "MA driver's license transfer", rootNewDueAt: etAt("2026-10-22"), mode: "same_gap", deltaWorkdays: 2, move: result.moves[0],
  });
  assert.equal(comments.named, "Due date moved from Thu 10/22 to Mon 10/26 because \"MA driver's license transfer\" slipped 2 working days.");
  assert.equal(comments.redacted, "Due date moved from Thu 10/22 to Mon 10/26 because a task it depends on moved later.");
});

// OnCore-shaped chain: calendar + 6 steps, each waiting on the one before.
const ONCORE = ["Calendar build", "MCA review", "Budget build", "Coverage analysis", "Regulatory sign-off", "Test plan", "Go-live checklist"];
const ONCORE_DATES = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"];
function oncore(extra = {}) {
  const ids = ONCORE.map((_, index) => tid(100 + index));
  const rows = {};
  ids.forEach((taskId, index) => {
    if (index > 0) rows[taskId] = row(taskId, ONCORE[index], etAt(ONCORE_DATES[index]), extra[ONCORE[index]] ?? {});
  });
  const edges = ids.slice(1).map((taskId, index) => [taskId, ids[index]]);
  return { ids, rows, edges };
}

await test("OnCore 7-task chain: calendar +2 working days moves each of the 6 after it +2 working days", () => {
  const { ids, rows, edges } = oncore();
  const result = plan(ids[0], rows, edges, { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22") });
  assert.deepEqual(movedDates(result), {
    "MCA review": "2026-10-23",
    "Budget build": "2026-10-26",
    "Coverage analysis": "2026-10-27",
    "Regulatory sign-off": "2026-10-28",
    "Test plan": "2026-10-29",
    "Go-live checklist": "2026-10-30",
  });
  assert.deepEqual(result.moves.map((move) => move.depth), [1, 2, 3, 4, 5, 6]);
  // Each keeps its own ET time of day.
  for (const move of result.moves) assert.equal(new Date(move.new_due_at).getUTCHours(), 21);
});

await test("Stop at Done: nothing after a Done step moves; Missed and recurring stop the walk too", () => {
  for (const [label, extra, reason] of [
    ["Done", { status: "Done" }, "done"],
    ["Missed", { status: "Missed" }, "missed"],
    ["recurring instance", { recurring_template_id: tid(999) }, "recurring"],
    ["recurring template", { is_recurring_template: true }, "recurring"],
  ]) {
    const { ids, rows, edges } = oncore({ "Coverage analysis": extra });
    const result = plan(ids[0], rows, edges, { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22") });
    assert.deepEqual(Object.keys(movedDates(result)), ["MCA review", "Budget build"], label);
    assert.deepEqual(result.skipped.map((skip) => [skip.title, skip.reason]), [["Coverage analysis", reason]], label);
  }
});

await test("Parked and undated tasks never move, but the walk goes through them to the tasks after", () => {
  const { ids, rows, edges } = oncore({ "Budget build": { status: "Parked" }, "Regulatory sign-off": { due_at: null } });
  const result = plan(ids[0], rows, edges, { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22") });
  assert.deepEqual(movedDates(result), {
    "MCA review": "2026-10-23",
    "Coverage analysis": "2026-10-27",
    "Test plan": "2026-10-29",
    "Go-live checklist": "2026-10-30",
  });
  assert.deepEqual(result.skipped.map((skip) => [skip.title, skip.reason]).sort(), [["Budget build", "parked"], ["Regulatory sign-off", "no_due_date"]]);
});

await test("A loop among later tasks (B waits on C, C waits on B) ends; each moves once; the edited task never moves", () => {
  const R = tid(1), B = tid(2), C = tid(3);
  const rows = { [B]: row(B, "B", etAt("2026-10-21")), [C]: row(C, "C", etAt("2026-10-22")) };
  const result = plan(R, rows, [[B, R], [C, B], [B, C], [R, C]], { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22") });
  assert.equal(result.moves.length, 2);
  // Floor inside the loop: both end on the later of the two.
  assert.deepEqual(movedDates(result), { B: "2026-10-26", C: "2026-10-26" });
  assert.equal(result.moves.some((move) => move.task_id === R), false);
});

await test("Diamond: D (after B and after C) is moved once, by the gap, and never ends before either", () => {
  const A = tid(1), B = tid(2), C = tid(3), E = tid(4), D = tid(5);
  const rows = {
    [B]: row(B, "B", etAt("2026-10-21")),
    [C]: row(C, "C", etAt("2026-10-21")),
    [E]: row(E, "E", etAt("2026-10-23")),
    [D]: row(D, "D", etAt("2026-10-22")), // already before E: the floor lifts it to E's new day
  };
  const result = plan(A, rows, [[B, A], [C, A], [E, C], [D, B], [D, E]], { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-21") });
  assert.equal(result.deltaWorkdays, 1);
  assert.equal(result.moves.filter((move) => move.title === "D").length, 1);
  assert.deepEqual(movedDates(result), { B: "2026-10-22", C: "2026-10-22", E: "2026-10-26", D: "2026-10-26" });
  const d = result.moves.find((move) => move.title === "D");
  assert.equal(d.floor_raised, true);
  assert.match(
    cascade.buildCascadeMoveComments({ rootTitle: "A", rootNewDueAt: etAt("2026-10-21"), mode: "same_gap", deltaWorkdays: 1, move: d }).named,
    /kept on or after the task it waits on/
  );
});

await test("only_collisions: moves only what would now be due before a task it waits on, to that day; no new gaps are 'fixed'", () => {
  const R = tid(1), B = tid(2), C = tid(3), X = tid(4), Y = tid(5);
  const rows = {
    [B]: row(B, "B collides", etAt("2026-10-21", "09:00")),
    [C]: row(C, "C after B", etAt("2026-10-21", "12:00")), // B moves to Thu → C now collides too
    [X]: row(X, "X fine", etAt("2026-10-27")),
    [Y]: row(Y, "Y already early", etAt("2026-10-19")), // waits on X, already before it: not this move's doing
  };
  const result = plan(R, rows, [[B, R], [C, B], [X, R], [Y, X]], { oldDue: etAt("2026-10-20"), newDue: etAt("2026-10-22"), mode: "only_collisions" });
  assert.deepEqual(movedDates(result), { "B collides": "2026-10-22", "C after B": "2026-10-22" });
  // Same ET day as its prerequisite, own time of day.
  assert.equal(result.moves[0].new_due_at, etAt("2026-10-22", "09:00"));
  assert.deepEqual(result.skipped.map((skip) => [skip.title, skip.reason]).sort(), [["X fine", "not_needed"], ["Y already early", "not_needed"]]);
  const comments = cascade.buildCascadeMoveComments({ rootTitle: "Root", rootNewDueAt: etAt("2026-10-22"), mode: "only_collisions", deltaWorkdays: 2, move: result.moves[0] });
  assert.match(comments.named, /moved to Thu 10\/22 and this task can't be due before a task it waits on/);
});

await test("cascadeTrigger: earlier, same day, cleared, no change, Done or recurring root never cascade; a first date only collides", () => {
  const before = { status: "Planned", due_at: etAt("2026-10-22") };
  const t = (after, mode = "same_gap", b = before) => cascade.cascadeTrigger(b, { ...b, ...after }, mode);
  assert.deepEqual(t({ due_at: etAt("2026-10-20") }), { run: false, reason: "earlier" });
  assert.deepEqual(t({ due_at: etAt("2026-10-22", "20:00") }), { run: false, reason: "same_day" });
  assert.deepEqual(t({ due_at: null }), { run: false, reason: "cleared" });
  assert.deepEqual(t({ due_at: before.due_at }), { run: false, reason: "no_change" });
  assert.deepEqual(t({ due_at: etAt("2026-10-26"), status: "Done" }), { run: false, reason: "done" });
  assert.deepEqual(t({ due_at: etAt("2026-10-26") }, "same_gap", { ...before, recurring_template_id: tid(9) }), { run: false, reason: "recurring" });
  assert.deepEqual(t({ due_at: etAt("2026-10-25") }, "same_gap", { status: "Planned", due_at: etAt("2026-10-24") }), { run: false, reason: "same_day" });
  assert.deepEqual(t({ due_at: etAt("2026-10-26") }, "same_gap", { status: "Planned", due_at: null }), { run: false, reason: "no_previous_date" });
  assert.deepEqual(t({ due_at: etAt("2026-10-26") }, "only_collisions", { status: "Planned", due_at: null }), { run: true, deltaWorkdays: 0 });
  assert.deepEqual(t({ due_at: etAt("2026-10-26") }), { run: true, deltaWorkdays: 2 });
});

await test("parseCascadeOptions: defaults, values, and plain 400 messages", () => {
  assert.deepEqual(cascade.parseCascadeOptions({ due_at: "x" }), { ok: true, value: { cascade: true, mode: "same_gap", confirm: false } });
  assert.deepEqual(cascade.parseCascadeOptions({ due_at: "x", cascade: "preview", cascade_mode: "only_collisions", cascade_confirm: true }), {
    ok: true, value: { cascade: "preview", mode: "only_collisions", confirm: true },
  });
  assert.equal(cascade.parseCascadeOptions({ cascade: "yes" }).ok, false);
  assert.equal(cascade.parseCascadeOptions({ cascade_mode: "all" }).ok, false);
  assert.equal(cascade.parseCascadeOptions({ cascade_confirm: "true" }).ok, false);
  assert.equal(cascade.parseCascadeOptions({ cascade: "preview" }).ok, false);
});

await test("projectFlagsForMoves: a move past the target date flags the project (Green → Yellow, Red stays Red)", () => {
  const flags = cascade.projectFlagsForMoves(
    [
      { project_id: "p1", new_due_at: etAt("2026-10-30") },
      { project_id: "p1", new_due_at: etAt("2026-10-29") },
      { project_id: "p2", new_due_at: etAt("2026-11-03") },
      { project_id: "p3", new_due_at: etAt("2026-10-20") },
    ],
    [
      { id: "p1", name: "OnCore", target_date: "2026-10-29", rag: "Green" },
      { id: "p2", name: "Red one", target_date: "2026-10-30", rag: "Red" },
      { id: "p3", name: "Fine", target_date: "2026-10-30", rag: "Green" },
    ]
  );
  assert.deepEqual(flags.map((flag) => [flag.name, flag.tasks_past_target, flag.latest_due_date, flag.rag_before, flag.rag_after]), [
    ["OnCore", 1, "2026-10-30", "Green", "Yellow"],
    ["Red one", 1, "2026-11-03", "Red", "Red"],
  ]);
});

// ── 3. Fake Supabase (in-memory; same shape as the S0 test's) ──────────────
const P = { id: tid(500), name: "OnCore Workflow Testing", stage: "Build", rag: "Green", tags: ["work"], user_id: API_USER_ID, implementation_id: null, target_date: "2026-10-29" };
const T = {
  license: tid(1), voter: tid(2), workWaiter: tid(3), personalBehindWork: tid(4), // FamCal both ways
  workRoot: tid(5), personalDep: tid(6), workDep: tid(7),
  stakeholderish: tid(8),
};

function task(taskId, title, extra = {}) {
  return {
    id: taskId, user_id: API_USER_ID, title, status: "Planned", tags: ["work"], due_at: null, follow_up_at: null,
    project_id: null, implementation_id: null, sprint_id: null, section_id: null, base_priority: 50, priority_score: 50,
    stakeholder_mentions: [], is_recurring_template: false, recurring_template_id: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...extra,
  };
}
function dep(depId, taskId, dependsOnTaskId, extra = {}) {
  return { id: depId, user_id: API_USER_ID, task_id: taskId, depends_on_task_id: dependsOnTaskId, depends_on_commitment_id: null, is_resolved: false, resolved_at: null, created_at: "2026-10-01T00:00:00Z", ...extra };
}

function seed() {
  const oncoreIds = ONCORE.map((_, index) => tid(100 + index));
  return {
    projects: [{ ...P }],
    commitments: [],
    stakeholders: [],
    tasks: [
      ...oncoreIds.map((taskId, index) => task(taskId, ONCORE[index], { project_id: P.id, due_at: etAt(ONCORE_DATES[index]) })),
      task(T.license, "MA driver's license transfer", { tags: ["personal"], due_at: etAt("2026-10-20") }),
      task(T.voter, "Voter registration", { tags: ["personal"], due_at: etAt("2026-10-22") }),
      task(T.workWaiter, "Secret work follow-on", { due_at: etAt("2026-10-23") }),
      task(T.personalBehindWork, "Personal behind a work task", { tags: ["personal"], due_at: etAt("2026-10-26") }),
      task(T.workRoot, "Secret work milestone", { due_at: etAt("2026-10-20") }),
      task(T.personalDep, "Pick up the new plates", { tags: ["personal"], due_at: etAt("2026-10-21") }),
      task(T.workDep, "Work follow-up", { due_at: etAt("2026-10-21") }),
    ],
    task_dependencies: [
      ...oncoreIds.slice(1).map((taskId, index) => dep(`oc${index + 1}`, taskId, oncoreIds[index])),
      dep("p1", T.voter, T.license),
      dep("p2", T.workWaiter, T.license),
      dep("p3", T.personalBehindWork, T.workWaiter),
      dep("w1", T.personalDep, T.workRoot),
      dep("w2", T.workDep, T.workRoot),
    ],
    task_comments: [],
    task_status_transitions: [],
    task_date_cascades: [],
    task_date_cascade_moves: [],
  };
}

function makeDb({ rowCap = 1000, rpcFails = null, hook = null, state: given = null } = {}) {
  const state = given ?? seed();
  const log = [];
  const rpcCalls = [];
  const projectById = () => new Map(state.projects.map((p) => [p.id, p]));
  const famcalEligible = (r) => {
    if (!(r.tags || []).includes("personal") || r.sprint_id) return false;
    if (!r.project_id) return !r.implementation_id && !r.section_id;
    const project = projectById().get(r.project_id);
    return Boolean(project && project.user_id === r.user_id && project.tags.includes("personal"));
  };
  const value = (table, r, column) => {
    // FamCal link read: the waiting task joined as `waiting` (inner join).
    if (table === "task_dependencies" && String(column).startsWith("waiting.")) {
      const waiting = state.tasks.find((t) => t.id === r.task_id);
      return waiting ? value("tasks", waiting, column.slice("waiting.".length)) : undefined;
    }
    return table === "tasks" && column === "famcal_eligible" ? famcalEligible(r) : r[column];
  };

  function run(table, ops) {
    const op = (name) => ops.find(([n]) => n === name);
    const mode = op("single") ? "single" : op("maybeSingle") ? "maybeSingle" : "many";
    const finish = (rows, error = null) => {
      if (error) return { data: null, error };
      if (mode === "many") return { data: rows, error: null };
      if (rows.length === 0) return mode === "single" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: rows[0], error: null };
    };
    const rowsOf = () => (state[table] ||= []);
    const matches = (r) => ops.every(([name, args]) => {
      if (name === "eq" && String(args[0]).startsWith("task_comments.")) return true; // embedded comments, applied below
      if (name === "eq") return value(table, r, args[0]) === args[1];
      if (name === "neq") return value(table, r, args[0]) !== args[1];
      if (name === "in") return args[1].includes(value(table, r, args[0]));
      if (name === "is") return value(table, r, args[0]) === args[1];
      if (name === "gt") return String(value(table, r, args[0])) > String(args[1]);
      if (name === "gte") return String(value(table, r, args[0])) >= String(args[1]);
      if (name === "not" && args[1] === "is") return value(table, r, args[0]) !== args[2];
      if (name === "contains") return args[1].every((tag) => (value(table, r, args[0]) || []).includes(tag));
      return true;
    });
    const withRelations = (r) => {
      if (table !== "tasks") return { ...r };
      const project = r.project_id ? projectById().get(r.project_id) ?? null : null;
      return { ...r, project: project ? { id: project.id, name: project.name, stage: project.stage, rag: project.rag, tags: project.tags } : null, implementation: null, sprint: null, section: null };
    };
    const insert = op("insert")?.[1][0];
    if (insert) {
      const rows = (Array.isArray(insert) ? insert : [insert]).map((r, index) => ({ id: r.id ?? `${table}-new-${rowsOf().length + index + 1}`, created_at: "2026-10-19T12:00:00Z", ...r }));
      if (state.failInsert?.[table]) return finish([], state.failInsert[table]);
      rowsOf().push(...rows);
      return finish(rows.map(withRelations));
    }
    if (op("delete")) {
      const doomed = rowsOf().filter(matches);
      state[table] = rowsOf().filter((r) => !doomed.includes(r));
      if (table === "tasks") {
        const gone = new Set(doomed.map((r) => r.id));
        for (const child of ["task_dependencies", "task_comments", "task_checklist_items"]) {
          state[child] = (state[child] || []).filter((r) => !gone.has(r.task_id));
        }
      }
      return finish(doomed);
    }
    const update = op("update")?.[1][0];
    if (update) {
      const hit = rowsOf().filter(matches);
      for (const r of hit) Object.assign(r, update);
      return finish(hit.map(withRelations));
    }
    if (ops.some(([name, args]) => name === "in" && args[1].length > 500)) return finish([], { message: "URI too long" });
    let rows = rowsOf().filter(matches);
    for (const [name, args] of ops) {
      if (name !== "order") continue;
      const [column, options = {}] = args;
      const dir = options.ascending === false ? -1 : 1;
      rows = [...rows].sort((a, b) => dir * (String(a[column] ?? "") < String(b[column] ?? "") ? -1 : String(a[column] ?? "") > String(b[column] ?? "") ? 1 : 0));
    }
    const limit = op("limit")?.[1][0];
    if (typeof limit === "number") rows = rows.slice(0, limit);
    if (mode === "many") rows = rows.slice(0, rowCap);
    // Embedded comments (select 'id, task_comments(...)'): one statement, like PostgREST.
    if (table === "tasks" && String(op("select")?.[1][0] ?? "").includes("task_comments(")) {
      return finish(rows.map((r) => ({ id: r.id, task_comments: (state.task_comments || []).filter((c) => c.task_id === r.id).map((c) => ({ ...c })) })));
    }
    return finish(rows.map(withRelations));
  }

  // Model of apply_task_date_cascade (061): root re-check, CAS per move, FamCal
  // eligibility in scope 'famcal', comment choice, log rows.
  function applyCascade(args) {
    const root = state.tasks.find((r) => r.id === args.p_root_task_id && r.user_id === args.p_user_id);
    const rootVisible = Boolean(root && famcalEligible(root));
    const rootCascades = root && root.status !== "Done" && !root.is_recurring_template && !root.recurring_template_id;
    const nameOk = Boolean(args.p_root_was_visible) && rootVisible && root.title === args.p_root_title;
    if (!rootCascades || (args.p_scope === "famcal" && !rootVisible) || Date.parse(root.due_at) !== Date.parse(args.p_root_new_due_at)) {
      return { status: "superseded", cascade_id: null, moved: [], skipped: [], project_flags: [] };
    }
    const cascadeId = `cascade-${state.task_date_cascades.length + 1}`;
    const moved = [];
    const skipped = [];
    for (const move of [...args.p_moves].sort((a, b) => (a.task_id < b.task_id ? -1 : 1))) {
      const target = state.tasks.find((r) => r.id === move.task_id && r.user_id === args.p_user_id);
      const ok = target
        && Date.parse(target.due_at) === Date.parse(move.old_due_at)
        && ["Backlog", "Planned", "In Progress", "Blocked/Waiting"].includes(target.status)
        && !target.is_recurring_template && !target.recurring_template_id
        && (args.p_scope !== "famcal" || famcalEligible(target));
      if (!ok) {
        skipped.push({ task_id: move.task_id, reason: "changed" });
        continue;
      }
      target.due_at = move.new_due_at;
      if (!("base_priority" in move) || target.base_priority === move.base_priority) target.priority_score = move.priority_score;
      const content = famcalEligible(target) && !nameOk ? move.comment_redacted : move.comment;
      state.task_comments.push({ id: `cc-${state.task_comments.length + 1}`, task_id: target.id, user_id: args.p_user_id, content, source: "system" });
      state.task_date_cascade_moves.push({ cascade_id: cascadeId, task_id: target.id, old_due_at: move.old_due_at, new_due_at: move.new_due_at });
      moved.push({ task_id: target.id, old_due_at: move.old_due_at, new_due_at: move.new_due_at, project_id: target.project_id });
    }
    if (moved.length) state.task_date_cascades.push({ id: cascadeId, root_task_id: root.id, scope: args.p_scope, mode: args.p_mode, source: args.p_source });
    return { status: moved.length ? "moved" : "nothing_moved", cascade_id: moved.length ? cascadeId : null, moved, skipped, project_flags: [] };
  }

  const client = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      log.push({ table: `rpc:${name}`, ops: [["rpc", [args]]] });
      if (name === "apply_task_date_cascade") {
        if (rpcFails) return { data: null, error: rpcFails };
        return { data: applyCascade(args), error: null };
      }
      if (name === "famcal_add_personal_task_comment") {
        const target = state.tasks.find((r) => r.id === args.p_task_id);
        if (!target || !famcalEligible(target)) return { data: [], error: null };
        const comment = { id: `fc-${state.task_comments.length + 1}`, task_id: target.id, user_id: args.p_user_id, content: args.p_content, source: args.p_source };
        state.task_comments.push(comment);
        return { data: [comment], error: null };
      }
      return { data: null, error: { code: "PGRST202", message: "no such function" } };
    },
    from(table) {
      const ops = [];
      log.push({ table, ops });
      const proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            const result = run(table, ops);
            if (hook) hook({ table, ops, state });
            return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          }
          return (...args) => {
            ops.push([prop, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  return { client, state, log, rpcCalls };
}

function routeRequest(db, authSource, method, urlPath, body) {
  const request = new NextRequest(`http://localhost${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return writeInternalAuthContext(request, { supabase: db.client, user: { id: API_USER_ID }, userId: API_USER_ID, authSource });
}
const params = (value) => ({ params: Promise.resolve({ id: value }) });
async function patch(db, taskId, body, authSource = "legacy_api_key") {
  const response = await taskRoute.PATCH(routeRequest(db, authSource, "PATCH", `/api/tasks/${taskId}`, body), params(taskId));
  return { status: response.status, body: await response.json() };
}
const dueOf = (db, taskId) => db.state.tasks.find((r) => r.id === taskId).due_at;
const commentsOn = (db, taskId) => db.state.task_comments.filter((c) => c.task_id === taskId).map((c) => c.content);
const ONCORE_IDS = ONCORE.map((_, index) => tid(100 + index));

// ── 4. PATCH integration ───────────────────────────────────────────────────
await test("PATCH (MCP key) moves the OnCore chain: reply lists every move with old and new dates, mode and gap", async () => {
  const db = makeDb();
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22") });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, ONCORE_IDS[0]);
  assert.equal(result.body.cascade.status, "moved");
  assert.equal(result.body.cascade.mode, "same_gap");
  assert.equal(result.body.cascade.delta_workdays, 2);
  assert.equal(result.body.cascade.moves.length, 6);
  assert.deepEqual(result.body.cascade.moves[0], { task_id: ONCORE_IDS[1], title: "MCA review", old_due_at: etAt("2026-10-21"), new_due_at: etAt("2026-10-23") });
  assert.match(result.body.cascade.message, /Moved 6 later tasks by 2 working days \(same gap\)/);
  assert.equal(etDate(dueOf(db, ONCORE_IDS[6])), "2026-10-30");
  assert.equal(commentsOn(db, ONCORE_IDS[6])[0], 'Due date moved from Wed 10/28 to Fri 10/30 because "Calendar build" slipped 2 working days.');
  const call = db.rpcCalls.find((c) => c.name === "apply_task_date_cascade");
  assert.equal(call.args.p_scope, "all");
  assert.equal(call.args.p_source, "legacy_api_key");
  assert.equal(call.args.p_root_new_due_at, dueOf(db, ONCORE_IDS[0]));
  // Moved tasks get their priority recomputed (due-date proximity boost).
  for (const move of call.args.p_moves) assert.equal(typeof move.priority_score, "number");
});

await test("PATCH cascade:'preview' writes nothing and returns what would move (and the project past its target)", async () => {
  const db = makeDb();
  const before = JSON.stringify(db.state.tasks);
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22"), cascade: "preview" });
  assert.equal(result.status, 200);
  assert.equal(result.body.preview, true);
  assert.equal(result.body.cascade.status, "preview");
  assert.equal(result.body.cascade.moves.length, 6);
  assert.deepEqual(result.body.cascade.project_flags.map((flag) => [flag.name, flag.rag_after]), [["OnCore Workflow Testing", "Yellow"]]);
  assert.equal(JSON.stringify(db.state.tasks), before);
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.log.some((entry) => entry.ops.some(([name]) => name === "update" || name === "insert")), false);
});

await test("PATCH cascade:'preview' of a move that wouldn't cascade (earlier, cleared) still saves nothing", async () => {
  for (const due of [etAt("2026-10-19"), null]) {
    const db = makeDb();
    const before = JSON.stringify(db.state.tasks);
    const result = await patch(db, ONCORE_IDS[0], { due_at: due, cascade: "preview", title: "Renamed in a preview" });
    assert.equal(result.status, 200);
    assert.equal(result.body.preview, true);
    assert.equal(result.body.cascade.status, "preview");
    assert.equal(JSON.stringify(db.state.tasks), before);
    assert.equal(db.log.some((entry) => entry.ops.some(([name]) => name === "update" || name === "insert")), false);
  }
});

await test("PATCH cascade:false moves only this task (no link read, no function call)", async () => {
  const db = makeDb();
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22"), cascade: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.cascade.status, "off");
  assert.equal(etDate(dueOf(db, ONCORE_IDS[1])), "2026-10-21");
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.log.some((entry) => entry.table === "task_dependencies"), false);
});

await test("PATCH cascade_mode only_collisions: only the task that would be due before the moved one moves", async () => {
  const db = makeDb();
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22"), cascade_mode: "only_collisions" });
  assert.equal(result.body.cascade.mode, "only_collisions");
  assert.deepEqual(result.body.cascade.moves.map((move) => [move.title, etDate(move.new_due_at)]), [["MCA review", "2026-10-22"]]);
  assert.equal(etDate(dueOf(db, ONCORE_IDS[2])), "2026-10-22");
});

await test("PATCH moving a date earlier or clearing it never moves others", async () => {
  for (const due of [etAt("2026-10-19"), null]) {
    const db = makeDb();
    const result = await patch(db, ONCORE_IDS[0], { due_at: due });
    assert.equal(result.status, 200);
    assert.equal(result.body.cascade.status, "not_applicable");
    assert.equal(db.rpcCalls.length, 0);
  }
});

await test("PATCH that changes no due date carries no cascade key and reads no links", async () => {
  const db = makeDb();
  const result = await patch(db, ONCORE_IDS[0], { title: "Calendar build v2" });
  assert.equal(result.status, 200);
  assert.equal("cascade" in result.body, false);
  assert.equal(db.log.some((entry) => entry.table === "task_dependencies"), false);
});

function bigFan(count) {
  const state = seed();
  for (let index = 0; index < count; index += 1) {
    const waiting = tid(2000 + index);
    state.tasks.push(task(waiting, `Fan ${index}`, { due_at: etAt("2026-10-23") }));
    state.task_dependencies.push(dep(`fan-${String(index).padStart(4, "0")}`, waiting, T.workRoot));
  }
  return state;
}

await test("More than 25 moves: 409 with the preview and nothing saved; cascade_confirm:true moves them", async () => {
  const db = makeDb({ state: bigFan(30) });
  const refused = await patch(db, T.workRoot, { due_at: etAt("2026-10-22") });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.cascade.status, "needs_confirm");
  assert.equal(refused.body.cascade.moves.length, 32);
  assert.match(refused.body.error, /more than 25.*cascade_confirm: true/);
  assert.equal(etDate(dueOf(db, T.workRoot)), "2026-10-20");
  assert.equal(db.rpcCalls.length, 0);

  const confirmed = await patch(db, T.workRoot, { due_at: etAt("2026-10-22"), cascade_confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.cascade.moves.length, 32);
  assert.equal(etDate(dueOf(db, tid(2000))), "2026-10-27");
});

await test("Too many linked tasks (past the 500-task walk limit): refused even with cascade_confirm, nothing saved", async () => {
  const db = makeDb({ state: bigFan(501) });
  const refused = await patch(db, T.workRoot, { due_at: etAt("2026-10-22"), cascade_confirm: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.cascade.status, "too_large");
  assert.equal(etDate(dueOf(db, T.workRoot)), "2026-10-20");
});

await test("Links past the 1,000-row page cap are all read (keyset paging), at a server cap of 100 too", async () => {
  const db = makeDb({ state: bigFan(450), rowCap: 100 });
  const result = await patch(db, T.workRoot, { due_at: etAt("2026-10-22"), cascade: "preview" });
  assert.equal(result.body.cascade.moves.length, 452);
});

await test("The two-statement seam: the function fails after the task saved → 200, cascade failed, a system comment on the task", async () => {
  const db = makeDb({ rpcFails: { code: "55P03", message: "lock timeout" } });
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22") });
  assert.equal(result.status, 200);
  assert.equal(etDate(result.body.due_at), "2026-10-22");
  assert.equal(result.body.cascade.status, "failed");
  // S2: the database text stays in the server log; the reply says only "busy" (or "error").
  assert.equal(result.body.cascade.reason, "busy");
  assert.equal(JSON.stringify(result.body).includes("lock timeout"), false);
  assert.match(result.body.cascade.message, /Baseline was busy/);
  assert.equal(etDate(dueOf(db, ONCORE_IDS[1])), "2026-10-21");
  assert.deepEqual(commentsOn(db, ONCORE_IDS[0]), [cascade.cascadeRootNotice("failed")]);
  assert.equal(db.state.task_comments.find((c) => c.task_id === ONCORE_IDS[0]).source, "system");
});

await test("Concurrent edit: a later task changed after planning is skipped (compare-and-set), not overwritten", async () => {
  // Someone moves "MCA review" right after the planner read it.
  let fired = false;
  const db = makeDb({
    hook: ({ table, ops, state }) => {
      if (!fired && table === "tasks" && ops.some(([name, args]) => name === "in" && args[1].includes(ONCORE_IDS[1]))) {
        fired = true;
        state.tasks.find((r) => r.id === ONCORE_IDS[1]).due_at = etAt("2026-10-29", "08:00");
      }
    },
  });
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22") });
  assert.equal(result.body.cascade.status, "moved");
  assert.equal(dueOf(db, ONCORE_IDS[1]), etAt("2026-10-29", "08:00"));
  assert.deepEqual(result.body.cascade.skipped.map((skip) => [skip.title, skip.reason]), [["MCA review", "changed"]]);
  assert.match(result.body.cascade.message, /1 task changed meanwhile/);
});

await test("A Done task's own date move never cascades; a recurring task's neither", async () => {
  const db = makeDb();
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22"), status: "Done" });
  assert.equal(result.body.cascade.reason, "done");
  const recurring = makeDb();
  recurring.state.tasks.find((r) => r.id === ONCORE_IDS[0]).recurring_template_id = tid(999);
  assert.equal((await patch(recurring, ONCORE_IDS[0], { due_at: etAt("2026-10-22") })).body.cascade.reason, "recurring");
});

await test("Bad cascade options are a 400 and save nothing", async () => {
  const db = makeDb();
  for (const body of [{ due_at: etAt("2026-10-22"), cascade: "maybe" }, { due_at: etAt("2026-10-22"), cascade_mode: "everything" }, { title: "x", cascade: "preview" }]) {
    const result = await patch(db, ONCORE_IDS[0], body);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal(etDate(dueOf(db, ONCORE_IDS[0])), "2026-10-20");
});

// ── 5. FamCal both ways ────────────────────────────────────────────────────
const SECRET = ["Secret work follow-on", "Secret work milestone", T.workWaiter, T.workRoot, "Work follow-up", T.workDep];

await test("FamCal moves a personal task: its personal follower moves; the work task waiting on it (and anything behind that) never does", async () => {
  const db = makeDb();
  const result = await patch(db, T.license, { due_at: etAt("2026-10-22") }, "famcal_api_key");
  assert.equal(result.status, 200);
  assert.equal(etDate(dueOf(db, T.voter)), "2026-10-26");
  assert.equal(etDate(dueOf(db, T.workWaiter)), "2026-10-23");
  assert.equal(etDate(dueOf(db, T.personalBehindWork)), "2026-10-26");
  const call = db.rpcCalls.find((c) => c.name === "apply_task_date_cascade");
  assert.equal(call.args.p_scope, "famcal");
  assert.equal(call.args.p_source, "famcal_api_key");
  assert.deepEqual(call.args.p_moves.map((move) => move.task_id), [T.voter]);
  // The task read behind the walk carries the FamCal filter in the same query.
  const taskReads = db.log.filter((entry) => entry.table === "tasks" && entry.ops.some(([name, args]) => name === "in" && args[0] === "id"));
  assert.ok(taskReads.length > 0);
  for (const entry of taskReads) {
    assert.ok(entry.ops.some(([name, args]) => name === "eq" && args[0] === "famcal_eligible" && args[1] === true), "famcal_eligible filter");
    assert.ok(entry.ops.some(([name, args]) => name === "contains" && args[1].includes("personal")), "personal tag filter");
  }
});

await test("FamCal reply is still exactly projectTaskForFamcal (no cascade key, nothing about other tasks)", async () => {
  const db = makeDb();
  const result = await patch(db, T.license, { due_at: etAt("2026-10-22") }, "famcal_api_key");
  const expected = famcal.projectTaskForFamcal({ ...db.state.tasks.find((r) => r.id === T.license), project: null, implementation: null, sprint: null, section: null });
  assert.deepEqual(Object.keys(result.body).sort(), Object.keys(expected).sort());
  assert.equal("cascade" in result.body, false);
  const text = JSON.stringify(result.body);
  for (const secret of [...SECRET, "Voter registration"]) assert.equal(text.includes(secret), false, secret);
});

await test("FamCal can't send cascade options: still a 400 from its body allowlist", async () => {
  const db = makeDb();
  for (const body of [{ due_at: etAt("2026-10-22"), cascade: false }, { due_at: etAt("2026-10-22"), cascade_mode: "only_collisions" }]) {
    const result = await patch(db, T.license, body, "famcal_api_key");
    assert.equal(result.status, 400);
  }
  assert.equal(etDate(dueOf(db, T.license)), "2026-10-20");
});

await test("Brent moves a WORK task (MCP key): the personal task after it moves with a comment that never names the work task", async () => {
  const db = makeDb();
  const result = await patch(db, T.workRoot, { due_at: etAt("2026-10-22") });
  assert.equal(result.body.cascade.moves.length, 2);
  assert.equal(etDate(dueOf(db, T.personalDep)), "2026-10-23");
  assert.deepEqual(commentsOn(db, T.personalDep), ["Due date moved from Wed 10/21 to Fri 10/23 because a task it depends on moved later."]);
  assert.deepEqual(commentsOn(db, T.workDep), ['Due date moved from Wed 10/21 to Fri 10/23 because "Secret work milestone" slipped 2 working days.']);
  // And FamCal reading that personal task's comments sees no work title.
  const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
  const response = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${T.personalDep}/comments`), params(T.personalDep));
  const text = JSON.stringify(await response.json());
  assert.equal(response.status, 200);
  assert.match(text, /a task it depends on/);
  for (const secret of SECRET) assert.equal(text.includes(secret), false, secret);
});

await test("FamCal over the 25-move cap: only its task moves, a plain comment on it says why, the reply is unchanged", async () => {
  const state = seed();
  for (let index = 0; index < 26; index += 1) {
    const waiting = tid(3000 + index);
    state.tasks.push(task(waiting, `Errand ${index}`, { tags: ["personal"], due_at: etAt("2026-10-23") }));
    state.task_dependencies.push(dep(`er-${String(index).padStart(3, "0")}`, waiting, T.license));
  }
  const db = makeDb({ state });
  const result = await patch(db, T.license, { due_at: etAt("2026-10-22") }, "famcal_api_key");
  assert.equal(result.status, 200);
  assert.equal("cascade" in result.body, false);
  assert.equal(etDate(dueOf(db, T.license)), "2026-10-22");
  assert.equal(etDate(dueOf(db, tid(3000))), "2026-10-23");
  assert.equal(db.rpcCalls.some((c) => c.name === "apply_task_date_cascade"), false);
  assert.deepEqual(commentsOn(db, T.license), [cascade.cascadeRootNotice("too_many")]);
  assert.equal(db.rpcCalls.find((c) => c.name === "famcal_add_personal_task_comment").args.p_source, "system");
});

await test("FamCal cascade failure: the date move stands, the reply is unchanged, the notice goes through the FamCal comment function", async () => {
  const db = makeDb({ rpcFails: { code: "XX000", message: "boom" } });
  const result = await patch(db, T.license, { due_at: etAt("2026-10-22") }, "famcal_api_key");
  assert.equal(result.status, 200);
  assert.equal("cascade" in result.body, false);
  assert.deepEqual(commentsOn(db, T.license), [cascade.cascadeRootNotice("failed")]);
  assert.ok(db.rpcCalls.some((c) => c.name === "famcal_add_personal_task_comment"));
});

// ── 6. Carry list ──────────────────────────────────────────────────────────
await test("Carry: FamCal list and detail agree: an eligible prerequisite keeps its title; a work one is 'Another task'", async () => {
  const db = makeDb();
  const list = await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal"));
  assert.equal(list.status, 200);
  const rows = await list.json();
  const voter = rows.find((r) => r.id === T.voter);
  assert.deepEqual([voter.dependencies[0].title, voter.dependencies[0].depends_on_task_id, voter.dependencies[0].status], ["MA driver's license transfer", T.license, "Planned"]);
  const behind = rows.find((r) => r.id === T.personalBehindWork);
  assert.deepEqual([behind.dependencies[0].title, behind.dependencies[0].depends_on_task_id, behind.dependencies[0].status], ["Another task", null, "Blocked/Waiting"]);
  assert.equal(behind.dependency_blocked, true);

  const detail = await taskRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${T.voter}`), params(T.voter));
  const detailBody = await detail.json();
  assert.equal(detailBody.blocked_by[0].title, voter.dependencies[0].title);
  assert.equal(detailBody.blocked_by[0].id, voter.dependencies[0].depends_on_task_id);
  for (const secret of SECRET) assert.equal(JSON.stringify(rows).includes(secret), false, secret);
});

await test("Carry: FamCal list fields for a linked task come only from the eligibility-filtered read (a re-tag between reads can't leak)", async () => {
  // The unfiltered summary read sees the old personal title; the task turns to
  // work before the filtered read. The list must show the placeholder.
  let flipped = false;
  const db = makeDb({
    hook: ({ table, ops, state }) => {
      if (!flipped && table === "tasks" && ops.some(([name]) => name === "select") && ops.some(([name, args]) => name === "in" && args[1].includes(T.license)) && !ops.some(([name, args]) => name === "eq" && args[0] === "famcal_eligible")) {
        flipped = true;
        const license = state.tasks.find((r) => r.id === T.license);
        license.tags = ["work"];
      }
    },
  });
  const rows = await (await tasksRoute.GET(routeRequest(db, "famcal_api_key", "GET", "/api/tasks?tag=personal"))).json();
  const voter = rows.find((r) => r.id === T.voter);
  assert.ok(flipped);
  assert.equal(voter.dependencies[0].title, "Another task");
  assert.equal(voter.dependencies[0].depends_on_task_id, null);
});

await test("Carry: fetchTaskDependencySummaries reads every link past the row cap and chunks long id lists", async () => {
  const state = seed();
  const waiting = [];
  for (let index = 0; index < 650; index += 1) {
    const waiter = tid(5000 + index);
    waiting.push(waiter);
    state.tasks.push(task(waiter, `W${index}`));
    state.task_dependencies.push(dep(`many-${String(index).padStart(4, "0")}`, waiter, T.workRoot));
    state.task_dependencies.push(dep(`many2-${String(index).padStart(4, "0")}`, waiter, T.workDep));
  }
  const db = makeDb({ state, rowCap: 100 });
  const map = await deps.fetchTaskDependencySummaries(db.client, API_USER_ID, waiting);
  assert.equal([...map.values()].flat().length, 1300);
  assert.equal(map.get(waiting[649]).length, 2);
  assert.equal(map.get(waiting[0]).find((d) => d.depends_on_task_id === T.workRoot).title, "Secret work milestone");
  for (const entry of db.log.filter((e) => e.table === "task_dependencies" || e.table === "tasks")) {
    for (const [name, args] of entry.ops) if (name === "in") assert.ok(args[1].length <= 100);
  }
});

await test("Carry: the database loop guard (061, SQLSTATE MC061) is a plain 400 from the add route, not a 500", async () => {
  const db = makeDb();
  db.state.failInsert = { task_dependencies: { code: "MC061", message: "That link would make a loop" } };
  const response = await dependenciesRoute.POST(
    routeRequest(db, "legacy_api_key", "POST", `/api/tasks/${T.workDep}/dependencies`, { depends_on_task_id: T.voter }),
    params(T.workDep)
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /would make a loop/);
  db.state.failInsert = { task_dependencies: { code: "55P03", message: "lock timeout" } };
  const busy = await dependenciesRoute.POST(
    routeRequest(db, "legacy_api_key", "POST", `/api/tasks/${T.workDep}/dependencies`, { depends_on_task_id: T.voter }),
    params(T.workDep)
  );
  assert.equal(busy.status, 503);
});

await test("Carry: OAuth remove_task_dependency needs mcp.write (it only marks the link resolved); real deletes still need mcp.delete", () => {
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", T.mca ?? "x", "dependencies", "d1"], "DELETE"), ["mcp.write"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x", "dependencies"], "DELETE"), ["mcp.write"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x"], "DELETE"), ["mcp.delete"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x", "comments"], "DELETE"), ["mcp.delete"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x", "recur"], "DELETE"), ["mcp.write"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x", "dependencies"], "GET"), ["mcp.read"]);
  assert.deepEqual(scopes.getRequiredScopesForPath(["tasks", "x", "dependencies"], "POST"), ["mcp.write"]);
});

async function createTask(db, body) {
  const response = await tasksRoute.POST(routeRequest(db, "legacy_api_key", "POST", "/api/tasks", body));
  return { status: response.status, body: await response.json() };
}

await test("Carry: a failed initial_comment is no longer swallowed: the half-made task is removed and the call says so", async () => {
  const db = makeDb();
  const before = db.state.tasks.length;
  db.state.failInsert = { task_comments: { message: "insert failed" } };
  const result = await createTask(db, { title: "Call the DMV", initial_comment: "Blocked: need the form" });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /initial_comment could not be saved, so the task was not created/);
  assert.equal(db.state.tasks.length, before);
});

await test("Carry: a failed initial_checklist is the same (task removed, plain error); a clean create still works", async () => {
  const db = makeDb();
  const before = db.state.tasks.length;
  db.state.failInsert = { task_checklist_items: { message: "insert failed" } };
  const result = await createTask(db, { title: "Pack", initial_checklist: ["boxes", "tape"], initial_comment: "start Friday" });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /initial_checklist could not be saved/);
  assert.equal(db.state.tasks.length, before);
  assert.equal(db.state.task_comments.some((c) => c.content === "start Friday"), false);

  db.state.failInsert = null;
  const ok = await createTask(db, { title: "Pack", initial_checklist: ["boxes"], initial_comment: "start Friday" });
  assert.equal(ok.status, 201);
  assert.ok(db.state.task_comments.some((c) => c.content === "start Friday"));
});

await test("Carry: if removing the half-made task also fails, the 500 says so and gives its id", async () => {
  const db = makeDb();
  db.state.failInsert = { task_comments: { message: "insert failed" } };
  const realFrom = db.client.from.bind(db.client);
  db.client.from = (table) => {
    const query = realFrom(table);
    if (table !== "tasks") return query;
    return new Proxy(query, {
      get(target, prop) {
        if (prop === "delete") return () => ({ eq: () => ({ eq: async () => ({ error: { message: "delete failed" } }) }) });
        return target[prop];
      },
    });
  };
  const result = await createTask(db, { title: "Call the DMV", initial_comment: "x" });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /could not be removed/);
  assert.ok(result.body.task_id);
});

// ── 6b. Fix round 1 (Fable ecd121ca, Codex Astra) ─────────────────────────
async function famcalCommentsText(db, taskId) {
  const commentsRoute = await import("../src/app/api/tasks/[id]/comments/route.ts");
  const response = await commentsRoute.GET(routeRequest(db, "famcal_api_key", "GET", `/api/tasks/${taskId}/comments`), params(taskId));
  assert.equal(response.status, 200);
  return JSON.stringify(await response.json());
}

await test("R1 P1-1: rename + re-tag work→personal + later date in ONE PATCH never puts the old work title on a FamCal-readable comment", async () => {
  const db = makeDb();
  const result = await patch(db, T.workRoot, { title: "Personal reminder", tags: ["personal"], due_at: etAt("2026-10-22") });
  assert.equal(result.status, 200);
  const call = db.rpcCalls.find((c) => c.name === "apply_task_date_cascade");
  assert.equal(call.args.p_root_title, "Personal reminder");
  assert.equal(call.args.p_root_was_visible, false);
  for (const move of call.args.p_moves) {
    assert.equal(move.comment.includes("Secret work milestone"), false, "named text uses the saved title");
  }
  const text = await famcalCommentsText(db, T.personalDep);
  assert.equal(text.includes("Secret work milestone"), false);
  // It was work when the plan was made, so the personal follower gets the redacted text.
  assert.match(text, /because a task it depends on moved later/);
});

await test("R1 P1-2 A: a redacted comment says only what changed on that task (no date or gap of the hidden task), both modes", async () => {
  for (const mode of ["only_collisions", "same_gap"]) {
    const db = makeDb();
    const result = await patch(db, T.workRoot, { due_at: etAt("2026-10-22"), cascade_mode: mode });
    assert.equal(result.status, 200);
    const text = await famcalCommentsText(db, T.personalDep);
    assert.equal(text.includes("Secret work milestone"), false, mode);
    assert.doesNotMatch(text, /depends on moved to|slipped|working day/, mode);
    assert.match(text, /because a task it depends on moved later\./, mode);
  }
});

function famcalFan(hiddenCount) {
  const state = seed();
  state.tasks = state.tasks.filter((r) => [T.license, T.voter].includes(r.id));
  state.task_dependencies = [dep("p1", T.voter, T.license)];
  for (let index = 0; index < hiddenCount; index += 1) {
    const hidden = tid(7000 + index);
    state.tasks.push(task(hidden, `Hidden ${index}`, { due_at: etAt("2026-10-22") }));
    state.task_dependencies.push(dep(`h-${String(index).padStart(5, "0")}`, hidden, T.license));
  }
  return state;
}

await test("R1 P1-3: hidden work tasks waiting on a personal task never count toward the limits or change what FamCal sees (0 / 499 / 600)", async () => {
  const outcomes = [];
  for (const hidden of [0, 499, 600]) {
    const db = makeDb({ state: famcalFan(hidden) });
    const result = await patch(db, T.license, { due_at: etAt("2026-10-22") }, "famcal_api_key");
    assert.equal(result.status, 200);
    outcomes.push(JSON.stringify({ body: Object.keys(result.body).sort(), voter: etDate(dueOf(db, T.voter)), license: commentsOn(db, T.license), voterComments: commentsOn(db, T.voter) }));
    // The link read itself is filtered on the waiting task's eligibility in the database.
    const linkReads = db.log.filter((entry) => entry.table === "task_dependencies");
    assert.ok(linkReads.length > 0);
    for (const entry of linkReads) {
      assert.ok(entry.ops.some(([name, args]) => name === "eq" && args[0] === "waiting.famcal_eligible" && args[1] === true), "eligibility in the link read");
      assert.ok(entry.ops.some(([name, args]) => name === "contains" && args[0] === "waiting.tags"), "personal tag in the link read");
    }
    if (hidden) assert.equal(etDate(dueOf(db, tid(7000))), "2026-10-22", "hidden task never moves");
  }
  assert.equal(new Set(outcomes).size, 1, outcomes.join("\n"));
  assert.match(outcomes[0], /"voter":"2026-10-26"/);
});

await test("R1 P2-1: two overlapping PATCHes on one task: the stale one is a 409 (nothing saved), never an extra shift; a retry gives the serial result", async () => {
  const state = seed();
  const db = makeDb({ state });
  const originalFrom = db.client.from;
  let armed = true;
  let signalRead;
  let resume;
  const read = new Promise((resolve) => { signalRead = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  // Pause PATCH A right after it reads the task (before it reads the links).
  db.client.from = (table) => {
    const query = originalFrom(table);
    if (table !== "tasks" || !armed) return query;
    const ops = [];
    const proxy = new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") {
          const capture = armed && ops.some(([name]) => name === "single") && ops.some(([name, args]) => name === "select" && args[0] === "*");
          if (capture) armed = false;
          return (resolve, reject) => {
            let built = query;
            for (const [name, args] of ops) built = built[name](...args);
            return Promise.resolve(built).then(async (result) => {
              if (capture) { signalRead(); await gate; }
              return result;
            }).then(resolve, reject);
          };
        }
        return (...args) => { ops.push([prop, args]); return proxy; };
      },
    });
    return proxy;
  };
  const pending = patch(db, T.license, { due_at: etAt("2026-10-22") });
  await read;
  const intervening = await patch(db, T.license, { due_at: etAt("2026-10-21") });
  assert.equal(intervening.body.cascade.status, "moved");
  assert.equal(etDate(dueOf(db, T.voter)), "2026-10-23");
  resume();
  const stale = await pending;
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed since it was read/);
  assert.equal(etDate(dueOf(db, T.license)), "2026-10-21");
  assert.equal(etDate(dueOf(db, T.voter)), "2026-10-23");
  const retry = await patch(db, T.license, { due_at: etAt("2026-10-22") });
  assert.equal(retry.status, 200);
  assert.equal(etDate(dueOf(db, T.voter)), "2026-10-26");
});

await test("R1 LOW a: a task marked Done between planning and applying moves nothing after it", async () => {
  let changed = false;
  const db = makeDb({
    hook: ({ table, ops, state }) => {
      if (!changed && table === "tasks" && ops.some(([name]) => name === "update")) {
        changed = true;
        state.tasks.find((r) => r.id === ONCORE_IDS[0]).status = "Done";
      }
    },
  });
  const result = await patch(db, ONCORE_IDS[0], { due_at: etAt("2026-10-22") });
  assert.equal(result.status, 200);
  assert.equal(result.body.cascade.status, "superseded");
  assert.equal(etDate(dueOf(db, ONCORE_IDS[1])), "2026-10-21");
});

await test("R1 P2-4 (low): a base-priority edit made after planning is not overwritten by the planned score", async () => {
  let changed = false;
  const db = makeDb({
    hook: ({ table, ops, state }) => {
      if (!changed && table === "tasks" && ops.some(([name]) => name === "update")) {
        changed = true;
        Object.assign(state.tasks.find((r) => r.id === T.voter), { base_priority: 90, priority_score: 90 });
      }
    },
  });
  const result = await patch(db, T.license, { due_at: etAt("2026-10-22") });
  assert.equal(result.body.cascade.status, "moved");
  const voter = db.state.tasks.find((r) => r.id === T.voter);
  assert.equal(etDate(voter.due_at), "2026-10-26");
  assert.equal(voter.priority_score, 90);
  const call = db.rpcCalls.find((c) => c.name === "apply_task_date_cascade");
  assert.equal(call.args.p_moves[0].base_priority, 50);
});

// ── 7. MCP update_task ─────────────────────────────────────────────────────
async function mcpRpc(body) {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mission-control-key": LEGACY_KEY,
      "mcp-session-id": "stateless",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const response = await mcpRoute.POST(request);
  const text = await response.text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "" : text;
  return JSON.parse(payload);
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
await mcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cascade-test", version: "1" } } });

await test("MCP update_task: cascade, cascade_mode and cascade_confirm are in the schema and the description says how to opt out", async () => {
  const result = await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tool = result.result.tools.find((t) => t.name === "update_task");
  for (const key of ["cascade", "cascade_mode", "cascade_confirm"]) assert.ok(key in tool.inputSchema.properties, key);
  assert.deepEqual(tool.inputSchema.properties.cascade_mode.enum, ["same_gap", "only_collisions"]);
  assert.match(tool.description, /cascade:false to move only this task/);
  assert.match(tool.description, /preview/);
  assert.doesNotMatch(tool.description, /claude|anthropic/i);
});

await test("MCP update_task passes the cascade options through and a 409 refusal comes back as an error with the preview", async () => {
  mcpCalls.length = 0;
  mcpResponder = () => json({ error: "This would also move 30 later tasks", cascade: { status: "needs_confirm", moves: [] } }, 409);
  const result = await mcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_task", arguments: { task_id: T.workRoot, due_at: etAt("2026-10-22"), cascade: "preview", cascade_mode: "only_collisions", cascade_confirm: false } } });
  assert.equal(mcpCalls[0].method, "PATCH");
  assert.deepEqual(mcpCalls[0].body, { due_at: etAt("2026-10-22"), cascade: "preview", cascade_mode: "only_collisions", cascade_confirm: false });
  assert.equal(result.result.isError, true);
  assert.equal(JSON.parse(result.result.content[0].text).data.cascade.status, "needs_confirm");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
