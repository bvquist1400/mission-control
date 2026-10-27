#!/usr/bin/env node
// Pure tests for "Pick a date..." on brief cards (Baseline task 57224ad9,
// migration 064): Accept takes any date on/after the brief date; carry items
// Move to a picked day; Undo puts each task's previous due date back (including
// "no due date"); repeats are safe; the ET end-of-day rule holds across the
// Nov 1 DST change.
//
// No database. The service runs against an in-memory stand-in for Supabase whose
// brief_item_transition mirrors 064's SQL (compare-and-set on the item's state,
// the saved snapshot, the expect_due_at refusal). The real function is checked
// by test-briefs-pick-date-db.mjs against a local stack.
//
// Every test runs even if an earlier one fails, so a run on the old code shows
// each missing behaviour separately.

import assert from "node:assert/strict";

async function load(path) {
  try {
    return await import(path);
  } catch (error) {
    return { __missing: String(error.message).split("\n")[0] };
  }
}

const due = await load("../src/lib/briefs/due.ts");
const validate = await load("../src/lib/briefs/validate.ts");
const service = await load("../src/lib/briefs/service.ts");

function need(mod, ...names) {
  if (mod.__missing) assert.fail(`module missing: ${mod.__missing}`);
  for (const name of names) assert.equal(typeof mod[name], "function", `${name} is not exported`);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${String(error.message).split("\n").join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory stand-in for the parts of Supabase the brief service touches
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";
const BRIEF_ID = "22222222-2222-4222-8222-222222222222";
const T = (n) => `00000000-0000-4000-8000-00000000000${n}`;

function makeWorld({ briefDate = "2026-10-27" } = {}) {
  const world = {
    brief: { id: BRIEF_ID, user_id: USER, edition: "eod", brief_date: briefDate, code: "EOD-1027", content: {}, covered_meeting_ids: [], created_at: "2026-10-27T20:15:00Z", updated_at: "2026-10-27T20:15:00Z" },
    items: [],
    tasks: new Map(),
    inserted: [],
    rpcCalls: [],
  };
  return world;
}

function addTask(world, n, patch = {}) {
  const task = {
    id: T(n),
    user_id: USER,
    title: `Task ${n}`,
    status: "Backlog",
    due_at: null,
    base_priority: 50,
    priority_score: 50,
    stakeholder_mentions: [],
    ...patch,
  };
  world.tasks.set(task.id, task);
  return task;
}

function addItem(world, n, kind, taskIds, patch = {}) {
  const item = {
    id: `33333333-3333-4333-8333-33333333333${n}`,
    user_id: USER,
    brief_id: BRIEF_ID,
    n,
    item_key: `key-${n}`,
    kind,
    payload: { title: `Item ${n}`, ...(patch.payload ?? {}) },
    task_ids: taskIds,
    source: { meetings: [] },
    state: "open",
    dismissed_reason: null,
    dismissed_note: null,
    choice: null,
    created_task_id: null,
    prior_due: null,
    acted_at: null,
    created_at: "2026-10-27T20:15:00Z",
    updated_at: "2026-10-27T20:15:00Z",
    ...patch,
  };
  item.payload = { title: `Item ${n}`, ...(patch.payload ?? {}) };
  world.items.push(item);
  return item;
}

const isoOf = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

function transition(world, args) {
  const item = world.items.find((entry) => entry.id === args.p_item_id && entry.user_id === args.p_user_id);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.state !== args.p_expected_state) return { ok: false, reason: "conflict", state: item.state, created_task_id: item.created_task_id, choice: item.choice };

  // Work on copies so a raised error leaves nothing behind (one transaction).
  const staged = new Map();
  let snapshot = [];
  let createdTaskId = null;
  let inserted = false;

  if (args.p_task) {
    createdTaskId = `99999999-9999-4999-8999-99999999999${world.inserted.length + 1}`;
    world.inserted.push({ id: createdTaskId, ...args.p_task });
    inserted = true;
  }

  if (args.p_task_updates) {
    const updated = [];
    for (const update of args.p_task_updates) {
      if (!item.task_ids.includes(update.id)) throw { code: "22023", message: "task is not part of this item" };
      const task = world.tasks.get(update.id);
      if (!task) throw { code: "P0002", message: "task no longer exists" };
      const next = { ...(staged.get(update.id) ?? task) };
      if ("due_at" in update) {
        if ("expect_due_at" in update && isoOf(next.due_at) !== isoOf(update.expect_due_at)) {
          throw { code: "MC064", message: "task has a different due date than the move set; refusing to overwrite it" };
        }
        snapshot.push({ id: update.id, due_at: isoOf(next.due_at), applied_due_at: isoOf(update.due_at) });
        next.due_at = update.due_at === null ? null : update.due_at;
      }
      if ("status" in update) next.status = update.status;
      if ("priority_score" in update) next.priority_score = Math.round(update.priority_score);
      staged.set(update.id, next);
      updated.push(update.id);
    }
    if (item.task_ids.some((id) => !updated.includes(id))) throw { code: "22023", message: "every task of the item must be updated together" };
  }

  for (const [id, task] of staged) world.tasks.set(id, task);
  item.state = args.p_state;
  if ("acted_at" in args.p_fields) item.acted_at = args.p_fields.acted_at;
  if (args.p_state === "open") item.prior_due = null;
  else if (args.p_state === "deferred" && snapshot.length) item.prior_due = snapshot;
  item.updated_at = new Date().toISOString();
  return { ok: true, state: args.p_state, created_task_id: createdTaskId ?? item.created_task_id, task_inserted: inserted };
}

function query(world, table) {
  const filters = [];
  let selected = null;
  const builder = {
    select(columns) {
      selected = columns;
      return builder;
    },
    eq(column, value) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column, values) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      const rows = rowsFor();
      return { data: rows[0] ?? null, error: null };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: rowsFor(), error: null }).then(resolve, reject);
    },
  };
  function rowsFor() {
    const source =
      table === "briefs" ? [world.brief] : table === "brief_items" ? world.items : table === "tasks" ? [...world.tasks.values()] : [];
    return source.filter((row) => filters.every((filter) => filter(row))).map((row) => ({ ...row }));
  }
  void selected;
  return builder;
}

