#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PROD_BASE_URL = "https://mission-control-orpin-chi.vercel.app";
const MCP_PROTOCOL_VERSION = "2025-06-18";

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env.local");
  const env = {};

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    env[trimmed.slice(0, separatorIndex).trim()] = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }

  return env;
}

async function postMcpMessage(apiKey, message, sessionId = null) {
  const response = await fetch(`${PROD_BASE_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "X-Mission-Control-Key": apiKey,
      ...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`MCP endpoint returned non-JSON output (${response.status}): ${bodyText}`);
  }

  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") || sessionId || "stateless",
    body,
  };
}

async function requestJson(apiKey, pathname, init = {}) {
  const response = await fetch(`${PROD_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      "X-Mission-Control-Key": apiKey,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`API ${pathname} returned non-JSON output (${response.status}): ${bodyText}`);
  }

  return { status: response.status, body };
}

function parseToolData(body) {
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`Unexpected MCP tool response payload: ${JSON.stringify(body)}`);
  }

  return JSON.parse(text);
}

const env = loadEnvFile();
const apiKey = env.MISSION_CONTROL_API_KEY?.trim();
const actionsApiKey = env.MISSION_CONTROL_ACTIONS_API_KEY?.trim() || apiKey;

if (!apiKey) {
  throw new Error("Missing MISSION_CONTROL_API_KEY in .env.local");
}

if (!actionsApiKey) {
  throw new Error("Missing MISSION_CONTROL_ACTIONS_API_KEY or MISSION_CONTROL_API_KEY in .env.local");
}

const init = await postMcpMessage(apiKey, {
  jsonrpc: "2.0",
  id: "initialize-1",
  method: "initialize",
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "codex-mcp-intelligence-validator",
      version: "1.0.0",
    },
  },
});

assert.equal(init.status, 200, "MCP initialize should succeed");

const toolsList = await postMcpMessage(
  apiKey,
  {
    jsonrpc: "2.0",
    id: "tools-list-1",
    method: "tools/list",
    params: {},
  },
  init.sessionId
);

assert.equal(toolsList.status, 200, "MCP tools/list should succeed");
const toolNames = (toolsList.body?.result?.tools || []).map((tool) => tool.name).sort();

for (const requiredTool of [
  "accept_artifact",
  "apply_artifact",
  "dismiss_artifact",
  "list_open_artifacts",
  "trigger_intelligence_run",
]) {
  assert.ok(toolNames.includes(requiredTool), `Missing MCP tool ${requiredTool}`);
}

const temporaryTasks = [];

