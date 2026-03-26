#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server.js";

const ACTIVE_TASK_STATUSES = ["Backlog", "Planned", "In Progress", "Blocked/Waiting"];
const MAX_SEED_TASKS = 120;
const FOLLOW_UP_RISK_AFTER_HOURS = 72;

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

function parseDate(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIso(left, right) {
  const leftParsed = parseDate(left) ?? 0;
  const rightParsed = parseDate(right) ?? 0;
  return leftParsed - rightParsed;
}

function reverseCompareIso(left, right) {
  return compareIso(right, left);
}

function taskIdFromSubjectKey(subjectKey) {
  return typeof subjectKey === "string" && subjectKey.startsWith("task:")
    ? subjectKey.slice("task:".length) || null
    : null;
}

function familyKeyFromReviewPayload(reviewPayload) {
  const coveredFamilies =
    reviewPayload && typeof reviewPayload === "object" && Array.isArray(reviewPayload.coveredFamilies)
      ? reviewPayload.coveredFamilies
      : [];

  return coveredFamilies.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

function sqlText(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return `'${escapeSqlString(value)}'`;
}

function sqlJson(value) {
  return `${sqlText(JSON.stringify(value ?? {}))}::jsonb`;
}

function loadSupabaseManagementToken() {
  const raw = execFileSync(
    "security",
    ["find-generic-password", "-s", "Supabase CLI", "-a", "access-token", "-w"],
    { encoding: "utf8" }
  ).trim();

  const encoded = raw.replace(/^go-keyring-base64:/, "");
  if (!encoded) {
    throw new Error("Supabase CLI access token was not found in the local keychain.");
  }

  return Buffer.from(encoded, "base64").toString("utf8");
}

async function runManagementSql(managementToken, query, readOnly = false) {
  const response = await fetch("https://api.supabase.com/v1/projects/lumhacjoxfimrtohrnhg/database/query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${managementToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      read_only: readOnly,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Management SQL query failed (${response.status}): ${text}`);
  }

  return text ? JSON.parse(text) : [];
}

class LiveValidationPromotionStore {
  constructor(baseStore, managementToken) {
    this.baseStore = baseStore;
    this.managementToken = managementToken;
  }

  createContractSnapshot(input) {
    return this.baseStore.createContractSnapshot(input);
  }

  listActiveArtifactsByFamily(userId, promotionFamilyKey) {
    return this.baseStore.listActiveArtifactsByFamily(userId, promotionFamilyKey);
  }

  getLatestUserDismissalTransitionByFamily(userId, promotionFamilyKey) {
    return this.baseStore.getLatestUserDismissalTransitionByFamily(userId, promotionFamilyKey);
  }

  listActiveArtifactsBySubject(userId, subjectKey) {
    return this.baseStore.listActiveArtifactsBySubject(userId, subjectKey);
  }

  createArtifact(input) {
    return this.baseStore.createArtifact(input);
  }

  updateArtifact(userId, artifactId, updates) {
    return this.baseStore.updateArtifact(userId, artifactId, updates);
  }

  getArtifactById(userId, artifactId) {
    return this.baseStore.getArtifactById(userId, artifactId);
  }

  upsertArtifactCoverages(userId, artifactId, coverages) {
    return this.baseStore.upsertArtifactCoverages(userId, artifactId, coverages);
  }

  insertArtifactContractLinks(userId, artifactId, links) {
    return this.baseStore.insertArtifactContractLinks(userId, artifactId, links);
  }

  insertStatusTransition(input) {
    return this.baseStore.insertStatusTransition(input);
  }

  async insertPromotionEvent(input) {
    try {
      return await this.baseStore.insertPromotionEvent(input);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : error && typeof error === "object" && "message" in error
            ? String(error.message)
            : String(error);

      if (!message.includes("suppression_reason")) {
        throw error;
      }

      const rows = await runManagementSql(
        this.managementToken,
        `
          INSERT INTO intelligence_promotion_events (
            user_id,
            contract_snapshot_id,
            artifact_id,
            promotion_family_key,
            event_type,
            suppression_reason,
            details
          )
          VALUES (
            ${sqlText(input.userId)},
            ${sqlText(input.contractSnapshotId)},
            ${sqlText(input.artifactId)},
            ${sqlText(input.promotionFamilyKey)},
            ${sqlText(input.eventType)},
            ${sqlText(input.suppressionReason)},
            ${sqlJson(input.details)}
          )
          RETURNING id, user_id, contract_snapshot_id, artifact_id, promotion_family_key, event_type, suppression_reason, details, created_at;
        `,
        false
      );

      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(`Unexpected management API insert result for promotion event: ${JSON.stringify(rows)}`);
      }

      const row = rows[0];
      return {
        id: String(row.id),
        userId: String(row.user_id),
        contractSnapshotId: typeof row.contract_snapshot_id === "string" ? row.contract_snapshot_id : null,
        artifactId: typeof row.artifact_id === "string" ? row.artifact_id : null,
        promotionFamilyKey: String(row.promotion_family_key),
        eventType: String(row.event_type),
        suppressionReason: typeof row.suppression_reason === "string" ? row.suppression_reason : null,
        details: row.details && typeof row.details === "object" ? row.details : {},
        createdAt: String(row.created_at),
      };
    }
  }
}

async function fetchSeedTaskIds(supabase, userId) {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, updated_at")
    .eq("user_id", userId)
    .in("status", ACTIVE_TASK_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(MAX_SEED_TASKS);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.id);
}

async function queryReminderExecutions(supabase, userId, artifactId) {
  const { data, error } = await supabase
    .from("intelligence_artifact_reminder_executions")
    .select("*")
    .eq("user_id", userId)
    .eq("artifact_id", artifactId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function queryTaskComments(supabase, userId, taskId) {
  const { data, error } = await supabase
    .from("task_comments")
    .select("*")
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function queryArtifactTransitions(supabase, userId, artifactId) {
  const { data, error } = await supabase
    .from("intelligence_artifact_status_transitions")
    .select("*")
    .eq("user_id", userId)
    .eq("artifact_id", artifactId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function queryReminderExecutionTableExists(supabase) {
  const { error } = await supabase
    .from("intelligence_artifact_reminder_executions")
    .select("id")
    .limit(1);

  if (error) {
    throw new Error(`Live reminder execution table is not available yet: ${error.message}`);
  }
}

async function queryArtifactById(supabase, userId, artifactId) {
  const { data, error } = await supabase
    .from("intelligence_artifacts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", artifactId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function queryAcceptedFollowUpArtifacts(supabase, userId) {
  const { data, error } = await supabase
    .from("intelligence_artifacts")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "accepted")
    .eq("artifact_kind", "single_contract")
    .eq("primary_contract_type", "follow_up_risk")
    .order("updated_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function queryActiveArtifactsByFamily(supabase, userId, promotionFamilyKey) {
  const { data: coverageRows, error: coverageError } = await supabase
    .from("intelligence_artifact_family_coverage")
    .select("*")
    .eq("user_id", userId)
    .eq("promotion_family_key", promotionFamilyKey)
    .order("created_at", { ascending: true });

  if (coverageError) {
    throw coverageError;
  }

  const artifactIds = [...new Set((coverageRows || []).map((row) => row.artifact_id))];
  if (artifactIds.length === 0) {
    return [];
  }

  const { data: artifactRows, error: artifactError } = await supabase
    .from("intelligence_artifacts")
    .select("*")
    .eq("user_id", userId)
    .in("id", artifactIds)
    .in("status", ["open", "accepted"])
    .order("updated_at", { ascending: true });

  if (artifactError) {
    throw artifactError;
  }

  return artifactRows || [];
}

function summarizeComment(comment) {
  return {
    id: comment.id,
    source: comment.source,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    content: comment.content,
  };
}

function summarizeExecution(execution) {
  return {
    id: execution.id,
    artifactId: execution.artifact_id,
    executionKind: execution.execution_kind,
    status: execution.status,
    taskId: execution.task_id,
    taskCommentId: execution.task_comment_id,
    startedAt: execution.started_at,
    completedAt: execution.completed_at,
    payload: execution.payload,
    createdAt: execution.created_at,
    updatedAt: execution.updated_at,
  };
}

function summarizeArtifact(artifact) {
  return {
    id: artifact.id,
    status: artifact.status,
    subjectKey: artifact.subject_key,
    primaryContractType: artifact.primary_contract_type,
    summary: artifact.summary,
    reason: artifact.reason,
    confidence: artifact.confidence,
    severity: artifact.severity,
    updatedAt: artifact.updated_at,
    reviewPayload: artifact.review_payload,
  };
}

function summarizeTransition(transition) {
  return {
    id: transition.id,
    fromStatus: transition.from_status,
    toStatus: transition.to_status,
    triggeredBy: transition.triggered_by,
    note: transition.note,
    payload: transition.payload,
    createdAt: transition.created_at,
  };
}

async function invokeReminderRoute(cwd, options) {
  const routeModule = await import(
    pathToFileURL(path.join(cwd, "src/app/api/intelligence/reminders/run/route.ts")).href
  );
  const { POST } = routeModule;
  const url = `http://localhost/api/intelligence/reminders/run?limit=${options.limit}`;

  let request;
  if (process.env.CRON_SECRET) {
    request = new NextRequest(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });
  } else {
    const internalAuthModule = await import(
      pathToFileURL(path.join(cwd, "src/lib/supabase/internal-auth.ts")).href
    );
    const { writeInternalAuthContext } = internalAuthModule;
    request = new NextRequest(url, { method: "POST" });
    writeInternalAuthContext(request, options.internalAuthContext);
  }

  const response = await POST(request);
  const bodyText = await response.text();
  let body;

  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    throw new Error(`Reminder route failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

function chooseBestFollowUpContract(contexts, contracts) {
  const contextByTaskId = new Map(contexts.map((context) => [context.task.id, context]));

  return [...contracts]
    .filter((contract) => contract.contractType === "follow_up_risk")
    .sort((left, right) => {
      const leftContext = contextByTaskId.get(left.subject.taskId);
      const rightContext = contextByTaskId.get(right.subject.taskId);
      const leftDays = leftContext?.daysSinceActivity ?? 0;
      const rightDays = rightContext?.daysSinceActivity ?? 0;

      if (leftDays !== rightDays) {
        return rightDays - leftDays;
      }

      return reverseCompareIso(leftContext?.task.updated_at, rightContext?.task.updated_at);
    })[0] ?? null;
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

  await queryReminderExecutionTableExists(supabase);

  const intelligenceModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);
  const {
    readIntelligenceTaskContexts,
    detectIntelligenceContracts,
    promoteIntelligenceContracts,
    transitionIntelligenceArtifactStatus,
    SupabaseIntelligencePromotionStore,
  } = intelligenceModule;

  const managementToken = loadSupabaseManagementToken();
  const promotionStore = new LiveValidationPromotionStore(
    new SupabaseIntelligencePromotionStore(supabase),
    managementToken
  );

  const validationStartedAt = new Date();
  const seedTaskIds = await fetchSeedTaskIds(supabase, userId);
  if (seedTaskIds.length === 0) {
    throw new Error("No active tasks were found for the configured live user.");
  }

  const currentContexts = await readIntelligenceTaskContexts(supabase, userId, {
    now: validationStartedAt,
    taskIds: seedTaskIds,
  });
  const currentContracts = detectIntelligenceContracts(currentContexts, { now: validationStartedAt });
  const currentFollowUpContracts = currentContracts.filter((contract) => contract.contractType === "follow_up_risk");
  if (currentFollowUpContracts.length === 0) {
    throw new Error("No live follow_up_risk contracts were detected for the configured user.");
  }

  const currentFamilyKeys = new Set(currentFollowUpContracts.map((contract) => contract.promotionFamilyKey));
  const acceptedArtifactsBeforeSelection = await queryAcceptedFollowUpArtifacts(supabase, userId);
  let targetArtifact = null;
  let targetContract = null;
  let selectionStrategy = null;

  for (const artifact of acceptedArtifactsBeforeSelection) {
    const familyKey = familyKeyFromReviewPayload(artifact.review_payload);
    if (!familyKey || !currentFamilyKeys.has(familyKey)) {
      continue;
    }

    const existingExecutions = await queryReminderExecutions(supabase, userId, artifact.id);
    if (existingExecutions.length > 0) {
      continue;
    }

    targetArtifact = artifact;
    targetContract = currentFollowUpContracts.find((contract) => contract.promotionFamilyKey === familyKey) ?? null;
    selectionStrategy = "existing_accepted";
    break;
  }

  if (!targetArtifact) {
    const bestContract = chooseBestFollowUpContract(currentContexts, currentFollowUpContracts);
    if (!bestContract) {
      throw new Error("Unable to choose a live follow_up_risk contract for reminder validation.");
    }

    const activeArtifacts = await queryActiveArtifactsByFamily(supabase, userId, bestContract.promotionFamilyKey);
    const eligibleOpenArtifact = activeArtifacts.find((artifact) => artifact.status === "open");

    if (eligibleOpenArtifact) {
      await transitionIntelligenceArtifactStatus(
        promotionStore,
        userId,
        eligibleOpenArtifact.id,
        "accepted",
        {
          triggeredBy: "system",
          note: "Live validation: preparing accepted reminder artifact.",
          payload: {
            validation: "phase3_live",
          },
        }
      );

      targetArtifact = await queryArtifactById(supabase, userId, eligibleOpenArtifact.id);
      targetContract = bestContract;
      selectionStrategy = "existing_open_promoted_to_accepted";
    } else {
      const promotionResult = await promoteIntelligenceContracts(
        promotionStore,
        userId,
        [bestContract],
        {
          now: validationStartedAt,
          enableTaskStalenessClarityGrouping: false,
        }
      );

      const promotedArtifact = promotionResult.artifacts.find((artifact) => artifact.primaryContractType === "follow_up_risk");
      if (!promotedArtifact) {
        throw new Error("Fresh promotion did not produce a follow_up_risk artifact.");
      }

      await transitionIntelligenceArtifactStatus(
        promotionStore,
        userId,
        promotedArtifact.id,
        "accepted",
        {
          triggeredBy: "system",
          note: "Live validation: preparing accepted reminder artifact from fresh promotion.",
          payload: {
            validation: "phase3_live",
          },
        }
      );

      targetArtifact = await queryArtifactById(supabase, userId, promotedArtifact.id);
      targetContract = bestContract;
      selectionStrategy = "fresh_promoted_then_accepted";
    }
  }

  if (!targetArtifact || !targetContract) {
    throw new Error("Failed to identify a live accepted follow_up_risk artifact for reminder validation.");
  }

  const targetTaskId = taskIdFromSubjectKey(targetArtifact.subject_key);
  if (!targetTaskId) {
    throw new Error(`Target artifact ${targetArtifact.id} is not task-backed.`);
  }

  const acceptedArtifactsBeforeRun = await queryAcceptedFollowUpArtifacts(supabase, userId);
  const targetAcceptedIndex = acceptedArtifactsBeforeRun.findIndex((artifact) => artifact.id === targetArtifact.id);
  if (targetAcceptedIndex < 0) {
    throw new Error(`Target artifact ${targetArtifact.id} is not present in the accepted follow-up artifact list.`);
  }

  const earlierSameTaskArtifact = acceptedArtifactsBeforeRun
    .slice(0, targetAcceptedIndex)
    .find((artifact) => taskIdFromSubjectKey(artifact.subject_key) === targetTaskId);
  if (earlierSameTaskArtifact) {
    throw new Error(`Cannot isolate target task because earlier accepted reminder artifact ${earlierSameTaskArtifact.id} shares the same task.`);
  }

  const { data: userResponse, error: userError } = await supabase.auth.admin.getUserById(userId);
  if (userError || !userResponse?.user) {
    throw new Error(`Unable to load live auth user ${userId}: ${userError?.message || "unknown error"}`);
  }

  const internalAuthContext = {
    supabase,
    user: userResponse.user,
    userId,
    authSource: "session",
  };

  const beforeComments = await queryTaskComments(supabase, userId, targetTaskId);
  const beforeExecutions = await queryReminderExecutions(supabase, userId, targetArtifact.id);
  const beforeTransitions = await queryArtifactTransitions(supabase, userId, targetArtifact.id);

  const firstRunResult = await invokeReminderRoute(cwd, {
    limit: targetAcceptedIndex + 1,
    internalAuthContext,
  });
  if (Array.isArray(firstRunResult?.errors) && firstRunResult.errors.length > 0) {
    throw new Error(`Reminder route returned errors on first run: ${JSON.stringify(firstRunResult.errors, null, 2)}`);
  }

  const afterFirstArtifact = await queryArtifactById(supabase, userId, targetArtifact.id);
  const afterFirstComments = await queryTaskComments(supabase, userId, targetTaskId);
  const afterFirstExecutions = await queryReminderExecutions(supabase, userId, targetArtifact.id);
  const afterFirstTransitions = await queryArtifactTransitions(supabase, userId, targetArtifact.id);
  const newCommentIds = new Set(beforeComments.map((comment) => comment.id));
  const firstRunNewComments = afterFirstComments.filter((comment) => !newCommentIds.has(comment.id) && comment.source === "system");

  if (firstRunNewComments.length !== 1) {
    throw new Error(`Expected exactly one new source='system' comment on task ${targetTaskId}, found ${firstRunNewComments.length}.`);
  }

  const reminderComment = firstRunNewComments[0];
  if (!String(reminderComment.content).includes(`[Mission Control reminder]`)) {
    throw new Error(`Reminder comment ${reminderComment.id} is missing the Mission Control reminder header.`);
  }

  if (!String(reminderComment.content).includes(`Artifact: ${targetArtifact.id}`)) {
    throw new Error(`Reminder comment ${reminderComment.id} does not reference target artifact ${targetArtifact.id}.`);
  }

  if (!Array.isArray(firstRunResult?.appliedArtifactIds) || !firstRunResult.appliedArtifactIds.includes(targetArtifact.id)) {
    throw new Error(`Reminder route did not report applying target artifact ${targetArtifact.id}.`);
  }

  if (afterFirstExecutions.length !== beforeExecutions.length + 1) {
    throw new Error(`Expected exactly one reminder execution row for target artifact ${targetArtifact.id}.`);
  }

  const completedExecution = afterFirstExecutions.find((execution) => execution.task_comment_id === reminderComment.id);
  if (!completedExecution) {
    throw new Error(`No completed reminder execution row references reminder comment ${reminderComment.id}.`);
  }

  if (completedExecution.status !== "completed" || !completedExecution.started_at || !completedExecution.completed_at) {
    throw new Error(`Reminder execution ${completedExecution.id} did not record clean start/completion timestamps.`);
  }

  if (afterFirstArtifact.status !== "applied") {
    throw new Error(`Target artifact ${targetArtifact.id} did not transition to applied. Current status: ${afterFirstArtifact.status}`);
  }

  const firstAppliedTransition = afterFirstTransitions.find(
    (transition) =>
      transition.from_status === "accepted" &&
      transition.to_status === "applied" &&
      transition.triggered_by === "system"
  );
  if (!firstAppliedTransition) {
    throw new Error(`Artifact ${targetArtifact.id} is missing the expected accepted -> applied system transition.`);
  }

  const secondRunResult = await invokeReminderRoute(cwd, {
    limit: targetAcceptedIndex + 1,
    internalAuthContext,
  });
  if (Array.isArray(secondRunResult?.errors) && secondRunResult.errors.length > 0) {
    throw new Error(`Reminder route returned errors on second run: ${JSON.stringify(secondRunResult.errors, null, 2)}`);
  }

  const afterSecondComments = await queryTaskComments(supabase, userId, targetTaskId);
  const afterSecondExecutions = await queryReminderExecutions(supabase, userId, targetArtifact.id);

  if (afterSecondComments.length !== afterFirstComments.length) {
    throw new Error(`Rerunning reminders created duplicate task comments for task ${targetTaskId}.`);
  }

  if (afterSecondExecutions.length !== afterFirstExecutions.length) {
    throw new Error(`Rerunning reminders created duplicate execution rows for artifact ${targetArtifact.id}.`);
  }

  const futureNow = new Date(validationStartedAt.getTime() + (FOLLOW_UP_RISK_AFTER_HOURS + 24) * 60 * 60 * 1000);
  const futureContexts = await readIntelligenceTaskContexts(supabase, userId, {
    now: futureNow,
    taskIds: [targetTaskId],
  });
  const futureContracts = detectIntelligenceContracts(futureContexts, { now: futureNow });
  const futureFollowUpContract = futureContracts.find(
    (contract) => contract.contractType === "follow_up_risk" && contract.promotionFamilyKey === targetContract.promotionFamilyKey
  );

  if (!futureFollowUpContract) {
    throw new Error(`Target family ${targetContract.promotionFamilyKey} did not redetect after the reminder aged past the inactivity threshold.`);
  }

  const activeArtifactsBeforeFuturePromotion = await queryActiveArtifactsByFamily(
    supabase,
    userId,
    targetContract.promotionFamilyKey
  );
  if (activeArtifactsBeforeFuturePromotion.length !== 0) {
    throw new Error(`Applied artifact is still suppressing active-family lookup before future promotion: ${JSON.stringify(activeArtifactsBeforeFuturePromotion, null, 2)}`);
  }

  const futurePromotionResult = await promoteIntelligenceContracts(
    promotionStore,
    userId,
    [futureFollowUpContract],
    {
      now: futureNow,
      enableTaskStalenessClarityGrouping: false,
    }
  );

  const activeArtifactsAfterFuturePromotion = await queryActiveArtifactsByFamily(
    supabase,
    userId,
    targetContract.promotionFamilyKey
  );
  const freshArtifact = activeArtifactsAfterFuturePromotion.find((artifact) => artifact.id !== targetArtifact.id);

  if (!freshArtifact) {
    throw new Error(`Future promotion did not create a fresh active artifact for family ${targetContract.promotionFamilyKey}.`);
  }

  if (freshArtifact.status !== "open") {
    throw new Error(`Freshly promoted artifact ${freshArtifact.id} is not open. Current status: ${freshArtifact.status}`);
  }

  const report = {
    validatedAt: new Date().toISOString(),
    userId,
    migration: {
      number: "036",
      tablePresent: true,
    },
    target: {
      selectionStrategy,
      artifactId: targetArtifact.id,
      taskId: targetTaskId,
      promotionFamilyKey: targetContract.promotionFamilyKey,
      taskTitle: futureContexts[0]?.task.title ?? currentContexts.find((context) => context.task.id === targetTaskId)?.task.title ?? null,
      routeLimit: targetAcceptedIndex + 1,
    },
    firstRun: {
      inspectedArtifactIds: Array.isArray(firstRunResult?.inspectedArtifacts)
        ? firstRunResult.inspectedArtifacts.map((artifact) => artifact.id)
        : [],
      appliedArtifactIds: Array.isArray(firstRunResult?.appliedArtifactIds)
        ? firstRunResult.appliedArtifactIds
        : [],
      skipped: firstRunResult?.skipped ?? [],
      errors: firstRunResult?.errors ?? [],
      newTaskComments: firstRunNewComments.map((comment) => summarizeComment(comment)),
      executionRows: afterFirstExecutions.map((execution) => summarizeExecution(execution)),
      artifact: summarizeArtifact(afterFirstArtifact),
      newTransitions: afterFirstTransitions
        .slice(beforeTransitions.length)
        .map((transition) => summarizeTransition(transition)),
    },
    secondRun: {
      inspectedArtifactIds: Array.isArray(secondRunResult?.inspectedArtifacts)
        ? secondRunResult.inspectedArtifacts.map((artifact) => artifact.id)
        : [],
      appliedArtifactIds: Array.isArray(secondRunResult?.appliedArtifactIds)
        ? secondRunResult.appliedArtifactIds
        : [],
      skipped: secondRunResult?.skipped ?? [],
      errors: secondRunResult?.errors ?? [],
      newSystemCommentCountOnTask: afterSecondComments.length - afterFirstComments.length,
      executionRowCount: afterSecondExecutions.length,
    },
    futurePromotion: {
      futureNow: futureNow.toISOString(),
      redetectedFamilyKey: futureFollowUpContract.promotionFamilyKey,
      redetectedSummary: futureFollowUpContract.summary,
      promotionArtifacts: futurePromotionResult.artifacts.map((artifact) => ({
        id: artifact.id,
        status: artifact.status,
        primaryContractType: artifact.primaryContractType,
        subjectKey: artifact.subjectKey,
      })),
      activeArtifactsByFamily: activeArtifactsAfterFuturePromotion.map((artifact) => summarizeArtifact(artifact)),
      freshArtifactId: freshArtifact.id,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