function fakeSupabase(world) {
  return {
    from: (table) => query(world, table),
    async rpc(name, args) {
      assert.equal(name, "brief_item_transition");
      world.rpcCalls.push(args);
      try {
        return { data: transition(world, args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

function actions(list) {
  need(validate, "parseBriefActions");
  const parsed = validate.parseBriefActions(list);
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  return parsed.value;
}

async function act(world, list, now = new Date("2026-10-27T20:30:00Z")) {
  need(service, "actOnBriefItems");
  return service.actOnBriefItems(fakeSupabase(world), USER, "EOD-1027", actions(list), { now });
}

async function rejects(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected a rejection");
}

// ---------------------------------------------------------------------------
// Pure date rules
// ---------------------------------------------------------------------------

await test("pickedDateProblem: real dates on/after the brief date pass; past, impossible and loose dates are refused", () => {
  need(due, "pickedDateProblem");
  assert.equal(due.pickedDateProblem("2026-10-27", "2026-10-27"), null);
  assert.equal(due.pickedDateProblem("2026-11-04", "2026-10-27"), null);
  assert.equal(due.pickedDateProblem("2031-01-01", "2026-10-27"), null);
  assert.match(due.pickedDateProblem("2026-10-26", "2026-10-27"), /before the brief's date \(2026-10-27\)/);
  for (const bad of ["2026-02-30", "2026-13-01", "2026-9-30", " 2026-11-04", "2026-11-04T10:00:00Z", "11/4", "", null, undefined, 20261104]) {
    assert.ok(due.pickedDateProblem(bad, "2026-10-27"), `${JSON.stringify(bad)} should be refused`);
  }
});

await test("resolvePickedDueAt: the end of the picked ET day, either side of the Nov 1 2026 DST change", () => {
  need(due, "resolvePickedDueAt");
  assert.equal(due.resolvePickedDueAt("2026-10-30", "2026-10-27"), "2026-10-31T03:59:59.999Z"); // EDT -4
  assert.equal(due.resolvePickedDueAt("2026-10-31", "2026-10-27"), "2026-11-01T03:59:59.999Z"); // EDT, the night before the change
  assert.equal(due.resolvePickedDueAt("2026-11-01", "2026-10-27"), "2026-11-02T04:59:59.999Z"); // the changeover Sunday ends in EST -5
  assert.equal(due.resolvePickedDueAt("2026-11-04", "2026-10-27"), "2026-11-05T04:59:59.999Z"); // EST
  assert.throws(() => due.resolvePickedDueAt("2026-10-26", "2026-10-27"), /before the brief's date/);
});

await test("a picked date resolves exactly like the same day written as an Accept choice", () => {
  need(due, "resolvePickedDueAt", "resolveAcceptDueAt");
  for (const date of ["2026-10-27", "2026-10-31", "2026-11-01", "2026-11-09"]) {
    assert.equal(due.resolvePickedDueAt(date, "2026-10-27"), due.resolveAcceptDueAt(date, "2026-10-27", new Date("2026-10-27T20:00:00Z")));
  }
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

await test("move needs a real date; date belongs to move only", () => {
  need(validate, "parseBriefActions");
  const ok = validate.parseBriefActions([{ n: 3, action: "move", date: "2026-11-04" }]);
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  assert.equal(ok.value[0].date, "2026-11-04");
  assert.equal(validate.parseBriefActions([{ n: 3, action: "move" }]).ok, false);
  for (const bad of ["2026-02-30", "11/4", "tomorrow", "", null, 20261104]) {
    const parsed = validate.parseBriefActions([{ n: 3, action: "move", date: bad }]);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.match(parsed.errors.join(" "), /date must be a real date written YYYY-MM-DD/);
  }
  const stray = validate.parseBriefActions([{ n: 3, action: "tomorrow", date: "2026-11-04" }]);
  assert.equal(stray.ok, false);
  assert.match(stray.errors.join(" "), /date only applies to move/);
  assert.equal(validate.parseBriefActions([{ n: 3, action: "undo" }]).ok, true);
});

await test("accept still takes a notes date, a preset or any other YYYY-MM-DD at parse time", () => {
  need(validate, "parseBriefActions");
  for (const value of ["today", "none", "2026-10-12", "2027-03-01"]) {
    assert.equal(validate.parseBriefActions([{ n: 1, action: "accept", due: value }]).ok, true, value);
  }
  assert.equal(validate.parseBriefActions([{ n: 1, action: "accept", due: "2026-02-30" }]).ok, false);
});

// ---------------------------------------------------------------------------
// Accept with a picked date
// ---------------------------------------------------------------------------

function proposalWorld(extra = {}) {
  const world = makeWorld();
  addItem(world, 1, "proposed_task", [], {
    payload: { title: "Send updated workbook", suggested_due: "2026-10-29", ...extra },
    source: { meetings: [{ id: "m1", title: "Study team sync", start: null, url: null, lines: ["Send updated workbook"] }] },
  });
  return world;
}

await test("accept with a date that is not the notes' date creates the task due the end of that ET day", async () => {
  const world = proposalWorld();
  const { results } = await act(world, [{ n: 1, action: "accept", due: "2026-11-03" }]);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.equal(world.inserted.length, 1);
  assert.equal(world.inserted[0].due_at, "2026-11-04T04:59:59.999Z"); // EST: after the Nov 1 change
  assert.equal(results[0].due_at, "2026-11-04T04:59:59.999Z");
});

await test("accept on a date across the DST change: Fri 10/30 ends in EDT, Mon 11/2 in EST", async () => {
  const world = proposalWorld();
  addItem(world, 2, "proposed_task", [], { payload: { title: "Second" }, source: { meetings: [{ id: "m1", title: "x", start: null, url: null, lines: ["Second"] }] } });
  await act(world, [{ n: 1, action: "accept", due: "2026-10-30" }, { n: 2, action: "accept", due: "2026-11-02" }]);
  assert.deepEqual(world.inserted.map((task) => task.due_at), ["2026-10-31T03:59:59.999Z", "2026-11-03T04:59:59.999Z"]);
});

await test("accept: the brief's own date is allowed; a past date is refused with a clear message and nothing is created", async () => {
  const world = proposalWorld();
  const { results } = await act(world, [{ n: 1, action: "accept", due: "2026-10-27" }]);
  assert.equal(results[0].ok, true);
  const refused = proposalWorld();
  const error = await rejects(act(refused, [{ n: 1, action: "accept", due: "2026-10-26" }]), 400, /#1: 2026-10-26 is before the brief's date \(2026-10-27\)/);
  assert.ok(error);
  assert.equal(refused.inserted.length, 0);
  assert.equal(refused.rpcCalls.length, 0);
});

await test("accept: one bad date refuses the whole call (validate everything before acting)", async () => {
  const world = proposalWorld();
  addItem(world, 2, "proposed_task", [], { payload: { title: "Second" } });
  await rejects(act(world, [{ n: 1, action: "accept", due: "2026-11-03" }, { n: 2, action: "accept", due: "2026-10-01" }]), 400, /#2/);
  assert.equal(world.inserted.length, 0);
});

await test("accept still takes the notes' date and the presets", async () => {
  const world = proposalWorld();
  addItem(world, 2, "proposed_task", [], { payload: { title: "Second" } });
  const { results } = await act(world, [{ n: 1, action: "accept", due: "2026-10-29" }, { n: 2, action: "accept", due: "none" }]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(world.inserted[0].due_at, "2026-10-30T03:59:59.999Z");
  assert.equal(world.inserted[1].due_at, null);
});

// ---------------------------------------------------------------------------
// Move: single carry-over and carry group
// ---------------------------------------------------------------------------

function carryWorld() {
  const world = makeWorld();
  addTask(world, 1, { due_at: "2026-10-27T03:59:59.999Z" }); // was due Mon 10/26, still open
  addTask(world, 2, { due_at: null }); // no due date at all
  addTask(world, 3, { due_at: "2026-10-28T03:59:59.999Z" });
  addTask(world, 4, { due_at: "2026-10-29T03:59:59.999Z" });
  addItem(world, 1, "carry_over", [T(1)]);
  addItem(world, 2, "carry_over", [T(2)]);
  addItem(world, 3, "carry_group", [T(3), T(4)]);
  addItem(world, 4, "carry_over", [T(1)], { item_key: "other" });
  return world;
}

const dueOf = (world, n) => world.tasks.get(T(n)).due_at;
const itemOf = (world, n) => world.items.find((entry) => entry.n === n);

await test("move a single carry-over: the task is due the end of the picked ET day and the item is deferred", async () => {
  const world = carryWorld();
  const { results, counts } = await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  assert.deepEqual({ ok: results[0].ok, state: results[0].state, due_at: results[0].due_at }, { ok: true, state: "deferred", due_at: "2026-11-05T04:59:59.999Z" });
  assert.equal(dueOf(world, 1), "2026-11-05T04:59:59.999Z");
  assert.equal(itemOf(world, 1).state, "deferred");
  assert.ok(counts.open < 4);
});

await test("move across the DST change: Sat 10/31 and Sun 11/1 end at the right UTC instant", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-10-31" }, { n: 2, action: "move", date: "2026-11-01" }]);
  assert.equal(dueOf(world, 1), "2026-11-01T03:59:59.999Z");
  assert.equal(dueOf(world, 2), "2026-11-02T04:59:59.999Z");
});

await test("move a carry group: every task goes to the one picked date, in one write", async () => {
  const world = carryWorld();
  const { results } = await act(world, [{ n: 3, action: "move", date: "2026-11-09" }]);
  assert.equal(results[0].ok, true);
  assert.equal(dueOf(world, 3), "2026-11-10T04:59:59.999Z");
  assert.equal(dueOf(world, 4), "2026-11-10T04:59:59.999Z");
  assert.equal(itemOf(world, 3).state, "deferred");
  assert.equal(world.rpcCalls.length, 1, "one transaction");
  assert.equal(world.rpcCalls[0].p_task_updates.length, 2);
});

await test("move writes due_at and priority only, the same shape Tomorrow writes (no status change, no extra fields)", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }, { n: 2, action: "tomorrow" }]);
  const [moveCall, tomorrowCall] = world.rpcCalls;
  assert.deepEqual(Object.keys(moveCall.p_task_updates[0]).sort(), ["due_at", "id", "priority_score"]);
  assert.deepEqual(Object.keys(tomorrowCall.p_task_updates[0]).sort(), Object.keys(moveCall.p_task_updates[0]).sort());
  assert.equal(world.tasks.get(T(1)).status, "Backlog");
});

await test("move: a past date is refused with a clear message, nothing changes, the whole call stops", async () => {
  const world = carryWorld();
  await rejects(act(world, [{ n: 1, action: "move", date: "2026-10-26" }]), 400, /#1: 2026-10-26 is before the brief's date/);
  await rejects(act(world, [{ n: 2, action: "tomorrow" }, { n: 1, action: "move", date: "2026-01-01" }]), 400);
  assert.equal(world.rpcCalls.length, 0);
  assert.equal(itemOf(world, 1).state, "open");
  assert.equal(dueOf(world, 2), null);
});

await test("move applies to carry items only (a proposal or a choice refuses it)", async () => {
  const world = proposalWorld();
  await rejects(act(world, [{ n: 1, action: "move", date: "2026-11-04" }]), 400, /proposed_task; "move" doesn't apply/);
});

await test("move to the brief's own date is allowed", async () => {
  const world = carryWorld();
  const { results } = await act(world, [{ n: 1, action: "move", date: "2026-10-27" }]);
  assert.equal(results[0].ok, true);
  assert.equal(dueOf(world, 1), "2026-10-28T03:59:59.999Z");
});

await test("repeating the same move is a safe no-op; a different day is refused until Undo", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  const calls = world.rpcCalls.length;
  const again = await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  assert.deepEqual({ ok: again.results[0].ok, already: again.results[0].already }, { ok: true, already: true });
  assert.equal(world.rpcCalls.length, calls, "no second write");
  assert.equal(dueOf(world, 1), "2026-11-05T04:59:59.999Z");
  await rejects(act(world, [{ n: 1, action: "move", date: "2026-11-05" }]), 400, /already moved to 2026-11-04; undo it first/);
  assert.equal(dueOf(world, 1), "2026-11-05T04:59:59.999Z");
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

await test("Undo restores the exact previous due date and reopens the card", async () => {
  const world = carryWorld();
  const before = dueOf(world, 1);
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  const { results } = await act(world, [{ n: 1, action: "undo" }]);
  assert.deepEqual({ ok: results[0].ok, state: results[0].state }, { ok: true, state: "open" });
  assert.equal(dueOf(world, 1), before);
  assert.equal(itemOf(world, 1).state, "open");
  assert.equal(itemOf(world, 1).prior_due, null, "the snapshot is cleared once reopened");
});

await test("Undo restores 'no due date' for a task that had none", async () => {
  const world = carryWorld();
  await act(world, [{ n: 2, action: "move", date: "2026-11-04" }]);
  assert.equal(dueOf(world, 2), "2026-11-05T04:59:59.999Z");
  await act(world, [{ n: 2, action: "undo" }]);
  assert.equal(dueOf(world, 2), null);
  assert.equal(itemOf(world, 2).state, "open");
});

await test("Undo works after Tomorrow too (Tomorrow now saves what it replaced)", async () => {
  const world = carryWorld();
  const before = dueOf(world, 1);
  await act(world, [{ n: 1, action: "tomorrow" }]);
  assert.notEqual(dueOf(world, 1), before);
  await act(world, [{ n: 1, action: "undo" }]);
  assert.equal(dueOf(world, 1), before);
});

await test("Undo on a carry group puts every task back, one with no date included", async () => {
  const world = carryWorld();
  addTask(world, 5, { due_at: null });
  const group = addItem(world, 5, "carry_group", [T(3), T(5)], { item_key: "g2" });
  await act(world, [{ n: 5, action: "move", date: "2026-11-09" }]);
  assert.equal(dueOf(world, 5), "2026-11-10T04:59:59.999Z");
  await act(world, [{ n: 5, action: "undo" }]);
  assert.equal(dueOf(world, 3), "2026-10-28T03:59:59.999Z");
  assert.equal(dueOf(world, 5), null);
  assert.equal(group.state, "open");
});

await test("Undo, then Move to another day, then Undo again: still back at the original date", async () => {
  const world = carryWorld();
  const original = dueOf(world, 1);
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  await act(world, [{ n: 1, action: "undo" }]);
  await act(world, [{ n: 1, action: "move", date: "2026-11-09" }]);
  assert.equal(dueOf(world, 1), "2026-11-10T04:59:59.999Z");
  await act(world, [{ n: 1, action: "undo" }]);
  assert.equal(dueOf(world, 1), original);
});

await test("Undo twice: the second is refused (the card is already open), nothing changes", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  await act(world, [{ n: 1, action: "undo" }]);
  const calls = world.rpcCalls.length;
  await rejects(act(world, [{ n: 1, action: "undo" }]), 400, /#1 is open; "undo" isn't possible from there/);
  assert.equal(world.rpcCalls.length, calls);
});

await test("Undo is refused, and changes nothing, when a task's date was edited after the move", async () => {
  const world = carryWorld();
  await act(world, [{ n: 3, action: "move", date: "2026-11-09" }]);
  world.tasks.get(T(4)).due_at = "2026-11-20T04:59:59.999Z"; // edited by hand afterwards
  const { results } = await act(world, [{ n: 3, action: "undo" }]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /#3 can't be undone: a task's due date was changed after the move/);
  assert.equal(itemOf(world, 3).state, "deferred");
  assert.equal(dueOf(world, 3), "2026-11-10T04:59:59.999Z", "the unedited task is not half-restored");
  assert.equal(dueOf(world, 4), "2026-11-20T04:59:59.999Z");
});

await test("Undo on an item deferred before snapshots existed is refused with a plain message", async () => {
  const world = carryWorld();
  itemOf(world, 1).state = "deferred"; // as 055-064 left it: no prior_due
  await rejects(act(world, [{ n: 1, action: "undo" }]), 400, /#1 can't be undone: it was moved before earlier due dates were saved/);
});

await test("a parked or done carry item has no Undo (as today)", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "park" }, { n: 2, action: "done" }]);
  await rejects(act(world, [{ n: 1, action: "undo" }]), 400, /#1 is parked; "undo" isn't possible from there/);
  await rejects(act(world, [{ n: 2, action: "undo" }]), 400, /#2 is done; "undo" isn't possible from there/);
});

await test("a different item on the same task is untouched by Move/Undo of another (task writes stay inside the item)", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  assert.equal(itemOf(world, 4).state, "open");
});

await test("Undo recomputes priority for the restored date (the due-date boost goes away or comes back)", async () => {
  const world = carryWorld();
  world.tasks.get(T(1)).due_at = "2026-10-27T03:59:59.999Z"; // overdue
  const before = world.tasks.get(T(1)).priority_score;
  await act(world, [{ n: 1, action: "move", date: "2026-12-30" }]);
  const moved = world.tasks.get(T(1)).priority_score;
  await act(world, [{ n: 1, action: "undo" }]);
  const restored = world.tasks.get(T(1)).priority_score;
  assert.ok(moved <= restored, `moving it far out should not raise priority (${moved} vs ${restored})`);
  assert.equal(typeof before, "number");
});

// ---------------------------------------------------------------------------
// What the page and the API are shown
// ---------------------------------------------------------------------------

await test("the brief view says whether Undo is possible and never exposes the saved snapshot", async () => {
  const world = carryWorld();
  await act(world, [{ n: 1, action: "move", date: "2026-11-04" }]);
  itemOf(world, 2).state = "deferred"; // legacy: deferred before snapshots
  need(service, "getBrief");
  const view = await service.getBrief(fakeSupabase(world), USER, "EOD-1027", { appUrl: "http://localhost:3000" });
  const byN = new Map(view.items.map((item) => [item.n, item]));
  assert.equal(byN.get(1).can_undo, true);
  assert.equal(byN.get(2).can_undo, false);
  assert.equal(byN.get(3).can_undo, false);
  for (const item of view.items) assert.equal("prior_due" in item, false, `#${item.n} leaks prior_due`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
