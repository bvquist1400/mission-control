#!/usr/bin/env node
// Independent negative controls for Slice 1. LOCAL disposable Supabase only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.BRIEFS_TEST_SUPABASE_URL;
const anonKey = process.env.BRIEFS_TEST_ANON_KEY;
const serviceKey = process.env.BRIEFS_TEST_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Set BRIEFS_TEST_* for a localhost disposable stack");
}
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;

const { saveBrief, actOnBriefItems, getBrief } = await import("../src/lib/briefs/service.ts");
const { parseSaveBriefInput, parseBriefActions } = await import("../src/lib/briefs/validate.ts");
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const quiet = { send: async () => {} };
const users = [];

function parsed(body) {
  const result = parseSaveBriefInput(body, new Date("2026-09-25T20:00:00Z"));
  assert.equal(result.ok, true, result.errors?.join("; "));
  return result.value;
}
function actions(body) {
  const result = parseBriefActions(body);
  assert.equal(result.ok, true, result.errors?.join("; "));
  return result.value;
}
async function makeUser() {
  const email = `briefs-review-${randomUUID()}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const user = { id: data.user.id, client };
  users.push(user);
  return user;
}

// Delay only the dismissed-state row write. Both clients read the open state,
// then Accept completes before the Dismiss write is released.
function delayDismissedWrite(client) {
  let release;
  let reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const atWrite = new Promise((resolve) => { reached = resolve; });
  const wrap = (builder) => new Proxy(builder, {
    get(target, property) {
      if (property === "then") return (resolve, reject) => gate.then(() => target.then(resolve, reject));
      const value = target[property];
      return typeof value === "function" ? (...args) => wrap(value.apply(target, args)) : value;
    },
  });
  const delayed = new Proxy(client, {
    get(target, property) {
      if (property !== "from") return target[property];
      return (table) => new Proxy(target.from(table), {
        get(query, key) {
          if (key === "update" && table === "brief_items") return (values) => {
            const builder = query.update(values);
            if (values.state === "dismissed") { reached(); return wrap(builder); }
            return builder;
          };
          return query[key];
        },
      });
    },
  });
  return { delayed, atWrite, release };
}

try {
  const alice = await makeUser();
  const bob = await makeUser();
  const meeting = { id: randomUUID(), title: "Synthetic review meeting", start: "2026-09-25T19:00:00Z", lines: ["Synthetic follow-up"] };
  const save = await saveBrief(admin, alice.id, parsed({
    date: "2026-09-25",
    covered_meeting_ids: [meeting.id],
    items: [{ kind: "proposed_task", title: "Synthetic follow-up", source: { meetings: [meeting] } }],
  }), { appUrl: "http://localhost:3000", notifier: quiet });

  // All four RLS operations on both tables: anon and cross-user must not
  // observe or mutate Alice's rows, including inserts claiming her user id.
  for (const [label, client] of [["anon", createClient(url, anonKey)], ["cross-user", bob.client]]) {
    for (const table of ["briefs", "brief_items"]) {
      const row = table === "briefs"
        ? { user_id: alice.id, edition: "eod", brief_date: "2026-09-23", code: "EOD-0923" }
        : { user_id: alice.id, brief_id: save.brief_id, n: 99, item_key: `review:${randomUUID()}`, kind: "choice" };
      const read = await client.from(table).select("id").eq(table === "briefs" ? "id" : "brief_id", save.brief_id);
      assert.equal(read.data?.length, 0, `${label} SELECT ${table}`);
      const insert = await client.from(table).insert(row);
      assert.ok(insert.error, `${label} INSERT ${table}`);
      const updated = await client.from(table).update({ user_id: bob.id }).eq(table === "briefs" ? "id" : "brief_id", save.brief_id).select("id");
      assert.equal(updated.data?.length, 0, `${label} UPDATE ${table}`);
      const deleted = await client.from(table).delete().eq(table === "briefs" ? "id" : "brief_id", save.brief_id).select("id");
      assert.equal(deleted.data?.length, 0, `${label} DELETE ${table}`);
    }
  }
  console.log("ok - eight RLS policies deny anon and cross-user operations");

  const foreignTask = await admin.from("tasks").insert({ user_id: bob.id, title: "Foreign synthetic task", status: "Backlog", task_type: "Task" }).select("id").single();
  if (foreignTask.error) throw foreignTask.error;
  const foreignItem = await admin.from("brief_items").insert({
    user_id: alice.id, brief_id: save.brief_id, n: 99, item_key: `review:${randomUUID()}`,
    kind: "carry_over", task_ids: [foreignTask.data.id],
  });
  assert.equal(foreignItem.error?.code, "23503", "trigger must reject a foreign task under service role");
  const mismatchedOwner = await admin.from("brief_items").insert({
    user_id: bob.id, brief_id: save.brief_id, n: 99, item_key: `review:${randomUUID()}`, kind: "choice",
  });
  assert.equal(mismatchedOwner.error?.code, "23503", "composite FK must reject a foreign brief");
  console.log("ok - 055 trigger and composite FK reject foreign references");

  const bobSave = await saveBrief(admin, bob.id, parsed({
    date: "2026-09-25", covered_meeting_ids: [meeting.id],
    items: [{ kind: "proposed_task", title: "Synthetic follow-up", source: { meetings: [meeting] } }],
  }), { appUrl: "http://localhost:3000", notifier: quiet });
  const bobView = await getBrief(admin, bob.id, bobSave.code, { appUrl: "http://localhost:3000" });
  const aliceView = await getBrief(admin, alice.id, save.code, { appUrl: "http://localhost:3000" });
  assert.equal(bobView.items[0].item_key, aliceView.items[0].item_key, "synthetic source must make the same key");
  const bobAccepted = await actOnBriefItems(admin, bob.id, bobSave.code, actions([{ n: 1, action: "accept" }]));
  assert.equal(bobAccepted.results[0].ok, true, "another user's matching key must not block Accept");
  await admin.from("tasks").delete().eq("id", bobAccepted.results[0].task_id).eq("user_id", bob.id);
  const afterDelete = await actOnBriefItems(admin, bob.id, bobSave.code, actions([{ n: 1, action: "accept" }]));
  assert.equal(afterDelete.results[0].already, true, "repeat Accept after task deletion must remain final");
  const { count: bobTaskCount } = await admin.from("tasks").select("id", { count: "exact", head: true })
    .eq("user_id", bob.id).eq("external_source_id", bobView.items[0].item_key);
  assert.equal(bobTaskCount, 0, "repeat Accept must not recreate a deliberately deleted task");
  console.log("ok - a matching key is user scoped and deleted accepted tasks are not recreated");

  const { delayed, atWrite, release } = delayDismissedWrite(alice.client);
  const dismissing = actOnBriefItems(delayed, alice.id, save.code, actions([{ n: 1, action: "dismiss", reason: "not_mine" }]));
  await atWrite;
  const accepted = await actOnBriefItems(admin, alice.id, save.code, actions([{ n: 1, action: "accept" }]));
  assert.equal(accepted.results[0].ok, true);
  release();
  const dismissed = await dismissing;
  assert.equal(dismissed.results[0].ok, true);
  const view = await getBrief(admin, alice.id, save.code, { appUrl: "http://localhost:3000" });
  const { data: tasks, error } = await admin.from("tasks").select("id").eq("user_id", alice.id).eq("external_source_id", view.items[0].item_key);
  if (error) throw error;
  assert.equal(tasks.length, 1, "Accept created exactly one task");
  assert.notEqual(view.items[0].state, "dismissed", "Dismiss must not silently coexist with a created task");
  assert.equal(view.items[0].created_task_id, tasks[0].id, "the accepted item must point to its task");
  console.log("ok - conflicting page and service actions preserve the accepted task linkage");
} finally {
  for (const user of users) await admin.auth.admin.deleteUser(user.id).catch(() => null);
}
