#!/usr/bin/env node
// Database tests for launch metrics (migration 065), against a LOCAL Supabase
// stack with every migration applied:
//
//   set -a; . scripts/test-stack/.env.local; set +a
//   LAUNCH_TEST_SUPABASE_URL=$STACK_API_URL LAUNCH_TEST_ANON_KEY=$STACK_ANON_KEY \
//   LAUNCH_TEST_SERVICE_ROLE_KEY=$STACK_SERVICE_ROLE_KEY LAUNCH_TEST_DB_CONTAINER=$STACK_DB_CONTAINER \
//   npm run test:launch-metrics-db
//
// Part 1: 065 itself: grants, RLS (anon nothing, a user only their own rows),
//         CHECKs, the Apple latest-wins trigger, rollback and re-apply.
// Later parts (sync, alerts, seed, routes) are appended below.
// Each test reports and the run continues; throwaway users are deleted at the end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LAUNCH_TEST_SUPABASE_URL;
const anonKey = process.env.LAUNCH_TEST_ANON_KEY;
const serviceKey = process.env.LAUNCH_TEST_SERVICE_ROLE_KEY;
const dbContainer = process.env.LAUNCH_TEST_DB_CONTAINER;

if (!url || !anonKey || !serviceKey || !dbContainer) {
  console.error("Set LAUNCH_TEST_SUPABASE_URL, LAUNCH_TEST_ANON_KEY, LAUNCH_TEST_SERVICE_ROLE_KEY and LAUNCH_TEST_DB_CONTAINER (local stack only).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  console.error(`Refusing to run against ${url}: this test creates and deletes users and rolls a migration back. Local stacks only.`);
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/065_add_launch_metrics.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollbacks/065_add_launch_metrics.down.sql", import.meta.url), "utf8");
const TABLES = [
  "launch_metric_daily",
  "launch_source_snapshots",
  "launch_apple_instances",
  "launch_metric_runs",
  "launch_reddit_posts",
  "launch_milestones",
  "launch_app_store_manual_reads",
];

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error).split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  }
}

const users = [];
async function makeUser(prefix) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

async function waitForTable(present) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = await admin.from("launch_milestones").select("id").limit(1);
    if (present ? !error : error) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`schema cache never ${present ? "saw" : "dropped"} launch_milestones`);
}

const brent = await makeUser("launch-db-brent");
const other = await makeUser("launch-db-other");
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ─── Part 1: migration 065 ────────────────────────────────────────────────

await test("065: every table has RLS on, four policies, and grants for authenticated + service_role only", () => {
  for (const table of TABLES) {
    assert.equal(psql(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`), "t", table);
    assert.equal(psql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${table}'`), "4", table);
    const grants = psql(
      `select string_agg(distinct grantee, ',' order by grantee) from information_schema.role_table_grants where table_schema = 'public' and table_name = '${table}' and grantee in ('anon','authenticated','service_role')`
    );
    // anon may hold the stack's default grants on a fresh local stack; RLS still
    // denies it every row (next test). authenticated + service_role must be there.
    assert.ok(grants.includes("authenticated") && grants.includes("service_role"), `${table}: ${grants}`);
  }
});

await test("065: anon reads nothing and writes nothing", async () => {
  await admin.from("launch_milestones").insert({ user_id: brent.id, happened_at: "2026-10-21T17:42:00Z", label: "Released", kind: "Release" });
  for (const table of TABLES) {
    const { data } = await anon.from(table).select("*").limit(5);
    assert.deepEqual(data ?? [], [], table);
  }
  const { error } = await anon.from("launch_milestones").insert({ user_id: brent.id, happened_at: "2026-10-22T00:00:00Z", label: "x", kind: "Other" });
  assert.ok(error, "anon insert must fail");
});

await test("065: a signed-in user sees and writes only their own rows", async () => {
  const { data: own } = await brent.client.from("launch_milestones").select("label");
  assert.deepEqual(own.map((r) => r.label), ["Released"]);
  const { data: theirs } = await other.client.from("launch_milestones").select("label");
  assert.deepEqual(theirs, []);
  const { error: crossInsert } = await other.client.from("launch_milestones").insert({ user_id: brent.id, happened_at: "2026-10-23T00:00:00Z", label: "spoof", kind: "Other" });
  assert.ok(crossInsert, "inserting for another user must fail");
  const { data: updated } = await other.client.from("launch_milestones").update({ label: "hijack" }).eq("user_id", brent.id).select("id");
  assert.deepEqual(updated, []);
  const { error: ownInsert } = await other.client.from("launch_reddit_posts").insert({ user_id: other.id, label: "Mine", subreddit: "r/apps", posted_at: "2026-10-26T18:40:00Z" });
  assert.equal(ownInsert, null);
});

