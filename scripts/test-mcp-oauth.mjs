#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sharedModuleUrl = pathToFileURL(
  path.join(process.cwd(), 'src/lib/mcp/shared.ts')
).href;

const searchModuleUrl = pathToFileURL(
  path.join(process.cwd(), 'src/lib/mcp/search.ts')
).href;

const oauth = await import(sharedModuleUrl);
const search = await import(searchModuleUrl);

const registration = oauth.buildPublicClientRegistrationResponse({
  client_id: 'mcp_client_123',
  client_name: 'Test Client',
  redirect_uris: ['https://example.com/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'mcp.read mcp.write',
  metadata: {
    software_id: 'software-id',
    software_version: '1.0.0',
  },
  created_at: '2026-03-08T12:00:00.000Z',
});

assert.equal('client_secret' in registration, false, 'Public clients must omit client_secret');
assert.equal(registration.token_endpoint_auth_method, 'none');
assert.equal(registration.scope, 'mcp.read mcp.write');

assert.equal(oauth.normalizeMcpScopeString(null), 'mcp.read mcp.write');
assert.equal(
  oauth.normalizeMcpScopeString('mcp.write mcp.read mcp.write'),
  'mcp.read mcp.write'
);

assert.deepEqual(oauth.getRequiredMcpScopesForMethod('GET'), ['mcp.read']);
assert.deepEqual(oauth.getRequiredMcpScopesForMethod('DELETE'), ['mcp.delete']);
assert.equal(oauth.canUseMcpOauthPath('/api/mcp-upstream'), true);
assert.equal(oauth.canUseMcpOauthPath('/api/mcp-upstream/tasks/123'), true);
assert.equal(oauth.canUseMcpOauthPath('/api/tasks'), false);

const encodedCalendarId = search.encodeCalendarSearchId({
  source: 'graph',
  externalEventId: 'evt-1',
  startAt: '2026-03-08T09:00:00.000Z',
});

assert.deepEqual(search.decodeCalendarSearchId(encodedCalendarId), {
  source: 'graph',
  externalEventId: 'evt-1',
  startAt: '2026-03-08T09:00:00.000Z',
});

assert.equal(search.mapRouteKindToTypedId('task', 'task-123'), 'record:task:task-123');
assert.equal(search.mapRouteKindToTypedId('email', 'email-123'), 'email:email-123');
assert.equal(search.mapRouteKindToTypedId('calendar', encodedCalendarId), `calendar:${encodedCalendarId}`);

assert.equal(
  search.isMissionControlSearchResult({
    id: 'record:task:task-123',
    title: 'Write migration',
    text: 'Add MCP OAuth migration',
    url: 'https://app.example.com/r/task/task-123',
    metadata: { entity: 'task' },
  }),
  true
);

assert.equal(
  search.isMissionControlSearchResult({
    id: 'record:task:task-123',
    title: 'Missing url',
    text: 'This should fail schema validation',
  }),
  false
);

console.log('MCP OAuth/search helper tests passed.');
