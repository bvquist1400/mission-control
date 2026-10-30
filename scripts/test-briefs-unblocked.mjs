#!/usr/bin/env node
// Pure tests for the brief's "Recently unblocked" section (Baseline 2f6b39f2, S3,
// no migration). No database: the service runs against an in-memory stand-in for
// Supabase that keeps PostgREST's 1,000-row cap, whose clear_task_unblock and
// brief_item_transition mirror 067 and 064 (a due-date change clears the pill, a
// same-date write doesn't). The real functions run in test-briefs-unblocked-db.mjs.
//
// Every test runs even if an earlier one fails, so a run on the old code shows
// each missing behaviour separately.
//
//   npm run test:briefs-unblocked

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

async function load(file) {
  try {
    return await import(pathToFileURL(path.join(ROOT, "src", file)).href);
  } catch (error) {
    return { __missing: String(error.message).split("\n")[0] };
  }
}

const service = await load("lib/briefs/service.ts");
const validate = await load("lib/briefs/validate.ts");
const words = await load("lib/briefs/unblocked.ts");
const unblocks = await load("lib/task-unblocks.ts");
const cards = await load("components/briefs/cards.tsx");
const briefPage = await load("components/briefs/BriefPage.tsx");
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

function need(mod, ...names) {
  if (mod.__missing) assert.fail(`module missing: ${mod.__missing}`);
  for (const name of names) assert.ok(mod[name] !== undefined, `${name} is not exported`);
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
// In-memory stand-in
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-30T12:00:00Z"); // Fri 10/30 8:00 AM EDT
const YESTERDAY_940 = "2026-10-29T13:40:00.000Z"; // Thu 10/29 9:40 AM EDT
const END_OF_TODAY = "2026-10-31T03:59:59.999Z"; // Fri 10/30, end of the ET day
const LATER = "2026-11-05T04:59:59.999Z"; // Wed 11/4
const PAST = "2026-10-28T03:59:59.999Z"; // Tue 10/27
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quiet = { send: async () => {} };

function makeWorld() {
  return {
    briefs: [],
    items: [],
    tasks: new Map(),
    commitments: [],
    unblocks: [],
    retries: [],
    rpcs: [],
    failClear: null,
    failTable: null,
    pages: {},
  };
}

/** A task showing the pill, with its open task_unblocks row. */
function addPill(world, n, patch = {}, unblock = {}) {
  const task = {
    id: uuid(n),
    user_id: USER,
    title: `Task ${n}`,
    status: "Planned",
    due_at: END_OF_TODAY,
    unblocked_at: YESTERDAY_940,
    is_recurring_template: false,
    tags: [],
    project: null,
    base_priority: 50,
    priority_score: 50,
    stakeholder_mentions: [],
    ...patch,
  };
  world.tasks.set(task.id, task);
  world.unblocks.push({
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    user_id: USER,
    task_id: task.id,
    unblocked_at: task.unblocked_at ?? YESTERDAY_940,
    waited_on_task_ids: [],
    waited_on_commitment_ids: [],
    cleared_at: null,
    cleared_reason: null,
    reverted_at: null,
    ...unblock,
  });
  return task;
}

function addTask(world, n, patch = {}) {
  const task = { id: uuid(n), user_id: USER, title: `Task ${n}`, status: "Planned", due_at: null, unblocked_at: null, tags: [], project: null, base_priority: 50, priority_score: 50, stakeholder_mentions: [], ...patch };
  world.tasks.set(task.id, task);
  return task;
}

function clearPill(world, taskId, reason) {
  const task = world.tasks.get(taskId);
  if (task) task.unblocked_at = null;
  let cleared = 0;
  for (const row of world.unblocks) {
    if (row.task_id === taskId && row.cleared_at === null) {
      row.cleared_at = new Date().toISOString();
      row.cleared_reason = reason;
      cleared += 1;
    }
  }
  return cleared;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

function transition(world, args) {
  const item = world.items.find((entry) => entry.id === args.p_item_id);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.state !== args.p_expected_state) return { ok: false, reason: "conflict", state: item.state, choice: item.choice };
  const snapshot = [];
  for (const update of args.p_task_updates ?? []) {
    const task = world.tasks.get(update.id);
    if ("due_at" in update) {
      if ("expect_due_at" in update && iso(task.due_at) !== iso(update.expect_due_at)) {
        const error = new Error("different date");
        error.code = "MC064";
        throw error;
      }
      snapshot.push({ id: update.id, due_at: iso(task.due_at), applied_due_at: iso(update.due_at) });
      // 067's trg_tasks_unblock_pill: any due change clears the pill; the same instant doesn't.
      if (iso(task.due_at) !== iso(update.due_at) && task.unblocked_at) clearPill(world, task.id, "redated");
      task.due_at = update.due_at;
    }
    if (update.status) {
      if (task.unblocked_at && update.status !== task.status) clearPill(world, task.id, update.status === "Done" ? "finished" : "parked");
      task.status = update.status;
    }
  }
  item.state = args.p_state;
  if ("acted_at" in args.p_fields) item.acted_at = args.p_fields.acted_at;
  if ("choice" in args.p_fields) item.choice = args.p_fields.choice;
  if (args.p_state === "open") item.prior_due = null;
  else if (args.p_state === "deferred" && snapshot.length) item.prior_due = snapshot;
  return { ok: true, state: args.p_state };
}

function tableRows(world, table) {
  switch (table) {
    case "briefs":
      return world.briefs;
    case "brief_items":
      return world.items;
    case "tasks":
      return [...world.tasks.values()];
    case "commitments":
      return world.commitments;
    case "task_unblocks":
      return world.unblocks;
    case "task_unblock_retries":
      return world.retries;
    default:
      return [];
  }
}

function fakeSupabase(world) {
  const from = (table) => {
    const filters = [];
    let orderBy = null;
    let descending = false;
    let cap = 1000;
    let head = false;
    let insertRows = null;
    let updateFields = null;
    let tooLong = false;
    const rows = () => {
      let out = tableRows(world, table).filter((row) => filters.every((filter) => filter(row)));
      if (orderBy) {
        out = [...out].sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : a[orderBy] > b[orderBy] ? 1 : 0));
        if (descending) out.reverse();
      }
      return out;
    };
    const run = () => {
      if (tooLong) return { data: null, error: { message: "URI too long\n" } };
      if (world.failTable === table) return { data: null, error: { code: "42P01", message: `relation ${table} does not exist` } };
      if (insertRows) {
        const inserted = insertRows.map((row, offset) =>
          table === "brief_items"
            ? { id: `b${world.items.length + offset + 1}`, state: "open", choice: null, prior_due: null, acted_at: null, updated_at: "t0", created_at: "t0", dismissed_reason: null, dismissed_note: null, created_task_id: null, ...row }
            : { id: uuid(9000 + world.briefs.length), notified_at: null, notify_sent_at: null, notify_error: null, created_at: "2026-10-30T12:00:00Z", updated_at: "t0", ...row }
        );
        tableRows(world, table).push(...inserted);
        return { data: inserted, error: null };
      }
      if (updateFields) {
        const matched = rows();
        for (const row of matched) Object.assign(row, updateFields);
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      if (head) return { data: null, count: rows().length, error: null };
      if (table in world.pages || table === "task_unblocks") world.pages[table] = (world.pages[table] ?? 0) + 1;
      const matched = rows().slice(0, Math.min(cap, 1000)).map((row) => ({ ...row }));
      if (table === "briefs") for (const row of matched) row.brief_items = world.items.filter((item) => item.brief_id === row.id).sort((a, b) => a.n - b.n);
      return { data: matched, error: null };
    };
    const builder = {
      select(_columns, options) {
        if (options?.head) head = true;
        return builder;
      },
      insert(values) {
        insertRows = Array.isArray(values) ? values : [values];
        return builder;
      },
      update(fields) {
        updateFields = fields;
        return builder;
      },
      eq(column, value) {
        // "brief_items.user_id" filters the embedded rows, not the brief.
        if (!column.includes(".")) filters.push((row) => row[column] === value);
        return builder;
      },
      is(column, value) {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      in(column, values) {
        // The list travels in the URL; the real stack answers "URI too long" (found by the DB test).
        if (values.join(",").length > 8000) tooLong = true;
        const allowed = new Set(values);
        filters.push((row) => allowed.has(row[column]));
        return builder;
      },
      gt(column, value) {
        filters.push((row) => row[column] > value);
        return builder;
      },
      gte(column, value) {
        filters.push((row) => row[column] >= value);
        return builder;
      },
      lte(column, value) {
        filters.push((row) => row[column] <= value);
        return builder;
      },
      order(column, options) {
        if (options?.referencedTable) return builder;
        orderBy = column;
        descending = options?.ascending === false;
        return builder;
      },
      limit(count) {
        cap = count;
        return builder;
      },
      async maybeSingle() {
        const result = run();
        return { data: result.data?.[0] ?? null, error: result.error };
      },
      async single() {
        const result = run();
        return { data: result.data?.[0] ?? null, error: result.error };
      },
      then(resolve, reject) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  };
  return {
    from,
    async rpc(name, args) {
      world.rpcs.push({ name, args });
      if (name === "clear_task_unblock") {
        if (world.failClear) return { data: null, error: world.failClear };
        return { data: { ok: true, cleared: clearPill(world, args.p_task_id, args.p_reason) > 0 }, error: null };
      }
      assert.equal(name, "brief_item_transition");
      try {
        return { data: transition(world, args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}

function saveInput(body = {}) {
  need(validate, "parseSaveBriefInput");
  const parsed = validate.parseSaveBriefInput({ edition: "am", date: "2026-10-30", content: {}, items: [], ...body }, NOW);
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  return parsed.value;
}

async function save(world, body = {}, now = NOW) {
  need(service, "saveBrief");
  return service.saveBrief(fakeSupabase(world), USER, saveInput(body), { appUrl: "http://localhost:3000", notifier: quiet, now });
}

async function act(world, code, list, now = NOW) {
  need(service, "actOnBriefItems");
  const parsed = validate.parseBriefActions(list);
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  return service.actOnBriefItems(fakeSupabase(world), USER, code, parsed.value, { now });
}

const rowsOf = (world) => world.items.filter((item) => item.payload.group === "Recently unblocked");
const clears = (world) => world.rpcs.filter((call) => call.name === "clear_task_unblock");

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const pill = (patch = {}) => ({ task_id: uuid(1), title: "Send revised timeline", status: "Planned", due_at: END_OF_TODAY, unblocked_at: YESTERDAY_940, waited_on: ["Get sign-off on scope"], waited_on_hidden: 0, ...patch });

await test("the row's line follows the mockup: what it waited on, when, where the date stands", () => {
  need(words, "unblockedWhy");
  assert.equal(words.unblockedWhy(pill(), NOW), 'Was waiting on "Get sign-off on scope" (done Thu 10/29 9:40 AM). Now due today.');
  assert.equal(words.unblockedWhy(pill({ due_at: LATER, waited_on: ["A", "B"] }), NOW), 'Was waiting on "A" and "B" (done Thu 10/29 9:40 AM). Already due Wed 11/4.');
  assert.equal(words.unblockedWhy(pill({ due_at: PAST, waited_on: ["A", "B", "C"], waited_on_hidden: 1 }), NOW), 'Was waiting on "A", "B" and 2 others (done Thu 10/29 9:40 AM). Was due Tue 10/27.');
  assert.equal(words.unblockedWhy(pill({ due_at: null, waited_on: [], waited_on_hidden: 1 }), NOW), "Was waiting on another task (done Thu 10/29 9:40 AM). No due date.");
  assert.equal(words.unblockedWhy(pill({ waited_on: [], waited_on_hidden: 2 }), NOW), "Was waiting on 2 other tasks (done Thu 10/29 9:40 AM). Now due today.");
  assert.equal(words.unblockedWhy(pill({ waited_on: [] }), NOW), "Everything it waited on is done (Thu 10/29 9:40 AM). Now due today.");
  assert.equal(words.unblockedWhy(pill({ unblocked_at: "2026-10-30T11:00:00.000Z" }), NOW), 'Was waiting on "Get sign-off on scope" (done 7:00 AM). Now due today.');
  assert.equal(words.unblockedWhy(pill({ status: "Blocked/Waiting" }), NOW), 'Was waiting on "Get sign-off on scope" (done Thu 10/29 9:40 AM). Still marked Waiting. Now due today.');
});

await test("Keep's words: the date, and it only leads when the date is still ahead", () => {
  need(words, "keepLabel", "keepLeads", "keptText");
  assert.equal(words.keepLabel(LATER, NOW), "Keep Wed 11/4");
  assert.equal(words.keepLabel(END_OF_TODAY, NOW), "Keep today");
  assert.equal(words.keepLabel(null, NOW), "Keep no date");
  assert.equal(words.keepLabel(PAST, NOW), "Keep Tue 10/27");
  assert.equal(words.keptText(LATER, NOW), "Keeping Wed 11/4");
  assert.equal(words.keepLeads(LATER, NOW), true);
  assert.equal(words.keepLeads(END_OF_TODAY, NOW), false);
  assert.equal(words.keepLeads(PAST, NOW), false);
  assert.equal(words.keepLeads(null, NOW), false);
});

await test("the stuck line is plain, singular and plural, and names no product", () => {
  need(words, "stuckUnblocksText");
  assert.equal(words.stuckUnblocksText(1), "1 task may be out of date. Something it waited on changed, and Baseline still couldn't update it after 8 tries. Ask your AI assistant to check.");
  assert.match(words.stuckUnblocksText(3), /^3 tasks may be out of date\. Something they waited on changed, and Baseline still couldn't update them after 8 tries/);
});

await test("the 8 here is 067's cap, and new product copy names neither Claude nor Anthropic", () => {
  need(unblocks, "UNBLOCK_RETRY_MAX_ATTEMPTS");
  const migration = readFileSync(path.join(ROOT, "supabase/migrations/067_task_unblocks.sql"), "utf8");
  assert.match(migration, new RegExp(`c_max_attempts CONSTANT INT := ${unblocks.UNBLOCK_RETRY_MAX_ATTEMPTS};`));
  for (const file of ["src/lib/briefs/unblocked.ts", "src/lib/briefs/unblocked-queries.ts"]) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, file), "utf8"), /claude|anthropic/i, file);
  }
  const cardSource = readFileSync(path.join(ROOT, "src/components/briefs/cards.tsx"), "utf8");
  const unblockedCard = cardSource.slice(cardSource.indexOf("function UnblockedCard"), cardSource.indexOf("function CarryOverCard"));
  assert.ok(unblockedCard.length > 100);
  assert.doesNotMatch(unblockedCard, /claude|anthropic/i);
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

await test("save adds one carry_over row per pill, newest first, without the routine listing them", async () => {
  const world = makeWorld();
  addPill(world, 1, { title: "Older", unblocked_at: "2026-10-28T13:00:00.000Z" });
  addPill(world, 2, { title: "Newer", due_at: LATER });
  const result = await save(world);
  const rows = rowsOf(world);
  assert.deepEqual(rows.map((row) => row.payload.title), ["Newer", "Older"]);
  assert.deepEqual(rows.map((row) => row.n), [1, 2]);
  assert.equal(rows[0].kind, "carry_over");
  assert.equal(rows[0].payload.label, "Now unblocked");
  assert.deepEqual(rows[0].task_ids, [uuid(2)]);
  assert.equal(rows[0].item_key, `am:2026-10-30:carry_over:${uuid(2)}`);
  assert.deepEqual(result.unblocked, { added: 2, stuck: 0, read_failed: false });
  assert.equal(result.counts.calls, 2);
  assert.deepEqual(result.appended.map((entry) => entry.n), [1, 2]);
  assert.deepEqual(result.skipped, []);
});

await test("the empty case: no pills, no rows, and the content carries nothing about it", async () => {
  const world = makeWorld();
  addTask(world, 1);
  const result = await save(world, { content: { narrative: "Quiet day." } });
  assert.equal(rowsOf(world).length, 0);
  assert.equal(world.items.length, 0);
  assert.deepEqual(result.unblocked, { added: 0, stuck: 0, read_failed: false });
  assert.deepEqual(world.briefs[0].content, { narrative: "Quiet day." });
});

await test("a row carries over to the next brief until he acts, with no time limit", async () => {
  const world = makeWorld();
  addPill(world, 1, { unblocked_at: "2026-08-01T13:00:00.000Z" });
  await save(world);
  const eod = await save(world, { edition: "eod" }, new Date("2026-10-30T20:15:00Z"));
  assert.equal(eod.unblocked.added, 1, "same pill, next brief");
  const next = await save(world, { date: "2026-11-02" }, new Date("2026-11-02T13:00:00Z"));
  assert.equal(next.unblocked.added, 1, "a weekend later, three months after the unblock");
  assert.deepEqual(rowsOf(world).map((row) => row.item_key), [
    `am:2026-10-30:carry_over:${uuid(1)}`,
    `eod:2026-10-30:carry_over:${uuid(1)}`,
    `am:2026-11-02:carry_over:${uuid(1)}`,
  ]);

  const code = next.code;
  await act(world, code, [{ n: 1, action: "keep" }], new Date("2026-11-02T13:30:00Z"));
  const after = await save(world, { edition: "eod", date: "2026-11-02" }, new Date("2026-11-02T20:15:00Z"));
  assert.equal(after.unblocked.added, 0, "acted on: it stops carrying");
});

await test("a rerun adds a pill that appeared since the first save, once, and leaves the rest alone", async () => {
  const world = makeWorld();
  addPill(world, 1);
  const first = await save(world);
  await act(world, first.code, [{ n: 1, action: "keep" }]);
  addPill(world, 2);
  addPill(world, 3);
  clearPill(world, uuid(3), "started"); // cleared before the save: no row
  const rerun = await save(world);
  assert.equal(rerun.created, false);
  assert.equal(rerun.unblocked.added, 1);
  assert.deepEqual(rowsOf(world).map((row) => [row.n, row.task_ids[0], row.state]), [[1, uuid(1), "decided"], [2, uuid(2), "open"]]);
  const again = await save(world);
  assert.equal(again.unblocked.added, 0);
  assert.equal(world.items.length, 2);
  assert.deepEqual(again.skipped, [], "the server's own rows never show as skipped");
});

await test("a task the routine lists as a carry-over becomes its row: one task, one card", async () => {
  const world = makeWorld();
  addPill(world, 1);
  const other = addTask(world, 2);
  const carry = (id, extra = {}) => ({ kind: "carry_over", title: "From the routine", label: "Due today", task_ids: [id], ...extra });
  const result = await save(world, { items: [carry(uuid(1), { why: "The routine's words" }), carry(other.id, { group: "Recently unblocked" })] });
  assert.equal(world.items.length, 2);
  const [row, plain] = world.items;
  assert.equal(row.payload.group, "Recently unblocked");
  assert.equal(row.payload.label, "Now unblocked");
  assert.equal(row.payload.title, "From the routine");
  assert.match(row.payload.why, /^Everything it waited on is done/);
  assert.equal("group" in plain.payload, false, "the group can't be claimed for a task with no pill");
  assert.equal(result.unblocked.added, 0, "the routine's own item carried it");
});

await test("left out: closed, cleared, reverted, personal, repeating templates, another user's", async () => {
  const world = makeWorld();
  addPill(world, 1, { title: "Keeps its row" });
  addPill(world, 2, { status: "Done" });
  addPill(world, 3, { status: "Parked" });
  addPill(world, 4, { status: "Missed" });
  addPill(world, 5, { unblocked_at: null });
  addPill(world, 6, {}, { cleared_at: YESTERDAY_940, cleared_reason: "brief" });
  addPill(world, 7, {}, { reverted_at: YESTERDAY_940 });
  addPill(world, 8, { tags: ["personal"] });
  addPill(world, 9, { project: { tags: ["personal"] } });
  addPill(world, 10, { is_recurring_template: true });
  addPill(world, 11, { user_id: "someone-else" }, { user_id: "someone-else" });
  await save(world);
  assert.deepEqual(rowsOf(world).map((row) => row.payload.title), ["Keeps its row"]);
});

await test("a pill on a task that was never Waiting gets a row like any other, and a still-Waiting task says so", async () => {
  const world = makeWorld();
  addPill(world, 1, { status: "Backlog" });
  addPill(world, 2, { status: "In Progress" });
  addPill(world, 3, { status: "Blocked/Waiting" });
  await save(world);
  assert.equal(rowsOf(world).length, 3);
  assert.match(rowsOf(world).find((row) => row.task_ids[0] === uuid(3)).payload.why, /Still marked Waiting\./);
});

await test("a row names what it waited on, but only counts anything personal", async () => {
  const world = makeWorld();
  addTask(world, 20, { title: "Get sign-off" });
  addTask(world, 21, { title: "Private errand", tags: ["personal"] });
  addTask(world, 22, { title: "Personal project step", project: { tags: ["personal"] } });
  world.commitments.push({ id: uuid(30), user_id: USER, title: "Send the contract", task: null });
  world.commitments.push({ id: uuid(31), user_id: USER, title: "Private promise", task: { tags: ["personal"], project: null } });
  addPill(world, 1, {}, { waited_on_task_ids: [uuid(20), uuid(21), uuid(22)], waited_on_commitment_ids: [uuid(30), uuid(31)] });
  await save(world);
  const why = rowsOf(world)[0].payload.why;
  assert.match(why, /^Was waiting on "Get sign-off", "Send the contract" and 3 others \(done/);
  assert.doesNotMatch(why, /Private|Personal project/);
});

await test("the read pages past the 1,000-row cap", async () => {
  const world = makeWorld();
  for (let n = 1; n <= 1205; n += 1) addPill(world, n);
  const result = await save(world);
  assert.equal(result.unblocked.added, 1205);
  assert.equal(rowsOf(world).length, 1205);
  assert.equal(world.pages.task_unblocks, 3, "two pages and the empty one that proves the end");
  const view = await service.getBrief(fakeSupabase(world), USER, result.code, { appUrl: "http://localhost:3000" });
  assert.equal(Object.keys(view.tasks).length, 1205, "the page's task read goes past the URL limit too");
});

await test("the stuck count: only retries open at 8+ attempts, stored only above zero, the caller's value ignored", async () => {
  const world = makeWorld();
  const retry = (id, attempts, closed_at = null, user_id = USER) => ({ id, user_id, attempts, closed_at });
  world.retries.push(retry("r1", 8), retry("r2", 9), retry("r3", 7), retry("r4", 8, "2026-10-30T00:00:00Z"), retry("r5", 8, null, "someone-else"));
  const result = await save(world, { content: { unblock_stuck: 99 } });
  assert.equal(world.briefs[0].content.unblock_stuck, 2);
  assert.equal(result.unblocked.stuck, 2);

  const clean = makeWorld();
  await save(clean, { content: { unblock_stuck: 99 } });
  assert.equal("unblock_stuck" in clean.briefs[0].content, false, "zero stores nothing, whatever the caller sent");
});

await test("a rerun refreshes the stuck count, and the section needs no extra read on the page", async () => {
  const world = makeWorld();
  world.retries.push({ id: "r1", user_id: USER, attempts: 8, closed_at: null });
  await save(world);
  assert.equal(world.briefs[0].content.unblock_stuck, 1);
  world.retries[0].closed_at = "2026-10-30T12:30:00Z";
  await save(world);
  assert.equal("unblock_stuck" in world.briefs[0].content, false);
  world.retries[0].closed_at = null;
  world.failTable = "task_unblock_retries";
  await save(world);
  assert.equal("unblock_stuck" in world.briefs[0].content, false, "an unknown count changes nothing");
});

await test("a failed read never fails the save: the brief lands and the reply says so", async () => {
  for (const table of ["task_unblocks", "task_unblock_retries"]) {
    const world = makeWorld();
    addPill(world, 1);
    world.failTable = table;
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const result = await save(world, { content: { narrative: "Still saved." } });
      assert.equal(result.created, true);
      assert.equal(result.unblocked.read_failed, true);
      assert.equal(result.unblocked.added, table === "task_unblocks" ? 0 : 1);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0][1], { code: "42P01" }, "a code only, never a row");
  }
});

// ---------------------------------------------------------------------------
// Act
// ---------------------------------------------------------------------------

await test("Keep clears the pill through clear_task_unblock, then decides the row; the task doesn't change", async () => {
  const world = makeWorld();
  const task = addPill(world, 1, { due_at: LATER });
  const { code } = await save(world);
  const { results, counts } = await act(world, code, [{ n: 1, action: "keep" }]);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].state, "decided");
  assert.equal(results[0].choice, "keep");
  assert.deepEqual(world.rpcs.map((call) => call.name), ["clear_task_unblock", "brief_item_transition"], "the pill first, so a failure can be retried");
  assert.deepEqual(clears(world)[0].args, { p_user_id: USER, p_task_id: task.id, p_reason: "brief" });
  assert.equal(world.tasks.get(task.id).unblocked_at, null);
  assert.equal(world.tasks.get(task.id).due_at, LATER, "a later date is kept");
  assert.equal(world.tasks.get(task.id).status, "Planned");
  assert.equal(world.unblocks[0].cleared_reason, "brief");
  assert.equal(rowsOf(world)[0].state, "decided");
  assert.equal(rowsOf(world)[0].choice, "keep");
  assert.equal(counts.open, 0);
});

await test("Keep repeated is a no-op, and on an ordinary carry-over it is refused before anything runs", async () => {
  const world = makeWorld();
  addPill(world, 1);
  const plain = addTask(world, 2);
  const { code } = await save(world, { items: [{ kind: "carry_over", title: "Plain", task_ids: [plain.id] }] });
  const row = rowsOf(world)[0];
  await act(world, code, [{ n: row.n, action: "keep" }]);
  const again = await act(world, code, [{ n: row.n, action: "keep" }]);
  assert.equal(again.results[0].already, true);
  assert.equal(clears(world).length, 1);

  const plainItem = world.items.find((item) => item.task_ids[0] === plain.id);
  const refused = await act(world, code, [{ n: plainItem.n, action: "keep" }]).then(
    () => null,
    (error) => error
  );
  assert.equal(refused?.status, 400);
  assert.match(refused.message, /isn't a Recently unblocked row/);
  assert.doesNotMatch(refused.message, /use .*keep/, "the hint doesn't offer keep");
});

await test("Move to today on a task already due today: no due change, so clear_task_unblock clears the pill", async () => {
  const world = makeWorld();
  const task = addPill(world, 1, { due_at: END_OF_TODAY });
  const { code } = await save(world);
  const { results } = await act(world, code, [{ n: 1, action: "move", date: "2026-10-30" }]);
  assert.equal(results[0].ok, true, results[0].error);
  assert.equal(results[0].state, "deferred");
  assert.deepEqual(world.rpcs.map((call) => call.name), ["clear_task_unblock", "brief_item_transition"]);
  assert.equal(world.tasks.get(task.id).unblocked_at, null);
  assert.equal(world.unblocks[0].cleared_reason, "brief");
});

await test("Pick a date landing on the date it already has, and Tomorrow likewise, clear the pill too", async () => {
  const world = makeWorld();
  const picked = addPill(world, 1, { due_at: LATER });
  const monday = addPill(world, 2, { due_at: "2026-11-03T04:59:59.999Z" }); // Mon 11/2 end of day, ET (EST)
  const { code } = await save(world);
  const byTask = (id) => rowsOf(world).find((row) => row.task_ids[0] === id).n;
  await act(world, code, [{ n: byTask(picked.id), action: "move", date: "2026-11-04" }]);
  await act(world, code, [{ n: byTask(monday.id), action: "tomorrow" }]);
  assert.equal(clears(world).length, 2);
  assert.equal(world.tasks.get(picked.id).unblocked_at, null);
  assert.equal(world.tasks.get(monday.id).unblocked_at, null);
});

await test("a task with a later due date: Today moves it and the due change itself clears the pill", async () => {
  const world = makeWorld();
  const task = addPill(world, 1, { due_at: LATER });
  const { code } = await save(world);
  const { results } = await act(world, code, [{ n: 1, action: "move", date: "2026-10-30" }]);
  assert.equal(results[0].due_at, END_OF_TODAY);
  assert.equal(clears(world).length, 0, "no second write: 067's trigger already cleared it");
  assert.equal(world.tasks.get(task.id).unblocked_at, null);
  assert.equal(world.unblocks[0].cleared_reason, "redated");
});

await test("a busy task: nothing changes, the row stays open, and the message is plain", async () => {
  for (const code of ["55P03", "57014"]) {
    const world = makeWorld();
    addPill(world, 1);
    const saved = await save(world);
    world.failClear = { code, message: "canceling statement due to lock timeout" };
    const { results } = await act(world, saved.code, [{ n: 1, action: "keep" }]);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /#1: the task is busy right now; nothing changed\. Try again\./);
    assert.equal(rowsOf(world)[0].state, "open");
    assert.equal(world.rpcs.filter((call) => call.name === "brief_item_transition").length, 0);
  }
});

await test("an ordinary carry-over is untouched: a same-date Move never calls clear_task_unblock", async () => {
  const world = makeWorld();
  const plain = addTask(world, 2, { due_at: END_OF_TODAY });
  const { code } = await save(world, { items: [{ kind: "carry_over", title: "Plain", task_ids: [plain.id] }] });
  await act(world, code, [{ n: 1, action: "move", date: "2026-10-30" }]);
  assert.equal(clears(world).length, 0);
});

await test("Undo reopens a kept row and a moved one; the view offers it", async () => {
  const world = makeWorld();
  addPill(world, 1, { due_at: LATER });
  addPill(world, 2, { due_at: LATER, unblocked_at: "2026-10-28T13:00:00.000Z" });
  const { code } = await save(world);
  await act(world, code, [{ n: 1, action: "keep" }]);
  await act(world, code, [{ n: 2, action: "move", date: "2026-10-30" }]);

  const view = await service.getBrief(fakeSupabase(world), USER, code, { appUrl: "http://localhost:3000" });
  assert.deepEqual(view.items.map((item) => [item.state, item.can_undo]), [["decided", true], ["deferred", true]]);
  assert.equal("prior_due" in view.items[0], false);

  const { results } = await act(world, code, [{ n: 1, action: "undo" }, { n: 2, action: "undo" }]);
  assert.deepEqual(results.map((result) => [result.ok, result.state, result.error]), [[true, "open", undefined], [true, "open", undefined]]);
  assert.equal(world.items[0].choice, null);
  assert.equal(world.tasks.get(uuid(2)).due_at, LATER, "the date goes back");
  assert.equal(world.tasks.get(uuid(1)).unblocked_at, null, "a cleared pill does not come back");
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function itemRow(patch = {}) {
  return {
    id: "i1",
    user_id: USER,
    brief_id: "b1",
    n: 1,
    item_key: "k1",
    kind: "carry_over",
    payload: { title: "Book the review session", why: "Was waiting on it.", group: "Recently unblocked", label: "Now unblocked" },
    task_ids: [uuid(1)],
    source: { meetings: [] },
    state: "open",
    dismissed_reason: null,
    dismissed_note: null,
    choice: null,
    created_task_id: null,
    can_undo: false,
    acted_at: null,
    created_at: "t0",
    updated_at: "t0",
    ...patch,
  };
}

function renderCard(item, task) {
  need(cards, "CARD_REGISTRY");
  const ctx = { tasks: task ? { [task.id]: task } : {}, pending: false, focused: false, act() {}, focus() {} };
  const { Card } = cards.CARD_REGISTRY[item.kind];
  return renderToStaticMarkup(h(Card, { item, ctx }));
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const buttons = (html) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)].map((match) => [text(match[2]), match[1].includes("solid")]);

const futureDue = new Date(Date.now() + 5 * 86_400_000).toISOString();
const taskRow = (patch = {}) => ({ id: uuid(1), title: "Book the review session", status: "Planned", due_at: futureDue, owner: "brent", ...patch });

await test("a row with a later date: Keep <date> leads, then Today, then Pick a date…", () => {
  const html = renderCard(itemRow(), taskRow());
  const labels = buttons(html);
  assert.match(labels[0][0], /^Keep [A-Z][a-z]{2} \d+\/\d+$/);
  assert.equal(labels[0][1], true);
  assert.deepEqual(labels.slice(1).map(([label]) => label), ["Today", "Pick a date…"]);
  assert.match(html, /ub-pill/);
  assert.match(text(html), /Book the review session/);
  assert.match(text(html), /Was waiting on it\./);
  assert.match(html, /href="\/r\/task\/00000000-0000-4000-8000-000000000001"/);
});

await test("a row due today or past or with no date: Today leads, Keep stays on offer", () => {
  const html = renderCard(itemRow(), taskRow({ due_at: null }));
  assert.deepEqual(buttons(html), [["Today", true], ["Pick a date…", false], ["Keep no date", false]]);
});

await test("handled rows say what happened and offer Undo", () => {
  const kept = text(renderCard(itemRow({ state: "decided", choice: "keep", can_undo: true }), taskRow()));
  assert.match(kept, /Keeping [A-Z][a-z]{2} \d+\/\d+/);
  assert.match(kept, /Undo/);
  const moved = text(renderCard(itemRow({ state: "deferred", can_undo: true }), taskRow()));
  assert.match(moved, /Due [A-Z][a-z]{2} \d+\/\d+/);
  assert.match(moved, /Undo/);
});

await test("a task closed elsewhere has nothing left to decide", () => {
  const html = renderCard(itemRow(), taskRow({ status: "Done" }));
  assert.deepEqual(buttons(html).map(([label]) => label), []);
  assert.match(text(html), /Done/);
});

await test("an ordinary carry-over still draws as before, in Needs a call", () => {
  need(cards, "sectionOf");
  const plain = itemRow({ payload: { title: "Plain", label: "Due today" } });
  assert.deepEqual(buttons(renderCard(plain, taskRow())).map(([label]) => label), ["Done", "Tomorrow", "Pick a date…", "Park"]);
  assert.equal(cards.sectionOf(plain), "calls");
  assert.equal(cards.sectionOf(itemRow()), "unblocked");
  assert.equal(cards.sectionOf({ ...itemRow(), kind: "choice" }), "calls", "the group means nothing on another kind");
});

function pageSource() {
  return readFileSync(path.join(ROOT, "src/components/briefs/BriefPage.tsx"), "utf8");
}

async function renderPage(view) {
  need(briefPage, "BriefPage");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { ToastProvider } = await import(pathToFileURL(path.join(ROOT, "src/components/ui/Toast.tsx")).href);
  return renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} } }, h(ToastProvider, null, h(briefPage.BriefPage, { view })))
  );
}

