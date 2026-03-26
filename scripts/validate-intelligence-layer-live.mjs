#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const ACTIVE_ARTIFACT_STATUSES = new Set(["open", "accepted"]);
const ACTIVE_TASK_STATUSES = ["Backlog", "Planned", "In Progress", "Blocked/Waiting"];
const MAX_SEED_TASKS = 120;
const TARGET_SAMPLE_SIZE = 6;

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
  return rightParsed - leftParsed;
}

function stableSortTaskInfos(taskInfos) {
  return [...taskInfos].sort((left, right) => {
    if (left.contracts.length !== right.contracts.length) {
      return right.contracts.length - left.contracts.length;
    }

    if (left.context.daysSinceActivity !== right.context.daysSinceActivity) {
      return right.context.daysSinceActivity - left.context.daysSinceActivity;
    }

    return compareIso(left.context.task.updated_at, right.context.task.updated_at);
  });
}

function addTaskSelection(selectedIds, taskInfo) {
  if (!taskInfo || selectedIds.has(taskInfo.context.task.id)) {
    return false;
  }

  selectedIds.add(taskInfo.context.task.id);
  return true;
}

function contractSummary(contract) {
  return {
    contractType: contract.contractType,
    promotionFamilyKey: contract.promotionFamilyKey,
    canonicalSubjectKey: contract.canonicalSubjectKey,
    severity: contract.severity,
    confidence: contract.confidence,
    summary: contract.summary,
    reason: contract.reason,
    metrics: contract.metrics,
    evidence: contract.evidence.map((item) => ({
      code: item.code,
      kind: item.kind,
      summary: item.summary,
      relatedId: item.relatedId,
      recordedAt: item.recordedAt,
    })),
  };
}

function taskSummary(context, contracts) {
  return {
    taskId: context.task.id,
    title: context.task.title,
    status: context.task.status,
    waitingOn: context.task.waiting_on,
    blocker: context.task.blocker,
    dependencyBlocked: context.task.dependency_blocked,
    needsReview: context.task.needs_review,
    dueAt: context.task.due_at,
    latestActivityAt: context.latestActivityAt,
    daysSinceActivity: context.daysSinceActivity,
    commentCount: context.comments.length,
    noteCount: context.notes.length,
    decisionCount: context.notes.reduce((total, note) => total + note.decisions.length, 0),
    openCommitmentCount: context.openCommitments.length,
    contracts: contracts.map((contract) => contractSummary(contract)),
  };
}

