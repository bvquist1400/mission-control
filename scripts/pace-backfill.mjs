#!/usr/bin/env node
// Pace tracking backfill for the Christmas Tree Blanket (slice 1).
//
// Dry run by default: prints the plan (project settings, task/row tags, every
// line it couldn't match, the sessions it would create) and the forecast the
// project would have afterwards. --apply writes it; re-running is safe
// (sessions are keyed by source_ref, tags are set, not added).
//
// Two sources:
//   1. A JSON snapshot (no database at all):
//        npm run backfill:pace:dry-run -- --snapshot /path/to/blanket-snapshot.json [--today 2026-10-04]
//   2. A database, through the service-role client (reads, and writes only with --apply):
//        PACE_BACKFILL_SUPABASE_URL=http://127.0.0.1:58321 \
//        PACE_BACKFILL_SERVICE_ROLE_KEY=... \
//        npm run backfill:pace:dry-run -- [--project <uuid>] [--apply] [--confirm-host <host>]
//      Every query is scoped to the project's owner (user_id). --apply against
//      anything but localhost / 127.0.0.1 also needs --confirm-host <that host>.
//      This script never reads .env files and never prints keys.
//
// Flags: --json prints the full plan as JSON; --today sets the forecast date (default today, ET).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const cwd = process.cwd();
const load = (rel) => import(pathToFileURL(path.join(cwd, rel)).href);
const { buildBackfillPlan, paceInputAfterPlan, readBackfillSnapshot, applyBackfillPlan, BLANKET_PROJECT_ID } = await load(
  "src/lib/work-sessions/backfill.ts"
);
const { computeForecast, formatForecastLine } = await load("src/lib/pace.ts");
const { etDateOf } = await load("src/lib/work-sessions/parse.ts");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
};

const snapshotPath = value("--snapshot");
const apply = flag("--apply");
const asJson = flag("--json");
const today = value("--today") ?? etDateOf(new Date());
const projectId = value("--project") ?? BLANKET_PROJECT_ID;

if (snapshotPath && apply) {
  console.error("--apply needs a database, not --snapshot.");
  process.exit(2);
}

let snapshot;
let supabase = null;
let userId = null;
if (snapshotPath) {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  console.log(`Source: snapshot ${path.basename(snapshotPath)} (captured ${snapshot.captured_at ?? "?"})`);
} else {
  const url = process.env.PACE_BACKFILL_SUPABASE_URL;
  const key = process.env.PACE_BACKFILL_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set PACE_BACKFILL_SUPABASE_URL and PACE_BACKFILL_SERVICE_ROLE_KEY, or pass --snapshot <file>.");
    process.exit(2);
  }
  const host = new URL(url).hostname;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);
  if (apply && !local && value("--confirm-host") !== host) {
    console.error(`Refusing to write to ${host}: pass --confirm-host ${host} to confirm.`);
    process.exit(2);
  }
  console.log(`Source: database at ${host}${local ? " (local)" : ""}, project ${projectId}`);
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  snapshot = await readBackfillSnapshot(supabase, projectId);
  userId = snapshot.user_id;
}

if (snapshot.project.id !== projectId) {
  console.error(`The snapshot is for project ${snapshot.project.id}, not ${projectId}.`);
  process.exit(2);
}

const plan = buildBackfillPlan(snapshot);

if (asJson) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`\nProject "${snapshot.project.name}": unit_label=${plan.project.unit_label}, pace_settings.size=${JSON.stringify(plan.project.pace_settings.size)}`);
  console.log(`\nTasks (${plan.task_updates.length}):`);
  for (const update of plan.task_updates) {
    const what = update.unit_count !== null
      ? `task-level ${update.work_type} ${update.unit_count}`
      : `${update.is_sample ? "sample (swatch)" : "main"}, width ${update.width}`;
    console.log(`  ${update.title} → ${what}`);
  }
  const byType = {};
  for (const tag of plan.item_tags) {
    byType[tag.work_type] ??= { rows: 0, units: 0 };
    byType[tag.work_type].rows += 1;
    byType[tag.work_type].units += tag.unit_count;
  }
  console.log(`\nRows tagged: ${plan.item_tags.length}`);
  for (const [type, totals] of Object.entries(byType)) console.log(`  ${type}: ${totals.rows} rows, ${totals.units} stitches`);
  console.log(`Rows left without units (check items etc.): ${plan.no_unit_items.length}`);
  console.log("\nRule hits:");
  for (const [rule, hits] of Object.entries(plan.rule_hits)) console.log(`  ${String(hits).padStart(4)}  ${rule}`);
  console.log(plan.rules_without_hits.length ? `Rules with NO hits: ${plan.rules_without_hits.join("; ")}` : "Every rule hit at least once.");
  console.log(`\nCouldn't match (${plan.unmatched.length}):`);
  for (const entry of plan.unmatched) console.log(`  [${entry.task_title}] ${entry.text}  — ${entry.reason}`);
  console.log(`\nSessions (${plan.sessions.length}):`);
  for (const session of plan.sessions) {
    console.log(
      `  ${session.session_date} ${session.minutes} min ${session.exclude_from_stats ? `EXCLUDED (${session.exclude_reason})` : "counted"}` +
        `${session.started_at ? ` ${session.started_at}–${session.ended_at}` : ""} · ${session.item_ids.length} rows · ${session.task_id ? `task ${session.task_id}` : "project-level"}` +
        ` · ref ${session.source_ref} · ${session.origin}${session.already_stored ? " · ALREADY STORED (skip)" : ""}`
    );
  }
  console.log(`\ncompleted_at to set on done rows: ${plan.completed_at_updates.length}`);
  console.log(`\nWarnings (${plan.warnings.length}):`);
  for (const warning of plan.warnings) console.log(`  ${warning}`);
}

const forecast = computeForecast(paceInputAfterPlan(snapshot, plan, today));
console.log(`\nForecast after the backfill (as of ${today}):`);
console.log(`  ${formatForecastLine(forecast, "colorwork-dc")}`);
console.log(`  work left ${forecast.work_left_minutes} min (${forecast.work_left_hours} h) · cadence ${forecast.cadence_minutes_per_day} min/day · available ${forecast.available_days} days from ${forecast.available_from} · needs ${forecast.needed_minutes_per_day} min/day · health ${forecast.health}`);
console.log(`  plan ratio ${forecast.plan_ratio?.ratio ?? "—"}× (${forecast.plan_ratio?.basis ?? "—"}) · counted ${forecast.counted_sessions} · excluded ${forecast.excluded_sessions}`);
for (const row of forecast.work_left) {
  console.log(`  ${row.work_type}: ${row.units_left} left · ${row.seconds_per_unit} s/stitch (${row.source}, ${row.n_sessions} session${row.n_sessions === 1 ? "" : "s"}) · ${row.hours_left} h`);
}
if (forecast.size_fit) {
  console.log(`  widest width by ${forecast.target_date}: ${forecast.size_fit.fits.map((fit) => `${fit.minutes_per_day} min/day → ${fit.widest ?? "none"}`).join(" · ")}`);
} else {
  console.log(`  size fit: ${forecast.size_fit_reason}`);
}

if (!apply) {
  console.log("\nDry run: nothing written. Re-run with --apply to write.");
  process.exit(0);
}

const result = await applyBackfillPlan(supabase, userId, plan);
console.log(`\nApplied: ${JSON.stringify(result)}`);