function pageView(items, content = {}) {
  return {
    brief: { id: "b1", user_id: USER, edition: "am", brief_date: "2026-10-30", code: "AM-1030", content, covered_meeting_ids: [], notified_at: null, notify_sent_at: null, notify_error: null, created_at: "2026-10-30T12:00:00Z", updated_at: "t0" },
    items,
    tasks: { [uuid(1)]: taskRow() },
    counts: { total: items.length, open: items.length, from_meetings: 0, calls: items.length },
    url: "http://localhost:3000/briefs/AM-1030",
  };
}

await test("the page: the section shows only when it has rows, above Needs a call", async () => {
  const empty = await renderPage(pageView([]));
  assert.doesNotMatch(empty, /Recently unblocked/);

  const plain = itemRow({ id: "i2", n: 2, item_key: "k2", payload: { title: "Plain", label: "Due today" } });
  const html = await renderPage(pageView([itemRow(), plain]));
  const section = html.indexOf('id="sec-unblocked"');
  const calls = html.indexOf('id="sec-calls"');
  assert.ok(section > 0 && calls > section, "Recently unblocked sits above Needs a call");
  assert.match(html.slice(section, calls), /Ready to move now\./);
  assert.match(html.slice(section, calls), /Book the review session/);
  assert.doesNotMatch(html.slice(section, calls), />Plain</);
  assert.match(html.slice(calls), />Plain</);
  assert.ok(pageSource().includes('sectionOf(item) === "unblocked"'));
});

