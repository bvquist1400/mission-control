#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server.js";

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

function summarizeItems(items) {
  return items.map((item) => ({
    artifactId: item.artifact_id,
    artifactType: item.artifact_type,
    taskId: item.task_id,
    taskTitle: item.task_title,
    suggestedAction: item.suggested_action,
  }));
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.MISSION_CONTROL_USER_ID || process.env.DEFAULT_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !userId) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or DEFAULT_USER_ID/MISSION_CONTROL_USER_ID in .env.local.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const digestModule = await import(pathToFileURL(path.join(cwd, "src/lib/briefing/digest.ts")).href);
  const { buildDailyBriefDigest } = digestModule;
  const digest = await buildDailyBriefDigest({
    supabase,
    userId,
    mode: "morning",
  });

  const routeModule = await import(pathToFileURL(path.join(cwd, "src/app/api/briefing/route.ts")).href);
  const internalAuthModule = await import(pathToFileURL(path.join(cwd, "src/lib/supabase/internal-auth.ts")).href);
  const { GET } = routeModule;
  const { writeInternalAuthContext } = internalAuthModule;

  const { data: userResponse, error: userError } = await supabase.auth.admin.getUserById(userId);
  if (userError || !userResponse?.user) {
    throw new Error(`Unable to load auth user ${userId}: ${userError?.message || "unknown error"}`);
  }

  const request = new NextRequest("http://localhost/api/briefing?mode=morning", {
    method: "GET",
  });
  writeInternalAuthContext(request, {
    supabase,
    user: userResponse.user,
    userId,
    authSource: "session",
  });

  const response = await GET(request);
  const routePayload = await response.json();

  if (!response.ok) {
    throw new Error(`Brief route failed (${response.status}): ${JSON.stringify(routePayload)}`);
  }

  const digestIds = digest.open_review_items.map((item) => item.artifact_id).sort();
  const routeIds = (routePayload.open_review_items || []).map((item) => item.artifact_id).sort();

  console.log(JSON.stringify({
    validatedAt: new Date().toISOString(),
    digest: {
      mode: digest.mode,
      openReviewItemCount: digest.open_review_items.length,
      markdownIncludesSection: digest.markdown.includes("## ⚠️ Open Review Items"),
      openReviewItems: summarizeItems(digest.open_review_items),
    },
    route: {
      openReviewItemCount: Array.isArray(routePayload.open_review_items) ? routePayload.open_review_items.length : 0,
      openReviewItems: summarizeItems(routePayload.open_review_items || []),
    },
    matchedArtifactIds: JSON.stringify(digestIds) === JSON.stringify(routeIds),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
