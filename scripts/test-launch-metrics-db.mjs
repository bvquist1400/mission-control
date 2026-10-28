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

// ─── Part 2: the sync route, run log and alert tasks on a real database ───

const { generateKeyPairSync } = await import("node:crypto");
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/launch-metrics/${name}`, import.meta.url), "utf8"));
const APP_DB_URL = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/launch-metrics";
const CRON_SECRET = `cron-${randomUUID()}`;
const MACHINE_KEY = `legacy-${randomUUID()}`;
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  MISSION_CONTROL_USER_ID: brent.id,
  MISSION_CONTROL_API_KEY: MACHINE_KEY,
  DEPLOYMENT_ROLE: "main",
  CRON_SECRET,
  MM_METRICS_URL: APP_DB_URL,
  MM_METRICS_TOKEN: "m".repeat(48),
  VERCEL_ANALYTICS_TOKEN: "vercel_token_fixture_0123456789",
  VERCEL_ANALYTICS_PROJECT_ID: "prj_menuandmarket",
  GSC_CLIENT_EMAIL: "launch-metrics@menuandmarket-123456.iam.gserviceaccount.com",
  GSC_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
  GSC_SITE_URL: "sc-domain:menuandmarket.com",
});
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;
delete process.env.LAUNCH_METRICS_ALERT_PROJECT_ID;

const external = { web: null, appDb: null, calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const target = String(typeof input === "string" ? input : input.url);
  const host = new URL(target).hostname;
  if (["127.0.0.1", "localhost"].includes(host)) return realFetch(input, init);
  external.calls.push(target);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (target === APP_DB_URL) return external.appDb ? external.appDb() : json(fixture("app-db-summary.json"));
  if (host === "api.vercel.com") {
    if (external.web) return external.web();
    if (target.includes("referrerHostname")) return json(fixture("vercel-visits-by-referrer.json"));
    if (target.includes("/events/")) return json(fixture("vercel-events-placement.json"));
    return json(fixture("vercel-visits-by-day.json"));
  }
  if (host === "oauth2.googleapis.com") return json(fixture("gsc-token.json"));
  if (host === "searchconsole.googleapis.com") return json(fixture(`gsc-query-${JSON.parse(init.body).dimensions[0]}.json`));
  throw new Error(`unexpected external call ${target}`);
};

const syncRoute = await import("../src/app/api/launch-metrics/sync/route.ts");
const { NextRequest } = await import("next/server.js");
const { createSupabaseLaunchStore } = await import("../src/lib/launch-metrics/store.ts");

const cronGet = (headers = {}, kind = "full") =>
  syncRoute.GET(new NextRequest(`http://localhost/api/launch-metrics/sync?kind=${kind}`, { headers }));
const countRuns = async () => (await admin.from("launch_metric_runs").select("id", { count: "exact", head: true }).eq("user_id", brent.id)).count;
const resetRuns = async () => {
  await admin.from("launch_metric_runs").delete().eq("user_id", brent.id);
};

await test("route: the cron GET needs the CRON_SECRET bearer; nothing runs without it", async () => {
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: CRON_SECRET }, { "x-mission-control-key": MACHINE_KEY }]) {
    const response = await cronGet(headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
  }
  assert.equal(await countRuns(), 0);
  assert.equal(external.calls.length, 0);
});

