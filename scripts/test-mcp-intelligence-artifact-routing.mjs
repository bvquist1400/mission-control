#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const upstreamRoute = fs.readFileSync(
  path.join(root, 'src/app/api/mcp-upstream/[...path]/route.ts'),
  'utf8'
);
const mcpRoute = fs.readFileSync(path.join(root, 'src/app/api/mcp/route.ts'), 'utf8');

for (const routeImport of [
  "import * as intelligenceArtifactsRoute from '@/app/api/intelligence/artifacts/route';",
  "import * as intelligenceArtifactStatusRoute from '@/app/api/intelligence/artifacts/[id]/status/route';",
  "import * as intelligenceArtifactApplyRoute from '@/app/api/intelligence/artifacts/[id]/apply/route';",
]) {
  assert.ok(upstreamRoute.includes(routeImport), `Missing intelligence upstream route import: ${routeImport}`);
}

for (const handler of [
  'invokeStatic(intelligenceArtifactsRoute.GET, requestWithContext)',
  'invokeDynamic(intelligenceArtifactStatusRoute.POST, requestWithContext, { id: segments[2] })',
  'invokeDynamic(intelligenceArtifactApplyRoute.POST, requestWithContext, { id: segments[2] })',
]) {
  assert.ok(upstreamRoute.includes(handler), `Missing intelligence upstream handler: ${handler}`);
}

assert.match(
  mcpRoute,
  /async function readMcpUpstreamJson\(response: Response, operation: string\).*?if \(!response\.ok\)/s,
  'Intelligence MCP responses must reject unsuccessful upstream status codes'
);

for (const operation of [
  'listing artifacts',
  'accepting an artifact',
  'dismissing an artifact',
  'applying an artifact',
]) {
  assert.ok(
    mcpRoute.includes(`readMcpUpstreamJson(res, '${operation}')`),
    `Missing checked upstream response for ${operation}`
  );
}

console.log('MCP intelligence artifact upstream routing checks passed.');