await test("the page: the stuck line shows only above zero, with or without rows", async () => {
  assert.doesNotMatch(await renderPage(pageView([])), /may be out of date/);
  const html = await renderPage(pageView([], { unblock_stuck: 2 }));
  assert.match(html, /2 tasks may be out of date\./);
  assert.match(html, /class="ub-stuck"/);
  assert.doesNotMatch(html, /Recently unblocked/, "the line doesn't need the section");
});

await test("an unblock_stuck that isn't a positive whole number is dropped on read", () => {
  need(validate, "normalizeBriefContent");
  assert.equal(validate.normalizeBriefContent({ unblock_stuck: 3 }).unblock_stuck, 3);
  for (const bad of [0, -1, 1.5, "3", null]) assert.equal("unblock_stuck" in validate.normalizeBriefContent({ unblock_stuck: bad }), false, String(bad));
});

// ---------------------------------------------------------------------------
// Docs and the tool surface
// ---------------------------------------------------------------------------

await test("the routines and the tool description tell the agent the section is the server's", () => {
  for (const file of ["docs/routines/morning.md", "docs/routines/eod.md"]) {
    const doc = readFileSync(path.join(ROOT, file), "utf8");
    assert.match(doc, /Recently unblocked is Baseline's, not yours/, file);
    assert.match(doc, /\{ n: 3, action: "keep" \}/, file);
  }
  const route = readFileSync(path.join(ROOT, "src/app/api/mcp/route.ts"), "utf8");
  assert.match(route, /'move', 'keep', 'park'/);
  assert.match(route, /Baseline adds a "Recently unblocked" row itself/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