try {
  const overdueFollowUpAt = new Date(Date.now() - (96 * 60 * 60 * 1000)).toISOString();
  for (const action of ["apply", "dismiss"]) {
    const validationTitle = `[Codex MCP Validation] ${action} artifact ${new Date().toISOString()}`;
    const createTaskResult = await requestJson(actionsApiKey, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: validationTitle,
        status: "Blocked/Waiting",
        task_type: "FollowUp",
        waiting_on: `Codex MCP validation ${action} response`,
        source_type: "Validation",
        description: `Temporary task created to validate the MCP ${action}_artifact tool. Safe to mark done after validation.`,
      }),
    });

    assert.equal(createTaskResult.status, 201, `Temporary ${action} validation task should be created`);
    const taskId = createTaskResult.body?.id;
    assert.equal(typeof taskId, "string", `Temporary ${action} validation task must include an id`);

    const patchTaskResult = await requestJson(actionsApiKey, `/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        follow_up_at: overdueFollowUpAt,
      }),
    });
    assert.equal(patchTaskResult.status, 200, `Temporary ${action} validation task should accept a follow_up_at update`);

    temporaryTasks.push({
      action,
      taskId,
      title: createTaskResult.body?.title ?? validationTitle,
    });
  }

  const initialRun = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-run-initial-1",
      method: "tools/call",
      params: {
        name: "trigger_intelligence_run",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(initialRun.status, 200, "Initial trigger_intelligence_run should succeed");
  const initialRunData = parseToolData(initialRun.body);
  assert.equal(typeof initialRunData?.data?.contractCount, "number", "Initial run summary should include contractCount");
  assert.equal(typeof initialRunData?.data?.promotionEventCount, "number", "Initial run summary should include promotionEventCount");

  const listBefore = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-list-before-1",
      method: "tools/call",
      params: {
        name: "list_open_artifacts",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(listBefore.status, 200, "list_open_artifacts should succeed");
  const listBeforeData = parseToolData(listBefore.body);
  const activeArtifactsBefore = Array.isArray(listBeforeData?.data?.artifacts) ? listBeforeData.data.artifacts : [];

  const appliedTarget = temporaryTasks.find((task) => task.action === "apply");
  const dismissedTarget = temporaryTasks.find((task) => task.action === "dismiss");
  const applicableArtifact = activeArtifactsBefore.find((artifact) => artifact.subject_task?.task_id === appliedTarget?.taskId);
  const dismissedArtifact = activeArtifactsBefore.find((artifact) => artifact.subject_task?.task_id === dismissedTarget?.taskId);

  assert.ok(applicableArtifact, "Temporary apply validation task should produce an active artifact through MCP");
  assert.ok(dismissedArtifact, "Temporary dismiss validation task should produce an open artifact through MCP");
  assert.equal(typeof applicableArtifact.artifact_id, "string", "Applicable artifact must include artifact_id");
  assert.equal(typeof dismissedArtifact.artifact_id, "string", "Dismissed artifact must include artifact_id");

  const acceptResult = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-accept-1",
      method: "tools/call",
      params: {
        name: "accept_artifact",
        arguments: {
          artifact_id: applicableArtifact.artifact_id,
        },
      },
    },
    init.sessionId
  );

  assert.equal(acceptResult.status, 200, "accept_artifact should succeed");
  const acceptData = parseToolData(acceptResult.body);
  assert.equal(acceptData?.data?.status, "accepted", "Artifact should transition to accepted through MCP");

  const listAccepted = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-list-accepted-1",
      method: "tools/call",
      params: {
        name: "list_open_artifacts",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(listAccepted.status, 200, "Accepted-state list_open_artifacts should succeed");
  const listAcceptedData = parseToolData(listAccepted.body);
  const activeArtifactsAccepted = Array.isArray(listAcceptedData?.data?.artifacts) ? listAcceptedData.data.artifacts : [];
  assert.ok(
    activeArtifactsAccepted.some(
      (artifact) => artifact.artifact_id === applicableArtifact.artifact_id && artifact.status === "accepted"
    ),
    "Accepted artifact should remain visible in list_open_artifacts until applied"
  );

  const applyResult = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-apply-1",
      method: "tools/call",
      params: {
        name: "apply_artifact",
        arguments: {
          artifact_id: applicableArtifact.artifact_id,
        },
      },
    },
    init.sessionId
  );

  assert.equal(applyResult.status, 200, "apply_artifact should succeed");
  const applyData = parseToolData(applyResult.body);
  assert.equal(applyData?.data?.status, "applied", "Artifact should transition to applied through MCP");

  const dismissResult = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-dismiss-1",
      method: "tools/call",
      params: {
        name: "dismiss_artifact",
        arguments: {
          artifact_id: dismissedArtifact.artifact_id,
        },
      },
    },
    init.sessionId
  );

  assert.equal(dismissResult.status, 200, "dismiss_artifact should succeed");
  const dismissData = parseToolData(dismissResult.body);
  assert.equal(dismissData?.data?.status, "dismissed", "Artifact should transition to dismissed through MCP");

  const listAfter = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-list-after-1",
      method: "tools/call",
      params: {
        name: "list_open_artifacts",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(listAfter.status, 200, "Second list_open_artifacts should succeed");
  const listAfterData = parseToolData(listAfter.body);
  const activeArtifactsAfter = Array.isArray(listAfterData?.data?.artifacts) ? listAfterData.data.artifacts : [];
  assert.ok(
    !activeArtifactsAfter.some((artifact) => artifact.artifact_id === applicableArtifact.artifact_id),
    "Applied artifact should no longer appear in active artifacts"
  );
  assert.ok(
    !activeArtifactsAfter.some((artifact) => artifact.artifact_id === dismissedArtifact.artifact_id),
    "Dismissed artifact should no longer appear in active artifacts"
  );

  const runResult = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-run-1",
      method: "tools/call",
      params: {
        name: "trigger_intelligence_run",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(runResult.status, 200, "trigger_intelligence_run should succeed");
  const runData = parseToolData(runResult.body);
  assert.equal(typeof runData?.data?.contractCount, "number", "Run summary should include contractCount");
  assert.equal(typeof runData?.data?.promotionEventCount, "number", "Run summary should include promotionEventCount");

  const listAfterRun = await postMcpMessage(
    apiKey,
    {
      jsonrpc: "2.0",
      id: "call-list-after-run-1",
      method: "tools/call",
      params: {
        name: "list_open_artifacts",
        arguments: {},
      },
    },
    init.sessionId
  );

  assert.equal(listAfterRun.status, 200, "Post-run list_open_artifacts should succeed");
  const listAfterRunData = parseToolData(listAfterRun.body);
  const activeArtifactsAfterRun = Array.isArray(listAfterRunData?.data?.artifacts) ? listAfterRunData.data.artifacts : [];
  assert.ok(
    !activeArtifactsAfterRun.some((artifact) => artifact.artifact_id === applicableArtifact.artifact_id),
    "Applied artifact should remain out of active artifacts after the immediate MCP-triggered intelligence run"
  );
  assert.ok(
    !activeArtifactsAfterRun.some((artifact) => artifact.artifact_id === dismissedArtifact.artifact_id),
    "Dismissed artifact should remain suppressed after an immediate MCP-triggered intelligence run"
  );

  console.log(JSON.stringify({
    toolsVerified: [
      "list_open_artifacts",
      "accept_artifact",
      "apply_artifact",
      "dismiss_artifact",
      "trigger_intelligence_run",
    ],
    temporaryTasks,
    appliedArtifactId: applicableArtifact.artifact_id,
    appliedArtifactSummary: applicableArtifact.summary ?? null,
    dismissedArtifactId: dismissedArtifact.artifact_id,
    dismissedArtifactSummary: dismissedArtifact.summary ?? null,
    activeCountBefore: activeArtifactsBefore.length,
    activeCountAfterActions: activeArtifactsAfter.length,
    activeCountAfterRun: activeArtifactsAfterRun.length,
    initialRunSummary: initialRunData.data,
    runSummary: runData.data,
  }, null, 2));
} finally {
  for (const task of temporaryTasks) {
    await requestJson(actionsApiKey, `/api/tasks/${task.taskId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "Done",
      }),
    }).catch(() => null);
  }
}