await test("route: a cron full run stores counts, a run row with codes only, and a counts-only snapshot", async () => {
  const response = await cronGet({ authorization: `Bearer ${CRON_SECRET}` });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.sources, { app_db: "ok", web: "ok", search_console: "ok", apple: "not_connected" });
  assert.equal(body.status, "ok");
  const { data: run } = await admin.from("launch_metric_runs").select("*").eq("id", body.run_id).single();
  assert.equal(run.trigger, "cron");
  assert.equal(run.kind, "full");
  assert.ok(run.finished_at);
  const { data: rows } = await admin.from("launch_metric_daily").select("source, metric, metric_date, dimension, value").eq("user_id", brent.id);
  const get = (source, metric, date, dimension = "") => Number(rows.find((r) => r.source === source && r.metric === metric && r.metric_date === date && r.dimension === dimension)?.value);
  assert.equal(get("app_db", "signups_real", "2026-10-26"), 2);
  assert.equal(get("web", "app_store_taps", "2026-10-26", "placement:site-hero"), 4);
  assert.equal(get("search_console", "clicks", "2026-10-26"), 5);
  const { data: snaps } = await admin.from("launch_source_snapshots").select("source, payload").eq("user_id", brent.id);
  const appSnap = snaps.find((s) => s.source === "app_db").payload;
  assert.deepEqual(Object.keys(appSnap).sort(), ["as_of_date_et", "daily", "generated_at", "release_at", "schema_version", "totals"]);
  // The only strings: two timestamps, one ET date (and each day's date).
  assert.match(appSnap.release_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(appSnap.as_of_date_et, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(appSnap.schema_version, 1);
  assert.ok(!JSON.stringify(snaps).match(/[0-9a-f]{8}-[0-9a-f]{4}/), "no uuid-like value in any snapshot");
});

await test("route: a light run (hourly) skips Search Console", async () => {
  const response = await cronGet({ authorization: `Bearer ${CRON_SECRET}` }, "light");
  const body = await response.json();
  assert.equal(body.sources.search_console, "skipped");
});

await test("route: POST (Refresh now) refuses a missing or foreign Origin and any machine key", async () => {
  const before = await countRuns();
  const post = (headers) => syncRoute.POST(new NextRequest("http://localhost/api/launch-metrics/sync", { method: "POST", headers }));
  assert.equal((await post({ host: "localhost" })).status, 403);
  assert.equal((await post({ host: "localhost", origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ host: "localhost", origin: "http://localhost", "x-mission-control-key": MACHINE_KEY })).status, 403);
  assert.equal(await countRuns(), before);
});

await test("alerts on the database: two failed runs → one task for Brent; more failures → still one; recovery closes it", async () => {
  await resetRuns();
  external.web = () => new Response("{}", { status: 403 });
  for (let i = 0; i < 4; i += 1) {
    const response = await cronGet({ authorization: `Bearer ${CRON_SECRET}` }, "light");
    assert.equal((await response.json()).sources.web, "http_403");
  }
  const { data: tasks } = await admin.from("tasks").select("id, title, status, owner, status_line, tags, external_source_system, external_source_id").eq("user_id", brent.id).eq("external_source_system", "launch_metrics");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].external_source_id, "source:web");
  assert.equal(tasks[0].owner, "brent");
  assert.equal(tasks[0].status, "Planned");
  assert.deepEqual(tasks[0].tags, ["personal", "stock-and-stir", "live-dashboard"]);
  const { data: comments } = await admin.from("task_comments").select("content, source").eq("task_id", tasks[0].id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].source, "system");

  external.web = null;
  await cronGet({ authorization: `Bearer ${CRON_SECRET}` }, "light");
  const { data: after } = await admin.from("tasks").select("status, owner").eq("id", tasks[0].id).single();
  assert.deepEqual(after, { status: "Done", owner: "agent" });
  const { data: comments2 } = await admin.from("task_comments").select("content").eq("task_id", tasks[0].id).order("created_at");
  assert.match(comments2.at(-1).content, /^Recovered: /);
});

await test("alerts on the database: the unique external id stops a second task even when two writers race", async () => {
  const store = createSupabaseLaunchStore(admin, brent.id);
  const task = { title: "Launch numbers: app sign-ups stopped updating", description: "d", status_line: "s", external_source_id: "source:app_db", project_id: null };
  const results = await Promise.all([store.createAlertTask(task), store.createAlertTask(task)]);
  assert.equal(results.filter(Boolean).length, 1);
  const { count } = await admin.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", brent.id).eq("external_source_id", "source:app_db");
  assert.equal(count, 1);
});

// ─── Part 3: the Launch page's routes and loader on a real database ───────

const redditRoute = await import("../src/app/api/launch-metrics/reddit/route.ts");
const redditIdRoute = await import("../src/app/api/launch-metrics/reddit/[id]/route.ts");
const milestonesRoute = await import("../src/app/api/launch-metrics/milestones/route.ts");
const { loadLaunchPageInput, buildLaunchView } = await import("../src/lib/launch-metrics/page-data.ts");

