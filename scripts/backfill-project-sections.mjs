#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(filePath) {
  let raw = "";

  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function summarizePlan(plan) {
  return {
    matchedTasks: plan.preview_rows.length,
    sectionsToCreate: plan.sections_to_create.length,
    taskUpdates: plan.task_updates.length,
    skippedNoProject: plan.skipped_no_project.length,
    skippedEmptyTitle: plan.skipped_empty_title.length,
  };
}

function sectionKey(userId, projectId, identity) {
  return `${userId}:${projectId}:${identity}`;
}

const cwd = process.cwd();
loadEnvFile(path.join(cwd, ".env.local"));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const applyMode = process.argv.includes("--apply");
const projectSectionsModule = await import(pathToFileURL(path.join(cwd, "src/lib/project-sections.ts")).href);
const { buildProjectSectionsBackfillPlan } = projectSectionsModule;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const [{ data: tasks, error: tasksError }, { data: existingSections, error: sectionsError }] = await Promise.all([
  supabase
    .from("tasks")
    .select("id, user_id, project_id, title")
    .order("created_at", { ascending: true }),
  supabase
    .from("project_sections")
    .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
    .order("created_at", { ascending: true }),
]);

if (tasksError) {
  throw tasksError;
}

if (sectionsError) {
  throw sectionsError;
}

const plan = buildProjectSectionsBackfillPlan({
  tasks: tasks || [],
  existing_sections: existingSections || [],
});

if (plan.preview_rows.length > 0) {
  console.table(plan.preview_rows);
} else {
  console.log("No eligible bracket-prefixed tasks matched the backfill pattern.");
}

console.log("Summary:", summarizePlan(plan));

if (!applyMode) {
  console.log("Dry-run only. Re-run with --apply to write changes.");
  process.exit(0);
}

const sectionIdByIdentity = new Map();
for (const section of existingSections || []) {
  sectionIdByIdentity.set(
    sectionKey(section.user_id, section.project_id, section.name.trim().toLowerCase()),
    section.id
  );
}

for (const section of plan.sections_to_create) {
  const { data, error } = await supabase
    .from("project_sections")
    .insert({
      user_id: section.user_id,
      project_id: section.project_id,
      name: section.name,
      sort_order: section.sort_order,
    })
    .select("id")
    .single();

  if (error) {
    throw error;
  }

  sectionIdByIdentity.set(sectionKey(section.user_id, section.project_id, section.identity), data.id);
}

let updatedTasks = 0;
for (const update of plan.task_updates) {
  const sectionId = sectionIdByIdentity.get(sectionKey(update.user_id, update.project_id, update.section_identity));
  if (!sectionId) {
    throw new Error(`Missing section id for ${update.user_id}/${update.project_id}/${update.section_identity}`);
  }

  const { error } = await supabase
    .from("tasks")
    .update({
      title: update.new_title,
      section_id: sectionId,
    })
    .eq("id", update.task_id)
    .eq("user_id", update.user_id);

  if (error) {
    throw error;
  }

  updatedTasks += 1;
}

console.log("Apply complete:", {
  sectionsCreated: plan.sections_to_create.length,
  tasksUpdated: updatedTasks,
});
