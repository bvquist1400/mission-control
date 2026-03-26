#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const LIVE_APP_URL = "https://mission-control-orpin-chi.vercel.app";
const OPEN_ACCEPTED_LIMIT = 100;
const RECENT_RESOLVED_LIMIT = 12;

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

function taskIdFromSubjectKey(subjectKey) {
  return typeof subjectKey === "string" && subjectKey.startsWith("task:")
    ? subjectKey.slice("task:".length) || null
    : null;
}

function ids(items) {
  return items.map((item) => item.artifact_id).sort();
}

function unique(values) {
  return [...new Set(values)];
}

function arraysEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarizeInboxQueue(items) {
  return items.map((item) => ({
    artifactId: item.artifact_id,
    artifactType: item.artifact_type,
    primaryContractType: item.primary_contract_type,
    status: item.status,
    taskId: item.task_id,
    taskTitle: item.task_title,
    taskStatus: item.task_status,
    suggestedAction: item.suggested_action,
    availableActions: item.available_actions,
  }));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  return { response, payload };
}

async function readRouteInbox(baseUrl, apiKey) {
  const { response, payload } = await fetchJson(`${baseUrl}/api/intelligence/artifacts`, {
    headers: {
      "X-Mission-Control-Key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`GET /api/intelligence/artifacts failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function readRouteMorningBrief(baseUrl, apiKey) {
  const { response, payload } = await fetchJson(`${baseUrl}/api/briefing?mode=morning`, {
    headers: {
      "X-Mission-Control-Key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`GET /api/briefing?mode=morning failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function acceptArtifact(baseUrl, apiKey, artifactId) {
  const { response, payload } = await fetchJson(`${baseUrl}/api/intelligence/artifacts/${artifactId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mission-Control-Key": apiKey,
    },
    body: JSON.stringify({ action: "accept" }),
  });

  if (!response.ok) {
    throw new Error(`POST /api/intelligence/artifacts/${artifactId}/status failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function readDbQueue(supabase, userId, status, limit) {
  const { data, error } = await supabase
    .from("intelligence_artifacts")
    .select("id, artifact_kind, primary_contract_type, subject_key, status, available_actions, updated_at")
    .eq("user_id", userId)
    .eq("status", status)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function readTaskTitles(supabase, userId, subjectKeys) {
  const taskIds = unique(subjectKeys.map((subjectKey) => taskIdFromSubjectKey(subjectKey)).filter(Boolean));
  if (taskIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status")
    .eq("user_id", userId)
    .in("id", taskIds);

  if (error) {
    throw error;
  }

  return new Map((data || []).map((task) => [task.id, task]));
}

async function readLatestTransition(supabase, userId, artifactId) {
  const { data, error } = await supabase
    .from("intelligence_artifact_status_transitions")
    .select("id, artifact_id, from_status, to_status, triggered_by, note, payload, created_at")
    .eq("user_id", userId)
    .eq("artifact_id", artifactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function readArtifactById(supabase, userId, artifactId) {
  const { data, error } = await supabase
    .from("intelligence_artifacts")
    .select("id, primary_contract_type, artifact_kind, subject_key, status, available_actions, summary, reason, updated_at")
    .eq("user_id", userId)
    .eq("id", artifactId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.MISSION_CONTROL_USER_ID || process.env.DEFAULT_USER_ID;
  const apiKey = process.env.MISSION_CONTROL_API_KEY;

  if (!supabaseUrl || !serviceRoleKey || !userId || !apiKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MISSION_CONTROL_USER_ID/DEFAULT_USER_ID, or MISSION_CONTROL_API_KEY in .env.local.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const beforeInbox = await readRouteInbox(LIVE_APP_URL, apiKey);
  const [dbOpen, dbAccepted, dbApplied, dbDismissed, beforeBrief] = await Promise.all([
    readDbQueue(supabase, userId, "open", OPEN_ACCEPTED_LIMIT),
    readDbQueue(supabase, userId, "accepted", OPEN_ACCEPTED_LIMIT),
    readDbQueue(supabase, userId, "applied", RECENT_RESOLVED_LIMIT),
    readDbQueue(supabase, userId, "dismissed", RECENT_RESOLVED_LIMIT),
    readRouteMorningBrief(LIVE_APP_URL, apiKey),
  ]);

  const queueParityBefore = {
    open: arraysEqual(ids(beforeInbox.open), dbOpen.map((row) => row.id).sort()),
    accepted: arraysEqual(ids(beforeInbox.accepted), dbAccepted.map((row) => row.id).sort()),
    appliedRecent: arraysEqual(ids(beforeInbox.applied), dbApplied.map((row) => row.id).sort()),
    dismissedRecent: arraysEqual(ids(beforeInbox.dismissed), dbDismissed.map((row) => row.id).sort()),
  };

  const openBriefIdsBefore = ((beforeBrief.open_review_items || []).map((item) => item.artifact_id)).sort();
  const openInboxIdsBefore = ids(beforeInbox.open);

  if (!arraysEqual(openInboxIdsBefore, openBriefIdsBefore)) {
    throw new Error(
      `Live morning brief and live inbox open queue diverged before transition: inbox=${JSON.stringify(openInboxIdsBefore)} brief=${JSON.stringify(openBriefIdsBefore)}`
    );
  }

  const candidate =
    beforeInbox.open.find((item) => item.primary_contract_type !== "follow_up_risk" && item.available_actions.includes("accept"))
    || beforeInbox.open.find((item) => item.available_actions.includes("accept"));

  if (!candidate) {
    throw new Error("No live open artifact was available for an accept validation.");
  }

  const targetBefore = await readArtifactById(supabase, userId, candidate.artifact_id);
  if (!targetBefore) {
    throw new Error(`Selected artifact ${candidate.artifact_id} was not found in the live database.`);
  }

  const acceptResponse = await acceptArtifact(LIVE_APP_URL, apiKey, candidate.artifact_id);

  const afterInbox = await readRouteInbox(LIVE_APP_URL, apiKey);
  const [afterBrief, targetAfter, latestTransition] = await Promise.all([
    readRouteMorningBrief(LIVE_APP_URL, apiKey),
    readArtifactById(supabase, userId, candidate.artifact_id),
    readLatestTransition(supabase, userId, candidate.artifact_id),
  ]);

  if (!targetAfter) {
    throw new Error(`Accepted artifact ${candidate.artifact_id} disappeared from the live database.`);
  }

  const openInboxIdsAfter = ids(afterInbox.open);
  const acceptedInboxIdsAfter = ids(afterInbox.accepted);
  const openBriefIdsAfter = ((afterBrief.open_review_items || []).map((item) => item.artifact_id)).sort();

  const acceptedItemAfter = afterInbox.accepted.find((item) => item.artifact_id === candidate.artifact_id) || null;

  if (openInboxIdsAfter.includes(candidate.artifact_id)) {
    throw new Error(`Accepted artifact ${candidate.artifact_id} still appeared in the live open inbox queue after transition.`);
  }

  if (!acceptedInboxIdsAfter.includes(candidate.artifact_id)) {
    throw new Error(`Accepted artifact ${candidate.artifact_id} did not appear in the live accepted inbox queue after transition.`);
  }

  if (openBriefIdsAfter.includes(candidate.artifact_id)) {
    throw new Error(`Accepted artifact ${candidate.artifact_id} still appeared in the live morning brief open-review section after transition.`);
  }

  if (!arraysEqual(openInboxIdsAfter, openBriefIdsAfter)) {
    throw new Error(
      `Live morning brief and live inbox open queue diverged after transition: inbox=${JSON.stringify(openInboxIdsAfter)} brief=${JSON.stringify(openBriefIdsAfter)}`
    );
  }

  if (targetAfter.status !== "accepted") {
    throw new Error(`Artifact ${candidate.artifact_id} status is ${targetAfter.status}, expected accepted.`);
  }

  if (!latestTransition) {
    throw new Error(`No status transition row was recorded for artifact ${candidate.artifact_id}.`);
  }

  if (
    latestTransition.from_status !== "open"
    || latestTransition.to_status !== "accepted"
    || latestTransition.triggered_by !== "user"
  ) {
    throw new Error(
      `Latest transition for artifact ${candidate.artifact_id} was not the expected open->accepted user transition: ${JSON.stringify(latestTransition)}`
    );
  }

  const taskLookup = await readTaskTitles(supabase, userId, [candidate.subject_key]);
  const taskId = taskIdFromSubjectKey(candidate.subject_key);
  const task = taskId ? taskLookup.get(taskId) || null : null;

  console.log(JSON.stringify({
    validatedAt: new Date().toISOString(),
    liveRoute: {
      baseUrl: LIVE_APP_URL,
      queueCountsBefore: beforeInbox.counts,
      queueCountsAfter: afterInbox.counts,
      queueParityBefore,
      morningBriefMatchedOpenQueueBefore: arraysEqual(openInboxIdsBefore, openBriefIdsBefore),
      morningBriefMatchedOpenQueueAfter: arraysEqual(openInboxIdsAfter, openBriefIdsAfter),
    },
    selectedArtifact: {
      artifactId: candidate.artifact_id,
      artifactType: candidate.artifact_type,
      primaryContractType: candidate.primary_contract_type,
      taskId,
      taskTitle: task?.title ?? candidate.task_title,
      taskStatus: task?.status ?? candidate.task_status,
      summaryBefore: targetBefore.summary,
      statusBefore: targetBefore.status,
      statusAfter: targetAfter.status,
      acceptResponseStatus: acceptResponse.status,
      acceptedQueuePresentAfter: Boolean(acceptedItemAfter),
    },
    ledger: {
      latestTransition,
      artifactAfter: targetAfter,
    },
    consistency: {
      removedFromOpenInbox: !openInboxIdsAfter.includes(candidate.artifact_id),
      addedToAcceptedInbox: acceptedInboxIdsAfter.includes(candidate.artifact_id),
      removedFromMorningBriefOpenReview: !openBriefIdsAfter.includes(candidate.artifact_id),
      openInboxIdsAfter,
      morningBriefOpenReviewIdsAfter: openBriefIdsAfter,
    },
    openQueueBefore: summarizeInboxQueue(beforeInbox.open),
    acceptedQueueAfter: summarizeInboxQueue(afterInbox.accepted),
    recentAppliedAfter: summarizeInboxQueue(afterInbox.applied),
    recentDismissedAfter: summarizeInboxQueue(afterInbox.dismissed),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
