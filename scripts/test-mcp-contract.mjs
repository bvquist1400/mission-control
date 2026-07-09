// MCP tool contract snapshot test.
//
// Drives the real /api/mcp POST handler with a JSON-RPC tools/list request and
// diffs the resulting tool names + input schemas against a checked-in snapshot.
// The MCP tool surface is a live contract consumed by an external AI assistant;
// this test fails on any unapproved change so contract breaks can't land
// silently inside unrelated refactors.
//
// Usage:
//   npm run test:mcp-contract             # verify against snapshot
//   npm run test:mcp-contract -- --update # regenerate the snapshot on purpose

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(scriptsDir, "fixtures", "mcp-tools.snapshot.json");
const updateMode = process.argv.includes("--update");

// The route module reads these at request time; provide inert test values.
process.env.MISSION_CONTROL_API_KEY ||= "contract-test-key";
process.env.MISSION_CONTROL_USER_ID ||= "00000000-0000-0000-0000-000000000000";
process.env.DEPLOYMENT_ROLE = "main";

const { POST } = await import("../src/app/api/mcp/route.ts");

async function rpc(body) {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY,
      "mcp-session-id": "stateless",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });

  const response = await POST(request);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`MCP request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  // enableJsonResponse means plain JSON, but tolerate SSE framing just in case.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;

  return JSON.parse(payload);
}

const result = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

if (result.error) {
  console.error("tools/list returned an error:", JSON.stringify(result.error, null, 2));
  process.exit(1);
}

const tools = (result.result?.tools ?? [])
  .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (tools.length === 0) {
  console.error("tools/list returned zero tools — the harness is broken, refusing to snapshot.");
  process.exit(1);
}

const rendered = `${JSON.stringify(tools, null, 2)}\n`;

if (updateMode || !fs.existsSync(snapshotPath)) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, rendered);
  console.log(`${updateMode ? "Updated" : "Created"} snapshot with ${tools.length} tools at ${path.relative(process.cwd(), snapshotPath)}`);
  process.exit(0);
}

const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const expectedByName = new Map(expected.map((tool) => [tool.name, tool]));
const actualByName = new Map(tools.map((tool) => [tool.name, tool]));

const removed = expected.filter((tool) => !actualByName.has(tool.name)).map((tool) => tool.name);
const added = tools.filter((tool) => !expectedByName.has(tool.name)).map((tool) => tool.name);
const changed = tools
  .filter((tool) => expectedByName.has(tool.name))
  .filter((tool) => JSON.stringify(tool.inputSchema) !== JSON.stringify(expectedByName.get(tool.name).inputSchema))
  .map((tool) => tool.name);

if (removed.length === 0 && added.length === 0 && changed.length === 0) {
  console.log(`MCP contract OK — ${tools.length} tools match the snapshot.`);
  process.exit(0);
}

console.error("MCP tool contract drift detected:");
if (removed.length > 0) console.error(`  REMOVED tools (breaking): ${removed.join(", ")}`);
if (changed.length > 0) console.error(`  CHANGED input schemas: ${changed.join(", ")}`);
if (added.length > 0) console.error(`  ADDED tools (additive): ${added.join(", ")}`);
console.error("\nIf this change is intentional, rerun with --update and commit the new snapshot.");
process.exit(1);
