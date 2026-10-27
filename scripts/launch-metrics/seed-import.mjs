#!/usr/bin/env node
// Seed import for the Launch page (piece 9): the hand-kept dashboard CSVs →
// launch tables. COUNTS ONLY: signups.csv becomes per-day counts; its account
// column is never read.
//
//   npm run launch-metrics:seed -- --dir /Users/owner/dev/launch-drafts/dashboard-data
//       dry run: reads the CSVs and prints what would be written (counts only)
//   ... --apply      writes, with LAUNCH_SEED_SUPABASE_URL, LAUNCH_SEED_SERVICE_ROLE_KEY
//                    and LAUNCH_SEED_USER_ID set; a non-local URL also needs
//                    --confirm-host <hostname>. Safe to re-run: every write is an upsert.
//
// Never prints a key. Exit 0 = done, 1 = a write failed, 2 = refused before anything was written.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const { buildSeedPlan, SeedError } = await import("../../src/lib/launch-metrics/seed.ts");

const FILES = ["signups.csv", "plus.csv", "reddit.csv", "milestones.csv", "app_store.csv"];
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(message) {
  console.error(`Refused: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = null;
let apply = false;
let confirmHost = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--dir") dir = args[++index] ?? null;
  else if (arg === "--apply") apply = true;
  else if (arg === "--confirm-host") confirmHost = args[++index] ?? null;
  else refuse("unknown argument (allowed: --dir <path>, --apply, --confirm-host <hostname>)");
}
if (!dir) refuse("--dir <folder with the CSVs> is required");

const files = {};
for (const name of FILES) {
  const file = path.join(dir, name);
  if (existsSync(file)) files[name] = readFileSync(file, "utf8");
}
if (Object.keys(files).length === 0) refuse(`none of ${FILES.join(", ")} found in that folder`);

let plan;
try {
  plan = buildSeedPlan(files);
} catch (error) {
  if (error instanceof SeedError) refuse(error.message);
  throw error;
}

console.log(`Files read: ${Object.keys(files).join(", ")}`);
console.log("Sign-ups per New York day (counts only):");
for (const day of plan.signupDays) {
  console.log(`  ${day.date}: real ${day.real} (Apple ${day.apple}, email ${day.email}), family ${day.family}`);
}
if (plan.skippedInternal > 0) console.log(`  internal accounts skipped: ${plan.skippedInternal}`);
console.log(`Would write: ${plan.daily.length} daily metric rows, ${plan.reddit.length} Reddit posts, ${plan.milestones.length} timeline events, ${plan.manualReads.length} App Store hand reads.`);

if (!apply) {
  console.log("Dry run: nothing written. Add --apply to write.");
  process.exit(0);
}

const url = process.env.LAUNCH_SEED_SUPABASE_URL?.trim();
const serviceKey = process.env.LAUNCH_SEED_SERVICE_ROLE_KEY?.trim();
const userId = process.env.LAUNCH_SEED_USER_ID?.trim();
if (!url || !serviceKey || !userId) refuse("set LAUNCH_SEED_SUPABASE_URL, LAUNCH_SEED_SERVICE_ROLE_KEY and LAUNCH_SEED_USER_ID");
if (!UUID.test(userId)) refuse("LAUNCH_SEED_USER_ID must be a user id (uuid)");
let target;
try {
  target = new URL(url);
} catch {
  refuse("LAUNCH_SEED_SUPABASE_URL is not a URL");
}
if (!LOCAL_HOSTS.has(target.hostname)) {
  if (target.protocol !== "https:") refuse("a non-local URL must be https");
  if (confirmHost !== target.hostname) refuse(`writing to ${target.hostname} needs --confirm-host ${target.hostname}`);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const withUser = (rows) => rows.map((row) => ({ ...row, user_id: userId }));
const steps = [
  ["launch_metric_daily", withUser(plan.daily), "user_id,metric_date,source,metric,dimension"],
  ["launch_reddit_posts", withUser(plan.reddit), "user_id,subreddit,posted_at"],
  ["launch_milestones", withUser(plan.milestones), "user_id,happened_at,label"],
  ["launch_app_store_manual_reads", withUser(plan.manualReads), "user_id,read_on,window_label"],
];
for (const [table, rows, onConflict] of steps) {
  if (rows.length === 0) continue;
  const { error } = await db.from(table).upsert(rows, { onConflict });
  if (error) {
    console.error(`Write to ${table} failed (code ${error.code ?? "unknown"}). Earlier tables were written; re-running is safe.`);
    process.exit(1);
  }
  console.log(`Wrote ${rows.length} rows to ${table}.`);
}
console.log("Done.");