await test("routes: Reddit/milestone writes refuse a missing or foreign Origin and every machine key", async () => {
  const body = JSON.stringify({ label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40" });
  const make = (headers) => new NextRequest("http://localhost/api/launch-metrics/reddit", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await redditRoute.POST(make({ host: "localhost" }))).status, 403);
  assert.equal((await redditRoute.POST(make({ host: "localhost", origin: "https://evil.example" }))).status, 403);
  assert.equal((await redditRoute.POST(make({ host: "localhost", origin: "http://localhost", "x-mission-control-key": MACHINE_KEY }))).status, 403);
  const milestone = new NextRequest("http://localhost/api/launch-metrics/milestones", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "x-mission-control-key": MACHINE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ happened_at: "2026-10-26T14:40", label: "x", kind: "Other" }),
  });
  assert.equal((await milestonesRoute.POST(milestone)).status, 403);
  const del = new NextRequest(`http://localhost/api/launch-metrics/reddit/${randomUUID()}`, { method: "DELETE", headers: { host: "localhost", origin: "http://localhost", "x-mission-control-key": MACHINE_KEY } });
  assert.equal((await redditIdRoute.DELETE(del, { params: Promise.resolve({ id: randomUUID() }) })).status, 403);
  const { count } = await admin.from("launch_reddit_posts").select("id", { count: "exact", head: true }).eq("user_id", brent.id);
  assert.equal(count, 0);
});

await test("loader: the page reads only this user's rows and builds the counts-only view", async () => {
  await admin.from("launch_reddit_posts").insert({ user_id: other.id, label: "Not Brent's", subreddit: "r/other", posted_at: "2026-10-26T18:40:00Z" });
  const input = await loadLaunchPageInput(brent.client, brent.id, null);
  assert.ok(input.daily.length > 0);
  assert.ok(input.runs.length > 0);
  assert.deepEqual(input.reddit, []);
  const view = buildLaunchView(input, new Date("2026-10-27T19:30:00Z"));
  assert.equal(view.totals.realUsers, 2);
  assert.equal(view.website.tapsSum, 7);
  const asOther = await loadLaunchPageInput(other.client, brent.id, null);
  assert.deepEqual([asOther.daily.length, asOther.runs.length], [0, 0], "RLS: another user reading Brent's id sees nothing");
});

globalThis.fetch = realFetch;
await admin.from("tasks").delete().eq("user_id", brent.id).eq("external_source_system", "launch_metrics");

// ─── Part 4: seed import against the local database ───────────────────────

