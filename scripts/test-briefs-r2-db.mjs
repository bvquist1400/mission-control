#!/usr/bin/env node
// Review round 2 regression (GPT-6 Sol, 2ecfdec), ported for fix round 2.
//
// The original intercepted the app-side task UPDATE that ran after the carry
// claim. Fix round 2 moved every task write into brief_item_transition's
// transaction, so there is no app-side write left to intercept. This port
// reproduces the same interleavings inside Postgres instead: a separate psql
// session holds a row lock so a call really is mid-transaction while another
// call runs, and failures happen inside that transaction.
//
// LOCAL disposable stack only:
//   BRIEFS_TEST_SUPABASE_URL=… BRIEFS_TEST_SERVICE_ROLE_KEY=… \
//   BRIEFS_TEST_DB_CONTAINER=supabase_db_<project> npm run test:briefs-r2-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const url = process.env.BRIEFS_TEST_SUPABASE_URL;
const container = process.env.BRIEFS_TEST_DB_CONTAINER;
assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "local stack only");
assert.ok(container, "set BRIEFS_TEST_DB_CONTAINER to the local stack's Postgres container");
assert.ok(!/pantry/.test(container), "never the pantry-local stack");
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, actOnBriefItems } = await import("../src/lib/briefs/service.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");
const admin = createClient(url, process.env.BRIEFS_TEST_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const parse = (fn, value) => {
  const result = fn(value);
  assert.equal(result.ok, true, result.errors?.join("; "));
  return result.value;
};

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, what, timeoutMs = 10000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Sessions blocked on a lock right now (the calls under test waiting inside Postgres). */
function lockWaiters() {
  const out = execFileSync("docker", [
    "exec", container, "psql", "-U", "postgres", "-d", "postgres", "-Atc",
    "select count(*) from pg_stat_activity where wait_event_type = 'Lock'",
  ]).toString().trim();
  return Number(out);
}

/** A separate, long-lived psql session: the lever for holding and releasing row locks. */
function pgSession() {
  const proc = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1"]);
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  let marks = 0;
  return {
    async run(sql) {
      const marker = `__done_${++marks}__`;
      proc.stdin.write(`${sql}\n\\echo ${marker}\n`);
      await waitFor(() => output.includes(marker), `psql: ${sql}`);
    },
    close() {
      proc.stdin.end();
    },
  };
}

/** Settles-yet probe for a pending promise. */
function track(promise) {
  const state = { settled: false, value: undefined };
  state.promise = promise.then((value) => { state.settled = true; state.value = value; return value; });
  return state;
}

const email = `briefs-r2-${randomUUID()}@example.test`;
const made = await admin.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
if (made.error) throw made.error;
const userId = made.data.user.id;
const notifier = { send: async () => {} };
let day = 0;

async function newTask(title) {
  const { data, error } = await admin.from("tasks").insert({ user_id: userId, title, status: "Backlog", task_type: "Task" }).select("id").single();
  if (error) throw error;
  return data.id;
}
async function newBrief(items) {
  day += 1;
  return saveBrief(admin, userId, parse(parseSaveBriefInput, { date: `2026-11-${String(day).padStart(2, "0")}`, items }), {
    appUrl: "http://localhost:3000",
    notifier,
  });
}
const act = (code, list) => actOnBriefItems(admin, userId, code, parse(parseBriefActions, list));
const itemState = async (briefId, n = 1) =>
  (await admin.from("brief_items").select("state").eq("brief_id", briefId).eq("n", n).single()).data.state;
const taskStatus = async (id) => (await admin.from("tasks").select("status").eq("id", id).single()).data?.status ?? null;

try {
  await test("reviewer's case: a repeat Done never reports success for a first Done that fails", async () => {
    const task = await newTask("Synthetic carry task");
    const saved = await newBrief([{ kind: "carry_over", title: "Synthetic carry", task_ids: [task] }]);

    // Make the first Done fail inside its transaction, after it has claimed the item.
    const failing = new Proxy(admin, {
      get(target, key) {
        if (key !== "rpc") return typeof target[key] === "function" ? target[key].bind(target) : target[key];
        return (fn, args, ...rest) =>
          target.rpc(fn, fn === "brief_item_transition" && args?.p_state === "done" && Array.isArray(args.p_task_updates)
            ? { ...args, p_task_updates: [...args.p_task_updates, { id: randomUUID(), status: "Done" }] }
            : args, ...rest);
      },
    });

    const lock = pgSession();
    await lock.run(`BEGIN; SELECT id FROM tasks WHERE id = '${task}' FOR UPDATE;`);
    const first = track(actOnBriefItems(failing, userId, saved.code, parse(parseBriefActions, [{ n: 1, action: "done" }])));
    await waitFor(() => lockWaiters() >= 1, "the first Done to block on the task, holding the item");
    const repeat = track(act(saved.code, [{ n: 1, action: "done" }]));
    await waitFor(() => repeat.settled || lockWaiters() >= 2, "the repeat Done to queue behind the first");
    await sleep(200);
    assert.equal(
      repeat.settled,
      false,
      `the repeat must wait, not see the first Done's claim; it returned ${JSON.stringify(repeat.value?.results?.[0])}`
    );
    await lock.run("ROLLBACK;");
    lock.close();
    await first.promise;
    await repeat.promise;

    assert.equal(first.value.results[0].ok, false, "the failing Done reports failure");
    assert.match(first.value.results[0].error, /not part of this item/);
    // The repeat ran after the first rolled back: it saw the item open and did the Done itself.
    const repeatResult = repeat.value.results[0];
    assert.equal(repeatResult.ok, true);
    assert.notEqual(repeatResult.already, true, "never 'already' for an action that didn't take effect");
    assert.equal(await itemState(saved.brief_id), "done");
    assert.equal(await taskStatus(task), "Done", "success was reported only because the task really is Done");
  });

  await test("carry_group: a task failing mid-group rolls back the claim and every earlier task", async () => {
    const tasks = [await newTask("Group A"), await newTask("Group B"), await newTask("Group C")];
    const saved = await newBrief([{ kind: "carry_group", title: "Synthetic group", task_ids: tasks }]);

    // Lock the middle task, let Park update the first one and block on it, then delete it.
    const lock = pgSession();
    await lock.run(`BEGIN; SELECT id FROM tasks WHERE id = '${tasks[1]}' FOR UPDATE;`);
    const park = track(act(saved.code, [{ n: 1, action: "park" }]));
    await waitFor(() => lockWaiters() >= 1, "Park to block mid-group");
    await lock.run(`DELETE FROM tasks WHERE id = '${tasks[1]}'; COMMIT;`);
    lock.close();
    await park.promise;

    const result = park.value.results[0];
    assert.equal(result.ok, false);
    assert.match(result.error, /no longer exists/);
    assert.equal(await itemState(saved.brief_id), "open", "the claim rolled back");
    assert.equal(await taskStatus(tasks[0]), "Backlog", "the first task's Park rolled back too");
    assert.equal(await taskStatus(tasks[2]), "Backlog");

    // A retry fails cleanly on the missing task and changes nothing.
    const retry = await act(saved.code, [{ n: 1, action: "park" }]);
    assert.equal(retry.results[0].ok, false);
    assert.equal(await itemState(saved.brief_id), "open");
    assert.equal(await taskStatus(tasks[0]), "Backlog");
  });

  await test("Done vs Park in flight: the second waits, then gets a conflict; the task matches the item", async () => {
    const task = await newTask("Race task");
    const saved = await newBrief([{ kind: "carry_over", title: "Race carry", task_ids: [task] }]);

    const lock = pgSession();
    await lock.run(`BEGIN; SELECT id FROM tasks WHERE id = '${task}' FOR UPDATE;`);
    const done = track(act(saved.code, [{ n: 1, action: "done" }]));
    await waitFor(() => lockWaiters() >= 1, "Done to hold the item");
    const park = track(act(saved.code, [{ n: 1, action: "park" }]));
    await waitFor(() => lockWaiters() >= 2, "Park to queue");
    await lock.run("COMMIT;");
    lock.close();
    await done.promise;
    await park.promise;

    assert.equal(done.value.results[0].ok, true);
    assert.equal(park.value.results[0].ok, false);
    assert.equal(park.value.results[0].conflict, true);
    assert.equal(park.value.results[0].current_state, "done");
    assert.equal(await itemState(saved.brief_id), "done");
    assert.equal(await taskStatus(task), "Done");
  });

  await test("a concurrent repeat Tomorrow reports 'already' only after the first one's task write committed", async () => {
    const task = await newTask("Tomorrow task");
    const saved = await newBrief([{ kind: "carry_over", title: "Tomorrow carry", task_ids: [task] }]);

    const lock = pgSession();
    await lock.run(`BEGIN; SELECT id FROM tasks WHERE id = '${task}' FOR UPDATE;`);
    const first = track(act(saved.code, [{ n: 1, action: "tomorrow" }]));
    await waitFor(() => lockWaiters() >= 1, "Tomorrow to hold the item");
    const repeat = track(act(saved.code, [{ n: 1, action: "tomorrow" }]));
    await waitFor(() => repeat.settled || lockWaiters() >= 2, "the repeat to queue");
    await sleep(200);
    assert.equal(repeat.settled, false, `the repeat must wait; it returned ${JSON.stringify(repeat.value?.results?.[0])}`);
    await lock.run("COMMIT;");
    lock.close();
    await first.promise;
    await repeat.promise;

    assert.equal(first.value.results[0].ok, true);
    assert.equal(repeat.value.results[0].ok, true);
    assert.equal(repeat.value.results[0].already, true);
    const { data } = await admin.from("tasks").select("due_at").eq("id", task).single();
    assert.equal(new Date(data.due_at).toISOString(), first.value.results[0].due_at, "the due date really is set");
  });

  await test("notify: a save that loses the claim never reports 'sent' before delivery", async () => {
    let releaseSend;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    let reachedSend;
    const atSend = new Promise((resolve) => { reachedSend = resolve; });
    const slowNotifier = { send: async () => { reachedSend(); await sendGate; throw new Error("synthetic Telegram failure"); } };
    const body = parse(parseSaveBriefInput, { date: "2026-12-01", items: [] });

    const first = track(saveBrief(admin, userId, body, { appUrl: "http://localhost:3000", notifier: slowNotifier }));
    await atSend;
    const second = await saveBrief(admin, userId, body, { appUrl: "http://localhost:3000", notifier });
    assert.equal(second.notify.status, "already_claimed");
    assert.equal(second.notify.sent_at, null, "nothing was delivered yet, so nothing says it was");
    releaseSend();
    await first.promise;
    assert.equal(first.value.notify.status, "failed");

    const third = await saveBrief(admin, userId, body, { appUrl: "http://localhost:3000", notifier });
    assert.equal(third.notify.status, "already_claimed");
    assert.equal(third.notify.sent_at, null);
    assert.match(third.notify.error, /synthetic Telegram failure/);
  });
} finally {
  await admin.auth.admin.deleteUser(userId);
}

console.log(`\n${passed} passed`);
