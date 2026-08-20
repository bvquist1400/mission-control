#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Environment variables may already be available outside a local checkout.
  }
}

const cwd = process.cwd();
loadEnvFile(path.join(cwd, ".env.local"));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const applyMode = process.argv.includes("--apply");
const moduleUrl = pathToFileURL(path.join(cwd, "src/lib/task-external-source.ts")).href;
const { buildTaskExternalSourceBackfillPlan } = await import(moduleUrl);
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: tasks, error } = await supabase
  .from("tasks")
  .select("id, user_id, title, source_url, tags, external_source_system, external_source_id")
  .order("created_at", { ascending: true });

if (error) throw error;

const plan = buildTaskExternalSourceBackfillPlan(tasks || []);
if (plan.updates.length > 0) {
  console.log("Proposed writes:");
  console.table(plan.updates);
} else {
  console.log("No TaskAdvisor external source IDs need backfilling.");
}

if (plan.conflicts.length > 0) {
  console.error("Conflicts detected; no writes may be applied until these are resolved:");
  for (const conflict of plan.conflicts) {
    console.error(`user=${conflict.user_id} taskadvisor/${conflict.external_source_id}`);
    console.table(conflict.tasks);
  }
}

console.log("Summary:", { proposed_writes: plan.updates.length, conflicts: plan.conflicts.length });

if (!applyMode) {
  console.log("Dry-run only. Re-run with --apply to write changes.");
  process.exit(0);
}

if (plan.conflicts.length > 0) {
  console.error("Apply refused because duplicate external source IDs were found.");
  process.exit(1);
}

let applied = 0;
for (const update of plan.updates) {
  console.log("Applying:", update);
  const { error: updateError } = await supabase
    .from("tasks")
    .update({
      external_source_system: update.external_source_system,
      external_source_id: update.external_source_id,
    })
    .eq("id", update.task_id)
    .eq("user_id", update.user_id);

  if (updateError) throw updateError;
  applied += 1;
}

console.log("Apply complete:", { tasks_updated: applied });