const { spawnSync } = await import("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const pathMod = await import("node:path");
const { fileURLToPath } = await import("node:url");

await test("seed: --apply writes counts only, and a second run changes nothing (upserts)", async () => {
  const seeded = await makeUser("launch-db-seed");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "launch-seed-db-"));
  try {
    writeFileSync(pathMod.join(dir, "signups.csv"), "account,signed_up_et,sign_in,who,household\nzz11aa22,2026-10-23 07:08,Apple,Family,Own\nyy33bb44,2026-10-26 07:10,Apple,Real user,Own\n");
    writeFileSync(pathMod.join(dir, "milestones.csv"), "when_et,event,kind\n2026-10-21 13:42,Menu & Market 1.0 released,Release\n");
    writeFileSync(pathMod.join(dir, "reddit.csv"), "post,subreddit,posted_et,views,upvotes,comments,stats_as_of\nr/apps post,r/apps,2026-10-26 14:40,,1,0,2026-10-26 15:18\n");
    writeFileSync(pathMod.join(dir, "app_store.csv"), "read_on,data_through,window,impressions,product_page_views,first_downloads,conversion\n2026-10-26,2026-10-24,Last 30 days,41,16,4,0.286\n");
    const run = () => spawnSync("npm", ["run", "-s", "launch-metrics:seed", "--", "--dir", dir, "--apply"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, LAUNCH_SEED_SUPABASE_URL: url, LAUNCH_SEED_SERVICE_ROLE_KEY: serviceKey, LAUNCH_SEED_USER_ID: seeded.id },
    });
    const counts = async () => Promise.all(
      ["launch_metric_daily", "launch_milestones", "launch_reddit_posts", "launch_app_store_manual_reads"].map(
        async (table) => (await admin.from(table).select("*", { count: "exact", head: true }).eq("user_id", seeded.id)).count
      )
    );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.ok(!first.stdout.includes(serviceKey));
    const afterFirst = await counts();
    assert.deepEqual(afterFirst.slice(1), [1, 1, 1]);
    assert.equal(run().status, 0);
    assert.deepEqual(await counts(), afterFirst);
    const { data: rows } = await admin.from("launch_metric_daily").select("*").eq("user_id", seeded.id);
    assert.ok(!JSON.stringify(rows).includes("zz11aa22") && !JSON.stringify(rows).includes("yy33bb44"));
    assert.equal(Number(rows.find((r) => r.metric_date === "2026-10-26" && r.metric === "total_real_users").value), 1);
    assert.ok(rows.every((r) => r.variant === "seed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("065: a seeded row never replaces a live one; live replaces seed; seed replaces seed", async () => {
  const owner = await makeUser("launch-db-seedrule");
  const key = { user_id: owner.id, metric_date: "2026-10-26", source: "app_db", dimension: "" };
  const upsert = (metric, value, variant) =>
    admin.from("launch_metric_daily").upsert({ ...key, metric, value, variant }, { onConflict: "user_id,metric_date,source,metric,dimension" });
  const read = async (metric) => {
    const { data, error } = await admin.from("launch_metric_daily").select("value, variant").match({ ...key, metric }).single();
    if (error) throw error;
    return [Number(data.value), data.variant];
  };
  assert.equal((await upsert("signups_real", 2, "seed")).error, null);
  assert.equal((await upsert("signups_real", 3, "seed")).error, null); // seed over seed: a corrected CSV wins
  assert.deepEqual(await read("signups_real"), [3, "seed"]);
  assert.equal((await upsert("signups_real", 5, null)).error, null); // live over seed: live wins
  assert.deepEqual(await read("signups_real"), [5, null]);
  assert.equal((await upsert("signups_real", 2, "seed")).error, null); // seed over live: ignored, no error
  assert.deepEqual(await read("signups_real"), [5, null]);
  assert.equal((await upsert("signups_real", 6, null)).error, null); // live over live: newest wins
  assert.deepEqual(await read("signups_real"), [6, null]);
});

await test("seed: a re-run after go-live keeps live sign-up rows and Reddit stats updated on the page", async () => {
  const owner = await makeUser("launch-db-seedrerun");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "launch-seed-rerun-"));
  try {
    writeFileSync(pathMod.join(dir, "signups.csv"), "account,signed_up_et,sign_in,who,household\nzz11aa22,2026-10-26 07:10,Apple,Real user,Own\nyy33bb44,2026-10-26 13:07,Apple,Real user,Own\n");
    writeFileSync(pathMod.join(dir, "plus.csv"), "as_of,trial,paid,comp\n2026-10-26,0,0,3\n");
    writeFileSync(pathMod.join(dir, "reddit.csv"), "post,subreddit,posted_et,views,upvotes,comments,stats_as_of\nr/apps post,r/apps,2026-10-26 14:40,100,1,0,2026-10-26 15:18\n");
    const run = () => spawnSync("npm", ["run", "-s", "launch-metrics:seed", "--", "--dir", dir, "--apply"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, LAUNCH_SEED_SUPABASE_URL: url, LAUNCH_SEED_SERVICE_ROLE_KEY: serviceKey, LAUNCH_SEED_USER_ID: owner.id },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    // Go-live: the live sync writes the same days (variant null); Brent updates the post's stats on the page.
    const live = (metric, value) => ({ user_id: owner.id, metric_date: "2026-10-26", source: "app_db", metric, dimension: "", value, variant: null });
    let r = await admin.from("launch_metric_daily").upsert([live("signups_real", 5), live("total_real_users", 5), live("total_plus_comp", 4)], { onConflict: "user_id,metric_date,source,metric,dimension" });
    assert.equal(r.error, null);
    r = await admin.from("launch_reddit_posts").update({ views: 999 }).eq("user_id", owner.id);
    assert.equal(r.error, null);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const { data: rows } = await admin.from("launch_metric_daily").select("metric, value, variant").eq("user_id", owner.id).eq("metric_date", "2026-10-26");
    const get = (metric) => rows.find((row) => row.metric === metric);
    assert.deepEqual([Number(get("signups_real").value), get("signups_real").variant], [5, null]);
    assert.deepEqual([Number(get("total_real_users").value), get("total_real_users").variant], [5, null]);
    assert.deepEqual([Number(get("total_plus_comp").value), get("total_plus_comp").variant], [4, null]);
    assert.equal(get("signups_apple").variant, "seed"); // seeded rows with no live twin are still written
    const { data: posts } = await admin.from("launch_reddit_posts").select("views").eq("user_id", owner.id);
    assert.deepEqual(posts.map((p) => p.views), [999]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