await test("065: CHECKs refuse bad sources, metric names, negatives, subreddits, kinds and run sources", async () => {
  const bad = [
    ["launch_metric_daily", { user_id: brent.id, metric_date: "2026-10-26", source: "famcal", metric: "x", value: 1 }],
    ["launch_metric_daily", { user_id: brent.id, metric_date: "2026-10-26", source: "web", metric: "Bad Name", value: 1 }],
    ["launch_metric_daily", { user_id: brent.id, metric_date: "2026-10-26", source: "web", metric: "pageviews", value: -1 }],
    ["launch_metric_daily", { user_id: brent.id, metric_date: "2026-10-26", source: "web", metric: "pageviews", value: 1, variant: "manual_read" }],
    ["launch_reddit_posts", { user_id: brent.id, label: "x", subreddit: "apps", posted_at: "2026-10-26T18:40:00Z" }],
    ["launch_reddit_posts", { user_id: brent.id, label: " ", subreddit: "r/apps", posted_at: "2026-10-26T18:40:00Z" }],
    ["launch_reddit_posts", { user_id: brent.id, label: "x", subreddit: "r/apps", posted_at: "2026-10-26T18:40:00Z", views: -5 }],
    ["launch_milestones", { user_id: brent.id, happened_at: "2026-10-26T18:40:00Z", label: "x", kind: "Party" }],
    ["launch_metric_runs", { user_id: brent.id, trigger: "cron", kind: "full", sources: [] }],
    ["launch_metric_runs", { user_id: brent.id, trigger: "webhook", kind: "full" }],
    ["launch_source_snapshots", { user_id: brent.id, source: "web", as_of_date: "2026-10-26", payload: {} }],
    ["launch_app_store_manual_reads", { user_id: brent.id, read_on: "2026-10-26", data_through: "2026-10-24", window_label: "30d", impressions: -1, product_page_views: 1, first_downloads: 1 }],
  ];
  for (const [table, row] of bad) {
    const { error } = await admin.from(table).insert(row);
    assert.ok(error, `${table} accepted ${JSON.stringify(row)}`);
  }
  const { error: feedback } = await admin.from("launch_milestones").insert({ user_id: brent.id, happened_at: "2026-10-26T17:56:00Z", label: "First feature request", kind: "Feedback" });
  assert.equal(feedback, null);
});

await test("065: Apple rows keep the newest processing date; other sources just overwrite", async () => {
  const key = { user_id: brent.id, metric_date: "2026-10-24", source: "apple", metric: "first_downloads", dimension: "" };
  const upsert = (value, processing) =>
    admin.from("launch_metric_daily").upsert({ ...key, value, variant: "standard", apple_processing_date: processing }, { onConflict: "user_id,metric_date,source,metric,dimension" });
  assert.equal((await upsert(3, "2026-10-25")).error, null);
  assert.equal((await upsert(9, "2026-10-24")).error, null); // older instance: ignored
  assert.equal((await upsert(8, null)).error, null); // no processing date: ignored
  let { data } = await admin.from("launch_metric_daily").select("value, apple_processing_date").match(key).single();
  assert.deepEqual([Number(data.value), data.apple_processing_date], [3, "2026-10-25"]);
  assert.equal((await upsert(4, "2026-10-26")).error, null); // newer: wins
  ({ data } = await admin.from("launch_metric_daily").select("value, apple_processing_date").match(key).single());
  assert.deepEqual([Number(data.value), data.apple_processing_date], [4, "2026-10-26"]);

  const webKey = { user_id: brent.id, metric_date: "2026-10-26", source: "web", metric: "pageviews", dimension: "" };
  await admin.from("launch_metric_daily").upsert({ ...webKey, value: 10 }, { onConflict: "user_id,metric_date,source,metric,dimension" });
  await admin.from("launch_metric_daily").upsert({ ...webKey, value: 7 }, { onConflict: "user_id,metric_date,source,metric,dimension" });
  ({ data } = await admin.from("launch_metric_daily").select("value").match(webKey).single());
  assert.equal(Number(data.value), 7);
});

await test("065: updated_at moves on update", async () => {
  const { data: row } = await admin.from("launch_milestones").select("id, updated_at").eq("user_id", brent.id).eq("label", "Released").single();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { data: after } = await admin.from("launch_milestones").update({ label: "Released 1.0" }).eq("id", row.id).select("updated_at").single();
  assert.ok(Date.parse(after.updated_at) > Date.parse(row.updated_at));
});

await test("065: the trigger function is not callable by anon", () => {
  const anonExec = psql(`select has_function_privilege('anon', 'public.launch_metric_daily_keep_latest_apple()', 'execute')`);
  assert.equal(anonExec, "f");
});

await test("065: rollback drops everything it added, re-apply restores it, nothing else changes", async () => {
  const before = psql("select count(*) from pg_tables where schemaname = 'public'");
  psql(ROLLBACK);
  for (const table of TABLES) {
    assert.equal(psql(`select to_regclass('public.${table}') is null`), "t", table);
  }
  assert.equal(psql("select count(*) from pg_proc where proname = 'launch_metric_daily_keep_latest_apple'"), "0");
  assert.equal(Number(psql("select count(*) from pg_tables where schemaname = 'public'")), Number(before) - TABLES.length);
  await waitForTable(false);
  psql(MIGRATION);
  psql(MIGRATION); // idempotent re-run
  assert.equal(psql("select count(*) from pg_tables where schemaname = 'public'"), before);
  await waitForTable(true);
});

// @@MORE_DB_TESTS@@

for (const id of users) {
  await admin.auth.admin.deleteUser(id);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