function normalizeEvidenceKey(item) {
  return JSON.stringify({
    code: item.code,
    kind: item.kind,
    summary: item.summary,
    relatedId: item.relatedId,
  });
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

function artifactEvidenceShape(artifact) {
  return {
    itemCount: Array.isArray(artifact.artifact_evidence) ? artifact.artifact_evidence.length : 0,
    codes: Array.isArray(artifact.artifact_evidence)
      ? artifact.artifact_evidence.map((item) => item.code)
      : [],
    kinds: Array.isArray(artifact.artifact_evidence)
      ? artifact.artifact_evidence.map((item) => item.kind)
      : [],
    sourceContractTypes: Array.isArray(artifact.artifact_evidence)
      ? [...new Set(artifact.artifact_evidence.map((item) => item.sourceContractType))]
      : [],
  };
}

function assertNoDuplicateActiveArtifacts(coverageRows, artifactRows) {
  const activeArtifactIds = new Set(
    artifactRows
      .filter((artifact) => ACTIVE_ARTIFACT_STATUSES.has(artifact.status))
      .map((artifact) => artifact.id)
  );
  const counts = new Map();

  for (const coverage of coverageRows) {
    if (!activeArtifactIds.has(coverage.artifact_id)) {
      continue;
    }

    const next = (counts.get(coverage.promotion_family_key) ?? 0) + 1;
    counts.set(coverage.promotion_family_key, next);
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([promotionFamilyKey, count]) => ({ promotionFamilyKey, activeArtifactCount: count }));

  if (duplicates.length > 0) {
    throw new Error(`Duplicate active artifacts detected for promotion families: ${JSON.stringify(duplicates, null, 2)}`);
  }
}

function assertSuppressionReasons(events) {
  const suppressionEvents = events.filter((event) => String(event.event_type).includes("noop"));
  if (suppressionEvents.length === 0) {
    throw new Error("Expected at least one suppression event after the second promotion run, but none were recorded.");
  }

  const missingReason = suppressionEvents.filter((event) => {
    return typeof event.suppression_reason !== "string" || event.suppression_reason.trim().length === 0;
  });

  if (missingReason.length > 0) {
    throw new Error(`Suppression events are missing suppression_reason: ${JSON.stringify(missingReason, null, 2)}`);
  }
}

function evidencePriority(contractType, code) {
  const byType = {
    follow_up_risk: ["follow_up_due", "waiting_on_target", "follow_up_inactive", "open_commitment", "latest_comment", "linked_note"],
    blocked_waiting_stale: ["blocked_stale_age", "blocked_state", "unresolved_dependency", "due_overdue", "due_recorded", "linked_note"],
    stale_task: ["active_task_status", "due_overdue", "due_recorded", "latest_comment", "linked_note"],
    ambiguous_task: ["needs_review_flag", "missing_clarifying_context", "due_overdue", "due_recorded", "linked_note_context"],
  };

  const priorities = byType[contractType] ?? [];
  const index = priorities.indexOf(code);
  return index >= 0 ? index : priorities.length + 1;
}

function deriveExpectedCuratedArtifactEvidence(snapshot, maxItems = 3) {
  const contractEvidence = Array.isArray(snapshot.evidence_payload) ? snapshot.evidence_payload : [];
  return [...contractEvidence]
    .sort((left, right) => evidencePriority(snapshot.contract_type, left.code) - evidencePriority(snapshot.contract_type, right.code))
    .slice(0, maxItems)
    .map((item) => ({
      code: item.code,
      kind: item.kind,
      summary: item.summary,
      relatedId: item.relatedId,
      sourceContractType: snapshot.contract_type,
    }));
}

function findEvidenceCurationFailures(artifactRows, contractLinkRows, snapshotRows) {
  const snapshotById = new Map(snapshotRows.map((snapshot) => [snapshot.id, snapshot]));
  const failures = [];

  for (const artifact of artifactRows) {
    if (artifact.artifact_kind !== "single_contract") {
      continue;
    }

    const latestPrimaryLink = [...contractLinkRows]
      .filter((link) => link.artifact_id === artifact.id && link.link_role === "primary")
      .sort((left, right) => compareIso(left.created_at, right.created_at))[0];

    if (!latestPrimaryLink) {
      continue;
    }

    const snapshot = snapshotById.get(latestPrimaryLink.contract_snapshot_id);
    if (!snapshot) {
      continue;
    }

    const artifactEvidence = Array.isArray(artifact.artifact_evidence) ? artifact.artifact_evidence : [];
    const expectedArtifactEvidence = deriveExpectedCuratedArtifactEvidence(snapshot, 3);
    const normalizedArtifactEvidence = artifactEvidence.map((item) => ({
      code: item.code,
      kind: item.kind,
      summary: item.summary,
      relatedId: item.relatedId,
      sourceContractType: item.sourceContractType,
    }));
    const matchesExpected =
      JSON.stringify(normalizedArtifactEvidence) === JSON.stringify(expectedArtifactEvidence);

    if (!matchesExpected) {
      failures.push({
        artifactId: artifact.id,
        contractSnapshotId: snapshot.id,
        promotionFamilyKey: latestPrimaryLink.promotion_family_key,
        artifactEvidence: normalizedArtifactEvidence,
        expectedArtifactEvidence,
      });
    }
  }

  return failures;
}

function assertCuratedEvidence(artifactRows, contractLinkRows, snapshotRows) {
  const failures = findEvidenceCurationFailures(artifactRows, contractLinkRows, snapshotRows);
  if (failures.length > 0) {
    throw new Error(`Artifact evidence did not match the explicit review-facing curation transform: ${JSON.stringify(failures, null, 2)}`);
  }
}

async function queryTable(supabase, table, userId, column, values, orderColumn = "created_at") {
  if (values.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq("user_id", userId)
    .in(column, values)
    .order(orderColumn, { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
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

async function ensureLiveTablesExist(supabase) {
  const { error } = await supabase
    .from("intelligence_artifacts")
    .select("id")
    .limit(1);

  if (error) {
    throw new Error(`Live intelligence tables are not available yet: ${error.message}`);
  }
}

async function fetchSeedTaskIds(supabase, userId) {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, status, updated_at")
    .eq("user_id", userId)
    .in("status", ACTIVE_TASK_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(MAX_SEED_TASKS);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => row.id);
}

function pickTaskSample(taskInfos) {
  const selectedIds = new Set();
  const sorted = stableSortTaskInfos(taskInfos);
  const byContractType = new Map();
  const byStatus = new Map();

  for (const taskInfo of sorted) {
    for (const contract of taskInfo.contracts) {
      if (!byContractType.has(contract.contractType)) {
        byContractType.set(contract.contractType, []);
      }
      byContractType.get(contract.contractType).push(taskInfo);
    }

    if (!byStatus.has(taskInfo.context.task.status)) {
      byStatus.set(taskInfo.context.task.status, []);
    }
    byStatus.get(taskInfo.context.task.status).push(taskInfo);
  }

  const staleTask = byContractType.get("stale_task")?.[0];
  const blockedTask = sorted.find((taskInfo) => {
    return (
      taskInfo.context.task.status === "Blocked/Waiting" ||
      Boolean(taskInfo.context.task.waiting_on?.trim()) ||
      taskInfo.context.task.blocker === true ||
      taskInfo.context.task.dependency_blocked === true
    );
  });

  if (!staleTask) {
    throw new Error("Unable to find a real stale task contract in the live dataset.");
  }

  if (!blockedTask) {
    throw new Error("Unable to find a real blocked or waiting task in the live dataset.");
  }

  addTaskSelection(selectedIds, staleTask);
  addTaskSelection(selectedIds, blockedTask);
  addTaskSelection(selectedIds, byContractType.get("follow_up_risk")?.[0]);
  addTaskSelection(selectedIds, byContractType.get("blocked_waiting_stale")?.[0]);
  addTaskSelection(selectedIds, byContractType.get("ambiguous_task")?.[0]);

  for (const status of ACTIVE_TASK_STATUSES) {
    addTaskSelection(selectedIds, byStatus.get(status)?.[0]);
    if (selectedIds.size >= TARGET_SAMPLE_SIZE) {
      break;
    }
  }

  for (const taskInfo of sorted) {
    addTaskSelection(selectedIds, taskInfo);
    if (selectedIds.size >= TARGET_SAMPLE_SIZE) {
      break;
    }
  }

  return [...selectedIds].slice(0, 10);
}

async function main() {
  const cwd = process.cwd();
  const inspectOnly = process.argv.includes("--inspect-only");
  loadEnvFile(path.join(cwd, ".env.local"));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userId = process.env.MISSION_CONTROL_USER_ID || process.env.DEFAULT_USER_ID;

  if (!supabaseUrl || !serviceRoleKey || !userId) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or DEFAULT_USER_ID/MISSION_CONTROL_USER_ID in .env.local.");
  }

  const validationStartedAt = new Date();
  const detectionNow = new Date(validationStartedAt.getTime());
  const secondPromotionNow = new Date(validationStartedAt.getTime() + 1000);
  const managementToken = loadSupabaseManagementToken();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  await ensureLiveTablesExist(supabase);

  const intelligenceModule = await import(pathToFileURL(path.join(cwd, "src/lib/intelligence-layer/index.ts")).href);
  const {
    readIntelligenceTaskContexts,
    detectIntelligenceContracts,
    promoteIntelligenceContracts,
    SupabaseIntelligencePromotionStore,
  } = intelligenceModule;

  const seedTaskIds = await fetchSeedTaskIds(supabase, userId);
  if (seedTaskIds.length === 0) {
    throw new Error("No active tasks were found for the configured live user.");
  }

  const seedContexts = await readIntelligenceTaskContexts(supabase, userId, {
    now: detectionNow,
    taskIds: seedTaskIds,
  });
  const seedContracts = detectIntelligenceContracts(seedContexts, { now: detectionNow });
  const contractsByTaskId = new Map();

  for (const contract of seedContracts) {
    const taskId = contract.subject.taskId;
    const existing = contractsByTaskId.get(taskId) ?? [];
    existing.push(contract);
    contractsByTaskId.set(taskId, existing);
  }

  const taskInfos = seedContexts.map((context) => ({
    context,
    contracts: contractsByTaskId.get(context.task.id) ?? [],
  }));

  const selectedTaskIds = pickTaskSample(taskInfos);
  const selectedContexts = await readIntelligenceTaskContexts(supabase, userId, {
    now: detectionNow,
    taskIds: selectedTaskIds,
  });
  const selectedContracts = detectIntelligenceContracts(selectedContexts, { now: detectionNow });

  const selectedContractsByTaskId = new Map();
  for (const contract of selectedContracts) {
    const existing = selectedContractsByTaskId.get(contract.subject.taskId) ?? [];
    existing.push(contract);
    selectedContractsByTaskId.set(contract.subject.taskId, existing);
  }

  const sampleTasks = selectedContexts.map((context) => taskSummary(context, selectedContractsByTaskId.get(context.task.id) ?? []));
  const sampleFamilyKeys = [...new Set(selectedContracts.map((contract) => contract.promotionFamilyKey))];

  const currentCoverageRows = await queryTable(
    supabase,
    "intelligence_artifact_family_coverage",
    userId,
    "promotion_family_key",
    sampleFamilyKeys
  );
  const currentArtifactIds = [...new Set(currentCoverageRows.map((row) => row.artifact_id))];
  const currentArtifactRows = await queryTable(
    supabase,
    "intelligence_artifacts",
    userId,
    "id",
    currentArtifactIds
  );
  const currentContractLinkRows = await queryTable(
    supabase,
    "intelligence_artifact_contract_links",
    userId,
    "artifact_id",
    currentArtifactIds
  );
  const currentSnapshotIds = [...new Set(currentContractLinkRows.map((row) => row.contract_snapshot_id))];
  const currentSnapshotRows = await queryTable(
    supabase,
    "intelligence_contract_snapshots",
    userId,
    "id",
    currentSnapshotIds
  );
  const currentPromotionEvents = await runManagementSql(
    managementToken,
    `
      SELECT
        id,
        user_id,
        contract_snapshot_id,
        artifact_id,
        promotion_family_key,
        event_type,
        suppression_reason,
        details,
        created_at
      FROM intelligence_promotion_events
      WHERE user_id = ${sqlText(userId)}
        AND promotion_family_key IN (${sampleFamilyKeys.map((value) => sqlText(value)).join(", ")})
      ORDER BY created_at ASC;
    `,
    true
  );
  const currentEvidenceFailures = findEvidenceCurationFailures(
    currentArtifactRows,
    currentContractLinkRows,
    currentSnapshotRows
  );

  if (inspectOnly) {
    const inspectionReport = {
      inspectedAt: new Date().toISOString(),
      userId,
      selectedTaskIds,
      sampleTasks,
      detectorCounts: {
        follow_up_risk: selectedContracts.filter((contract) => contract.contractType === "follow_up_risk").length,
        blocked_waiting_stale: selectedContracts.filter((contract) => contract.contractType === "blocked_waiting_stale").length,
        stale_task: selectedContracts.filter((contract) => contract.contractType === "stale_task").length,
        ambiguous_task: selectedContracts.filter((contract) => contract.contractType === "ambiguous_task").length,
      },
      artifacts: currentArtifactRows.map((artifact) => ({
        artifactId: artifact.id,
        artifactKind: artifact.artifact_kind,
        subjectKey: artifact.subject_key,
        status: artifact.status,
        primaryContractType: artifact.primary_contract_type,
        confidence: artifact.confidence,
        severity: artifact.severity,
        availableActions: artifact.available_actions,
        familyKeys: currentCoverageRows
          .filter((coverage) => coverage.artifact_id === artifact.id)
          .sort((left, right) => {
            if (left.is_primary !== right.is_primary) {
              return left.is_primary ? -1 : 1;
            }

            return String(left.promotion_family_key).localeCompare(String(right.promotion_family_key));
          })
          .map((coverage) => ({
            promotionFamilyKey: coverage.promotion_family_key,
            contractType: coverage.contract_type,
            isPrimary: coverage.is_primary,
          })),
        evidenceShape: artifactEvidenceShape(artifact),
        artifactEvidence: Array.isArray(artifact.artifact_evidence)
          ? artifact.artifact_evidence.map((item) => ({
              code: item.code,
              kind: item.kind,
              summary: item.summary,
              relatedId: item.relatedId,
              sourceContractType: item.sourceContractType,
            }))
          : [],
      })),
      promotionEvents: currentPromotionEvents.map((event) => ({
        eventId: event.id,
        eventType: event.event_type,
        promotionFamilyKey: event.promotion_family_key,
        artifactId: event.artifact_id,
        suppressionReason: event.suppression_reason,
        createdAt: event.created_at,
      })),
      evidenceCurationFailures: currentEvidenceFailures,
    };

    console.log(JSON.stringify(inspectionReport, null, 2));
    return;
  }

  const store = new LiveValidationPromotionStore(
    new SupabaseIntelligencePromotionStore(supabase),
    managementToken
  );
  const firstPromotion = await promoteIntelligenceContracts(store, userId, selectedContracts, {
    now: detectionNow,
    enableTaskStalenessClarityGrouping: false,
  });

  const firstCoverageRows = await queryTable(
    supabase,
    "intelligence_artifact_family_coverage",
    userId,
    "promotion_family_key",
    sampleFamilyKeys
  );
  const firstArtifactIds = [...new Set(firstCoverageRows.map((row) => row.artifact_id))];
  const firstArtifactRows = await queryTable(
    supabase,
    "intelligence_artifacts",
    userId,
    "id",
    firstArtifactIds
  );
  const firstContractLinkRows = await queryTable(
    supabase,
    "intelligence_artifact_contract_links",
    userId,
    "artifact_id",
    firstArtifactIds
  );
  const firstSnapshotIds = [...new Set(firstContractLinkRows.map((row) => row.contract_snapshot_id))];
  const firstSnapshotRows = await queryTable(
    supabase,
    "intelligence_contract_snapshots",
    userId,
    "id",
    firstSnapshotIds
  );

  assertNoDuplicateActiveArtifacts(firstCoverageRows, firstArtifactRows);
  assertCuratedEvidence(firstArtifactRows, firstContractLinkRows, firstSnapshotRows);

  const secondPromotion = await promoteIntelligenceContracts(store, userId, selectedContracts, {
    now: secondPromotionNow,
    enableTaskStalenessClarityGrouping: false,
  });

  const coverageRows = await queryTable(
    supabase,
    "intelligence_artifact_family_coverage",
    userId,
    "promotion_family_key",
    sampleFamilyKeys
  );
  const artifactIds = [...new Set(coverageRows.map((row) => row.artifact_id))];
  const artifactRows = await queryTable(
    supabase,
    "intelligence_artifacts",
    userId,
    "id",
    artifactIds
  );
  const contractLinkRows = await queryTable(
    supabase,
    "intelligence_artifact_contract_links",
    userId,
    "artifact_id",
    artifactIds
  );
  const snapshotIds = [...new Set(contractLinkRows.map((row) => row.contract_snapshot_id))];
  const snapshotRows = await queryTable(
    supabase,
    "intelligence_contract_snapshots",
    userId,
    "id",
    snapshotIds
  );
  const promotionEvents = await runManagementSql(
    managementToken,
    `
      SELECT
        id,
        user_id,
        contract_snapshot_id,
        artifact_id,
        promotion_family_key,
        event_type,
        suppression_reason,
        details,
        created_at
      FROM intelligence_promotion_events
      WHERE user_id = ${sqlText(userId)}
        AND promotion_family_key IN (${sampleFamilyKeys.map((value) => sqlText(value)).join(", ")})
        AND created_at >= ${sqlText(validationStartedAt.toISOString())}
      ORDER BY created_at ASC;
    `,
    true
  );

  assertNoDuplicateActiveArtifacts(coverageRows, artifactRows);
  assertSuppressionReasons(promotionEvents);
  assertCuratedEvidence(artifactRows, contractLinkRows, snapshotRows);

  const artifactsWithFamilies = artifactRows.map((artifact) => ({
    artifactId: artifact.id,
    artifactKind: artifact.artifact_kind,
    subjectKey: artifact.subject_key,
    status: artifact.status,
    primaryContractType: artifact.primary_contract_type,
    confidence: artifact.confidence,
    severity: artifact.severity,
    availableActions: artifact.available_actions,
    familyKeys: coverageRows
      .filter((coverage) => coverage.artifact_id === artifact.id)
      .sort((left, right) => {
        if (left.is_primary !== right.is_primary) {
          return left.is_primary ? -1 : 1;
        }

        return String(left.promotion_family_key).localeCompare(String(right.promotion_family_key));
      })
      .map((coverage) => ({
        promotionFamilyKey: coverage.promotion_family_key,
        contractType: coverage.contract_type,
        isPrimary: coverage.is_primary,
      })),
    evidenceShape: artifactEvidenceShape(artifact),
    artifactEvidence: Array.isArray(artifact.artifact_evidence)
      ? artifact.artifact_evidence.map((item) => ({
          code: item.code,
          kind: item.kind,
          summary: item.summary,
          relatedId: item.relatedId,
          sourceContractType: item.sourceContractType,
        }))
      : [],
  }));

  const suppressionEvents = promotionEvents
    .filter((event) => String(event.event_type).includes("noop"))
    .map((event) => ({
      eventId: event.id,
      eventType: event.event_type,
      promotionFamilyKey: event.promotion_family_key,
      artifactId: event.artifact_id,
      suppressionReason: event.suppression_reason,
      createdAt: event.created_at,
    }));

  const report = {
    validationStartedAt: validationStartedAt.toISOString(),
    userId,
    selectedTaskIds,
    sampleTasks,
    detectorCounts: {
      follow_up_risk: selectedContracts.filter((contract) => contract.contractType === "follow_up_risk").length,
      blocked_waiting_stale: selectedContracts.filter((contract) => contract.contractType === "blocked_waiting_stale").length,
      stale_task: selectedContracts.filter((contract) => contract.contractType === "stale_task").length,
      ambiguous_task: selectedContracts.filter((contract) => contract.contractType === "ambiguous_task").length,
    },
    firstPromotion: {
      contractSnapshotCount: firstPromotion.contractSnapshots.length,
      artifactCount: firstPromotion.artifacts.length,
      eventCount: firstPromotion.promotionEvents.length,
      eventTypes: firstPromotion.promotionEvents.map((event) => event.eventType),
    },
    secondPromotion: {
      contractSnapshotCount: secondPromotion.contractSnapshots.length,
      artifactCount: secondPromotion.artifacts.length,
      eventCount: secondPromotion.promotionEvents.length,
      eventTypes: secondPromotion.promotionEvents.map((event) => event.eventType),
    },
    artifacts: artifactsWithFamilies,
    suppressionEvents,
  };

  console.log(JSON.stringify(report, null, 2));
}

await main();
